/* =====================================================================
 * Alev Laboratuvarı — Uygulama: başlatma, döngü, etkileşim
 * ===================================================================== */
import { FL } from '../core/fl.js';

const $ = (id) => document.getElementById(id);
const fmt = (x, d) => FL.fmt(x, d);
const same = (a, b) => (typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b)) : a === b);

const app = {
  state: null,
  preset: null,
  defaults: null,
  paused: false,
  stepOnce: false,
  lastT: 0,
  fps: 60,
  simRate: 1,
  autoIgnPending: false,
  lastEventId: 0,
  wantShot: false,
  lost: false,
  started: false,
  adapt: { acc: 0, n: 0, lastDown: 0, hinted: false },
  fx: null,
  fxEventId: 0,
  simAcc: 0,
  due: { hud: 0, chart: 0, theory: 0 },
};
FL.app = app;

function storageGet(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
function storageSet(k, v) { try { window.localStorage.setItem(k, v); } catch (e) { /* depolama kapalı */ } }

/* ------------------------------------------------------------------ */
/* Bildirimler                                                          */
/* ------------------------------------------------------------------ */
let toastTimer = 0;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  t.classList.add('out');
  requestAnimationFrame(() => t.classList.remove('out'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.classList.add('out');
    setTimeout(() => { if (t.classList.contains('out')) t.hidden = true; }, 240);
  }, 2400);
}
function announce(msg) { $('live').textContent = msg; }

function showFatal(title, text, detail, reload) {
  $('fatalTitle').textContent = title;
  if (text) $('fatalText').textContent = text;
  $('fatalDetail').textContent = detail || '';
  $('fatal').hidden = false;
  $('loading').classList.add('done');
  $('fatalReload').onclick = reload || (() => location.reload());
  $('statusTxt').textContent = 'Hata';
}

/* ------------------------------------------------------------------ */
/* URL durumu: paylaşım bağlantısı ve yeniden yüklemede deneyi koruma   */
/* ------------------------------------------------------------------ */
function encodeState() {
  const st = app.state, d = app.defaults;
  const parts = ['p=' + app.preset.id];
  for (const k in st) {
    if (k === 'preset' || !(k in FL.DEFAULTS)) continue;
    if (same(st[k], d[k])) continue;
    const v = st[k];
    parts.push(k + '=' + encodeURIComponent(typeof v === 'boolean' ? (v ? '1' : '0') : typeof v === 'number' ? String(Number(v.toPrecision(6))) : v));
  }
  return '#' + parts.join('&');
}
function decodeHash(hash) {
  const h = (hash || '').replace(/^#/, '');
  if (!h) return null;
  if (!h.includes('=')) { try { return { preset: decodeURIComponent(h), set: {} }; } catch (e) { return null; } }
  const out = { preset: null, set: {} };
  for (const part of h.split('&')) {
    const [k, raw] = part.split('=');
    let v;
    try { v = decodeURIComponent(raw || ''); } catch (e) { continue; }
    if (k === 'p') { out.preset = v; continue; }
    if (!(k in FL.DEFAULTS)) continue;
    const t = typeof FL.DEFAULTS[k];
    if (t === 'number') { const n = Number(v); if (isFinite(n)) out.set[k] = n; }
    else if (t === 'boolean') out.set[k] = v === '1' || v === 'true';
    else out.set[k] = v;
  }
  return out;
}
let hashTimer = 0;
function scheduleHash() {
  clearTimeout(hashTimer);
  hashTimer = setTimeout(() => {
    try { history.replaceState(null, '', encodeState()); } catch (e) { /* dosya:// altında izin verilmeyebilir */ }
  }, 350);
}

/* ------------------------------------------------------------------ */
/* Başlatma                                                            */
/* ------------------------------------------------------------------ */
function init() {
  // Ekran tazeleme hızı açılış sırasında ölçülmeye başlar (kare hızı yöneticisinin hedefi)
  let pt = 0;
  const probe = (t) => {
    if (pt && FL.observeFrame) FL.observeFrame(t - pt, t);
    pt = t;
    if (!app.started) requestAnimationFrame(probe);
  };
  requestAnimationFrame(probe);
  FL.hydrateIcons(document);
  setPauseIcon();
  // Yükleme ekranının çizilmesine izin ver, sonra ağır işi yap
  requestAnimationFrame(() => setTimeout(boot, 16));
}

/* Açılış ekranı: her başlatma adımından önce bir kare çizilir, böylece çubuk gerçek ilerlemeyi gösterir */
const nextPaint = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
function bootProgress(frac, text) {
  const pct = Math.round(frac * 100);
  const bar = $('bootBar');
  if (bar) bar.style.width = pct + '%';
  if (text) $('bootStep').textContent = text;
  $('bootPct').textContent = '%' + pct;
}

async function boot() {
  const canvas = $('gl');
  let glc;
  bootProgress(0.06, 'Grafik bağlamı açılıyor');
  await nextPaint();
  try {
    glc = new FL.GLContext(canvas);
  } catch (e) {
    showFatal('WebGL2 başlatılamadı', null, String(e && e.message ? e.message : e));
    return;
  }
  app.glc = glc;
  FL.app = app; // tanı ve otomatik testler için

  const fromHash = decodeHash(location.hash);
  const valid = (id) => FL.PRESETS.some((p) => p.id === id);
  const startId = fromHash && valid(fromHash.preset) ? fromHash.preset : valid(storageGet('fl-preset')) ? storageGet('fl-preset') : 'earth-candle';
  const r = FL.stateForPreset(startId);
  app.state = r.state;
  app.preset = r.preset;
  app.defaults = FL.stateForPreset(startId).state;
  if (fromHash) Object.assign(app.state, fromHash.set);
  else if (/Mobi|Android|iPhone|iPad/i.test(navigator.userAgent)) {
    // Düşük güçlü cihazlarda daha kaba ızgara
    app.state.resolution = 32;
    app.state.renderScale = 0.6;
  }
  // Otomatik test kancası
  if (window.FL_TEST) Object.assign(app.state, window.FL_TEST);

  try {
    bootProgress(0.18, 'Akış ve kimya çözücüsü derleniyor');
    await nextPaint();
    app.sim = new FL.Simulation(glc);
    bootProgress(0.52, 'Hesaplama ızgarası kuruluyor');
    await nextPaint();
    app.sim.configure(app.state);
    bootProgress(0.66, 'Işın yürütücü ve görüntü hattı derleniyor');
    await nextPaint();
    app.renderer = new FL.Renderer(glc, app.sim);
    // Yangın ve patlama sistemi: durum burada, çizimi renderer.fx yapar
    app.fx = new FL.FxSystem();
    app.renderer.fxSys = app.fx;
    app.fx.bindScene(null, app.state);
    app.gov = new FL.FrameGovernor();
  } catch (e) {
    showFatal('Çözücü başlatılamadı', 'Grafik işlemcisi gerekli gölgelendiricileri derleyemedi veya ızgara için yeterli bellek yok.', String(e && e.message ? e.message : e));
    return;
  }
  bootProgress(0.86, 'Arayüz hazırlanıyor');
  await nextPaint();
  fitCamera(false);
  app.renderer.camera.autoRotate = !!app.state.autoRotate;

  app.inspector = new FL.Inspector($('inspRoot'), {
    getState: () => app.state,
    getDefault: (k) => (app.defaults ? app.defaults[k] : undefined),
    onChange: onControl,
    actions: {
      openScenarios,
      restorePreset: () => { loadPreset(app.preset.id, true); toast('Senaryo varsayılanları yüklendi'); },
      downloadCSV, copyCSV,
      camAlignView: () => { camAlignView(); toast('Kamera görünüme hizalandı'); },
      camAimFlame: () => { camAimFlame(); toast('Kamera alevin ışık merkezine çevrildi'); },
      captureDataset: () => FL.captureDataset(app, {
        alignCamera: camAlignView,
        canvas: $('gl'),
        status: (t) => { const el = document.getElementById('dsStatus'); if (el) el.textContent = t; },
        toast, download, ignDuration: igniteDuration,
      }),
      clearHistory: () => { app.sim.history = []; app.sim.events = []; toast('Geçmiş temizlendi'); },
      applyEnv,
    },
  });
  app.inspector.sync();
  app.inspector.setScenario(app.preset);
  app.chart = new FL.Chart($('chart'));
  app.chart.series = app.state.chartSeries;
  app.chart.onSelect = (id) => { app.state.chartSeries = id; scheduleHash(); };
  app.readouts = new FL.Readouts($('readouts'));
  app.legend = new FL.Legend($('legend'));
  app.overlay = new FL.Overlay($('overlay'));
  app.flam = new FL.FlamPanel($('flam'), {
    onSelect: (ids) => { app.renderer.model.setSelection(ids); app.renderer.warming = Math.max(app.renderer.warming, 4); },
    onClose: () => setFlam(false),
    onMode: (m) => onControl('flamMode', m, 'live', false),
  });

  app.ai = new FL.AIPanel($('aiPanel'), {
    onClose: () => { onControl('view', 'real', 'live', false); syncRail(); },
    onSelect: (id) => { app.renderer.model.setSelection(id >= 0 ? [id] : []); app.renderer.warming = Math.max(app.renderer.warming, 4); },
    onIgnite: aiIgnite,
    onControl: (k, v) => onControl(k, v, 'live', true),
  });
  FL.AI.load().then(() => { app.renderer.warming = Math.max(app.renderer.warming, 20); });

  bindToolbar();
  bindRail();
  bindStage();
  bindKeys();
  bindLayout();
  bindDialogs();
  restoreLayout();
  // Bağlantıdan gelen model ve yanıcılık görünümü
  if (FL.modelById(app.state.model)) setModel(app.state.model, true);
  else app.state.model = 'none';
  if (app.state.flamView && app.state.model !== 'none') setFlam(true);
  else app.state.flamView = false;
  syncAI();
  updateScenarioLabel();
  scheduleAutoIgnite();
  if (fromHash) scheduleHash();

  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    app.lost = true;
    try { history.replaceState(null, '', encodeState()); } catch (err) { /* yok say */ }
    showFatal('Grafik bağlamı kayboldu', 'Grafik sürücüsü sıfırlandı ya da sistem belleği geri aldı. Deney ayarlarınız bağlantıda saklandı; yeniden yükleyerek kaldığınız yerden devam edebilirsiniz.', '');
  });

  if (!storageGet('fl-coach')) {
    $('coach').hidden = false;
    setTimeout(hideCoach, 9000);
  }
  bootProgress(0.94, 'İlk kare hesaplanıyor');
  requestAnimationFrame(loop);
}

function hideCoach() {
  if ($('coach').hidden) return;
  $('coach').hidden = true;
  storageSet('fl-coach', '1');
}

function fitCamera(animate) {
  const gr = app.sim.grid;
  const focus = app.preset && app.preset.focus !== undefined ? app.preset.focus : 0.5;
  const c = $('gl');
  const aspect = c.clientWidth > 0 && c.clientHeight > 0 ? c.clientWidth / c.clientHeight : undefined;
  // Sahnede model varsa kutu ile modelin birleşimi çerçevelenir
  let bounds;
  const ms = app.renderer.model;
  if (app.renderer.modelActive(app.state)) {
    ms.place(app.state, gr);
    const box = [gr.Lx, gr.Ly, gr.Lz];
    const lo = [0, 1, 2].map((i) => Math.min(0, ms.worldLo[i]));
    const hi = [0, 1, 2].map((i) => Math.max(box[i], ms.worldHi[i]));
    bounds = { lo, hi };
    app.renderer.camera.farMin = 4 * Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
  } else {
    app.renderer.camera.farMin = 0;
  }
  app.renderer.camera.fit([gr.Lx, gr.Ly, gr.Lz], gr.Ly * focus, animate, aspect, bounds);
}

/* ------------------------------------------------------------------ */
/* Sahne modeli ve yanıcılık modülü                                     */
/* ------------------------------------------------------------------ */
/**
 * Sahnede nesne varken deney düzeneği (mum, jet, damla, levha) olmaz: nesne eklenince kaynak
 * kaldırılır. Döner: bir düzenek kaldırıldıysa true.
 */
function dropSource() {
  const st = app.state;
  if (st.source === 'none') return false;
  st.source = 'none';
  st.fuel = FL.DEFAULT_FUEL.none || st.fuel;
  st.depth = 0;
  st.domain = 4;
  st.aspect = st.gravity > 0.05 ? 1.8 : 1.0;
  rebuild();
  app.autoIgnPending = false;
  if (app.inspector) app.inspector.sync();
  return true;
}

/** Modeli seç: indir, çözümle, uzaklık alanını hesapla, yerleştir */
function setModel(id, keepPlacement) {
  const st = app.state;
  const ms = app.renderer.model;
  const def = FL.modelById(id);
  st.model = def ? def.id : 'none';
  const dropped = def ? dropSource() : false;
  if (app.ai) app.ai.select(-1);
  app.flam.reset();
  ms.setSelection([]);
  hideFlamTip();
  const gen = (app._modelGen = (app._modelGen || 0) + 1);
  const ld = $('modelLoad');
  if (!def) {
    ms.unload();
    fxRebind();
    ld.hidden = true;
    if (st.flamView) setFlam(false);
    scheduleOcc();
    fitCamera(true);
    syncRail();
    app.renderer.warming = Math.max(app.renderer.warming, 10);
    return;
  }
  if (!keepPlacement) { st.modelRot = def.rot || 0; st.modelX = 0; st.modelZ = 0; }
  ld.hidden = false;
  $('modelLoadTxt').textContent = def.name + ' · indiriliyor';
  $('modelLoadBar').style.width = '0%';
  ms.load(def, (f, txt) => {
    if (gen !== app._modelGen) return;
    $('modelLoadTxt').textContent = def.name + ' · ' + txt.toLocaleLowerCase('tr');
    $('modelLoadBar').style.width = Math.round(f * 100) + '%';
  }).then((ok) => {
    if (gen !== app._modelGen || !ok) return;
    ld.hidden = true;
    ms.place(app.state, app.sim.grid);
    fxRebind();
    // Alevin ışığı birkaç desimetrede ≈ 10–100 lx'e düşer: model görünsün diye tavan lambası
    // (kabin aydınlatması düzeyi) açılır; kullanıcı Görüntü › Sahne'den kapatabilir.
    let lit = '';
    if (!(app.state.roomLight > 0)) { app.state.roomLight = 300; lit = ' · tavan lambası 300 lx'; }
    if (app.state.ambientLight < 4) app.state.ambientLight = 4;
    app.inspector.sync();
    fitCamera(true);
    app.renderer.warming = 40;
    app.flam.reset();
    toast(def.name + ' · ' + ms.parts.length + ' parça' + lit + (dropped ? ' · deney düzeneği kaldırıldı' : ''));
    scheduleHash();
    scheduleOcc();
  }).catch((e) => {
    if (gen !== app._modelGen) return;
    ld.hidden = true;
    console.error(e);
    toast('Model yüklenemedi: ' + (e && e.message ? e.message : e));
    st.model = 'none';
    app.inspector.sync();
    syncRail();
  });
  syncRail();
}

