#!/usr/bin/env node
// Встраивает текст в звук (водяной знак, пакет по кругу) — то же, что делает sender.html.
//   node tools/encode.js in.mp3 out.mp3 "Meet me at the old bridge at midnight." [--alpha 0.1]
const { spawnSync } = require('child_process');
const path = require('path');
const WEB = path.join(__dirname, '..', 'web');
const C = require(path.join(WEB, 'wmcore.js'));
const { TextCodec } = require(path.join(WEB, 'textcodec.js'));
const P = require(path.join(WEB, 'protocol.json')).watermark;

(async () => {
  const [inp, out, text] = process.argv.slice(2);
  const args = process.argv.slice(2);
  const alpha = args.includes('--alpha') ? +args[args.indexOf('--alpha') + 1] : P.alpha;
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', inp, '-f', 'f32le', '-ac', '2', '-ar', '48000', '-'], { maxBuffer: 1 << 30 });
  const pcm = new Float32Array(r.stdout.buffer, r.stdout.byteOffset, r.stdout.length / 4);
  const n = pcm.length / 2, L = new Float32Array(n), R = new Float32Array(n);
  for (let i = 0; i < n; i++) { L[i] = pcm[2 * i]; R[i] = pcm[2 * i + 1]; }
  const codec = new TextCodec(require(path.join(WEB, 'vocab.json')));
  const bits = codec.encode(text), pk = C.buildPacket(P, bits);
  const emb = new C.Embedder(P, 48000);
  emb.alpha = alpha;
  emb.schedule = [{ start: 0, end: Infinity, chips: pk.chips }];
  const [yL, yR] = await emb.render(L, R);
  const y = new Float32Array(2 * n);
  let peak = 0;
  for (let i = 0; i < n; i++) { y[2 * i] = yL[i]; y[2 * i + 1] = yR[i]; peak = Math.max(peak, Math.abs(yL[i]), Math.abs(yR[i])); }
  if (peak > 0.99) for (let i = 0; i < y.length; i++) y[i] *= 0.99 / peak;
  const codecArgs = out.endsWith('.wav') ? [] : ['-c:a', 'libmp3lame', '-b:a', '256k'];
  spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'f32le', '-ac', '2', '-ar', '48000', '-i', '-', ...codecArgs, out], { input: Buffer.from(y.buffer) });
  console.log(`${bits.length} бит текста → пакет K=${pk.K}, цикл ${pk.seconds.toFixed(1)} с → ${out}`);
})();
