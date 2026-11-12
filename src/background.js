// Background: a service worker in Chrome, an event page in Firefox and Safari.
//
// Three jobs.
//
//  1. Clock relay. Embed frames (embed_relay.js) send `clock`; this forwards each one to the top
//     frame of the same tab -- page_relay.js on beatshiver.com, or the extension's debug page.
//     A tab is only forwarded to after its top frame has said `page-hello` / `debug-hello`, so an
//     embed on any other site goes nowhere.
//
//  2. Capture (Chrome only). `capture-start` from the page becomes chrome.tabCapture:
//       mode 'stream' -- a stream id the page itself turns into a MediaStream with getUserMedia
//                        (consumerTabId = the page's own tab), so the page keeps its existing
//                        AudioWorklet pipeline and gets a real MediaStream;
//       mode 'pcm'    -- the extension captures in an offscreen document, plays the audio back
//                        out (tab capture mutes the tab otherwise) and streams Float32 PCM chunks.
//     Chrome only grants tab capture for a tab the user has invoked the extension on (toolbar
//     click, shortcut). Without it the request is parked as `pending-gesture`, the toolbar icon
//     gets a badge, and the click starts it.
//
// Firefox and Safari have neither tabCapture nor offscreen documents: `capture-start` answers
// `unsupported` with `fallback: 'getDisplayMedia'`, and the page keeps the path it has today.
//
//  3. Measure on the source (Chrome only, sites.js `measureOn: 'source'`). `source-open` from a
//     beatshiver page (the consumer) opens the site's own item page in a new tab next to it (the
//     target). The target's top-frame clock goes to the consumer tagged `frame:{source, id, ref,
//     url}`, and the target's audio is captured into the consumer as `pcm` carrying the source
//     `id`. The capture needs the toolbar click on the *target* tab, so a refused one badges that
//     tab. A change of ref (another item, or off the item path) ends it as `navigated`; closing
//     either tab ends it; at `ended` the consumer tab is focused again. Nothing is ever sent to
//     the target page: its player, ads and UI are left alone, and no script plays there.

if (typeof importScripts === 'function' && typeof ext === 'undefined') {
  // Chrome service worker (classic). Firefox/Safari list these in background.scripts instead.
  importScripts('shim.js', 'sites.js');
}

const HAS_CAPTURE = !!(globalThis.chrome && chrome.tabCapture && chrome.tabCapture.getMediaStreamId
                       && chrome.offscreen);