/** Yanıcılık modülü: panel + parça renkleri */
function setFlam(on) {
  const st = app.state;
  if (on && (!st.model || st.model === 'none')) {
    st.flamView = false;
    toast('Önce bir sahne modeli seçin');
    openFly($('railModel'));
    app.inspector.sync();
    return;
  }
  st.flamView = !!on;
  $('flam').hidden = !on;
  $('railFlam').setAttribute('aria-pressed', on ? 'true' : 'false');
  if (on) app.flam.update(app.renderer.model, st);
  else { hideFlamTip(); app.renderer.model.setHover(-1); }
  app.inspector.sync();
  app.renderer.warming = Math.max(app.renderer.warming, 6);
  scheduleHash();
}

function hideFlamTip() {
  const t = $('flamTip');
  if (t) t.hidden = true;
}

/** Ekran noktasından dünya ışını (son karenin kamerasıyla) */
function screenRay(cx, cy) {
  const cam = app.renderer.lastCam;
  const c = $('gl');
  if (!cam) return null;
  const x = (cx / c.clientWidth) * 2 - 1, y = 1 - (cy / c.clientHeight) * 2;
  const a = FL.M4.transformPoint(cam.invVP, [x, y, -1]), b = FL.M4.transformPoint(cam.invVP, [x, y, 1]);
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const l = Math.hypot(d[0], d[1], d[2]) || 1;
  return { ro: cam.eye, rd: d.map((v) => v / l) };
}

function pickPart(cx, cy) {
  if (!app.renderer.modelActive(app.state)) return -1;
  const r = screenRay(cx, cy);
  return r ? app.renderer.model.pick(r.ro, r.rd).id : -1;
}

/* Çözücü: model hesaplama alanına girerse katı hücreler (yerleşim değişince, gecikmeli) */
let occTimer = 0;
function occKey() {
  const g = app.sim.grid, ms = app.renderer.model;
  const on = app.renderer.modelActive(app.state) && app.state.modelSolid;
  return on ? [ms.version, g.NX, g.NY, g.NZ, g.dx.toPrecision(6)].join('|') : 'off';
}
function scheduleOcc() {
  clearTimeout(occTimer);
  app._occWant = occKey();
  occTimer = setTimeout(updateOcc, 250);
}
async function updateOcc() {
  if (app._occBusy) { app._occAgain = true; return; }
  const key = occKey();
  if (key === app._occDone) return;
  app._occBusy = true;
  try {
    let occ = null;
    if (key !== 'off') {
      app.renderer.model.place(app.state, app.sim.grid);
      occ = await app.renderer.model.occupancy(app.sim.grid);
    }
    // Hesap sürerken ızgara ya da yerleşim değiştiyse yeniden dene
    if (occKey() !== key) { app._occAgain = true; return; }
    const was = !!app.sim._moccOn;
    const changed = app.sim.setModelOccupancy(occ);
    app._occDone = key;
    if (changed) {
      let n = 0;
      if (occ) for (let q = 0; q < occ.length; q++) n += occ[q];
      resetField(occ ? 'Model hesaplama alanında: ' + fmt(n / 1000, 3) + ' bin hücre katı engel' : was ? 'Model alandan çıktı' : null);
    }
  } catch (e) {
    console.error(e);
  } finally {
    app._occBusy = false;
    if (app._occAgain) { app._occAgain = false; scheduleOcc(); }
  }
}

/** Model bilgi tablosu (Deney › Model bilgisi) */
function updateModelInfo() {
  const ms = app.renderer.model;
  if (!ms.def) { app.inspector.setKV('modelInfo', []); return; }
  if (!ms.ready) { app.inspector.setKV('modelInfo', [['Durum', 'yükleniyor…']]); return; }
  const lo = ms.worldLo, hi = ms.worldHi;
  const cm = (v) => fmt(v * 100, 3);
  const g = ms.sdfGrid;
  let solid = '—';
  if (app.sim._moccOn) solid = 'evet (alanla kesişiyor)';
  else if (app.state.modelSolid) solid = 'hayır (alanın dışında)';
  app.inspector.setKV('modelInfo', [
    ['Dosya', ms.def.file],
    ['Parça · üçgen', ms.parts.length + ' · ' + fmt(ms.triCount / 1000, 3) + ' bin'],
    ['Boyut (x·y·z)', cm(hi[0] - lo[0]) + ' · ' + cm(hi[1] - lo[1]) + ' · ' + cm(hi[2] - lo[2]) + ' cm'],
    ['Konum (alt köşe)', cm(lo[0]) + ' · ' + cm(lo[1]) + ' · ' + cm(lo[2]) + ' cm'],
    ['Uzaklık alanı', g.n.join('×') + ' · ' + fmt(g.d * 1000, 2) + ' mm'],
    ['Çözücüde katı', solid],
  ]);
}

/* ------------------------------------------------------------------ */
/* Yangın ve patlama efektleri                                          */
/* ------------------------------------------------------------------ */
/** Sahne nesneleri değişince yangın hücrelerini yeniden kur */
function fxRebind() {
  const fx = app.fx;
  if (!fx) return;
  const ms = app.renderer.model;
  const on = app.renderer.modelActive(app.state);
  if (on) ms.place(app.state, app.sim.grid);
  fx.bindScene(on ? ms : null, app.state);
  FL.AIView.clear();
  FL.AIView.invalidate();
  app.fxEventId = 0;
  fxPaintLog();
}

function fxReset() {
  const fx = app.fx;
  if (!fx) return;
  fx.reset();
  FL.AIView.clear();
  // Yangının tükettiği kabin oksijeni geri gelir
  if (fx.o2Base != null && Math.abs(app.state.o2 - fx.o2Base) > 1e-6) {
    app.state.o2 = fx.o2Base;
    if (app.inspector) app.inspector.syncKey('o2');
  }
  fx._o2Applied = app.state.o2;
  // Delinen gövdeden boşalan basınç da geri gelir
  if (fx.pBase != null) {
    app.state.pressure = fx.pBase;
    fx._pApplied = fx.pBase;
    fx.pBase = null;
    if (app.inspector) app.inspector.syncKey('pressure');
  }
  app.fxEventId = 0;
  fxLogs.length = 0;
  fxPaintLog();
}

/**
 * Efektleri benzetim süresi kadar ilerletir ve iki çözücüyü birbirine bağlar:
 * akış çözücüsündeki alev nesneleri ısıtır; nesne yangını kabin O₂'sini tüketir,
 * patlama dalgası ve söndürücü akış çözücüsündeki alevi etkiler.
 */
function fxAdvance(dt) {
  const fx = app.fx, sim = app.sim, st = app.state;
  if (!fx || !(dt > 0)) return;
  fx.floorOn = !!st.floor && !app.renderer.orbitBackdrop(st) && !(app.renderer.modelActive(st) && app.renderer.model.def.large);
  fx.density = app.gov ? app.gov.level.density : 1;
  fx.setEnv(st);
  const s = sim.stats;
  const on = !!sim.flameOn && s.valid;
  fx.update(dt, {
    on, hrr: on ? s.hrr : 0,
    pos: on ? [s.cx, s.cy, s.cz] : sim.geo.anchor,
    height: on ? 0.5 * Math.max(s.flameH || 0, s.rMax || 0) : 0,
  });
  // Yapay zekâ: kendiliğinden başlayan yangının (alev teması, patlama) ilk tutuşma noktası
  if (fx.stats.burningCells > 0 && !FL.AIView.origins.length && FL.AI.ready) {
    const i = fx.core.burningList[0];
    const body = fx.bodies[fx.core.body[i]];
    FL.AIView.addOrigin([fx.core.position[i * 3], fx.core.position[i * 3 + 1], fx.core.position[i * 3 + 2]], body ? body.part : null, fx.time, st, fx);
  }
  if (fx.cfdBlow > 0) { sim.supHold = Math.max(sim.supHold, sim.simTime + 0.3); sim.ignTimer = 0; fx.cfdBlow = 0; }
  if (fx.cfdSmother > 0) { sim.smoHold = Math.max(sim.smoHold, sim.simTime + fx.cfdSmother); sim.ignTimer = 0; fx.cfdSmother = 0; }
  if (st.fxO2Link) {
    const o2 = fx.o2Feedback();
    if (o2 !== null) { st.o2 = o2; app.fxO2Dirty = true; }
    // Gövde deliği: kabin basıncı düştükçe akış çözücüsündeki alev de oksitleyicisiz kalır
    const pk = fx.pressureFeedback();
    if (pk !== null) { st.pressure = pk; app.fxO2Dirty = true; }
  }
}
FL.fxAdvance = fxAdvance;

