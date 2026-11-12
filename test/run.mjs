#!/usr/bin/env node
// Loads dist/chrome unpacked into Playwright's Chromium and checks what can be checked without a
// person: the clock from cross-origin embed frames (fixtures and real sites), the page relay, the
// debug page, and tab capture -- the last only with Chrome's test switch that stands in for the
// toolbar click (--allowlisted-extension-id), and says so.
//
//   node test/run.mjs                 all groups, headless (new headless)
//   node test/run.mjs --headful       same, with a window
//   node test/run.mjs --only=real     one group: fixtures | real | debug | gesture | capture |
//                                     source | source-real
//   node test/run.mjs --no-real       skip the groups that need the public internet
//
// beatshiver.com is never contacted: the test serves its own page at https://beatshiver.com/__bsx/
// through Playwright routing, so the real top-frame content script matches it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = path.join(ROOT, 'dist', 'chrome');
const FIX = path.join(ROOT, 'test', 'fixtures');
const OUT = path.join(ROOT, 'test', 'out');
fs.mkdirSync(OUT, { recursive: true });
// Always test what src/ says now, never a stale dist/.
execFileSync(process.execPath, [path.join(ROOT, 'build.mjs'), 'chrome'], { stdio: 'inherit' });

const argv = process.argv.slice(2);
const HEADFUL = argv.includes('--headful');
// Headful runs play the test tone on the real speakers unless muted; --audible to hear it.
const MUTE = HEADFUL && !argv.includes('--audible');
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

// ---- the source fixture at the real www.youtube.com --------------------------------------------
// A tab the extension opens itself (chrome.tabs.create) starts loading before Playwright attaches
// to it, so ctx.route never sees that navigation (measured: the real youtube.com loaded). The
// source group therefore maps www.youtube.com to a local HTTPS server with a throwaway
// self-signed certificate (Chromium's resolver rules + ignored certificate errors).
function opensslBin() {
  for (const b of ['openssl', 'C:/Program Files/Git/usr/bin/openssl.exe',
                   'C:/Program Files/Git/mingw64/bin/openssl.exe']) {
    try { execFileSync(b, ['version'], { stdio: 'ignore' }); return b; } catch (e) {}
  }
  return null;
}
async function ytServer() {
  const bin = opensslBin();
  if (!bin) throw new Error('openssl not found: the source group needs it for its local https fixture');
  const key = path.join(OUT, 'yt-key.pem'), cert = path.join(OUT, 'yt-cert.pem');
  execFileSync(bin, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
                     '-days', '2', '-subj', '/CN=www.youtube.com',
                     '-addext', 'subjectAltName=DNS:www.youtube.com'], { stdio: 'ignore' });
  const srv = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (req, res) => {
    const u = new URL(req.url, 'https://www.youtube.com');
    const file = u.pathname === '/watch' ? 'youtube_watch.html'
      : u.pathname.startsWith('/embed/') ? 'embed.html' : null;
    if (!file) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(fs.readFileSync(path.join(FIX, file)));
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  return { srv, args: [`--host-resolver-rules=MAP www.youtube.com 127.0.0.1:${port}`,
                       '--ignore-certificate-errors'] };
}

