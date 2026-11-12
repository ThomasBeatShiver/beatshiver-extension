#!/usr/bin/env node
// Loads dist/chrome unpacked into Playwright's Chromium and checks what can be checked without a
// person: the clock from cross-origin embed frames (fixtures and real sites), the page relay, the
// debug page, and tab capture -- the last only with Chrome's test switch that stands in for the
// toolbar click (--allowlisted-extension-id), and says so.
//
//   node test/run.mjs                 all groups, headless (new headless)
//   node test/run.mjs --headful       same, with a window
//   node test/run.mjs --only=real     one group: fixtures | real | debug | gesture | capture
//   node test/run.mjs --no-real       skip the groups that need the public internet
//
// beatshiver.com is never contacted: the test serves its own page at https://beatshiver.com/__bsx/
// through Playwright routing, so the real top-frame content script matches it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = path.join(ROOT, 'dist', 'chrome');
const FIX = path.join(ROOT, 'test', 'fixtures');
const OUT = path.join(ROOT, 'test', 'out');
fs.mkdirSync(OUT, { recursive: true });

const argv = process.argv.slice(2);
const HEADFUL = argv.includes('--headful');
const NO_REAL = argv.includes('--no-real');
const ONLY = (argv.find(a => a.startsWith('--only=')) || '').slice(7) || null;

const REAL = {
  xvideos: 'https://www.xvideos.com/embedframe/olktlpmf47d',
  pornhub: 'https://www.pornhub.com/embed/6ae6214b360b4',
  peertube: 'https://framatube.org/videos/embed/9c9de5e8-0a1e-484a-b099-e80766180a6d',
};