/** Olay günlüğü: neyin neden tutuştuğu / tutuşmadığı (yangın üçgeni) */
const fxLogs = [];
function fxLog(text, level) {
  fxLogs.push({ text, level: level || 'info', at: performance.now() });
  if (fxLogs.length > 4) fxLogs.shift();
  fxPaintLog();
  announce(text);
}
function fxPaintLog() {
  const el = $('fxLog');
  if (!el) return;
  const now = performance.now();
  while (fxLogs.length && now - fxLogs[0].at > 14000) fxLogs.shift();
  el.hidden = fxLogs.length === 0;
  el.innerHTML = fxLogs.map((l) => '<div class="fx-line" data-level="' + l.level + '">' + l.text.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</div>').join('');
}

/** Durum çipi: yangın gücü, yanan alan, kabin atmosferi */
function fxUpdateHud() {
  const fx = app.fx;
  if (!fx) return;
  for (const e of fx.events) {
    if (e.id <= app.fxEventId) continue;
    app.fxEventId = e.id;
    fxLog(e.text, e.level);
  }
  if (fxLogs.length) fxPaintLog();
  if (app.fxO2Dirty) { app.fxO2Dirty = false; app.inspector.syncKey('o2'); app.inspector.syncKey('pressure'); }
  const chip = $('fxChip');
  if (!chip) return;
  const s = fx.stats, comp = fx.cabin;
  const tr = (v, d) => fmt(v, d);
  const active = s.burningCells > 0 || s.hotCells > 0 || fx.debris.active > 0 || fx.explosionCount > 0 || !!(comp && comp.breached);
  chip.hidden = !active;
  if (!active) return;
  const parts = [];
  if (s.burningCells > 0) parts.push('<b>Yangın</b> ' + tr(s.heatKW, 3) + ' kW · ' + tr(s.burningArea * 1e4, 3) + ' cm²');
  else if (s.hotCells > 0) parts.push('<b>Kızışma</b> (piroliz dumanı)');
  else parts.push('<b>Söndü</b>');
  if (comp && !comp.isVacuum) parts.push('O₂ %' + tr(comp.o2Fraction * 100, 3) + ' · ' + tr(comp.pressure, 4) + ' kPa · ' + tr(comp.temperature, 3) + ' K' + (comp.breached ? ' · <b>gövde delik</b>' : ''));
  if (fx.explosionCount > 0) parts.push(fx.explosionCount + ' patlama');
  chip.dataset.state = s.burningCells > 0 ? 'fire' : 'idle';
  chip.innerHTML = parts.join('<span class="fx-sep"></span>');
}

/** Araçlar: sahnede tıklanan noktaya kıvılcım, patlayıcı ya da söndürücü */
const FX_TOOLS = [
  { id: 'none', name: 'Kapalı', short: 'Araç', desc: 'Tıklama yalnız görünümü döndürür' },
  { id: 'spark', name: 'Kıvılcım', short: 'Kıvılcım', desc: 'Tıklanan noktada elektrik arkı: yakıt + ısı + oksitleyici varsa tutuşur' },
  { id: 'charge', name: 'Patlayıcı', short: 'Patlayıcı', desc: 'Tıklanan noktada patlama (enerji: Deney › Yangın ve patlama)' },
  { id: 'agent', name: 'Söndürücü', short: 'Söndürücü', desc: 'Tıklanan noktaya CO₂: oksijeni yerinden eder ve soğutur' },
];
const FX_ACTIONS = [
  { id: 'act-short', name: 'Senaryo: kısa devre', desc: 'En yanıcı parçada (kablo, hortum, kumaş) ark çıkar' },
  { id: 'act-cook', name: 'Senaryo: tüp yanında yangın', desc: 'Basınçlı kap ya da O₂ kaynağının dibindeki yakıt tutuşur; kap ısınınca yarılır' },
  { id: 'act-blast', name: 'Senaryo: patlama', desc: 'Sahnenin ortasında seçili enerjide patlama' },
  { id: 'act-breach', name: 'Senaryo: gövde delinmesi', desc: 'Kabin vakuma boşalır; O₂ kısmi basıncı düşünce alevler söner (kabin modeli gerekir)' },
  { id: 'act-clear', name: 'Efektleri temizle', desc: 'Yangını, dumanı, enkazı sil; parçaları ve kabin havasını geri getir' },
];

function fxPoint(cx, cy) {
  const st = app.state;
  const r = screenRay(cx, cy);
  if (!r) return null;
  let t = Infinity, body = null;
  if (app.renderer.modelActive(st)) {
    const hit = app.renderer.model.pick(r.ro, r.rd);
    if (hit.id >= 0) { t = hit.t; body = app.fx.bodyAtPart(hit.id); }
  }
  if (!isFinite(t) && app.fx.floorOn && r.rd[1] < -1e-4) {
    const tf = -r.ro[1] / r.rd[1];
    if (tf > 0) t = tf;
  }
  if (!isFinite(t)) {
    // Boşluk: bakılan noktanın derinliğinde
    const g = app.sim.grid;
    const tg = st.camPhys && st.camLook ? [g.Lx / 2, g.Ly / 2, g.Lz / 2] : app.renderer.camera.target;
    t = Math.max(0.02, (tg[0] - r.ro[0]) * r.rd[0] + (tg[1] - r.ro[1]) * r.rd[1] + (tg[2] - r.ro[2]) * r.rd[2]);
  }
  const back = Math.min(0.01, 0.1 * t);
  return { p: [r.ro[0] + r.rd[0] * (t - back), r.ro[1] + r.rd[1] * (t - back), r.ro[2] + r.rd[2] * (t - back)], body };
}

function fxApplyTool(tool, hit) {
  const fx = app.fx, st = app.state;
  if (!hit) return;
  // Ortam (O₂, basınç, havalandırma) en güncel haliyle değerlendirilsin
  fx.setEnv(st);
  const comp = hit.body ? hit.body.compartment : fx.compartmentAt(hit.p);
  if (tool === 'spark') {
    const touched = fx.ignite(hit.p, { compartment: comp });
    // Yapay zekâ bu noktadan alevin nasıl yayılacağını öngörür (Yapay zekâ görünümünde çizilir)
    if (hit.body) FL.AIView.addOrigin(hit.p, hit.body.part, fx.time, st, fx);
    // Tutuşursa nedenini yangın sistemi kendi olayıyla yazar; burada yalnız tutuşmama nedeni yazılır
    if (hit.body) { const m = fx.describeIgnition(hit.body); if (m.level !== 'fire' || fx.stats.burningCells > 0) fxLog(hit.body.label + ' · ' + m.text, m.level); }
    else fxLog(touched ? 'Kıvılcım: yakındaki yüzeyler ısındı.' : 'Kıvılcım: yakınında yakıt yok.', 'info');
  } else if (tool === 'charge') {
    const before = comp.pressure;
    const res = fx.explode(hit.p, { yield: st.fxYield, compartment: comp, selfOxidizing: true });
    if (!res.shock) fxLog('Vakumda patlama: şok dalgasını taşıyacak gaz yok, duman asılı kalmaz; ateş topu anında genişleyip seyrelir, parçalar düz çizgide uçar.', 'fire');
    else fxLog('Basınçlı ortamda patlama (' + fmt(st.fxYield * 1000, 3) + ' kJ): şok dalgası, ısı darbesi ve +' + fmt(Math.max(0, comp.pressure - before), 2) + ' kPa aşırı basınç.', 'fire');
  } else if (tool === 'agent') {
    fx.extinguish(hit.p, { compartment: comp });
    fxLog(comp.isVacuum || comp.pressure < 1 ? 'Söndürücü: vakumda zaten oksitleyici yok.' : 'Söndürücü gaz oksijeni yerinden etti ve yakıtı tutuşma sıcaklığının altına soğuttu.', 'info');
  }
  app.renderer.warming = Math.max(app.renderer.warming, 30);
  if (app.paused) toast('Duraklatılmış: efekt, sürdürünce (Boşluk) ilerler');
}

function fxAction(id) {
  const fx = app.fx, st = app.state;
  if (id === 'act-clear') { fxReset(); app.renderer.warming = 20; toast('Efektler temizlendi'); return; }
  const g = app.sim.grid;
  if (id === 'act-blast') {
    const c = fx.scene ? [0.5 * (fx.scene.worldLo[0] + fx.scene.worldHi[0]), 0.5 * (fx.scene.worldLo[1] + fx.scene.worldHi[1]), 0.5 * (fx.scene.worldLo[2] + fx.scene.worldHi[2])] : [g.Lx / 2, g.Ly * 0.6, g.Lz / 2];
    // Kabinde: orta güverte, deney kutusunun bir adım yanı
    const p = fx.large ? [g.Lx / 2 + 0.6, 0.9, g.Lz / 2 - 0.4] : c;
    fxApplyTool('charge', { p, body: null });
    return;
  }
  if (id === 'act-breach') {
    const h = fx.hullPoint();
    if (!h) { toast('Gövde delinmesi için kabin modelini ekleyin (M)'); openFly($('railModel')); return; }
    if (fx.cabin.breached) { fxLog('Gövde zaten delik.', 'info'); return; }
    fx.breach(h.p, h.n, 0.05);
    fxLog('Gövde delindi: basınç düşüyor. O₂ kısmi basıncı sınırın altına inince alevler oksitleyicisiz kalıp söner.', 'info');
    app.renderer.warming = 30;
    return;
  }
  if (!fx.scene || !fx.bodies.length) { toast('Önce bir sahne nesnesi ekleyin (M)'); openFly($('railModel')); return; }
  const core = fx.core;
  const burnable = fx.bodies.filter((b) => FL.fxIsCombustible(b.material) && !b.destroyed && b.compartment === fx.cabin);
  if (id === 'act-short') {
    if (!burnable.length) { fxLog('Sahnede yanıcı parça yok: yangın üçgeninin yakıt kenarı eksik.', 'info'); return; }
    // En düşük LOI'li (en kolay yanan), yeterince büyük parça
    burnable.sort((a, b) => a.material.loi - b.material.loi || b.cellCount - a.cellCount);
    const body = burnable[0];
    const i = body.cellStart + Math.floor(body.cellCount / 2);
    const p = [core.position[i * 3] + core.normal[i * 3] * 0.004, core.position[i * 3 + 1] + core.normal[i * 3 + 1] * 0.004, core.position[i * 3 + 2] + core.normal[i * 3 + 2] * 0.004];
    fxApplyTool('spark', { p, body });
    fxLog('Kısa devre: ' + body.label + ' üzerinde ark.', 'fire');
    return;
  }
  if (id === 'act-cook') {
    const vessels = fx.bodies.filter((b) => b.explosive && !b.destroyed && !b.triggered);
    if (!vessels.length) { fxLog('Sahnede basınçlı kap, oksijen kaynağı ya da pil yok. CO₂ tüpü, SFOG ya da O₂ vanası ekleyin.', 'info'); return; }
    const v = vessels[0];
    // Kaba en yakın yanıcı parça
    let best = null, bd = Infinity;
    for (const b of burnable) {
      const d = Math.hypot(b.center[0] - v.center[0], b.center[1] - v.center[1], b.center[2] - v.center[2]) - b.radius;
      if (d < bd) { bd = d; best = b; }
    }
    if (best && bd < Math.max(0.5, 3 * v.radius)) {
      // O parçanın kaba en yakın hücresi
      let ci = best.cellStart, cd = Infinity;
      for (let i = best.cellStart; i < best.cellStart + best.cellCount; i++) {
        const d = Math.hypot(core.position[i * 3] - v.center[0], core.position[i * 3 + 1] - v.center[1], core.position[i * 3 + 2] - v.center[2]);
        if (d < cd) { cd = d; ci = i; }
      }
      fxApplyTool('spark', { p: [core.position[ci * 3], core.position[ci * 3 + 1], core.position[ci * 3 + 2]], body: best });
      fxLog(v.explosive.label + ' yanındaki ' + best.label + ' tutuşturuldu. Kap ısınınca yarılacak.', 'fire');
    } else {
      // Yakında yakıt yok: kap doğrudan ısıtılır (ör. kısa devre arkı)
      core.heatSphere(v.center[0], v.center[1], v.center[2], v.radius * 1.2 + fx.spacing, 900, true);
      fxLog(v.explosive.label + ' doğrudan ısıtılıyor: cidarının bir bölümü yeterince uzun kızgın kalırsa yarılır.', 'fire');
      app.renderer.warming = 30;
    }
  }
}

/** Yapay zekâ panelinden: seçilen parçada kıvılcım çak */
function aiIgnite(partId) {
  const fx = app.fx;
  const body = fx.bodyAtPart(partId);
  if (!body || !body.cellCount) { toast('Bu parçada yangın hücresi yok'); return; }
  const core = fx.core;
  const i = body.cellStart + Math.floor(body.cellCount / 2);
  const p = [0, 1, 2].map((k) => core.position[i * 3 + k] + core.normal[i * 3 + k] * 0.004);
  app.ai.select(partId);
  app.renderer.model.setSelection([partId]);
  fxApplyTool('spark', { p, body });
}

/** Yapay zekâ görünümü: panel, düğme ve seçim görünüm moduna bağlıdır */
function syncAI() {
  const st = app.state;
  const on = st.view === 'ai';
  const panel = $('aiPanel');
  if (!panel) return;
  if (on && st.flamView) setFlam(false);
  if (panel.hidden === on) {
    panel.hidden = !on;
    if (!on && app.renderer) app.renderer.model.setSelection([]);
    if (on && app.ai) { app.ai._key = ''; app.ai.update(app.renderer.modelActive(st) ? app.renderer.model : null, st, app.fx); }
  }
  $('railAI').setAttribute('aria-pressed', on ? 'true' : 'false');
}

function toggleAI() {
  const on = app.state.view !== 'ai';
  onControl('view', on ? 'ai' : 'real', 'live', false);
  syncRail();
  toast(on ? (FL.AI.ready ? 'Yapay zekâ tahmini: bir parçaya tıklayın' : 'Yapay zekâ modeli yükleniyor…') : 'Gerçekçi görünüm');
}

function setFxTool(id) {
  const st = app.state;
  st.fxTool = FX_TOOLS.some((x) => x.id === id) ? id : 'none';
  $('stage').classList.toggle('fx-aim', st.fxTool !== 'none');
  syncRail();
  if (app.inspector) app.inspector.syncKey('fxTool');
  scheduleHash();
}

function scheduleAutoIgnite() {
  app.autoIgnPending = true;
  app.autoIgnAt = app.sim.simTime + (app.state.source === 'sheet' ? 0.2 : 0.12);
  // Deney düzeneği yokken tutuşturulacak bir şey de yoktur
  if (app.state.source === 'none') app.autoIgnPending = false;
}

// Kumaşın ısıl kütlesi büyük: sıcak tel, ön kenarın ötesindeki lifler piroliz
// sıcaklığına ulaşıp alev kendi başına yayılana kadar açık kalır
function igniteDuration() {
  if (app.state.source === 'sheet') return 5;
  if (app.state.source === 'candle') return 2;
  return 0.9;
}

function ignite() {
  app.autoIgnPending = false;
  app.sim.ignite(igniteDuration());
  const b = $('btnIgnite');
  b.classList.add('flash');
  setTimeout(() => b.classList.remove('flash'), 260);
}

function resetField(msg) {
  app.sim.reset();
  fxReset();
  app.renderer.invalidate();
  app.lastEventId = app.sim._evSeq;
  scheduleAutoIgnite();
  if (msg) toast(msg);
}

/* ------------------------------------------------------------------ */
/* Denetim değişiklikleri                                              */
/* ------------------------------------------------------------------ */
function onControl(key, value, effect, isInput) {
  const st = app.state;
  const prev = st[key];
  // Sahnede nesne varken deney düzeneği eklenmez (mum, mekiğin altında / nesnelerin yanında kalmasın)
  if (key === 'source' && value !== 'none' && FL.modelById(st.model)) {
    toast('Sahnede nesne varken deney düzeneği eklenemez. Önce nesneleri kaldırın (M › Hiçbiri).');
    app.inspector.sync();
    syncRail();
    return;
  }
  st[key] = value;
  if (key === 'source' && prev !== value) {
    st.fuel = FL.DEFAULT_FUEL[value];
    st.depth = 0;
    if (value === 'droplet') { st.domain = st.gravity > 0.05 ? 4.4 : 6; st.aspect = st.gravity > 0.05 ? 1.8 : 1.0; st.chartSeries = 'd2'; }
    else if (value === 'sheet') { st.domain = 6; st.aspect = 1.6; }
    else if (value === 'jet') { st.domain = 4; st.aspect = 2.0; }
    else { st.domain = 4; st.aspect = st.gravity > 0.05 ? 1.8 : 1.0; }
    app.chart.series = st.chartSeries;
    rebuild();
    scheduleAutoIgnite();
  } else if (key === 'fuel' && prev !== value && (st.source === 'droplet' || st.source === 'sheet')) {
    resetField();
  } else if (effect === 'rebuild' && !isInput && !same(prev, value)) {
    rebuild();
    scheduleAutoIgnite();
  } else if (effect === 'reset' && !isInput && !same(prev, value)) {
    resetField();
  }
  // Fiziksel kamera ilk açıldığında sahne kamerası o anki görünüme yerleşir ve
  // görüntü kameradan alınır (Blender: Ctrl+Alt+Numpad 0, sonra Numpad 0)
  if (key === 'camPhys' && value && !prev) {
    if (!st.camSet) camAlignView();
    st.camLook = true;
  }
  // Editör görünümüne dönünce, kamera nesnesi görünsün diye görüş biraz geri çekilir
  if (key === 'camLook' && !value && prev) {
    camFrameEditor();
  }
  if (key === 'model' && !isInput) setModel(value);
  if (key === 'fxTool') $('stage').classList.toggle('fx-aim', value !== 'none');
  if (key === 'flamView') setFlam(!!value);
  if (key === 'view') { if (value === 'ai' && st.flamView) setFlam(false); syncAI(); }
  if (key === 'flamMode') { app.flam.reset(); app.renderer.model.setSelection([]); }
  if (key === 'autoRotate') {
    app.renderer.camera.autoRotate = !!value;
    $('camOrbit').setAttribute('aria-pressed', value ? 'true' : 'false');
  }
  if (isInput) {
    app.inspector.syncKey(key);
  } else {
    app.inspector.sync();
  }
  if (app.renderer) app.renderer.warming = Math.max(app.renderer.warming, 10);
  scheduleHash();
}

/** Konum veya oksitleyici: bir grup ortam değerini tek seferde yazar */
function applyEnv(set, name) {
  const st = app.state;
  let changed = false;
  for (const k of Object.keys(set)) {
    if (!(k in st) || same(st[k], set[k])) continue;
    st[k] = set[k];
    changed = true;
  }
  if (app.renderer) app.renderer.warming = Math.max(app.renderer.warming, 10);
  app.inspector.sync();
  scheduleHash();
  if (changed && name) toast(name);
}

function rebuild() {
  try {
    // Izgara kurulumu birkaç kareyi uzatır: kare hızı yöneticisi bunu yük sanmasın
    if (app.gov) app.gov.resume(2.5);
    app.sim.configure(app.state);
    app.renderer.invalidate();
    app.lastEventId = app.sim._evSeq;
    fitCamera(true);
    syncDims();
  } catch (e) {
    showFatal('Izgara kurulamadı', 'Seçilen çözünürlük bu grafik işlemcisinin doku sınırını aşıyor olabilir. Daha küçük bir değer deneyin.', String(e.message || e));
  }
}

function loadPreset(id, keepView) {
  const r = FL.stateForPreset(id, app.state);
  app.state = r.state;
  app.preset = r.preset;
  app.defaults = FL.stateForPreset(id).state;
  app.chart.series = app.state.chartSeries;
  app.renderer.camera.autoRotate = !!app.state.autoRotate;
  storageSet('fl-preset', id);
  rebuild();
  // Senaryolar deney düzeneği kurar: sahnedeki nesneler kaldırılır
  if (app.state.source !== 'none' && FL.modelById(app.state.model)) { setModel('none'); toast('Senaryo deney düzeneği kurdu: sahne nesneleri kaldırıldı'); }
  syncAI();
  app.inspector.sync();
  app.inspector.setScenario(r.preset);
  updateScenarioLabel();
  scheduleAutoIgnite();
  scheduleHash();
  if (!keepView) announce('Senaryo: ' + r.preset.name);
}

function updateScenarioLabel() {
  $('scnLabel').textContent = app.preset.name;
  document.title = app.preset.name + ' — Alev Laboratuvarı';
}

/* ------------------------------------------------------------------ */
/* Araç çubuğu                                                          */
/* ------------------------------------------------------------------ */
function setPauseIcon() {
  const b = $('btnPause');
  b.innerHTML = FL.icon(app.paused ? 'play' : 'pause');
  b.setAttribute('aria-label', app.paused ? 'Sürdür' : 'Duraklat');
  b.setAttribute('aria-pressed', app.paused ? 'true' : 'false');
  $('btnStep').disabled = !app.paused;
}

function togglePause() {
  app.paused = !app.paused;
  setPauseIcon();
  if (app.renderer) app.renderer.warming = Math.max(app.renderer.warming, 16);
  announce(app.paused ? 'Duraklatıldı' : 'Sürdürülüyor');
}

function stepFrame() {
  if (!app.paused) return;
  app.stepOnce = true;
}

function setSuppress(on) {
  const sim = app.sim;
  if (!sim) return;
  sim.supActive = on;
  // Tıklama da işe yarsın: parmak kalksa bile yaklaşık 1 s benzetim süresi jet sürer
  if (on) {
    sim.supHold = sim.simTime + 1.0;
    sim.ignTimer = 0;
  }
  paintSuppress();
}

function setSmother(on) {
  const sim = app.sim;
  if (!sim) return;
  sim.smoActive = on;
  // Bir tıklama tüpü yaklaşık 2 s boşaltır; basılı tutmak boşaltmayı sürdürür
  if (on) {
    sim.smoHold = sim.simTime + 2.0;
    sim.ignTimer = 0;
  }
  paintSuppress();
}

function paintSuppress() {
  const sim = app.sim;
  const btn = $('btnSuppress');
  if (!sim || !btn) return;
  const on = sim.quenching ? sim.quenching() : !!sim.supActive;
  btn.classList.toggle('active', on);
  btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  const sb = $('btnSmother');
  if (sb) {
    const so = sim.smothering ? sim.smothering() : false;
    sb.classList.toggle('active', so);
    sb.setAttribute('aria-pressed', so ? 'true' : 'false');
  }
}

/* ------------------------------------------------------------------ */
/* Hesaplama alanı boyutu (X, Y, Z cm) — araç çubuğunda                 */
/* ------------------------------------------------------------------ */
const DIM_LIM = { X: [2, 14], Y: [2, 30], Z: [2, 14] };
const fmtCm = (v) => FL.fmtCm(v);

function currentDims() {
  const g = app.sim && app.sim.grid;
  if (g) return { X: g.Lx * 100, Y: g.Ly * 100, Z: g.Lz * 100 };
  const st = app.state;
  return { X: st.domain, Y: st.domain * st.aspect, Z: st.depth > 0 ? st.depth : st.domain };
}

function syncDims() {
  const d = currentDims();
  for (const k of ['X', 'Y', 'Z']) {
    const el = $('dim' + k);
    if (el && document.activeElement !== el) el.value = fmtCm(d[k]);
  }
}

function applyDim(axis, raw) {
  const st = app.state;
  const v0 = parseFloat(String(raw).replace(',', '.'));
  if (!isFinite(v0)) { syncDims(); return; }
  const [lo, hi] = DIM_LIM[axis];
  const v = FL.clamp(v0, lo, hi);
  const d = currentDims();
  if (Math.abs(v - d[axis]) < 0.05) { syncDims(); return; }
  if (axis === 'X') {
    st.domain = v;
    st.aspect = d.Y / v;              // yükseklik aynı kalsın
    if (!(st.depth > 0)) st.depth = d.Z; // derinlik aynı kalsın
  } else if (axis === 'Y') {
    st.aspect = v / st.domain;
  } else {
    st.depth = v;
  }
  if (!(st.depth > 0)) st.depth = 0;
  // Hücre sayısı denetimi: çok büyük alan GPU'yu kilitlemesin
  const N = Math.round(st.resolution);
  const dx = st.domain / N;
  const cells = N * Math.round((st.domain * st.aspect) / dx) * Math.round((st.depth > 0 ? st.depth : st.domain) / dx);
  rebuild();
  scheduleAutoIgnite();
  app.inspector.sync();
  scheduleHash();
  const g = app.sim.grid;
  toast('Alan ' + fmtCm(g.Lx * 100) + ' × ' + fmtCm(g.Ly * 100) + ' × ' + fmtCm(g.Lz * 100) + ' cm' + (cells > 450000 ? ' · ' + Math.round(cells / 1000) + ' bin hücre, yavaşlayabilir' : ''));
  if (v !== v0) announce(axis + ' ' + lo + '–' + hi + ' cm aralığına sınırlandı');
}

function bindDims() {
  for (const k of ['X', 'Y', 'Z']) {
    const el = $('dim' + k);
    if (!el) continue;
    el.addEventListener('change', () => applyDim(k, el.value));
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); el.blur(); }
      else if (e.key === 'Escape') { syncDims(); el.blur(); }
      else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        const v = parseFloat(el.value.replace(',', '.')) || currentDims()[k];
        el.value = fmtCm(v + (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 1 : 0.5));
      }
    });
    el.addEventListener('focus', () => el.select());
  }
  syncDims();
}