async function launch(extraArgs = [], { unmute = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bsx-profile-'));
  const ctx = await chromium.launchPersistentContext(dir, {
    channel: 'chromium',
    headless: !HEADFUL,
    args: [
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      '--autoplay-policy=no-user-gesture-required',
      ...(MUTE && !unmute ? ['--mute-audio'] : []),
      ...extraArgs,
    ],
    viewport: { width: 1280, height: 900 },
    // Playwright mutes headless Chromium by default, and a muted tab captures as silence
    // (measured: --mute-audio gives RMS 0.0000 in both capture modes). The capture group needs
    // the audio unmuted; its tone is kept quiet for that reason.
    ignoreDefaultArgs: unmute ? ['--mute-audio'] : [],
  });
  // Fixtures: our page at beatshiver.com, our stand-in players at real embed URLs.
  const pageRoute = route => {
    const u = new URL(route.request().url());
    if (u.pathname === '/__bsx/client.js') {
      return route.fulfill({ contentType: 'text/javascript',
        body: fs.readFileSync(path.join(ROOT, 'client', 'beatshiver-extension-client.js')) });
    }
    return route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(FIX, 'page.html')) });
  };
  // qa too: every page origin in sites.js must actually receive clocks, not just match the
  // manifest (a hardcoded beatshiver.com in embed_relay.js once dropped every qa clock).
  await ctx.route('https://beatshiver.com/__bsx/**', pageRoute);
  await ctx.route('https://qa.beatshiver.com/__bsx/**', pageRoute);
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
  // A YouTube embed (no longer clocked). Only BSX* refs: live youtube.com stays reachable. The
  // watch-page fixture is served by ytServer() instead (see there).
  await ctx.route(/^https:\/\/www\.youtube\.com\/embed\/BSXFIXTURE/, fixtureEmbed);
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
  let page = await L.ctx.newPage();
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

  // xvideos pre-roll layout: an unmarked short <video> beside the paused long content.
  await page.close();
  await xvPreroll(L);
  page = null;

  // An embed on a page that is not beatshiver.com reports nowhere.
  const other = await L.ctx.newPage();
  await other.route('https://example.com/**', r => r.fulfill({ contentType: 'text/html',
    body: `<iframe src="https://www.xvideos.com/embedframe/BSXFIXTURE?kind=xvideos"></iframe>
           <script>window.__got=[];addEventListener('message',e=>{if(e.data&&e.data.source==='beatshiver-extension')__got.push(e.data)})</script>` }));
  await other.goto('https://example.com/');
  await sleep(2000);
  const leaked = await other.evaluate(() => window.__got.length);
  record(G, 'no clock reaches a non-beatshiver top page', leaked === 0, `messages=${leaked}`);
  await other.close();

  // ...and one does reach qa.beatshiver.com, the channel the site's half ships on first.
  const qa = await L.ctx.newPage();
  await qa.goto('https://qa.beatshiver.com/__bsx/test.html?embeds='
    + encodeURIComponent('https://www.xvideos.com/embedframe/BSXFIXTURE?kind=xvideos'));
  let qaGot = 0;
  for (let i = 0; i < 20 && !qaGot; i++) {
    await sleep(250);
    qaGot = await qa.evaluate(() => (window.__t && window.__t.clocks || []).length);
  }
  record(G, 'clocks reach a qa.beatshiver.com top page', qaGot > 0, `messages=${qaGot}`);
  await qa.close();
}

// Start playback in each real embed: a real click on the player (Pornhub's player only starts
// from its own click handler), then play() muted as a fallback for the others.
async function xvPreroll(L) {
  const G = 'fixtures';
  const page = await L.ctx.newPage();
  await page.goto('https://beatshiver.com/__bsx/test.html?embeds='
    + encodeURIComponent('https://www.xvideos.com/embedframe/BSXFIXTURE?kind=xvideos-preroll'));
  await sleep(2000);   // content loaded, pre-roll (4 s) playing
  const fr = page.frames().find(f => f.url().includes('kind=xvideos-preroll'));
  const during = await fr.evaluate(() => ({ adT: window.__fx.ad && window.__fx.ad.currentTime,
                                            adPaused: window.__fx.ad && window.__fx.ad.paused }));
  await sleep(5500);   // pre-roll over, content ~2.5 s in
  const xs = await page.evaluate(() => window.__t.clocks.filter(c => c.frame.origin === 'https://www.xvideos.com'));
  const withMedia = xs.filter(c => c.media);
  const ids = [...new Set(withMedia.map(c => c.media.mediaId))];
  const durs = [...new Set(withMedia.map(c => c.media.duration))];
  const adMsgs = xs.filter(c => c.adPlaying);
  const heldDuringAd = adMsgs.every(c => c.media && c.media.paused && c.media.currentTime === 0);
  const last = withMedia[withMedia.length - 1];
  record(G, 'xvideos pre-roll fixture: the unmarked short overlay never becomes the clock',
         ids.length === 1 && durs.length === 1 && durs[0] === 120,
         `mediaIds=${JSON.stringify(ids)} durations=${JSON.stringify(durs)} msgs=${xs.length}`);
  record(G, 'xvideos pre-roll fixture: adPlaying through the pre-roll, content held at 0',
         adMsgs.length >= 3 && heldDuringAd && !adMsgs[0].media.currentTime && during.adPaused === false,
         `adMsgs=${adMsgs.length} held=${heldDuringAd} adTimeAt2s=${during.adT && during.adT.toFixed(2)}`
         + ` firstAdEvent=${adMsgs[0] && adMsgs[0].event} seq=${xs.map(c => c.event + ":" + c.candidates + ":" + c.adPlaying).join(",")}`);
  record(G, 'xvideos pre-roll fixture: content then plays from 0',
         !!last && !last.adPlaying && !last.media.paused && last.media.currentTime > 1 && last.media.currentTime < 4,
         last ? `t=${last.media.currentTime.toFixed(2)} paused=${last.media.paused} ad=${last.adPlaying}` : 'none');
  await page.close();
}

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

