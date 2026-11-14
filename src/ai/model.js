/* =====================================================================
 * Alev Laboratuvarı — Yapay zekâ: kokpit yangın modeli
 * ---------------------------------------------------------------------
 * cockpit_fire_model (LightGBM): bir malzeme parçasının verilen kabin
 * koşullarında tutuşup tutuşmayacağını, alevin sürüp sürmeyeceğini ve
 * tutuşursa yayılma hızını, tepe ısı salınımını, yanma süresini ve yanan
 * kesri öngörür. Model tarayıcıda çalışır (src/ai/forest.js).
 *
 *   FL.AI       model, özellik çıkarımı, tahmin
 *   FL.AIView   "Yapay zekâ" görünümü: parçaların risk boyaması ve öngörülen
 *               alev cephesi (ışın yürütücünün uniform'ları)
 *   FL.AIPanel  tahmin paneli: seçili hedef, olasılıklar, en riskli parçalar,
 *               öngörü ile benzetimin karşılaştırması
 * ===================================================================== */
import { FL } from '../core/fl.js';
import { parseForest, predict, clampInputs } from './forest.js';
import modelUrl from '../assets/ai/cockpit_fire_model.bin?url';

const fmt = (x, d) => FL.fmt(x, d);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

const OUTCOMES = [
  { id: 0, name: 'Tutuşmaz', color: '#3fb27f', desc: 'Tutuşturucu bu koşullarda parçayı tutuşturamıyor' },
  { id: 1, name: 'Tutuşur, kendiliğinden söner', color: '#e3b341', desc: 'Alev oluşur ama tutuşturucu çekilince sürmez' },
  { id: 2, name: 'Yanar ve yayılır', color: '#e5484d', desc: 'Alev kendi başına sürer ve yüzeyde ilerler' },
];
const FEATURE_TR = {
  flam_level: 'Yanıcılık sınıfı', o2_pct: 'O₂', pressure_kpa: 'Basınç', airflow_cm_s: 'Hava akışı', gravity_g: 'Yerçekimi',
  thickness_mm: 'Kalınlık', area_cm2: 'Alan', temp_c: 'Sıcaklık', ign_power_w: 'Tutuşturucu gücü', ign_time_s: 'Tutuşturma süresi',
};
const FEATURE_UNIT = {
  flam_level: '', o2_pct: '%', pressure_kpa: 'kPa', airflow_cm_s: 'cm/s', gravity_g: 'g', thickness_mm: 'mm', area_cm2: 'cm²', temp_c: '°C', ign_power_w: 'W', ign_time_s: 's',
};

/* Risk rengi: yeşil (düşük) → sarı → turuncu → kırmızı (yüksek); yanmaz parçalar arduvaz grisi */
const RAMP = [[0.0, [47, 158, 108]], [0.35, [150, 190, 70]], [0.55, [236, 196, 64]], [0.78, [240, 128, 56]], [1.0, [226, 54, 62]]];
const INERT_HEX = '#3a4350';
function riskHex(r) {
  r = clamp(r, 0, 1);
  let a = RAMP[0], b = RAMP[RAMP.length - 1];
  for (let i = 0; i < RAMP.length - 1; i++) if (r >= RAMP[i][0] && r <= RAMP[i + 1][0]) { a = RAMP[i]; b = RAMP[i + 1]; break; }
  const t = (r - a[0]) / Math.max(1e-6, b[0] - a[0]);
  const c = [0, 1, 2].map((k) => Math.round(a[1][k] + (b[1][k] - a[1][k]) * t));
  return '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
}
/** Tek bir sayı: tutuşma olasılığı ve tutuşursa sürme olasılığı */
const riskOf = (p) => 0.4 * p.pIgnite + 0.6 * p.pIgnite * p.pSustain;

function triArea(P, a, b, c) {
  const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
  const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
  return 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
}