function bindToolbar() {
  bindDims();
  $('btnIgnite').addEventListener('click', ignite);
  const sup = $('btnSuppress');
  sup.addEventListener('pointerdown', (e) => { e.preventDefault(); sup.setPointerCapture(e.pointerId); setSuppress(true); });
  ['pointerup', 'pointercancel', 'lostpointercapture'].forEach((ev) => sup.addEventListener(ev, () => setSuppress(false)));
  sup.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) { e.preventDefault(); setSuppress(true); } });
  sup.addEventListener('keyup', (e) => { if (e.key === 'Enter' || e.key === ' ') setSuppress(false); });
  const smo = $('btnSmother');
  smo.addEventListener('pointerdown', (e) => { e.preventDefault(); smo.setPointerCapture(e.pointerId); setSmother(true); });
  ['pointerup', 'pointercancel', 'lostpointercapture'].forEach((ev) => smo.addEventListener(ev, () => setSmother(false)));
  smo.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) { e.preventDefault(); setSmother(true); } });
  smo.addEventListener('keyup', (e) => { if (e.key === 'Enter' || e.key === ' ') setSmother(false); });
  $('btnPause').addEventListener('click', togglePause);
  $('btnStep').addEventListener('click', stepFrame);
  $('btnReset').addEventListener('click', () => resetField('Alan sıfırlandı'));
  $('btnShot').addEventListener('click', () => { app.wantShot = true; });
  $('btnShare').addEventListener('click', shareLink);
  $('btnKeys').addEventListener('click', () => openDialog('dlgKeys'));
  $('btnInspector').addEventListener('click', toggleInspector);
  $('btnCine').addEventListener('click', () => setCinema(!app.cine));
  $('scnBtn').addEventListener('click', openScenarios);

  $('camFit').addEventListener('click', () => fitCamera(true));
  $('camFront').addEventListener('click', () => app.renderer.camera.setView('front'));
  $('camSide').addEventListener('click', () => app.renderer.camera.setView('side'));
  $('camTop').addEventListener('click', () => app.renderer.camera.setView('top'));
  $('camOrbit').addEventListener('click', () => onControl('autoRotate', !app.state.autoRotate, 'live', false));
  $('camOrbit').setAttribute('aria-pressed', app.state.autoRotate ? 'true' : 'false');
  $('chartHide').addEventListener('click', () => setChart(false));
  $('chartShow').addEventListener('click', () => setChart(true));
  $('coachClose').addEventListener('click', hideCoach);
}

/* ------------------------------------------------------------------ */
/* Sol hızlı panel: temel denetimler ve açılır seçim listeleri           */
/* ------------------------------------------------------------------ */
const RAIL_SOURCES = [
  { id: 'none', name: 'Yok', short: 'Kaynak yok', desc: 'Deney düzeneği olmadan: yalnız sahne nesneleri ve yangın efektleri' },
  { id: 'candle', name: 'Mum', short: 'Mum', desc: 'Parafin buharı fitilden beslenir' },
  { id: 'jet', name: 'Gaz jeti', short: 'Jet', desc: 'Nozuldan çıkan yakıt gazı' },
  { id: 'droplet', name: 'Yakıt damlası', short: 'Damla', desc: 'd²-yasasıyla küçülen damla' },
  { id: 'sheet', name: 'Katı levha', short: 'Levha', desc: 'Saffire tipi kumaşta alev yayılması' },
];
const RAIL_VIEW_SHORT = { real: 'Gerçekçi', ir: 'Termal', temp: 'Sıcaklık', hrr: 'HRR', soot: 'Kurum', vel: 'Hız', species: 'Türler', schlieren: 'Schlieren', rad: 'Işınım', ai: 'YZ tahmini' };
let flyOwner = null;
let flyTimer = 0;

/** Sağdaki çekmecenin görüntü alanını örttüğü genişlik (CSS pikseli) */
function drawerCover(canvas) {
  if (mobile()) return 0;
  const ir = $('inspector').getBoundingClientRect();
  const cr = canvas.getBoundingClientRect();
  return Math.max(0, cr.right - Math.max(ir.left, cr.left));
}

function placeDesc(p) {
  const g = p.set.gravity;
  const gt = g <= 0 ? '0' : g < 1e-3 ? '≈0' : fmt(g, 3);
  return gt + ' g₀ · ' + fmt(p.set.pressure, 3) + ' kPa · %' + fmt(p.set.o2, 3) + ' O₂';
}

function flyItems(kind) {
  const st = app.state;
  if (kind === 'source') {
    // Sahnede nesne varken deney düzeneği seçilemez
    const locked = !!FL.modelById(st.model);
    return { title: 'Kaynak', items: RAIL_SOURCES.map((x) => {
      const off = locked && x.id !== 'none';
      return { id: x.id, name: x.name, desc: off ? 'Sahnede nesne varken eklenemez: önce nesneleri kaldırın' : x.desc, on: st.source === x.id, off };
    }) };
  }
  if (kind === 'place') {
    return { title: 'Konum', items: FL.PLACES.map((p) => ({ id: p.id, name: p.name, desc: placeDesc(p), on: FL.matchPlace(p, st) })) };
  }
  if (kind === 'model') {
    // Her model ayrı bir sahne nesnesidir: birden çoğu birlikte seçilebilir (kabin tek başına)
    // Mekik kabini seçiliyken başka nesne seçilemez; diğerleri birlikte seçilip yan yana dizilir
    const ids = FL.modelIds(st.model);
    const cabin = ids.includes('cabin');
    return {
      title: 'Sahne nesneleri', multi: true,
      items: [{ id: 'none', name: 'Hiçbiri', desc: 'Bütün nesneleri kaldır', on: !ids.length }]
        .concat(FL.MODELS.map((m) => {
          const off = cabin && m.id !== 'cabin';
          const swap = !cabin && ids.length > 0 && m.id === 'cabin';
          return { id: m.id, name: m.name, on: ids.includes(m.id), off,
            desc: off ? 'Mekik seçiliyken eklenemez: önce mekiği kaldırın' : swap ? m.desc + ' · seçilirse diğer nesnelerin yerini alır' : m.desc };
        })),
    };
  }
  if (kind === 'tool') {
    return {
      title: 'Yangın ve patlama',
      items: FX_TOOLS.map((x) => ({ id: x.id, name: x.id === 'none' ? 'Araç kapalı' : x.name, desc: x.desc, on: st.fxTool === x.id }))
        .concat(FX_ACTIONS.map((x) => ({ id: x.id, name: x.name, desc: x.desc, on: false, action: true }))),
    };
  }
  return { title: 'Görünüm', items: FL.VIEW_MODES.map((m, i) => ({ id: m.id, name: m.name, desc: m.desc, kbd: m.kbd || String(i + 1), on: st.view === m.id })) };
}

function applyFly(kind, id) {
  if (kind === 'source') {
    if (app.state.source !== id) onControl('source', id, 'reset', false);
  } else if (kind === 'place') {
    const p = FL.PLACES.find((x) => x.id === id);
    if (p) applyEnv(p.set, p.name);
  } else if (kind === 'model') {
    const next = FL.modelToggle(app.state.model, id);
    if (app.state.model !== next) {
      setModel(next);
      app.inspector.sync();
      scheduleHash();
    }
  } else if (kind === 'tool') {
    if (id.startsWith('act-')) fxAction(id);
    else { setFxTool(id); if (id !== 'none') toast(FX_TOOLS.find((x) => x.id === id).name + ': sahnede bir noktaya tıklayın'); }
  } else {
    onControl('view', id, 'live', false);
  }
  syncRail();
}

function flyHTML(kind) {
  const spec = flyItems(kind);
  let html = '<div class="fly-title">' + spec.title + (spec.multi ? '<span class="fly-hint">birden çok seçilebilir</span>' : '') + '</div>';
  for (const it of spec.items) {
    html += '<button type="button" class="fly-item' + (it.action ? ' fly-action' : '') + (it.off ? ' fly-off' : '') + '" role="' + (it.action ? 'menuitem' : spec.multi ? 'menuitemcheckbox' : 'menuitemradio') + '"' + (it.action ? '' : ' aria-checked="' + (it.on ? 'true' : 'false') + '"') + (it.off ? ' aria-disabled="true"' : '') + ' data-id="' + it.id + '">' +
      '<span class="fly-name">' + it.name + '</span>' +
      '<span class="fly-mark">' + (it.kbd ? '<kbd>' + it.kbd + '</kbd>' : '') + FL.icon('check') + '</span>' +
      '<span class="fly-desc">' + it.desc + '</span></button>';
  }
  return { html, title: spec.title, multi: !!spec.multi };
}

function openFly(btn) {
  const kind = btn.dataset.fly;
  if (flyOwner === btn) { closeFly(); return; }
  closeFly(true);
  const fly = $('flyout');
  const spec = flyHTML(kind);
  fly.innerHTML = spec.html;
  fly.setAttribute('aria-label', spec.title);
  fly.classList.remove('out');
  fly.hidden = false;
  clearTimeout(flyTimer);
  // Listeyi açan düğmenin hizasına koy, görüntü alanından taşırma
  const rail = $('rail'), stage = $('stage');
  let top = rail.offsetTop + btn.offsetTop - 4;
  top = Math.max(8, Math.min(top, stage.clientHeight - fly.offsetHeight - 12));
  fly.style.top = top + 'px';
  flyOwner = btn;
  btn.setAttribute('aria-expanded', 'true');
  FL.Tip.hide();
  const cur = fly.querySelector('[aria-checked="true"]') || fly.querySelector('.fly-item');
  if (cur) cur.focus({ preventScroll: true });
}

function closeFly(now) {
  const fly = $('flyout');
  if (flyOwner) flyOwner.setAttribute('aria-expanded', 'false');
  const owner = flyOwner;
  flyOwner = null;
  if (fly.hidden) return;
  clearTimeout(flyTimer);
  if (now) { fly.hidden = true; return; }
  if (owner && fly.contains(document.activeElement)) owner.focus({ preventScroll: true });
  fly.classList.add('out');
  flyTimer = setTimeout(() => { fly.hidden = true; fly.classList.remove('out'); }, 130);
}

