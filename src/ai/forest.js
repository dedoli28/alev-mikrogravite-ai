/* =====================================================================
 * Alev Laboratuvarı — Yapay zekâ: LightGBM ormanı (tarayıcıda çıkarım)
 * ---------------------------------------------------------------------
 * cockpit_fire_model.joblib içindeki yedi LightGBM modeli (2 sınıflandırıcı,
 * 5 regresör; her biri 400 ağaç) tools/ai-export.mjs ile ikili dosyaya
 * aktarılır. Burada yalnız ağaçlar gezilir: bağımlılık yok, DOM yok;
 * Node'da da çalışır (tools/ai-verify.mjs).
 *
 * Özellikler (sırayla): flam_level, o2_pct, pressure_kpa, airflow_cm_s,
 * gravity_g, thickness_mm, area_cm2, temp_c, ign_power_w, ign_time_s
 * ===================================================================== */

export function parseForest(arrayBuffer) {
  const dv = new DataView(arrayBuffer);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== 'FLAI') throw new Error('Yapay zekâ modeli tanınmadı');
  const jsonLen = dv.getUint32(4, true);
  const meta = JSON.parse(new TextDecoder().decode(new Uint8Array(arrayBuffer, 8, jsonLen)));
  let at = 8 + jsonLen;
  const nN = meta.counts.nodes, nL = meta.counts.leaves;
  // Dilimler kopyalanır: hizalama güvencesi (veri adresi / tek dosyalık derleme)
  const take = (T, n) => { const a = new T(arrayBuffer.slice(at, at + n * T.BYTES_PER_ELEMENT)); at += n * T.BYTES_PER_ELEMENT; return a; };
  const thr = take(Float64Array, nN);
  const leaf = take(Float32Array, nL);
  const left = take(Int16Array, nN);
  const right = take(Int16Array, nN);
  const feat = take(Uint8Array, nN);
  let n0 = 0, l0 = 0;
  const models = {};
  for (const m of meta.models) {
    const nodeAt = new Uint32Array(m.trees.length), leafAt = new Uint32Array(m.trees.length);
    for (let t = 0; t < m.trees.length; t++) {
      nodeAt[t] = n0; leafAt[t] = l0;
      n0 += m.trees[t] - 1; l0 += m.trees[t];
    }
    models[m.name] = { name: m.name, objective: m.objective, log: m.log, leaves: Uint16Array.from(m.trees), nodeAt, leafAt, ranges: m.ranges };
  }
  return { meta, models, thr, leaf, left, right, feat };
}

/** Bir modelin ham çıktısı (yaprak değerlerinin toplamı) */
export function rawScore(F, model, x) {
  const { thr, leaf, left, right, feat } = F;
  let sum = 0;
  for (let t = 0, nt = model.leaves.length; t < nt; t++) {
    const l0 = model.leafAt[t];
    if (model.leaves[t] === 1) { sum += leaf[l0]; continue; }
    const n0 = model.nodeAt[t];
    let node = 0;
    while (node >= 0) {
      const k = n0 + node;
      node = x[feat[k]] <= thr[k] ? left[k] : right[k];
    }
    sum += leaf[l0 + ~node];
  }
  return sum;
}

const sigmoid = (v) => 1 / (1 + Math.exp(-v));

/**
 * x: on özellik (meta.features sırası). Döner: olasılıklar ve fiziksel birimde tahminler.
 * Regresörler yalnız tutuşan örneklerle eğitilmiştir: tutuşma olasılığı düşükken
 * değerleri "tutuşursa" koşuluyla okunmalıdır.
 */
export function predict(F, x) {
  const M = F.models;
  const reg = (name) => {
    const m = M[name];
    const v = rawScore(F, m, x);
    return m.log ? Math.max(0, Math.expm1(v)) : v;
  };
  const pIgnite = sigmoid(rawScore(F, M.clf_ignite, x));
  const pSustain = sigmoid(rawScore(F, M.clf_sustain, x));
  const outcome = pIgnite < 0.5 ? 0 : pSustain < 0.5 ? 1 : 2;
  return {
    pIgnite, pSustain, pSpread: pIgnite * pSustain, outcome,
    tIgnition: reg('t_ignition_s'),
    spreadRate: reg('spread_rate_mm_s'),
    peakHrr: reg('peak_hrr_w'),
    burnDuration: reg('burn_duration_s'),
    burnedFrac: Math.min(1, Math.max(0, reg('burned_frac'))),
  };
}

/** Girdiyi eğitim aralığına kırpar; aralık dışına çıkan özelliklerin adlarını döndürür */
export function clampInputs(F, x) {
  const out = new Float64Array(x.length);
  const clipped = [];
  F.meta.features.forEach((name, i) => {
    const [lo, hi] = F.meta.inputs[name];
    out[i] = Math.min(hi, Math.max(lo, x[i]));
    if (Math.abs(out[i] - x[i]) > 1e-9) clipped.push(name);
  });
  return { x: out, clipped };
}
