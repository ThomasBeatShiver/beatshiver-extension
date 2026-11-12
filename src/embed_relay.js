// ISOLATED world, document_start, every embed frame. Carries embed_main.js's clock reports out
// of the frame to the background, which forwards them to the beatshiver.com top frame of the
// same tab. Never talks to the embed page itself.
(function () {
  'use strict';
  if (window === window.top) return;

  // Where the browser tells us (Chrome, Safari), skip frames whose top is not a page we report
  // to: no point waking the background for an xvideos embed on some other site. Firefox has no
  // ancestorOrigins; there the background drops messages from tabs nobody registered.
  const extOrigin = new URL(ext.runtime.getURL('/')).origin;
  const ao = location.ancestorOrigins;
  if (ao && ao.length) {
    const top = ao[ao.length - 1];
    const sites = ['https://beatshiver.com', extOrigin];
    if (!sites.includes(top)) return;
  }

  let dead = false;
  document.addEventListener('beatshiver:clock', ev => {
    if (dead || typeof ev.detail !== 'string') return;
    let data;
    try { data = JSON.parse(ev.detail); } catch (e) { return; }
    try {
      const p = ext.runtime.sendMessage({ type: 'clock', data });
      if (p && p.catch) p.catch(onErr);
    } catch (e) { onErr(e); }
  });

  function onErr(e) {
    // The extension was reloaded or removed under a live page: this script is orphaned and every
    // send will throw from now on.
    if (/context invalidated|Extension context/i.test(String(e && e.message))) dead = true;
  }
})();
