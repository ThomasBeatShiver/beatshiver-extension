# Integrating beatshiver.com with the extension

This covers what the site (`audio_fap/beatshiver/static/player.html`) will need to do. None of
it exists in the site yet. `client/beatshiver-extension-client.js` is a working reference
implementation of the page side; the test page in `test/fixtures/page.html` uses it, and
`npm test` exercises it.

Only `https://beatshiver.com/*` and `https://qa.beatshiver.com/*` top frames get the page relay (`src/sites.js`, `PAGE_MATCHES`).
Local `serve.py` (`localhost:8421`), `www.` and any QA host are **not** matched. See the open
questions in README.md.

## Channel

Everything goes over `window.postMessage` on the page's own window, with the page's own origin
as `targetOrigin`. There are two fixed envelopes:

| direction | envelope |
| --- | --- |
| page → extension | `{ source: 'beatshiver-page', v: 1, type, ... }` |
| extension → page | `{ source: 'beatshiver-extension', v: 1, type, ... }` |

The relay ignores anything whose `ev.source !== window`, whose origin is not the page's own, or
whose `source` is not `beatshiver-page`. So frames (including the embeds) cannot drive it. The
page should filter the same way: `ev.source === window && ev.origin === location.origin &&
ev.data.source === 'beatshiver-extension'`.

## Detecting the extension

There are two signals. Use either one; the second also returns capabilities.

1. **The attribute, synchronous.** At `document_start`, before any page script runs, the relay
   sets `<html data-beatshiver-extension="0.1.0">`. Checking for it costs nothing.
2. **The handshake.** The page posts `{source:'beatshiver-page', v:1, type:'hello', id}`. The
   relay answers:

   ```js
   { source: 'beatshiver-extension', v: 1, type: 'ready', version: '0.1.0', replyTo: id,
     capabilities: {
       clock: true,
       capture: ['stream', 'pcm'],      // [] on Firefox and Safari
       browser: 'chrome' | 'firefox' | 'safari',
       captureFallback: null,           // 'getDisplayMedia' where capture is []
       sources: ['youtube']             // same as the top-level `sources` below
     },
     sources: ['youtube'] }             // sites the page may `source-open`; [] without capture
   ```

   The relay also posts one unsolicited `ready` (`replyTo: null`) at load. A page that registers
   its listener late will miss it, so send `hello`. If nothing answers within ~500 ms, there is
   no extension (`detectExtension()` in the client does exactly this).

## Clock

Every embed frame on a matched origin reports its content element's state. Each report reaches
the page as:

```js
{
  source: 'beatshiver-extension', v: 1, type: 'clock',
  frame: { frameId: 4, origin: 'https://www.xvideos.com', url: 'https://www.xvideos.com/embedframe/…' },
  seq: 37,                   // per frame, increasing
  site: 'xvideos',           // id from src/sites.js: xvideos | pornhub | peertube | soundcloud
  event: 'tick',             // play | playing | pause | seeking | seeked | ratechange |
                             // durationchange | loadedmetadata | ended | emptied | waiting | tick
  fromPrimary: false,        // did the event come from the content element itself
  primaryChanged: false,     // the extension switched which element it calls content
  adPlaying: false,          // a pre-roll (or other non-content element) is playing right now
  media: {                   // null until the frame has a content element
    mediaId: 1, kind: 'video',
    currentTime: 12.5, paused: false, ended: false, playbackRate: 1,
    duration: 615.04,        // seconds | 'live' | null (unknown yet)
    readyState: 4, muted: false, volume: 1
  },
  candidates: 2,             // media elements seen in the frame
  wallMs: 1762941234567,     // Date.now() in the frame when sampled
  perfMs: 12345.6            // the frame's performance.now()
}
```

- **Cadence.** Every media event is sent at once. While content or an ad is playing there is
  also a `tick` every 250 ms. While paused, a tick goes every 2 s, stopping after 5 of them
  (any event restarts them). Measured relay latency from frame to page is p50 2 ms and p95 2-3 ms
  (headless Chromium, fixtures).
- **Position now.** If `!media.paused && !media.ended && !adPlaying`, it is
  `media.currentTime + (Date.now() - wallMs) / 1000 * media.playbackRate`; otherwise it is
  `media.currentTime`. `positionNow()` in the client does this calculation.