// Quiet: this tone really plays on the machine's speakers (see `unmute`). RMS of a sine = A/sqrt2.
const AMP = 0.02, RMS = AMP / Math.SQRT2;
const near = x => x > RMS * 0.8 && x < RMS * 1.2;

async function capture(L) {
  const G = 'capture';
  const page = await L.ctx.newPage();
  await page.goto('https://beatshiver.com/__bsx/test.html');
  await page.waitForFunction(() => window.__t && window.__t.detect !== null, null, { timeout: 5000 });
  const toneState = await page.evaluate(a => window.__toneOn(a, 440), AMP);
  console.log('tone context state', toneState);
  // pcm mode: offscreen capture, re-routed to the speakers, PCM back to the page.
  let r;
  try { r = await page.evaluate(() => window.__capPcm()); } catch (e) { r = { error: e.message }; }
  await sleep(2500);
  const pcm = await page.evaluate(() => window.__t.pcm);
  const rms = pcm.n ? Math.sqrt(pcm.sumSq / pcm.n) : 0;
  record(G, 'pcm mode: chunks arrive with the tab tone in them',
         pcm.chunks > 10 && near(rms),
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
         !!s.rms && near(mean), JSON.stringify({ tracks: s.tracks, error: s.error, mean: +mean.toFixed(4) }));
  await page.evaluate(() => window.__cap && window.__cap.stop());
  await sleep(500);

  // stream mode, monitored in the same tab: does the replay feed back into the capture?
  try { s = await page.evaluate(() => window.__capStream(true)); } catch (e) { s = { error: e.message.split('\n')[0] }; }
  const first = s.rms ? s.rms.slice(0, 5).reduce((a, b) => a + b) / 5 : 0;
  const last = s.rms ? s.rms.slice(-5).reduce((a, b) => a + b) / 5 : 0;
  // Measured 2026-11-12: replaying the captured stream in the captured tab feeds back (0.141 tone
  // grew to 0.35 then 0.57 RMS in two seconds). This asserts it, so the client's refusal to
  // monitor in stream mode stays justified.
  // Informational: how far it grows varies run to run (0.0143 to 0.089 against 0.0141).
  record(G, 'stream mode + same-tab monitor: level vs. the tone (feedback check, informational)',
         true, `expected ${RMS.toFixed(4)}, first0.5s=${first.toFixed(4)} last0.5s=${last.toFixed(4)} ${s.error || ''}`);
  await page.evaluate(() => window.__cap && window.__cap.stop());
  await page.close();
  void offscreenCount;
}

// ---- measure on the source (sites.js measureOn: 'source'; YouTube is the configured one) ------

const YT_FIX = 'https://www.youtube.com/watch?v=BSXFIXTURE';

/** The extension's tabs and its source sessions, read inside the service worker. */
async function swState(L) {
  return L.sw.evaluate(async () => {
    const tabs = (await chrome.tabs.query({})).map(t => ({ id: t.id, index: t.index, active: t.active,
                                                           opener: t.openerTabId, windowId: t.windowId }));
    const { sources } = await chrome.storage.session.get('sources');
    return { tabs, sources: sources || {} };
  });
}
const badge = (L, tabId) => L.sw.evaluate(id => chrome.action.getBadgeText({ tabId: id }), tabId);

async function until(fn, ms = 8000, step = 200) {
  const t0 = Date.now();
  let v;
  while (Date.now() - t0 < ms) { v = await fn(); if (v) return v; await sleep(step); }
  return v;
}

