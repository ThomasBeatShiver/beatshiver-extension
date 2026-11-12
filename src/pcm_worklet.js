// AudioWorklet: gathers 128-frame render quanta into chunks of `chunkFrames` and posts them,
// interleaved, to the offscreen document. No outputs: it is a sink, not part of what is heard.
class BeatshiverPcm extends AudioWorkletProcessor {
  constructor(opts) {
    super();
    const o = (opts && opts.processorOptions) || {};
    this.channels = o.channels === 2 ? 2 : 1;
    this.chunk = o.chunkFrames || 2048;
    this.buf = new Float32Array(this.chunk * this.channels);
    this.fill = 0;
  }
  process(inputs) {
    const input = inputs[0];
    if (!input || !input.length) return true;
    const n = input[0].length;
    const L = input[0], R = input[1] || input[0];
    for (let i = 0; i < n; i++) {
      if (this.channels === 2) {
        this.buf[this.fill * 2] = L[i];
        this.buf[this.fill * 2 + 1] = R[i];
      } else {
        // Mono: average every channel the tab has.
        let s = 0;
        for (let c = 0; c < input.length; c++) s += input[c][i];
        this.buf[this.fill] = s / input.length;
      }
      if (++this.fill === this.chunk) {
        this.port.postMessage(this.buf, [this.buf.buffer]);
        this.buf = new Float32Array(this.chunk * this.channels);
        this.fill = 0;
      }
    }
    return true;
  }
}
registerProcessor('beatshiver-pcm', BeatshiverPcm);
