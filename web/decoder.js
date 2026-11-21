/* Потоковый декодер data-over-sound. Работает в браузере (window.DosDecoder) и в node:
 *   node web/decoder.js file.mp3 [--sr 44100]
 * Протокол — web/protocol.json, кодер — encode.py.
 */
(function (root) {
  'use strict';

  // ---------- Рид–Соломон над GF(256), совместим с python reedsolo (prim 0x11d, fcr 0) ----------
  const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
  (function () {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      EXP[i] = x; LOG[x] = i;
      x <<= 1; if (x & 0x100) x ^= 0x11d;
    }
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  })();
  const gmul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);
  const gdiv = (a, b) => (a ? EXP[(LOG[a] + 255 - LOG[b]) % 255] : 0);
  const gpow = (a, p) => EXP[(((LOG[a] * p) % 255) + 255) % 255];
  const ginv = (a) => EXP[255 - LOG[a]];
  const pscale = (p, x) => p.map((c) => gmul(c, x));
  function padd(p, q) {
    const r = new Array(Math.max(p.length, q.length)).fill(0);
    for (let i = 0; i < p.length; i++) r[i + r.length - p.length] = p[i];
    for (let i = 0; i < q.length; i++) r[i + r.length - q.length] ^= q[i];
    return r;
  }
  function pmul(p, q) {
    const r = new Array(p.length + q.length - 1).fill(0);
    for (let j = 0; j < q.length; j++) for (let i = 0; i < p.length; i++) r[i + j] ^= gmul(p[i], q[j]);
    return r;
  }
  function peval(p, x) {
    let y = p[0];
    for (let i = 1; i < p.length; i++) y = gmul(y, x) ^ p[i];
    return y;
  }

  function rsDecode(msgIn, nsym) {
    let msg = Array.from(msgIn);
    const synd = (m) => [0].concat(Array.from({ length: nsym }, (_, i) => peval(m, gpow(2, i))));
    let s = synd(msg);
    if (Math.max(...s) === 0) return Uint8Array.from(msg.slice(0, msg.length - nsym));
    // Берлекэмп–Мэсси
    let errLoc = [1], oldLoc = [1];
    for (let i = 0; i < nsym; i++) {
      const K = i + 1;
      let delta = s[K];
      for (let j = 1; j < errLoc.length; j++) delta ^= gmul(errLoc[errLoc.length - 1 - j], s[K - j]);
      oldLoc = oldLoc.concat([0]);
      if (delta !== 0) {
        if (oldLoc.length > errLoc.length) {
          const newLoc = pscale(oldLoc, delta);
          oldLoc = pscale(errLoc, ginv(delta));
          errLoc = newLoc;
        }
        errLoc = padd(errLoc, pscale(oldLoc, delta));
      }
    }
    while (errLoc.length && errLoc[0] === 0) errLoc.shift();
    const errs = errLoc.length - 1;
    if (errs * 2 > nsym) return null;
    // поиск Чена
    const rev = errLoc.slice().reverse();
    const errPos = [];
    for (let i = 0; i < msg.length; i++) if (peval(rev, gpow(2, i)) === 0) errPos.push(msg.length - 1 - i);
    if (errPos.length !== errs) return null;
    // Форни
    const coefPos = errPos.map((p) => msg.length - 1 - p);
    let eLoc = [1];
    for (const i of coefPos) eLoc = pmul(eLoc, padd([1], [gpow(2, i), 0]));
    const prod = pmul(s.slice().reverse(), eLoc);
    const errEval = prod.slice(prod.length - eLoc.length).reverse();
    const X = coefPos.map((c) => gpow(2, -(255 - c)));
    const E = new Array(msg.length).fill(0);
    for (let i = 0; i < X.length; i++) {
      const xinv = ginv(X[i]);
      let prime = 1;
      for (let j = 0; j < X.length; j++) if (j !== i) prime = gmul(prime, 1 ^ gmul(xinv, X[j]));
      if (prime === 0) return null;
      const y = gmul(X[i], peval(errEval.slice().reverse(), xinv));
      E[errPos[i]] = gdiv(y, prime);
    }
    msg = padd(msg, E);
    if (Math.max(...synd(msg)) !== 0) return null;
    return Uint8Array.from(msg.slice(0, msg.length - nsym));
  }

  // ---------- FFT (radix-2, на месте) ----------
  function fft(re, im, inverse) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = ((inverse ? 2 : -2) * Math.PI) / len;
      const wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < len / 2; k++) {
          const a = i + k, b = a + len / 2;
          const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
          re[b] = re[a] - tr; im[b] = im[a] - ti;
          re[a] += tr; im[a] += ti;
          const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
        }
      }
    }
  }

  // ---------- биквад (RBJ) ----------
  class Biquad {
    constructor(type, f, q, sr) {
      const w = (2 * Math.PI * f) / sr, cs = Math.cos(w), al = Math.sin(w) / (2 * q);
      let b0, b1, b2;
      if (type === 'lp') { b0 = (1 - cs) / 2; b1 = 1 - cs; b2 = b0; }
      else { b0 = (1 + cs) / 2; b1 = -(1 + cs); b2 = b0; }
      const a0 = 1 + al;
      this.b = [b0 / a0, b1 / a0, b2 / a0];
      this.a = [(-2 * cs) / a0, (1 - al) / a0];
      this.z1 = 0; this.z2 = 0;
    }
    run(x) {
      const [b0, b1, b2] = this.b, [a1, a2] = this.a;
      let z1 = this.z1, z2 = this.z2;
      for (let i = 0; i < x.length; i++) {
        const y = b0 * x[i] + z1;
        z1 = b1 * x[i] - a1 * y + z2;
        z2 = b2 * x[i] - a2 * y;
        x[i] = y;
      }
      this.z1 = z1; this.z2 = z2;
    }
  }

  // ---------- ультразвуковой канал: текст целиком ----------
  class UltrasoundDecoder {
    constructor(P, sr, opts = {}) {
      this.P = P; this.sr = sr;
      this.thresh = opts.thresh || 0.25;
      this.isi = opts.isi ?? 0.5;   // доля мощности предыдущего символа, вычитаемая как эхо
      this.onMessage = opts.onMessage || (() => {});
      this.onEvent = opts.onEvent || (() => {});
      this.symN = Math.round(P.sym * sr);
      this.stepN = this.symN + Math.round(P.guard * sr);
      this.chirpN = Math.round(P.chirp * sr);
      this.gapN = Math.round(P.gap * sr);
      this.hdrSyms = Math.ceil(((4 + P.hdr_nsym) * 2) / P.groups);
      this.freqs = [];
      for (let g = 0; g < P.groups; g++) {
        const row = [];
        for (let t = 0; t < P.tones; t++) row.push(P.base + P.spacing * (g * (P.tones + 1) + t));
        this.freqs.push(row);
      }
      this.lo = this.freqs[0][0] - P.spacing;
      this.hi = this.freqs[P.groups - 1][P.tones - 1] + P.spacing;

      // chirp — та же формула, что в encode.py
      const c = new Float64Array(this.chirpN), fadeN = Math.max(1, Math.round(0.01 * sr));
      const k = (this.hi - this.lo) / P.chirp;
      for (let i = 0; i < this.chirpN; i++) {
        const t = i / sr;
        let env = 1;
        if (i < fadeN) env = 0.5 - 0.5 * Math.cos((Math.PI * i) / (fadeN - 1 || 1));
        else if (i >= this.chirpN - fadeN) env = 0.5 - 0.5 * Math.cos((Math.PI * (this.chirpN - 1 - i)) / (fadeN - 1 || 1));
        c[i] = Math.sin(2 * Math.PI * (this.lo * t + 0.5 * k * t * t)) * env;
      }
      this.cNorm = Math.sqrt(c.reduce((s, v) => s + v * v, 0));
      this.M = 1; while (this.M < 2 * this.chirpN) this.M <<= 1;
      this.cRe = new Float64Array(this.M); this.cIm = new Float64Array(this.M);
      this.cRe.set(c); fft(this.cRe, this.cIm, false);
      this.wRe = new Float64Array(this.M); this.wIm = new Float64Array(this.M);

      // полоса данных у самого верха спектра: достаточно крутого ФВЧ, музыка/речь ниже давятся
      this.filters = [0, 1, 2, 3].map(() => new Biquad('hp', this.lo - 300, 0.707, sr));
      if (this.hi + 300 < sr * 0.45) this.filters.push(new Biquad('lp', this.hi + 300, 0.707, sr));

      // окно анализа символа: центральная часть без фронтов, с окном Ханна
      this.winOff = Math.floor(this.symN / 8);
      this.winLen = this.symN - 2 * this.winOff;
      const nT = P.groups * P.tones;
      this.tc = new Float32Array(nT * this.winLen); this.ts = new Float32Array(nT * this.winLen);
      for (let g = 0; g < P.groups; g++) for (let t = 0; t < P.tones; t++) {
        const f = this.freqs[g][t], row = (g * P.tones + t) * this.winLen;
        for (let i = 0; i < this.winLen; i++) {
          const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (this.winLen - 1));
          this.tc[row + i] = Math.cos((2 * Math.PI * f * i) / sr) * w;
          this.ts[row + i] = Math.sin((2 * Math.PI * f * i) / sr) * w;
        }
      }
      const s48 = sr / 48000;
      this.shifts = [0, -24, 24, -60, 60, -120, 120].map((v) => Math.round(v * s48));
      this.maxShift = Math.round(120 * s48);

      this.cap = 1; while (this.cap < 22 * sr) this.cap <<= 1;
      this.buf = new Float32Array(this.cap);
      this.base = 0; this.len = 0;
      this.scanPos = 0; this.cand = null; this.pending = []; this.suppressUntil = 0;
      this.level = 0; this.lastNcc = 0;
    }

    get total() { return this.base + this.len; }

    push(chunk) {
      let e = 0;
      for (let i = 0; i < chunk.length; i++) e += chunk[i] * chunk[i];
      this.level = Math.sqrt(e / chunk.length);
      const x = Float32Array.from(chunk);
      for (const f of this.filters) f.run(x);
      if (this.len + x.length > this.cap) {
        const keep = this.cap >> 1, drop = this.len - keep;
        this.buf.copyWithin(0, drop, this.len);
        this.base += drop; this.len = keep;
        if (this.scanPos < this.base) { this.scanPos = this.base; this.cand = null; }
      }
      this.buf.set(x, this.len);
      this.len += x.length;
    }

    at(abs) { return this.buf[abs - this.base]; }

    process() {
      this._scan();
      this._resolve();
    }

    // нормированная корреляция с chirp, блоками через FFT
    _scan() {
      const L = this.chirpN, M = this.M, maxOut = M - L + 1;
      for (;;) {
        const avail = this.total - L + 1 - this.scanPos;
        if (avail < Math.min(2048, maxOut)) return;
        const n = Math.min(avail, maxOut), s0 = this.scanPos - this.base;
        const re = this.wRe, im = this.wIm, buf = this.buf;
        const segLen = Math.min(M, this.len - s0);
        for (let i = 0; i < M; i++) { re[i] = i < segLen ? buf[s0 + i] : 0; im[i] = 0; }
        fft(re, im, false);
        for (let i = 0; i < M; i++) {   // X * conj(C)
          const a = re[i], b = im[i], c = this.cRe[i], d = -this.cIm[i];
          re[i] = a * c - b * d; im[i] = a * d + b * c;
        }
        fft(re, im, true);
        let e = 0;
        for (let i = 0; i < L; i++) e += buf[s0 + i] * buf[s0 + i];
        const peakWin = Math.round(0.03 * this.sr);
        for (let i = 0; i < n; i++) {
          if (i > 0) { const a = buf[s0 + i - 1], b = buf[s0 + i + L - 1]; e += b * b - a * a; }
          const abs = this.scanPos + i;
          if (abs < this.suppressUntil) continue;
          if (e < 1e-8 * L) continue;   // тишина — корреляция бессмысленна
          const v = Math.abs(re[i] / M) / (this.cNorm * Math.sqrt(e));
          if (v > this.thresh && (!this.cand || v > this.cand.val)) this.cand = { pos: abs, val: v };
          if (this.cand && abs - this.cand.pos > peakWin) this._commit();
        }
        this.scanPos += n;
      }
    }

    _commit() {
      const c = this.cand; this.cand = null;
      this.lastNcc = c.val;
      this.pending.push({ pos: c.pos, state: 'hdr' });
      this.suppressUntil = c.pos + this.chirpN + this.gapN + this.hdrSyms * this.stepN;
      this.onEvent({ type: 'sync', t: c.pos / this.sr, ncc: c.val });
    }

    _demod(start, nSym) {
      const P = this.P, nibs = new Uint8Array(nSym * P.groups), W = this.winLen, nT = P.groups * P.tones;
      let prev = new Float64Array(nT), cur = new Float64Array(nT);
      for (let k = -1; k < nSym; k++) {   // k = -1: окно перед первым символом, для оценки эха
        const s = start + k * this.stepN + this.winOff - this.base;
        if (s < 0 || s + W > this.len) return null;
        for (let r = 0; r < nT; r++) {
          const row = r * W;
          let a = 0, b = 0;
          for (let i = 0; i < W; i++) { const v = this.buf[s + i]; a += v * this.tc[row + i]; b += v * this.ts[row + i]; }
          cur[r] = a * a + b * b;
        }
        if (k >= 0) {
          for (let g = 0; g < P.groups; g++) {
            let best = -Infinity, bi = 0;
            for (let t = 0; t < P.tones; t++) {
              const r = g * P.tones + t, p = cur[r] - this.isi * prev[r];
              if (p > best) { best = p; bi = t; }
            }
            nibs[k * P.groups + g] = bi;
          }
        }
        [prev, cur] = [cur, prev];
      }
      const out = new Uint8Array(nibs.length >> 1);
      for (let i = 0; i < out.length; i++) out[i] = nibs[2 * i] | (nibs[2 * i + 1] << 4);
      return out;
    }

    _resolve() {
      const P = this.P;
      this.pending = this.pending.filter((p) => {
        const sym0 = p.pos + this.chirpN + this.gapN;
        if (sym0 - this.maxShift < this.base) return false;
        if (p.state === 'hdr') {
          if (this.total < sym0 + this.hdrSyms * this.stepN + this.maxShift) return true;
          p.ok = [];
          for (const sh of this.shifts) {
            const h = this._demod(sym0 + sh, this.hdrSyms);
            const d = h && rsDecode(h, P.hdr_nsym);
            if (d && d[0] > 0 && d[0] <= P.max_len) p.ok.push({ sh, len: d[0], flags: d[1], dur: (d[2] << 8) | d[3] });
          }
          if (!p.ok.length) { this.onEvent({ type: 'fail', stage: 'header', t: p.pos / this.sr }); return false; }
          const h = p.ok[0];
          p.bodyBytes = h.len + P.body_nsym;
          p.bodySyms = Math.ceil((p.bodyBytes * 2) / P.groups);
          p.end = sym0 + (this.hdrSyms + p.bodySyms) * this.stepN;
          this.suppressUntil = Math.max(this.suppressUntil, p.end + h.sh);
          p.state = 'body';
          this.onEvent({ type: 'header', t: p.pos / this.sr, len: h.len, eta: (p.end - this.total) / this.sr });
        }
        if (this.total < p.end + this.maxShift) return true;
        const tried = new Set();
        for (const h of p.ok.concat(this.shifts.map((sh) => ({ ...p.ok[0], sh })))) {
          if (tried.has(h.sh)) continue;
          tried.add(h.sh);
          const raw = this._demod(sym0 + h.sh + this.hdrSyms * this.stepN, p.bodySyms);
          const d = raw && rsDecode(raw.subarray(0, p.bodyBytes), P.body_nsym);
          if (!d) continue;
          const text = new TextDecoder(h.flags & 1 ? 'windows-1251' : 'utf-8').decode(d);
          this.onMessage({ text, duration: h.dur / 10, t: p.pos / this.sr, ncc: this.lastNcc });
          return false;
        }
        this.onEvent({ type: 'fail', stage: 'body', t: p.pos / this.sr });
        return false;
      });
    }
  }

  // ---------- водяной знак: «ролик id, время t» ----------
  function xorshiftPn(seed, n) {
    let x = seed >>> 0;
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
      out[i] = (x >>> 16) & 1 ? 1 : -1;
    }
    return out;
  }
  function crc16(bytes) {
    let crc = 0xffff;
    for (const b of bytes) {
      crc ^= b << 8;
      for (let i = 0; i < 8; i++) crc = (crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1) & 0xffff;
    }
    return crc;
  }

  class WatermarkDecoder {
    constructor(P, sr, opts = {}) {
      this.P = P; this.sr = sr;
      this.onLock = opts.onLock || (() => {});
      this.N = P.fft;
      this.hop = Math.round((P.hop * sr) / 48000);
      this.H = P.half_hops;
      this.nData = P.id_bits + P.time_bits;
      this.msgBits = P.sync.length + this.nData + 16;
      this.halfCount = 2 * this.msgBits;
      this.halfDur = (P.hop * this.H) / 48000;             // секунды — по часам кодера
      this.msgDur = this.halfDur * this.halfCount;
      this.msgHops = this.halfCount * this.H;
      const nCells = Math.floor((P.fmax - P.fmin) / P.cell_hz);
      let pn = xorshiftPn(P.seed, P.pairs ? (nCells + 1) >> 1 : nCells);
      if (P.pairs) pn = Float64Array.from({ length: nCells }, (_, c) => pn[c >> 1] * (c % 2 ? -1 : 1));
      // вес каждого бина = ±1 его частотной ячейки; среднее вычитаем → громкость не влияет
      this.bins = []; const w = [];
      for (let k = 0; k <= this.N / 2; k++) {
        const f = (k * sr) / this.N, c = Math.floor((f - P.fmin) / P.cell_hz);
        if (f >= P.fmin && c < nCells) { this.bins.push(k); w.push(pn[c]); }
      }
      const mean = w.reduce((a, b) => a + b, 0) / w.length;
      this.w = Float64Array.from(w, (v) => v - mean);
      this.win = Float64Array.from({ length: this.N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / this.N));
      this.re = new Float64Array(this.N); this.im = new Float64Array(this.N);
      this.hpW = Math.round(Math.max(0.4, 4 * this.halfDur) / (this.hop / sr));   // полуширина окна ФВЧ, хопов

      this.sbuf = new Float32Array(1 << 17); this.sLen = 0; this.sBase = 0;  // сэмплы
      this.c = []; this.cBase = 0;                         // проекция на узор, по хопам
      this.cPre = [0];                                     // префиксные суммы c
      this.d = []; this.dPre = [0];                        // c после ФВЧ и их префиксы
      this.nextE = 0; this.chipCache = new Map();
      this.zFixed = opts.zThresh; this.lastZ = 0;
      this.searchWindows = opts.searchWindows || [6, 12];
      this.searchThresh = opts.searchThresh || 5.6;
      this.setAllowed(opts.allowed || null);
    }

    get hops() { return this.cBase + this.c.length; }      // сколько хопов посчитано
    get dEnd() { return this.cBase + this.d.length; }      // сколько готово после ФВЧ
    centerTime(h) { return (h * this.hop + this.N / 2) / this.sr; }

    push(chunk) {
      if (this.sLen + chunk.length > this.sbuf.length) {
        const from = this.hops * this.hop - this.sBase;     // начало следующего кадра
        this.sbuf.copyWithin(0, from, this.sLen);
        this.sLen -= from; this.sBase += from;
      }
      this.sbuf.set(chunk, this.sLen); this.sLen += chunk.length;
      for (;;) {
        const s = this.hops * this.hop - this.sBase;
        if (s + this.N > this.sLen) break;
        for (let i = 0; i < this.N; i++) { this.re[i] = this.sbuf[s + i] * this.win[i]; this.im[i] = 0; }
        fft(this.re, this.im, false);
        let v = 0;
        for (let j = 0; j < this.bins.length; j++) {
          const k = this.bins[j];
          v += this.w[j] * Math.log(this.re[k] * this.re[k] + this.im[k] * this.im[k] + 1e-12);
        }
        this.c.push(v);
        this.cPre.push(this.cPre[this.cPre.length - 1] + v);
      }
      // ФВЧ: d[h] = c[h] − среднее c по ±hpW хопов
      while (this.dEnd + this.hpW < this.hops) {
        const h = this.dEnd, i = h - this.cBase;
        const a = Math.max(0, i - this.hpW), b = i + this.hpW + 1;
        const v = this.c[i] - (this.cPre[b] - this.cPre[a]) / (b - a);
        this.d.push(v); this.dPre.push(this.dPre[this.dPre.length - 1] + v);
      }
      if (this.c.length > 6000) this._trim(3000);
    }

    _trim(keep) {
      const drop = this.c.length - keep;
      this.c = this.c.slice(drop); this.d = this.d.slice(drop);
      const c0 = this.cPre[drop], d0 = this.dPre[drop];
      this.cPre = this.cPre.slice(drop).map((v) => v - c0);
      this.dPre = this.dPre.slice(drop).map((v) => v - d0);
      this.cBase += drop;
    }

    // своя маска для каждого ролика и сообщения (как в encode.py)
    whiten(id, m) {
      const pn = xorshiftPn((this.P.seed ^ Math.imul(id, 0x9e3779b1) ^ Math.imul(m, 0x85ebca6b)) >>> 0, this.msgBits);
      return Array.from(pn, (v) => (v > 0 ? 1 : 0));
    }

    bits(id, m) {
      const P = this.P, data = (id << P.time_bits) | (m % (1 << P.time_bits));
      const crc = crc16([data >> 8, data & 0xff]), out = P.sync.slice();
      for (let i = 0; i < this.nData; i++) out.push((data >> (this.nData - 1 - i)) & 1);
      for (let i = 0; i < 16; i++) out.push((crc >> (15 - i)) & 1);
      const w = this.whiten(id, m % (1 << P.time_bits));
      return out.map((b, i) => b ^ w[i]);
    }
    chips(id, m) {
      const key = id * 65536 + m;
      if (!this.chipCache.has(key)) {
        if (this.chipCache.size > 64) this.chipCache.clear();
        this.chipCache.set(key, this.bits(id, m).flatMap((b) => (b ? [1, -1] : [-1, 1])));
      }
      return this.chipCache.get(key);
    }

    // мягкие биты сообщения, заканчивающегося перед хопом e
    _soft(e) {
      const H = this.H, start = e - this.msgHops - this.cBase, D = this.dPre, out = new Float64Array(this.msgBits);
      for (let i = 0; i < this.msgBits; i++) {
        const a = start + 2 * i * H;
        out[i] = (D[a + H] - D[a]) - (D[a + 2 * H] - D[a + H]);
      }
      return out;
    }

    // Декодирование по максимуму правдоподобия: перебираем все 2^16 пар (ролик, время),
    // считаем корреляцию мягких бит с их кодовым словом (данные+CRC), складывая энергию
    // текущего и 1–2 предыдущих сообщений (у них время m−1, m−2). Через таблицы по байтам —
    // ~1 млн операций на попытку.
    _tables() {
      const n = 1 << this.nData;
      this.cw = new Uint32Array(n); this.pv = new Uint32Array(n);
      const tm = (1 << this.P.time_bits) - 1;
      const ns = this.P.sync.length, tb = this.P.time_bits;
      this.syncv = new Uint8Array(n);
      for (let v = 0; v < n; v++) {
        const w = this.whiten(v >> tb, v & tm);
        let x = 0, sy = 0;
        for (let i = 0; i < 32; i++) x = ((x << 1) | w[ns + i]) >>> 0;
        for (let i = 0; i < ns; i++) sy = (sy << 1) | (this.P.sync[i] ^ w[i]);
        this.syncv[v] = sy;
        this.cw[v] = (((v << 16) | crc16([v >> 8, v & 0xff])) ^ x) >>> 0;
        this.pv[v] = (v & ~tm) | (((v & tm) + tm) & tm);   // тот же ролик, время m−1
      }
    }

    // allowed: [{id, duration}] — какие ролики бывают. Меньше гипотез → ниже порог при той же
    // вероятности ложной метки (максимум N гауссовых шумов ≈ √(2 ln N)).
    setAllowed(allowed) {
      let list;
      if (allowed && allowed.length) {
        const tm = 1 << this.P.time_bits, vs = [];
        for (const a of allowed) {
          const maxM = Math.min(tm - 1, Math.ceil((a.duration || tm * this.msgDur) / this.msgDur) + 1);
          for (let m = 0; m <= maxM; m++) vs.push((a.id << this.P.time_bits) | m);
        }
        list = Uint32Array.from(vs);
      } else list = null;
      this.hyp = list;
      this.allowed = allowed && allowed.length ? allowed : null;
      this.grids = new Map();
      const N = list ? list.length : 1 << this.nData;
      this.zThresh = this.zFixed || (list ? +(Math.sqrt(2 * Math.log(Math.max(N, 2))) + 1.8).toFixed(2) : 7.8);
    }

    _windowStats(e) {
      const b = this._soft(e), ns = this.P.sync.length, T = [];
      let en = 0;
      for (let i = 0; i < b.length; i++) en += b[i] * b[i];
      const Ts = new Float64Array(1 << ns);   // вклад синхрослова (с маской) для каждого его варианта
      for (let x = 0; x < Ts.length; x++) {
        let v = 0;
        for (let i = 0; i < ns; i++) v += (x >> (ns - 1 - i)) & 1 ? b[i] : -b[i];
        Ts[x] = v;
      }
      for (let q = 0; q < 4; q++) {
        const t = new Float64Array(256);
        for (let x = 0; x < 256; x++) {
          let v = 0;
          for (let k = 0; k < 8; k++) v += (x >> (7 - k)) & 1 ? b[ns + 8 * q + k] : -b[ns + 8 * q + k];
          t[x] = v;
        }
        T.push(t);
      }
      return { Ts, en, T };
    }

    _ml(e) {
      if (!this.cw) this._tables();
      const W = [];
      for (let w = 0; w < 3 && e - (w + 1) * this.msgHops >= this.cBase; w++) W.push(this._windowStats(e - w * this.msgHops));
      const best = W.map(() => ({ z: -Infinity, v: 0 }));
      const norm = []; let acc = 0;
      for (const w of W) { acc += w.en; norm.push(1 / Math.sqrt(acc + 1e-12)); }
      const cw = this.cw, pv = this.pv, hyp = this.hyp, n = hyp ? hyp.length : cw.length, tb = this.P.time_bits;
      for (let h = 0; h < n; h++) {
        const v = hyp ? hyp[h] : h;
        let u = v, tot = 0;
        for (let w = 0; w < W.length; w++) {
          const c = cw[u], T = W[w].T;
          tot += W[w].Ts[this.syncv[u]] + T[0][c >>> 24] + T[1][(c >>> 16) & 255] + T[2][(c >>> 8) & 255] + T[3][c & 255];
          const z = tot * norm[w];
          if (z > best[w].z) { best[w].z = z; best[w].v = v; }
          u = pv[u];
        }
      }
      let r = null;
      best.forEach((bw, w) => { if (!r || bw.z > r.z) r = { z: bw.z, v: bw.v, msgs: w + 1 }; });
      return r;
    }

    // Узор водяного знака по времени видео на сетке хопов: chip(t) для t = k·hopDur.
    _grid(a, n) {
      const key = a.id + ':' + n;
      if (this.grids.has(key)) return this.grids.get(key);
      const hopDur = this.hop / this.sr, re = new Float64Array(n), im = new Float64Array(n);
      const G = Math.min(n, Math.ceil((a.duration + 20) / hopDur)), tm = 1 << this.P.time_bits;
      for (let k = 0; k < G; k++) {
        const slot = Math.floor((k * hopDur) / this.halfDur), m = Math.floor(slot / this.halfCount);
        re[k] = this.chips(a.id, m % tm)[slot % this.halfCount];
      }
      fft(re, im, false);
      const g = { re, im, G };
      this.grids.set(key, g);
      return g;
    }

    // Скользящая корреляция последних windowSec секунд со всем узором каждого ролика —
    // не нужно ждать целых сообщений. z = пик / СКО корреляции по всем сдвигам.
    search(windowSec) {
      if (!this.allowed) return null;
      const hopDur = this.hop / this.sr, W = Math.min(this.d.length, Math.round(windowSec / hopDur));
      if (W < Math.round(3 / hopDur)) return null;
      let best = null;
      for (const a of this.allowed) {
        const Gmax = Math.ceil((a.duration + 20) / hopDur);
        let n = 1; while (n < Gmax + W) n <<= 1;
        const g = this._grid(a, n), re = new Float64Array(n), im = new Float64Array(n);
        for (let j = 0; j < W; j++) re[j] = this.d[this.d.length - W + j];
        fft(re, im, false);
        for (let i = 0; i < n; i++) {           // G * conj(Dw)
          const a1 = g.re[i], b1 = g.im[i], c1 = re[i], d1 = -im[i];
          re[i] = a1 * c1 - b1 * d1; im[i] = a1 * d1 + b1 * c1;
        }
        fft(re, im, true);
        const K = Math.max(1, g.G - W);
        let sum = 0, sum2 = 0, pk = -Infinity, pkK = 0;
        for (let k = 0; k < K; k++) {
          const v = re[k] / n;
          sum += v; sum2 += v * v;
          if (v > pk) { pk = v; pkK = k; }
        }
        const mean = sum / K, sd = Math.sqrt(Math.max(sum2 / K - mean * mean, 1e-30));
        const z = (pk - mean) / sd;
        if (!best || z > best.z) best = { id: a.id, z, videoTime: pkK * hopDur, streamTime: this.centerTime(this.cBase + this.d.length - W) };
      }
      return best;
    }

    process() {
      const H2 = 2 * this.H;
      if (!this.phase) this.phase = new Float64Array(H2);
      if (this.allowed && this.dEnd - (this.lastSearch || 0) >= Math.round(0.5 / (this.hop / this.sr))) {
        this.lastSearch = this.dEnd;
        for (const w of this.searchWindows) {
          const r = this.search(w);
          if (!r) continue;
          this.lastSearchZ = Math.max(this.lastSearchZ || 0, r.z);
          if (r.z >= this.searchThresh) {
            this.onLock({ id: r.id, m: -1, streamTime: r.streamTime, videoTime: r.videoTime, quality: r.z, msgs: `поиск ${w} с` });
            break;
          }
        }
      }
      // список роликов известен → хватает скользящего поиска (он надёжнее: декодирование по
      // сообщениям при сдвинутой фазе бит иногда «узнаёт» чужую гипотезу)
      if (this.allowed) { this.nextE = this.dEnd + 1; return; }
      const min = this.cBase + this.msgHops;
      if (this.nextE < min) this.nextE = min;
      for (; this.nextE <= this.dEnd; this.nextE++) {
        const e = this.nextE, i = e - this.cBase, D = this.dPre;
        // тактовая синхронизация: в какой фазе (по модулю бита) манчестерские биты сильнее
        const bit = (D[i - H2] - D[i - this.H]) - (D[i - this.H] - D[i]);
        const ph = e % H2;
        this.phase[ph] = 0.97 * this.phase[ph] + bit * bit;
        let bp = 0;
        for (let k = 1; k < H2; k++) if (this.phase[k] > this.phase[bp]) bp = k;
        if (ph !== bp) continue;
        const r = this._ml(e);
        this.lastZ = r.z;
        if (r.z < this.zThresh) continue;
        // граница сообщения — между центрами кадров e−1 и e
        const id = r.v >> this.P.time_bits, m = r.v & ((1 << this.P.time_bits) - 1);
        const t = this.centerTime(e) - this.hop / 2 / this.sr;
        this.onLock({ id, m, streamTime: t, videoTime: (m + 1) * this.msgDur, quality: r.z, msgs: r.msgs });
      }
    }

    // насколько последние ~2 с совпадают с ожидаемым узором при данном сопоставлении времени
    track(id, offset, seconds = 2) {
      const n = Math.min(this.d.length, Math.round(seconds / (this.hop / this.sr)));
      let acc = 0, e2 = 0;
      for (let i = this.d.length - n; i < this.d.length; i++) {
        const vt = this.centerTime(this.cBase + i) + offset;
        if (vt < 0) continue;
        const slot = Math.floor(vt / this.halfDur), m = Math.floor(slot / this.halfCount);
        const chip = this.chips(id, m % (1 << this.P.time_bits))[slot % this.halfCount];
        acc += this.d[i] * chip; e2 += this.d[i] * this.d[i];
      }
      return n ? acc / Math.sqrt(e2 * n + 1e-12) : 0;
    }
  }

  // ---------- текст из водяного знака: пакет по кругу, накопление повторов ----------
  const Core = typeof WMCore !== 'undefined' ? WMCore : (typeof require !== 'undefined' ? require('./wmcore.js') : null);

  class PacketDecoder {
    constructor(P, sr, opts = {}) {
      this.P = P; this.sr = sr; this.H = P.half_hops;
      this.codec = opts.codec;
      this.onMessage = opts.onMessage || (() => {});
      this.fe = new WatermarkDecoder(P, sr, {});             // общий «фронт»: проекция на узор + ФВЧ
      this.hopDur = this.fe.hop / sr;
      this.ratio = this.hopDur / (P.hop / 48000);             // хоп приёмника в хопах кодера
      this.classes = P.packet.sizes.map((K) => {
        const ci = Core.classInfo(P, K), period = ci.bits * 2 * this.H;
        return { K, ci, period, acc: new Float64Array(period), sync: Int8Array.from(ci.sync, (b) => (b ? 1 : -1)) };
      });
      this.tau = P.packet.tau; this.nextH = 0; this.heard = 0;
      this.best = { z: 0, K: 0 }; this.level = 0;
    }

    push(chunk) {
      this.fe.push(chunk);
      const fe = this.fe;
      let h = Math.max(this.nextH, fe.cBase);
      const end = fe.dEnd;
      if (end <= h) return;
      const lam = Math.exp((-(end - h) * this.hopDur) / this.tau);   // забываем старое (смена текста)
      for (const c of this.classes) for (let i = 0; i < c.period; i++) c.acc[i] *= lam;
      for (; h < end; h++) {
        const v = fe.d[h - fe.cBase], u = Math.round(h * this.ratio);
        for (const c of this.classes) c.acc[u % c.period] += v;
      }
      this.heard += (end - this.nextH) * this.hopDur;
      this.nextH = end;
    }

    reset() { for (const c of this.classes) c.acc.fill(0); this.heard = 0; }

    process() {
      const H = this.H, ns = this.P.packet.sync_bits;
      let best = { z: 0, K: 0 };
      const found = [];
      for (const c of this.classes) {
        const Pn = c.period, a = c.acc, pre = new Float64Array(2 * Pn + 1);
        for (let i = 0; i < 2 * Pn; i++) pre[i + 1] = pre[i] + a[i % Pn];
        const bit = new Float64Array(Pn);
        let e2 = 0, nz = 0;
        for (let x = 0; x < Pn; x++) {
          bit[x] = (pre[x + H] - pre[x]) - (pre[x + 2 * H] - pre[x + H]);
          if (a[x] !== 0) { e2 += bit[x] * bit[x]; nz++; }      // шум — только по уже услышанным позициям
        }
        if (nz < Pn / 4) continue;                               // услышано меньше четверти круга
        const sigma = Math.sqrt(e2 / nz) + 1e-12;
        let b1 = -Infinity, x1 = 0, b2 = -Infinity, x2 = 0;
        for (let x = 0; x < Pn; x++) {
          let s = 0;
          for (let i = 0; i < ns; i++) s += c.sync[i] * bit[(x + i * 2 * H) % Pn];
          if (s > b1) { b2 = b1; x2 = x1; b1 = s; x1 = x; } else if (s > b2 && Math.abs(x - x1) > H) { b2 = s; x2 = x; }
        }
        const z1 = b1 / (sigma * Math.sqrt(ns));
        if (z1 > best.z) best = { z: z1, K: c.K };
        for (const [x, z] of [[x1, z1], [x2, b2 / (sigma * Math.sqrt(ns))]]) {
          if (z < 2.5) continue;
          const soft = new Float64Array(c.ci.coded);
          for (let j = 0; j < soft.length; j++) soft[j] = bit[(x + (ns + j) * 2 * H) % Pn];
          const payload = Core.decodePacket(c.ci, soft);
          const text = payload && this.codec ? this.codec.decode(Array.from(payload)) : null;
          if (text !== null && text !== undefined && text.length) { found.push({ text, K: c.K, z }); break; }
        }
      }
      this.best = best;
      for (const f of found) this.onMessage({ ...f, heard: this.heard });
      return found;
    }
  }

  const api = { UltrasoundDecoder, WatermarkDecoder, PacketDecoder, rsDecode };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DosDecoder = api;

  // ---------- CLI для проверки: node web/decoder.js file [--sr N] [-v] ----------
  if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
    const { spawnSync } = require('child_process');
    const path = require('path');
    const args = process.argv.slice(2);
    const file = args.find((a) => !a.startsWith('-') && !/^\d+$/.test(a));
    const sr = args.includes('--sr') ? +args[args.indexOf('--sr') + 1] : 48000;
    const verbose = args.includes('-v');
    const P = require(path.join(__dirname, 'protocol.json'));
    const r = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'f32le', '-ac', '1', '-ar', String(sr), '-'],
      { maxBuffer: 1 << 30 });
    const pcm = new Float32Array(r.stdout.buffer, r.stdout.byteOffset, r.stdout.length / 4);
    let nUs = 0, nWm = 0, wmBad = 0;
    const us = new UltrasoundDecoder(P.ultrasound, sr, {
      onMessage: (m) => { nUs++; console.log(`${m.t.toFixed(2).padStart(7)}s  ультразвук ncc=${m.ncc.toFixed(2)}  ${m.text.replace(/\n/g, ' / ')}`); },
      onEvent: (e) => { if (verbose || e.type === 'fail') console.error('  ', JSON.stringify(e)); },
    });
    const zArg = args.includes('--z') ? +args[args.indexOf('--z') + 1] : undefined;
    let zMax = 0;
    const allowArg = args.includes('--allow') ? args[args.indexOf('--allow') + 1] : null;
    const allowed = allowArg ? allowArg.split(',').map((x) => { const [id, d] = x.split(':'); return { id: +id, duration: +d }; }) : null;
    const sArg = args.includes('--sz') ? +args[args.indexOf('--sz') + 1] : undefined;
    const wm = new WatermarkDecoder(P.watermark, sr, { zThresh: zArg, allowed, searchThresh: sArg,
      onLock: (l) => {
        nWm++;
        const err = l.streamTime - l.videoTime;               // для файла поток = видео, должно быть ≈0
        if (Math.abs(err) > 0.05) wmBad++;
        console.log(`найдено на ${wm.centerTime(wm.dEnd).toFixed(1).padStart(5)}s  водяной знак: ролик #${l.id}, видео ${l.videoTime.toFixed(2)}s (ошибка ${(err * 1000).toFixed(0)} мс), z=${l.quality.toFixed(1)} [${l.msgs}], слежение ${wm.track(l.id, l.videoTime - l.streamTime, 4).toFixed(2)}`);
      },
    });
    console.error(`водяной знак: порог z=${wm.zThresh}`);
    const { TextCodec } = require('./textcodec.js');
    const codec = new TextCodec(require(path.join(__dirname, 'vocab.json')));
    let lastText = null, nPk = 0;
    const pd = new PacketDecoder(P.watermark, sr, { codec, onMessage: (m) => {
      nPk++;
      if (m.text !== lastText) console.log(`найдено на ${(i0 / sr).toFixed(1).padStart(5)}s  ТЕКСТ (K=${m.K}, z=${m.z.toFixed(1)}): ${m.text}`);
      lastText = m.text;
    } });
    let i0 = 0;
    const textOnly = args.includes('--text');
    const t0 = Date.now();
    for (let i = 0; i < pcm.length; i += 2048) {
      const ch = pcm.subarray(i, i + 2048);
      i0 = i; pd.push(ch); if ((i / 2048) % 24 === 0) pd.process();
      if (textOnly) continue;
      us.push(ch); wm.push(ch);
      if ((i / 2048) % 4 === 0) { us.process(); wm.process(); zMax = Math.max(zMax, wm.lastZ); }
    }
    pd.process();
    if (textOnly) { console.error(`текст из водяного знака: ${nPk} успешных декодирований, сила синхро z=${pd.best.z.toFixed(1)} (K=${pd.best.K}); ${(pcm.length / sr).toFixed(0)} с аудио за ${((Date.now() - t0) / 1000).toFixed(1)} с`); return; }
    const tail = new Float32Array(sr); us.push(tail); wm.push(tail); us.process(); wm.process();
    const dur = pcm.length / sr;
    console.error(`текст из водяного знака: ${nPk} успешных декодирований, последняя сила синхро z=${pd.best.z.toFixed(1)} (K=${pd.best.K})`);
    console.error(`ультразвук: ${nUs} реплик; водяной знак: ${nWm} меток из ~${Math.floor(dur / wm.msgDur)}` +
      (wmBad ? `, ${wmBad} с неверным временем` : '') + `, макс. z=${zMax.toFixed(1)}, макс. z поиска=${(wm.lastSearchZ || 0).toFixed(1)}` + `; ${dur.toFixed(1)} с аудио за ${((Date.now() - t0) / 1000).toFixed(2)} с`);
  }
})(typeof self !== 'undefined' ? self : this);
