/* Ядро водяного знака «текст в звуке» — общее для передатчика (страница + AudioWorklet),
 * приёмника и node-утилит.
 *
 * Пакет:  [синхрослово 24 бита][свёрточный код K=7, r=1/2 над (текст+CRC16+хвост), перемежение,
 *          маска]  — крутится по кругу. Каждый бит — манчестерская пара «чипов» (+,−)/(−,+).
 * Чип = небольшое изменение амплитуд (±α в лог-шкале) частотных ячеек 200–6000 Гц по
 * псевдослучайному узору, пары соседних ячеек с противоположными знаками (неслышимо).
 */
(function (root) {
  'use strict';

  // ---------- общие утилиты ----------
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
      const ang = ((inverse ? 2 : -2) * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang), half = len >> 1;
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < half; k++) {
          const a = i + k, b = a + half;
          const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
          const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
        }
      }
    }
  }

  function prbs(seed, n) {             // xorshift32 → биты 0/1
    let x = seed >>> 0 || 1;
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
      out[i] = (x >>> 16) & 1;
    }
    return out;
  }

  function crc16bits(bits) {
    let crc = 0xffff;
    for (const b of bits) {
      const top = ((crc >> 15) & 1) ^ b;
      crc = ((crc << 1) & 0xffff) ^ (top ? 0x1021 : 0);
    }
    return crc;
  }

  // ---------- частотный узор ----------
  function pattern(W) {
    const nCells = Math.floor((W.fmax - W.fmin) / W.cell_hz);
    const base = prbs(W.seed, (nCells + 1) >> 1), pat = new Float64Array(nCells);
    for (let c = 0; c < nCells; c++) pat[c] = (base[c >> 1] ? 1 : -1) * (c % 2 ? -1 : 1);
    return { nCells, pat };
  }

  // ---------- пакет ----------
  const G1 = 0o133, G2 = 0o171, TAIL = 6;
  const parity = (x) => { x ^= x >> 4; x ^= x >> 2; x ^= x >> 1; return x & 1; };

  // Короткое перемежение (блоки по 16 бит, бит-реверс): биты идут почти по порядку, поэтому
  // начало пакета можно раскодировать, не дослушав круг, — слова появляются по мере прихода.
  const BR16 = [0, 8, 4, 12, 2, 10, 6, 14, 1, 9, 5, 13, 3, 11, 7, 15];
  function classInfo(W, K) {
    const Pk = W.packet, coded = 2 * (K + 16 + TAIL), B = Pk.interleave || 16;
    const perm = Array.from({ length: coded }, (_, i) => i);
    for (let b = 0; b + B <= coded; b += B) for (let i = 0; i < B; i++) perm[b + i] = b + (B === 16 ? BR16[i] : i);
    return {
      K, coded, perm,
      whiten: prbs((W.seed ^ Math.imul(K, 7919) ^ 0x5bd1e995) >>> 0, coded),
      sync: prbs((W.seed ^ Math.imul(K, 104729) ^ 0xabcdef) >>> 0, Pk.sync_bits),
      bits: Pk.sync_bits + coded,
    };
  }

  function convEncode(bits) {
    const out = new Uint8Array(bits.length * 2);
    let s = 0;
    for (let i = 0; i < bits.length; i++) {
      const reg = ((s << 1) | bits[i]) & 127;
      out[2 * i] = parity(reg & G1); out[2 * i + 1] = parity(reg & G2);
      s = reg & 63;
    }
    return out;
  }

  // payload — массив бит (≤ максимального K). Возвращает пакет и его чипы.
  function buildPacket(W, payload) {
    const sizes = W.packet.sizes;
    let K = sizes.find((k) => k >= payload.length);
    if (!K) { K = sizes[sizes.length - 1]; payload = payload.slice(0, K); }
    const info = new Uint8Array(K + 16 + TAIL);
    info.set(payload);
    const crc = crc16bits(info.subarray(0, K));
    for (let i = 0; i < 16; i++) info[K + i] = (crc >> (15 - i)) & 1;
    const ci = classInfo(W, K), enc = convEncode(info), tx = new Uint8Array(ci.coded);
    for (let i = 0; i < ci.coded; i++) tx[ci.perm[i]] = enc[i] ^ ci.whiten[ci.perm[i]];
    const bits = new Uint8Array(ci.bits);
    bits.set(ci.sync); bits.set(tx, ci.sync.length);
    const chips = new Int8Array(bits.length * 2);
    for (let i = 0; i < bits.length; i++) { chips[2 * i] = bits[i] ? 1 : -1; chips[2 * i + 1] = bits[i] ? -1 : 1; }
    return { K, bits, chips, used: payload.length, seconds: chips.length * W.half_hops * W.hop / 48000 };
  }

  // мягкий Витерби: soft > 0 ⇒ «1»
  function viterbi(soft, nInfo) {
    const NS = 64, NEG = -1e300;
    let pm = new Float64Array(NS).fill(NEG); pm[0] = 0;
    let nm = new Float64Array(NS);
    const dec = new Uint8Array(nInfo * NS);
    const o1 = new Int8Array(128), o2 = new Int8Array(128);
    for (let r = 0; r < 128; r++) { o1[r] = parity(r & G1) ? 1 : -1; o2[r] = parity(r & G2) ? 1 : -1; }
    for (let t = 0; t < nInfo; t++) {
      const s1 = soft[2 * t], s2 = soft[2 * t + 1];
      nm.fill(NEG);
      for (let s = 0; s < NS; s++) {
        if (pm[s] === NEG) continue;
        for (let u = 0; u < 2; u++) {
          const reg = ((s << 1) | u) & 127, ns = reg & 63;
          const m = pm[s] + o1[reg] * s1 + o2[reg] * s2;
          if (m > nm[ns]) { nm[ns] = m; dec[t * NS + ns] = s >> 5; } // запоминаем старший бит предыдущего
        }
      }
      [pm, nm] = [nm, pm];
    }
    const out = new Uint8Array(nInfo);
    let s = 0;                                  // хвост из нулей ⇒ конечное состояние 0
    for (let t = nInfo - 1; t >= 0; t--) {
      out[t] = s & 1;
      s = (s >> 1) | (dec[t * NS + s] << 5);
    }
    return out;
  }

  // мягкие биты пакета (без синхрослова, в порядке передачи) → лучшая догадка Витерби:
  // info — биты (текст+CRC+хвост), soft — снятые маска/перемежение, agree — согласие каждого
  // принятого бита с перекодированной догадкой (0 там, где ещё ничего не услышано)
  function decodeSoft(ci, softTx) {
    const soft = new Float64Array(ci.coded);
    for (let i = 0; i < ci.coded; i++) {
      const p = ci.perm[i];
      soft[i] = ci.whiten[p] ? -softTx[p] : softTx[p];
    }
    const info = viterbi(soft, ci.K + 16 + TAIL);
    const re = convEncode(info), agree = new Float64Array(ci.coded);
    for (let i = 0; i < ci.coded; i++) agree[i] = re[i] ? soft[i] : -soft[i];
    let crc = 0;
    for (let i = 0; i < 16; i++) crc = (crc << 1) | info[ci.K + i];
    const payload = info.subarray(0, ci.K);
    return { info, payload, soft, agree, ok: crc16bits(payload) === crc };
  }

  function decodePacket(ci, softTx) {
    const r = decodeSoft(ci, softTx);
    return r.ok ? r.payload : null;
  }

  // ---------- встраивание (стерео одним комплексным БПФ: re=L, im=R) ----------
  class Embedder {
    constructor(W, sr) {
      this.W = W; this.N = W.fft; this.hop = Math.round((W.hop * sr) / 48000); this.sr = sr;
      this.halfDur = (W.half_hops * W.hop) / 48000;
      const { nCells, pat } = pattern(W);
      this.gainIdx = []; this.gainPat = [];
      for (let k = 1; k < this.N / 2; k++) {
        const f = (k * sr) / this.N, c = Math.floor((f - W.fmin) / W.cell_hz);
        if (f >= W.fmin && c < nCells) { this.gainIdx.push(k); this.gainPat.push(pat[c]); }
      }
      this.win = Float64Array.from({ length: this.N }, (_, i) => Math.sqrt(0.5 - 0.5 * Math.cos((2 * Math.PI * i) / this.N)));
      this.re = new Float64Array(this.N); this.im = new Float64Array(this.N);
      this.schedule = []; this.alpha = W.alpha;
    }

    // schedule: [{start, end, chips}] — в каком интервале времени какой пакет крутится
    chipAt(t) {
      for (const s of this.schedule) {
        if (t >= s.start && t < s.end) {
          const k = Math.floor((t - s.start) / this.halfDur);
          return s.chips[k % s.chips.length];
        }
      }
      return 0;
    }

    // кадр f: вход L/R с позиции f*hop (длиной N), результат (с окном синтеза) — в outL/outR
    frame(L, R, start, t, outL, outR) {
      const N = this.N, re = this.re, im = this.im, w = this.win;
      for (let i = 0; i < N; i++) {
        const j = start + i, ok = j >= 0 && j < L.length;
        re[i] = ok ? L[j] * w[i] : 0; im[i] = ok && R ? R[j] * w[i] : 0;
      }
      const chip = this.chipAt(t);
      if (chip) {
        fft(re, im, false);
        const a = this.alpha * chip;
        for (let j = 0; j < this.gainIdx.length; j++) {
          const k = this.gainIdx[j], g = Math.exp(a * this.gainPat[j]);
          re[k] *= g; im[k] *= g; re[N - k] *= g; im[N - k] *= g;
        }
        fft(re, im, true);
        for (let i = 0; i < N; i++) { re[i] /= N; im[i] /= N; }
      }
      for (let i = 0; i < N; i++) { outL[i] = re[i] * w[i] * 0.5; outR[i] = im[i] * w[i] * 0.5; }
    }

    // офлайн: весь буфер (для «Download» и тестов). onProgress(0..1)
    async render(L, R, onProgress) {
      const N = this.N, hop = this.hop, n = L.length;
      const yL = new Float32Array(n), yR = new Float32Array(n);
      const fL = new Float64Array(N), fR = new Float64Array(N);
      const nFrames = Math.ceil((n + N) / hop);
      for (let f = 0; f < nFrames; f++) {
        const start = f * hop - N + hop;           // первый кадр захватывает начало буфера
        this.frame(L, R || L, start, (start + N / 2) / this.sr, fL, fR);
        for (let i = 0; i < N; i++) {
          const j = start + i;
          if (j >= 0 && j < n) { yL[j] += fL[i]; yR[j] += fR[i]; }
        }
        if (onProgress && f % 2000 === 0) { onProgress(f / nFrames); await new Promise((r) => setTimeout(r, 0)); }
      }
      return [yL, yR];
    }
  }

  const api = { fft, prbs, crc16bits, pattern, classInfo, convEncode, buildPacket, viterbi, decodeSoft, decodePacket, Embedder };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.WMCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