- **Ads.** `media` is always the content element. It is never the pre-roll. While an ad plays,
  `adPlaying` is true and `media` shows the content held (on xvideos and in the Pornhub-style
  fixture, paused at 0). Hold the script while `adPlaying`. How the content element is
  chosen, in order:
  1. Shape, which needs no markup. A clip shorter than 90 s beside one that is 60 s or longer
     and at least 3x its length is an ad. A clip whose duration is still unknown never outranks
     one with a known long duration. This is the xvideos pre-roll, an unmarked
     `<video class="video-overlay">` of about 20 s, first reported from the Android build.
  2. An ad-network host in `src` (VAST/VPAID, doubleclick, trafficjunky, exoclick, …).
  3. Markup: ad-like class or id words on the element or its ancestors, across shadow roots.
     Per-site rules also apply: Pornhub content is `video.mgp_videoElement`, with a blob or
     phncdn source; YouTube's player gets `.ad-showing` (on youtube.com, see below).
  4. Then content-selector match, then loaded, then the longest.
- **Several embeds.** Use `frame.frameId` + `frame.origin` to tell frames apart. One page with
  one embed sees one stream.
- **Which pages hear it.** The background forwards clocks only to tabs whose top frame
  registered: beatshiver.com (through the page relay) or the extension's own debug page. An
  xvideos embed on any other site reports nowhere (tested).

The clock is read-only. The extension never calls `play()`, never seeks and never changes rate
on the embed. Its hooks only observe.

## Capture (Chrome only)

### Asking

```js
{ source: 'beatshiver-page', v: 1, type: 'capture-start', id: 'cap-abc',
  mode: 'pcm' | 'stream',     // default in the client: 'pcm'
  channels: 1 | 2,            // pcm: mono downmix or interleaved stereo
  chunkFrames: 2048,          // pcm: frames per chunk, 256..16384
  sampleRate: 0,              // pcm: 0 = the device rate (44100 measured here)
  monitor: true }             // pcm: keep the tab audible (see below)

{ source: 'beatshiver-page', v: 1, type: 'capture-stop', id: 'cap-abc' }
```

### Answers: `type: 'capture'`

| `state` | meaning | what the page does |
| --- | --- | --- |
| `started` | running. pcm: `sampleRate`, `channels`. stream: `streamId` | pcm: read `pcm` messages. stream: call `getUserMedia` now (below) |
| `pending-gesture` | Chrome refused because the user has not invoked the extension on this tab | tell the user to **click the Beatshiver toolbar icon**; the click starts this same request and a `started` with the same `id` follows |
| `granted` (`id: null`) | the user clicked the icon with nothing pending; capture is now allowed in this tab until it navigates | optional: enable a one-click "measure" control |
| `unsupported` | Firefox or Safari. `fallback: 'getDisplayMedia'` | use today's `getDisplayMedia` path unchanged |
| `error` | anything else, in `error` | treat as refused |
| `stopped` | `reason`: `requested`, `toolbar` (user clicked the icon again), `navigated`, `tab-closed`, `track-ended`, `replaced` | drop the lane |

### PCM chunks (mode `pcm`)

```js
{ source: 'beatshiver-extension', v: 1, type: 'pcm', id: 'cap-abc', seq: 12,
  sampleRate: 44100, channels: 1, frames: 2048, wallMs: 1762941234567,
  data: Float32Array }       // interleaved when channels = 2; transferred, not copied
```

`wallMs` is when the offscreen document posted the chunk. That is the chunk's last sample, give
or take one 2048-frame chunk (46 ms at 44.1 kHz). Measured delivery to the page took about 1 ms.

### Which mode

- **`pcm` (recommended).** The extension captures in its offscreen document and plays the
  audio back to the speakers there (`monitor: true`), so the user keeps hearing the tab. The page
  gets lossless Float32 at the device rate and resamples to 22,050 itself, as listen mode
  already does. The playback runs in the extension's renderer, not the tab, so it does not feed
  back. The captured level matched the source exactly (0.0141 vs 0.0141 RMS).