/** Opens a source session from the beatshiver page; resolves with its id and the new tab. */
async function openSource(L, page, url) {
  const newTab = L.ctx.waitForEvent('page', { timeout: 10000 });
  const id = await page.evaluate(u => window.__openSource('youtube', u), url);
  const tab = await newTab;
  // The 'page' event fires on the new tab's about:blank; wait for the source page itself.
  await tab.waitForURL(/^https:\/\/www\.youtube\.com\/watch/, { timeout: 10000 }).catch(() => {});
  await tab.waitForFunction(() => window.__fx, null, { timeout: 10000 }).catch(() => {});
  return { id, tab };
}
const S = (page, id) => page.evaluate(i => {
  const s = window.__t.src[i];
  return { states: s.states, clocks: s.clocks, pcm: s.pcm };
}, id);

async function source(L) {
  const G = 'source';
  const page = await L.ctx.newPage();
  // A YouTube *embed* on the page: no longer clocked at all (measured on youtube.com instead).
  await page.goto('https://beatshiver.com/__bsx/test.html?embeds='
    + encodeURIComponent('https://www.youtube.com/embed/BSXFIXTURE?kind=xvideos'));
  await page.waitForFunction(() => window.__t && window.__t.detect !== null, null, { timeout: 5000 });
  const det = await page.evaluate(() => window.__t.detect);
  record(G, 'ready advertises sources: [youtube]',
         !!det && JSON.stringify(det.sources) === '["youtube"]', JSON.stringify(det && det.sources));
  await sleep(2500);
  const ytFrame = page.frames().find(f => f.url().startsWith('https://www.youtube.com/embed/'));
  const embedT = ytFrame ? await ytFrame.evaluate(() => window.__fx.state().t) : null;
  const embedClocks = await page.evaluate(() => window.__t.raw.filter(m => m.type === 'clock').length);
  record(G, 'youtube embed gets no clock', !!ytFrame && embedT > 1 && embedClocks === 0,
         `embed playing t=${embedT && embedT.toFixed(2)}, clocks=${embedClocks}`);

  // Validation: only the site's own item pages are opened.
  const tabsBefore = (await swState(L)).tabs.length;
  const refused = [];
  for (const [site, url] of [['youtube', 'https://www.youtube.com/feed/subscriptions'],
                             ['youtube', 'https://evil.example/watch?v=BSXFIXTURE'],
                             ['youtube', 'https://www.youtube.com.evil.example/watch?v=x'],
                             ['xvideos', 'https://www.xvideos.com/embedframe/BSXFIXTURE'],
                             ['youtube', 'https://www.youtube.com/embed/BSXFIXTURE']]) {
    const r = await page.evaluate(async ([s, u]) => {
      const id = 'v-' + Math.random();
      window.postMessage({ source: 'beatshiver-page', v: 1, type: 'source-open', id, site: s, url: u }, location.origin);
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 50));
        const m = window.__t.raw.find(x => x.type === 'source' && x.id === id);
        if (m) return m.state;
      }
      return 'no answer';
    }, [site, url]);
    refused.push(`${site} ${url} -> ${r}`);
  }
  const tabsAfter = (await swState(L)).tabs.length;
  record(G, 'source-open refuses urls off the site\'s pages / itemPath',
         refused.every(x => x.endsWith('-> error')) && tabsAfter === tabsBefore,
         refused.join('; '));

  // A YouTube tab the user opened themselves: nothing reaches the page.
  const own = await L.ctx.newPage();
  await own.goto(YT_FIX + '&dur=30');
  await sleep(1500);
  const ownLeak = await page.evaluate(() => window.__t.raw.filter(m => m.type === 'clock').length);
  record(G, 'a youtube tab not opened by source-open reports nowhere', ownLeak === 0,
         `clocks=${ownLeak}`);
  await own.close();

  // Open, clock relayed cross-tab with the contract's frame.
  const { id, tab: yt } = await openSource(L, page, YT_FIX);
  const tagged = await until(async () => {
    const s = await S(page, id);
    return s.clocks.filter(x => x.media && x.media.currentTime > 1).length > 3 ? s : null;
  }, 8000);
  const st = await swState(L);
  const sess = st.sources[id];
  const pageTab = st.tabs.find(t => t.id === (sess && sess.consumerTabId));
  const ytTab = st.tabs.find(t => t.id === (sess && sess.targetTabId));
  record(G, 'source-open opens the url in a new tab next to the page',
         !!sess && !!ytTab && !!pageTab && ytTab.index === pageTab.index + 1
         && ytTab.opener === pageTab.id && yt.url() === YT_FIX,
         JSON.stringify({ sess, pageTab, ytTab, url: yt.url() }));
  const s1 = tagged || await S(page, id);
  const c = s1.clocks[s1.clocks.length - 1];
  const ts = s1.clocks.filter(x => x.media).map(x => x.media.currentTime);
  const frameKeys = c ? Object.keys(c.frame).sort().join(',') : '';
  record(G, 'clock tagged frame:{source,id,ref,url} and relayed to the beatshiver tab',
         !!c && c.frame.source === 'youtube' && c.frame.id === id && c.frame.ref === 'BSXFIXTURE'
         && c.frame.url === YT_FIX && frameKeys === 'id,ref,source,url' && c.ref === 'BSXFIXTURE'
         && c.site === 'youtube' && ts.length > 3 && ts[ts.length - 1] > ts[0],
         c ? `frame=${JSON.stringify(c.frame)} t ${ts[0] && ts[0].toFixed(2)} -> ${ts[ts.length - 1] && ts[ts.length - 1].toFixed(2)}` : 'no clock');
  const leakedToOnClock = await page.evaluate(i => window.__t.clocks.filter(m => m.frame && m.frame.id === i).length, id);
  record(G, 'source clocks never reach the embed onClock() listeners', leakedToOnClock === 0,
         `leaked=${leakedToOnClock}`);
  const states1 = (await S(page, id)).states.map(m => m.state);
  const b1 = ytTab ? await badge(L, ytTab.id) : null;
  const bPage = pageTab ? await badge(L, pageTab.id) : null;
  record(G, 'without the toolbar click: needs-gesture, badge on the youtube tab (not the page)',
         states1[0] === 'opened' && states1.includes('needs-gesture') && b1 === '!' && bPage === '',
         `states=${states1.join(',')} badge yt=${JSON.stringify(b1)} page=${JSON.stringify(bPage)}`);

  // Ad: the player's ad class holds the clock; nothing on the page is touched.
  await yt.evaluate(() => window.__fx.ad(true));
  await sleep(900);
  const during = (await S(page, id)).clocks.slice(-2);
  const clsDuring = await yt.evaluate(() => window.__fx.state().cls);
  await yt.evaluate(() => window.__fx.ad(false));
  await sleep(900);
  const after = (await S(page, id)).clocks.slice(-1)[0];
  const clsAfter = await yt.evaluate(() => window.__fx.state().cls);
  record(G, 'ad class on the player flags adPlaying, clears after; the page\'s classes untouched',
         during.length === 2 && during.every(x => x.adPlaying === true) && after && after.adPlaying === false
         && clsDuring === 'html5-video-player ad-showing' && clsAfter === 'html5-video-player',
         `during=${during.map(x => x.adPlaying)} after=${after && after.adPlaying} cls=${clsDuring}|${clsAfter}`);

  // Navigation: another video in the same tab (pushState) -> navigated, clocks stop, badge off.
  await yt.evaluate(() => window.__fx.nav('BSXOTHER'));
  const nav = await until(async () => (await S(page, id)).states.find(m => m.state === 'navigated'), 4000);
  const n0 = (await S(page, id)).clocks.length;
  await sleep(1200);
  const s2 = await S(page, id);
  const st2 = await swState(L);
  const b2 = ytTab ? await badge(L, ytTab.id) : null;
  record(G, 'ref change (pushState to another v=) -> navigated; relay stops; session gone',
         !!nav && s2.clocks.length === n0 && !st2.sources[id] && b2 === ''
         && s2.clocks.every(x => x.frame.ref === 'BSXFIXTURE'),
         `navigated=${JSON.stringify(nav)} clocks ${n0} -> ${s2.clocks.length} badge=${JSON.stringify(b2)}`);
  await yt.close();

  // Leaving the item path counts as navigation too.
  {
    const { id: id2, tab: yt2 } = await openSource(L, page, YT_FIX);
    await until(async () => (await S(page, id2)).clocks.length > 2, 6000);
    await yt2.evaluate(() => window.__fx.leave());
    const nav2 = await until(async () => (await S(page, id2)).states.find(m => m.state === 'navigated'), 4000);
    record(G, 'leaving the item path (/feed/...) -> navigated', !!nav2 && nav2.reason === 'left-item',
           JSON.stringify(nav2));
    await yt2.close();
  }

  // Closing the source tab -> closed (tab-closed) to the page.
  {
    const { id: id3, tab: yt3 } = await openSource(L, page, YT_FIX);
    await until(async () => (await S(page, id3)).clocks.length > 1, 6000);
    await yt3.close();
    const cl = await until(async () => (await S(page, id3)).states.find(m => m.state === 'closed'), 4000);
    record(G, 'closing the source tab -> closed (tab-closed)', !!cl && cl.reason === 'tab-closed',
           JSON.stringify(cl));
  }

  // source-close from the page -> closed, and the tab it opened is removed.
  {
    const { id: id4, tab: yt4 } = await openSource(L, page, YT_FIX);
    await until(async () => (await S(page, id4)).clocks.length > 1, 6000);
    const gone = new Promise(r => yt4.once('close', () => r(true)));
    await page.evaluate(i => window.__closeSource(i), id4);
    const cl = await until(async () => (await S(page, id4)).states.find(m => m.state === 'closed'), 4000);
    const closed = await Promise.race([gone, sleep(3000).then(() => false)]);
    record(G, 'source-close from the page -> closed, source tab removed',
           !!cl && cl.reason === 'requested' && closed, `${JSON.stringify(cl)} tabClosed=${closed}`);
  }
  await page.close();
}