const AI = {
  ready: false,
  error: null,
  F: null,
  OUTCOMES,

  load() {
    if (this._loading) return this._loading;
    this._loading = fetch(modelUrl)
      .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); })
      .then((buf) => { this.F = parseForest(buf); this.ready = true; this.version = (this.version || 0) + 1; return true; })
      .catch((e) => { this.error = e; console.error('Yapay zekâ modeli yüklenemedi', e); return false; });
    return this._loading;
  },

  /** Ortamdan gelen özellikler: O₂, basınç, hava akışı, yerçekimi, sıcaklık, tutuşturucu */
  env(st, fx) {
    let flow = Math.hypot(st.wind || 0, st.flow || 0);
    const comp = fx && fx.cabin;
    if (comp && !comp.isVacuum) flow = 100 * Math.hypot(comp.ventilation.x, comp.ventilation.y, comp.ventilation.z);
    return {
      o2_pct: st.o2, pressure_kpa: st.pressure, airflow_cm_s: flow, gravity_g: st.gravity, temp_c: st.Tamb - 273.15,
      ign_power_w: st.aiIgnPower ?? 100, ign_time_s: st.aiIgnTime ?? 20,
    };
  },
  envKey(st, fx) {
    const e = this.env(st, fx);
    return [e.o2_pct.toFixed(1), e.pressure_kpa.toFixed(1), e.airflow_cm_s.toFixed(1), e.gravity_g.toFixed(3), e.temp_c.toFixed(0), e.ign_power_w, e.ign_time_s].join('|');
  },

  /** Sahne parçasının geometrisinden: yüzey alanı [cm²] ve kalınlık [mm] (sınır kutusunun en ince boyutu) */
  partGeometry(p) {
    if (p._aiGeo) return p._aiGeo;
    let a = 0;
    const P = p.pos, I = p.idx;
    for (let t = 0; t < I.length; t += 3) a += triArea(P, I[t] * 3, I[t + 1] * 3, I[t + 2] * 3);
    const ext = [p.hi[0] - p.lo[0], p.hi[1] - p.lo[1], p.hi[2] - p.lo[2]];
    p._aiGeo = { area_cm2: a * 1e4, thickness_mm: Math.min(ext[0], ext[1], ext[2]) * 1000 };
    return p._aiGeo;
  },

  /** Deney düzeneği (mum, levha…) için temsilî yakıt özellikleri */
  sourceSubject(st) {
    const s = st.source;
    if (s === 'sheet') return { label: 'Katı levha (SIBAL kumaşı)', flam_level: 2, thickness_mm: 0.33, area_cm2: 2 * st.sheetW * st.sheetH };
    if (s === 'candle') return { label: 'Mum fitili ve parafin', flam_level: 3, thickness_mm: 2, area_cm2: 20 };
    if (s === 'droplet') return { label: 'Yakıt damlası', flam_level: 3, thickness_mm: st.dropletD, area_cm2: Math.max(20, Math.PI * (st.dropletD / 10) ** 2) };
    if (s === 'jet') return { label: 'Gaz jeti', flam_level: 3, thickness_mm: st.nozzleD, area_cm2: 20 };
    return { label: 'Genel yanıcı yüzey', flam_level: 2, thickness_mm: 1, area_cm2: 400 };
  },

  /** subject: { flam_level, thickness_mm, area_cm2 }. Döner: tahmin + kullanılan girdiler */
  predict(subject, st, fx) {
    if (!this.ready) return null;
    const e = this.env(st, fx);
    const raw = Object.assign({}, e, { flam_level: subject.flam_level, thickness_mm: subject.thickness_mm, area_cm2: subject.area_cm2 });
    const vec = this.F.meta.features.map((f) => raw[f]);
    const { x, clipped } = clampInputs(this.F, vec);
    const out = predict(this.F, x);
    out.inputs = raw;
    out.used = Object.fromEntries(this.F.meta.features.map((f, i) => [f, x[i]]));
    out.clipped = clipped;
    out.risk = riskOf(out);
    // Sınıf 0 (yanmaz) eğitim verisinde hiç sürmez: sürme sınıflandırıcısı yalnız tutuşan örnekleri gördü
    if (subject.flam_level <= 0) { out.pSustain = 0; out.pSpread = 0; out.outcome = Math.min(out.outcome, out.pIgnite >= 0.5 ? 1 : 0); out.risk = 0.4 * out.pIgnite; }
    return out;
  },

  predictPart(p, st, fx) {
    const g = this.partGeometry(p);
    return this.predict({ flam_level: p.level, thickness_mm: g.thickness_mm, area_cm2: g.area_cm2 }, st, fx);
  },
};