- **`stream`.** The extension gets a stream id for `consumerTabId` = the page's own tab, and
  the page turns it into a real `MediaStream`:

  ```js
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
    video: false });
  ```

  Do this immediately, because ids expire within seconds. The page keeps its existing
  `recordPcm(stream)` pipeline. **But the user stops hearing the tab, and the page cannot fix
  that.** Chrome does not play a captured tab locally, and replaying the stream from inside the
  captured tab gets captured again and feeds back. In one run a 0.141 RMS tone grew to 0.57 in
  2 s; the growth varies from run to run. Use `stream` only where silence is acceptable.

### The gesture, and what "one click" means

Chrome grants `tabCapture` only for a tab on which the user has invoked the extension (toolbar
icon, keyboard shortcut or context menu). A click on the page does not count. So the page's
button cannot start a capture on its own the first time. The real flow:

1. The page sends `capture-start` and gets `pending-gesture`. The icon shows a red `!` badge
   and the title "click to allow".
2. The user clicks the toolbar icon, and the capture starts (`started`, same `id`).
3. Until that tab navigates or reloads, further `capture-start`s from the page work without a
   click.

That is still one click instead of today's two (`window.open` + the `getDisplayMedia` picker),
and no picker appears at all. The click is on the toolbar, not on the page.

### Recommended page logic

```
caps = detectExtension()
if caps && caps.capture includes 'pcm':
    try startCapture({mode:'pcm'}) -> feed chunks into the listen-mode matcher
    on ExtensionNeedsGesture: show "click the Beatshiver icon"; await err.started
else:
    getDisplayMedia path, unchanged (Firefox, Safari, no extension)
```

## Measure on the source (Chrome)

Some sites are not clocked through their embed at all: they are measured on their own page, in
their own tab (`measureOn: 'source'` in `src/sites.js`). YouTube is the only one so far. Its
API policies forbid beatshiver.com to isolate the audio of its embed, so the YouTube embed gets
no clock, and a YouTube track nobody has measured is measured once, in real time, on
youtube.com. Every play with a script stays on beatshiver.com: the extension only provides the
clock and the audio. It never drives the toy, never sends anything to the source page, and
leaves its player, ads and UI alone.

Which sites, and how their URLs are read, is configuration only:

| field | meaning | YouTube |
| --- | --- | --- |
| `measureOn` | `'source'` = measured on the site's own page | `'source'` |
| `pages` | match patterns of the site's pages (whole hosts: single-page apps) | `https://www.youtube.com/*`, `https://m.youtube.com/*` |
| `itemPath` | regex for the pathname of an item page | `^/watch$` |
| `refFrom` | how to read the item key: `{query:'v'}` or `{path:'<regex>'}` | `{query:'v'}` |
| `pageUrl` | template the page builds `source-open.url` from | `https://www.youtube.com/watch?v={id}` |
| `content`, `adPlayer`, … | the clock and ad rules, as for embeds | `#movie_player video.html5-main-video`, `.html5-video-player.ad-showing` / `.ad-interrupting` |

`ready.sources` lists the ids the page may ask for. It is `[]` on Firefox and Safari: without
tab capture there is nothing to measure with.

### Messages

```js
// page -> extension
{ source: 'beatshiver-page', v: 1, type: 'source-open', id: 'src-abc', site: 'youtube',
  url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  channels: 1, chunkFrames: 2048, sampleRate: 0 }   // optional, as for capture-start
{ source: 'beatshiver-page', v: 1, type: 'source-close', id: 'src-abc' }

// extension -> page: the session's state
{ source: 'beatshiver-extension', v: 1, type: 'source', id: 'src-abc', state, reason? }

// extension -> page: the source tab's clock (the embed clock shape, plus `ref`)
{ source: 'beatshiver-extension', v: 1, type: 'clock',
  frame: { source: 'youtube', id: 'src-abc', ref: 'dQw4w9WgXcQ',
           url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' },
  site: 'youtube', ref: 'dQw4w9WgXcQ', seq, event, fromPrimary, primaryChanged, adPlaying,
  media, candidates, wallMs, perfMs }

// extension -> page: the source tab's audio (the pcm shape; `id` is the session's)
{ source: 'beatshiver-extension', v: 1, type: 'pcm', id: 'src-abc', site: 'youtube',
  seq, sampleRate, channels, frames, wallMs, data: Float32Array }
```

