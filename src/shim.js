// One namespace for every browser. Firefox and Safari expose a promise-based `browser.*`;
// Chrome's MV3 `chrome.*` returns promises when no callback is passed. Prefer `browser` where it
// exists so Firefox and Safari get their native promise API, and fall back to `chrome`.
// A var on purpose: a classic script shared by service worker, background page and content
// scripts, where `globalThis.ext` is what every other file reads.
// eslint-disable-next-line no-var
var ext = (typeof globalThis.browser !== 'undefined' && globalThis.browser.runtime)
  ? globalThis.browser
  : globalThis.chrome;
