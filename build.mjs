#!/usr/bin/env node
// Builds dist/chrome and dist/firefox from src/ and one shared manifest. No bundler: every source
// file is shipped as written; only the manifest differs per browser.
//
//   node build.mjs            -> dist/chrome, dist/firefox
//   node build.mjs chrome     -> just one
//
// Safari is not built here (it needs a Mac and Xcode); see README.md. Its converter takes the
// Firefox-shaped build as input.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'dist');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

// sites.js is a classic script; run it in a sandbox to read the one site list.
const sandbox = {};
sandbox.globalThis = sandbox;
vm.runInNewContext(fs.readFileSync(path.join(SRC, 'sites.js'), 'utf8'), sandbox);
const SITES = sandbox.BEATSHIVER_SITES;
const EMBEDS = SITES.embedMatches();

const COMMON_FILES = ['shim.js', 'sites.js', 'embed_main.js', 'embed_relay.js', 'page_relay.js',
                      'background.js', 'debug.html', 'debug.js', 'debug.css'];
const CHROME_ONLY = ['offscreen.html', 'offscreen.js', 'pcm_worklet.js'];

function baseManifest() {
  return {
    manifest_version: 3,
    name: 'Beatshiver',
    short_name: 'Beatshiver',
    version: pkg.version,
    description: 'Reads the playback clock of video embeds on beatshiver.com, and lets the page '
      + 'measure a track in one click.',
    icons: { 16: 'icons/16.png', 32: 'icons/32.png', 48: 'icons/48.png', 128: 'icons/128.png' },
    action: { default_title: 'Beatshiver', default_icon: { 16: 'icons/16.png', 32: 'icons/32.png' } },
    permissions: ['storage'],
    content_scripts: [
      // MAIN world first, so the prototype hooks exist before the player script runs.
      { matches: EMBEDS, js: ['sites.js', 'embed_main.js'], run_at: 'document_start',
        all_frames: true, world: 'MAIN' },
      { matches: EMBEDS, js: ['shim.js', 'embed_relay.js'], run_at: 'document_start',
        all_frames: true },
      { matches: SITES.PAGE_MATCHES, js: ['shim.js', 'page_relay.js'], run_at: 'document_start',
        all_frames: false },
    ],
  };
}

const TARGETS = {
  chrome(m) {
    m.minimum_chrome_version = '116';   // getContexts + offscreen USER_MEDIA + tabCapture ids
    m.permissions.push('tabCapture', 'offscreen');
    m.background = { service_worker: 'background.js' };
    return { manifest: m, files: [...COMMON_FILES, ...CHROME_ONLY] };
  },
  firefox(m) {
    // No offscreen API and no tabCapture: capture answers `unsupported` and the page keeps
    // getDisplayMedia. MAIN-world content scripts need Firefox 128.
    m.background = { scripts: ['shim.js', 'sites.js', 'background.js'] };
    m.browser_specific_settings = {
      gecko: {
        id: 'extension@beatshiver.com',
        strict_min_version: '128.0',
        // Nothing leaves the browser through the extension itself: it relays embed state to the
        // beatshiver.com tab the user has open, and audio to that same tab.
        data_collection_permissions: { required: ['none'] },
      },
    };
    return { manifest: m, files: COMMON_FILES };
  },
};

// ---- icons: a plain filled circle, written as PNG with no dependencies -----------------------
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function iconPng(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const r = size / 2, cx = r - 0.5, cy = r - 0.5;
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - cx, y - cy);
      const a = Math.max(0, Math.min(1, r - d));          // anti-aliased disc
      const wave = Math.abs((y - cy) - Math.sin((x / size) * Math.PI * 4) * size * 0.12) < size * 0.07;
      const o = y * (size * 4 + 1) + 1 + x * 4;
      const [R, G, B] = wave ? [255, 255, 255] : [194, 24, 91];
      raw[o] = R; raw[o + 1] = G; raw[o + 2] = B; raw[o + 3] = Math.round(a * 255);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
                        chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function build(name) {
  const out = path.join(DIST, name);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(path.join(out, 'icons'), { recursive: true });
  const { manifest, files } = TARGETS[name](baseManifest());
  for (const f of files) fs.copyFileSync(path.join(SRC, f), path.join(out, f));
  for (const s of [16, 32, 48, 128]) fs.writeFileSync(path.join(out, 'icons', s + '.png'), iconPng(s));
  fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`built dist/${name} (${files.length} files, ${EMBEDS.length} embed patterns)`);
}

const want = process.argv.slice(2);
for (const name of want.length ? want : Object.keys(TARGETS)) {
  if (!TARGETS[name]) { console.error('unknown target ' + name); process.exit(1); }
  build(name);
}
