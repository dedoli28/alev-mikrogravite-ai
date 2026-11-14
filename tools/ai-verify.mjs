/* Aktarılan modelin çıktısını döker (LightGBM ile karşılaştırma ve hızlı akıl sağlığı denetimi).
 *   node tools/ai-verify.mjs [satır sayısı] > tahminler.json */
import { readFileSync } from 'node:fs';
import { parseForest, rawScore, predict } from '../src/ai/forest.js';

const buf = readFileSync(new URL('../src/assets/ai/cockpit_fire_model.bin', import.meta.url));
const F = parseForest(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
let seed = 12345;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const n = Number(process.argv[2]) || 300;
const rows = [];
for (let i = 0; i < n; i++) {
  const x = F.meta.features.map((f) => { const [lo, hi] = F.meta.inputs[f]; const v = lo + (hi - lo) * rnd(); return f === 'flam_level' ? Math.round(v) : +v.toFixed(3); });
  const raw = {};
  for (const m of F.meta.models) raw[m.name] = rawScore(F, F.models[m.name], x);
  rows.push({ x, raw, pred: predict(F, x) });
}
console.log(JSON.stringify({ features: F.meta.features, rows }));
