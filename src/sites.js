// The one list of sites this extension touches. Everything else reads it:
//
//   * build.mjs turns `embedMatches()` and `PAGE_MATCHES` into the manifests' content_scripts,
//     so a host added here is a host the extension asks permission for, and nowhere else;
//   * embed_main.js asks `siteFor(location.href)` which ad/content rules apply in its frame;
//   * the debug page's sample embeds live in debug.js, not here, because they are test data.
//
// A classic script rather than a module, on purpose: the same file is loaded by a Chrome service
// worker (importScripts), a Firefox/Safari background page (background.scripts), a MAIN-world
// content script, and Node (build.mjs runs it in a vm). Only a plain script works in all four.
//
// Match patterns are as narrow as the embed URL allows -- the embed path, not the whole site.
// Chrome's install prompt still words it per host ("www.pornhub.com"), but the scripts only ever
// run on the embed pages.
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
      id: 'youtube',
      embeds: ['https://www.youtube.com/embed/*', 'https://www.youtube-nocookie.com/embed/*'],
      content: 'video.html5-main-video',
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
  const PAGE_MATCHES = ['https://beatshiver.com/*'];
  const PAGE_ORIGINS = ['https://beatshiver.com'];

  function patternToRegExp(p) {
    // Enough of the match-pattern grammar for the patterns above: scheme://host/path with `*`.
    const esc = s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    const m = /^(https?):\/\/([^/]+)(\/.*)$/.exec(p);
    if (!m) throw new Error('bad match pattern ' + p);
    return new RegExp('^' + m[1] + ':\\/\\/' + esc(m[2]) + esc(m[3]) + '$');
  }

  function embedMatches() {
    return SITES.flatMap(s => s.embeds);
  }

  function siteFor(url) {
    for (const s of SITES) {
      if (s.embeds.some(p => patternToRegExp(p).test(url))) return s;
    }
    return null;
  }

  root.BEATSHIVER_SITES = {
    SITES, PEERTUBE_INSTANCES, GENERIC_AD_CLASS, PAGE_MATCHES, PAGE_ORIGINS,
    embedMatches, siteFor, patternToRegExp,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