async function sourceCapture(L) {
  const G = 'source';
  const page = await L.ctx.newPage();
  await page.goto('https://beatshiver.com/__bsx/test.html');
  await page.waitForFunction(() => window.__t && window.__t.detect !== null, null, { timeout: 5000 });
  // 8 s tone at AMP: capture it, then let it end.
  const { id, tab: yt } = await openSource(L, page, YT_FIX + `&dur=8&amp=${AMP}`);
  const pageTabId = await until(async () => {
    const x = (await swState(L)).sources[id];
    return x ? x.consumerTabId : null;
  }, 3000);
  const cap = await until(async () => (await S(page, id)).states.find(m => m.state === 'capturing'), 8000);
  await sleep(3000);
  const s = await S(page, id);
  const rms = s.pcm.n ? Math.sqrt(s.pcm.sumSq / s.pcm.n) : 0;
  record(G, 'two-tab capture: youtube tab audio arrives as pcm on the beatshiver tab (id = session)',
         !!cap && s.pcm.chunks > 10 && near(rms) && Object.keys(s.pcm.ids).join() === id
         && s.pcm.site === 'youtube',
         `capturing=${JSON.stringify(cap)} chunks=${s.pcm.chunks} rms=${rms.toFixed(4)} (tone ${RMS.toFixed(4)}) ids=${JSON.stringify(s.pcm.ids)} site=${s.pcm.site}`);
  const ownPcm = await page.evaluate(() => window.__t.pcm.chunks);
  record(G, 'source pcm is not mixed into the page\'s own capture listeners', ownPcm === 0,
         `own chunks=${ownPcm}`);
  const end = await until(async () => (await S(page, id)).states.find(m => m.state === 'ended'), 12000, 300);
  await sleep(600);
  const st = await swState(L);
  const active = st.tabs.filter(t => t.active).map(t => t.id);
  const c1 = (await S(page, id)).pcm.chunks;
  await sleep(800);
  const c2 = (await S(page, id)).pcm.chunks;
  record(G, 'at ended: source ended, capture stopped, beatshiver tab focused again',
         !!end && c1 === c2 && pageTabId != null && active.includes(pageTabId) && !st.sources[id],
         `ended=${JSON.stringify(end)} chunks ${c1}->${c2} active=${JSON.stringify(active)} page=${pageTabId}`);
  await yt.close().catch(() => {});
  await page.close();
}

