// The one list of sites this extension touches. Everything else reads it:
//
//   * build.mjs turns `embedMatches()`, `pageMatches()` and `PAGE_MATCHES` into the manifests'
//     content_scripts, so a host added here is a host the extension asks permission for, and
//     nowhere else;
//   * embed_main.js asks `siteFor(location.href)` which ad/content rules apply in its frame, and
//     `refFor()` which item a source page is showing;
//   * background.js validates `source-open` against `pages` + `itemPath` and advertises
//     `sourceIds()` to the page.
//   * the debug page's sample embeds live in debug.js, not here, because they are test data.
//
// A classic script rather than a module, on purpose: the same file is loaded by a Chrome service
// worker (importScripts), a Firefox/Safari background page (background.scripts), a MAIN-world
// content script, and Node (build.mjs runs it in a vm). Only a plain script works in all four.
//
// Embed match patterns are as narrow as the embed URL allows -- the embed path, not the whole
// site. Chrome's install prompt still words it per host ("www.pornhub.com"), but the scripts only
// ever run on the embed pages. Source `pages` are whole hosts: those sites are single-page apps,
// so the item page is reached without a document load and the script must already be there.
(function (root) {
  'use strict';

  /** PeerTube is federated: every instance is its own origin. Add instances here, nowhere else. */
  const PEERTUBE_INSTANCES = [
    'framatube.org',
    'peertube.tv',
    'tilvids.com',
    'video.blender.org',
    'peertube.futo.org',
  ];

  /**
   * id       -- reported in every clock message as `site`
   * embeds   -- match patterns for the embed frames (content_scripts `matches`)
   * content  -- CSS selector that names the content <video>/<audio>, when the player has one
   * adClass  -- regex source tested against the class/id of the element and its ancestors; a hit
   *             marks the element as an ad rather than content
   * adPlayer -- CSS selector; while an ancestor of the element matches, the element is playing
   *             an ad (YouTube reuses one <video> for ads and content and flags the player)
   * contentSrc -- regex source; when set, a content element whose currentSrc does not match is
   *             treated as playing an ad (a VAST player that swaps an mp4 into the same element)
   *
   * Where the site is measured (the same rules for every site; nothing in the logic names one):
   * measureOn -- 'embed' (default): clock from the site's embed frames on beatshiver.com.
   *             'source': the site's own page is measured in its own tab. The beatshiver page
   *             asks for it with `source-open`; the extension opens it, reports its top-frame
   *             clock to that page and captures its audio. Every play with a script stays on
   *             beatshiver.com; the source tab is never driven and its ads and UI are untouched.
   * pages    -- match patterns for the source site's pages (top frame only). Whole hosts.
   * itemPath -- regex source for location.pathname of an item page; the clock reports only there
   * refFrom  -- how to read the item key ("ref") from an item URL: {query:'v'} for a query
   *             parameter, or {path:'<regex with one group>'} tested against the pathname
   * pageUrl  -- the template the page builds `source-open.url` from (documentation only here;
   *             the extension validates the URL against `pages` + `itemPath` instead)
   */
  const SITES = [
    {
      id: 'xvideos',
      embeds: ['https://www.xvideos.com/embedframe/*'],
      content: '#html5video video, #hlsplayer video',
    },
    {
      id: 'pornhub',
      // Pornhub serves VAST pre-rolls. The content element is `video.mgp_videoElement`
      // (measured 2026-11-12); a pre-roll either gets its own element (no mgp_videoElement
      // class -> ad) or is swapped into the content element as a plain https mp4 off an ad CDN
      // (contentSrc fails -> ad). Content itself plays from a MediaSource blob or phncdn.
      embeds: ['https://www.pornhub.com/embed/*'],
      content: 'video.mgp_videoElement',
      contentSrc: '^(blob:|https://[^/]*(phncdn\\.com|pornhub\\.com)/)',
      // Guessed, not observed: no Pornhub pre-roll was served to any test run (2026-11-12). The
      // shape rules in embed_main.js are what actually catch an unmarked pre-roll.
      adPlayer: '.mgp_adRollActive, .mgp_adPlaying, .mgp_preRoll, .mgp_isAd',
    },
    {
      id: 'peertube',
      embeds: PEERTUBE_INSTANCES.flatMap(h => [
        `https://${h}/videos/embed/*`,
        `https://${h}/video-playlists/embed/*`,
      ]),
      content: 'video.vjs-tech',
    },
    {
      // Measured on youtube.com itself (backlog item 33): YouTube's API policies forbid
      // beatshiver.com to isolate the audio of its embed, so the embed gets no clock at all.
      id: 'youtube',
      measureOn: 'source',
      embeds: [],
      pages: ['https://www.youtube.com/*', 'https://m.youtube.com/*'],
      itemPath: '^/watch$',
      refFrom: { query: 'v' },
      pageUrl: 'https://www.youtube.com/watch?v={id}',
      // #movie_player: the watch page's own player. The home page's hover-preview player also
      // has a video.html5-main-video, and it stays in the document after an SPA move to /watch.
      content: '#movie_player video.html5-main-video',
      // YouTube plays the ad in the same <video> and flags the player element.
      adPlayer: '.html5-video-player.ad-showing, .html5-video-player.ad-interrupting',
    },
    {
      id: 'soundcloud',
      // The widget plays through an <audio> it never attaches to the document; the prototype
      // hook in embed_main.js is what finds it.
      embeds: ['https://w.soundcloud.com/player/*'],
    },
  ];

  /** Generic ad markers, applied on every site in addition to its own. */
  const GENERIC_AD_CLASS = '(^|[\\s_-])(ad|ads|adroll|ad-?container|preroll|pre-roll|vast|ima-ad|advert)([\\s_-]|$)|adRoll|preRoll|PreRoll|vastVideo';

  /** The top frames that receive the clock and may ask for capture. */
  // qa.beatshiver.com is where the site's half ships first (the page's `QA` flag).
  const PAGE_MATCHES = ['https://beatshiver.com/*', 'https://qa.beatshiver.com/*'];
  const PAGE_ORIGINS = ['https://beatshiver.com', 'https://qa.beatshiver.com'];

  function patternToRegExp(p) {
    // Enough of the match-pattern grammar for the patterns above: scheme://host/path with `*`.
    const esc = s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    const m = /^(https?):\/\/([^/]+)(\/.*)$/.exec(p);
    if (!m) throw new Error('bad match pattern ' + p);
    return new RegExp('^' + m[1] + ':\\/\\/' + esc(m[2]) + esc(m[3]) + '$');
  }

  const isSource = s => s.measureOn === 'source';

  function embedMatches() {
    return SITES.flatMap(s => s.embeds || []);
  }

  /** Match patterns of every measure-on-source site's pages (top-frame content scripts). */
  function pageMatches() {
    return SITES.filter(isSource).flatMap(s => s.pages || []);
  }

  /** Ids of the sites the page may `source-open`. */
  function sourceIds() {
    return SITES.filter(isSource).map(s => s.id);
  }

  function siteById(id) {
    return SITES.find(s => s.id === id) || null;
  }

  /** The site whose embed patterns -- or, for a source site, page patterns -- match `url`. */
  function siteFor(url) {
    for (const s of SITES) {
      if ((s.embeds || []).some(p => patternToRegExp(p).test(url))) return s;
    }
    for (const s of SITES) {
      if (isSource(s) && (s.pages || []).some(p => patternToRegExp(p).test(url))) return s;
    }
    return null;
  }

  /**
   * The item key of `url` on source site `site`, or null when `url` is not one of its item pages
   * (another host, off `itemPath`, or no ref in it).
   */
  function refFor(site, url) {
    if (!site || !isSource(site)) return null;
    let u;
    try { u = new URL(String(url)); } catch (e) { return null; }
    if (!(site.pages || []).some(p => patternToRegExp(p).test(u.href))) return null;
    if (site.itemPath && !new RegExp(site.itemPath).test(u.pathname)) return null;
    const rf = site.refFrom || {};
    let ref = null;
    if (rf.query) ref = u.searchParams.get(rf.query);
    else if (rf.path) {
      const m = new RegExp(rf.path).exec(u.pathname);
      ref = m ? (m[1] != null ? m[1] : m[0]) : null;
    }
    return ref ? String(ref) : null;
  }

  root.BEATSHIVER_SITES = {
    SITES, PEERTUBE_INSTANCES, GENERIC_AD_CLASS, PAGE_MATCHES, PAGE_ORIGINS,
    embedMatches, pageMatches, sourceIds, siteById, siteFor, refFor, patternToRegExp,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
