/* =====================================================================
 * Alev Laboratuvarı — Yangın ve patlama sistemi
 * ---------------------------------------------------------------------
 * Sahne nesnelerinin (GLB parçaları) yüzeyi "yangın hücrelerine" bölünür.
 * Bir hücre ancak yakıt + ısı + oksitleyici bir aradayken yanar (yangın
 * üçgeni); parçacıklar yalnız bu modelin durumunu çizer.
 *
 * İki çözücü birbirine bağlıdır:
 *   - Akış çözücüsündeki alev (mum, jet, damla, levha) çevresindeki
 *     yüzeyleri ışınım ve alev temasıyla ısıtır: nesneler ondan tutuşur.
 *   - Nesne yangını kabin oksijenini tüketir; ortam O₂ yüzdesi düştükçe
 *     akış çözücüsündeki alev de zayıflar. Patlamanın basınç dalgası
 *     akış çözücüsündeki alevi üfler.
 *
 * Yanma çekirdeği (CombustionCore, Compartment, materials) ignition-fx
 * projesinden alınmıştır; three.js bağımlılığı yoktur.
 * ===================================================================== */
import { FL } from '../core/fl.js';
import { CombustionCore, CELL_BURNING, CELL_BURNT, CELL_DEAD, CELL_VIRGIN } from './CombustionCore.js';
import { Compartment, G0, P_ATM, effectiveOxygen, oxygenTransport } from './Compartment.js';
import { MATERIALS, isCombustible } from './materials.js';

const STEP = 1 / 30;
const MAX_STEPS_PER_FRAME = 3;
const REF_SPACING = 0.08;

/* Saniyedeki doğum bütçeleri (yoğunluk 1). Duman pufları büyüktür: en sıkı bütçe onlarındır. */
const FLAME_BUDGET = 5200;
const SMOKE_BUDGET = 70;
const EMBER_BUDGET = 70;
const PLUME_INTERVAL = 0.2;
const PLUME_SAMPLES = 10;
const PLUME_HEAT = 34;
/** Kabinde parçadan parçaya ışınım: aralık [s], en çok küme, eşik akı [W/m²], hızlandırma */
const RAD_INTERVAL = 0.4;
const RAD_CLUSTERS = 28;
const RAD_MIN_FLUX = 2500;
const RAD_ACCEL = 6;
const FLAME_COVERAGE = 7;
const FLAME_RADIUS = 0.075;
const SMOKE_PER_M2 = 40;
const EMBER_PER_M2 = 25;

export const KIND_FLAME = 0;
export const KIND_SMOKE = 1;
export const KIND_GLOW = 2;

const STRIDE = 20;
const LIFE_BUCKETS = 256;
const BUCKETS_PER_SECOND = 8;

/** Halka arabelleği: yalnız yeni yazılan aralık GPU'ya yüklenir. */
class ParticleChannel {
  constructor(capacity) {
    this.capacity = capacity;
    this.data = new Float32Array(capacity * STRIDE);
    this.head = 0;
    this.highWater = 0;
    this.live = 0;
    this.dirtyFrom = -1;
    this.wrapped = false;
    this.cleared = true;
    this._deaths = new Uint32Array(LIFE_BUCKETS);
    this._bucket = 0;
  }

  /**
   * @param time  efekt zamanı (s)
   * @param kind  KIND_*
   * @param drag  1/s; 0 = balistik, (tx,ty,tz) o zaman ivmedir
   * @param a     alev/parlama/kıvılcım: sıcaklık K   | duman: albedo
   * @param b     alev/parlama/kıvılcım: şiddet       | duman: opaklık
   * @param c     alev: mavi (kurumsuz) kesri         | duman: yangından gelen iç ışık
   */
  spawn(time, kind, x, y, z, vx, vy, vz, tx, ty, tz, drag, life, size0, size1, a, b, c, spin) {
    const i = this.head;
    const d = this.data;
    const o = i * STRIDE;
    d[o] = x; d[o + 1] = y; d[o + 2] = z; d[o + 3] = time;
    d[o + 4] = vx; d[o + 5] = vy; d[o + 6] = vz; d[o + 7] = life;
    d[o + 8] = tx; d[o + 9] = ty; d[o + 10] = tz; d[o + 11] = drag;
    d[o + 12] = size0; d[o + 13] = size1; d[o + 14] = kind; d[o + 15] = Math.random();
    d[o + 16] = a; d[o + 17] = b; d[o + 18] = c; d[o + 19] = spin;
    if (this.dirtyFrom < 0) this.dirtyFrom = i;
    this.head = i + 1;
    if (this.head === this.capacity) { this.head = 0; this.wrapped = true; }
    if (this.highWater < this.capacity) this.highWater = Math.max(this.highWater, i + 1);
    const bucket = (Math.floor((time + life) * BUCKETS_PER_SECOND) + 1) % LIFE_BUCKETS;
    this._deaths[bucket]++;
    this.live++;
  }

  tick(time) {
    const now = Math.floor(time * BUCKETS_PER_SECOND);
    let steps = Math.min(LIFE_BUCKETS, now - this._bucket);
    while (steps-- > 0) {
      this._bucket++;
      const b = this._bucket % LIFE_BUCKETS;
      this.live -= this._deaths[b];
      this._deaths[b] = 0;
    }
    if (steps < -1) this._bucket = now;
    if (this.live < 0) this.live = 0;
    if (this.live > this.capacity) this.live = this.capacity;
  }

  clear() {
    this.data.fill(0);
    this.head = 0;
    this.highWater = 0;
    this.live = 0;
    this._deaths.fill(0);
    this.dirtyFrom = -1;
    this.wrapped = false;
    this.cleared = true;
  }
}
FL.FX_STRIDE = STRIDE;

/* ------------------------------------------------------------------ */
/* Malzeme eşlemesi: model kitaplığı (LOI, sınıf) → yanma parametreleri */
/* ------------------------------------------------------------------ */
const FUEL_BASE = {
  latex: 'kopuk', paper: 'kagit', cotton: 'kumas', fabric: 'kumas', polyester: 'kumas', rubber: 'kablo', nylon: 'kablo',
  plastic: 'kablo', liion: 'elektronik', elec: 'elektronik', pc: 'elektronik', motor: 'elektronik', nomex: 'nomex',
  kapton: 'kapton', ptfe: 'kapton',
};
const INERT_STEEL = new Set(['ss', 'steel', 'brass']);

function partMaterial(part) {
  const info = part.info || {};
  const level = part.level || 0;
  let worst = null;
  for (const m of info.fuels || []) if (!worst || m.loi[0] < worst.loi[0]) worst = m;
  // Modelin kendi sınıfı "Yanmaz" ise (ör. PTFE, içi boş metal kutu) yakıt sayılmaz
  if (!worst || level === 0 || worst.loi[0] >= 90) {
    const steel = info.inert && INERT_STEEL.has(info.inert.id);
    const base = MATERIALS[steel ? 'celik' : 'aluminyum'];
    return { key: steel ? 'celik' : 'aluminyum', mat: Object.assign({}, base, { label: (info.inert && info.inert.name) || info.label || base.label }) };
  }
  const base = MATERIALS[FUEL_BASE[worst.id] || 'kablo'];
  // Yanıcılık modülüyle aynı sınır: LOI aralığının ortası (hacim kesri)
  const loi = (worst.loi[0] + worst.loi[1]) / 200;
  // Metal kutu içindeki yakıt (dolap içeriği) ya da "Düşük" sınıf: geç ısınır, yavaş yanar
  const boxed = !!info.inert && (info.fuels || []).length > 0;
  const reluctant = level <= 1;
  const mat = Object.assign({}, base, {
    label: worst.name,
    loi,
    thermalInertia: base.thermalInertia * (boxed ? 2.4 : 1) * (reluctant ? 1.5 : 1),
    burnRate: base.burnRate * (reluctant ? 0.6 : 1),
    selfOxidizing: worst.id === 'liion',
  });
  return { key: worst.id + '|' + loi.toFixed(3) + (boxed ? 'b' : '') + (reluctant ? 'r' : ''), mat };
}