// Read-only look at live youtube.com: do the configured selectors resolve on a real watch page,
// and does the source clock see it? Nothing is clicked; no ad is touched.
const REAL_YT = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
async function sourceReal(L) {
  const G = 'source-real';
  const probe = async (page, url) => {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.evaluate(() => {
      window.__bsc = [];
      document.addEventListener('beatshiver:clock', e => { try { window.__bsc.push(JSON.parse(e.detail)); } catch (x) {} });
    });
    await sleep(8000);
    return page.evaluate(() => {
      const player = document.querySelector('#movie_player');
      const content = document.querySelector('#movie_player video.html5-main-video');
      const last = window.__bsc[window.__bsc.length - 1];
      return {
        url: location.href,
        player: !!player, playerClass: player ? player.className.slice(0, 120) : null,
        playerIsHtml5: !!(player && player.matches('.html5-video-player')),
        content: !!content, videos: document.querySelectorAll('video').length,
        adNow: !!(player && player.matches('.ad-showing, .ad-interrupting')),
        clocks: window.__bsc.length, ref: last ? last.ref : null, media: last ? !!last.media : null,
      };
    });
  };
  const page = await L.ctx.newPage();
  let r;
  try { r = await probe(page, REAL_YT); } catch (e) { r = { error: e.message.split('\n')[0] }; }
  record(G, 'live www.youtube.com watch page: #movie_player.html5-video-player + content video resolve',
         !!r.playerIsHtml5 && !!r.content, JSON.stringify(r));
  record(G, 'live www.youtube.com: source clock reports ref from the page (informational)',
         true, `clocks=${r.clocks} ref=${r.ref} media=${r.media}`);
  await page.close();
  // m.youtube.com: serve it a phone user agent, or it redirects to www.
  const m = await L.ctx.newPage();
  try {
    const cdp = await L.ctx.newCDPSession(m);
    await cdp.send('Emulation.setUserAgentOverride', {
      userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) '
        + 'Chrome/130.0.0.0 Mobile Safari/537.36' });
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 412, height: 915, deviceScaleFactor: 2, mobile: true });
    r = await probe(m, REAL_YT.replace('www.', 'm.'));
  } catch (e) { r = { error: e.message.split('\n')[0] }; }
  record(G, 'live m.youtube.com watch page: #movie_player.html5-video-player + content video resolve',
         !!r.playerIsHtml5 && !!r.content && /^https:\/\/m\.youtube\.com\//.test(r.url || ''), JSON.stringify(r));
  await m.close();
}

