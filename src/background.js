// Background: a service worker in Chrome, an event page in Firefox and Safari.
//
// Two jobs.
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
const ready = (async () => {
  try {
    const got = store ? await store.get('listeners') : {};
    for (const [k, v] of Object.entries((got && got.listeners) || {})) listeners.set(+k, v);
  } catch (e) {}
})();
function persist() {
  if (!store) return;
  store.set({ listeners: Object.fromEntries(listeners) }).catch(() => {});
}

// ---- capture state ----------------------------------------------------------------------------
// tabId -> { id, mode, state, req }
const captures = new Map();
const pending = new Map();   // tabId -> request waiting for a toolbar click

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
  const cur = captures.get(tabId);
  if (cur && cur.state === 'started') {
    if (cur.id === req.id) return { id: req.id, state: 'started', mode: cur.mode, reused: true };
    await stopCapture(tabId, cur.id, 'replaced');
  }
  try {
    if (req.mode === 'stream') {
      const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId,
                                                                  consumerTabId: tabId });
      captures.set(tabId, { id: req.id, mode: 'stream', state: 'started' });
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
    captures.set(tabId, { id: req.id, mode: 'pcm', state: 'started' });
    return { id: req.id, state: 'started', mode: 'pcm', sampleRate: res.sampleRate,
             channels: res.channels };
  } catch (e) {
    if (isGrantError(e)) {
      pending.set(tabId, req);
      setBadge(tabId, true);
      return { id: req.id, state: 'pending-gesture',
               error: 'click the Beatshiver toolbar icon on this tab to allow measuring it' };
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
  if (reason && reason !== 'requested') notifyTab(tabId, Object.assign({ type: 'capture' }, out));
  return out;
}

// ---- messages ---------------------------------------------------------------------------------
ext.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || typeof msg.type !== 'string' || msg.target === 'offscreen') return;
  const tabId = sender.tab && sender.tab.id;

  switch (msg.type) {
    case 'clock': {
      if (tabId == null) return;
      return ready.then(() => {
        if (!listeners.has(tabId)) return;
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
                               captureFallback: HAS_CAPTURE ? null : 'getDisplayMedia' });
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
          notifyTab(msg.tabId, { type: 'capture', id: cur.id, state: 'stopped',
                                 reason: msg.reason || 'ended' });
        }
        return;
      }
      if (listeners.get(msg.tabId) === 'page') {
        ext.tabs.sendMessage(msg.tabId, msg, { frameId: 0 }).catch(() => {});
      }
      return;
  }
});

function originOf(u) { try { return new URL(u).origin; } catch (e) { return null; } }

// ---- the toolbar click: the user gesture Chrome's tab capture needs ---------------------------
if (ext.action && ext.action.onClicked) {
  ext.action.onClicked.addListener(async tab => {
    const req = pending.get(tab.id);
    if (req) {
      pending.delete(tab.id);
      setBadge(tab.id, false);
      const res = await startCapture(tab.id, req);
      notifyTab(tab.id, Object.assign({ type: 'capture' }, res));
      return;
    }
    if (captures.has(tab.id)) {
      await stopCapture(tab.id, null, 'toolbar');
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

ext.tabs.onRemoved.addListener(tabId => {
  pending.delete(tabId);
  if (captures.has(tabId)) stopCapture(tabId, null, 'tab-closed');
  if (listeners.delete(tabId)) persist();
});

// A navigation or reload ends the grant and the page that asked; stop rather than capture the
// next page. (`url` is only in changeInfo when it changed, so a reload is caught by status alone.)
ext.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading') {
    pending.delete(tabId);
    if (captures.has(tabId)) stopCapture(tabId, null, 'navigated');
  }
});