function syncRail() {
  const st = app.state;
  if (!st) return;
  const set = (id, txt) => { const el = $(id); if (el && el.textContent !== txt) el.textContent = txt; };
  const src = RAIL_SOURCES.find((x) => x.id === st.source);
  set('railSourceCap', src ? src.short : 'Kaynak');
  const pl = FL.PLACES.find((p) => FL.matchPlace(p, st));
  set('railPlaceCap', pl ? pl.short : 'Özel');
  const g = st.gravity;
  set('railGravityCap', g >= 0.995 && g <= 1.005 ? '1 g' : g < 1e-3 ? '0 g' : fmt(g, 2) + ' g');
  $('railGravity').setAttribute('aria-pressed', g < 0.05 ? 'true' : 'false');
  set('railViewCap', RAIL_VIEW_SHORT[st.view] || 'Görünüm');
  const md = FL.modelById(st.model);
  set('railModelCap', md ? md.short : 'Nesneler');
  const tl = FX_TOOLS.find((x) => x.id === st.fxTool);
  set('railToolCap', tl && tl.id !== 'none' ? tl.short : 'Yangın');
  const rt = $('railTool');
  if (rt) rt.classList.toggle('armed', !!tl && tl.id !== 'none');
  $('railFlam').setAttribute('aria-pressed', st.flamView ? 'true' : 'false');
  $('railAI').setAttribute('aria-pressed', st.view === 'ai' ? 'true' : 'false');
  // Sahnede nesne varken kaynak düğmesi kilitli görünür; senaryo etiketi sahneyi adlandırır
  $('railSource').classList.toggle('locked', !!md);
  if (app.preset) $('scnLabel').textContent = md && st.source === 'none' ? 'Sahne: ' + md.name : app.preset.name;
}

function bindRail() {
  document.querySelectorAll('#rail [data-fly]').forEach((b) => b.addEventListener('click', () => openFly(b)));
  $('railGravity').addEventListener('click', () => {
    onControl('gravity', app.state.gravity > 0.5 ? 0 : 1, 'live', false);
    toast('Yerçekimi ' + (app.state.gravity ? '1 g₀' : '0 g'));
    syncRail();
  });
  $('railChart').addEventListener('click', () => setChart($('chart').hidden));
  $('railFlam').addEventListener('click', () => setFlam(!app.state.flamView));
  $('railAI').addEventListener('click', toggleAI);
  $('railSettings').addEventListener('click', toggleInspector);
  const fly = $('flyout');
  fly.addEventListener('click', (e) => {
    const it = e.target.closest('.fly-item');
    if (!it || !flyOwner) return;
    const kind = flyOwner.dataset.fly;
    if (it.getAttribute('aria-disabled') === 'true') {
      toast(kind === 'model' ? 'Mekik seçiliyken başka nesne eklenemez. Önce mekiği kaldırın.' : 'Sahnede nesne varken deney düzeneği eklenemez. Önce nesneleri kaldırın (M › Hiçbiri).');
      return;
    }
    // Nesne listesi çoklu seçimdir: açık kalır, birkaç nesne art arda eklenip çıkarılabilir
    if (kind === 'model' && it.dataset.id !== 'none' && it.dataset.id !== 'cabin' && !FL.modelIds(app.state.model).includes('cabin')) {
      const id = it.dataset.id;
      applyFly(kind, id);
      fly.innerHTML = flyHTML(kind).html;
      const again = fly.querySelector('[data-id="' + id + '"]');
      if (again) again.focus({ preventScroll: true });
      return;
    }
    closeFly();
    applyFly(kind, it.dataset.id);
  });
  fly.addEventListener('keydown', (e) => {
    const items = [...fly.querySelectorAll('.fly-item')];
    const i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = items.length;
      items[(i + (e.key === 'ArrowDown' ? 1 : -1) + n) % n].focus();
    } else if (e.key === 'Home') { e.preventDefault(); items[0].focus(); }
    else if (e.key === 'End') { e.preventDefault(); items[items.length - 1].focus(); }
    else if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); closeFly(); }
    e.stopPropagation();
  });
  document.addEventListener('pointerdown', (e) => {
    if (!flyOwner) return;
    if (e.target.closest('#flyout') || e.target.closest('[data-fly]')) return;
    closeFly();
  }, true);
  window.addEventListener('resize', () => closeFly(true));
  syncRail();
}

/* ------------------------------------------------------------------ */
/* Sinematik mod: arayüz gizlenir, yalnız alev görünür                  */
/* ------------------------------------------------------------------ */
let cineIdle = 0;
function setCinema(on) {
  if (!!on === !!app.cine) return;
  app.cine = !!on;
  const root = $('app');
  root.classList.toggle('cine', app.cine);
  root.classList.remove('cine-idle');
  $('btnCine').setAttribute('aria-pressed', app.cine ? 'true' : 'false');
  clearTimeout(cineIdle);
  try {
    if (app.cine && document.documentElement.requestFullscreen && !document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => {});
    else if (!app.cine && document.fullscreenElement) document.exitFullscreen().catch(() => {});
  } catch (e) { /* tam ekran reddedildi: pencere içinde sinematik */ }
  // Yerleşim değişti: alanı yeniden çerçevele (canvas boyutu döngüde izlenir)
  setTimeout(() => fitCamera(true), 60);
  if (app.cine) {
    toast('Sinematik mod · çıkmak için K veya Esc');
    cineIdle = setTimeout(() => root.classList.add('cine-idle'), 2500);
  }
}

function cineWake() {
  if (!app.cine) return;
  const root = $('app');
  root.classList.remove('cine-idle');
  clearTimeout(cineIdle);
  cineIdle = setTimeout(() => root.classList.add('cine-idle'), 2500);
}

function setChart(on) {
  $('chart').hidden = !on;
  $('chartShow').hidden = on;
  $('railChart').setAttribute('aria-pressed', on ? 'true' : 'false');
  app.due.chart = 0;
  storageSet('fl-chart', on ? '1' : '0');
}

/* ------------------------------------------------------------------ */
/* Yerleşim: denetçi genişliği, gizleme, mobil alt sayfa                 */
/* ------------------------------------------------------------------ */
const mobile = () => window.matchMedia('(max-width: 820px)').matches;

function paintInspectorButtons(open) {
  $('btnInspector').setAttribute('aria-pressed', open ? 'true' : 'false');
  $('railSettings').setAttribute('aria-pressed', open ? 'true' : 'false');
}

function setInspector(open) {
  if (mobile()) {
    $('inspector').classList.toggle('open', open);
    $('inspector').inert = false;
    paintInspectorButtons(open);
    return;
  }
  $('app').classList.toggle('no-insp', !open);
  // Kapalı çekmecedeki denetimler sekme sırasına girmesin
  $('inspector').inert = !open;
  paintInspectorButtons(open);
}

function toggleInspector() {
  const open = mobile() ? !$('inspector').classList.contains('open') : $('app').classList.contains('no-insp');
  setInspector(open);
}

function setInspWidth(w) {
  const v = Math.round(FL.clamp(w, 280, Math.min(560, window.innerWidth * 0.5)));
  document.documentElement.style.setProperty('--insp-w', v + 'px');
  return v;
}

function restoreLayout() {
  const w = Number(storageGet('fl-insp-w'));
  if (w) setInspWidth(w);
  // Ayrıntılı ayarlar her açılışta kapalı gelir; temel denetimler soldaki paneldedir
  setInspector(false);
  const chartPref = storageGet('fl-chart');
  setChart(chartPref === null ? window.innerHeight > 620 : chartPref === '1');
}

