/* =====================================================================
 * Alev Laboratuvarı — Görüntüleyici
 * ---------------------------------------------------------------------
 * Yörünge kamerası, HDR hedef (ışıma + derinlik/OPD), zamansal
 * biriktirme (TAA), enerji koruyan parlama zinciri, otomatik pozlama ve
 * alevin çevresini aydınlatan sonlu boyutlu ışık kaynağı tahmini.
 * ===================================================================== */
import { FL } from '../core/fl.js';

const M4 = FL.M4;

/**
 * Sahne kamerası (Blender'daki kamera nesnesi gibi): konum (m) ve yön (derece).
 * Yön kuralı yörünge kamerasıyla aynıdır: bakış yönü
 *   f = −(cos p · sin y, sin p, cos p · cos y)
 * Yuvarlanma (roll) bakış ekseni çevresinde döndürür.
 */
function sceneCamBasis(st) {
  const y = (st.camYaw * Math.PI) / 180, p = (st.camPitch * Math.PI) / 180, r = ((st.camRoll || 0) * Math.PI) / 180;
  const cp = Math.cos(p);
  const f = [-cp * Math.sin(y), -Math.sin(p), -cp * Math.cos(y)];
  // Sağ ve yukarı (yuvarlanmasız)
  let rt = [Math.cos(y), 0, -Math.sin(y)];
  let up = [rt[1] * f[2] - rt[2] * f[1], rt[2] * f[0] - rt[0] * f[2], rt[0] * f[1] - rt[1] * f[0]];
  // up = rt × f
  if (r) {
    const c = Math.cos(r), s = Math.sin(r);
    const rt2 = rt.map((v, i) => c * v + s * up[i]);
    const up2 = up.map((v, i) => c * v - s * rt[i]);
    rt = rt2; up = up2;
  }
  return { pos: [st.camX, st.camY, st.camZ], f, rt, up };
}
FL.sceneCamBasis = sceneCamBasis;

/* ------------------------------------------------------------------ */
/* Yörünge kamerası                                                     */
/* ------------------------------------------------------------------ */
class OrbitCamera {
  constructor() {
    this.yaw = 0.55;
    this.pitch = 0.12;
    this.dist = 0.2;
    this.target = [0, 0, 0];
    this.fov = (38 * Math.PI) / 180;
    this.minDist = 0.01;
    this.maxDist = 2.0;
    this._v = { yaw: 0, pitch: 0, zoom: 0, px: 0, py: 0 };
    this._goal = null;
    this.autoRotate = false;
    this.home = null;
  }
  /**
   * Alanın tamamını görüntü oranına göre kenar payıyla sığdırır. Ön yüz
   * kameraya daha yakın olduğu için uzaklığa yarım köşegen eklenir; alt
   * ölçüm şeridi görüntünün altını kapattığından sahne biraz yukarı alınır.
   */
  fit(box, focusY, animate, aspect, bounds) {
    // bounds: { lo, hi } — sahneye yerleştirilmiş modelle birlikte çerçevelenecek dünya kutusu
    const L0 = Math.max(box[0], box[1], box[2]);
    const org = bounds ? bounds.lo : [0, 0, 0];
    if (bounds) {
      box = [0, 1, 2].map((c) => bounds.hi[c] - bounds.lo[c]);
      focusY = undefined;
    }
    const L = Math.max(box[0], box[1], box[2]);
    const a = aspect || this.aspect || 1.5;
    const t = Math.tan(this.fov / 2);
    const depth = 0.5 * Math.hypot(box[0], box[2]);
    const dist = Math.max((0.6 * box[1]) / t, (0.75 * Math.max(box[0], box[2])) / (t * a)) + depth;
    const fy = focusY !== undefined ? 0.5 * (0.5 * box[1] + focusY) : 0.5 * box[1];
    const goal = {
      yaw: 0.55, pitch: 0.12, dist,
      target: [org[0] + box[0] / 2, org[1] + fy - 0.1 * dist * t, org[2] + box[2] / 2],
    };
    this.minDist = L0 * 0.15;
    this.maxDist = L * 6;
    this.home = goal;
    if (animate) {
      // En kısa yoldan dön
      const tau = Math.PI * 2;
      goal.yaw = this.yaw + ((((goal.yaw - this.yaw) % tau) + tau * 1.5) % tau) - Math.PI;
      this._goal = goal;
    } else {
      this._goal = null;
      this.yaw = goal.yaw; this.pitch = goal.pitch; this.dist = goal.dist; this.target = goal.target.slice();
    }
    this._v = { yaw: 0, pitch: 0, zoom: 0, px: 0, py: 0 };
  }
  /** Hazır bakış açıları: ön, yan, üst */
  setView(name) {
    if (!this.home) return;
    const g = { yaw: this.yaw, pitch: this.pitch, dist: this.dist, target: this.target.slice() };
    if (name === 'front') { g.yaw = 0; g.pitch = 0.02; }
    else if (name === 'side') { g.yaw = Math.PI / 2; g.pitch = 0.02; }
    else if (name === 'top') { g.pitch = 1.3; }
    this._goal = g;
  }
  eye() {
    const cp = Math.cos(this.pitch);
    return [
      this.target[0] + this.dist * cp * Math.sin(this.yaw),
      this.target[1] + this.dist * Math.sin(this.pitch),
      this.target[2] + this.dist * cp * Math.cos(this.yaw),
    ];
  }
  update(dt) {
    // Eylemsizlik ile yumuşak dönüş, kaydırma ve yakınlaştırma
    const k = Math.exp(-dt * 6.5);
    const a = 1 - k;
    this.yaw += this._v.yaw * a;
    this.pitch += this._v.pitch * a;
    this.dist *= Math.exp(this._v.zoom * a);
    if (this._v.px || this._v.py) {
      const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
      const right = [cy, 0, -sy];
      const sp = Math.sin(this.pitch), cp = Math.cos(this.pitch);
      const up = [-sp * sy, cp, -sp * cy];
      for (let i = 0; i < 3; i++) this.target[i] += (right[i] * this._v.px + up[i] * this._v.py) * a;
    }
    this._v.yaw *= k; this._v.pitch *= k; this._v.zoom *= k; this._v.px *= k; this._v.py *= k;
    if (this._goal) {
      const g = this._goal;
      // Kritik sönümlü yaklaşım: başta hızlı, sona doğru yavaşlayarak oturur
      const s = 1 - Math.exp(-dt * 5.5);
      this.yaw += (g.yaw - this.yaw) * s;
      this.pitch += (g.pitch - this.pitch) * s;
      this.dist += (g.dist - this.dist) * s;
      for (let i = 0; i < 3; i++) this.target[i] += (g.target[i] - this.target[i]) * s;
      if (Math.abs(g.yaw - this.yaw) + Math.abs(g.pitch - this.pitch) < 2e-5 && Math.abs(g.dist - this.dist) < 2e-6) this._goal = null;
    }
    if (this.autoRotate) this.yaw += dt * 0.15;
    this.pitch = FL.clamp(this.pitch, -1.2, 1.4);
    this.dist = FL.clamp(this.dist, this.minDist, this.maxDist);
  }
  drag(dx, dy) {
    this._goal = null;
    this._v.yaw -= dx * 0.0045;
    this._v.pitch += dy * 0.0045;
  }
  /** Ekran pikseli cinsinden kaydırma: hedef noktayı kamera düzleminde taşır */
  pan(dx, dy, viewH) {
    this._goal = null;
    const s = (2 * this.dist * Math.tan(this.fov / 2)) / Math.max(viewH, 1);
    this._v.px -= dx * s;
    this._v.py += dy * s;
  }
  zoom(delta) {
    this._goal = null;
    this._v.zoom += delta;
  }
  /** Kameranın bu karede hâlâ hareket edip etmediği (durunca çizim kesilir) */
  active() {
    const v = this._v;
    return this.autoRotate || !!this._goal
      || Math.abs(v.yaw) + Math.abs(v.pitch) + Math.abs(v.zoom) + Math.abs(v.px) + Math.abs(v.py) > 2e-5;
  }
  matrices(aspect) {
    this.aspect = aspect;
    const eye = this.eye();
    const view = M4.lookAt(eye, this.target, [0, 1, 0]);
    const proj = M4.perspective(this.fov, aspect, this.dist * 0.02, Math.max(this.dist * 20, this.farMin || 0));
    const vp = M4.multiply(proj, view);
    return { eye, view, proj, vp, invVP: M4.invert(vp) };
  }
}
FL.OrbitCamera = OrbitCamera;

