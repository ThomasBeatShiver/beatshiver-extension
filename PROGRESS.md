# Progress

2026-11-12 10:03 DONE repo initialised; read backlog/browser-extension.md, native-wrapper-app.md, capture_session.js, player.html listen mode
2026-11-12 10:03 DONE tooling: node 22.14, playwright 1.65 + chromium-1254, web-ext 8.10 installed as devDependencies
2026-11-12 10:03 DONE probed real embeds headless: xvideos embedframe (blob/MSE <video>, light DOM), pornhub embed (video.mgp_videoElement, no preroll served to this headless run), framatube (video.js vjs-tech)
2026-11-12 10:07 DONE first cut of src/ (clock hooks, relays, background, offscreen PCM capture, debug page) + build.mjs generating dist/chrome and dist/firefox; untested
2026-11-12 10:11 DONE fixture tests 9/9 headless: clock from cross-origin fixture frames at real embed URLs (closed shadow root, VAST-style pre-roll flagged, detached Audio()), events in order, relay latency p95 2-3 ms, no leak to non-beatshiver pages
2026-11-12 10:12 DONE real embeds headless: clocks arrive from real xvideos, pornhub, framatube cross-origin frames (t advancing ~8-10 s over 10 s); no Pornhub pre-roll was served, so real VAST handling is unverified
2026-11-12 10:13 DONE debug page headless: live clocks from xvideos, pornhub, framatube frames inside the extension page (fixed: raw embed broadcasts were reaching the page unaddressed)
2026-11-12 10:19 DONE capture works headless with Chrome's --allowlisted-extension-id test switch standing in for the toolbar click: pcm mode RMS 0.0141 vs 0.0141 tone, stream mode same; without the switch the request parks as pending-gesture
2026-11-12 10:19 FAIL a muted tab captures silence: Playwright's default --mute-audio gave RMS 0.0000 in both modes (fixed in test by unmuting the capture group, quiet tone)
2026-11-12 10:19 DONE stream mode + replay in the same tab feeds back (one run 0.141 tone grew to 0.57 RMS; varies run to run) -> pcm is the default/audible mode, client never monitors a stream
2026-11-12 10:19 DONE coordinator request: xvideos unmarked pre-roll (video-overlay) handled by short-beside-long + unknown-length rules; fixture test passes (never chosen, adPlaying from its play() before metadata, content plays from 0)
2026-11-12 10:19 DONE full suite 22/22 headless (test/run.mjs now rebuilds dist/chrome itself)
2026-11-12 10:20 DONE web-ext lint dist/firefox: 0 errors, 4 warnings (tabCapture/offscreen unsupported, all behind the HAS_CAPTURE guard); Firefox itself not installed here, so the Firefox build was never loaded
2026-11-12 10:21 DONE README.md (layout, build/load per browser, Safari converter steps, tests) and INTEGRATION.md (message formats, detection, clock, capture states, gesture flow)