const BROWSER = (() => {
  const ua = (globalThis.navigator && navigator.userAgent) || '';
  if (/Firefox\//.test(ua)) return 'firefox';
  if (/Safari\//.test(ua) && !/Chrom(e|ium)\//.test(ua)) return 'safari';
  return 'chrome';
})();

// ---- registry of listening tabs ---------------------------------------------------------------
// tabId -> 'page' | 'debug'. In storage.session so a service worker restart keeps it; mirrored in
// memory so the hot path (a clock message every 250 ms) does not wait on storage.
const listeners = new Map();
const store = ext.storage && ext.storage.session;
const listenersReady = (async () => {
  try {
    const got = store ? await store.get('listeners') : {};
    for (const [k, v] of Object.entries((got && got.listeners) || {})) listeners.set(+k, v);
  } catch (e) {}
})();
function persist() {
  if (!store) return;
  store.set({ listeners: Object.fromEntries(listeners) }).catch(() => {});
}

// ---- measure-on-source sessions ---------------------------------------------------------------
// id (the page's) -> { id, site, url, ref, targetTabId, consumerTabId, live, ended, capture }
// In storage.session with the listeners, so a service worker restart keeps relaying.
const sources = new Map();
let opening = 0;   // source-opens in flight: their tab may clock before it is in `sources`
const ready = Promise.all([listenersReady, (async () => {
  try {
    const got = store ? await store.get('sources') : {};
    for (const [k, v] of Object.entries((got && got.sources) || {})) sources.set(k, v);
  } catch (e) {}
})()]);
function persistSources() {
  if (!store) return;
  store.set({ sources: Object.fromEntries(sources) }).catch(() => {});
}
function sourceByTarget(tabId) {
  for (const s of sources.values()) if (s.targetTabId === tabId) return s;
  return null;
}
// Measuring on a source needs its audio, so only a browser with tab capture offers it.
const SOURCE_IDS = HAS_CAPTURE ? BEATSHIVER_SITES.sourceIds() : [];

// ---- capture state ----------------------------------------------------------------------------
// Keyed by the *target* tab, the one whose audio is captured (the offscreen document keys on it
// too). `consumerTabId` is the tab that hears it: the same tab for a page's own capture, the
// beatshiver tab for a source capture (`sourceId` set).
// targetTabId -> { id, mode, state, consumerTabId, sourceId }
const captures = new Map();
const pending = new Map();   // targetTabId -> request waiting for a toolbar click

function notifyTab(tabId, msg) {
  const kind = listeners.get(tabId);
  if (kind === 'debug') {
    // Extension pages do not receive tabs.sendMessage; they hear runtime broadcasts.
    return ext.runtime.sendMessage(Object.assign({ tabId }, msg)).catch(() => {});
  }
  return ext.tabs.sendMessage(tabId, msg, { frameId: 0 }).catch(() => {});
}

function isGrantError(e) {
  return /invoked|activeTab|permission/i.test(String(e && e.message || e));
}

async function setBadge(tabId, on) {
  if (!ext.action) return;
  try {
    await ext.action.setBadgeText({ tabId, text: on ? '!' : '' });
    if (on) await ext.action.setBadgeBackgroundColor({ tabId, color: '#d33' });
    await ext.action.setTitle({ tabId, title: on
      ? 'Beatshiver wants to measure this tab: click to allow'
      : 'Beatshiver' });
  } catch (e) {}
}

// ---- offscreen document (Chrome) --------------------------------------------------------------
let creating = null;
async function ensureOffscreen() {
  const url = chrome.runtime.getURL('offscreen.html');
  if (chrome.runtime.getContexts) {
    const ctxs = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'],
                                                    documentUrls: [url] });
    if (ctxs.length) return;
  }
  if (!creating) {
    creating = chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['USER_MEDIA'],
      justification: 'Capture the Beatshiver tab audio the page asked to measure, and play it back.',
    }).catch(e => { if (!/single offscreen|already/i.test(e.message)) throw e; })
      .finally(() => { creating = null; });
  }
  await creating;
}

async function startCapture(tabId, req) {
  if (!HAS_CAPTURE) {
    return { id: req.id, state: 'unsupported', browser: BROWSER, fallback: 'getDisplayMedia',
             error: 'this browser has no extension tab capture' };
  }
  const consumerTabId = req.consumerTabId != null ? req.consumerTabId : tabId;
  const sourceId = req.sourceId || null;
  const cur = captures.get(tabId);
  if (cur && cur.state === 'started') {
    if (cur.id === req.id) return { id: req.id, state: 'started', mode: cur.mode, reused: true };
    await stopCapture(tabId, cur.id, 'replaced');
  }
  try {
    if (req.mode === 'stream') {
      const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId,
                                                                  consumerTabId: tabId });
      captures.set(tabId, { id: req.id, mode: 'stream', state: 'started', consumerTabId });
      return { id: req.id, state: 'started', mode: 'stream', streamId };
    }
    await ensureOffscreen();
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    const res = await chrome.runtime.sendMessage({
      target: 'offscreen', type: 'offscreen-start', tabId, id: req.id, streamId,
      channels: req.channels, chunkFrames: req.chunkFrames, sampleRate: req.sampleRate,
      monitor: req.monitor,
    });
    if (!res || !res.ok) throw new Error((res && res.error) || 'offscreen capture failed');
    captures.set(tabId, { id: req.id, mode: 'pcm', state: 'started', consumerTabId, sourceId });
    return { id: req.id, state: 'started', mode: 'pcm', sampleRate: res.sampleRate,
             channels: res.channels };
  } catch (e) {
    if (isGrantError(e)) {
      pending.set(tabId, req);
      setBadge(tabId, true);
      return { id: req.id, state: 'pending-gesture',
               error: sourceId
                 ? 'click the Beatshiver toolbar icon on the tab being measured to allow it'
                 : 'click the Beatshiver toolbar icon on this tab to allow measuring it' };
    }
    return { id: req.id, state: 'error', error: String(e && e.message || e) };
  }
}