function halton(i, b) {
  let f = 1, r = 0;
  while (i > 0) { f /= b; r += f * (i % b); i = Math.floor(i / b); }
  return r;
}

const TONEMAP_CODE = { agx: 0, aces: 1, neutral: 2 };

class Renderer {
  constructor(glc, sim) {
    this.glc = glc;
    this.gl = glc.gl;
    this.sim = sim;
    this.camera = new OrbitCamera();
    this.frame = 0;
    this.autoEV = 0;
    this.lumReadEvery = 6;
    this.light = { pos: [0, 0, 0], cd: 0, col: [1, 0.8, 0.55], R: 0.004 };
    this.adaptiveScale = 1;
    this.stepBoost = 1;
    this.warming = 24;
    this.histValid = false;
    this._prevPreExp = 1;
    this._lastView = -1;
    // Fiziksel kamera durumu
    this.camAutoT = 1 / 250;      // diyafram öncelikli otomatik pozlamanın obtüratör süresi
    this.camFrame = null;         // kamera karesi (cihaz pikseli)
    this.camInfo = null;          // son karenin kamera parametreleri (etiketler için)
    this._shutValid = false;
    this._shutSimT = 0;
    this._shutPreExp = 1;
    this._compile();
    this._buildLUT();
    this.resize(2, 2, 1);
    // Sahneye yerleştirilen GLB modeli (yoksa boş)
    this.model = new FL.ModelScene(glc);
    // Yangın ve patlama efektleri: çizim katmanı (durum app.fx'te, burada yalnız GPU tarafı)
    this.fx = new FL.FxRenderer(glc);
    this.fxSys = null;
    this.lightU = { pos: [0, 0, 0], cd: 0, col: [1, 0.8, 0.55], R: 0.004 };
  }

  /** Uzay arka planı (yıldızlar, Dünya) etkin mi: 'auto' → kabin modelinde ya da mikrogravitede */
  orbitBackdrop(st) {
    if (st.backdrop === 'orbit') return true;
    if (st.backdrop === 'lab') return false;
    return (this.modelActive(st) && !!this.model.def.large) || st.gravity < 0.01;
  }

  /** Model sahnede ve çizilmeye hazır mı */
  modelActive(st) {
    return !!(this.model && this.model.ready && st.model && st.model !== 'none' && this.model.def && this.model.def.id === st.model);
  }

  _compile() {
    const g = this.glc;
    const S = FL.SHADERS;
    this.P = {
      march: g.program('raymarch', S.raymarch()),
      backdrop: g.program('backdrop', S.backdrop()),
      temporal: g.program('temporal', S.temporal()),
      down: g.program('down', S.down()),
      up: g.program('up', S.up()),
      composite: g.program('composite', S.composite()),
      shutter: g.program('shutter', S.shutter()),
      dof: g.program('dof', S.dof()),
      lum: g.program('luminance', S.luminance()),
      reduce: this.sim.P.reduce,
    };
  }