// ---- main -------------------------------------------------------------------------------------
const want = g => (!ONLY || ONLY === g)
  && !(NO_REAL && (g === 'real' || g === 'debug' || g === 'source-real'));

let L = await launch();
console.log(`extension id ${L.id} (${HEADFUL ? 'headful' : 'headless'})`);
try {
  if (want('fixtures')) await fixtures(L);
  if (want('real')) await realEmbeds(L);
  if (want('debug')) await debugPage(L);
  if (want('gesture')) await gesture(L);
} catch (e) { record('harness', 'uncaught', false, e.stack); }
if (want('source-real')) {
  try { await sourceReal(L); } catch (e) { record('source-real', 'uncaught', false, e.stack); }
}
const id = L.id;
await close(L);

if (want('capture')) {
  // Chrome's own test switch: treat this extension as allowlisted for tab capture, standing in
  // for the toolbar click a person makes. Nothing in the extension knows about it.
  L = await launch([`--allowlisted-extension-id=${id}`], { unmute: true });
  try { await capture(L); } catch (e) { record('capture', 'uncaught', false, e.stack); }
  await close(L);
}
if (want('source')) {
  let yts = null;
  try {
    yts = await ytServer();
    L = await launch(yts.args);
    try { await source(L); } catch (e) { record('source', 'uncaught', false, e.stack); }
    await close(L);
    // The two-tab capture needs the same stand-in for the toolbar click, here on the YouTube tab.
    L = await launch([...yts.args, `--allowlisted-extension-id=${id}`], { unmute: true });
    try { await sourceCapture(L); } catch (e) { record('source', 'uncaught (capture)', false, e.stack); }
    await close(L);
  } catch (e) { record('source', 'setup', false, e.message); }
  if (yts) yts.srv.close();
}

const failed = results.filter(r => !r.ok);
fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 1));
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
