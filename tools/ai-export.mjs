/* cockpit_fire_model.joblib (LightGBM) → tarayıcıda çalışan ikili model dosyası.
 *
 *   node tools/ai-export.mjs
 *
 * Joblib dosyası bir sözlüktür: clf_ignite, clf_sustain (LGBMClassifier) ve regs
 * (t_ignition_s, spread_rate_mm_s, peak_hrr_w, burn_duration_s, burned_frac: LGBMRegressor).
 * Her LightGBM modeli dosyada düz metin olarak durur ("tree\nversion=v4 … end of trees");
 * turşu (pickle) çözülmez, yalnız bu metinler ayrıştırılır. Çıktı:
 *
 *   u32 'FLAI' · u32 json uzunluğu · json (8'e hizalı) · f64 eşikler · f32 yaprak değerleri ·
 *   i16 sol çocuk · i16 sağ çocuk · u8 bölme özelliği
 */
import { readFileSync, writeFileSync } from 'node:fs';

const SRC = new URL('./models-src/cockpit_fire_model.joblib', import.meta.url);
const OUT = new URL('../src/assets/ai/cockpit_fire_model.bin', import.meta.url);
const NAMES = ['clf_ignite', 'clf_sustain', 't_ignition_s', 'spread_rate_mm_s', 'peak_hrr_w', 'burn_duration_s', 'burned_frac'];
const LOG_TARGETS = ['burn_duration_s', 'peak_hrr_w', 'spread_rate_mm_s', 't_ignition_s'];

const raw = readFileSync(SRC).toString('latin1');
const texts = [];
for (let at = raw.indexOf('tree\nversion=v4'); at >= 0; at = raw.indexOf('tree\nversion=v4', at + 1)) {
  texts.push(raw.slice(at, raw.indexOf('end of trees', at)));
}
if (texts.length !== NAMES.length) throw new Error('beklenen 7 model, bulunan ' + texts.length);

const thr = [], leaf = [], left = [], right = [], feat = [];
const models = [];
let features = null;
texts.forEach((txt, mi) => {
  const head = txt.slice(0, txt.indexOf('Tree=0'));
  const get = (k) => new RegExp('^' + k + '=(.*)$', 'm').exec(head)[1];
  const f = get('feature_names').split(' ');
  if (!features) features = f; else if (f.join() !== features.join()) throw new Error('özellik adları uyuşmuyor');
  const objective = get('objective').split(' ')[0];
  const ranges = get('feature_infos').split(' ').map((s) => s.slice(1, -1).split(':').map(Number));
  const trees = [];
  for (const block of txt.split(/\nTree=\d+\n/).slice(1)) {
    const kv = Object.fromEntries(block.split('\n').filter((l) => l.includes('=')).map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)]; }));
    const nl = Number(kv.num_leaves);
    if (Number(kv.num_cat) !== 0 || Number(kv.is_linear) !== 0) throw new Error('kategorik / doğrusal ağaç desteklenmiyor');
    const nums = (k) => (kv[k] ? kv[k].trim().split(' ').map(Number) : []);
    if (nums('decision_type').some((d) => d !== 2)) throw new Error('beklenmeyen decision_type');
    const lv = nums('leaf_value');
    if (lv.length !== nl) throw new Error('yaprak sayısı uyuşmuyor');
    trees.push(nl);
    thr.push(...nums('threshold'));
    feat.push(...nums('split_feature'));
    left.push(...nums('left_child'));
    right.push(...nums('right_child'));
    leaf.push(...lv);
  }
  models.push({ name: NAMES[mi], objective, log: LOG_TARGETS.includes(NAMES[mi]), trees, ranges });
});

const meta = {
  version: 1,
  source: 'cockpit_fire_model.joblib (LightGBM v4, 7 × 400 ağaç)',
  features,
  units: { flam_level: '0-3', o2_pct: '% O2', pressure_kpa: 'kPa', airflow_cm_s: 'cm/s', gravity_g: 'g', thickness_mm: 'mm', area_cm2: 'cm^2', temp_c: 'deg C', ign_power_w: 'W', ign_time_s: 's' },
  inputs: { flam_level: [0, 3], o2_pct: [16, 40], pressure_kpa: [50, 105], airflow_cm_s: [0, 40], gravity_g: [0, 1], thickness_mm: [0.1, 10], area_cm2: [20, 5000], temp_c: [15, 45], ign_power_w: [5, 500], ign_time_s: [1, 60] },
  defaults: { o2_pct: 21, pressure_kpa: 101.3, airflow_cm_s: 10, gravity_g: 0, thickness_mm: 1, area_cm2: 400, temp_c: 22, ign_power_w: 100, ign_time_s: 20 },
  outcomes: ['no ignition', 'self-extinguishes', 'burns and spreads'],
  models,
  counts: { nodes: thr.length, leaves: leaf.length },
};
let json = Buffer.from(JSON.stringify(meta), 'utf8');
const pad = (8 - ((8 + json.length) % 8)) % 8;
json = Buffer.concat([json, Buffer.alloc(pad, 0x20)]);
const headBuf = Buffer.alloc(8);
headBuf.write('FLAI', 0, 'latin1');
headBuf.writeUInt32LE(json.length, 4);
const buf = (T, a) => Buffer.from(new T(a).buffer);
const out = Buffer.concat([headBuf, json, buf(Float64Array, thr), buf(Float32Array, leaf), buf(Int16Array, left), buf(Int16Array, right), buf(Uint8Array, feat)]);
writeFileSync(OUT, out);
console.log('yazıldı:', OUT.pathname, (out.length / 1024).toFixed(0) + ' kB', '· düğüm', thr.length, '· yaprak', leaf.length);
