// The extension's own debug page: proves the clock and capture work with no site changes.
// It plays the part page_relay.js + beatshiver.com would, but listens on the runtime directly.
'use strict';

// Ordinary public embeds, found 2026-11-12 from each site's front page / API. If one goes away,
// paste another into the box.
const SAMPLE_EMBEDS = [
  'https://www.xvideos.com/embedframe/olktlpmf47d',
  'https://www.pornhub.com/embed/6ae6214b360b4',
  'https://framatube.org/videos/embed/9c9de5e8-0a1e-484a-b099-e80766180a6d',
];

const $ = id => document.getElementById(id);
const rows = new Map();   // key -> { tr, last, count }
let myTabId = null;
const params = new URLSearchParams(location.search);
// ?embeds=none for a page with no frames (tests); ?embeds=<url>,<url> for others.
const embedList = params.has('embeds')
  ? params.get('embeds').split(',').filter(u => /^https:\/\//.test(u))
  : SAMPLE_EMBEDS;

// Exposed for automated checks: everything this page has received.
window.__bs = { clocks: [], capture: [], pcm: { chunks: 0, rms: 0, peak: 0, sampleRate: 0 } };

function addFrame(url) {
  const box = document.createElement('div');
  box.className = 'frame';
  const f = document.createElement('iframe');
  f.src = url;
  f.allow = 'autoplay; fullscreen; encrypted-media';
  f.referrerPolicy = 'strict-origin-when-cross-origin';
  const cap = document.createElement('div');
  cap.className = 'cap';
  cap.textContent = url;
  box.append(f, cap);
  $('frames').append(box);
}

function fmt(x, d = 2) { return typeof x === 'number' ? x.toFixed(d) : String(x); }

function onClock(msg) {
  window.__bs.clocks.push({ frame: msg.frame, data: msg.data, at: Date.now() });
  if (window.__bs.clocks.length > 2000) window.__bs.clocks.splice(0, 1000);
  const key = msg.frame.frameId + ' ' + msg.frame.origin;
  let r = rows.get(key);
  if (!r) {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td></td>'.repeat(11);
    $('clocks').tBodies[0].append(tr);
    r = { tr, last: null, count: 0 };
    rows.set(key, r);
  }
  r.last = msg.data;
  r.lastAt = Date.now();
  r.count++;
  r.frame = msg.frame;
}

function paint() {
  const now = Date.now();
  for (const r of rows.values()) {
    const d = r.last, m = d.media || {};
    const live = m.paused === false && !d.adPlaying
      ? m.currentTime + (now - d.wallMs) / 1000 * (m.playbackRate || 1) : m.currentTime;
    const cells = [
      new URL(r.frame.url).host + ' #' + r.frame.frameId, d.site, d.event,
      fmt(m.currentTime), fmt(live), m.paused, m.playbackRate, fmt(m.duration, 1),
      d.adPlaying ? 'AD' : '', r.count, ((now - r.lastAt) / 1000).toFixed(1) + 's',
    ];
    cells.forEach((c, i) => { r.tr.cells[i].textContent = c == null ? '' : c; });
  }
  requestAnimationFrame(paint);
}

// ---- capture ---------------------------------------------------------------------------------
let capId = null;
let peakHold = 0;

function onCapture(msg) {
  window.__bs.capture.push(msg);
  $('capState').textContent = msg.state + (msg.error ? ' — ' + msg.error : '')
    + (msg.sampleRate ? ` (${msg.sampleRate} Hz, ${msg.channels} ch)` : '');
  if (msg.state === 'granted' && capId) startCapture();
}

function onPcm(msg) {
  const bin = atob(msg.b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const f = new Float32Array(bytes.buffer);
  let sum = 0, peak = 0;
  for (let i = 0; i < f.length; i++) { sum += f[i] * f[i]; peak = Math.max(peak, Math.abs(f[i])); }
  const rms = Math.sqrt(sum / Math.max(1, f.length));
  const p = window.__bs.pcm;
  p.chunks++; p.rms = rms; p.peak = Math.max(p.peak, peak); p.sampleRate = msg.sampleRate;
  const db = rms > 0 ? 20 * Math.log10(rms) : -120;
  const pct = Math.max(0, Math.min(100, (db + 60) / 60 * 100));
  peakHold = Math.max(peakHold * 0.97, pct);
  $('level').style.width = pct + '%';
  $('peak').style.left = peakHold + '%';
  $('capStats').textContent = `chunk ${msg.seq} · ${msg.frames} frames @ ${msg.sampleRate} Hz · `
    + `RMS ${db.toFixed(1)} dBFS · peak ${peak.toFixed(3)} · latency ${Date.now() - msg.wallMs} ms`;
}

async function startCapture() {
  capId = capId || 'debug-' + Math.random().toString(36).slice(2, 8);
  const res = await ext.runtime.sendMessage({ type: 'capture-start', id: capId, mode: 'pcm',
                                              channels: 1, chunkFrames: 2048, tabId: myTabId });
  onCapture(res);
}

async function stopCapture() {
  const res = await ext.runtime.sendMessage({ type: 'capture-stop', id: capId, tabId: myTabId });
  onCapture(res);
  capId = null;
}

// A tone to capture when no embed is playing.
let toneCtx = null;
function toggleTone() {
  if (toneCtx) { toneCtx.close(); toneCtx = null; $('tone').textContent = 'Test tone on'; return; }
  toneCtx = new AudioContext();
  const o = toneCtx.createOscillator();
  const g = toneCtx.createGain();
  o.frequency.value = 440; g.gain.value = 0.2;
  o.connect(g).connect(toneCtx.destination);
  o.start();
  $('tone').textContent = 'Test tone off';
}
window.__bsToggleTone = toggleTone;
window.__bsStartCapture = startCapture;
window.__bsStopCapture = stopCapture;

ext.runtime.onMessage.addListener(msg => {
  if (!msg || (msg.tabId != null && msg.tabId !== myTabId)) return;
  if (msg.type === 'clock') onClock(msg);
  else if (msg.type === 'capture') onCapture(msg);
  else if (msg.type === 'pcm' && capId && msg.id === capId) onPcm(msg);
});

(async () => {
  const tab = await ext.tabs.getCurrent();
  myTabId = tab ? tab.id : null;
  await ext.runtime.sendMessage({ type: 'debug-hello', tabId: myTabId });
  const caps = await ext.runtime.sendMessage({ type: 'caps' });
  window.__bs.caps = caps;
  $('caps').textContent = `v${ext.runtime.getManifest().version} · ${caps.browser} · tab ${myTabId}`
    + ` · capture: ${caps.capture.length ? caps.capture.join(', ') : 'none (fallback '
    + caps.captureFallback + ')'}`;
  embedList.forEach(addFrame);
  window.__bs.ready = true;
})();

$('addForm').addEventListener('submit', ev => {
  ev.preventDefault();
  const u = $('addUrl').value.trim();
  if (/^https:\/\//.test(u)) addFrame(u);
});
$('tone').addEventListener('click', toggleTone);
$('capStart').addEventListener('click', startCapture);
$('capStop').addEventListener('click', stopCapture);
requestAnimationFrame(paint);