function bindLayout() {
  const split = $('split');
  let drag = null;
  split.addEventListener('pointerdown', (e) => {
    drag = { x: e.clientX, w: $('inspector').getBoundingClientRect().width };
    split.setPointerCapture(e.pointerId);
    split.classList.add('active');
  });
  split.addEventListener('pointermove', (e) => { if (drag) setInspWidth(drag.w - (e.clientX - drag.x)); });
  const end = () => {
    if (!drag) return;
    drag = null;
    split.classList.remove('active');
    storageSet('fl-insp-w', String(parseInt(getComputedStyle(document.documentElement).getPropertyValue('--insp-w'), 10)));
  };
  split.addEventListener('pointerup', end);
  split.addEventListener('pointercancel', end);
  split.addEventListener('dblclick', () => { setInspWidth(340); storageSet('fl-insp-w', '340'); });
  split.addEventListener('keydown', (e) => {
    const cur = $('inspector').getBoundingClientRect().width;
    if (e.key === 'ArrowLeft') setInspWidth(cur + 16);
    else if (e.key === 'ArrowRight') setInspWidth(cur - 16);
    else return;
    e.preventDefault();
    storageSet('fl-insp-w', String(Math.round($('inspector').getBoundingClientRect().width)));
  });

  // Mobil alt sayfa: tutamaçla aç/kapa, sürükleyerek konumla
  const sheet = $('inspector');
  const grab = $('sheetGrab');
  let sd = null;
  const startSheet = (e) => {
    if (!mobile()) return;
    sd = { y: e.clientY, open: sheet.classList.contains('open'), moved: false, h: sheet.getBoundingClientRect().height };
    sheet.classList.add('dragging');
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const moveSheet = (e) => {
    if (!sd) return;
    const dy = e.clientY - sd.y;
    if (Math.abs(dy) > 4) sd.moved = true;
    const peek = 64;
    const base = sd.open ? 0 : sd.h - peek;
    const y = FL.clamp(base + dy, 0, sd.h - peek);
    sheet.style.transform = 'translateY(' + y + 'px)';
  };
  const endSheet = (e) => {
    if (!sd) return;
    const dy = e.clientY - sd.y;
    sheet.classList.remove('dragging');
    sheet.style.transform = '';
    let open = sd.open;
    if (!sd.moved) open = !open;
    else if (dy < -40) open = true;
    else if (dy > 40) open = false;
    sheet.classList.toggle('open', open);
    paintInspectorButtons(open);
    sd = null;
  };
  grab.addEventListener('pointerdown', startSheet);
  grab.addEventListener('pointermove', moveSheet);
  grab.addEventListener('pointerup', endSheet);
  grab.addEventListener('pointercancel', endSheet);
  // Sekmeye dokunmak kapalı sayfayı açar
  sheet.addEventListener('click', (e) => {
    if (mobile() && !sheet.classList.contains('open') && e.target.closest('.insp-head')) {
      sheet.classList.add('open');
      paintInspectorButtons(true);
    }
  });
}

/* ------------------------------------------------------------------ */
/* Görüntü alanı: döndürme, kaydırma, yakınlaştırma, dokunma             */
/* ------------------------------------------------------------------ */
/* ------------------------------------------------------------------ */
/* Sahne kamerası (Blender / Roblox Studio'daki kamera nesnesi gibi)    */
/* ------------------------------------------------------------------ */
const CAM_KEYS = ['camX', 'camY', 'camZ', 'camYaw', 'camPitch', 'camRoll', 'camFocal', 'camLook', 'camGizmo', 'camSet', 'camPhys'];
function camChanged(keys) {
  for (const k of keys) app.inspector.syncKey(k);
  if (app.renderer) app.renderer.warming = Math.max(app.renderer.warming, 10);
  scheduleHash();
}

/** Kamerayı editör görüşünün yerine ve yönüne koy */
function camAlignView() {
  const st = app.state, oc = app.renderer.camera;
  const e = oc.eye();
  st.camX = e[0]; st.camY = e[1]; st.camZ = e[2];
  st.camYaw = (oc.yaw * 180) / Math.PI;
  st.camPitch = FL.clamp((oc.pitch * 180) / Math.PI, -89, 89);
  st.camRoll = 0;
  st.camSet = true;
  camChanged(CAM_KEYS);
}

/** Kamerayı yerinde döndürüp alevin ışık merkezine (yoksa kaynağın üstüne) çevir */
function camAimFlame() {
  const st = app.state, sim = app.sim;
  const lp = app.renderer.light.cd > 0 ? app.renderer.light.pos : [sim.geo.anchor[0], sim.geo.anchor[1] + 0.012, sim.geo.anchor[2]];
  const d = [lp[0] - st.camX, lp[1] - st.camY, lp[2] - st.camZ];
  const h = Math.hypot(d[0], d[2]);
  // f = −(cos p sin y, sin p, cos p cos y)
  st.camYaw = (Math.atan2(-d[0], -d[2]) * 180) / Math.PI;
  st.camPitch = FL.clamp((Math.atan2(-d[1], h) * 180) / Math.PI, -89, 89);
  st.camSet = true;
  camChanged(['camYaw', 'camPitch', 'camSet']);
}

function camFocusDist() {
  const st = app.state, lp = app.renderer.light.pos;
  const d = Math.hypot(lp[0] - st.camX, lp[1] - st.camY, lp[2] - st.camZ);
  return FL.clamp(isFinite(d) ? d : 0.2, 0.02, 2);
}

/** Editör görüşünü, hem alan kutusu hem kamera nesnesi görünecek şekilde yerleştir */
function camFrameEditor() {
  const st = app.state, gr = app.sim.grid, oc = app.renderer.camera;
  const bc = [gr.Lx / 2, gr.Ly / 2, gr.Lz / 2];
  const cp = [st.camX, st.camY, st.camZ];
  const sep = Math.hypot(cp[0] - bc[0], cp[1] - bc[1], cp[2] - bc[2]);
  const mid = bc.map((v, i) => 0.5 * (v + cp[i]));
  // Kameranın arkasından ve yanından bak (üçüncü şahıs): görüş piramidi alana doğru açılır
  const yawCam = (st.camYaw * Math.PI) / 180;
  oc._goal = {
    yaw: yawCam + 0.8, pitch: 0.42,
    dist: Math.max(1.45 * sep + 0.5 * Math.max(gr.Lx, gr.Ly, gr.Lz), oc.dist),
    target: mid,
  };
  oc.maxDist = Math.max(oc.maxDist, oc._goal.dist * 1.5);
}

/* Sahne kamerası eylemsizliği: fare girdisi hıza eklenir, her karede sönümlenerek uygulanır */
const camV = { yaw: 0, pitch: 0, focal: 0, p: [0, 0, 0] };
function camVActive() {
  return Math.abs(camV.yaw) + Math.abs(camV.pitch) > 1e-3 || Math.abs(camV.focal) > 1e-5
    || Math.abs(camV.p[0]) + Math.abs(camV.p[1]) + Math.abs(camV.p[2]) > 1e-7;
}
function camVUpdate(dt) {
  if (!camVActive()) { camV.yaw = camV.pitch = camV.focal = 0; camV.p.fill(0); return; }
  const st = app.state, k = Math.exp(-dt * 10), a = 1 - k, keys = [];
  if (camV.yaw || camV.pitch) {
    st.camYaw += camV.yaw * a;
    st.camPitch = FL.clamp(st.camPitch + camV.pitch * a, -89, 89);
    if (st.camYaw > 180) st.camYaw -= 360; else if (st.camYaw < -180) st.camYaw += 360;
    keys.push('camYaw', 'camPitch');
  }
  if (camV.focal) { st.camFocal = FL.clamp(st.camFocal * Math.exp(camV.focal * a), 8, 300); keys.push('camFocal'); }
  if (camV.p[0] || camV.p[1] || camV.p[2]) {
    st.camX += camV.p[0] * a; st.camY += camV.p[1] * a; st.camZ += camV.p[2] * a;
    keys.push('camX', 'camY', 'camZ');
  }
  camV.yaw *= k; camV.pitch *= k; camV.focal *= k;
  for (let i = 0; i < 3; i++) camV.p[i] *= k;
  if (keys.length) camChanged(keys);
}

function toggleCamLook() {
  const st = app.state;
  if (!st.camPhys) { onControl('camPhys', true, 'live', false); return; }
  onControl('camLook', !st.camLook, 'live', false);
  toast(st.camLook ? 'Kameradan bakılıyor (0)' : 'Editör görünümü · kamera nesnesini taşıyın');
}

function bindStage() {
  const stage = $('stage');
  const canvas = $('gl');
  const pts = new Map();
  let mode = null;
  let pinch = null;
  const cam = () => app.renderer.camera;

  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    canvas.focus({ preventScroll: true });
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    hideCoach();
    const st = app.state;
    if (pts.size === 1) {
      const panBtn = e.button === 2 || e.button === 1 || e.shiftKey;
      if (st.camPhys && st.camLook) {
        // Kameradan bakarken fare sahne kamerasını yönetir (Blender: kamerayı görünüme kilitle)
        mode = panBtn ? 'camPan' : 'camRot';
      } else {
        const r = canvas.getBoundingClientRect();
        const hit = st.camPhys && e.button === 0 && app.overlay.pickGizmo ? app.overlay.pickGizmo(e.clientX - r.left, e.clientY - r.top) : null;
        if (hit) { mode = 'gizmo'; app.gizmoDrag = hit; app.overlay.active = hit; }
        else mode = panBtn ? 'pan' : 'rotate';
      }
      stage.classList.add(mode === 'pan' || mode === 'camPan' ? 'panning' : 'dragging');
    } else if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
      mode = 'pinch';
    }
  });
  canvas.addEventListener('pointermove', (e) => {
    const p = pts.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    const st = app.state;
    if (mode === 'rotate') cam().drag(dx, dy);
    else if (mode === 'pan') cam().pan(dx, dy, canvas.clientHeight);
    else if (mode === 'camRot') {
      camV.yaw -= dx * 0.15;
      camV.pitch += dy * 0.15;
    } else if (mode === 'camPan') {
      const B = FL.sceneCamBasis(st);
      const fov = app.renderer.sceneFov || 0.5;
      const k = (2 * camFocusDist() * Math.tan(fov / 2)) / Math.max(canvas.clientHeight, 1);
      for (let i = 0; i < 3; i++) camV.p[i] += (-dx * B.rt[i] + dy * B.up[i]) * k;
    } else if (mode === 'gizmo') {
      const g = app.gizmoDrag;
      if (g.type === 'axis') {
        // Ekranda izdüşen eksen yönündeki fare hareketi → eksen boyunca metre
        const along = (dx * g.dir[0] + dy * g.dir[1]) / Math.max(g.ppm, 1e-6);
        const key = ['camX', 'camY', 'camZ'][g.axis];
        st[key] += along;
        camChanged([key]);
      } else if (g.type === 'dolly') {
        // Bakış yönünde ileri/geri
        const along = (dx * g.dir[0] + dy * g.dir[1]) / Math.max(g.ppm, 1e-6);
        const B = FL.sceneCamBasis(st);
        st.camX += B.f[0] * along; st.camY += B.f[1] * along; st.camZ += B.f[2] * along;
        camChanged(['camX', 'camY', 'camZ']);
      } else if (g.type === 'fov') {
        // Köşe tutamacı: dışa çekmek görüş açısını büyütür (odak kısalır), içe itmek küçültür.
        // Köşe ekranda fareyi izlesin diye yarıçap oranı kadar odak değişir (köşe ∝ 1/f).
        const along = dx * g.dir[0] + dy * g.dir[1];
        const R1 = Math.max(g.R + along, 4);
        const f1 = FL.clamp((st.camFocal * g.R) / R1, 8, 300);
        g.R = (g.R * st.camFocal) / f1;
        st.camFocal = f1;
        camChanged(['camFocal']);
      } else if (g.type === 'free') {
        // Serbest taşıma: editör görüş düzleminde, fare imlecini izleyerek
        const oc = cam(), E = oc.eye();
        const fw = [oc.target[0] - E[0], oc.target[1] - E[1], oc.target[2] - E[2]];
        const fl = Math.hypot(fw[0], fw[1], fw[2]) || 1;
        for (let i = 0; i < 3; i++) fw[i] /= fl;
        let rx = -fw[2], rz = fw[0];
        const rl = Math.hypot(rx, rz) || 1; rx /= rl; rz /= rl;
        const up = [-rz * fw[1], rz * fw[0] - rx * fw[2], rx * fw[1]]; // up = rt × fw
        const depth = (st.camX - E[0]) * fw[0] + (st.camY - E[1]) * fw[1] + (st.camZ - E[2]) * fw[2];
        const k = (2 * Math.max(depth, 1e-3) * Math.tan(oc.fov / 2)) / Math.max(canvas.clientHeight, 1);
        st.camX += (dx * rx - dy * up[0]) * k;
        st.camY += (-dy * up[1]) * k;
        st.camZ += (dx * rz - dy * up[2]) * k;
        camChanged(['camX', 'camY', 'camZ']);
      } else if (g.type === 'yaw') {
        st.camYaw -= dx * 0.4;
        if (st.camYaw > 180) st.camYaw -= 360; else if (st.camYaw < -180) st.camYaw += 360;
        camChanged(['camYaw']);
      } else if (g.type === 'pitch') {
        st.camPitch = FL.clamp(st.camPitch - dy * 0.4, -89, 89);
        camChanged(['camPitch']);
      } else if (g.type === 'roll') {
        st.camRoll = FL.clamp(st.camRoll + dx * 0.4, -180, 180);
        camChanged(['camRoll']);
      }
      st.camSet = true;
    }
    else if (mode === 'pinch' && pts.size >= 2) {
      const [a, b] = [...pts.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      if (pinch.d > 0 && d > 0) cam().zoom(-Math.log(d / pinch.d) * 1.2);
      cam().pan(mx - pinch.mx, my - pinch.my, canvas.clientHeight);
      pinch = { d, mx, my };
    }
  });
  const end = (e) => {
    pts.delete(e.pointerId);
    if (pts.size === 1 && mode === 'pinch') { mode = 'rotate'; }
    if (pts.size === 0) { mode = null; stage.classList.remove('dragging', 'panning'); app.gizmoDrag = null; if (app.overlay) app.overlay.active = null; }
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    hideCoach();
    // Satır ve sayfa kipini piksele çevir; dokunmatik yüzey kıstırması (ctrl) daha duyarlı
    let dy = e.deltaY;
    if (e.deltaMode === 1) dy *= 16;
    else if (e.deltaMode === 2) dy *= canvas.clientHeight;
    const st = app.state;
    if (st.camPhys && st.camLook) {
      if (e.ctrlKey || e.altKey) {
        // Optik yakınlaştırma: odak uzaklığı
        camV.focal -= FL.clamp(dy * 0.002, -0.4, 0.4);
      } else {
        // Kamerayı bakış yönünde ileri/geri götür (dolly)
        const B = FL.sceneCamBasis(st);
        const m = -FL.clamp(dy * 0.0015, -0.4, 0.4) * camFocusDist();
        for (let i = 0; i < 3; i++) camV.p[i] += B.f[i] * m;
      }
      return;
    }
    const k = e.ctrlKey ? 0.01 : 0.0015;
    cam().zoom(FL.clamp(dy * k, -0.5, 0.5));
  }, { passive: false });
  canvas.addEventListener('dblclick', () => {
    if (app.state.camPhys && app.state.camLook) { camAimFlame(); toast('Kamera aleve çevrildi'); }
    else fitCamera(true);
  });
  // Yanıcılık modülü: imleç altındaki parça (ipucu) ve tıklayınca seçim
  let down = null, hoverRaf = 0, hoverAt = null;
  const tip = $('flamTip');
  const flamOn = () => app.state.flamView && app.renderer.modelActive(app.state) && !(app.state.camPhys && app.state.camLook);
  // Yapay zekâ görünümü: imleç altındaki parçanın tahmini, tıklayınca hedef seçimi
  const aiOn = () => app.state.view === 'ai' && FL.AI.ready && app.renderer.modelActive(app.state) && !(app.state.camPhys && app.state.camLook);
  canvas.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, b: e.button, sh: e.shiftKey }; hideFlamTip(); });
  canvas.addEventListener('pointerup', (e) => {
    const d = down;
    down = null;
    if (!d || d.b !== 0 || d.sh) return;
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) return;
    // Yangın aracı seçiliyse tıklama onu uygular (sürükleme yine görünümü döndürür)
    if (app.state.fxTool && app.state.fxTool !== 'none') {
      const rc = canvas.getBoundingClientRect();
      fxApplyTool(app.state.fxTool, fxPoint(e.clientX - rc.left, e.clientY - rc.top));
      return;
    }
    if (aiOn()) {
      const r = canvas.getBoundingClientRect();
      const id = pickPart(e.clientX - r.left, e.clientY - r.top);
      app.ai.select(id);
      app.renderer.model.setSelection(id >= 0 ? [id] : []);
      app.ai.update(app.renderer.model, app.state, app.fx);
      app.renderer.warming = Math.max(app.renderer.warming, 4);
      return;
    }
    if (!flamOn()) return;
    const r = canvas.getBoundingClientRect();
    const id = pickPart(e.clientX - r.left, e.clientY - r.top);
    if (id >= 0) app.flam.selectPart(id);
    else app.flam.clear();
    app.flam.update(app.renderer.model, app.state);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (pts.size || !(flamOn() || aiOn())) { if (!tip.hidden) hideFlamTip(); return; }
    const r = canvas.getBoundingClientRect();
    hoverAt = [e.clientX - r.left, e.clientY - r.top];
    if (hoverRaf) return;
    hoverRaf = requestAnimationFrame(() => {
      hoverRaf = 0;
      if (!hoverAt || !(flamOn() || aiOn())) return;
      const [x, y] = hoverAt;
      const id = pickPart(x, y);
      const ms = app.renderer.model;
      if (ms.setHover(id)) app.renderer.warming = Math.max(app.renderer.warming, 3);
      if (id < 0) { hideFlamTip(); return; }
      tip.innerHTML = aiOn() ? FL.aiTipHTML(ms.parts[id], app.state, app.fx) : FL.flamTipHTML(ms.parts[id], app.state);
      tip.hidden = false;
      const sw = stage.clientWidth, sh = stage.clientHeight;
      const tw = tip.offsetWidth, th = tip.offsetHeight;
      tip.style.left = Math.min(x + 14, sw - tw - 8) + 'px';
      tip.style.top = Math.max(8, Math.min(y + 16, sh - th - 8)) + 'px';
    });
  });
  canvas.addEventListener('pointerleave', () => {
    hoverAt = null;
    hideFlamTip();
    if (app.renderer.model.setHover(-1)) app.renderer.warming = Math.max(app.renderer.warming, 3);
  });
  // İmleç tutamaç üzerindeyken değişsin
  canvas.addEventListener('pointermove', (e) => {
    if (pts.size || !app.state.camPhys || app.state.camLook || !app.overlay.pickGizmo) return;
    const r = canvas.getBoundingClientRect();
    const hit = app.overlay.pickGizmo(e.clientX - r.left, e.clientY - r.top);
    const key = hit ? hit.type + (hit.axis ?? '') : '';
    if (key !== app.overlay.hoverKey) { app.overlay.hover = hit; app.overlay.hoverKey = key; app.renderer.warming = Math.max(app.renderer.warming, 2); }
    canvas.style.cursor = hit ? 'pointer' : '';
  });
}

/* ------------------------------------------------------------------ */
/* Klavye                                                               */
/* ------------------------------------------------------------------ */
function bindKeys() {
  window.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    if (t.closest && t.closest('input:not([type=range]):not([type=checkbox]), textarea, select, [contenteditable="true"]')) return;
    if (document.querySelector('dialog[open]')) return;
    const k = e.key;
    const onBtn = t.closest && t.closest('button, [role=radio]');
    if (k === ' ') {
      // Klavye ile odaklanmış bir düğmede Boşluk düğmeyi çalıştırır; fareyle tıklanmışsa duraklatır
      if (onBtn && onBtn.matches(':focus-visible')) return;
      e.preventDefault();
      togglePause();
      return;
    }
    if (e.repeat && k.toLowerCase() !== 's' && k.toLowerCase() !== 't') return;
    const lk = k.toLowerCase();
    if (lk === 'i') ignite();
    else if (lk === 's') { if (!e.repeat) setSuppress(true); }
    else if (lk === 't') { if (!e.repeat) setSmother(true); }
    else if (lk === 'r') resetField('Alan sıfırlandı');
    else if (k === '0') toggleCamLook();
    else if (lk === 'w' && app.state.camPhys) { onControl('camGizmo', 'move', 'live', false); toast('Kamera aracı: Taşı'); }
    else if (lk === 'e' && app.state.camPhys) { onControl('camGizmo', 'rotate', 'live', false); toast('Kamera aracı: Döndür'); }
    else if (lk === 'q' && app.state.camPhys) { onControl('camGizmo', 'zoom', 'live', false); toast('Kamera aracı: Ölçekle (görüş açısı)'); }
    else if (k === '.') stepFrame();
    else if (lk === 'v') {
      const ids = FL.VIEW_MODES.map((m) => m.id);
      const v = ids[(ids.indexOf(app.state.view) + 1) % ids.length];
      onControl('view', v, 'live', false);
      toast(FL.VIEW_MODES.find((m) => m.id === v).name);
    } else if (k >= '1' && k <= '9') {
      const m = FL.VIEW_MODES[Number(k) - 1];
      onControl('view', m.id, 'live', false);
      toast(m.name);
    } else if (lk === 'g') {
      onControl('gravity', app.state.gravity > 0.5 ? 0 : 1, 'live', false);
      toast('Yerçekimi ' + (app.state.gravity ? '1 g₀' : '0 g'));
    } else if (lk === 'f') fitCamera(true);
    else if (lk === 'c') setChart($('chart').hidden);
    else if (lk === 'h') toggleInspector();
    else if (lk === 'k') setCinema(!app.cine);
    else if (k === 'Escape' && app.cine) setCinema(false);
    else if (lk === 'p') app.wantShot = true;
    else if (lk === 'o') openScenarios();
    else if (lk === 'd') toggleProfiler();
    else if (lk === 'm') openFly($('railModel'));
    else if (lk === 'n') openFly($('railTool'));
    else if (lk === 'x') fxAction('act-blast');
    else if (lk === 'b') {
      const orbit = app.renderer.orbitBackdrop(app.state);
      onControl('backdrop', orbit ? 'lab' : 'orbit', 'live', false);
      toast(orbit ? 'Arka plan: deney odası' : 'Arka plan: yörünge (Dünya ve yıldızlar)');
    }
    else if (k === 'Escape' && app.state.fxTool !== 'none') setFxTool('none');
    else if (lk === 'y') setFlam(!app.state.flamView);
    else if (lk === 'a') toggleAI();
    else if (k === '?') openDialog('dlgKeys');
    else return;
    e.preventDefault();
  });
  window.addEventListener('mousemove', cineWake, { passive: true });
  window.addEventListener('keyup', (e) => { const kk = e.key.toLowerCase(); if (kk === 's') setSuppress(false); if (kk === 't') setSmother(false); });
  window.addEventListener('blur', () => { setSuppress(false); setSmother(false); });
}