const results = [];
function record(group, name, ok, detail) {
  results.push({ group, name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} [${group}] ${name}${detail ? ' -- ' + detail : ''}`);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

function wav(seconds, rate = 8000, freq = 330) {
  const n = Math.round(seconds * rate);
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin(2 * Math.PI * freq * i / rate) * 3000), 44 + i * 2);
  return b;
}

async function launch(extraArgs = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsx-profile-'));
  const ctx = await chromium.launchPersistentContext(dir, {
    channel: 'chromium',
    headless: !HEADFUL,
    args: [
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      '--autoplay-policy=no-user-gesture-required',
      ...extraArgs,
    ],
    viewport: { width: 1280, height: 900 },
  });
  // Fixtures: our page at beatshiver.com, our stand-in players at real embed URLs.
  await ctx.route('https://beatshiver.com/__bsx/**', route => {
    const u = new URL(route.request().url());
    if (u.pathname === '/__bsx/client.js') {
      return route.fulfill({ contentType: 'text/javascript',
        body: fs.readFileSync(path.join(ROOT, 'client', 'beatshiver-extension-client.js')) });
    }
    return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(FIX, 'page.html')) });
  });
  const fixtureEmbed = route => {
    const u = new URL(route.request().url());
    if (u.pathname.startsWith('/__bsx/tone.wav')) {
      return route.fulfill({ contentType: 'audio/wav', body: wav(+u.searchParams.get('s') || 10) });
    }
    return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(FIX, 'embed.html')) });
  };
  await ctx.route('https://www.pornhub.com/embed/BSXFIXTURE*', fixtureEmbed);
  await ctx.route('https://www.xvideos.com/embedframe/BSXFIXTURE*', fixtureEmbed);
  await ctx.route('https://w.soundcloud.com/player/BSXFIXTURE*', fixtureEmbed);
  for (const h of ['https://www.pornhub.com', 'https://www.xvideos.com', 'https://w.soundcloud.com']) {
    await ctx.route(h + '/__bsx/**', fixtureEmbed);
  }
  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
  const id = new URL(sw.url()).host;
  return { ctx, id, dir, sw };
}

async function close(L) {
  await L.ctx.close();
  try { fs.rmSync(L.dir, { recursive: true, force: true }); } catch (e) {}
}

function byOrigin(clocks) {
  const m = {};
  for (const c of clocks) (m[c.frame.origin] = m[c.frame.origin] || []).push(c);
  return m;
}

// ---- groups -----------------------------------------------------------------------------------

async function fixtures(L) {
  const G = 'fixtures';
  const page = await L.ctx.newPage();
  const embeds = [
    'https://www.pornhub.com/embed/BSXFIXTURE?kind=pornhub',
    'https://www.xvideos.com/embedframe/BSXFIXTURE?kind=xvideos',
    'https://w.soundcloud.com/player/BSXFIXTURE?kind=soundcloud',
  ];
  await page.goto('https://beatshiver.com/__bsx/test.html?embeds=' + encodeURIComponent(embeds.join(',')));
  await page.waitForFunction(() => window.__t && window.__t.detect !== null, null, { timeout: 5000 })
    .catch(() => {});
  const t0 = await page.evaluate(() => ({ detect: window.__t.detect, attr: window.__t.attrAtStart }));
  record(G, 'page detects extension (hello -> ready)', !!t0.detect,
         JSON.stringify(t0.detect));
  record(G, 'data-beatshiver-extension attribute present before page script', !!t0.attr, 'attr=' + t0.attr);

  // Pornhub fixture: 3 s pre-roll in its own element, then content, both in a closed shadow root.
  await sleep(1800);
  const early = await page.evaluate(() => window.__t.clocks.filter(c => c.frame.origin === 'https://www.pornhub.com').slice(-1)[0]);
  record(G, 'pornhub fixture: pre-roll flagged adPlaying, content clock held at 0',
         !!early && early.adPlaying === true && early.media && early.media.currentTime === 0 && early.media.paused === true,
         early ? `adPlaying=${early.adPlaying} t=${early.media && early.media.currentTime} paused=${early.media && early.media.paused} candidates=${early.candidates}` : 'no message');
  await sleep(4500);
  const ph = page.frames().find(f => f.url().startsWith('https://www.pornhub.com/embed/'));
  const after = await page.evaluate(() => window.__t.clocks.filter(c => c.frame.origin === 'https://www.pornhub.com').slice(-1)[0]);
  const real = await ph.evaluate(() => window.__fx.state());
  record(G, 'pornhub fixture: after pre-roll the content clock runs (closed shadow root)',
         !!after && !after.adPlaying && after.media && !after.media.paused && after.media.currentTime > 0.5
         && Math.abs(after.media.currentTime - real.t) < 1,
         after ? `reported t=${after.media.currentTime.toFixed(2)} actual t=${real.t.toFixed(2)} ad=${after.adPlaying}` : 'none');

  // Pause / seek / rate in the xvideos fixture, reflected as events.
  const xv = page.frames().find(f => f.url().startsWith('https://www.xvideos.com/embedframe/'));
  const n0 = await page.evaluate(() => window.__t.clocks.length);
  await xv.evaluate(() => window.__fx.pause()); await sleep(400);
  await xv.evaluate(() => window.__fx.seek(12.5)); await sleep(400);
  await xv.evaluate(() => window.__fx.rate(1.5)); await sleep(400);
  await xv.evaluate(() => window.__fx.play()); await sleep(800);
  const evs = await page.evaluate(n => window.__t.clocks.slice(n)
    .filter(c => c.frame.origin === 'https://www.xvideos.com' && c.event !== 'tick')
    .map(c => ({ e: c.event, t: c.media && c.media.currentTime, p: c.media && c.media.paused, r: c.media && c.media.playbackRate })), n0);
  const names = evs.map(e => e.e);
  const seeked = evs.find(e => e.e === 'seeked');
  const rate = evs.find(e => e.e === 'ratechange');
  record(G, 'xvideos fixture: pause, seeked, ratechange, play events arrive in order',
         ['pause', 'seeked', 'ratechange', 'play'].every(n => names.includes(n))
         && names.indexOf('pause') < names.indexOf('seeked') && names.indexOf('seeked') < names.indexOf('ratechange')
         && names.indexOf('ratechange') < names.lastIndexOf('play')
         && seeked && Math.abs(seeked.t - 12.5) < 0.1 && rate && rate.r === 1.5,
         JSON.stringify(evs));

  // SoundCloud fixture: a detached new Audio() is still found.
  const sc = await page.evaluate(() => window.__t.clocks.filter(c => c.frame.origin === 'https://w.soundcloud.com').slice(-1)[0]);
  record(G, 'soundcloud fixture: detached Audio() element found and clocked',
         !!sc && sc.media && sc.media.kind === 'audio' && sc.media.currentTime > 1,
         sc ? `t=${sc.media && sc.media.currentTime.toFixed(2)} kind=${sc.media && sc.media.kind}` : 'none');

  // Message shape.
  const one = await page.evaluate(() => window.__t.clocks.slice(-1)[0]);
  const keys = ['source', 'v', 'type', 'frame', 'site', 'event', 'media', 'adPlaying', 'wallMs', 'seq'];
  record(G, 'clock message shape', keys.every(k => k in one) && one.source === 'beatshiver-extension' && one.type === 'clock',
         Object.keys(one).join(','));

  // Latency: frame wallMs -> page receipt.
  const lat = await page.evaluate(async () => {
    const xs = [];
    const h = ev => { if (ev.data && ev.data.type === 'clock' && ev.data.source === 'beatshiver-extension') xs.push(Date.now() - ev.data.wallMs); };
    window.addEventListener('message', h);
    await new Promise(r => setTimeout(r, 3000));
    window.removeEventListener('message', h);
    xs.sort((a, b) => a - b);
    return { n: xs.length, p50: xs[xs.length >> 1], p95: xs[Math.floor(xs.length * 0.95)], max: xs[xs.length - 1] };
  });
  record(G, 'relay latency frame -> page (ms)', lat.n > 5 && lat.p95 < 100, JSON.stringify(lat));

  // An embed on a page that is not beatshiver.com reports nowhere.
  await page.close();
  const other = await L.ctx.newPage();
  await other.route('https://example.com/**', r => r.fulfill({ contentType: 'text/html',
    body: `<iframe src="https://www.xvideos.com/embedframe/BSXFIXTURE?kind=xvideos"></iframe>
           <script>window.__got=[];addEventListener('message',e=>{if(e.data&&e.data.source==='beatshiver-extension')__got.push(e.data)})</script>` }));
  await other.goto('https://example.com/');
  await sleep(2000);
  const leaked = await other.evaluate(() => window.__got.length);
  record(G, 'no clock reaches a non-beatshiver top page', leaked === 0, `messages=${leaked}`);
  await other.close();
}

// Start playback in each real embed: a real click on the player (Pornhub's player only starts
// from its own click handler), then play() muted as a fallback for the others.
async function startReal(page) {
  for (const f of page.frames()) {
    if (f === page.mainFrame()) continue;
    if (f.url().startsWith('https://www.pornhub.com/')) {
      await f.click('#player', { timeout: 3000 }).catch(() => {});
      continue;
    }
    await f.evaluate(() => { const v = document.querySelector('video'); if (v) { v.muted = true; v.play().catch(() => {}); } })
      .catch(() => {});
  }
}

async function realEmbeds(L) {
  const G = 'real';
  const page = await L.ctx.newPage();
  await page.goto('https://beatshiver.com/__bsx/test.html?embeds=' + encodeURIComponent(Object.values(REAL).join(',')));
  await sleep(6000);
  await startReal(page);
  await sleep(10000);
  const clocks = await page.evaluate(() => window.__t.clocks);
  const by = byOrigin(clocks);
  for (const [site, url] of Object.entries(REAL)) {
    const origin = new URL(url).origin;
    const xs = (by[origin] || []).filter(c => c.media);
    const ts = xs.map(c => c.media.currentTime);
    const advancing = ts.length > 3 && ts[ts.length - 1] - ts[0] > 2;
    const last = xs[xs.length - 1];
    record(G, `${site}: clock from real cross-origin embed frame ${origin}`, advancing,
           `${(by[origin] || []).length} msgs, t ${ts[0] != null ? ts[0].toFixed(2) : '-'} -> ${ts.length ? ts[ts.length - 1].toFixed(2) : '-'}`
           + (last ? `, dur=${last.media.duration}, ad=${last.adPlaying}, candidates=${last.candidates}, site=${last.site}` : ''));
  }
  fs.writeFileSync(path.join(OUT, 'real-clocks.json'), JSON.stringify(clocks.slice(-60), null, 1));
  await page.screenshot({ path: path.join(OUT, 'real-embeds.png') });
  await page.close();
}

async function debugPage(L) {
  const G = 'debug';
  const page = await L.ctx.newPage();
  await page.goto(`chrome-extension://${L.id}/debug.html`);
  await page.waitForFunction(() => window.__bs && window.__bs.ready, null, { timeout: 10000 });
  await sleep(6000);
  await startReal(page);
  await sleep(8000);
  const s = await page.evaluate(() => ({ caps: window.__bs.caps,
    by: Object.entries(window.__bs.clocks.reduce((m, c) => { (m[c.frame.origin] = m[c.frame.origin] || []).push(c.data.media && c.data.media.currentTime); return m; }, {}))
      .map(([o, ts]) => [o, ts.length, ts.filter(x => x != null).slice(-1)[0]]) }));
  const origins = s.by.filter(([, n, t]) => n > 3 && t > 1).map(([o]) => o);
  record(G, 'debug page receives clocks from framed embeds', origins.length >= 1, JSON.stringify(s.by));
  record(G, 'debug page reports capture capability', s.caps && s.caps.capture.includes('pcm'), JSON.stringify(s.caps));
  await page.screenshot({ path: path.join(OUT, 'debug-page.png'), fullPage: true });
  await page.close();
}

async function gesture(L) {
  const G = 'gesture';
  // Without the toolbar click Chrome refuses tab capture; the request must park, not fail.
  const page = await L.ctx.newPage();
  await page.goto('https://beatshiver.com/__bsx/test.html');
  await page.waitForFunction(() => window.__t && window.__t.detect !== null, null, { timeout: 5000 });
  const r = await page.evaluate(() => window.__capError('pcm'));
  record(G, 'capture without a toolbar click parks as pending-gesture', /ExtensionNeedsGesture/.test(r), r);
  await page.close();
}

async function capture(L) {
  const G = 'capture';
  const page = await L.ctx.newPage();
  await page.goto('https://beatshiver.com/__bsx/test.html');
  await page.waitForFunction(() => window.__t && window.__t.detect !== null, null, { timeout: 5000 });
  await page.evaluate(() => window.__toneOn(0.2, 440));
  // pcm mode: offscreen capture, re-routed to the speakers, PCM back to the page.
  let r;
  try { r = await page.evaluate(() => window.__capPcm()); } catch (e) { r = { error: e.message }; }
  await sleep(2500);
  const pcm = await page.evaluate(() => window.__t.pcm);
  const rms = pcm.n ? Math.sqrt(pcm.sumSq / pcm.n) : 0;
  // A 0.2-amplitude sine has RMS 0.141.
  record(G, 'pcm mode: chunks arrive with the tab tone in them',
         pcm.chunks > 10 && rms > 0.08 && rms < 0.2,
         `start=${JSON.stringify(r)} chunks=${pcm.chunks} rate=${pcm.sampleRate} rms=${rms.toFixed(4)} lastLatency=${pcm.lastLatency}ms`);
  const offscreenCount = L.ctx.serviceWorkers().length; // informational
  await page.evaluate(() => window.__cap && window.__cap.stop());
  await sleep(600);
  const c1 = await page.evaluate(() => window.__t.pcm.chunks);
  await sleep(800);
  const c2 = await page.evaluate(() => window.__t.pcm.chunks);
  record(G, 'pcm mode: stop stops the chunks', c2 === c1, `chunks ${c1} -> ${c2}`);

  // stream mode, unmonitored: the page holds a real MediaStream of its own tab.
  let s;
  try { s = await page.evaluate(() => window.__capStream(false)); } catch (e) { s = { error: e.message.split('\n')[0] }; }
  const mean = s.rms ? s.rms.reduce((a, b) => a + b, 0) / s.rms.length : 0;
  record(G, 'stream mode: page gets a MediaStream of the tab with the tone in it',
         !!s.rms && mean > 0.08 && mean < 0.2, JSON.stringify({ tracks: s.tracks, error: s.error, mean: +mean.toFixed(4) }));
  await page.evaluate(() => window.__cap && window.__cap.stop());
  await sleep(500);

  // stream mode, monitored in the same tab: does the replay feed back into the capture?
  try { s = await page.evaluate(() => window.__capStream(true)); } catch (e) { s = { error: e.message.split('\n')[0] }; }
  const first = s.rms ? s.rms.slice(0, 5).reduce((a, b) => a + b) / 5 : 0;
  const last = s.rms ? s.rms.slice(-5).reduce((a, b) => a + b) / 5 : 0;
  record(G, 'stream mode + same-tab monitor: level (feedback check, informational)', true,
         `first0.5s=${first.toFixed(4)} last0.5s=${last.toFixed(4)} ${s.error || ''}`);
  await page.evaluate(() => window.__cap && window.__cap.stop());
  await page.close();
  void offscreenCount;
}

// ---- main -------------------------------------------------------------------------------------
const want = g => (!ONLY || ONLY === g) && !(NO_REAL && (g === 'real' || g === 'debug'));

let L = await launch();
console.log(`extension id ${L.id} (${HEADFUL ? 'headful' : 'headless'})`);
try {
  if (want('fixtures')) await fixtures(L);
  if (want('real')) await realEmbeds(L);
  if (want('debug')) await debugPage(L);
  if (want('gesture')) await gesture(L);
} catch (e) { record('harness', 'uncaught', false, e.stack); }
const id = L.id;
await close(L);

if (want('capture')) {
  // Chrome's own test switch: treat this extension as allowlisted for tab capture, standing in
  // for the toolbar click a person makes. Nothing in the extension knows about it.
  L = await launch([`--allowlisted-extension-id=${id}`]);
  try { await capture(L); } catch (e) { record('capture', 'uncaught', false, e.stack); }
  await close(L);
}

const failed = results.filter(r => !r.ok);
fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 1));
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