/* ------------------------------------------------------------------ */
/* Görünüm: risk boyaması ve öngörülen alev cephesi                      */
/* ------------------------------------------------------------------ */
const ISO_STEPS = [1, 2, 5, 10, 20, 30, 60, 120, 300, 600, 1200, 1800, 3600];
const AIView = {
  origins: [],          // { p, t0, partId, label, pred, area }
  _key: '',
  _org: new Float32Array(16),
  _par: new Float32Array(16),
  table: null,          // parça kimliği → tahmin

  painted(ms) { return !!ms && ms.mode === 'ai'; },

  /** Parça tahminlerini (gerekirse) yeniler ve parçaları risk rengine boyar */
  paint(ms, st, fx) {
    if (!AI.ready || !ms || !ms.ready) return false;
    const key = ms.version + '|' + (ms.def ? ms.def.id : '') + '|' + ms.parts.length + '|' + AI.envKey(st, fx);
    if (key !== this._key || !this.table) {
      this._key = key;
      this.table = new Map();
      for (const p of ms.parts) {
        const pr = AI.predictPart(p, st, fx);
        this.table.set(p.id, pr);
        p.aiHex = p.glass ? '#26303c' : p.level <= 0 ? INERT_HEX : riskHex(pr.risk);
      }
      this.tableVersion = (this.tableVersion || 0) + 1;
      // Tutuşma noktalarının öngörüleri de ortamla birlikte yenilenir
      for (const o of this.origins) { const p = ms.parts[o.partId]; if (p) o.pred = this.table.get(p.id) || o.pred; }
      ms.mode = 'ai';
      ms._paintParts();
    } else if (ms.mode !== 'ai') {
      ms.mode = 'ai';
      ms._paintParts();
    }
    this._threats(ms, fx);
    return true;
  },

  /**
   * "Sıradaki" parçalar: yanan bir parçanın hemen yanında duran ve modelin bu atmosferde
   * tutuşup alevi sürdüreceğini öngördüğü parçalar. Saniyede iki kez yenilenir.
   */
  _threats(ms, fx) {
    const burning = fx && fx.scene === ms ? fx.core.burningCount : 0;
    const tick = burning > 0 ? Math.floor(fx.time * 2) : -1;
    if (tick === this._threatTick) return;
    this._threatTick = tick;
    const next = [];
    if (burning > 0) {
      const core = fx.core;
      const hot = new Set();
      for (let b = 0; b < burning; b++) hot.add(core.body[core.burningList[b]]);
      const src = [...hot].map((i) => fx.bodies[i]).filter(Boolean);
      for (const body of fx.bodies) {
        if (hot.has(body.index) || body.destroyed || body.compartment !== fx.cabin) continue;
        const pr = this.table.get(body.part.id);
        if (!pr || body.part.level <= 0 || pr.outcome < 2) continue;
        // Yanmış bitmiş parça yeniden tutuşmaz
        if (body.everBurned && core.fuel[body.cellStart + (body.cellCount >> 1)] <= 0) continue;
        let near = Infinity;
        for (const s of src) {
          const d = Math.hypot(s.center[0] - body.center[0], s.center[1] - body.center[1], s.center[2] - body.center[2]) - s.radius - body.radius;
          if (d < near) near = d;
        }
        if (near < 0.3) next.push({ id: body.part.id, label: body.part.label, d: Math.max(0, near), pred: pr });
      }
      next.sort((a, b) => a.d - b.d || b.pred.risk - a.pred.risk);
    }
    const ids = new Set(next.slice(0, 12).map((n) => n.id));
    let changed = false;
    for (const p of ms.parts) {
      const v = ids.has(p.id);
      if (!!p.aiNext !== v) { p.aiNext = v; changed = true; }
    }
    this.next = next.slice(0, 12);
    if (changed) { ms._paintParts(); this.nextVersion = (this.nextVersion || 0) + 1; }
  },

  invalidate() { this._key = ''; },

  /** Tutuşma noktası ekle (kıvılcım, kısa devre ya da kendiliğinden tutuşma) */
  addOrigin(p, part, fxTime, st, fx) {
    if (!AI.ready || !p) return;
    let pred, area, label, partId = -1;
    if (part) {
      pred = AI.predictPart(part, st, fx);
      area = AI.partGeometry(part).area_cm2 / 1e4;
      label = part.label;
      partId = part.id;
    } else {
      const s = AI.sourceSubject(st);
      pred = AI.predict(s, st, fx);
      area = s.area_cm2 / 1e4;
      label = s.label;
    }
    // Aynı noktaya üst üste tıklama tek kayıt
    for (const o of this.origins) if (Math.hypot(o.p[0] - p[0], o.p[1] - p[1], o.p[2] - p[2]) < 0.03 && fxTime - o.t0 < 2) return;
    this.origins.push({ p: p.slice(0, 3), t0: fxTime, partId, label, pred, area });
    if (this.origins.length > 4) this.origins.shift();
  },

  clear() { this.origins.length = 0; },

  /** Bir tutuşma noktasının öngörülen cephesi [m]: şimdi (ileri sarma dahil) ve son sınır */
  front(o, now, lead) {
    const pr = o.pred;
    if (!pr || pr.outcome === 0) return { r: 0, rFinal: 0, rate: 0, age: 0 };
    const rate = pr.spreadRate / 1000;
    // Yanan kesir × parça alanı kadar bir daire: öngörülen son yanık
    let rFinal = Math.sqrt((pr.burnedFrac * o.area) / Math.PI);
    if (pr.outcome === 1) rFinal = Math.min(rFinal, rate * Math.min(pr.burnDuration, 15));
    const age = Math.max(0, now + lead - o.t0 - pr.tIgnition);
    return { r: Math.min(rFinal, rate * Math.min(age, pr.burnDuration)), rFinal, rate, age };
  },

  /** Işın yürütücünün uniform'ları */
  uniforms(st, fx, cam, rh) {
    const org = this._org, par = this._par;
    org.fill(-1); par.fill(0);
    const now = fx ? fx.time : 0;
    const lead = st.aiLead || 0;
    let iso = 0;
    this.origins.forEach((o, i) => {
      if (i > 3) return;
      const f = this.front(o, now, lead);
      org[i * 4] = o.p[0]; org[i * 4 + 1] = o.p[1]; org[i * 4 + 2] = o.p[2]; org[i * 4 + 3] = f.r;
      // Eş-zaman çizgileri: cephe ile son sınır arasında ~5 çizgi düşecek "yuvarlak" bir süre
      let step = 0, dt = 0;
      if (f.rate > 1e-6 && f.rFinal - f.r > 1e-4) {
        const want = (f.rFinal - f.r) / 5 / f.rate;
        dt = ISO_STEPS.find((s) => s >= want) || ISO_STEPS[ISO_STEPS.length - 1];
        step = f.rate * dt;
      }
      par[i * 4] = f.rFinal; par[i * 4 + 1] = step; par[i * 4 + 2] = 8; par[i * 4 + 3] = 0;
      if (i === this.origins.length - 1) iso = dt;
    });
    this.isoSeconds = iso;
    par[3] = now;   // yanıp sönme için zaman (ilk kaydın boş bileşeni)
    const proj5 = cam && cam.proj ? cam.proj[5] : 2.9;
    return { org, par, px: 2 / (Math.max(proj5, 1e-3) * Math.max(rh, 1)) };
  },
};