async function stopCapture(tabId, id, reason) {
  pending.delete(tabId);
  setBadge(tabId, false);
  const cur = captures.get(tabId);
  if (!cur || (id && cur.id !== id && reason !== 'replaced')) {
    return { id, state: 'stopped', reason: 'not-running' };
  }
  captures.delete(tabId);
  if (cur.mode === 'pcm') {
    try { await chrome.runtime.sendMessage({ target: 'offscreen', type: 'offscreen-stop', tabId }); }
    catch (e) {}
  }
  const out = { id: cur.id, state: 'stopped', reason: reason || 'requested' };
  // A source capture's end is told through its session (`source` messages), not `capture`.
  if (reason && reason !== 'requested' && !cur.sourceId) {
    notifyTab(tabId, Object.assign({ type: 'capture' }, out));
  }
  return out;
}

// ---- measure on the source --------------------------------------------------------------------
function tellSource(src, state, extra) {
  return notifyTab(src.consumerTabId,
                   Object.assign({ type: 'source', id: src.id, state }, extra || {}));
}

/** End a session: stop its capture, forget it, tell the consumer (unless it is gone). */
async function endSource(src, state, reason, { notify = true } = {}) {
  if (!sources.has(src.id)) return;
  sources.delete(src.id);
  persistSources();
  pending.delete(src.targetTabId);
  setBadge(src.targetTabId, false);
  const cur = captures.get(src.targetTabId);
  if (cur && cur.sourceId === src.id) await stopCapture(src.targetTabId, cur.id, reason || state);
  if (notify) tellSource(src, state, reason ? { reason } : null);
}

async function sourceOpen(msg, sender) {
  const consumer = sender.tab;
  const id = typeof msg.id === 'string' ? msg.id : '';
  const fail = error => ({ type: 'source', id, state: 'error', reason: error });
  if (!consumer || listeners.get(consumer.id) !== 'page') return fail('not a beatshiver page');
  if (!id || id.length > 200) return fail('bad id');
  if (!HAS_CAPTURE) return fail('this browser has no extension tab capture');
  const site = BEATSHIVER_SITES.siteById(msg.site);
  if (!site || site.measureOn !== 'source') return fail('not a measure-on-source site');
  // The whole validation: one of the site's page patterns, on its item path, with a ref.
  const ref = BEATSHIVER_SITES.refFor(site, msg.url);
  if (!ref) return fail("url is not one of that site's item pages");
  const old = sources.get(id);
  if (old) {
    // The same session asked again: show its tab rather than open a second one.
    try {
      await ext.tabs.update(old.targetTabId, { active: true });
      return { type: 'source', id, state: 'opened', reused: true };
    } catch (e) { await endSource(old, 'closed', 'tab-gone', { notify: false }); }
  }
  opening++;
  try {
    const tab = await ext.tabs.create({ url: msg.url, openerTabId: consumer.id,
                                        index: consumer.index + 1, active: true });
    const src = {
      id, site: site.id, url: msg.url, ref, targetTabId: tab.id, consumerTabId: consumer.id,
      live: false, ended: false,
      capture: {
        channels: msg.channels === 2 ? 2 : 1,
        chunkFrames: Math.max(256, Math.min(16384, (msg.chunkFrames | 0) || 2048)),
        sampleRate: (msg.sampleRate | 0) || 0,
      },
    };
    sources.set(id, src);
    persistSources();
    // Its relay may already have been told nobody wants it (a clock before this line).
    ext.tabs.sendMessage(tab.id, { type: 'source-wake' }, { frameId: 0 }).catch(() => {});
    return { type: 'source', id, state: 'opened' };
  } catch (e) {
    return fail(String(e && e.message || e));
  } finally {
    opening--;
  }
}

/** First clock from a target: its page is up, so capture its audio now (or ask for the click). */
async function startSourceCapture(src) {
  const res = await startCapture(src.targetTabId, {
    id: src.id, mode: 'pcm', monitor: true, consumerTabId: src.consumerTabId, sourceId: src.id,
    channels: src.capture.channels, chunkFrames: src.capture.chunkFrames,
    sampleRate: src.capture.sampleRate,
  });
  if (!sources.has(src.id)) {
    // The session ended while Chrome was starting it: do not leave the capture running.
    if (res.state === 'started') stopCapture(src.targetTabId, src.id, 'ended');
    return;
  }
  if (res.state === 'started') {
    tellSource(src, 'capturing', { sampleRate: res.sampleRate, channels: res.channels });
  } else if (res.state === 'pending-gesture') {
    tellSource(src, 'needs-gesture', { reason: res.error });
  } else {
    tellSource(src, 'error', { reason: res.error || res.state });
  }
}

