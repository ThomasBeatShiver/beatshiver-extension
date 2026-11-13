// ISOLATED world, document_start, the beatshiver.com top frame only.
//
// The page's only contact with the extension. It speaks window.postMessage in one fixed shape
// (INTEGRATION.md): messages *to* the page carry `source: 'beatshiver-extension'`, messages
// *from* the page carry `source: 'beatshiver-page'`. Everything else on the channel is ignored.
(function () {
  'use strict';
  if (window !== window.top) return;

  const V = 1;
  const ORIGIN = location.origin;
  const version = ext.runtime.getManifest().version;

  // Synchronous detection: present before any page script runs.
  try { document.documentElement.setAttribute('data-beatshiver-extension', version); } catch (e) {}

  function toPage(msg, transfer) {
    window.postMessage(Object.assign({ source: 'beatshiver-extension', v: V }, msg), ORIGIN,
                       transfer || []);
  }

  let caps = null;
  async function getCaps() {
    if (!caps) {
      try { caps = await ext.runtime.sendMessage({ type: 'caps' }); } catch (e) { caps = null; }
    }
    return caps || { clock: true, capture: [], browser: 'unknown' };
  }

  async function announce(replyTo) {
    const c = await getCaps();
    // `sources`: the sites the page may `source-open` (sites.js `measureOn: 'source'`), [] where
    // the browser cannot capture. Also in capabilities, beside `capture`.
    toPage({ type: 'ready', version, replyTo: replyTo || null, capabilities: c,
             sources: c.sources || [] });
  }

  // Register this tab as a listener. Re-sent on every load, so a background that restarted and
  // lost its registry learns it again from the next page.
  function register() {
    try {
      const p = ext.runtime.sendMessage({ type: 'page-hello', url: location.href });
      if (p && p.catch) p.catch(() => {});
    } catch (e) {}
  }
  register();
  announce();

  window.addEventListener('message', ev => {
    if (ev.source !== window || ev.origin !== ORIGIN) return;
    const m = ev.data;
    if (!m || m.source !== 'beatshiver-page' || typeof m.type !== 'string') return;
    switch (m.type) {
      case 'hello':
        register();
        announce(m.id);
        break;
      case 'capture-start':
      case 'capture-stop': {
        const req = {
          type: m.type,
          id: String(m.id || ''),
          mode: m.mode === 'pcm' ? 'pcm' : 'stream',
          channels: m.channels === 2 ? 2 : 1,
          chunkFrames: Math.max(256, Math.min(16384, (m.chunkFrames | 0) || 2048)),
          sampleRate: (m.sampleRate | 0) || 0,
          monitor: m.monitor !== false,
        };
        ext.runtime.sendMessage(req).then(
          res => { if (res) toPage(Object.assign({ type: 'capture' }, res)); },
          err => toPage({ type: 'capture', id: req.id, state: 'error',
                          error: String(err && err.message || err) }));
        break;
      }
      case 'source-open':
      case 'source-close': {
        // Measure on the source site's own page. The background validates `url` against the
        // site's configured pages; this only passes plain strings on.
        const req = { type: m.type, id: String(m.id || '') };
        if (m.type === 'source-open') {
          req.site = String(m.site || '');
          req.url = String(m.url || '');
          if (m.channels === 2) req.channels = 2;
          if (m.chunkFrames) req.chunkFrames = m.chunkFrames | 0;
          if (m.sampleRate) req.sampleRate = m.sampleRate | 0;
        }
        ext.runtime.sendMessage(req).then(
          res => { if (res) toPage(res); },
          err => toPage({ type: 'source', id: req.id, state: 'error',
                          reason: String(err && err.message || err) }));
        break;
      }
    }
  });

  function b64ToFloat32(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Float32Array(bytes.buffer);
  }

  ext.runtime.onMessage.addListener(msg => {
    if (!msg || typeof msg.type !== 'string') return;
    if (msg.type === 'clock') {
      toPage({ type: 'clock', frame: msg.frame, ...msg.data });
    } else if (msg.type === 'capture' || msg.type === 'source') {
      toPage(msg);
    } else if (msg.type === 'pcm') {
      const data = b64ToFloat32(msg.b64);
      const out = { type: 'pcm', id: msg.id, seq: msg.seq, sampleRate: msg.sampleRate,
                    channels: msg.channels, frames: msg.frames, wallMs: msg.wallMs, data };
      // Audio of a source tab: `id` is the source session's, `site` its site id. (Not `source`:
      // that is the envelope's.)
      if (msg.site) out.site = msg.site;
      toPage(out, [data.buffer]);
    }
  });
})();