/* ------------------------------------------------------------------ */
/* Panel                                                                */
/* ------------------------------------------------------------------ */
const bar = (v, color) => '<span class="ai-bar"><b style="width:' + (clamp(v, 0, 1) * 100).toFixed(1) + '%;background:' + color + '"></b></span>';
const pct = (v) => '%' + fmt(v * 100, v > 0.995 || v < 0.005 ? 3 : 2);
function dur(s) {
  if (!(s >= 0)) return '—';
  if (s < 90) return fmt(s, 2) + ' s';
  if (s < 5400) return fmt(s / 60, 2) + ' dk';
  return fmt(s / 3600, 2) + ' sa';
}
function power(w) { return w >= 1000 ? fmt(w / 1000, 3) + ' kW' : fmt(w, 3) + ' W'; }

class AIPanel {
  constructor(root, opts) {
    this.root = root;
    this.o = opts || {};
    this.sel = -1;            // seçili parça (−1: otomatik = en riskli / tutuşma noktası)
    this._key = '';
    root.addEventListener('click', (e) => this._click(e));
    root.addEventListener('input', (e) => this._input(e));
  }

  select(id) { this.sel = id; this._key = ''; }

  _click(e) {
    const b = e.target.closest('[data-ai]');
    if (!b) return;
    const act = b.dataset.ai;
    if (act === 'close') this.o.onClose && this.o.onClose();
    else if (act === 'pick') { this.sel = Number(b.dataset.id); this._key = ''; this.o.onSelect && this.o.onSelect(this.sel); }
    else if (act === 'auto') { this.sel = -1; this._key = ''; this.o.onSelect && this.o.onSelect(-1); }
    else if (act === 'ignite') this.o.onIgnite && this.o.onIgnite(Number(b.dataset.id));
    else if (act === 'lead0') this.o.onControl && this.o.onControl('aiLead', 0);
  }