function sourceClock(src, msg, sender) {
  if (sender.frameId !== 0 || src.ended) return;
  const data = msg.data || {};
  const ref = data.ref || null;
  if (ref !== src.ref) {
    endSource(src, 'navigated', ref ? 'ref-changed' : 'left-item');
    return;
  }
  if (!src.live) {
    src.live = true;
    persistSources();
    startSourceCapture(src);
  }
  // The contract's frame: which site, which session, which item. No `origin`/`frameId`: a page
  // that routes embed clocks by origin must never take this for its own embed's clock.
  notifyTab(src.consumerTabId, {
    type: 'clock',
    frame: { source: src.site, id: src.id, ref, url: sender.url },
    data,
  });
  if (data.event === 'ended' && !data.adPlaying && data.media && data.media.ended) {
    src.ended = true;
    persistSources();
    // Let the last PCM chunks through, then end and hand the user back to beatshiver.com.
    setTimeout(async () => {
      await endSource(src, 'ended', null);
      focusTab(src.consumerTabId);
    }, 500);
  }
}

async function focusTab(tabId) {
  try {
    const t = await ext.tabs.update(tabId, { active: true });
    if (t && t.windowId != null && ext.windows) await ext.windows.update(t.windowId, { focused: true });
  } catch (e) {}
}

// ---- messages ---------------------------------------------------------------------------------
ext.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || typeof msg.type !== 'string' || msg.target === 'offscreen') return;
  const tabId = sender.tab && sender.tab.id;

  switch (msg.type) {
    case 'clock': {
      if (tabId == null) return;
      return ready.then(() => {
        const src = sourceByTarget(tabId);
        if (src) { sourceClock(src, msg, sender); return { want: true }; }
        if (!listeners.has(tabId)) {
          // A source-site page nobody opened for measuring: tell its relay to stop sending.
          return sender.frameId === 0 && !opening ? { want: false } : undefined;
        }
        notifyTab(tabId, {
          type: 'clock',
          frame: { frameId: sender.frameId, origin: sender.origin || originOf(sender.url),
                   url: sender.url },
          data: msg.data,
        });
      });
    }
    case 'page-hello':
      if (tabId == null) return;
      listeners.set(tabId, 'page');
      persist();
      return Promise.resolve({ ok: true });
    case 'debug-hello': {
      const t = tabId != null ? tabId : msg.tabId;
      if (t == null) return;
      listeners.set(t, 'debug');
      persist();
      return Promise.resolve({ ok: true, tabId: t });
    }
    case 'caps':
      return Promise.resolve({ clock: true, capture: HAS_CAPTURE ? ['stream', 'pcm'] : [],
                               browser: BROWSER,
                               captureFallback: HAS_CAPTURE ? null : 'getDisplayMedia',
                               sources: SOURCE_IDS });
    case 'source-open':
      return ready.then(() => sourceOpen(msg, sender));
    case 'source-close':
      return ready.then(async () => {
        const src = sources.get(msg.id);
        if (!src || !sender.tab || src.consumerTabId !== sender.tab.id) {
          return { type: 'source', id: msg.id, state: 'closed', reason: 'not-open' };
        }
        await endSource(src, 'closed', 'requested', { notify: false });
        // We opened that tab for this session; the page is done with it.
        ext.tabs.remove(src.targetTabId).catch(() => {});
        return { type: 'source', id: src.id, state: 'closed', reason: 'requested' };
      });
    case 'capture-start': {
      const t = tabId != null ? tabId : msg.tabId;   // debug page passes its own tab id
      if (t == null) return Promise.resolve({ id: msg.id, state: 'error', error: 'no tab' });
      return startCapture(t, msg);
    }
    case 'capture-stop': {
      const t = tabId != null ? tabId : msg.tabId;
      return stopCapture(t, msg.id, 'requested');
    }
    case 'pcm':
    case 'offscreen-ended':
      // From the offscreen document. Web tabs get the chunk through their content script; the
      // debug page already heard the runtime broadcast directly.
      if (sender.tab) return;
      if (msg.type === 'offscreen-ended') {
        const cur = captures.get(msg.tabId);
        if (cur) {
          captures.delete(msg.tabId);
          const src = cur.sourceId && sources.get(cur.sourceId);
          if (src) endSource(src, 'error', 'capture-' + (msg.reason || 'ended'));
          else if (!cur.sourceId) {
            notifyTab(msg.tabId, { type: 'capture', id: cur.id, state: 'stopped',
                                   reason: msg.reason || 'ended' });
          }
        }
        return;
      }
      {
        // Audio of tab msg.tabId goes to whoever consumes it: itself, or the source's consumer.
        const cur = captures.get(msg.tabId);
        const to = cur ? cur.consumerTabId : msg.tabId;
        if (listeners.get(to) !== 'page') return;
        const src = cur && cur.sourceId ? sources.get(cur.sourceId) : null;
        const out = src ? Object.assign({}, msg, { tabId: to, id: src.id, site: src.site }) : msg;
        ext.tabs.sendMessage(to, out, { frameId: 0 }).catch(() => {});
      }
      return;
  }
});

