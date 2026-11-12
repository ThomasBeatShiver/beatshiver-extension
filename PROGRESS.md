# Progress

2026-11-12 10:03 DONE repo initialised; read backlog/browser-extension.md, native-wrapper-app.md, capture_session.js, player.html listen mode
2026-11-12 10:03 DONE tooling: node 22.14, playwright 1.65 + chromium-1254, web-ext 8.10 installed as devDependencies
2026-11-12 10:03 DONE probed real embeds headless: xvideos embedframe (blob/MSE <video>, light DOM), pornhub embed (video.mgp_videoElement, no preroll served to this headless run), framatube (video.js vjs-tech)
2026-11-12 10:07 DONE first cut of src/ (clock hooks, relays, background, offscreen PCM capture, debug page) + build.mjs generating dist/chrome and dist/firefox; untested
2026-11-12 10:11 DONE fixture tests 9/9 headless: clock from cross-origin fixture frames at real embed URLs (closed shadow root, VAST-style pre-roll flagged, detached Audio()), events in order, relay latency p95 2-3 ms, no leak to non-beatshiver pages
2026-11-12 10:12 DONE real embeds headless: clocks arrive from real xvideos, pornhub, framatube cross-origin frames (t advancing ~8-10 s over 10 s); no Pornhub pre-roll was served, so real VAST handling is unverified