  _input(e) {
    const el = e.target.closest('input[data-key]');
    if (!el) return;
    this.o.onControl && this.o.onControl(el.dataset.key, Number(el.value));
    const out = this.root.querySelector('[data-out="' + el.dataset.key + '"]');
    if (out) out.textContent = el.dataset.key === 'aiLead' ? '+' + dur(Number(el.value)) : fmt(Number(el.value), 3) + ' ' + (el.dataset.unit || '');
  }

  /** scene: model sahnesi (yoksa null), fx: yangın sistemi */
  update(scene, st, fx) {
    const root = this.root;
    if (!AI.ready) {
      const k = 'load|' + (AI.error ? 1 : 0);
      if (k === this._key) return;
      this._key = k;
      root.innerHTML = this._head('Yapay zekâ tahmini', AI.error ? 'Model yüklenemedi' : 'Model yükleniyor…') +
        '<p class="flam-empty">' + (AI.error ? esc(String(AI.error.message || AI.error)) : 'cockpit_fire_model · 7 × 400 ağaç') + '</p>';
      FL.hydrateIcons(root);
      return;
    }
    const hasScene = !!(scene && scene.ready && scene.parts && scene.parts.length);
    const s = fx ? fx.stats : null;
    const live = s ? [s.burningCells > 0 ? 1 : 0, Math.round(s.heatKW * 10), Math.round((s.burnedFraction || 0) * 1000)].join(',') : '';
    const key = [hasScene ? scene.def.id + scene.parts.length : st.source, AI.envKey(st, fx), this.sel, AIView.tableVersion || 0, AIView.origins.length,
      AIView.origins.length ? Math.round((fx ? fx.time : 0) * 2) : 0, st.aiLead || 0, live, AIView.nextVersion || 0].join('|');
    if (key === this._key) return;
    // Kaydırıcı sürüklenirken panel yeniden kurulmaz (odak ve tutuş kaybolmasın)
    if (root.contains(document.activeElement) && document.activeElement.matches('input[type=range]') && this._built) { this._live(st, fx); return; }
    this._key = key;
    this._built = true;

    // Hedef: seçili parça → son tutuşma noktası → en riskli parça → deney düzeneği
    let subject, pred, targetId = -1, auto = '';
    let ranked = [];
    if (hasScene) {
      if (!AIView.table || !AIView.painted(scene)) AIView.paint(scene, st, fx);
      ranked = this._rank(scene);
      const lastO = AIView.origins[AIView.origins.length - 1];
      if (this.sel >= 0 && scene.parts[this.sel]) targetId = this.sel;
      else if (lastO && lastO.partId >= 0) { targetId = lastO.partId; auto = 'tutuşma noktası'; }
      else if (ranked.length) { targetId = ranked[0].ids[0]; auto = 'en riskli parça'; }
      const p = scene.parts[targetId];
      if (p) {
        pred = AIView.table.get(p.id) || AI.predictPart(p, st, fx);
        subject = { label: p.label, sub: p.info && p.info.text ? p.info.text : '', level: p.level };
      }
    }
    if (!pred) {
      const src = AI.sourceSubject(st);
      pred = AI.predict(src, st, fx);
      subject = { label: src.label, sub: 'Deney düzeneği', level: src.flam_level };
    }
    const oc = OUTCOMES[pred.outcome];
    let html = this._head('Yapay zekâ tahmini', 'cockpit_fire_model · LightGBM');
    html += '<div class="ai-target"><div class="ai-target-n">' + esc(subject.label) + (auto ? ' <em>' + auto + '</em>' : '') + '</div>' +
      '<div class="ai-target-m">' + esc(subject.sub || '') + (subject.sub ? ' · ' : '') + 'sınıf ' + subject.level +
      (this.sel >= 0 ? ' · <button type="button" class="ai-link" data-ai="auto">otomatik hedef</button>' : '') + '</div></div>';
    html += '<div class="ai-verdict" style="--c:' + oc.color + '"><i></i><div><b>' + oc.name + '</b><span>' + oc.desc + '</span></div></div>';
    html += '<div class="ai-probs">' +
      '<div class="ai-prob"><span>Tutuşma olasılığı</span>' + bar(pred.pIgnite, '#f0803a') + '<code>' + pct(pred.pIgnite) + '</code></div>' +
      '<div class="ai-prob"><span>Alevin sürmesi</span>' + bar(pred.pSustain, '#e5484d') + '<code>' + pct(pred.pSustain) + '</code></div></div>';
    const dim = pred.outcome === 0 ? ' ai-dim' : '';
    html += '<dl class="ai-grid' + dim + '">' +
      '<div><dt>Tutuşma süresi</dt><dd>' + dur(pred.tIgnition) + '</dd></div>' +
      '<div><dt>Yayılma hızı</dt><dd>' + fmt(pred.spreadRate, 3) + ' mm/s</dd></div>' +
      '<div><dt>Tepe ısı salınımı</dt><dd>' + power(pred.peakHrr) + '</dd></div>' +
      '<div><dt>Yanma süresi</dt><dd>' + dur(pred.burnDuration) + '</dd></div>' +
      '<div><dt>Yanan kesir</dt><dd>' + pct(pred.burnedFrac) + '</dd></div>' +
      '<div><dt>Risk puanı</dt><dd>' + fmt(pred.risk * 100, 3) + ' / 100</dd></div></dl>';
    if (pred.outcome === 0) html += '<p class="ai-note">Değerler “tutuşursa” koşuluyla okunmalıdır: regresörler yalnız tutuşan örneklerle eğitildi.</p>';

    // Tutuşturucu (modelin iki girdisi) ve öngörüyü ileri sarma
    html += '<div class="ai-ctl"><label><span>Tutuşturucu gücü</span><input type="range" min="5" max="500" step="5" value="' + (st.aiIgnPower ?? 100) + '" data-key="aiIgnPower" data-unit="W"><code data-out="aiIgnPower">' + fmt(st.aiIgnPower ?? 100, 3) + ' W</code></label>' +
      '<label><span>Tutuşturma süresi</span><input type="range" min="1" max="60" step="1" value="' + (st.aiIgnTime ?? 20) + '" data-key="aiIgnTime" data-unit="s"><code data-out="aiIgnTime">' + fmt(st.aiIgnTime ?? 20, 3) + ' s</code></label></div>';

    // Girdiler: modelin gördüğü on özellik; eğitim aralığının dışına çıkanlar işaretlenir
    html += '<details class="ai-inputs"><summary>Modelin girdileri' + (pred.clipped.length ? ' <em>' + pred.clipped.length + ' değer eğitim aralığına kırpıldı</em>' : '') + '</summary><dl>';
    for (const f of AI.F.meta.features) {
      const cl = pred.clipped.includes(f);
      html += '<div' + (cl ? ' class="clip"' : '') + '><dt>' + FEATURE_TR[f] + '</dt><dd>' + fmt(pred.used[f], 3) + ' ' + FEATURE_UNIT[f] +
        (cl ? ' <s>' + fmt(pred.inputs[f], 3) + '</s>' : '') + '</dd></div>';
    }
    html += '</dl></details>';

    // Öngörülen cephe ve benzetimle karşılaştırma
    const lastO = AIView.origins[AIView.origins.length - 1];
    if (lastO && fx) {
      const f = AIView.front(lastO, fx.time, st.aiLead || 0);
      const lead = st.aiLead || 0;
      html += '<div class="ai-cmp"><div class="ai-cmp-t">Öngörü ↔ benzetim <em>' + esc(lastO.label) + '</em></div>' +
        '<dl class="ai-grid"><div><dt>Öngörülen cephe</dt><dd data-live="front">' + fmt(f.r * 100, 3) + ' cm</dd></div>' +
        '<div><dt>Son yayılma sınırı</dt><dd>' + fmt(f.rFinal * 100, 3) + ' cm</dd></div>' +
        '<div><dt>Benzetim: yangın gücü</dt><dd data-live="kw">' + power((s ? s.heatKW : 0) * 1000) + '</dd></div>' +
        '<div><dt>Öngörü: tepe güç</dt><dd>' + power(lastO.pred.peakHrr) + '</dd></div></dl>' +
        '<label class="ai-lead"><span>Öngörüyü ileri sar</span><input type="range" min="0" max="900" step="5" value="' + lead + '" data-key="aiLead"><code data-out="aiLead">+' + dur(lead) + '</code></label>' +
        '<p class="ai-note">Macenta: modelin öngördüğü cephe ve yanmış bölge' + (AIView.isoSeconds ? ' (çizgiler ' + dur(AIView.isoSeconds) + ' arayla)' : '') + '. Beyaz kesikli: son yayılma sınırı. Camgöbeği: benzetimde gerçekleşen alev. Model fiziksel hızı öngörür; benzetimdeki yüzey yangını izlenebilsin diye hızlandırılmıştır.</p></div>';
    } else if (hasScene) {
      html += '<p class="ai-note">Bir parçaya tıklayın: yapay zekâ o parça için tahmin yapar. <b>Tutuştur</b> ile kıvılcım çakın; öngörülen alev cephesi (macenta) ile benzetimdeki alev (camgöbeği) birlikte görünür.</p>';
    }

    // Sıradaki parçalar: yangının yanında, tutuşması öngörülenler
    if (hasScene && AIView.next && AIView.next.length) {
      const seen = new Set();
      const names = AIView.next.filter((n) => !seen.has(n.label) && seen.add(n.label)).slice(0, 5);
      html += '<div class="ai-list-t ai-next-t">Sırada: alevin sıçraması öngörülen parçalar</div><div class="ai-next">' +
        names.map((n) => '<button type="button" data-ai="pick" data-id="' + n.id + '"><i></i>' + esc(n.label) + ' <em>' + fmt(n.d * 100, 2) + ' cm · ' + dur(n.pred.tIgnition) + '</em></button>').join('') + '</div>';
    }

    // En riskli parçalar
    if (ranked.length) {
      html += '<div class="ai-list-t">En riskli parçalar</div><div class="ai-list">';
      for (const g of ranked.slice(0, 6)) {
        const on = g.ids.includes(targetId);
        html += '<div class="ai-row' + (on ? ' on' : '') + '"><button type="button" class="ai-row-b" data-ai="pick" data-id="' + g.ids[0] + '">' +
          '<i style="background:' + riskHex(g.pred.risk) + '"></i><span class="ai-row-n">' + esc(g.label) + (g.ids.length > 1 ? ' <em>×' + g.ids.length + '</em>' : '') + '</span>' +
          '<span class="ai-row-m">' + OUTCOMES[g.pred.outcome].name + ' · ' + fmt(g.pred.spreadRate, 2) + ' mm/s</span>' +
          '<code>' + fmt(g.pred.risk * 100, 2) + '</code></button>' +
          '<button type="button" class="ai-go" data-ai="ignite" data-id="' + g.ids[0] + '" data-tip="Bu parçada kıvılcım çak">Tutuştur</button></div>';
      }
      html += '</div>';
    }
    html += '<p class="flam-note">Model eğitim ve tehlike farkındalığı içindir; sertifikalı yanıcılık testlerinin (NASA-STD-6001B) yerine geçmez.</p>';
    root.innerHTML = html;
    FL.hydrateIcons(root);
  }