function originOf(u) { try { return new URL(u).origin; } catch (e) { return null; } }

// ---- the toolbar click: the user gesture Chrome's tab capture needs ---------------------------
if (ext.action && ext.action.onClicked) {
  ext.action.onClicked.addListener(async tab => {
    await ready;
    const req = pending.get(tab.id);
    const src = sourceByTarget(tab.id);
    if (src && !captures.has(tab.id)) {
      // A click on the source tab is the grant its capture was waiting for (or will need).
      pending.delete(tab.id);
      setBadge(tab.id, false);
      await startSourceCapture(src);
      return;
    }
    if (req) {
      pending.delete(tab.id);
      setBadge(tab.id, false);
      const res = await startCapture(tab.id, req);
      notifyTab(tab.id, Object.assign({ type: 'capture' }, res));
      return;
    }
    if (captures.has(tab.id)) {
      const cur = captures.get(tab.id);
      const s = cur.sourceId && sources.get(cur.sourceId);
      if (s) await endSource(s, 'closed', 'toolbar');
      else await stopCapture(tab.id, null, 'toolbar');
      return;
    }
    if (listeners.get(tab.id) === 'page' || listeners.get(tab.id) === 'debug') {
      // The click itself granted capture for this tab until it navigates; say so, so the page
      // can enable a one-click "measure" control.
      notifyTab(tab.id, { type: 'capture', id: null, state: 'granted' });
      return;
    }
    ext.tabs.create({ url: ext.runtime.getURL('debug.html') });
  });
}

ext.tabs.onRemoved.addListener(async tabId => {
  await ready;
  for (const src of [...sources.values()]) {
    // The source tab closed: tell the page. The page closed: nobody to tell; just stop.
    if (src.targetTabId === tabId) await endSource(src, 'closed', 'tab-closed');
    else if (src.consumerTabId === tabId) {
      await endSource(src, 'closed', 'page-closed', { notify: false });
    }
  }
  pending.delete(tabId);
  if (captures.has(tabId)) stopCapture(tabId, null, 'tab-closed');
  if (listeners.delete(tabId)) persist();
});

// A navigation or reload ends the grant and the page that asked; stop rather than capture the
// next page. (`url` is only in changeInfo when it changed, so a reload is caught by status alone.)
// A source tab is different: its site is a single-page app, so `loading` alone means nothing;
// only a change of ref does. (Its clock says so too, from the history hooks: changeInfo.url is
// only there where the browser shows this extension the tab's URL.)
ext.tabs.onUpdated.addListener(async (tabId, info) => {
  await ready;
  const src = sourceByTarget(tabId);
  if (src) {
    if (info.url && src.live && !src.ended) {
      const ref = BEATSHIVER_SITES.refFor(BEATSHIVER_SITES.siteById(src.site), info.url);
      if (ref !== src.ref) endSource(src, 'navigated', ref ? 'ref-changed' : 'left-item');
    }
    return;
  }
  if (info.status === 'loading') {
    pending.delete(tabId);
    if (captures.has(tabId)) stopCapture(tabId, null, 'navigated');
    // The beatshiver page that consumed a source reloaded: its session is gone with it.
    for (const s of [...sources.values()]) {
      if (s.consumerTabId === tabId) endSource(s, 'closed', 'page-navigated', { notify: false });
    }
  }
});