/* ------------------------------------------------------------------ */
/* İletişim kutuları                                                    */
/* ------------------------------------------------------------------ */
function openDialog(id) {
  const d = $(id);
  if (d.open) return;
  d.showModal();
}

function bindDialogs() {
  document.querySelectorAll('dialog').forEach((d) => {
    d.addEventListener('click', (e) => {
      if (e.target === d) d.close();
      if (e.target.closest('[data-close]')) d.close();
    });
  });
  const search = $('scnSearch');
  search.addEventListener('input', () => renderScenarioList(search.value));
  search.addEventListener('keydown', (e) => {
    const items = [...$('scnList').querySelectorAll('.scn-item')];
    if (!items.length) return;
    let i = items.findIndex((x) => x.classList.contains('kb'));
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      i = e.key === 'ArrowDown' ? Math.min(items.length - 1, i + 1) : Math.max(0, i - 1);
      items.forEach((x, j) => x.classList.toggle('kb', j === i));
      items[i].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      (items[i] || items[0]).click();
    }
  });
}

function openScenarios() {
  const d = $('dlgScenarios');
  $('scnSearch').value = '';
  renderScenarioList('');
  d.showModal();
  $('scnSearch').focus();
  const cur = $('scnList').querySelector('[aria-selected="true"]');
  if (cur) cur.scrollIntoView({ block: 'center' });
}