  /** Kaydırıcı tutulurken yalnız canlı sayılar güncellenir */
  _live(st, fx) {
    const lastO = AIView.origins[AIView.origins.length - 1];
    if (!lastO || !fx) return;
    const f = AIView.front(lastO, fx.time, st.aiLead || 0);
    const a = this.root.querySelector('[data-live="front"]');
    if (a) a.textContent = fmt(f.r * 100, 3) + ' cm';
    const b = this.root.querySelector('[data-live="kw"]');
    if (b) b.textContent = power(fx.stats.heatKW * 1000);
  }

  /** Aynı ad + sınıf birlikte: en riskliden aza */
  _rank(scene) {
    const map = new Map();
    for (const p of scene.parts) {
      if (p.glass || p.level <= 0 || p.destroyed) continue;
      const pr = AIView.table && AIView.table.get(p.id);
      if (!pr) continue;
      const k = p.group + '|' + p.level;
      let g = map.get(k);
      if (!g) map.set(k, (g = { label: p.label, ids: [], pred: pr }));
      g.ids.push(p.id);
      if (pr.risk > g.pred.risk) { g.pred = pr; g.ids.unshift(g.ids.pop()); }
    }
    return [...map.values()].sort((a, b) => b.pred.risk - a.pred.risk || b.pred.spreadRate - a.pred.spreadRate);
  }