A source clock's `frame` has **no** `origin` or `frameId`, so a page that routes embed clocks by
origin never takes it for an embed's clock. Route on `frame.source` + `frame.id`.
`onClock()` in the client skips source clocks; `openSource()` gets them.

| `state` | meaning | what the page does |
| --- | --- | --- |
| `opened` | the source tab is open (`reused: true` when the same `id` asked again: its tab is shown) | show "Measuring on YouTube — keep that tab playing" |
| `needs-gesture` | Chrome refused the capture: the user has not clicked the Beatshiver icon **on the source tab**. That tab's icon has the red `!` | tell the user to click the icon on the YouTube tab; `capturing` follows |
| `capturing` | its audio is coming as `pcm` (`sampleRate`, `channels`) | feed the capture lane |
| `ended` | the content `ended` (not an ad); capture stopped 0.5 s later, the beatshiver tab is focused again | finish the take |
| `navigated` | `reason: 'ref-changed'` (another item in the same tab) or `'left-item'` (off `itemPath`); capture stopped | abort the take |
| `closed` | `reason: 'tab-closed'` (the source tab), `'requested'` (the page's `source-close`; the extension closes the tab it opened), `'toolbar'` (the user clicked the icon again while capturing) | abort / done |
| `error` | `reason`: refused `source-open` (not a beatshiver page, unknown or non-source site, url not one of the site's item pages, no tab capture), or the capture failed | treat as refused |

`ended`, `navigated`, `closed` and `error` end the session; send a new `source-open` (a new
`id`) to measure again.

### Rules, the same for every site

- **Validation.** `source-open` is refused unless `url` matches one of the site's `pages`, its
  pathname matches `itemPath` and `refFrom` finds a ref in it.
- **Where.** The new tab opens next to the beatshiver tab (`index + 1`, `openerTabId`), active.
- **Clock.** Only the source tab's top frame. It reports while the URL is on `itemPath`; leaving
  it sends one report with `ref: null`, which the background turns into `navigated`. SPA moves
  are seen through `history.pushState` / `replaceState` / `popstate` hooks, not any site's own
  events.
- **Ads.** As for embeds: `adPlaying` while the player is flagged (YouTube: `ad-showing` /
  `ad-interrupting` on `.html5-video-player`, which plays the ad in the same `<video>`). The
  extension only reads the flag.
- **Rate.** `media.playbackRate` is reported as is; the page refuses a take at rate ≠ 1.
- **Capture.** Starts on the source tab's first clock (pcm mode, monitored so the user keeps
  hearing YouTube). It is keyed on the source tab; its chunks go to the beatshiver tab only.
- **The gesture.** Chrome grants tab capture for a tab only after a click on the extension
  **in that tab**. A click on the beatshiver tab does not cover the YouTube tab. Tested only with
  Chrome's `--allowlisted-extension-id` test switch, not with a person's click.
- **A YouTube tab the user opened themselves** reports nowhere: the background tells its relay
  to go quiet.
- **Closing.** Either tab closing ends the session. A reload of the beatshiver tab ends it too
  (the source tab is left open).

## Firefox and Safari

Neither browser has `tabCapture` or offscreen documents, so `capabilities.capture` is `[]` and
`capture-start` answers `unsupported` / `fallback: 'getDisplayMedia'`. The clock is the same on
all three: MAIN-world content scripts need Firefox 128+ and Safari 16.4+ (unverified). Desktop
Firefox and Safari both have `getDisplayMedia`, so the page's existing capture path still works
there. The extension adds the clock only.

## Things the page must not assume

- **A muted tab captures silence.** With Chromium's `--mute-audio`, both modes measured RMS
  0.0000. A user who muted the beatshiver tab ("Mute site") will probably get the same result;
  this was not tested with the tab-mute UI itself. Refuse a silent take, as listen mode already
  does.
- **Calibration.** The lead-in, drift and silence constants in the capture lane were measured
  against `getDisplayMedia`. This is a different path, so re-measure before reusing them
  (backlog/browser-extension.md, open question 2).
