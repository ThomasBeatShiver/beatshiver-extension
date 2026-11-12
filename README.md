# Beatshiver extension

The desktop half of the "clock + capture" idea (`audio_fap/backlog/native-wrapper-app.md`,
"Related options"). This is a narrower first cut of `audio_fap/backlog/browser-extension.md`. It
does two things:

1. **Clock.** It reads `currentTime`, `paused`, `playbackRate` and `duration`, plus
   play/pause/seek/rate events, from inside the xvideos, Pornhub, PeerTube, YouTube and
   SoundCloud embed frames on beatshiver.com, and hands them to the page. It skips pre-roll ads.
2. **One-click measuring (Chrome).** `chrome.tabCapture` via an offscreen document. The page
   starts and stops it, receives Float32 PCM (or a MediaStream), and the user keeps hearing the
   tab.

The site does not use any of this yet. INTEGRATION.md is the contract for that follow-on work.

## Layout

```
src/sites.js        the one list of sites: embed match patterns, PeerTube instances, ad rules
src/embed_main.js   MAIN world, every embed frame: hooks HTMLMediaElement, picks content vs ad
src/embed_relay.js  ISOLATED world, every embed frame: forwards clock reports to the background
src/page_relay.js   ISOLATED world, beatshiver.com top frame: the window.postMessage protocol
src/background.js   service worker (Chrome) / event page (Firefox, Safari): relay + capture
src/offscreen.*     Chrome only: tabCapture -> AudioContext -> speakers + PCM chunks
src/pcm_worklet.js  Chrome only: AudioWorklet that chunks PCM
src/debug.*         extension page: framed embeds, live clock table, capture level meter
src/shim.js         `ext` = `browser` (Firefox/Safari, promise API) or `chrome` (MV3 promises)
client/             reference page-side client (for the site; not shipped in the extension)
build.mjs           writes dist/chrome and dist/firefox from src/ + one shared manifest
test/run.mjs        Playwright: loads dist/chrome unpacked and checks clock, relay, debug, capture
```

There is one codebase and no bundler. The two manifests differ only where the browsers differ.
Chrome gets `background.service_worker` plus `tabCapture` and `offscreen`. Firefox gets
`background.scripts`, `browser_specific_settings.gecko` (id, `strict_min_version` 128 for
MAIN-world content scripts) and no capture permissions.

**Permissions.** These are `storage` (session-scoped tab registry), `tabCapture` and `offscreen`
(Chrome only), plus content-script matches on the embed paths only (for example
`https://www.pornhub.com/embed/*`, not the whole site) and `https://beatshiver.com/*`. There are
no `host_permissions`, no `tabs`, no `activeTab`, no `<all_urls>`. Chrome's install prompt still
names the hosts, because it words host access per host.

## Build and load

```
npm install              # playwright + web-ext, dev only
node build.mjs           # dist/chrome and dist/firefox
```

- **Chrome / Edge / Brave.** Go to `chrome://extensions`, turn on Developer mode, choose *Load
  unpacked*, then pick `dist/chrome`. Click the toolbar icon on any non-beatshiver tab to open
  the debug page. Branded Chrome 137+ ignores `--load-extension` on the command line, but
  *Load unpacked* still works.
- **Firefox (128+).** Go to `about:debugging#/runtime/this-firefox`, choose *Load Temporary
  Add-on*, then pick `dist/firefox/manifest.json`. Or run `npx web-ext run --source-dir
  dist/firefox`. Firefox MV3 may list the embed hosts as optional permissions in
  *about:addons → Permissions*; if the clock is silent, grant them there. This is unverified:
  no Firefox was installed on the build machine.
- **Debug page.** `chrome-extension://<id>/debug.html` or `moz-extension://<id>/debug.html`.
  `?embeds=<url>,<url>` replaces the sample embeds.

## Safari (not built)

Safari Web Extensions need a Mac with Xcode. The code is written to run there: it uses
`browser.*` through the shim, classic scripts, MAIN-world content scripts (Safari 16.4+) and no
offscreen API. The steps are:

```
node build.mjs firefox
xcrun safari-web-extension-converter dist/firefox --app-name "Beatshiver" \
      --bundle-identifier com.beatshiver.extension --swift --copy-resources
# open the generated Xcode project, set a signing team, run the macOS (and/or iOS) target,
# then Safari > Settings > Extensions > enable, and allow it on beatshiver.com + the embed hosts
```

Safari has no tabCapture, so capture answers `unsupported` and the site keeps `getDisplayMedia`
(macOS). iOS has no `getDisplayMedia` at all; there, only the clock is useful. App Store
distribution needs the $99/year developer program (backlog/browser-extension.md, open
question 3).

## Tests

```
node test/run.mjs                 # everything, new headless Chromium (Playwright's build)
node test/run.mjs --only=capture  # fixtures | real | debug | gesture | capture
node test/run.mjs --no-real       # skip groups that reach the public internet
node test/run.mjs --headful       # with a window (muted except the capture group)
npm run lint:firefox              # web-ext lint on dist/firefox
```

beatshiver.com is never contacted. The test serves its own page at
`https://beatshiver.com/__bsx/…` through Playwright routing, so the real page relay matches it.
Fixture players are served at real embed URLs (`…/embedframe/BSXFIXTURE`) so the real embed
scripts run on them.

**Capture and the gesture.** Chrome only allows tab capture after a toolbar click. A test
cannot click the toolbar, so the `capture` group relaunches with Chrome's own test switch
`--allowlisted-extension-id=<id>`, which stands in for that click. The `gesture` group runs
without it and checks that the request parks as `pending-gesture`. The click path itself
(`action.onClicked` → start the parked request) has **not** been exercised by a person.

The capture group also removes Playwright's default `--mute-audio`, because a muted browser
captures silence. Its test tone (440 Hz, amplitude 0.02) therefore really plays, quietly, on
the machine's speakers.
