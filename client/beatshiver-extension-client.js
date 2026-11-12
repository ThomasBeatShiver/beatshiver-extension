// Reference page-side client for the Beatshiver extension. NOT part of the extension: this is
// what beatshiver.com would import (copy it into audio_fap/client/ when the site work starts).
// It speaks the window.postMessage protocol in INTEGRATION.md and nothing else.
//
//   import { detectExtension, onClock, startCapture } from './beatshiver-extension-client.js';
//   const ext = await detectExtension();           // null when not installed
//   const off = onClock(msg => ...);               // every clock report from every embed frame
//   const cap = await startCapture({ mode: 'stream' });  // { stream, stop } -- or throws
//
// Capture throws an Error whose `name` says what to do next:
//   ExtensionCaptureUnsupported -- Firefox/Safari: use getDisplayMedia (today's path)
//   ExtensionNeedsGesture       -- Chrome: ask the user to click the Beatshiver toolbar icon;
//                                  `err.started` is a promise that resolves when they do
//   ExtensionCaptureError       -- anything else

const SRC_PAGE = 'beatshiver-page';
const SRC_EXT = 'beatshiver-extension';

function post(msg) {
  window.postMessage(Object.assign({ source: SRC_PAGE, v: 1 }, msg), location.origin);
}

function listen(fn) {
  const h = ev => {
    if (ev.source !== window || ev.origin !== location.origin) return;
    const m = ev.data;
    if (m && m.source === SRC_EXT) fn(m);
  };
  window.addEventListener('message', h);
  return () => window.removeEventListener('message', h);
}

/** Resolves with `{version, capabilities}` or null if no extension answers in `timeoutMs`. */
export function detectExtension({ timeoutMs = 500 } = {}) {
  const attr = document.documentElement.getAttribute('data-beatshiver-extension');
  return new Promise(resolve => {
    const id = 'hello-' + Math.random().toString(36).slice(2);
    const t = setTimeout(() => { off(); resolve(null); }, attr ? timeoutMs * 4 : timeoutMs);
    const off = listen(m => {
      if (m.type === 'ready' && (m.replyTo === id || m.replyTo == null)) {
        clearTimeout(t); off();
        resolve({ version: m.version, capabilities: m.capabilities });
      }
    });
    post({ type: 'hello', id });
  });
}

/**
 * Every clock report. `msg.frame.origin` says which embed; `msg.media` is null until the frame
 * has a content element. Position now = media.currentTime + (Date.now() - wallMs) / 1000 *
 * playbackRate while !paused && !adPlaying.
 */
export function onClock(fn) {
  return listen(m => { if (m.type === 'clock') fn(m); });
}

/** Seconds into the content right now, extrapolated from one clock message. */
export function positionNow(m, now = Date.now()) {
  const md = m && m.media;
  if (!md) return null;
  if (md.paused || md.ended || m.adPlaying) return md.currentTime;
  return md.currentTime + (now - m.wallMs) / 1000 * (md.playbackRate || 1);
}

function named(name, message, extra) {
  return Object.assign(new Error(message), { name }, extra || {});
}

/**
 * Ask the extension to capture this tab.
 *
 * mode 'pcm' (default): resolves with `{ sampleRate, channels, stop }` and calls
 *   `onPcm(Float32Array, msg)` per chunk. The extension captures in its offscreen document and
 *   plays the audio back out itself, so the user keeps hearing the tab. `monitor: false` turns
 *   that playback off.
 * mode 'stream': resolves with `{ stream, stop }`, a real MediaStream of the tab's audio, for a
 *   page that wants to feed its existing MediaStream pipeline. Chrome stops playing a captured
 *   tab to the user, and this page cannot put it back: replaying the stream inside the captured
 *   tab is captured again and feeds back (measured: a 0.141 RMS tone grew to 0.57 in two
 *   seconds). So the stream is silent for the user; use it only where that is acceptable.
 */
export function startCapture({ mode = 'pcm', monitor = true, onPcm = null, channels = 1,
                               chunkFrames = 2048, timeoutMs = 10000 } = {}) {
  const id = 'cap-' + Math.random().toString(36).slice(2);
  let offPcm = null;

  const stop = () => {
    post({ type: 'capture-stop', id });
    if (offPcm) offPcm();
  };

  const settle = (resolve, reject, m) => {
    if (m.state === 'unsupported') {
      reject(named('ExtensionCaptureUnsupported', m.error, { fallback: m.fallback }));
    } else if (m.state === 'error') {
      reject(named('ExtensionCaptureError', m.error));
    } else if (m.state === 'started') {
      if (mode === 'pcm') {
        offPcm = listen(p => { if (p.type === 'pcm' && p.id === id && onPcm) onPcm(p.data, p); });
        resolve({ id, sampleRate: m.sampleRate, channels: m.channels, stop });
      } else {
        openStream(m.streamId).then(stream => {
          resolve({ id, stream, stop: () => {
            stream.getTracks().forEach(t => t.stop());
            stop();
          } });
        }, e => reject(named('ExtensionCaptureError', e.name + ': ' + e.message)));
      }
    }
  };

  return new Promise((resolve, reject) => {
    let waitingForGesture = null;
    const t = setTimeout(() => { off(); reject(named('ExtensionCaptureError', 'no answer')); },
                         timeoutMs);
    const off = listen(m => {
      if (m.type !== 'capture' || m.id !== id) return;
      if (m.state === 'pending-gesture') {
        clearTimeout(t);
        // Hand the caller a promise for the click, and fail this one so the UI can ask for it.
        waitingForGesture = new Promise((res2, rej2) => {
          const off2 = listen(m2 => {
            if (m2.type !== 'capture' || m2.id !== id) return;
            if (m2.state === 'pending-gesture') return;
            off2();
            settle(res2, rej2, m2);
          });
        });
        off();
        reject(named('ExtensionNeedsGesture', m.error, { started: waitingForGesture, stop }));
        return;
      }
      clearTimeout(t); off();
      settle(resolve, reject, m);
    });
    post({ type: 'capture-start', id, mode, monitor, channels, chunkFrames });
  });
}

async function openStream(streamId) {
  // Must happen within a few seconds of the id being issued; Chrome expires unused ids.
  return navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
    video: false,
  });
}
