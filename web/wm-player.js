// AudioWorklet: проигрывает буфер и на лету встраивает водяной знак (STFT, overlap-add).
// Сетка кадров та же, что в WMCore.Embedder.render — поток совпадает с «Download».
/* global WMCore, sampleRate */
class WMPlayer extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.emb = new WMCore.Embedder(options.processorOptions.W, sampleRate);
    this.N = this.emb.N; this.hop = this.emb.hop;
    this.L = null; this.R = null; this.pos = 0; this.playing = false;
    this.acc = [new Float64Array(this.N), new Float64Array(this.N)];
    this.fL = new Float64Array(this.N); this.fR = new Float64Array(this.N);
    this.out = [new Float32Array(this.hop), new Float32Array(this.hop)];
    this.ptr = this.hop; this.block = 0; this.tick = 0;
    this.port.onmessage = (e) => this.onMsg(e.data);
  }

  onMsg(m) {
    if (m.type === 'load') { this.L = m.L; this.R = m.R; this.seek(0); this.playing = false; }
    else if (m.type === 'play') { if (this.L) { if (this.pos >= this.L.length) this.seek(0); this.playing = true; } }
    else if (m.type === 'pause') this.playing = false;
    else if (m.type === 'seek') this.seek(Math.max(0, Math.min(m.pos, this.L ? this.L.length - 1 : 0)));
    else if (m.type === 'schedule') { this.emb.schedule = m.items; if (!this.playing && this.L) this.seek(this.pos + (this.skip || 0)); }
    else if (m.type === 'alpha') this.emb.alpha = m.value;
  }

  addFrame(f, fromBlock) {
    const start = f * this.hop;
    this.emb.frame(this.L, this.R, start, (start + this.N / 2) / sampleRate, this.fL, this.fR);
    const off = (fromBlock - f) * this.hop;               // какая часть кадра попадает в acc
    for (let i = off; i < this.N; i++) { this.acc[0][i - off] += this.fL[i]; this.acc[1][i - off] += this.fR[i]; }
  }

  seek(pos) {
    const b = Math.floor(pos / this.hop);
    this.acc[0].fill(0); this.acc[1].fill(0);
    if (this.L) for (let f = b - 3; f < b; f++) this.addFrame(f, b);
    this.block = b; this.ptr = this.hop; this.pos = b * this.hop;
    this.skip = pos - b * this.hop;
  }

  nextBlock() {
    this.addFrame(this.block, this.block);
    const h = this.hop, N = this.N;
    for (let c = 0; c < 2; c++) {
      const a = this.acc[c];
      this.out[c].set(a.subarray(0, h));
      a.copyWithin(0, h); a.fill(0, N - h);
    }
    this.block++; this.ptr = 0;
  }

  process(inputs, outputs) {
    const o = outputs[0];
    for (let i = 0; i < o[0].length; i++) {
      if (!this.playing || !this.L) { o[0][i] = 0; if (o[1]) o[1][i] = 0; continue; }
      if (this.ptr >= this.hop) {
        this.nextBlock();
        if (this.skip) { this.ptr = this.skip; this.pos += this.skip; this.skip = 0; }
      }
      o[0][i] = this.out[0][this.ptr]; if (o[1]) o[1][i] = this.out[1][this.ptr];
      this.ptr++; this.pos++;
      if (this.pos >= this.L.length) { this.playing = false; this.port.postMessage({ type: 'ended' }); }
    }
    if (++this.tick % 8 === 0) this.port.postMessage({ type: 'pos', pos: this.pos, playing: this.playing });
    return true;
  }
}
registerProcessor('wm-player', WMPlayer);