/** Basınçlı kap, oksijen kaynağı, pil: ısıtılınca ne olur */
function partExplosive(part) {
  const sim = part.extras && part.extras.sim_sinifi;
  const liion = (part.info && part.info.fuels || []).some((m) => m.id === 'liion');
  // yield [MJ]: kabın yarılırken saldığı mekanik + kimyasal enerji (küçük kaplar: onlarca kJ).
  // o2Release / inertRelease [kg]: kabine karışan gaz. soak [s]: cidarın kızgın kalması gereken süre.
  if (sim === 'sondurucu_CO2') {
    return { kind: 'co2', label: 'CO₂ tüpü', yield: 0.15, fireball: 0, selfOxidizing: false, triggerTemp: 640, triggerFraction: 0.1, soak: 3, inertRelease: 2.3, suppress: 1.8 };
  }
  if (sim === 'oksijen_kaynagi') {
    return { kind: 'sfog', label: 'Oksijen üreteci', yield: 0.2, selfOxidizing: true, triggerTemp: 560, triggerFraction: 0.1, soak: 2.5, o2Release: 0.86 };
  }
  if (sim === 'oksijen_hatti') {
    return { kind: 'o2', label: 'O₂ hattı', yield: 0.05, selfOxidizing: false, triggerTemp: 720, triggerFraction: 0.14, soak: 4, o2Release: 0.6 };
  }
  if (liion) {
    return { kind: 'liion', label: 'Li-iyon pil', yield: 0.05, selfOxidizing: true, triggerTemp: 440, triggerFraction: 0.12, soak: 1.5 };
  }
  return null;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const _flow = [0, 0, 0];
const _d = [0, 0, 0];
function randomUnit(out) {
  const z = Math.random() * 2 - 1;
  const a = Math.random() * Math.PI * 2;
  const r = Math.sqrt(1 - z * z);
  out[0] = r * Math.cos(a); out[1] = r * Math.sin(a); out[2] = z;
  return out;
}
function randomDir(out, bx, by, bz) {
  let x = bx + Math.random() - 0.5, y = by + Math.random() - 0.5, z = bz + Math.random() - 0.5;
  const l = Math.hypot(x, y, z) || 1;
  out[0] = x / l; out[1] = y / l; out[2] = z / l;
  return out;
}

/** Eksen hizalı kutunun içi için çarpışma: küreyi içeri iter, hızını yansıtır */
function boxCollider(lo, hi, closed, sys) {
  return {
    lo, hi, closed,
    resolve(p, r, v, restitution) {
      // Açık laboratuvarda masa çizilmiyorsa (yörünge arka planı) çarpacak zemin de yoktur
      if (!closed && !sys.floorOn) return false;
      let hit = false;
      for (let a = 0; a < 3; a++) {
        // Açık laboratuvarda yalnız zemin (y alt sınırı) vardır
        if (!closed && a !== 1) continue;
        if (p[a] < lo[a] + r) {
          p[a] = lo[a] + r;
          if (v[a] < 0) v[a] *= -restitution;
          if (a === 1) { v[0] *= 0.9; v[2] *= 0.9; }
          hit = true;
        } else if (closed && p[a] > hi[a] - r) {
          p[a] = hi[a] - r;
          if (v[a] > 0) v[a] *= -restitution;
          hit = true;
        }
      }
      return hit;
    },
  };
}

class FxSystem {
  constructor(opts = {}) {
    this.core = new CombustionCore(4096);
    this.fire = new ParticleChannel(opts.fire ?? 12288);
    this.smoke = new ParticleChannel(opts.smoke ?? 4096);
    this.sparks = new ParticleChannel(opts.sparks ?? 4096);
    this._initDebris(opts.debris ?? 512);

    this.materialList = [];
    this._matIndex = new Map();
    this.compartments = [];
    this.cabin = null;
    this.space = null;
    this.bodies = [];
    this.scene = null;
    this.sceneKey = '';
    this.placeVersion = -1;
    this.spacing = REF_SPACING;
    this.scale = 1;

    this.gravity = [0, 0, 0];
    this.up = [0, 1, 0];
    this.gNorm = 0;
    this.density = 1;
    this.time = 0;
    this._acc = 0;
    this._scheduled = [];
    this._plumeTimer = 0;
    this._flameDemand = 0;
    this._smokeDemand = 0;
    this._emberDemand = 0;
    this._env = { gravity: [0, 0, 0], compartments: this.compartments, materials: this.materialList };

    this.shockwaves = [];
    this.shake = 0;
    this.flash = 0;
    this.flashPos = [0, 0, 0];
    this.explosionCount = 0;
    this.lastExplosion = null;
    /** Sahneyi aydınlatan yangın ışığı: konum, ışık şiddeti [cd], renk, etkin yarıçap [m] */
    this.light = { pos: [0, 0, 0], cd: 0, col: [1, 0.55, 0.2], R: 0.05, valid: false };
    this._lightTimer = 0;
    this._lightTarget = { pos: [0, 0, 0], cd: 0, valid: false };
    this.burnVersion = 0;
    this._burnTimer = 0;
    this.events = [];
    this._evSeq = 0;
    this.o2Base = null;
    this._o2Applied = null;
    this._pApplied = null;
    this.stats = { burningCells: 0, hotCells: 0, burningArea: 0, heatKW: 0, particles: 0, debris: 0, cells: 0, bodies: 0, burnedFraction: 0 };
    this.cfd = { hrr: 0, pos: [0, 0, 0], reach: 0, on: false };
    /** Akış çözücüsüne geri bildirim: patlama üflemesi, söndürücü */
    this.cfdBlow = 0;
    this.cfdSmother = 0;
  }

  _event(text, level) {
    this.events.push({ id: ++this._evSeq, t: this.time, text, level: level || 'info' });
    if (this.events.length > 60) this.events.shift();
  }

  /* -------------------------------------------------------------- */
  /* Sahne: model parçaları → gövdeler ve yangın hücreleri            */
  /* -------------------------------------------------------------- */
  materialIndex(key, mat) {
    let i = this._matIndex.get(key);
    if (i === undefined) {
      i = this.materialList.length;
      this.materialList.push(mat);
      this._matIndex.set(key, i);
    }
    return i;
  }

  /** Model sahnesi değişince (nesne eklendi / çıkarıldı / yüklendi) yeniden kur */
  bindScene(ms, st) {
    this.clearAll();
    this.core = new CombustionCore(4096);
    this.materialList.length = 0;
    this._matIndex.clear();
    this.compartments.length = 0;
    this.bodies = [];
    this.scene = ms && ms.ready ? ms : null;
    this.placeVersion = -1;

    const large = !!(this.scene && this.scene.def && this.scene.def.large);
    // Kabin: gaz hacmi ve çarpışma kutusu basınç kabuğundan. Masa üstü nesneler açık laboratuvarda.
    this.cabin = new Compartment({
      name: large ? 'Mürettebat kabini' : 'Laboratuvar',
      volume: large ? 65 : 45,
      pressure: Math.max(st.pressure, 0.001), o2Fraction: st.o2 / 100, temperature: st.Tamb,
      // Oksijen tükenme hızı çarpanı (1 = fiziksel); setEnv, Deney › Yangın ayarından günceller
      chemistryScale: st.fxDeplete ?? 1,
      burstOverpressure: 70,
      // Kabin: ısının çoğu duvarlara ve yapıya gider; basınç tahliye vanası yavaş basınç artışını
      // (yangının ısıttığı gaz) dışarı atar. Gövdeyi ancak patlamanın ani aşırı basıncı yırtar.
      gasHeatFraction: large ? 0.3 : 1,
      reliefOverpressure: large ? 12 : 0,
    });
    this._reliefSaid = false;
    this.cabin.index = 0;
    this.cabin.onOverpressure = () => {
      const h = this.hullPoint();
      if (!h) return;
      this.breach(h.p, h.n, 0.05);
      this._event('Aşırı basınç gövdeyi yırttı: kabin vakuma boşalıyor.', 'fire');
    };
    this.pBase = null;
    this._pTouched = false;
    this.space = new Compartment({ name: 'Uzay boşluğu', vacuum: true, temperature: 250 });
    this.space.index = 1;
    this.compartments.push(this.cabin, this.space);
    this.large = large;
    this._o2Applied = st.o2;
    this._pApplied = st.pressure;
    this.o2Base = st.o2;
    if (!this.scene) {
      // Sahne nesnesi yok: efektler (patlama, kıvılcım) açık laboratuvarda yine çalışır
      this.box = { lo: [-1e3, 0, -1e3], hi: [1e3, 1e3, 1e3], closed: false };
      this.cabin.collider = boxCollider(this.box.lo, this.box.hi, false, this);
      this.stats.cells = 0; this.stats.bodies = 0; this.burnVersion++;
      return;
    }

    const parts = this.scene.parts;
    // Hücre aralığı: toplam yüzey alanından; ince ağda da kaba ağda da aynı hücre yoğunluğu
    let total = 0;
    const areas = new Float64Array(parts.length);
    for (const p of parts) {
      if (p.glass) continue;
      let a = 0;
      const P = p.pos, I = p.idx;
      for (let t = 0; t < I.length; t += 3) a += triArea(P, I[t] * 3, I[t + 1] * 3, I[t + 2] * 3);
      areas[p.id] = a;
      total += a;
    }
    const target = large ? 30000 : 7000;
    this.spacing = FL.clamp(Math.sqrt(total / target), 0.012, REF_SPACING);
    this.scale = FL.clamp(this.spacing / REF_SPACING, 0.16, 1);
    const cellArea = this.spacing * this.spacing;
    const rand = mulberry32(90210);
    const ctr = [0, 1, 2].map((c) => 0.5 * (this.scene.lo[c] + this.scene.hi[c]));

    const local = [];
    const localN = [];
    for (const p of parts) {
      if (p.glass || !(areas[p.id] > 0)) continue;
      const { key, mat } = partMaterial(p);
      const mi = this.materialIndex(key, mat);
      const outside = p.noSdf;
      const comp = outside ? this.space : this.cabin;
      const explosive = partExplosive(p);
      const structural = p.shell || outside || areas[p.id] > 2.5 || !!p.cut;
      const body = {
        index: this.bodies.length, part: p, label: p.label, material: mat, materialIndex: mi, compartment: comp,
        cellStart: this.core.count, cellCount: 0, area: areas[p.id],
        center: [0, 0, 0], radius: 0.05, localCenter: [0.5 * (p.lo[0] + p.hi[0]), 0.5 * (p.lo[1] + p.hi[1]), 0.5 * (p.lo[2] + p.hi[2])],
        localRadius: 0.5 * Math.hypot(p.hi[0] - p.lo[0], p.hi[1] - p.lo[1], p.hi[2] - p.lo[2]),
        // Patlama yüküne dayanım (MJ/m²): basınçlı kaplar kalın cidarlıdır, komşu bir patlama onları kolayca yarmaz
        toughness: structural ? Infinity : explosive ? 9 : isCombustible(mat) ? 1.6 : 5,
        explosive, destroyed: false, triggered: false, cookTime: 0,
        color: p.alb ? p.alb.slice(0, 3) : [0.5, 0.5, 0.5],
        everBurned: false,
      };
      // Üçgenlere alanla orantılı nokta serp
      const P = p.pos, I = p.idx;
      const combustible = isCombustible(mat);
      const want = Math.max(1, Math.round(areas[p.id] / cellArea));
      const per = areas[p.id] / want;
      let acc = rand() * per;
      const bc = body.localCenter;
      for (let t = 0; t < I.length; t += 3) {
        const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
        acc += triArea(P, a, b, c);
        while (acc >= per) {
          acc -= per;
          let u = rand(), v = rand();
          if (u + v > 1) { u = 1 - u; v = 1 - v; }
          const w = 1 - u - v;
          const x = P[a] * w + P[b] * u + P[c] * v;
          const y = P[a + 1] * w + P[b + 1] * u + P[c + 1] * v;
          const z = P[a + 2] * w + P[b + 2] * u + P[c + 2] * v;
          // Üçgen normali; kabuk panellerinde kabinin içine, diğerlerinde parçanın dışına bakar
          const e1x = P[b] - P[a], e1y = P[b + 1] - P[a + 1], e1z = P[b + 2] - P[a + 2];
          const e2x = P[c] - P[a], e2y = P[c + 1] - P[a + 1], e2z = P[c + 2] - P[a + 2];
          let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
          const nl = Math.hypot(nx, ny, nz) || 1;
          nx /= nl; ny /= nl; nz /= nl;
          const ref = structural ? [ctr[0] - x, ctr[1] - y, ctr[2] - z] : [x - bc[0], y - bc[1], z - bc[2]];
          if (nx * ref[0] + ny * ref[1] + nz * ref[2] < 0) { nx = -nx; ny = -ny; nz = -nz; }
          local.push(x, y, z);
          localN.push(nx, ny, nz);
          this.core.addCell(x, y, z, nx, ny, nz, mi, comp.index, body.index, per, comp.temperature, combustible);
          body.cellCount++;
        }
      }
      if (body.cellCount === 0) {
        // Çok küçük parça: tek hücre, parçanın merkezinde
        local.push(bc[0], bc[1], bc[2]);
        localN.push(0, 1, 0);
        this.core.addCell(bc[0], bc[1], bc[2], 0, 1, 0, mi, comp.index, body.index, areas[p.id], comp.temperature, combustible);
        body.cellCount = 1;
      }
      this.bodies.push(body);
    }
    this.cellLocal = new Float32Array(local);
    this.cellLocalN = new Float32Array(localN);
    this.core.buildNeighbors(this.spacing * 2.75);
    this.stats.cells = this.core.count;
    this.stats.bodies = this.bodies.length;
    this._fuelCells = 0;
    for (let i = 0; i < this.core.count; i++) if (this.core.fuel[i] > 0) this._fuelCells++;
    this._burnBytes = null;
    this.burnVersion++;
    this.syncPlacement();
  }

  /** Model yerleşimi (kaydırma, döndürme, ızgara) değişince hücreleri dünya uzayına taşı */
  syncPlacement() {
    const ms = this.scene;
    if (!ms || !ms.M) return;
    if (this.placeVersion === ms.version) return;
    this.placeVersion = ms.version;
    const M = ms.M;
    const pos = this.core.position, nor = this.core.normal;
    const L = this.cellLocal, N = this.cellLocalN;
    for (let i = 0, n = this.core.count; i < n; i++) {
      const o = i * 3;
      const x = L[o], y = L[o + 1], z = L[o + 2];
      pos[o] = M[0] * x + M[4] * y + M[8] * z + M[12];
      pos[o + 1] = M[1] * x + M[5] * y + M[9] * z + M[13];
      pos[o + 2] = M[2] * x + M[6] * y + M[10] * z + M[14];
      const a = N[o], b = N[o + 1], c = N[o + 2];
      nor[o] = M[0] * a + M[4] * b + M[8] * c;
      nor[o + 1] = M[1] * a + M[5] * b + M[9] * c;
      nor[o + 2] = M[2] * a + M[6] * b + M[10] * c;
    }
    for (const body of this.bodies) {
      const c = FL.M4.transformPoint(M, body.localCenter);
      body.center[0] = c[0]; body.center[1] = c[1]; body.center[2] = c[2];
      body.radius = body.localRadius;
    }
    // Kabin kutusu: basınç kabuğu panellerinin dünya sınırları
    if (this.large) {
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      let any = false;
      for (const p of ms.parts) {
        if (!p.shell && !p.cut) continue;
        if (p.noSdf) continue;
        any = true;
        for (let k = 0; k < 8; k++) {
          const q = FL.M4.transformPoint(M, [k & 1 ? p.hi[0] : p.lo[0], k & 2 ? p.hi[1] : p.lo[1], k & 4 ? p.hi[2] : p.lo[2]]);
          for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], q[a]); hi[a] = Math.max(hi[a], q[a]); }
        }
      }
      if (!any) { for (let a = 0; a < 3; a++) { lo[a] = ms.worldLo[a]; hi[a] = ms.worldHi[a]; } }
      this.box = { lo, hi, closed: true };
      const vol = (hi[0] - lo[0]) * (hi[1] - lo[1]) * (hi[2] - lo[2]) * 0.6;
      if (vol > 5 && Math.abs(vol - this.cabin.volume) > 1) {
        const o2 = this.cabin.o2Fraction, p = this.cabin.pressure;
        this.cabin.volume = vol;
        this.cabin.setAtmosphere(p, o2);
      }
    } else {
      this.box = { lo: [-1e3, 0, -1e3], hi: [1e3, 1e3, 1e3], closed: false };
    }
    this.cabin.collider = boxCollider(this.box.lo, this.box.hi, this.box.closed, this);
    this.space.collider = null;
  }

  compartmentAt(p) {
    if (!this.box || !this.box.closed) return this.cabin;
    const { lo, hi } = this.box;
    const inside = p[0] > lo[0] && p[0] < hi[0] && p[1] > lo[1] && p[1] < hi[1] && p[2] > lo[2] && p[2] < hi[2];
    return inside ? this.cabin : this.space;
  }

  /** Ortam: yerçekimi, basınç, O₂, havalandırma (uygulama durumundan) */
  setEnv(st) {
    const g = st.gravity * G0;
    this.gravity[0] = 0; this.gravity[1] = -g; this.gravity[2] = 0;
    this.gNorm = Math.min(1, st.gravity);
    this.up[0] = 0; this.up[1] = 1; this.up[2] = 0;
    const comp = this.cabin;
    if (!comp) return;
    // Kullanıcı O₂ ya da basıncı değiştirdiyse kabin atmosferi yeniden kurulur
    if (this._pApplied === null || Math.abs(st.pressure - this._pApplied) > 1e-6 || Math.abs(st.o2 - this._o2Applied) > 0.011) {
      comp.temperature = comp.wallTemperature = st.Tamb;
      comp.setAtmosphere(Math.max(st.pressure, 0.001), st.o2 / 100);
      comp._initial = { pressure: Math.max(st.pressure, 0.001), o2Fraction: st.o2 / 100 };
      comp._designPressure = comp._initial.pressure;
      this._pApplied = st.pressure;
      this._o2Applied = st.o2;
      this.o2Base = st.o2;
    }
    comp.chemistryScale = Math.max(0, st.fxDeplete ?? 1);
    // Havalandırma: yatay rüzgâr + düşey zorlanmış akış [cm/s → m/s]
    const U = (st.wind || 0) / 100, a = ((st.windDir || 0) * Math.PI) / 180;
    let vx = U * Math.cos(a), vy = (st.flow || 0) / 100, vz = U * Math.sin(a);
    // Mekik kabini: fanlar havayı sürekli dolaştırır (ECLSS). Mikrogravitede yüzdürme olmadığından
    // alevi besleyen tek akış budur; kullanıcının rüzgârı / zorlanmış akışı varsa o geçerlidir.
    if (this.large && Math.hypot(vx, vy, vz) < 1e-4) vx = Math.max(0, st.cabinVent ?? 15) / 100;
    comp.setVentilation(vx, vy, vz);
  }

  /** Yangının tükettiği kabin oksijeni: ortam O₂ yüzdesine geri yazılacak değer (yoksa null) */
  o2Feedback() {
    const comp = this.cabin;
    if (!comp || comp.isVacuum) return null;
    const pct = +(comp.o2Fraction * 100).toFixed(2);
    if (Math.abs(pct - this._o2Applied) < 0.02) return null;
    this._o2Applied = pct;
    return pct;
  }

  /** Delinme ya da yangınla değişen kabin basıncı: ortam basıncına geri yazılacak değer (yoksa null) */
  pressureFeedback() {
    const comp = this.cabin;
    if (!comp || comp.isVacuum || !this.large) return null;
    // Yalnız gövde delikken: yangının yol açtığı küçük basınç artışı akış çözücüsüne taşınmaz
    if (!comp.breached && !this._pTouched) return null;
    const p = +Math.max(comp.pressure, 0.001).toFixed(3);
    if (Math.abs(p - this._pApplied) < 0.02) return null;
    this._pApplied = p;
    this._pTouched = true;
    return p;
  }

  /** Gövde deliği: kabin gazı boğulmuş akışla vakuma boşalır. Döner: delik kaydı */
  breach(point, normal, area = 0.05) {
    const comp = this.cabin;
    if (!comp || comp.isVacuum) return null;
    if (this.pBase == null) this.pBase = this._pApplied;
    return comp.breach(point[0], point[1], point[2], area, normal[0], normal[1], normal[2]);
  }

  /** Kabin kutusunda görünür bir duvar noktası (delik senaryosu için): arka duvar, deneyin yanı */
  hullPoint() {
    const b = this.box;
    if (!b || !b.closed) return null;
    return { p: [0.5 * (b.lo[0] + b.hi[0]) + 0.25 * (b.hi[0] - b.lo[0]), b.lo[1] + 0.55 * (b.hi[1] - b.lo[1]), b.lo[2] + 0.03], n: [0, 0, -1] };
  }

  /** Yanıcılık okuması (araç ipucu ve günlük için) */
  flammability(mat, comp) {
    const speed = Math.hypot(comp.ventilation.x, comp.ventilation.y, comp.ventilation.z);
    const transport = oxygenTransport(this.gNorm, speed);
    const ambient = effectiveOxygen(comp.o2Fraction, comp.pressure, 1);
    const sustained = effectiveOxygen(comp.o2Fraction, comp.pressure, transport);
    return { canIgnite: ambient >= mat.loi, canSustain: sustained >= mat.loi * 0.93, transport, effectiveOxygen: sustained, ambient };
  }

  describeIgnition(body) {
    const pct = (f) => '%' + (f * 100).toFixed(1).replace('.', ',');
    const mat = body.material, comp = body.compartment;
    if (!isCombustible(mat)) return { level: 'info', text: mat.label + ' yanıcı değil: üçgenin yakıt kenarı yok. Yalnız ısınır ve islenir.' };
    if (comp.isVacuum || comp.pressure < 1) return { level: 'info', text: 'Vakumda oksitleyici yok: ısı ve yakıt var ama alev oluşamaz.' };
    const f = this.flammability(mat, comp);
    if (!f.canIgnite) return { level: 'info', text: mat.label + ': etkin O₂ ' + pct(f.ambient) + ' < sınır (LOI) ' + pct(mat.loi) + ' → tutuşmaz.' };
    if (!f.canSustain) return { level: 'warn', text: mat.label + ' tutuşur, ama durgun mikrogravitede alev kendi yanma ürünlerinde boğulup söner (havalandırma yok).' };
    return { level: 'fire', text: mat.label + ' tutuştu: yakıt + ısı (≥ ' + Math.round(mat.ignitionTemp) + ' K) + oksitleyici (etkin O₂ ' + pct(f.effectiveOxygen) + ').' };
  }

  bodyAtPart(partId) {
    for (const b of this.bodies) if (b.part.id === partId) return b;
    return null;
  }

  schedule(delay, fn) {
    this._scheduled.push({ at: this.time + delay, fn });
  }

  /* -------------------------------------------------------------- */
  /* Olaylar: kıvılcım, söndürücü, patlama                            */
  /* -------------------------------------------------------------- */
  /** Kıvılcım / elektrik arkı: küçük, çok sıcak bir pilot kaynak */
  ignite(p, opts = {}) {
    const s = this.scale;
    const radius = opts.radius ?? Math.max(0.13 * s, this.spacing * 1.7);
    const comp = opts.compartment ?? this.compartmentAt(p);
    const pAtm = Math.min(1, comp.pressure / P_ATM);
    const t = this.time;
    const g = this.gravity;
    const count = Math.round(18 * Math.max(0.5, this.density));
    const ss = Math.sqrt(s);
    for (let i = 0; i < count; i++) {
      randomUnit(_d);
      const speed = (0.8 + 3.2 * Math.random()) * ss;
      const drag = 1.6 * pAtm;
      if (drag > 0.05) {
        this.sparks.spawn(t, 0, p[0], p[1], p[2], _d[0] * speed, _d[1] * speed, _d[2] * speed, g[0] / drag, g[1] / drag, g[2] / drag, drag, 0.25 + 0.6 * Math.random(), 0.012 * ss, 0.004 * ss, 2900, 3.5, 0, 0);
      } else {
        this.sparks.spawn(t, 0, p[0], p[1], p[2], _d[0] * speed, _d[1] * speed, _d[2] * speed, g[0], g[1], g[2], 0, 0.5 + 0.8 * Math.random(), 0.012 * ss, 0.006 * ss, 2900, 3.5, 0, 0);
      }
    }
    this.fire.spawn(t, KIND_GLOW, p[0], p[1], p[2], 0, 0, 0, 0, 0, 0, 0, 0.22, 0.12 * ss, 0.3 * ss, 3100, 0.9, 0, 0);
    return this.core.heatSphere(p[0], p[1], p[2], radius, opts.heat ?? 1150, true);
  }

  /** CO₂ tipi söndürücü: oksijeni yerinden eder ve soğutur */
  extinguish(p, opts = {}) {
    const s = Math.max(this.scale, 0.3);
    const radius = opts.radius ?? 0.65 * s;
    const comp = opts.compartment ?? this.compartmentAt(p);
    const t = this.time;
    if (!comp.isVacuum && comp.pressure > 1) {
      comp.flowAt(p[0], p[1], p[2], _flow);
      const count = Math.round(16 * Math.max(0.5, this.density));
      for (let i = 0; i < count; i++) {
        randomUnit(_d);
        const speed = (0.6 + 1.6 * Math.random()) * s;
        this.smoke.spawn(
          t + Math.random() * 0.15, KIND_SMOKE,
          p[0] + _d[0] * 0.08 * s, p[1] + _d[1] * 0.08 * s, p[2] + _d[2] * 0.08 * s,
          _d[0] * speed, _d[1] * speed, _d[2] * speed, _flow[0], _flow[1], _flow[2],
          2.2, 1.2 + 1.2 * Math.random(), radius * 0.25, radius * (0.6 + 0.4 * Math.random()), 0.92, 0.22, 0, (Math.random() - 0.5) * 0.6,
        );
      }
      comp.addGas(0, 0.4 * s);
    }
    // Akış çözücüsündeki alev de bulutun içindeyse boğulur
    const c = this.cfd;
    if (c.on && Math.hypot(c.pos[0] - p[0], c.pos[1] - p[1], c.pos[2] - p[2]) < radius + c.reach) this.cfdSmother = Math.max(this.cfdSmother, 1.5);
    return this.core.suppressSphere(p[0], p[1], p[2], radius, opts.seconds ?? 6, 330);
  }

  /**
   * Patlama; çevrenin izin verdiği kadar:
   *  - Ateş topu: ancak oksitleyici kadar. Kendi oksitleyicisini taşıyan yük her yerde yanar;
   *    yalnız yakıt içeren patlama kabin oksijenine muhtaçtır.
   *  - Şok dalgası, duman, sürüklenme, yüzdürme: gaz ister. Vakumda ürünler serbestçe genişler,
   *    parçalar düz çizgide uçar ve sıcak kalır.
   * @param {number[]} p
   * @param {{yield?:number, selfOxidizing?:boolean, fireball?:number, compartment?:object, source?:object}} options
   */
  explode(p, options = {}) {
    const energy = options.yield ?? 1;
    const comp = options.compartment ?? this.compartmentAt(p);
    const pAtm = Math.min(1, comp.pressure / P_ATM);
    const selfOx = options.selfOxidizing !== false;
    const oxidizer = selfOx ? 1 : Math.min(1.5, effectiveOxygen(comp.o2Fraction, comp.pressure, 1) / 0.21);
    const fire = Math.min(1.3, options.fireball ?? oxidizer);
    const size = Math.cbrt(energy);
    const R = 0.5 * size;
    const density = this.density;
    const t = this.time;
    const x = p[0], y = p[1], z = p[2];
    const gN = this.gNorm;
    const up = this.up;
    const buoy = gN * pAtm;
    const g = this.gravity;
    comp.flowAt(x, y, z, _flow);
    this.explosionCount++;

    // Parlama
    this.fire.spawn(t, KIND_GLOW, x, y, z, 0, 0, 0, 0, 0, 0, 0, 0.16, R * 2.6, R * 6, 3200, 1.0 * (0.45 + 0.55 * fire), 0, 0);
    if (fire > 0.05) this.fire.spawn(t, KIND_GLOW, x, y, z, 0, 0, 0, 0, 0, 0, 0, 0.6, R * 1.6, R * 3.2, 2500, 0.8 * fire, 0, 0);

    // Ateş topu
    const drag = 4.5 * pAtm;
    const fireCount = Math.round(95 * density * Math.min(2.2, Math.max(size, 0.6)) * Math.min(1, fire + 0.1));
    for (let i = 0; i < fireCount; i++) {
      randomUnit(_d);
      const spread = 0.25 + 0.75 * Math.sqrt(Math.random());
      const start = R * 0.15 * Math.random();
      if (drag > 0.5) {
        const speed = R * drag * spread * 1.05;
        const rise = (0.5 + 0.9 * Math.random()) * buoy * (1 + size) * Math.sqrt(Math.min(1, size));
        this.fire.spawn(
          t + Math.random() * 0.05, KIND_FLAME,
          x + _d[0] * start, y + _d[1] * start, z + _d[2] * start,
          _d[0] * speed, _d[1] * speed, _d[2] * speed,
          _flow[0] + up[0] * rise, _flow[1] + up[1] * rise, _flow[2] + up[2] * rise,
          drag, (0.55 + 0.6 * Math.random()) * (0.8 + 0.25 * size),
          R * 0.3, R * (0.62 + 0.4 * Math.random()),
          2500 + 450 * Math.random(), 1.05 * Math.min(1, fire), 0, (Math.random() - 0.5) * 2,
        );
      } else {
        // Serbest genişleme: hızlı, kısa ömürlü, büyüdükçe seyrelir
        const speed = R * (5 + 13 * spread);
        this.fire.spawn(
          t + Math.random() * 0.03, KIND_FLAME,
          x + _d[0] * start, y + _d[1] * start, z + _d[2] * start,
          _d[0] * speed, _d[1] * speed, _d[2] * speed, 0, 0, 0,
          0, 0.2 + 0.32 * Math.random(),
          R * 0.32, R * (1.3 + 0.8 * Math.random()),
          2600 + 400 * Math.random(), 0.95 * Math.min(1, fire), 0, (Math.random() - 0.5) * 2,
        );
      }
    }

    // Duman gazda asılı kalır; gaz yoksa ürünler dağılır gider
    const smokeCount = Math.round(24 * density * Math.min(2, Math.max(size, 0.6)) * pAtm * (0.4 + 0.6 * Math.min(1, fire)));
    for (let i = 0; i < smokeCount; i++) {
      randomUnit(_d);
      const speed = R * 3 * (0.35 + 0.75 * Math.random());
      const rise = (0.4 + 0.7 * Math.random()) * buoy * (1 + size) * Math.sqrt(Math.min(1, size));
      this.smoke.spawn(
        t + 0.08 + Math.random() * 0.25, KIND_SMOKE,
        x + _d[0] * R * 0.3, y + _d[1] * R * 0.3, z + _d[2] * R * 0.3,
        _d[0] * speed, _d[1] * speed, _d[2] * speed,
        _flow[0] + up[0] * rise, _flow[1] + up[1] * rise, _flow[2] + up[2] * rise,
        2.6, 3 + 3.5 * Math.random(),
        R * 0.45, R * (1.1 + 0.7 * Math.random()),
        options.fireball === 0 ? 0.9 : 0.035 + 0.06 * Math.random(), options.fireball === 0 ? 0.3 : 0.5, options.fireball === 0 ? 0 : 1, (Math.random() - 0.5) * 0.8,
      );
    }

    // Kıvılcımlar: kızgın gövde parçaları ve erimiş metal
    const sparkCount = Math.round(110 * density * Math.min(2, Math.max(size, 0.5)));
    const sparkDrag = 1.3 * pAtm;
    const sz = Math.sqrt(Math.min(1, size));
    for (let i = 0; i < sparkCount; i++) {
      randomUnit(_d);
      const speed = (4 + 18 * Math.random() * Math.random()) * Math.sqrt(size);
      if (sparkDrag > 0.05) {
        this.sparks.spawn(
          t, 0, x, y, z, _d[0] * speed, _d[1] * speed, _d[2] * speed,
          _flow[0] + g[0] / sparkDrag, _flow[1] + g[1] / sparkDrag, _flow[2] + g[2] / sparkDrag,
          sparkDrag, 0.5 + 1.2 * Math.random(), 0.02 * sz, 0.008 * sz, 2300 + 700 * Math.random(), 3, 0, 0,
        );
      } else {
        this.sparks.spawn(t, 0, x, y, z, _d[0] * speed, _d[1] * speed, _d[2] * speed, g[0], g[1], g[2], 0, 1.1 + 1.6 * Math.random(), 0.02 * sz, 0.01 * sz, 2300 + 700 * Math.random(), 3, 0, 0);
      }
    }

    const shock = pAtm > 0.15;
    if (shock) {
      if (this.shockwaves.length >= FL.FX_SHADERS.MAX_SHOCK) this.shockwaves.shift();
      this.shockwaves.push({ center: [x, y, z], radius: R * 0.4, speed: 15 + 6 * size, age: 0, life: 0.5 + 0.12 * size, strength: Math.min(2.6, Math.max(size, 0.4)) * pAtm });
      this.shake = Math.min(0.5, this.shake + 0.07 * size * pAtm);
    }

    this.flash = Math.max(this.flash, 2.5e4 * size * size * (0.4 + 0.6 * Math.min(1, fire)));
    this.flashPos = [x, y, z];

    // Isı darbesi: gaz varsa ateş topu teması, yoksa ışınım
    const core = this.core;
    core.heatSphere(x, y, z, R * 2.6, 250 + 1250 * (0.35 + 0.65 * pAtm) * Math.min(1, fire), true, 2600, this.materialList.map((m) => m.thermalInertia));
    core.scorchSphere(x, y, z, R * 1.9, 0.8 * Math.min(1, fire + 0.2));
    comp.addHeat(energy * 1.0);

    // Bölmeyi paylaşan her şeye patlama yükü
    for (const body of this.bodies) {
      if (body.destroyed || body.compartment !== comp || body === options.source) continue;
      const dx = body.center[0] - x, dy = body.center[1] - y, dz = body.center[2] - z;
      const distance = Math.hypot(dx, dy, dz);
      const d = Math.max(0.12 * Math.max(this.scale, 0.3), distance - body.radius * 0.6);
      const load = (energy / (d * d)) * (0.3 + 0.7 * pAtm);
      if (load > body.toughness) {
        if (body.explosive && !body.triggered) this.triggerBody(body, 0.05 + 0.12 * Math.random());
        else this.shatter(body, p, Math.min(14, 3 + 3 * Math.sqrt(load)));
      }
    }

    const shards = Math.round(14 * density * Math.min(2, Math.max(size, 0.5)));
    const casing = [0.29, 0.3, 0.32];
    for (let i = 0; i < shards; i++) {
      randomUnit(_d);
      const sp = (2.5 + 9 * Math.random()) * Math.sqrt(size);
      this.spawnDebris([x + _d[0] * R * 0.2, y + _d[1] * R * 0.2, z + _d[2] * R * 0.2], [_d[0] * sp, _d[1] * sp, _d[2] * sp], (0.015 + 0.04 * Math.random() ** 2) * Math.max(sz, 0.35), casing, 0.65 + 0.35 * Math.random(), comp);
    }

    // Basınç dalgası akış çözücüsündeki alevi üfler (gaz varsa)
    const c = this.cfd;
    if (shock && c.on) {
      const dist = Math.hypot(c.pos[0] - x, c.pos[1] - y, c.pos[2] - z);
      if (energy / Math.max(dist * dist, 0.01) > 0.4) this.cfdBlow = Math.max(this.cfdBlow, 0.5);
    }
    this.lastExplosion = { t, pos: [x, y, z], yield: energy, fireball: fire, shock, radius: R };
    this.burnVersion++;
    return { compartment: comp, fireball: fire, shock };
  }

  /** Patlayıcı bir gövdeyi (basınçlı kap, oksijen kaynağı, pil) patlatır */
  triggerBody(body, delay = 0) {
    if (body.triggered || body.destroyed || !body.explosive) return;
    body.triggered = true;
    const go = () => {
      if (body.destroyed) return;
      const spec = body.explosive;
      const comp = body.compartment;
      const center = body.center.slice();
      if (spec.o2Release) comp.addGas(spec.o2Release, 0);
      if (spec.inertRelease) comp.addGas(0, spec.inertRelease);
      this.shatter(body, center, 5 + 3 * Math.cbrt(spec.yield ?? 1));
      this.explode(center, Object.assign({}, spec, { compartment: comp, source: body }));
      const pct = '%' + (comp.o2Fraction * 100).toFixed(1).replace('.', ',');
      if (spec.kind === 'co2') {
        // Boşalan CO₂ çevredeki alevleri boğar
        this.core.suppressSphere(center[0], center[1], center[2], spec.suppress * Math.max(this.scale, 0.35), 8, 320);
        this._event('CO₂ tüpü yarıldı: inert gaz, ateş topu yok. Boşalan CO₂ çevredeki alevleri boğdu; kabin O₂ ' + pct + '.', 'info');
      } else if (spec.kind === 'sfog') {
        this._event('Oksijen üreteci alev aldı (Mir, 1997): kendi oksijenini ürettiği için söndürülemez; kabin O₂ ' + pct + ' oldu.', 'fire');
      } else if (spec.kind === 'o2') {
        this._event('O₂ hattı yarıldı: kabin oksijeni ' + pct + '. Daha çok malzeme yanıcı hale geldi, yanma hızlandı.', 'fire');
      } else if (spec.kind === 'liion') {
        this._event('Li-iyon pil ısıl kaçağa girdi: kendi oksitleyicisini taşır, ortam O₂’sinden bağımsız yanar.', 'fire');
      }
    };
    if (delay > 0) this.schedule(delay, go);
    else go();
  }

  /** Parçalanma: parça gizlenir, yerine origin'den uzağa uçan enkaz gelir */
  shatter(body, origin, speed) {
    if (body.destroyed) return;
    body.destroyed = true;
    body.part.destroyed = true;
    this.partsDirty = true;
    const core = this.core;
    const spacing = Math.sqrt(body.area / body.cellCount);
    const pieces = Math.max(6, Math.min(48, Math.round(body.cellCount * 0.1 * this.density)));
    for (let k = 0; k < pieces; k++) {
      const c = body.cellStart + Math.floor(Math.random() * body.cellCount);
      const px = core.position[c * 3], py = core.position[c * 3 + 1], pz = core.position[c * 3 + 2];
      let nx = px - origin[0], ny = py - origin[1], nz = pz - origin[2];
      const d = Math.hypot(nx, ny, nz) || 1e-3;
      nx = nx / d + (Math.random() - 0.5) * 0.7;
      ny = ny / d + (Math.random() - 0.5) * 0.7;
      nz = nz / d + (Math.random() - 0.5) * 0.7;
      const l = Math.hypot(nx, ny, nz) || 1;
      const sp = (speed * (0.35 + Math.random() * 0.9)) / l;
      const heat = Math.min(1, Math.max(0, (core.temperature[c] - 450) / 900) + Math.random() ** 3 * 0.75);
      // Çoğu küçük parça, birkaç büyük plaka
      const size = Math.max(0.018 * Math.max(this.scale, 0.3), spacing * (0.25 + 1.5 * Math.random() ** 3));
      this.spawnDebris([px, py, pz], [nx * sp, ny * sp, nz * sp], size, body.color, heat, body.compartment);
    }
    for (let i = body.cellStart, end = body.cellStart + body.cellCount; i < end; i++) {
      core.state[i] = CELL_DEAD;
      core.intensity[i] = 0;
    }
    this.burnVersion++;
  }

  /* -------------------------------------------------------------- */
  /* Enkaz                                                           */
  /* -------------------------------------------------------------- */
  _initDebris(capacity) {
    const d = (this.debris = { capacity, count: 0, next: 0, active: 0 });
    d.position = new Float32Array(capacity * 3);
    d.velocity = new Float32Array(capacity * 3);
    d.axis = new Float32Array(capacity * 3);
    d.scale = new Float32Array(capacity * 3);
    d.color = new Float32Array(capacity * 3);
    d.angle = new Float32Array(capacity);
    d.spin = new Float32Array(capacity);
    d.age = new Float32Array(capacity);
    d.life = new Float32Array(capacity);
    d.heat = new Float32Array(capacity);
    d.alive = new Uint8Array(capacity);
    d.impactAge = new Float32Array(capacity);
    d.comp = new Array(capacity).fill(null);
    /** Örnek tamponu: (konum, ısı) (eksen, açı) (ölçek, -) (renk, -) */
    d.inst = new Float32Array(capacity * 16);
  }

  spawnDebris(pos, vel, size, color, heat, comp, life) {
    const d = this.debris;
    const i = d.next;
    d.next = (d.next + 1) % d.capacity;
    if (d.count < d.capacity) d.count = Math.max(d.count, i + 1);
    const o = i * 3;
    d.position[o] = pos[0]; d.position[o + 1] = pos[1]; d.position[o + 2] = pos[2];
    d.velocity[o] = vel[0]; d.velocity[o + 1] = vel[1]; d.velocity[o + 2] = vel[2];
    randomUnit(_d);
    d.axis[o] = _d[0]; d.axis[o + 1] = _d[1]; d.axis[o + 2] = _d[2];
    d.scale[o] = size * (0.6 + Math.random() * 0.9);
    d.scale[o + 1] = size * (0.5 + Math.random() * 0.6);
    d.scale[o + 2] = size * (0.6 + Math.random() * 0.9);
    const k = 0.55 + Math.random() * 0.45;
    d.color[o] = color[0] * k; d.color[o + 1] = color[1] * k; d.color[o + 2] = color[2] * k;
    d.angle[i] = Math.random() * 6.283;
    d.spin[i] = (Math.random() - 0.5) * 22;
    d.age[i] = 0;
    d.life[i] = life ?? (comp && comp.isVacuum ? 9 + Math.random() * 5 : 14 + Math.random() * 8);
    d.heat[i] = heat;
    d.impactAge[i] = -1;
    d.alive[i] = 1;
    d.comp[i] = comp;
  }

  _updateDebris(dt) {
    const d = this.debris;
    const g = this.gravity;
    const gl2 = g[0] * g[0] + g[1] * g[1] + g[2] * g[2];
    const p = [0, 0, 0], v = [0, 0, 0];
    let active = 0;
    for (let i = 0; i < d.count; i++) {
      const q = i * 16;
      if (!d.alive[i]) { d.inst[q + 8] = 0; continue; }
      const o = i * 3;
      d.age[i] += dt;
      if (d.age[i] >= d.life[i]) { d.alive[i] = 0; d.heat[i] = 0; d.inst[q + 8] = 0; continue; }
      active++;
      const comp = d.comp[i];
      const pAtm = comp ? Math.min(1, comp.pressure / P_ATM) : 0;
      v[0] = d.velocity[o] + g[0] * dt; v[1] = d.velocity[o + 1] + g[1] * dt; v[2] = d.velocity[o + 2] + g[2] * dt;
      if (pAtm > 0) { const k = Math.exp(-0.35 * pAtm * dt); v[0] *= k; v[1] *= k; v[2] *= k; }
      p[0] = d.position[o] + v[0] * dt; p[1] = d.position[o + 1] + v[1] * dt; p[2] = d.position[o + 2] + v[2] * dt;
      const col = comp && comp.collider;
      if (col) {
        const before = v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
        if (col.resolve(p, d.scale[o] * 0.5, v, 0.42)) {
          d.spin[i] *= 0.7;
          // Kızgın parça yakıta çarparsa pilot kaynaktır
          if (d.heat[i] > 0.45 && before > 0.25 && d.age[i] - d.impactAge[i] > 0.3) {
            d.impactAge[i] = d.age[i];
            if (!comp.isVacuum) this.core.heatSphere(p[0], p[1], p[2], Math.max(0.16 * this.scale, this.spacing * 1.6), 420 * d.heat[i], true);
          }
          if (v[0] * v[0] + v[1] * v[1] + v[2] * v[2] < 0.01 && gl2 > 0.1) { v[0] = v[1] = v[2] = 0; d.spin[i] = 0; }
        }
      }
      d.velocity[o] = v[0]; d.velocity[o + 1] = v[1]; d.velocity[o + 2] = v[2];
      d.position[o] = p[0]; d.position[o + 1] = p[1]; d.position[o + 2] = p[2];
      d.angle[i] += d.spin[i] * dt;
      // Taşınım ısıyı ancak gaz varsa götürür
      d.heat[i] *= Math.exp(-(0.07 + 0.5 * pAtm) * dt);
      const remaining = d.life[i] - d.age[i];
      const shrink = remaining < 1 ? remaining : 1;
      d.inst[q] = p[0]; d.inst[q + 1] = p[1]; d.inst[q + 2] = p[2]; d.inst[q + 3] = d.heat[i];
      d.inst[q + 4] = d.axis[o]; d.inst[q + 5] = d.axis[o + 1]; d.inst[q + 6] = d.axis[o + 2]; d.inst[q + 7] = d.angle[i];
      d.inst[q + 8] = d.scale[o] * shrink; d.inst[q + 9] = d.scale[o + 1] * shrink; d.inst[q + 10] = d.scale[o + 2] * shrink;
      d.inst[q + 12] = d.color[o]; d.inst[q + 13] = d.color[o + 1]; d.inst[q + 14] = d.color[o + 2];
    }
    d.dirty = active > 0 || d.active > 0;
    d.active = active;
  }

  /* -------------------------------------------------------------- */
  /* Zaman adımı                                                     */
  /* -------------------------------------------------------------- */
  /**
   * @param dt   benzetim süresi [s]
   * @param cfd  akış çözücüsündeki alev: { on, hrr [W], pos, height [m] }
   */
  update(dt, cfd) {
    dt = Math.min(dt, 0.1);
    if (!(dt > 0)) return;
    this.time += dt;
    this.syncPlacement();
    if (cfd) {
      this.cfd.on = !!cfd.on && cfd.hrr > 0.05;
      this.cfd.hrr = cfd.hrr || 0;
      this.cfd.pos = cfd.pos;
      this.cfd.reach = Math.max(0.006, cfd.height || 0);
    }

    if (this._scheduled.length > 0) {
      for (let i = this._scheduled.length - 1; i >= 0; i--) {
        if (this._scheduled[i].at <= this.time) {
          const [ev] = this._scheduled.splice(i, 1);
          ev.fn();
        }
      }
    }

    this._acc += dt;
    let steps = 0;
    while (this._acc >= STEP && steps < MAX_STEPS_PER_FRAME) {
      this._acc -= STEP;
      steps++;
      this._step(STEP);
    }
    if (this._acc > STEP) this._acc = 0;

    this._emitFire(dt);
    this._emitVenting(dt);
    this._updateDebris(dt);

    for (let i = this.shockwaves.length - 1; i >= 0; i--) {
      const w = this.shockwaves[i];
      w.age += dt;
      w.radius += w.speed * dt;
      if (w.age >= w.life) this.shockwaves.splice(i, 1);
    }
    this.flash *= Math.exp(-dt * 8);
    if (this.flash < 0.5) this.flash = 0;
    this.shake *= Math.exp(-dt * 5);
    if (this.shake < 1e-4) this.shake = 0;
    if (this.cfdBlow > 0) this.cfdBlow = Math.max(0, this.cfdBlow - dt);
    if (this.cfdSmother > 0) this.cfdSmother = Math.max(0, this.cfdSmother - dt);

    this._updateLight(dt);
    this.fire.tick(this.time);
    this.smoke.tick(this.time);
    this.sparks.tick(this.time);

    const core = this.core;
    const s = this.stats;
    s.burningCells = core.burningCount;
    s.hotCells = core.hotCount;
    s.heatKW = core.heatReleaseKW;
    s.particles = this.fire.live + this.smoke.live + this.sparks.live;
    s.debris = this.debris.active;
    let area = 0;
    for (let b = 0; b < core.burningCount; b++) area += core.area[core.burningList[b]];
    s.burningArea = area;

    // Yanık izi dokusu saniyede birkaç kez yenilenir
    this._burnTimer -= dt;
    if (this._burnTimer <= 0 && (steps > 0)) {
      this._burnTimer = 0.14;
      if (core.burningCount > 0 || core.hotCount > 0 || this._burnLive) this.burnVersion++;
      this._burnLive = core.burningCount > 0 || core.hotCount > 0;
    }
  }

  _step(dt) {
    const env = this._env;
    env.gravity[0] = this.gravity[0]; env.gravity[1] = this.gravity[1]; env.gravity[2] = this.gravity[2];
    for (const comp of this.compartments) comp.step(dt);
    if (this.cabin.reliefOpen && !this._reliefSaid) {
      this._reliefSaid = true;
      this._event('Kabin basınç tahliye vanası açıldı: yangının ısıttığı gaz dışarı atılıyor.', 'info');
    }
    const core = this.core;
    this._heatFromCFD(dt);
    const before = core.burningCount;
    core.step(dt, env);
    if (before === 0 && core.burningCount > 0) {
      const body = this.bodies[core.body[core.burningList[0]]];
      if (body && !body.everBurned) {
        body.everBurned = true;
        this._event(body.label + ': ' + this.describeIgnition(body).text, 'fire');
      }
    } else if (before > 0 && core.burningCount === 0) {
      const comp = this.cabin;
      const why = comp.pressure < 5 ? 'basınç düştü, oksitleyici kalmadı' : this.gNorm < 0.05 && Math.hypot(comp.ventilation.x, comp.ventilation.y, comp.ventilation.z) < 0.03
        ? 'durgun mikrogravitede alev kendi ürünlerinde boğuldu' : 'yakıt, ısı ya da oksitleyiciden biri kesildi';
      this._event('Yangın söndü: ' + why + '.', 'info');
    }

    // Basınçlı kaplar ve oksijen kaynakları pişince bırakır
    for (const body of this.bodies) {
      if (!body.explosive || body.triggered || body.destroyed) continue;
      const spec = body.explosive;
      const limit = spec.triggerTemp ?? 650;
      let hot = 0;
      const temp = core.temperature;
      for (let i = body.cellStart, end = body.cellStart + body.cellCount; i < end; i++) if (temp[i] > limit) hot++;
      // Kap en zayıf yerinden bırakır: yeterince uzun süre kızgın kalan bir yama yeter
      const cooking = hot / body.cellCount >= (spec.triggerFraction ?? 0.12);
      body.cookTime = cooking ? body.cookTime + dt : Math.max(0, body.cookTime - dt * 0.5);
      if (body.cookTime > (spec.soak ?? 1.5)) this.triggerBody(body, spec.delay ?? 0);
    }

    // Alev, oturduğu yüzeyden öteye uzanır: örneklenen birkaç yanan hücre tüyünün değdiğini ısıtır
    // (1 g'de yukarı ve rüzgâr altı; durgun mikrogravitede ve vakumda yalnız kısa menzilli ışınım)
    this._plumeTimer -= dt;
    if (this._plumeTimer <= 0) {
      this._plumeTimer = PLUME_INTERVAL;
      const n = core.burningCount;
      const stride = Math.max(1, Math.ceil(n / PLUME_SAMPLES));
      const s = this.scale;
      for (let b = Math.floor(Math.random() * stride); b < n; b += stride) {
        const i = core.burningList[b];
        const comp = this.compartments[core.compartment[i]];
        const pAtm = Math.min(1, comp.pressure / P_ATM);
        const x = core.position[i * 3], y = core.position[i * 3 + 1], z = core.position[i * 3 + 2];
        comp.flowAt(x, y, z, _flow);
        const buoy = this.gNorm * pAtm;
        let dx = this.up[0] * buoy + _flow[0] * 2.5 * pAtm;
        let dy = this.up[1] * buoy + _flow[1] * 2.5 * pAtm;
        let dz = this.up[2] * buoy + _flow[2] * 2.5 * pAtm;
        const carried = Math.min(1, Math.hypot(dx, dy, dz));
        if (carried > 1e-3) { dx /= carried; dy /= carried; dz /= carried; }
        // Kapalı kabinde alev ışınımı ve sıcak gaz parçadan parçaya da atlar: erim, hücre ölçeğiyle
        // birlikte küçülmez (yoksa yangın tutuştuğu parçada kalır, komşu dolaba, kabloya geçemez)
        const sr = this.large ? Math.max(s, 0.85) : s;
        const reach = (0.14 + 0.2 * carried) * Math.min(1.8, 0.8 + 0.12 * Math.sqrt(stride)) * sr;
        const heat = PLUME_HEAT * core.intensity[i] * (this.large ? 0.55 + 0.45 * carried : 0.3 + 0.7 * carried);
        core.heatSphere(
          x + dx * reach * carried + core.normal[i * 3] * 0.05 * s,
          y + dy * reach * carried + core.normal[i * 3 + 1] * 0.05 * s,
          z + dz * reach * carried + core.normal[i * 3 + 2] * 0.05 * s,
          Math.max(0.16 * sr + reach * 0.6, this.spacing * 1.5), heat, true, 1400,
        );
      }
    }

    // Kapalı hacimde sıcak gaz katmanı: yangın kabin gazını ısıtır, sıcak gaz da henüz yanmayan
    // yüzeyleri ısıtır (kompartıman yangınının büyüme evresi; yeterince ısınırsa genel tutuşma).
    if (this.large) {
      this._heatFromGas(dt);
      this._radTimer = (this._radTimer || 0) - dt;
      if (this._radTimer <= 0) { this._radTimer = RAD_INTERVAL; this._radiantExchange(RAD_INTERVAL); }
    }
  }

  /**
   * Yangının ışınımı: yanan hücreler kaba kümelere toplanır, her küme çevresindeki yüzeyleri
   * q″ = χ·Q̇ / (4πr²) (χ ≈ 0,3) ile ısıtır. Yüzdürmenin olmadığı kabinde alevi bir parçadan
   * ötekine (dolaptan kabloya, kumaştan kâğıda) taşıyan asıl yol budur: komşuluk bağları yalnız
   * birbirine değen parçaları, alev tüyü yalnız birkaç santimetreyi kapsar.
   */
  _radiantExchange(dt) {
    const core = this.core;
    const nb = core.burningCount;
    if (nb === 0) return;
    const pos = core.position, nor = core.normal;
    const BIN = 0.45;
    const bins = new Map();
    for (let b = 0; b < nb; b++) {
      const i = core.burningList[b];
      const m = this.materialList[core.material[i]];
      // Hücrenin ısı salınımı [W]
      const P = core.intensity[i] * core.area[i] * m.burnRate * m.heatOfCombustion * 1e6;
      if (!(P > 0)) continue;
      const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
      const key = Math.floor(x / BIN) + 4096 * Math.floor(y / BIN) + 16777216 * Math.floor(z / BIN);
      let c = bins.get(key);
      if (!c) bins.set(key, (c = [0, 0, 0, 0, core.compartment[i]]));
      c[0] += P; c[1] += P * x; c[2] += P * y; c[3] += P * z;
    }
    let clusters = [...bins.values()].filter((c) => c[0] > 3000);
    if (!clusters.length) return;
    clusters.sort((a, b) => b[0] - a[0]);
    if (clusters.length > RAD_CLUSTERS) clusters.length = RAD_CLUSTERS;
    const nC = clusters.length;
    const cx = new Float32Array(nC), cy = new Float32Array(nC), cz = new Float32Array(nC), cq = new Float32Array(nC), cr2 = new Float32Array(nC);
    for (let k = 0; k < nC; k++) {
      const c = clusters[k];
      cx[k] = c[1] / c[0]; cy[k] = c[2] / c[0]; cz[k] = c[3] / c[0];
      cq[k] = (0.3 * c[0]) / (4 * Math.PI);            // q″·r²
      // Kümenin katkısının önemsizleştiği uzaklığın karesi (toplam eşiğin küçük bir payı:
      // birkaç orta boy kümenin toplamı da uzaktaki yüzeyi tutuşturabilir)
      cr2[k] = cq[k] / (RAD_MIN_FLUX / 8);
    }
    const comp = this.cabin;
    const pAtm = Math.min(1, comp.pressure / P_ATM);
    if (comp.isVacuum) return;
    const temp = core.temperature, state = core.state, mat = core.material, cidx = core.compartment, pilot = core.pilot;
    const k = (dt * RAD_ACCEL) / 1800;
    for (let i = 0, n = core.count; i < n; i++) {
      if (state[i] !== 0 || cidx[i] !== comp.index) continue;
      const o = i * 3;
      const x = pos[o], y = pos[o + 1], z = pos[o + 2];
      let q = 0;
      for (let c = 0; c < nC; c++) {
        const dx = cx[c] - x, dy = cy[c] - y, dz = cz[c] - z;
        const r2 = dx * dx + dy * dy + dz * dz;
        if (r2 > cr2[c]) continue;
        const r = Math.sqrt(r2) || 1e-3;
        // Yangına bakan yüzey tam akıyı alır; sırtı dönük olan saçılan / yansıyan küçük bir payı
        const facing = Math.max(0.2, (nor[o] * dx + nor[o + 1] * dy + nor[o + 2] * dz) / r);
        q += (cq[c] / Math.max(r2, 0.03)) * facing;
      }
      if (q < RAD_MIN_FLUX) continue;
      q = Math.min(q, 90000);
      const dT = (k * q) / this.materialList[mat[i]].thermalInertia;
      temp[i] = Math.min(1250, temp[i] + dT);
      // Güçlü akıda yüzeyin önünde alev dilleri / kıvılcım bulunur: pilotlu tutuşma sıcaklığı geçerli
      if (q > 9000 && pAtm > 0.05) pilot[i] = Math.max(pilot[i], RAD_INTERVAL + 0.2);
    }
  }

  /** Kabin gazından yüzeylere taşınım + ışınım: T_yüzey → T_gaz, ısıl eylemsizlikle */
  _heatFromGas(dt) {
    const comp = this.cabin;
    if (!comp || comp.isVacuum) return;
    const core = this.core;
    const Tg = comp.temperature;
    if (Tg < comp.wallTemperature + 35 || core.burningCount === 0) return;
    const n = core.count;
    const temp = core.temperature, state = core.state, mat = core.material, cidx = core.compartment;
    const pAtm = Math.min(1, comp.pressure / P_ATM);
    // Her adımda hücrelerin dörtte biri: maliyet düşük, etki aynı (zaman sabiti saniyeler)
    this._gasPhase = ((this._gasPhase || 0) + 1) & 3;
    const k = dt * 4 * 0.03 * (0.25 + 0.75 * pAtm);
    for (let i = this._gasPhase; i < n; i += 4) {
      if (state[i] !== 0 || cidx[i] !== comp.index) continue;
      const d = Tg - temp[i];
      if (d <= 0) continue;
      temp[i] += (d * k) / this.materialList[mat[i]].thermalInertia;
      // Sıcak gaz katmanında alev dilleri dolaşır: pilot kaynak var sayılır
      if (Tg > 600) core.pilot[i] = Math.max(core.pilot[i], 0.3);
    }
  }

  /**
   * Akış çözücüsündeki alevin (mum, jet, damla, levha) nesnelere verdiği ısı.
   *   Işınım: q″ = χ·Q̇ / (4πr²)   (optik ince, χ ≈ 0,3)
   *   Alev teması ve tüy: alevin boyu kadar yakındaki ve üstündeki yüzeylerde ~60 kW/m²
   * Yüzey sıcaklığı ince cidar yaklaşımıyla yükselir: dT/dt = q″ / (ρ c δ). İzlenebilir
   * olsun diye ısınma 4 kat hızlandırılır.
   */
  _heatFromCFD(dt) {
    const c = this.cfd;
    if (!c.on || !this.scene) return;
    const core = this.core;
    const n = core.count;
    const pos = core.position;
    const Prad = 0.3 * c.hrr;
    const H = c.reach;
    const gN = this.gNorm;
    const comp = this.cabin;
    const pAtm = Math.min(1, comp.pressure / P_ATM);
    // Etki yarıçapı: ışınım akısının ~1 kW/m²'ye düştüğü uzaklık
    const rMax = Math.max(0.03, Math.sqrt(Prad / (4 * Math.PI * 1000)), 2.5 * H);
    const r2Max = rMax * rMax;
    const cx = c.pos[0], cy = c.pos[1], cz = c.pos[2];
    const ACCEL = 4;
    const RHO_C_DELTA = 1800;
    for (let i = 0; i < n; i++) {
      const o = i * 3;
      const dx = pos[o] - cx, dy = pos[o + 1] - cy, dz = pos[o + 2] - cz;
      const r2 = dx * dx + dy * dy + dz * dz;
      if (r2 > r2Max || core.state[i] === CELL_DEAD || core.state[i] === CELL_BURNING) continue;
      const r = Math.sqrt(r2);
      let q = Prad / (4 * Math.PI * Math.max(r2, 1e-4));
      // Alev teması: alev gövdesinin içi; tüy: 1 g'de alevin üstündeki dar koni
      let contact = r < 1.1 * H + 0.004 ? 1 : 0;
      if (!contact && gN > 0.05 && dy > 0) {
        const lateral = Math.hypot(dx, dz);
        if (lateral < 0.25 * dy + 0.6 * H && dy < 6 * H) contact = Math.min(1, (H / dy) * 1.5) * gN * pAtm;
      }
      q += contact * 60000;
      if (q < 600) continue;
      const mat = this.materialList[core.material[i]];
      const dT = (dt * ACCEL * q) / (RHO_C_DELTA * mat.thermalInertia);
      core.temperature[i] = Math.min(1500, core.temperature[i] + dT);
      // Alev değiyorsa pilot kaynak vardır (pilotlu tutuşma sıcaklığı geçerli)
      if (contact > 0.3) core.pilot[i] = Math.max(core.pilot[i], 0.6);
    }
  }

  _emitFire(dt) {
    const core = this.core;
    const n = core.burningCount;
    const t = this.time;
    const density = this.density;
    const gN = this.gNorm;
    const up = this.up;
    const g = this.gravity;
    const s = this.scale;
    const ss = Math.sqrt(s);
    const fire = this.fire, smoke = this.smoke, sparks = this.sparks;

    if (n > 0) {
      // Doğum hızları geçen karenin talebine göre bütçeye ölçeklenir: daha az, daha büyük
      // parçacık aynı görsel hacmi korur.
      const flameScale = Math.min(1, (FLAME_BUDGET * density) / Math.max(1, this._flameDemand));
      const smokeScale = Math.min(1, (SMOKE_BUDGET * density) / Math.max(1, this._smokeDemand));
      const emberScale = Math.min(1, (EMBER_BUDGET * density) / Math.max(1, this._emberDemand));
      const flameGrow = Math.min(2.2, 1 / Math.sqrt(Math.max(flameScale, 0.05)));
      const smokeGrow = Math.min(1.8, 1 / Math.cbrt(Math.max(smokeScale, 0.05)));
      let flameDemand = 0, smokeDemand = 0, emberDemand = 0;
      const box = this.box && this.box.closed ? this.box : null;

      for (let b = 0; b < n; b++) {
        const i = core.burningList[b];
        const power = core.intensity[i];
        if (power < 0.02) continue;
        const material = this.materialList[core.material[i]];
        const comp = this.compartments[core.compartment[i]];
        const calm = 1 - gN * Math.min(1, comp.pressure / P_ATM);
        const area = core.area[i];
        // Mikrogravite alevleri daha büyük ve uzun ömürlüdür: daha azı yeter
        const flameRadius = FLAME_RADIUS * s * (1 + 0.25 * calm);
        const flameLife = 0.59 * ss * (1 + 0.9 * calm);
        const flameRate = ((FLAME_COVERAGE * area) / (Math.PI * flameRadius * flameRadius * flameLife)) * Math.min(1.5, 0.4 + 0.6 * power);
        const smokeRate = (SMOKE_PER_M2 * area * material.soot * Math.min(1.5, power)) / (s * s);
        const emberRate = (EMBER_PER_M2 * area * Math.min(1.5, power)) / (s * s);
        flameDemand += flameRate;
        smokeDemand += smokeRate;
        emberDemand += emberRate;

        let flames = Math.floor(flameRate * flameScale * dt + Math.random());
        let smokes = Math.floor(smokeRate * smokeScale * dt + Math.random());
        let embers = Math.floor(emberRate * emberScale * dt + Math.random());
        if (flames + smokes + embers === 0) continue;

        const i3 = i * 3;
        const px = core.position[i3], py = core.position[i3 + 1], pz = core.position[i3 + 2];
        const nx = core.normal[i3], ny = core.normal[i3 + 1], nz = core.normal[i3 + 2];
        comp.flowAt(px, py, pz, _flow);
        const pAtm = Math.min(1, comp.pressure / P_ATM);
        const buoy = gN * pAtm;
        const spacing = Math.min(0.14, Math.max(0.03, 0.08 / core.rateScale[i])) * s;
        const strength = Math.min(1.6, power);
        const root = Math.sqrt(strength);

        for (let k = 0; k < flames; k++) {
          const jitter = spacing * 0.9;
          const jx = (Math.random() - 0.5) * jitter, jy = (Math.random() - 0.5) * jitter, jz = (Math.random() - 0.5) * jitter;
          const out = (0.1 + 0.25 * Math.random()) * ss;
          // 1 g'de yüzdürmeli tüy; yüzdürme yoksa alev yalnız gaz akışıyla sürüklenir
          const rise = (0.75 + 0.95 * Math.random()) * buoy * root * ss;
          const size = flameRadius * (0.7 + 0.45 * root) * (0.8 + 0.4 * Math.random()) * flameGrow;
          const life = flameLife * (0.72 + 0.56 * Math.random());
          fire.spawn(
            t + Math.random() * dt, KIND_FLAME,
            px + nx * 0.02 * s + jx, py + ny * 0.02 * s + jy, pz + nz * 0.02 * s + jz,
            nx * out + (Math.random() - 0.5) * 0.12 * ss, ny * out + (Math.random() - 0.5) * 0.12 * ss, nz * out + (Math.random() - 0.5) * 0.12 * ss,
            _flow[0] + up[0] * rise, _flow[1] + up[1] * rise, _flow[2] + up[2] * rise,
            3.2 / ss, life,
            size, size * (0.45 + 0.95 * (1 - buoy)),
            1750 + 320 * buoy + 220 * Math.max(0, power - 1) + 120 * Math.random(),
            (0.7 + 0.3 * buoy) * (0.75 + 0.25 * strength),
            Math.min(0.85, 0.1 + 0.62 * (1 - buoy)),
            (Math.random() - 0.5) * 1.5,
          );
        }

        for (let k = 0; k < smokes; k++) {
          const lift = (0.12 + 0.3 * buoy) * s;
          const rise = (0.55 + 0.6 * Math.random()) * buoy * root * ss;
          const out = (0.1 + 0.15 * Math.random()) * ss;
          let sx = px + nx * 0.1 * s + up[0] * lift;
          let sy = py + ny * 0.1 * s + up[1] * lift;
          let sz = pz + nz * 0.1 * s + up[2] * lift;
          if (box) {
            // Tavana dayalı salınan duman tavanın altında başlar, ötesinde değil
            const m = 0.08;
            sx = Math.min(Math.max(sx, box.lo[0] + m), box.hi[0] - m);
            sy = Math.min(Math.max(sy, box.lo[1] + m), box.hi[1] - m);
            sz = Math.min(Math.max(sz, box.lo[2] + m), box.hi[2] - m);
          }
          smoke.spawn(
            t + Math.random() * dt, KIND_SMOKE,
            sx, sy, sz,
            nx * out + up[0] * 0.4 * buoy * ss, ny * out + up[1] * 0.4 * buoy * ss, nz * out + up[2] * 0.4 * buoy * ss,
            _flow[0] + up[0] * rise, _flow[1] + up[1] * rise, _flow[2] + up[2] * rise,
            1.1 / ss, (2.6 + 2.4 * Math.random()) * (1 + 0.6 * (1 - buoy)) * Math.max(ss, 0.6),
            0.09 * smokeGrow * s, (0.42 + 0.4 * Math.random()) * smokeGrow * s,
            0.13 - 0.09 * material.soot + 0.03 * Math.random(),
            (0.16 + 0.3 * material.soot) * (0.7 + 0.3 * buoy),
            0.06 + 0.14 * buoy, (Math.random() - 0.5) * 0.7,
          );
        }

        for (let k = 0; k < embers; k++) {
          randomDir(_d, nx, ny, nz);
          const speed = (0.3 + 1.4 * Math.random()) * ss;
          const drag = 1.4 * pAtm + 0.05;
          const rise = 0.8 * buoy * ss;
          sparks.spawn(
            t, 0, px, py, pz, _d[0] * speed, _d[1] * speed, _d[2] * speed,
            _flow[0] + up[0] * rise + (g[0] * 0.25) / drag, _flow[1] + up[1] * rise + (g[1] * 0.25) / drag, _flow[2] + up[2] * rise + (g[2] * 0.25) / drag,
            drag, 0.5 + 1.1 * Math.random(), 0.009 * ss, 0.004 * ss, 1900 + 400 * Math.random(), 2.2, 0, 0,
          );
        }
      }
      this._flameDemand = flameDemand;
      this._smokeDemand = smokeDemand;
      this._emberDemand = emberDemand;
    } else {
      this._flameDemand = 0;
      this._smokeDemand = 0;
      this._emberDemand = 0;
    }

    // Piroliz: sıcak ama henüz yanmayan yakıt önce soluk duman verir
    const hot = core.hotCount;
    if (hot > 0) {
      const rate = Math.min(18 * density, hot * 0.8);
      let count = Math.floor(rate * dt + Math.random());
      while (count-- > 0) {
        const i = core.hotList[Math.floor(Math.random() * hot)];
        const comp = this.compartments[core.compartment[i]];
        if (comp.pressure < 5) continue;
        const i3 = i * 3;
        const pAtm = Math.min(1, comp.pressure / P_ATM);
        const rise = (0.3 + 0.3 * Math.random()) * gN * pAtm * ss;
        comp.flowAt(core.position[i3], core.position[i3 + 1], core.position[i3 + 2], _flow);
        smoke.spawn(
          t, KIND_SMOKE,
          core.position[i3] + core.normal[i3] * 0.03 * s, core.position[i3 + 1] + core.normal[i3 + 1] * 0.03 * s, core.position[i3 + 2] + core.normal[i3 + 2] * 0.03 * s,
          core.normal[i3] * 0.12 * ss, core.normal[i3 + 1] * 0.12 * ss, core.normal[i3 + 2] * 0.12 * ss,
          _flow[0] + up[0] * rise, _flow[1] + up[1] * rise, _flow[2] + up[2] * rise,
          1.5 / ss, (1.6 + 1.4 * Math.random()) * Math.max(ss, 0.6), 0.035 * s, (0.16 + 0.12 * Math.random()) * s, 0.55, 0.13, 0, (Math.random() - 0.5) * 0.8,
        );
      }
    }
  }

  /** Delikten kaçan gaz: dışarıda donan buhar jeti, içeride deliğe akan sis */
  _emitVenting(dt) {
    const t = this.time;
    for (const comp of this.compartments) {
      if (!(comp.ventMassRate > 0.02)) continue;
      const strength = Math.min(1, comp.ventMassRate / 4);
      for (const hole of comp.breaches) {
        const scale = Math.sqrt(hole.area / 0.05);
        let jets = Math.floor(70 * strength * this.density * dt + Math.random());
        while (jets-- > 0) {
          const speed = 22 + 30 * Math.random();
          const spread = 0.42;
          const vx = (hole.nx + (Math.random() - 0.5) * spread) * speed, vy = (hole.ny + (Math.random() - 0.5) * spread) * speed, vz = (hole.nz + (Math.random() - 0.5) * spread) * speed;
          this.smoke.spawn(
            t + Math.random() * dt, KIND_SMOKE,
            hole.x + hole.nx * 0.45, hole.y + hole.ny * 0.45, hole.z + hole.nz * 0.45,
            vx, vy, vz, 0, 0, 0,
            0, 0.35 + 0.4 * Math.random(), 0.08 * scale, (1.1 + 0.9 * Math.random()) * scale, 0.95, 0.2 * strength, 0, (Math.random() - 0.5) * 2,
          );
        }
        let fog = Math.floor(26 * strength * this.density * dt + Math.random());
        while (fog-- > 0) {
          randomUnit(_d);
          const distance = 0.35 + 1.5 * Math.random();
          const px = hole.x - hole.nx * 0.2 + _d[0] * distance, py = hole.y - hole.ny * 0.2 + _d[1] * distance, pz = hole.z - hole.nz * 0.2 + _d[2] * distance;
          if (this.compartmentAt([px, py, pz]) !== comp) continue;
          comp.flowAt(px, py, pz, _flow);
          this.smoke.spawn(
            t, KIND_SMOKE, px, py, pz,
            _flow[0] * 0.4, _flow[1] * 0.4, _flow[2] * 0.4, _flow[0], _flow[1], _flow[2],
            3, 0.45 + 0.35 * Math.random(), 0.12, 0.3, 0.9, 0.07 * strength, 0, (Math.random() - 0.5) * 1.5,
          );
        }
      }
    }
  }

  /**
   * Sahneyi aydınlatan yangın ışığı: en büyük yangın kümesinin konumu ve yanan alanla
   * orantılı ışık şiddeti (alev ışıklılığı ~5×10³ cd/m² × görünen alan) + patlama parlaması.
   */
  _updateLight(dt) {
    this._lightTimer -= dt;
    const core = this.core;
    if (this._lightTimer <= 0) {
      this._lightTimer = 0.1;
      const n = core.burningCount;
      const tgt = this._lightTarget;
      if (n === 0) { tgt.valid = false; tgt.cd = 0; }
      else {
        const CL = Math.max(1.6 * this.scale, 0.2);
        const clusters = new Map();
        const step = Math.max(1, Math.floor(n / 400));
        let power = 0;
        for (let b = 0; b < n; b += step) {
          const i = core.burningList[b];
          const x = core.position[i * 3], y = core.position[i * 3 + 1], z = core.position[i * 3 + 2];
          const key = Math.floor(x / CL) + ',' + Math.floor(y / CL) + ',' + Math.floor(z / CL);
          let c = clusters.get(key);
          if (!c) clusters.set(key, (c = { x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0, w: 0, p: 0 }));
          const w = core.intensity[i] * step;
          c.x += x * w; c.y += y * w; c.z += z * w;
          c.nx += core.normal[i * 3] * w; c.ny += core.normal[i * 3 + 1] * w; c.nz += core.normal[i * 3 + 2] * w;
          c.w += w;
          c.p += w * core.area[i];
          power += w * core.area[i];
        }
        let best = null;
        for (const c of clusters.values()) if (c.w > 1e-4 && (!best || c.p > best.p)) best = c;
        if (best) {
          const lift = 0.55 * this.scale;
          tgt.pos = [best.x / best.w + (best.nx / best.w) * lift, best.y / best.w + (best.ny / best.w) * lift, best.z / best.w + (best.nz / best.w) * lift];
          tgt.cd = 2500 * power * (1 - 0.55 * (1 - this.gNorm));
          tgt.valid = true;
        } else { tgt.valid = false; tgt.cd = 0; }
      }
    }
    const L = this.light;
    const tgt = this._lightTarget;
    const k = Math.min(1, dt * 6);
    const tt = this.time;
    const flicker = 0.82 + 0.18 * Math.sin(tt * 23.1) * Math.sin(tt * 14.7) + 0.08 * Math.sin(tt * 41);
    let cd = L.fireCd || 0;
    cd += ((tgt.valid ? tgt.cd * flicker : 0) - cd) * k;
    if (cd < 1e-3) cd = 0;
    L.fireCd = cd;
    if (tgt.valid) {
      if (!L.valid) L.pos = tgt.pos.slice();
      else for (let a = 0; a < 3; a++) L.pos[a] += (tgt.pos[a] - L.pos[a]) * k;
    }
    // Patlama parlaması yangın ışığından baskınsa ışık oraya atlar
    if (this.flash > cd) { L.pos = this.flashPos.slice(); L.col = [1, 0.84, 0.63]; }
    else {
      const blue = 0.55 * (1 - this.gNorm);
      L.col = [1 + (0.42 - 1) * blue, 0.5 + (0.55 - 0.5) * blue, 0.16 + (1 - 0.16) * blue];
    }
    L.cd = cd + this.flash;
    L.valid = L.cd > 0;
    L.R = Math.max(0.02, 0.25 * this.scale + (this.flash > cd && this.lastExplosion ? this.lastExplosion.radius * 0.5 : 0));
  }

  /* -------------------------------------------------------------- */
  /* Yanık izi: model uzayında hacim dokusu (ısı, kömürleşme)         */
  /* -------------------------------------------------------------- */
  /** grid: { o, d, n } model uzayı; döner: Uint8Array(n³ × 2) (R: ısı, G: kömürleşme) */
  burnVolume(grid) {
    const n = grid.n, d = grid.d, o = grid.o;
    const size = n[0] * n[1] * n[2];
    if (!this._burnBytes || this._burnBytes.length !== size * 2) this._burnBytes = new Uint8Array(size * 2);
    const out = this._burnBytes;
    out.fill(0);
    const core = this.core;
    if (!this.cellLocal) return out;
    const L = this.cellLocal;
    const rad = Math.max(this.spacing * 1.35, d * 1.2);
    const rv = Math.min(3, Math.ceil(rad / d));
    const inv = 1 / d;
    const r2 = rad * rad;
    for (let i = 0, m = core.count; i < m; i++) {
      const st = core.state[i];
      if (st === CELL_DEAD) continue;
      const heat = Math.max(0, Math.min(1, (core.temperature[i] - 480) / 1250));
      const ch = Math.min(1, core.char[i]);
      if (heat < 0.01 && ch < 0.01) continue;
      const h8 = heat * 255, c8 = ch * 255;
      const x = (L[i * 3] - o[0]) * inv, y = (L[i * 3 + 1] - o[1]) * inv, z = (L[i * 3 + 2] - o[2]) * inv;
      const ix = Math.round(x), iy = Math.round(y), iz = Math.round(z);
      for (let dz = -rv; dz <= rv; dz++) {
        const kz = iz + dz;
        if (kz < 0 || kz >= n[2]) continue;
        for (let dy = -rv; dy <= rv; dy++) {
          const ky = iy + dy;
          if (ky < 0 || ky >= n[1]) continue;
          for (let dx = -rv; dx <= rv; dx++) {
            const kx = ix + dx;
            if (kx < 0 || kx >= n[0]) continue;
            const ex = (kx - x) * d, ey = (ky - y) * d, ez = (kz - z) * d;
            const q = (ex * ex + ey * ey + ez * ez) / r2;
            if (q >= 1) continue;
            const w = 1 - q;
            const p = ((kz * n[1] + ky) * n[0] + kx) * 2;
            const hv = h8 * w;
            if (hv > out[p]) out[p] = hv;
            const cv = c8 * Math.min(1, w * 1.7);
            if (cv > out[p + 1]) out[p + 1] = cv;
          }
        }
      }
    }
    return out;
  }

  /* -------------------------------------------------------------- */
  /* Yer gerçeği (veri kümesi etiketleri)                             */
  /* -------------------------------------------------------------- */
  /** Yanan bölgeler: nesne/parça başına merkez, dünya sınır kutusu, alan, şiddet */
  regions(max = 12) {
    const core = this.core;
    const map = new Map();
    for (let b = 0; b < core.burningCount; b++) {
      const i = core.burningList[b];
      const bi = core.body[i];
      let r = map.get(bi);
      if (!r) map.set(bi, (r = { body: bi, n: 0, area: 0, power: 0, c: [0, 0, 0], lo: [Infinity, Infinity, Infinity], hi: [-Infinity, -Infinity, -Infinity], T: 0 }));
      const w = core.intensity[i] * core.area[i];
      r.n++;
      r.area += core.area[i];
      r.power += w;
      r.T = Math.max(r.T, core.temperature[i]);
      for (let a = 0; a < 3; a++) {
        const v = core.position[i * 3 + a];
        r.c[a] += v;
        if (v < r.lo[a]) r.lo[a] = v;
        if (v > r.hi[a]) r.hi[a] = v;
      }
    }
    const pad = FLAME_RADIUS * this.scale * 1.5;
    const list = [...map.values()].sort((a, b) => b.power - a.power).slice(0, max);
    return list.map((r) => {
      const body = this.bodies[r.body];
      const comp = body.compartment;
      const buoy = this.gNorm * Math.min(1, comp.pressure / P_ATM);
      const lo = r.lo.map((v) => v - pad), hi = r.hi.map((v) => v + pad);
      // 1 g'de alev tüyü yukarı uzanır
      hi[1] += 0.45 * buoy * Math.sqrt(this.scale);
      return {
        part: body.label, object: body.part.obj || null, material: body.material.label,
        cells: r.n, area_m2: r.area, intensity: r.power / Math.max(r.area, 1e-9), Tmax_K: r.T,
        centroid_m: r.c.map((v) => v / r.n), bbox_lo_m: lo, bbox_hi_m: hi,
        color: buoy < 0.3 ? 'blue' : 'yellow',
      };
    });
  }

  /** Efektlerde çizilecek bir şey var mı */
  visible() {
    return this.fire.live > 0 || this.smoke.live > 0 || this.sparks.live > 0 || this.debris.active > 0 || this.shockwaves.length > 0;
  }

  /** Efektler hâlâ evrimleşiyor mu (duraklatma dışındaki sürekli çizim için) */
  busy() {
    return this.visible() || this.core.burningCount > 0 || this.core.hotCount > 0 || this.flash > 0 || this._scheduled.length > 0
      || !!(this.cabin && this.cabin.ventMassRate > 0.02);
  }

  clearAll() {
    this.fire.clear();
    this.smoke.clear();
    this.sparks.clear();
    const d = this.debris;
    d.alive.fill(0); d.heat.fill(0); d.inst.fill(0);
    d.count = 0; d.next = 0; d.active = 0; d.dirty = true;
    this.shockwaves.length = 0;
    this.flash = 0;
    this.shake = 0;
    this.light.cd = 0; this.light.fireCd = 0; this.light.valid = false;
    this._lightTarget.valid = false;
    this._scheduled.length = 0;
    this._acc = 0;
    this.cfdBlow = 0;
    this.cfdSmother = 0;
  }

  /** bindScene sonrasındaki duruma dön */
  reset() {
    this.clearAll();
    const core = this.core;
    for (const comp of this.compartments) comp.reset();
    for (const body of this.bodies) {
      body.destroyed = false;
      body.triggered = false;
      body.cookTime = 0;
      body.everBurned = false;
      if (body.part.destroyed) { body.part.destroyed = false; this.partsDirty = true; }
      const combustible = isCombustible(body.material);
      for (let i = body.cellStart, end = body.cellStart + body.cellCount; i < end; i++) {
        core.temperature[i] = body.compartment.temperature;
        core.fuel[i] = combustible ? 1 : 0;
        core.char[i] = 0;
        core.intensity[i] = 0;
        core.suppress[i] = 0;
        core.pilot[i] = 0;
        core.localOxygen[i] = 0;
        core.state[i] = CELL_VIRGIN;
      }
    }
    core.burningCount = 0;
    core.hotCount = 0;
    core.heatReleaseKW = 0;
    this.explosionCount = 0;
    this.lastExplosion = null;
    this.events.length = 0;
    this._pTouched = false;
    if (this.cabin) this._o2Applied = +(this.cabin.o2Fraction * 100).toFixed(2);
    this.burnVersion++;
  }

  /** Yakıtın ne kadarı tükendi (0..1) */
  burnedFraction() {
    const core = this.core;
    if (!this._fuelCells) return 0;
    let burnt = 0;
    for (let i = 0; i < core.count; i++) if (core.state[i] === CELL_BURNT) burnt++;
    return burnt / this._fuelCells;
  }
}

function triArea(P, a, b, c) {
  const e1x = P[b] - P[a], e1y = P[b + 1] - P[a + 1], e1z = P[b + 2] - P[a + 2];
  const e2x = P[c] - P[a], e2y = P[c + 1] - P[a + 1], e2z = P[c + 2] - P[a + 2];
  const x = e1y * e2z - e1z * e2y, y = e1z * e2x - e1x * e2z, z = e1x * e2y - e1y * e2x;
  return 0.5 * Math.hypot(x, y, z);
}

FL.FxSystem = FxSystem;
FL.FX_MATERIALS = MATERIALS;
FL.fxIsCombustible = isCombustible;
FL.fxPartMaterial = partMaterial;
FL.fxPartExplosive = partExplosive;
void CELL_BURNT;
