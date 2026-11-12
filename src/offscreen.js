// Chrome offscreen document (reason USER_MEDIA): the only extension context in MV3 that can turn
// a tabCapture stream id into a MediaStream and run an AudioContext on it.
//
// One capture per tab. Each one plays the captured audio back to the default output -- tab
// capture mutes the tab for the user otherwise -- and streams Float32 PCM to the background as
// base64 (extension messaging is JSON; typed arrays do not survive it).
'use strict';

const runs = new Map(); // tabId -> { stream, ctx, node, seq }

function toB64(f32) {
  const bytes = new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

async function start(msg) {
  await stop(msg.tabId);
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: msg.streamId } },
    video: false,
  });
  let ctx;
  try {
    ctx = msg.sampleRate ? new AudioContext({ sampleRate: msg.sampleRate }) : new AudioContext();
  } catch (e) {
    ctx = new AudioContext();
  }
  const src = ctx.createMediaStreamSource(stream);
  // Re-route to the speakers: without this the user stops hearing the tab the moment it is
  // captured. `monitor: false` is for a page that plays the audio some other way.
  if (msg.monitor !== false) src.connect(ctx.destination);
  await ctx.audioWorklet.addModule('pcm_worklet.js');
  const channels = msg.channels === 2 ? 2 : 1;
  const node = new AudioWorkletNode(ctx, 'beatshiver-pcm', {
    numberOfInputs: 1, numberOfOutputs: 0,
    processorOptions: { channels, chunkFrames: msg.chunkFrames || 2048 },
  });
  src.connect(node);
  const run = { stream, ctx, node, seq: 0 };
  node.port.onmessage = ev => {
    const f32 = ev.data;
    chrome.runtime.sendMessage({
      type: 'pcm', tabId: msg.tabId, id: msg.id, seq: ++run.seq,
      sampleRate: ctx.sampleRate, channels, frames: f32.length / channels,
      wallMs: Date.now(), b64: toB64(f32),
    }).catch(() => {});
  };
  stream.getAudioTracks()[0].addEventListener('ended', () => {
    stop(msg.tabId);
    chrome.runtime.sendMessage({ type: 'offscreen-ended', tabId: msg.tabId, reason: 'track-ended' })
      .catch(() => {});
  });
  if (ctx.state !== 'running') await ctx.resume().catch(() => {});
  runs.set(msg.tabId, run);
  return { ok: true, sampleRate: ctx.sampleRate, channels };
}

async function stop(tabId) {
  const run = runs.get(tabId);
  if (!run) return;
  runs.delete(tabId);
  try { run.node.port.onmessage = null; run.node.disconnect(); } catch (e) {}
  run.stream.getTracks().forEach(t => { try { t.stop(); } catch (e) {} });
  try { await run.ctx.close(); } catch (e) {}
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg || msg.target !== 'offscreen') return;
  if (msg.type === 'offscreen-start') {
    start(msg).then(reply, e => reply({ ok: false, error: e.name + ': ' + e.message }));
    return true;
  }
  if (msg.type === 'offscreen-stop') {
    stop(msg.tabId).then(() => reply({ ok: true }));
    return true;
  }
});