  _buildLUT() {
    const gl = this.gl;
    const n = 512;
    this.lutRange = [300, 3400];
    const lut = FL.buildRadiationLUT(n, this.lutRange[0], this.lutRange[1]);
    // Satır başına ölçek: yarım duyarlıkta taşmayı önlemek için normalize
    let maxS = 0, maxG = 0;
    for (let i = 0; i < n; i++) {
      maxS = Math.max(maxS, lut.data[i * 4], lut.data[i * 4 + 1], lut.data[i * 4 + 2]);
      maxG = Math.max(maxG, lut.data[(n + i) * 4], lut.data[(n + i) * 4 + 1], lut.data[(n + i) * 4 + 2]);
    }
    this.lutScaleSoot = maxS / 1000;
    this.lutScaleGray = maxG / 1000;
    const data = new Float32Array(lut.data.length);
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < 4; c++) {
        data[i * 4 + c] = lut.data[i * 4 + c] / this.lutScaleSoot;
        data[(n + i) * 4 + c] = lut.data[(n + i) * 4 + c] / this.lutScaleGray;
      }
    }
    // NEAREST + texelFetch: doğrusal süzme olmayan GPU'larda tablo siyah kalmasın.
    this.lut = this.glc.texture(n, 2, { internal: gl.RGBA32F, type: gl.FLOAT, data, filter: gl.NEAREST });
    this.lutRaw = lut;
  }

  /** Kara cisim ışıksal verimi [lm/W] — LUT gri cisim satırından */
  luminousEfficacy(T) {
    const lut = this.lutRaw;
    const u = FL.clamp((T - lut.Tmin) / (lut.Tmax - lut.Tmin), 0, 1) * (lut.n - 1);
    const i = Math.floor(u), f = u - i;
    const i1 = Math.min(i + 1, lut.n - 1);
    const Y = lut.data[(lut.n + i) * 4 + 3] * (1 - f) + lut.data[(lut.n + i1) * 4 + 3] * f; // cd/m² (ε=1)
    const L = (FL.C.SIGMA * Math.pow(T, 4)) / Math.PI;                                       // W/(m² sr)
    return Y / Math.max(L, 1e-9);
  }

  _destroyTargets() {
    const g = this.glc;
    if (!this.hdr) return;
    g.destroyFBO(this.mrt);
    g.destroyTarget(this.hdr);
    g.destroyTarget(this.aux);
    g.destroyPingPong(this.hist);
    g.destroyPingPong(this.shut);
    g.destroyTarget(this.dofT);
    g.destroyTarget(this.bgT);
    this.levels.forEach((l) => { g.destroyTarget(l.down); g.destroyTarget(l.up); });
    this.lumChain.forEach((t) => g.destroyTarget(t));
    (this.lumChainS || []).forEach((t) => g.destroyTarget(t));
    g.destroyTarget(this.lumT);
    this.hdr = null;
  }

  resize(w, h, scale) {
    const g = this.glc;
    const gl = this.gl;
    const rw = Math.max(2, Math.round(w * scale));
    const rh = Math.max(2, Math.round(h * scale));
    if (this.hdr && this.hdr.w === rw && this.hdr.h === rh) return false;
    this._destroyTargets();
    const opts = { internal: gl.RGBA16F, type: gl.HALF_FLOAT, filter: gl.LINEAR };
    const sOpts = { internal: g.fmtField, type: g.typeField, filter: gl.NEAREST };
    this.hdr = g.target(rw, rh, opts);
    // Derinlik ve optik yol farkı tam duyarlıkla saklanır (Schlieren türevi için)
    this.aux = g.target(rw, rh, sOpts);
    this.mrt = g.framebuffer([this.hdr.tex, this.aux.tex]);
    this.hist = g.pingPong(rw, rh, opts);
    this.shut = g.pingPong(rw, rh, opts);
    this.dofT = g.target(rw, rh, opts);
    // Uzay arka planı (yörünge): ışın yürütücü bu dokudan okur
    this.bgT = g.target(rw, rh, Object.assign({}, opts, { filter: gl.NEAREST }));
    this._shutValid = false;
    this.levels = [];
    let lw = rw, lh = rh;
    for (let i = 0; i < 6; i++) {
      lw = Math.max(2, Math.ceil(lw / 2));
      lh = Math.max(2, Math.ceil(lh / 2));
      this.levels.push({ down: g.target(lw, lh, opts), up: g.target(lw, lh, opts), w: lw, h: lh });
    }
    const L2 = this.levels[2];
    this.lumT = g.target(L2.w, L2.h, sOpts);
    this.lumChain = [];
    let cw = L2.w, ch = L2.h;
    while (cw > 1 || ch > 1) {
      cw = Math.max(1, Math.ceil(cw / 4));
      ch = Math.max(1, Math.ceil(ch / 4));
      this.lumChain.push(g.target(cw, ch, sOpts));
    }
    // Model sahnedeyken sahne ölçümü için toplam zinciri (log-ortalama)
    this.lumChainS = this.lumChain.map((t) => g.target(t.w, t.h, sOpts));
    this.histValid = false;
    return true;
  }

  /** Zamansal geçmişi geçersiz kıl (sıfırlama, mod değişimi) */
  invalidate() {
    this.histValid = false;
  }

  /**
   * Alevin çevresini aydınlatan ışık şiddeti, rengi ve etkin yarıçapı.
   * Optik ince alevin ışık şiddeti I = ∫ j dV'dir (j: görüntüdeki yayınım
   * katsayısı, kurum + kemilüminesans). Benzetim istatistikleri bunu RGB
   * olarak aynı yayınım tablosuyla toplar; görüntü ile aydınlatma tutarlıdır.
   */
  _estimateLight() {
    const s = this.sim.stats;
    const sim = this.sim;
    if (!s.valid || !(s.lumY > 0)) {
      this.light.cd += (0 - this.light.cd) * 0.3;
      if (!s.valid) this.light.pos = sim.geo.anchor.slice();
      return;
    }
    const target = s.lumY;
    this.light.cd += (target - this.light.cd) * (this.light.cd < target * 0.5 ? 0.6 : 0.25);
    const Y = Math.max(s.lumY, 1e-12);
    const col = [s.lumR / Y, s.lumG / Y, s.lumB / Y].map((c) => (isFinite(c) ? Math.max(c, 0) : 1));
    for (let i = 0; i < 3; i++) this.light.col[i] += (col[i] - this.light.col[i]) * 0.3;
    const p = [s.lx, s.ly, s.lz];
    this.light.pos = this.light.pos.map((v, i) => (isFinite(p[i]) ? v + (p[i] - v) * 0.3 : v));
    // Alev bir nokta değil: etkin yarıçap alev boyutundan (yumuşak gölge, sınırlı aydınlık)
    const size = s.flameH > 0 ? s.flameH : 2 * (s.rMax || 0);
    const R = FL.clamp(0.2 * size, 0.0015, 0.006);
    this.light.R += (R - this.light.R) * 0.2;
  }

  /**
   * Görüntüdeki yayınım katsayısının parametreleri. Benzetim istatistikleri de
   * (ışık şiddeti) aynı değerleri kullanır.
   */
  emission(st) {
    const fuel = this.sim.phys.fuel;
    // Kemilüminesans: HRR'nin görünür ışımaya dönen kesri ~10⁻⁵ (CH*, C₂*, CO₂*).
    // Renk vektörleri 683 lm/W çarpanını içerir; 4π ile radyans katsayısına çevrilir.
    const fChem = 1.0e-5;
    const ch = FL.CHEMI;
    const cCH = fuel.c2ch > 0 ? 1.0 : 0.0;
    const chem = [0, 1, 2].map((i) => {
      let v = cCH * ch.CH[i] + fuel.c2ch * ch.C2[i] + fuel.co2star * ch.CO2[i];
      if (fuel.h2o) v = 0.03 * ch.H2O[i];
      return ((v * fChem) / (4 * Math.PI)) * st.chemGain;
    });
    // Soğuk alev HCHO*: çok zayıf (~4×10⁻⁷); görünür kılmak için kazanç kullanılır
    const cool = FL.CHEMI.HCHO.map((c) => ((c * 4e-7) / (4 * Math.PI)) * st.coolGain);
    return {
      lut: this.lut,
      lutRange: this.lutRange,
      sootGain: st.sootGain * this.lutScaleSoot,
      sootAbs: FL.SOOT_ABS_RGB,
      chem,
      cool,
    };
  }

  render(st, viewW, viewH, opts) {
    const g = this.glc;
    const gl = this.gl;
    const sim = this.sim;
    const running = !(opts && opts.paused);
    const scale = st.renderScale * (st.adaptive ? this.adaptiveScale : 1);
    this.resize(viewW, viewH, scale);
    const rw = this.hdr.w, rh = this.hdr.h;
    const maskPass = !!(opts && opts.mask);
    // Fiziksel kamera işlemleri yalnız kameradan bakarken (Blender: Numpad 0)
    const phys = !!(st.camPhys && st.camLook);
    let sensor = null;
    if (phys) {
      // Blender'daki gibi: odak uzaklığı ve sensör boyutu görüş açısını belirler.
      // Kamera karesi (sensör en-boy oranı) görüntü alanına sığdırılır.
      sensor = FL.SENSORS[st.camSensor] || FL.SENSORS.ff;
      const f = Math.max(st.camFocal, 1);
      const as = sensor.w / sensor.h, av = viewW / viewH;
      let fw, fh;
      if (av >= as) { fh = viewH; fw = viewH * as; } else { fw = viewW; fh = viewW / as; }
      const tanH = sensor.w / (2 * f), tanV = sensor.h / (2 * f);
      this.sceneFov = 2 * Math.atan((tanV * viewH) / fh);
      this.camera.fov = this.sceneFov;
      this.camFrame = { x: (viewW - fw) / 2, y: (viewH - fh) / 2, w: fw, h: fh, tanH, tanV, viewW, viewH };
    } else {
      this.camera.fov = (st.fov * Math.PI) / 180;
      this.camFrame = null;
    }
    let cam;
    // Patlama sarsıntısı: kamera kısa süre rastgele yer değiştirir (dış parametreler etiketlere de yansır)
    const fxs = this.fxSys;
    // (sarsıntı metre cinsindendir ve ~8 m'den bakışa göre ayarlıdır: yakın çekimde orantılı küçülür)
    const viewDist = phys ? Math.max(sim.grid.Ly, 0.05) * 3 : this.camera.dist;
    const shake = fxs && running && !maskPass ? fxs.shake * Math.min(1, viewDist / 8) : 0;
    const sh = shake > 0 ? [(Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake] : null;
    if (maskPass && this.lastCam) {
      // Maske, görüntüyle birebir aynı kameradan alınır
      cam = this.lastCam;
    } else if (phys) {
      // Kameradan bakış: sahne kamerasının konumu ve yönü
      const B = sceneCamBasis(st);
      const eye = sh ? [B.pos[0] + sh[0], B.pos[1] + sh[1], B.pos[2] + sh[2]] : B.pos;
      const view = M4.lookAt(eye, [eye[0] + B.f[0], eye[1] + B.f[1], eye[2] + B.f[2]], B.up);
      const L = Math.max(sim.grid.Lx, sim.grid.Ly, sim.grid.Lz);
      const proj = M4.perspective(this.camera.fov, viewW / viewH, Math.max(0.002, L * 0.01), Math.max(L * 60, this.camera.farMin || 0));
      const vp = M4.multiply(proj, view);
      cam = { eye, view, proj, vp, invVP: M4.invert(vp) };
    } else {
      const tg = this.camera.target;
      if (sh) for (let i = 0; i < 3; i++) tg[i] += sh[i];
      cam = this.camera.matrices(viewW / viewH);
      if (sh) for (let i = 0; i < 3; i++) tg[i] -= sh[i];
    }
    const gr = sim.grid;
    const fuel = sim.phys.fuel;
    const em = this.emission(st);
    sim.emis = em;
    this._estimateLight();
    // Sahneyi aydınlatan tek ışık: akış çözücüsündeki alev ile nesne yangını / patlama parlamasından
    // baskın olanın konumu, ikisinin toplam ışık şiddeti
    const LU = this.lightU;
    LU.pos = this.light.pos; LU.cd = this.light.cd; LU.col = this.light.col; LU.R = this.light.R;
    const fl = fxs && fxs.light;
    if (fl && fl.valid && fl.cd > 0) {
      if (fl.cd > this.light.cd) { LU.pos = fl.pos; LU.col = fl.col; LU.R = fl.R; }
      LU.cd = this.light.cd + fl.cd;
    }

    // Kamera yalnız görünür ışığı görür: fiziksel kamerada görünüm her zaman gerçekçidir
    // Maske geçişi: aynı kameradan ısı salınımı alanı (veri kümesi yer gerçeği)
    const view = maskPass ? 3 : phys ? 0 : VIEW_CODE[st.view] || 0;
    if (view !== this._lastView) { this.histValid = false; this._lastView = view; }
    let falseRange = 2200;
    let sliceRange = [st.Tamb, 2300];
    if (view === 1 || view === 2) falseRange = st.falseTmax;
    if (view === 3) falseRange = st.falseHRR;
    if (view === 4) falseRange = st.falseSoot;
    if (view === 5) falseRange = st.falseU / 100;
    if (view === 6) falseRange = st.falseYf;
    if (view === 8) falseRange = st.falseRad;
    if (view === 9) falseRange = st.falseHRR;
    const sf = SLICE_FIELD[st.sliceField] || 0;
    if (sf === 0) sliceRange = [st.Tamb, st.falseTmax];
    else if (sf === 1) sliceRange = [0, st.falseHRR];
    else if (sf === 2) sliceRange = [0, st.falseSoot];
    else if (sf === 3) sliceRange = [0, st.falseU / 100];
    else if (sf === 4) sliceRange = [0, st.falseYf];
    else if (sf === 6) sliceRange = [0, 200];

    const exposureMul = this._exposure(st);
    // Fiziksel modda ışıma pozlanmış olarak yazılır; yarım duyarlıkta taşmaz
    const preExp = view === 0 ? exposureMul : 1;
    const taa = !!st.taa && view !== 7 && !maskPass;
    let jitter = [0, 0];
    if (taa) {
      const i = (this.frame % 16) + 1;
      jitter = [((halton(i, 2) - 0.5) * 2) / rw, ((halton(i, 3) - 0.5) * 2) / rh];
    }
    // Model: yerleşim, kesit görünümü, yanıcılık boyası, G-tamponu
    const mOn = this.modelActive(st);
    const ms = this.model;
    let floorFade = gr.Lx * 1.8;
    // Yanık izi hacmi (model uzayı): G-tamponu geçişi örnekler
    if (fxs && fxs.partsDirty) { fxs.partsDirty = false; ms._paintParts(); ms.refreshSDF(); }
    this.fx.syncBurn(mOn ? fxs : null, ms);
    if (mOn) {
      ms.place(st, gr);
      ms.updateCutaway(cam.eye);
      // Yapay zekâ görünümü: parçalar modelin öngördüğü riskle boyanır
      if (!(view === 9 && FL.AIView && FL.AIView.paint(ms, st, fxs))) ms.setFlam(st.flamMode || 'class', st.o2);
      ms.renderGBuffer(cam, jitter, rw, rh, this.fx.burnUniforms(fxs));
      const e = Math.max(ms.worldHi[0] - ms.worldLo[0], ms.worldHi[2] - ms.worldLo[2]);
      floorFade = Math.max(floorFade, 1.3 * e);
    }
    const large = mOn && ms.def.large;
    // Uzay arka planı: Dünya ve yıldızlar ayrı, küçük bir geçişte (aynı kamera ve kayma)
    const orbit = this.orbitBackdrop(st);
    const sunDir = FL.SUN_DIR;
    const sunE = orbit ? Math.max(st.sunLight || 0, 0) : 0;
    const bgOn = orbit && view === 0 && !maskPass;
    if (bgOn) {
      g.pass(this.P.backdrop, this.bgT, {
        uInvVP: cam.invVP, uJitter: jitter, uSunDir: sunDir, uSpaceL: st.earthLum || 0,
        uSpaceT: sim.simTime + (fxs ? fxs.time : 0),
      });
    }
    // Tavan lambası: hedef noktada (masa ya da kabin döşemesi) istenen aydınlığı verecek ışık şiddeti
    let key = [0, 0, 0, 0], keyR = 0.1;
    if (st.roomLight > 0) {
      let P, aim;
      if (mOn && ms.def.lamp) {
        P = M4.transformPoint(ms.M, ms.def.lamp);
        aim = [P[0], 0, P[2]];
        keyR = ms.def.lampR || 0.3;
      } else {
        const lo = mOn ? ms.worldLo.map((v) => Math.min(v, 0)) : [0, 0, 0];
        const hi = mOn ? [gr.Lx, gr.Ly, gr.Lz].map((v, i) => Math.max(v, ms.worldHi[i])) : [gr.Lx, gr.Ly, gr.Lz];
        const S = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2], 0.25);
        const cx = 0.5 * (lo[0] + hi[0]), cz = 0.5 * (lo[2] + hi[2]);
        P = [cx + 0.35 * S, hi[1] + 1.1 * S, cz + 0.55 * S];
        aim = [cx, 0, cz];
        keyR = 0.12 * S;
      }
      const d2 = (P[0] - aim[0]) ** 2 + (P[1] - aim[1]) ** 2 + (P[2] - aim[2]) ** 2;
      key = [P[0], P[1], P[2], st.roomLight * d2];
    }
    this.keyLight = key;
    const aiOn = view === 9 && !!FL.AIView;
    const aiU = aiOn ? FL.AIView.uniforms(st, fxs, cam, rh) : AI_OFF;
    const base = Object.assign({}, sim.commonU(), sim.thermoU(), ms.uniforms(mOn, (!!st.flamView && !maskPass && !phys) || (aiOn && FL.AIView.painted(ms))), {
      uAiOrg: aiU.org, uAiPar: aiU.par, uAiPx: aiU.px,
      uBackdrop: bgOn ? 1 : 0, uBgTex: this.bgT, uSunDir: sunDir, uSunE: sunE, uFxNit: FL.FX_FLAME_NIT * 0.6,
      uExpTot: view === 0 ? exposureMul : 1,
      uFloorFade: floorFade,
      uKey: key, uKeyR: keyR,
      uSca: sim.F.sca.read, uAux: sim.F.aux.read, uVel: sim.F.vel.read, uLUT: this.lut, uGr: sim.F.radF,
      uLUTRange: this.lutRange,
      uInvVP: cam.invVP, uCamPos: cam.eye,
      uJitter: jitter,
      uBox: [gr.Lx, gr.Ly, gr.Lz],
      uView: view,
      uStep: st.stepCells * (this.stepBoost || 1),
      uChemCol: em.chem, uCoolCol: em.cool,
      uSootGain: em.sootGain,
      uSootAbs: em.sootAbs,
      uChemGain: 1,
      uCoolGain: 1,
      uFrame: this.frame,
      uLight: [LU.pos[0], LU.pos[1], LU.pos[2], LU.cd],
      uLightCol: LU.col,
      uLightR: LU.R,
      uAmbientL: st.ambientLight,
      uSlice: [st.slice ? 1 : 0, sf, SLICE_AXIS[st.sliceAxis] || 2, st.slicePos],
      uSliceRange: sliceRange,
      uSliceGain: 0.6 / Math.max(exposureMul, 1e-12),
      // Kabinde deney orta güverte döşemesinde durur: masa yüzeyi çizilmez
      // (yörünge arka planında da masa yoktur: deney boşlukta asılı durur)
      uFloor: st.floor && !large && !orbit ? (st.floorGrid ? 2 : 1) : 0,
      uSheetColor: fuel.color || [0.85, 0.84, 0.8],
      uSheetInert: fuel.inert || 0,
      uGlowGain: this.lutScaleGray,
      uFalseRange: falseRange,
      uMaskPass: maskPass ? 1 : 0,
      uPreExp: preExp,
      uWamb: sim.phys.amb.W,
      uShadows: st.shadows ? 1 : 0,
    });
    g.pass(this.P.march, this.mrt, base);

    // Zamansal biriktirme: alt piksel titreşimli kareler yeniden izdüşümle birleşir
    let color = this.hdr;
    if (taa) {
      g.pass(this.P.temporal, this.hist.write, {
        uCur: this.hdr, uDepth: this.aux, uHist: this.hist.read,
        uInvVP: cam.invVP, uPrevVP: this._prevVP || cam.vp, uCamPos: cam.eye,
        uTexel: [1 / rw, 1 / rh],
        uAlpha: running ? 0.22 : 0.08,
        uExpRatio: preExp / Math.max(this._prevPreExp, 1e-30),
        uValid: this.histValid && this._prevVP ? 1 : 0,
      });
      this.hist.swap();
      color = this.hist.read;
      this.histValid = true;
    } else {
      this.histValid = false;
    }
    this._prevVP = cam.vp;
    this._prevPreExp = preExp;

    // Yangın ve patlama efektleri: alev, duman, kıvılcım, enkaz, şok dalgası. TAA'dan sonra,
    // obtüratör / alan derinliği / parlamadan önce eklenir: kamera onları sahnenin parçası görür.
    // Gerçekçi görünümde fiziksel ışıklılık, termal/sıcaklık görünümünde sahte renk, maske
    // geçişinde alev gövdesi beyaz (yer gerçeği).
    // Her görünümde çizilir: bilimsel görünümlerde o görünümün büyüklüğüyle (ısı salınımı, kurum,
    // hız, türler, ışınım) sahte renk; Schlieren'de yoğunluk açığı tamponu bileşik geçişe verilir.
    const fxView = maskPass ? 2 : view === 2 ? 1 : view;
    let fxSch = 0;
    if (fxs && fxs.visible()) {
      fxSch = fxView === 7 ? 1 : 0;
      color = this.fx.render({
        sys: fxs, color, aux: this.aux, cam, w: rw, h: rh, view: fxView, preExp, velRange: st.falseU / 100,
        key, light: LU, sun: [sunDir[0], sunDir[1], sunDir[2], sunE], ambL: st.ambientLight,
        heatRange: [st.Tamb, st.falseTmax], floor: st.floor && !large && !orbit,
      });
    }

    // Fiziksel kamera: obtüratör süresi boyunca birikim ve alan derinliği
    if (phys && !maskPass) {
      const tShut = this.shutterTime(st);
      const dts = sim.simTime - this._shutSimT;
      this._shutSimT = sim.simTime;
      const pv = this._shutVP;
      let vpChanged = !pv;
      if (pv) for (let i = 0; i < 16; i++) if (Math.abs(pv[i] - cam.vp[i]) > 1e-6) { vpChanged = true; break; }
      this._shutVP = Array.from(cam.vp);
      const moved = vpChanged || !this._shutValid || this._shutView !== view;
      let a = moved || dts < 0 ? 1 : dts > 0 ? 1 - Math.exp(-dts / Math.max(tShut, 1e-5)) : 0.3;
      if (opts && opts.keepShutter && this._shutValid && !vpChanged) a = 0;
      g.pass(this.P.shutter, this.shut.write, {
        uCur: color, uAcc: this.shut.read, uA: a, uRatio: preExp / Math.max(this._shutPreExp, 1e-30),
      });
      this.shut.swap();
      color = this.shut.read;
      this._shutValid = true;
      this._shutPreExp = preExp;
      this._shutView = view;

      const fm = st.camFocal / 1000;
      const N = Math.max(st.camFstop, 0.7);
      const Ap = fm / N;
      const lp = this.light.pos;
      const autoD = Math.hypot(cam.eye[0] - lp[0], cam.eye[1] - lp[1], cam.eye[2] - lp[2]);
      const df = Math.max(st.camFocus > 0 ? st.camFocus / 100 : autoD, fm * 1.05);
      const frameWrt = rw * (this.camFrame.w / viewW);
      const K = ((Ap * fm) / (df - fm) / (sensor.w / 1000)) * frameWrt;
      const maxR = Math.min(28, 0.06 * rw);
      g.pass(this.P.dof, this.dofT, { uSrc: color, uDepthT: this.aux, uTexel: [1 / rw, 1 / rh], uDof: [K, df, K > 0.02 ? maxR : 0] });
      color = this.dofT;
      this.camInfo = {
        focal_mm: st.camFocal, sensor: st.camSensor, sensor_mm: [sensor.w, sensor.h], fstop: N, shutter_s: tShut, iso: st.camISO,
        focus_m: df, focus_auto: !(st.camFocus > 0), wb_K: st.camWB, exposure_scale: exposureMul,
        fov_h_deg: (2 * Math.atan(this.camFrame.tanH) * 180) / Math.PI, fov_v_deg: (2 * Math.atan(this.camFrame.tanV) * 180) / Math.PI,
      };
    } else if (!maskPass) {
      this._shutValid = false;
      this.camInfo = null;
    }

    // Parlama zinciri (ilk seviyede Karis ortalaması)
    let src = color;
    for (let i = 0; i < this.levels.length; i++) {
      const L = this.levels[i];
      g.pass(this.P.down, L.down, { uSrc: src, uTexel: [1 / src.w, 1 / src.h], uKaris: i === 0 ? 1 : 0 });
      src = L.down;
    }
    let up = this.levels[this.levels.length - 1].down;
    for (let i = this.levels.length - 2; i >= 0; i--) {
      const L = this.levels[i];
      g.pass(this.P.up, L.up, { uSrc: up, uBase: L.down, uTexel: [1 / up.w, 1 / up.h], uRadius: 1.0 });
      up = L.up;
    }

    // Otomatik pozlama (yavaş, kararlı, engellemeyen okuma)
    const wantAE = phys ? st.camAE === 'A' : st.autoExposure && view === 0;
    if (wantAE && this.frame % this.lumReadEvery === 0) this._measureLuminance(preExp, phys ? st : null, mOn);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    const W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
    // Odak düzleminde görüş yüksekliği; tipik bir alev kenarı (ΔOPD/Δy ≈ 3) ≈ ±0,3 kontrast verir
    const viewHm = 2 * this.camera.dist * Math.tan(this.camera.fov / 2);
    const schK = 0.12;
    g.pass(this.P.composite, null, {
      uSchScale: [schK / (viewHm * (rw / rh)), schK / viewHm],
      uHDR: color, uBloom: this.levels[0].up, uAuxT: this.aux,
      uFxPt: fxSch && this.fx.pt ? this.fx.pt : this.aux, uFxSch: fxSch && this.fx.pt ? 1 : 0,
      uSrcSize: [rw, rh],
      uExposure: view === 0 ? exposureMul / preExp : 1,
      uBloomAmt: maskPass ? 0 : phys ? FL.clamp(st.camGlare, 0, 0.3) : view === 0 ? FL.clamp(st.bloom * 0.08, 0, 0.35) : st.bloom * 0.5,
      uFalse: view !== 0 && view !== 7 ? 1 : 0,
      uSchlieren: view === 7 ? (st.schMode === 'color' ? 2 : 1) : 0,
      uSchGain: st.schGain,
      uTonemap: TONEMAP_CODE[st.tonemap] || 0,
      uFrame: this.frame,
      uVignette: st.vignette,
      uViewport: [W, H],
      uCam: phys && !maskPass ? [1, st.camView === 'agx' ? 1 : 0, st.camNoise ? 1 : 0, st.camVig ? 1 : 0] : [0, 0, 0, 0],
      uWB: phys ? FL.wbGains(st.camWB) : [1, 1, 1],
      uSensorN: phys ? [Math.max(50, ((sensor.fwc || 30000) * 100) / Math.max(st.camISO, 25)), 3] : [1, 0],
      uFrameR: phys ? [this.camFrame.x * (W / viewW), H - (this.camFrame.y + this.camFrame.h) * (H / viewH), this.camFrame.w * (W / viewW), this.camFrame.h * (H / viewH)] : [0, 0, W, H],
      uTanHalf: phys ? [this.camFrame.tanH, this.camFrame.tanV] : [0, 0],
    }, [0, 0, W, H]);
    this.frame++;
    this.lastCam = cam;
    if (opts && opts.paused && !this.camera.active()) this.warming = Math.max(0, this.warming - 1);
    else this.warming = Math.max(this.warming, 8);
    return cam;
  }

  /** Fiziksel kameranın obtüratör süresi [s] */
  shutterTime(st) {
    return st.camAE === 'A' ? this.camAutoT : Math.max(st.camShutter, 1e-5);
  }

  _exposure(st) {
    if (st.camPhys) {
      // ISO 12232 doyma tabanlı hız: H_sat = 78/S lx·s. Görüntü düzlemi pozlaması
      // H = q·L·t/N², q ≈ 0,65 (mercek geçirgenliği, π/4, vinyet). Piksel değeri
      // (doyma = 1) = L / L_sat,  L_sat = 78 N² / (q S t)  [cd/m²].
      const N = Math.max(st.camFstop, 0.7);
      return (0.65 * st.camISO * this.shutterTime(st)) / (78 * N * N);
    }
    // Referans: 10⁴ cd/m² (mum alevi parlaklığı) EV=0'da ~0.8 görüntü değeri
    const Lref = 1.0e4;
    const ev = st.autoExposure ? this.autoEV + st.exposure : st.exposure;
    return (Math.pow(2, ev) * 1.6) / Lref;
  }

  /**
   * Otomatik pozlama ölçümü. Yalnız alev varken en parlak bölge (tepe) ölçülür.
   * Sahnede model varsa merkez ağırlıklı log-ortalama parlaklık orta griye
   * getirilir; alev tepesi en çok ~4,5 durak taşabilir (AgX bunu yumuşak
   * beyaza sıkıştırır: aydınlık odada mum fotoğrafı gibi).
   */
  _measureLuminance(preExp, camSt, scene) {
    if (this._lumInFlight) return;
    const g = this.glc;
    // Döşeme parlaklığı: 2 cd/m²'den karanlık pikseller ortalamayı aşağı çekmesin
    g.pass(this.P.lum, this.lumT, { uSrc: this.levels[2].down, uFloorY: 2 * preExp, uInvN: 1 / (this.lumT.w * this.lumT.h) });
    let src = this.lumT;
    for (const t of this.lumChain) {
      g.pass(this.P.reduce, t, { uSrc: src, uOp: 1 });
      src = t;
    }
    let srcS = null;
    if (scene && !camSt) {
      srcS = this.lumT;
      for (const t of this.lumChainS) {
        g.pass(this.P.reduce, t, { uSrc: srcS, uOp: 0 });
        srcS = t;
      }
    }
    const apply = (px, ps) => {
      const Ymax = px[0] / Math.max(preExp, 1e-30);
      if (ps && ps[2] > 0 && !camSt) {
        const Yavg = Math.exp(ps[1] / ps[2]) / Math.max(preExp, 1e-30);
        if (isFinite(Yavg) && Yavg > 1e-4) {
          let target = Math.log2((0.18 * 1.0e4) / (1.6 * Yavg));
          if (isFinite(Ymax) && Ymax > 1e-3) target = Math.min(target, Math.log2(1.0e4 / (Ymax * 1.4)) + 4.5);
          this.autoEV += (FL.clamp(target, -8, 12) - this.autoEV) * 0.3;
        }
        return;
      }
      if (camSt) {
        // Diyafram öncelikli: obtüratör, en parlak bölge doymanın %85'ine gelecek şekilde
        if (isFinite(Ymax) && Ymax > 1e-3) {
          const N = Math.max(camSt.camFstop, 0.7);
          const t = (0.85 * Math.pow(2, camSt.camEV || 0) * 78 * N * N) / (0.65 * camSt.camISO * Ymax);
          const tc = FL.clamp(t, 1 / 8000, 1);
          this.camAutoT = Math.exp(Math.log(this.camAutoT) + (Math.log(tc) - Math.log(this.camAutoT)) * 0.35);
        }
        return;
      }
      if (isFinite(Ymax) && Ymax > 1e-3) {
        const target = Math.log2(1.0e4 / (Ymax * 1.4));
        this.autoEV += (FL.clamp(target, -8, 9) - this.autoEV) * 0.3;
      }
    };
    if (!this.sim.asyncReads) {
      apply(g.readPixels(src, 0, 0, 1, 1, new Float32Array(4)), srcS ? g.readPixels(srcS, 0, 0, 1, 1, new Float32Array(4)) : null);
      return;
    }
    this._lumInFlight = true;
    const reads = [{ target: src, w: 1, h: 1 }];
    if (srcS) reads.push({ target: srcS, w: 1, h: 1 });
    g.readAsync(reads, (out) => { this._lumInFlight = false; apply(out[0], out[1] || null); });
  }

  /** Dünya noktasını ekran pikseline izdüşür (ölçek çubuğu, etiketler) */
  project(p, w, h) {
    if (!this.lastCam) return null;
    const q = M4.transformPoint(this.lastCam.vp, p);
    if (q[2] < -1 || q[2] > 1) return null;
    return [(q[0] * 0.5 + 0.5) * w, (1 - (q[1] * 0.5 + 0.5)) * h];
  }
}

const VIEW_CODE = { real: 0, ir: 1, temp: 2, hrr: 3, soot: 4, vel: 5, species: 6, schlieren: 7, rad: 8, ai: 9 };
const AI_OFF = { org: new Float32Array(16).fill(-1), par: new Float32Array(16), px: 0.001 };
const SLICE_FIELD = { T: 0, hrr: 1, soot: 2, vel: 3, fuel: 4, o2: 5, div: 6, prod: 7 };
const SLICE_AXIS = { x: 0, y: 1, z: 2 };
FL.VIEW_CODE = VIEW_CODE;
/** Güneş yönü (yörünge arka planı, model yüzeyleri, duman) */
FL.SUN_DIR = (() => { const v = [0.5, 0.72, 0.62]; const l = Math.hypot(v[0], v[1], v[2]); return v.map((x) => x / l); })();
FL.Renderer = Renderer;