function renderScenarioList(q) {
  const list = $('scnList');
  // Sözcük başı eşleşme; "0 g", "1 g" gibi ifadeler tek sözcük sayılır ("0 g" artık "%21,0" ile eşleşmez)
  const norm = (s) => s.toLocaleLowerCase('tr').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ı/g, 'i').replace(/(\d)\s+g\b/g, '$1g');
  const words = (s) => norm(s).split(/[\s,;:()·/%"'’]+/).filter(Boolean);
  const terms = words(q || '');
  const groups = {};
  for (const p of FL.PRESETS) {
    const tags = FL.presetTags(p);
    const g = p.set.gravity;
    const gWord = g === 0 ? '0 g mikrogravite' : Math.abs(g - 1) < 0.005 ? '1 g' : '';
    const hay = words(p.name + ' ' + p.group + ' ' + p.desc + ' ' + tags.join(' ') + ' ' + gWord);
    if (terms.length && !terms.every((t) => hay.some((w) => w.startsWith(t)))) continue;
    (groups[p.group] = groups[p.group] || []).push({ p, tags });
  }
  list.innerHTML = '';
  const keys = Object.keys(groups);
  if (!keys.length) {
    list.innerHTML = '<div class="scn-empty">Eşleşen senaryo yok</div>';
    return;
  }
  let first = true;
  for (const g of keys) {
    const gh = document.createElement('div');
    gh.className = 'scn-gh';
    gh.textContent = g;
    list.appendChild(gh);
    for (const { p, tags } of groups[g]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'scn-item' + (terms.length && first ? ' kb' : '');
      first = false;
      b.setAttribute('role', 'option');
      b.setAttribute('aria-selected', p.id === app.preset.id ? 'true' : 'false');
      b.innerHTML = '<span class="scn-item-name"></span>' + (p.id === app.preset.id ? '<span class="scn-item-cur">Geçerli</span>' : '<span></span>') +
        '<span class="scn-item-desc"></span><span class="scn-item-tags">' + tags.map((t) => '<span class="tag">' + t + '</span>').join('') + '</span>';
      b.querySelector('.scn-item-name').textContent = p.name;
      b.querySelector('.scn-item-desc').textContent = p.desc;
      b.addEventListener('click', () => {
        $('dlgScenarios').close();
        loadPreset(p.id);
        toast(p.name);
      });
      list.appendChild(b);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Dışa aktarma: ekran görüntüsü, CSV, bağlantı                         */
/* ------------------------------------------------------------------ */
// claude.ai'de yayınlanmış sayfada dosya, platformun indirme onayıyla verilir;
// yerel dosyada (ya da başka bir sunucuda) doğrudan bağlantıyla indirilir.
let downloadsNs;
function downloadsCapability() {
  if (downloadsNs !== undefined) return Promise.resolve(downloadsNs);
  if (!(window.claude && typeof window.claude.use === 'function')) { downloadsNs = null; return Promise.resolve(null); }
  return window.claude.use('downloads').then((d) => (downloadsNs = d || null), () => (downloadsNs = null));
}

function download(blob, name) {
  downloadsCapability().then((dl) => {
    if (!dl) { anchorDownload(blob, name); return; }
    dl.save({ filename: name, data: blob }).catch((e) => {
      if (e && e.code === 'declined') return;
      if (e && e.code === 'rate_limited') { toast('Bir indirme onayı zaten açık'); return; }
      anchorDownload(blob, name);
    });
  });
}

function anchorDownload(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function fileStem() {
  return 'alev-' + app.preset.id + '-t' + app.sim.simTime.toFixed(2).replace('.', '_') + 's';
}

/** Çizimden hemen sonra çağrılır: WebGL arabelleği henüz geçerliyken kopyalanır */
function captureShot() {
  const gl = $('gl'), ov = $('overlay');
  const W = gl.width, H = gl.height;
  const dpr = W / Math.max(gl.clientWidth, 1);
  const cap = Math.round(46 * dpr);
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H + cap;
  const x = c.getContext('2d');
  x.drawImage(gl, 0, 0);
  x.drawImage(ov, 0, 0, W, H);
  x.fillStyle = '#0d1117';
  x.fillRect(0, H, W, cap);
  x.fillStyle = 'rgba(255,255,255,0.08)';
  x.fillRect(0, H, W, Math.max(1, Math.round(dpr)));
  const s = app.sim.stats, st = app.state;
  const view = FL.VIEW_MODES.find((m) => m.id === st.view);
  x.textBaseline = 'middle';
  x.font = '600 ' + Math.round(13 * dpr) + 'px "Barlow", system-ui, sans-serif';
  x.fillStyle = 'rgba(255,255,255,0.92)';
  const pad = Math.round(14 * dpr);
  x.fillText(app.preset.name, pad, H + cap * 0.36);
  x.font = '500 ' + Math.round(11 * dpr) + 'px "JetBrains Mono", ui-monospace, monospace';
  x.fillStyle = 'rgba(235,235,245,0.62)';
  const meta = [
    't = ' + fmt(app.sim.simTime, 4) + ' s',
    'g = ' + FL.gravityText(st.gravity) + ' g₀',
    'O₂ %' + fmt(st.o2, 3),
    fmt(st.pressure, 4) + ' kPa',
    s.valid ? 'HRR ' + fmt(s.hrr, 3) + ' W' : '',
    s.valid ? 'T maks ' + fmt(s.Tmax, 4) + ' K' : '',
    view ? view.name : '',
  ].filter(Boolean).join('   ·   ');
  x.fillText(meta, pad, H + cap * 0.72);
  x.textAlign = 'right';
  x.fillStyle = 'rgba(235,235,245,0.38)';
  x.fillText('Mikrogravite Alev Laboratuvarı', W - pad, H + cap * 0.36);
  c.toBlob((b) => { if (b) { download(b, fileStem() + '.png'); toast('Ekran görüntüsü kaydedildi'); } }, 'image/png');
}

function downloadCSV() {
  if (!app.sim.history.length) { toast('Henüz kayıt yok'); return; }
  download(new Blob(['\ufeff' + app.sim.historyCSV()], { type: 'text/csv;charset=utf-8' }), 'alev-' + app.preset.id + '-zaman-serisi.csv');
  toast('CSV indirildi (' + app.sim.history.length + ' satır)');
}

function copyCSV() {
  if (!app.sim.history.length) { toast('Henüz kayıt yok'); return; }
  const csv = app.sim.historyCSV();
  const ok = () => toast('CSV panoya kopyalandı (' + app.sim.history.length + ' satır)');
  if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(csv).then(ok, () => downloadCSV());
  else downloadCSV();
}

function shareLink() {
  const url = location.origin + location.pathname + encodeState();
  try { history.replaceState(null, '', encodeState()); } catch (e) { /* yok say */ }
  const ok = () => toast('Bağlantı kopyalandı: deney ayarları dahil');
  if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(url).then(ok, () => toast('Bağlantı adres çubuğunda'));
  else toast('Bağlantı adres çubuğunda');
}

/* ------------------------------------------------------------------ */
/* Kuram ve durum tabloları                                             */
/* ------------------------------------------------------------------ */
function updateTheory() {
  const sim = app.sim;
  const st = app.state;
  const ph = sim.phys;
  const s = sim.stats;
  const rho = FL.density(ph.P, st.Tamb, ph.amb.W);
  const alpha = FL.thermalDiffusivity(st.Tamb, ph.P, ph.amb);
  const L = sim.geo.charL || 0.005;
  const dim = FL.dimensionless({ g: st.gravity * FL.C.G0, L, U: Math.max(sim.geo.charU || 0, st.flow / 100), Tf: Math.max(s.valid ? s.Tmax : ph.Tad, st.Tamb + 10), Tinf: st.Tamb, P: ph.P, amb: ph.amb });
  const rows = [
    ['Adyabatik alev sıcaklığı T_ad', fmt(ph.Tad, 4) + ' K'],
    ['Stokiyometrik karışım kesri Z_st', fmt(ph.Zst, 3)],
    ['Ortam O₂ kütle kesri', fmt(ph.amb.Yo, 3)],
    ['Ortam yoğunluğu ρ∞', fmt(rho, 3) + ' kg/m³'],
    ['Isıl yayınım α∞', fmt(alpha * 1e6, 3) + ' mm²/s'],
    ['Grashof Gr', fmt(dim.Gr, 3)],
    ['Reynolds Re', fmt(dim.Re, 3)],
    ['Froude Fr', isFinite(dim.Fr) ? fmt(dim.Fr, 3) : '∞'],
    ['Rejim', dim.regime],
  ];
  if (st.source === 'droplet' && sim.droplet) {
    const d = sim.droplet;
    const fit = app.chart.d2Fit(sim);
    rows.push(['Spalding B', fmt(d.B, 3)]);
    rows.push(['K anlık (B ve taşınım)', fmt(d.K * 1e6, 3) + ' mm²/s']);
    rows.push(['K, d² eğiminden', fit ? fmt(-fit.b, 3) + ' mm²/s' : '—']);
    rows.push(['r_f/r_s kuram', d.rRatio ? fmt(d.rRatio, 3) : '—']);
    rows.push(['Durum', d.alive ? (d.hot ? 'Sıcak alev' : d.cool ? 'Soğuk alev' : 'Buharlaşma') : 'Tükendi']);
  }
  if (st.source === 'sheet') {
    rows.push(['Cephe yayılma hızı', isFinite(sim.spread) ? fmt(sim.spread, 3) + ' mm/s' : '—']);
    rows.push(['Akış yönü', st.sheetIgnTop ? 'Karşı akış (aşağı)' : 'Eş yönlü (yukarı)']);
  }
  if (st.source === 'jet') {
    const Q = Math.PI * Math.pow((st.nozzleD * 1e-3) / 2, 2) * (st.jetU / 100);
    rows.push(['Yakıt hacimsel debisi', fmt(Q * 1e6 * 60, 3) + ' cm³/dk']);
    // Roper (1977) dairesel nozul: L_f ≈ 1330 Q (T∞/T_F) / ln(1 + 1/S), Q [m³/s]
    const S = (ph.fuel.s * ph.fuel.W) / FL.C.W_O2 / ph.amb.xO2 / Math.max(1 - st.fuelDilution / 100, 0.05);
    const Lroper = (1330 * Q * (1 - st.fuelDilution / 100)) / Math.log(1 + 1 / Math.max(S, 1e-3));
    rows.push(['Alev boyu (Roper, 1 g)', fmt(Lroper * 1000, 3) + ' mm']);
    rows.push(['Alev boyu (benzetim)', s.valid && s.flameH > 0 ? fmt(s.flameH * 1000, 3) + ' mm' : '—']);
  }
  rows.push(['Hücre boyu Δx', fmt(sim.grid.dx * 1000, 3) + ' mm']);
  app.inspector.setKV('theoryKV', rows);

  const plan = sim.lastPlan || {};
  const r = app.renderer;
  app.inspector.setKV('solverInfo', [
    ['Izgara', sim.grid.NX + '×' + sim.grid.NY + '×' + sim.grid.NZ + ' (' + fmt(sim.grid.cells / 1000, 3) + ' bin)'],
    ['Atlas dokusu', sim.grid.W + '×' + sim.grid.H],
    ['Δt × alt adım', fmt((plan.dt || 0) * 1000, 3) + ' ms × ' + (plan.n || 0)],
    ['Δt sınırı CFL / difüzyon', fmt((plan.dtCfl || 0) * 1000, 2) + ' / ' + fmt((plan.dtDiff || 0) * 1000, 2) + ' ms'],
    ['Difüzyon alt adımı', String(sim.lastDiffSub || '—')],
    ['Kinetik verim katsayısı', '×' + fmt(sim.phys.kinEff, 3)],
    ['Görüntü çözünürlüğü', r.hdr ? r.hdr.w + '×' + r.hdr.h + (app.state.adaptive && r.adaptiveScale < 1 ? ' (uyarlamalı ×' + fmt(r.adaptiveScale, 2) + ')' : '') : '—'],
    ['Kare hızı', fmt(app.fps, 3) + ' fps · hedef ' + Math.round(app.gov.target) + (app.gov._refreshMs > 0 ? '' : ' (ölçülüyor)')],
    ['Kalite seviyesi', app.gov.level.name + (app.state.adaptive ? ' (otomatik)' : ' (sabit)') + ' · ' + Math.round(Math.max(1, app.state.maxSub * (app.state.realTime ? 1 : app.gov.level.sub)) * 60) + ' alt adım/s'],
    ['Yangın efektleri', app.fx.stats.cells ? fmt(app.fx.stats.cells / 1000, 3) + ' bin hücre · ' + app.fx.stats.bodies + ' gövde · ' + app.fx.stats.particles + ' parçacık' : 'sahne nesnesi yok · ' + app.fx.stats.particles + ' parçacık'],
    ['Doku duyarlılığı', app.glc.float32RT ? '32 bit' : '16 bit'],
    ['GPU', String(app.glc.renderer).replace(/^ANGLE \((.*)\)$/, '$1').slice(0, 42)],
  ]);
  const hc = document.getElementById('histCount');
  if (hc) {
    const hh = sim.history;
    hc.textContent = hh.length ? hh.length + ' örnek · ' + fmt(hh[0].t, 3) + '–' + fmt(hh[hh.length - 1].t, 3) + ' s' : 'Kayıt yok';
  }
}

/* Araç çubuğunun altındaki alev durumu şeridi (bkz. app.css .toolbar::after) */
let lastBand = '';
function paintBand(sim, state) {
  let band = 'transparent';
  const s = sim.stats;
  if (sim.quenching && sim.quenching()) band = 'linear-gradient(90deg, transparent, rgba(255,90,78,0.9) 30%, rgba(255,90,78,0.9) 70%, transparent)';
  else if (sim.smothering && sim.smothering()) band = 'linear-gradient(90deg, transparent, rgba(220,232,255,0.85) 30%, rgba(220,232,255,0.85) 70%, transparent)';
  else if (state === 'on' && s.valid) {
    const c = FL.blackbodyCSS(FL.clamp(s.Tmax, 1000, 3200)).map((v) => Math.round(v * 255)).join(',');
    band = 'linear-gradient(90deg, transparent, rgba(' + c + ',0.95) 30%, rgba(' + c + ',0.95) 70%, transparent)';
  } else if (state === 'cool') band = 'linear-gradient(90deg, transparent, rgba(111,211,255,0.7) 30%, rgba(111,211,255,0.7) 70%, transparent)';
  if (band !== lastBand) {
    lastBand = band;
    document.documentElement.style.setProperty('--band', band);
  }
}

let lastStatus = '';
function updateStatus() {
  const sim = app.sim;
  const s = sim.stats;
  const d = sim.droplet;
  let state = 'none', txt = 'Alev yok';
  const lastIgn = [...sim.events].reverse().find((e) => e.kind === 'ignite');
  const extinct = sim.events.some((e) => e.kind === 'extinct' && (!lastIgn || e.id > lastIgn.id));
  if (sim.flameOn) { state = 'on'; txt = 'Alev · ' + fmt(s.hrr, 3) + ' W' + (sim.ignTimer > 0 ? ' · tel açık' : ''); }
  else if (s.valid && s.cool > 0.002) { state = 'cool'; txt = 'Soğuk alev'; }
  else if (d && !d.alive) { state = 'out'; txt = 'Damla tükendi'; }
  else if (extinct) { state = 'out'; txt = 'Söndü'; }
  else if (sim.ignTimer > 0) { state = 'none'; txt = 'Tutuşturuluyor'; }
  const fxs = app.fx && app.fx.stats;
  if (fxs && fxs.burningCells > 0) {
    txt = (sim.flameOn ? txt.replace(/ · tel açık/, '') + ' + ' : '') + 'Yangın · ' + fmt(fxs.heatKW, 3) + ' kW';
    if (state !== 'on') state = 'fire';
  }
  if (app.paused) txt = 'Duraklatıldı · ' + txt.replace(/ · .*/, '');
  const el = $('status');
  el.dataset.state = app.paused ? 'paused' : state;
  paintBand(sim, state);
  $('statusTxt').textContent = txt;
  const key = state + (app.paused ? 'p' : '');
  if (key !== lastStatus) {
    lastStatus = key;
    announce(txt.replace(/ · [\d,.]+ W/, ''));
  }
  syncRail();
  $('tcTime').textContent = sim.simTime.toFixed(3).replace('.', ',');
  paintSuppress();
  $('tcRate').textContent = '×' + fmt(app.simRate, 2) + ' · ' + Math.round(app.fps) + ' fps';
}

function checkEvents() {
  const ev = app.sim.events;
  for (const e of ev) {
    if (e.id <= app.lastEventId) continue;
    app.lastEventId = e.id;
    if (e.kind === 'ignite') continue;
    toast(e.label + ' · t = ' + fmt(e.t, 3) + ' s');
  }
}

/* ------------------------------------------------------------------ */
/* GPU profili                                                          */
/* ------------------------------------------------------------------ */
function toggleProfiler() {
  const p = app.glc.prof;
  app.glc.profEnable(!p.on);
  if (!p.on) app.inspector.setKV('perfInfo', []);
  toast(p.on ? 'GPU profili açık (' + (p.mode === 'timer' ? 'zamanlayıcı sorgusu' : 'yedek: gl.finish') + ')' : 'GPU profili kapalı');
}

function updatePerf() {
  const p = app.glc.prof;
  if (!p.on) return;
  const rep = p.report;
  if (!rep) { app.inspector.setKV('perfInfo', [['Ölçüm', 'toplanıyor…']]); return; }
  const rows = [
    ['Yöntem', rep.mode === 'timer' ? 'EXT_disjoint_timer_query' : 'performance.now + gl.finish (şişirilmiş)'],
    ['Çözücü toplamı', fmt(rep.total.solver, 3) + ' ms/kare'],
    ['Görüntü toplamı', fmt(rep.total.render, 3) + ' ms/kare'],
    ['Baskın grup', rep.total.solver >= rep.total.render ? 'çözücü' : 'görüntü'],
  ];
  rep.rows.slice(0, 14).forEach((r) => rows.push([(r.group === 'solver' ? 'Ç ' : 'G ') + r.name, fmt(r.ms, 3) + ' ms']));
  app.inspector.setKV('perfInfo', rows);
}

/* ------------------------------------------------------------------ */
/* Uyarlamalı görüntü çözünürlüğü                                       */
/* ------------------------------------------------------------------ */
/**
 * Kare hızı yöneticisi (FL.FrameGovernor): kare aralığını izler, hedefin (ekran tazeleme
 * hızı) altında kalınırsa önce kare başına alt adım sayısını, sonra görüntü çözünürlüğünü,
 * ışın adımını ve efekt yoğunluğunu kısar.
 */
function adaptQuality(dtRaw) {
  const gov = app.gov;
  const r = app.renderer;
  const st = app.state;
  // Gerçek zaman öncelikliyken görüntü kalitesi ancak 30 fps'nin altında kısılır
  gov.targetFps = st.realTime ? Math.min(st.targetFps > 0 ? st.targetFps : 30, 30) : st.targetFps > 0 ? st.targetFps : 0;
  gov.setAuto(!!st.adaptive && !document.hidden);
  gov.update(dtRaw);
  const lv = gov.level;
  r.adaptiveScale = lv.scale;
  r.stepBoost = lv.boost;
  r.fx.particleScale = lv.particle;
  app.sim.tight = gov.levelIndex > 0;
  const a = app.adapt;
  if (gov.levelIndex === gov.levels.length - 1 && gov.fps < gov.target * 0.5 && !a.hinted && r.frame > 600) {
    a.hinted = true;
    toast('Kare hâlâ ağır: Çözücü › Izgara çözünürlüğünü azaltmayı deneyin');
  }
}

/* ------------------------------------------------------------------ */
/* Ana döngü                                                           */
/* ------------------------------------------------------------------ */
function loop(t) {
  if (app.lost) return;
  requestAnimationFrame(loop);
  const glc = app.glc;
  glc.pollReads();
  if (app.capturing) return;   // veri kümesi yakalanırken çizimi o yönetir
  if (document.hidden && !app.stepOnce) return;
  // Çizim ekranın tazeleme hızında yapılır (60 Hz tavanı yok). Akış çözücüsü ondan bağımsızdır:
  // saniyede en çok 60 kez adım atar; aradaki kareler yalnız görüntüdür (ucuz) ve akıcılığı verir.
  // Kare hızı yöneticisi (Görüntü › Kalite) hedefin altına düşülmesine izin vermez.
  const canvas = $('gl');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (w < 2 || h < 2) return;
  const ren = app.renderer;
  const needPicture = !app.started || app.stepOnce || !app.paused || app.wantShot || ren.camera.active() || camVActive() || ren.warming > 0;
  if (!needPicture) {
    if (t >= app.due.hud) { app.due.hud = t + 250; updateStatus(); }
    app.lastT = 0;
    if (app.gov) app.gov.resume();
    return;
  }
  const W = Math.round(w * dpr), H = Math.round(h * dpr);
  if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
  app.presented = t;

  const dtRaw = app.lastT ? Math.max((t - app.lastT) / 1000, 1e-3) : 1 / 60;
  const dtReal = Math.min(dtRaw, 0.1);
  app.lastT = t;
  app.fps += (1 / dtRaw - app.fps) * (1 - Math.exp(-dtRaw / 0.4));
  const workT0 = performance.now();

  const st = app.state;
  const sim = app.sim;
  try {
    // Çözücü, ekran hızından bağımsız bir alt adım bütçesiyle ilerler: saniyede en çok
    // 60 × (En çok alt adım) alt adım. 60 Hz ekranda bu, kare başına 6 alt adımdır; 165 Hz
    // ekranda aynı iş karelere yayılır (kare başına ~2), böylece her kare kısa kalır ve
    // benzetim hızı değişmeden çizim ekranın hızında akar.
    // Gerçek zaman öncelikliyken yönetici alt adımı kısmaz: kare hızı düşer, benzetim hızı korunur
    const subRate = Math.max(1, st.maxSub * (st.realTime ? 1 : app.gov.level.sub)) * 60;
    app.simAcc = app.paused ? 0 : Math.min(app.simAcc + dtReal, 0.1);
    app.subBudget = app.paused ? 0 : Math.min((app.subBudget || 0) + subRate * dtReal, Math.max(1, st.maxSub));
    const allow = Math.floor(app.subBudget + 1e-6);
    const tick = app.stepOnce || (!app.paused && allow >= 1);
    if (tick) {
      const frameDt = st.timeScale * (app.stepOnce ? 1 / 60 : Math.min(app.simAcc, 1 / 30));
      const realSpan = app.stepOnce ? 1 / 60 : app.simAcc;
      sim.subCap = app.stepOnce ? st.maxSub : allow;
      app.simAcc = 0;
      app.stepOnce = false;
      const t0 = sim.simTime;
      if (app.autoIgnPending && sim.simTime >= app.autoIgnAt) {
        app.autoIgnPending = false;
        sim.ignite(igniteDuration());
      }
      glc.prof.group = 'solver';
      sim.step(frameDt);
      const adv = sim.simTime - t0;
      if (!app.paused) app.simRate += (adv / Math.max(realSpan, 1e-4) - app.simRate) * 0.1;
      app.subBudget = Math.max(0, (app.subBudget || 0) - (sim.lastPlan ? sim.lastPlan.n : 1));
      // Yangın ve patlama efektleri aynı benzetim süresi kadar ilerler
      fxAdvance(adv);
      // İstatistikler kare sayısına değil zamana bağlıdır (yüksek tazeleme hızında fazladan geçiş çalışmaz)
      if (t >= (app.due.stats || 0)) { app.due.stats = t + 45; sim.computeStats(); }
      if (t >= (app.due.front || 0)) { app.due.front = t + 160; sim.measureSheetFront(); }
    }
    app.renderer.camera.update(dtReal);
    camVUpdate(dtReal);
    glc.prof.group = 'render';
    app.renderer.render(st, W, H, { paused: app.paused });
    glc.profEndFrame();
    const ct = document.querySelector('.cam-tools');
    const safe = { gx: w - 34 - drawerCover(canvas), gy: ct ? ct.offsetTop + ct.offsetHeight + 34 : 80 };
    if (!app.cine) app.overlay.draw(app.renderer, sim, st, w, h, dpr, safe);
    if (app.wantShot) { app.wantShot = false; captureShot(); }
    adaptQuality(dtRaw);
    void workT0;
    // Panel güncellemeleri kare sayısına değil zamana bağlı: yavaş GPU'da da akar
    const due = app.due;
    if (t >= due.hud) {
      due.hud = t + 100;
      app.readouts.update(sim, st);
      app.legend.update(st, app.renderer);
      if (!$('flam').hidden) app.flam.update(app.renderer.model, st);
      if (!$('aiPanel').hidden) app.ai.update(app.renderer.modelActive(st) ? app.renderer.model : null, st, app.fx);
      updateModelInfo();
      if (occKey() !== app._occWant) scheduleOcc();
      updateStatus();
      checkEvents();
      fxUpdateHud();
      updatePerf();
    }
    if (!$('chart').hidden) {
      if (t >= due.chart) {
        due.chart = t + 160;
        app.chart.buildButtons(st);
        app.chart.draw(sim, st);
      } else if (app.chart.dirty) {
        app.chart.dirty = false;
        app.chart.draw(sim, st);
      }
    }
    if (t >= due.theory) { due.theory = t + 330; updateTheory(); }
    if (!app.started) {
      app.started = true;
      bootProgress(1, 'Hazır');
      const ld = $('loading');
      setTimeout(() => ld.classList.add('done'), 180);
      setTimeout(() => { ld.hidden = true; }, 700);
    }
  } catch (e) {
    console.error(e);
    app.paused = true;
    setPauseIcon();
    showFatal('Beklenmeyen hata', 'Benzetim duraklatıldı. Ayrıntılar aşağıda.', String(e && e.stack ? e.stack : e));
  }
}

/* Otomatik testler ve betikler için (tools/fx-test.js): arayüzün yaptığını kodla yapar */
FL.api = {
  setModel: (id) => { setModel(FL.modelById(id) ? FL.modelById(id).id : 'none'); app.inspector.sync(); },
  setControl: (key, value, effect) => onControl(key, value, effect || 'live', false),
  loadPreset: (id) => loadPreset(id, true),
  reset: () => resetField(),
  fxTool: (tool, x, y) => fxApplyTool(tool, fxPoint(x, y)),
  fxAt: (tool, p, partId) => fxApplyTool(tool, { p, body: partId != null ? app.fx.bodyAtPart(partId) : null }),
  fxAction, fxAdvance, fitCamera, aiIgnite,
  toggleModel: (id) => applyFly('model', id),
  flyItems,
  logs: () => fxLogs.map((l) => l.text),
};

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