  _head(title, sub) {
    return '<div class="flam-head"><div><div class="flam-title">' + title + '</div><div class="flam-sub">' + sub + '</div></div>' +
      '<button type="button" class="ct-btn ct-sm" data-ai="close" data-icon="close" aria-label="Yapay zekâ görünümünü kapat"></button></div>';
  }
}

/** İmleç altındaki parçanın kısa tahmini (ipucu) */
function aiTipHTML(p, st, fx) {
  const pr = (AIView.table && AIView.table.get(p.id)) || AI.predictPart(p, st, fx);
  if (!pr) return '';
  const oc = OUTCOMES[pr.outcome];
  return '<div class="ft-n">' + esc(p.label) + '</div><div class="ft-m">' + esc(p.info && p.info.text ? p.info.text : '') + '</div>' +
    '<div class="ft-r"><i style="background:' + (p.level <= 0 ? INERT_HEX : riskHex(pr.risk)) + '"></i>' + oc.name + '</div>' +
    '<div class="ft-r">Tutuşma ' + pct(pr.pIgnite) + ' · sürme ' + pct(pr.pSustain) + '</div>' +
    (pr.outcome > 0 ? '<div class="ft-r">' + fmt(pr.spreadRate, 3) + ' mm/s · tepe ' + power(pr.peakHrr) + '</div>' : '');
}

FL.AI = AI;
FL.AIView = AIView;
FL.AIPanel = AIPanel;
FL.aiTipHTML = aiTipHTML;
FL.aiRiskHex = riskHex;
