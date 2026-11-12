// MAIN world, document_start, every frame on an embed origin (see sites.js).
//
// Finds the frame's media elements wherever they are -- light DOM, open or closed shadow roots,
// or never attached at all (SoundCloud's widget plays a detached `new Audio()`) -- and reports
// the content element's clock to embed_relay.js, which runs in the isolated world and owns the
// extension messaging.
//
// Why the MAIN world: an isolated-world script sees its own copy of the DOM prototypes, so
// patching HTMLMediaElement.prototype there catches nothing the page does. Patching the page's
// prototype at document_start, before the player script runs, is what makes shadow DOM and
// detached elements irrelevant: every element passes through play(), src or load() eventually.
//
// Media events do not bubble out of a shadow root (they are not composed), so listeners go on
// each element itself, never on document.
(function () {
  'use strict';
  if (window.__beatshiverClock) return;
  window.__beatshiverClock = true;

  const SITES = globalThis.BEATSHIVER_SITES;
  // Loaded into the page's own world by sites.js; take what we need and leave no global behind.
  try { delete globalThis.BEATSHIVER_SITES; } catch (e) { globalThis.BEATSHIVER_SITES = undefined; }
  if (!SITES) return;

  // Not inside a frame: somebody opened the embed URL directly. Nothing to report to.
  if (window === window.top) return;

  const site = SITES.siteFor(location.href) || { id: 'unknown' };
  const adClassRe = new RegExp(SITES.GENERIC_AD_CLASS + (site.adClass ? '|' + site.adClass : ''));
  const contentSrcRe = site.contentSrc ? new RegExp(site.contentSrc) : null;

  const EVENT_NAME = 'beatshiver:clock';
  const REPORTED = ['play', 'playing', 'pause', 'seeking', 'seeked', 'ratechange',
                    'durationchange', 'loadedmetadata', 'ended', 'emptied', 'waiting'];
  const TICK_MS = 250;       // heartbeat while the content element plays
  const IDLE_TICK_MS = 2000; // heartbeat while paused, so a page that loaded late still hears

  const ids = new WeakMap();
  const tracked = new Set(); // strong refs are fine: an embed frame holds one or two players
  let nextId = 1;
  let lastPrimary = null;
  let seq = 0;

  const Media = window.HTMLMediaElement;
  if (!Media) return;

  function track(el) {
    if (!(el instanceof Media) || ids.has(el)) return;
    ids.set(el, nextId++);
    tracked.add(el);
    for (const type of REPORTED) {
      el.addEventListener(type, () => report(type, el), { passive: true });
    }
    el.addEventListener('timeupdate', () => {
      // timeupdate fires every 15-250 ms; the heartbeat already covers it. Only use it to wake a
      // clock that had gone idle.
      if (!tickTimer) schedule();
    }, { passive: true });
    schedule();
  }

  // ---- finding elements ----------------------------------------------------------------------

  function patchMethod(name) {
    const orig = Media.prototype[name];
    if (typeof orig !== 'function') return;
    const wrapped = function () { try { track(this); } catch (e) {} return orig.apply(this, arguments); };
    try {
      Object.defineProperty(wrapped, 'name', { value: name });
      Object.defineProperty(wrapped, 'length', { value: orig.length });
      wrapped.toString = () => orig.toString();
    } catch (e) {}
    Media.prototype[name] = wrapped;
  }

  function patchSetter(name) {
    const d = Object.getOwnPropertyDescriptor(Media.prototype, name);
    if (!d || !d.set) return;
    Object.defineProperty(Media.prototype, name, Object.assign({}, d, {
      set(v) { try { track(this); } catch (e) {} return d.set.call(this, v); },
    }));
  }

  ['play', 'load', 'pause', 'fastSeek'].forEach(patchMethod);
  ['src', 'srcObject', 'currentTime', 'playbackRate'].forEach(patchSetter);

  function scan(root) {
    try {
      if (root instanceof Media) track(root);
      if (root.querySelectorAll) root.querySelectorAll('video, audio').forEach(track);
    } catch (e) {}
  }

  function observe(root) {
    scan(root);
    try {
      new MutationObserver(records => {
        for (const r of records) for (const n of r.addedNodes) if (n.nodeType === 1) scan(n);
      }).observe(root, { childList: true, subtree: true });
    } catch (e) {}
  }

  // Shadow roots, including closed ones: we hand back the same root the page asked for, and keep
  // a reference to observe it.
  const origAttach = Element.prototype.attachShadow;
  if (origAttach) {
    const wrappedAttach = function (init) {
      const r = origAttach.call(this, init);
      try { observe(r); } catch (e) {}
      return r;
    };
    try { wrappedAttach.toString = () => origAttach.toString(); } catch (e) {}
    Element.prototype.attachShadow = wrappedAttach;
  }

  observe(document);

  // ---- choosing the content element ----------------------------------------------------------

  function classChain(el) {
    const out = [];
    let n = el;
    for (let i = 0; i < 8 && n; i++) {
      if (n.nodeType === 1) {
        const c = typeof n.className === 'string' ? n.className : '';
        out.push(c + ' ' + (n.id || ''));
      }
      n = n.parentNode instanceof ShadowRoot ? n.parentNode.host : n.parentNode;
    }
    return out;
  }

  function closestAcrossShadow(el, sel) {
    let n = el;
    while (n) {
      if (n.nodeType === 1 && n.matches && n.matches(sel)) return n;
      n = n.parentNode instanceof ShadowRoot ? n.parentNode.host : n.parentNode;
    }
    return null;
  }

  /** 'content' | 'ad' | 'unknown' -- what this element is playing right now. */
  function knownDur(el) {
    return Number.isFinite(el.duration) && el.duration > 0 ? el.duration : null;
  }

  /** Longest known duration among the other connected media elements in this frame. */
  function longestOther(el) {
    let m = 0;
    for (const o of tracked) {
      if (o === el || !o.isConnected) continue;
      const d = knownDur(o);
      if (d && d > m) m = d;
    }
    return m;
  }

  // Ad-serving hosts in a src: a VAST player that plays the creative straight off the ad CDN.
  const AD_SRC = /vast|vpaid|preroll|adserv|doubleclick|googlesyndication|trafficjunky|exoclick|exosrv|tsyndicate|adtng|adspyglass|\/ads?\//i;

  function role(el) {
    // Shape rules first, because they need no markup at all. xvideos (seen 2026-11-12 on the
    // Android build): the pre-roll is a second <video class="video-overlay">, ~20 s, no ad class
    // or ad host, inside the same player as the paused 37-minute content element -- so the
    // content selector matches it too.
    //  * short-beside-long: a clip under 90 s beside one of 60 s+ and 3x its length is the ad;
    //  * unknown-length: a clip whose duration is not known yet never outranks one with a known
    //    long duration (the same pre-roll between play() and loadedmetadata). It is 'pending',
    //    not 'ad', until its metadata says which it is.
    const d = knownDur(el);
    const other = longestOther(el);
    if (d && d < 90 && other >= 60 && other > 3 * d) return 'ad';
    if (!d && el.duration !== Infinity && other >= 60) return 'pending';
    if (AD_SRC.test(el.currentSrc || el.src || '')) return 'ad';

    let contentMatch = false;
    if (site.content) {
      try { contentMatch = el.matches(site.content); } catch (e) {}
    }
    if (!contentMatch && classChain(el).some(c => adClassRe.test(c))) return 'ad';
    if (site.adPlayer && el.isConnected && closestAcrossShadow(el, site.adPlayer)) return 'ad';
    if (contentMatch && contentSrcRe) {
      const src = el.currentSrc || el.src || '';
      if (src && !contentSrcRe.test(src)) return 'ad';
    }
    if (contentMatch) return 'content';
    // A site with a content selector: anything else is not the content (a second <video> beside
    // the player is a pre-roll or a preview). A site without one: unknown, chosen on duration.
    return site.content && el.isConnected ? 'ad' : 'unknown';
  }

  function finiteDur(el) {
    return Number.isFinite(el.duration) ? el.duration : (el.duration === Infinity ? 1e9 : 0);
  }

  function pickPrimary() {
    let best = null, bestScore = -1;
    for (const el of tracked) {
      const r = role(el);
      if (r === 'ad' || r === 'pending') continue;
      // Content beats unknown; then something that has loaded; then the longest; a detached
      // element that never loaded anything scores nothing.
      const score = (r === 'content' ? 4e9 : 0) + (el.readyState > 0 ? 2e9 : 0) + finiteDur(el);
      if (score > bestScore) { best = el; bestScore = score; }
    }
    return best;
  }

  function adPlaying() {
    for (const el of tracked) {
      if (el.paused || el.ended) continue;
      const r = role(el);
      // A playing clip of unknown length beside a long one: the pre-roll before its metadata.
      if (r === 'ad' || r === 'pending') return true;
    }
    return false;
  }

  // ---- reporting -----------------------------------------------------------------------------

  function snapshot(el) {
    return {
      mediaId: ids.get(el),
      kind: el.tagName.toLowerCase(),
      currentTime: el.currentTime,
      paused: el.paused,
      ended: el.ended,
      playbackRate: el.playbackRate,
      duration: Number.isFinite(el.duration) ? el.duration : (el.duration === Infinity ? 'live' : null),
      readyState: el.readyState,
      muted: el.muted,
      volume: el.volume,
    };
  }

  function report(event, from) {
    const primary = pickPrimary();
    const fromPrimary = !!from && from === primary;
    // Events from a non-primary element are reported only as an ad state change; their clock is
    // never sent as the clock.
    const msg = {
      v: 1,
      seq: ++seq,
      site: site.id,
      event,
      fromPrimary,
      primaryChanged: primary !== lastPrimary,
      adPlaying: adPlaying(),
      media: primary ? snapshot(primary) : null,
      candidates: tracked.size,
      wallMs: Date.now(),
      perfMs: performance.now(),
    };
    lastPrimary = primary;
    try {
      document.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: JSON.stringify(msg) }));
    } catch (e) {}
    schedule(event === 'tick');
  }

  // Idle heartbeats stop after a few, so a paused player does not keep the extension's service
  // worker awake for ever; any media event (or timeupdate) restarts them.
  const IDLE_TICKS = 5;
  let tickTimer = null;
  let idleTicks = 0;
  function schedule(fromTick) {
    if (tickTimer) return;
    const p = pickPrimary();
    if (!p && !tracked.size) return;
    const playing = (p && !p.paused && !p.ended) || adPlaying();
    if (playing || !fromTick) idleTicks = 0;
    else if (++idleTicks > IDLE_TICKS) return;
    tickTimer = setTimeout(() => { tickTimer = null; report('tick', null); },
                           playing ? TICK_MS : IDLE_TICK_MS);
  }
})();
