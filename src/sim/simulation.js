/* =====================================================================
 * Alev Laboratuvarı — Çözücü orkestrasyonu
 * ---------------------------------------------------------------------
 * GPU alanlarını ayırır, her alt adımda pass sırasını yürütür, zaman
 * adımını (CFL + difüzyon kararlılığı) uyarlar, istatistikleri okur ve
 * CPU tarafındaki damla (d²-yasası) modelini ilerletir.
 * ===================================================================== */
import { FL } from '../core/fl.js';

class Simulation {
  constructor(glc) {
    this.glc = glc;
    this.gl = glc.gl;
    this.simTime = 0;
    this.frame = 0;
    this.stats = {
      hrr: 0, qrad: 0, soot: 0, cool: 0, Tmax: 300, umax: 0, yTip: 0, rMax: 0,
      cx: 0, cy: 0, cz: 0, lumR: 0, lumG: 0, lumB: 0, lumY: 0, lx: 0, ly: 0, lz: 0, valid: false,
    };
    this.history = [];
    this.maxHistory = 900;
    this.ignTimer = 0;
    this.supActive = false;
    this.supHold = -1;
    this.smoActive = false;
    this.smoHold = -1;
    this.droplet = null;
    this.extinctTimer = 0;
    this.flameOn = false;
    this.events = [];
    this._evSeq = 0;
    this._gen = 0;
    this.sheetFront = [];
    this.spread = NaN;
    // Engellemeyen PBO okuması; testlerde eşzamanlı okuma için false yapılabilir
    this.asyncReads = true;
    this._compile();
  }

  _event(label, kind, t) {
    this.events.push({ id: ++this._evSeq, t: t === undefined ? this.simTime : t, label, kind: kind || label });
  }

  /* -------------------------------------------------------------- */
  /* Programlar                                                     */
  /* -------------------------------------------------------------- */
  _compile() {
    const g = this.glc;
    const S = FL.SHADERS;
    this.P = {
      advect: g.program('advect', S.advect()),
      advectU: g.program('advectU', S.advectU()),
      correctU: g.program('correctU', S.correctU()),
      maccormack: g.program('maccormack', S.maccormack()),
      combust: g.program('combust', S.combust()),
      diffuse: g.program('diffuse', S.diffuse()),
      curl: g.program('curl', S.curl()),
      forces: g.program('forces', S.forces()),
      viscosity: g.program('viscosity', S.viscosity()),
      divergence: g.program('divergence', S.divergence()),
      pressure: g.program('pressure', S.pressure()),
      subtract: g.program('subtract', S.subtract()),
      sheet: g.program('sheet', S.sheet()),
      sheetInit: g.program('sheetInit', S.sheetInit()),
      stats: g.program('stats', S.stats()),
      radSource: g.program('radSource', S.radSource()),
      radField: g.program('radField', S.radField()),
      reduce: g.program('reduce', S.reduce()),
      init: g.program('init', S.init()),
      celltype: g.program('celltype', S.celltype()),
    };
  }

  /* -------------------------------------------------------------- */
  /* Izgara ve alanlar                                              */
  /* -------------------------------------------------------------- */
  configure(state) {
    this.state = state;
    const N = Math.round(state.resolution);
    const aspect = state.aspect;
    const Lx = state.domain / 100; // cm → m (genişlik)
    const dx = Lx / N;
    // Derinlik (Z) ayrı verilebilir; verilmezse genişliğe eşit
    const depth = state.depth > 0 ? state.depth / 100 : Lx;
    const NX = N, NZ = Math.max(8, Math.round(depth / dx)), NY = Math.max(8, Math.round(N * aspect));
    const tilesX = Math.ceil(Math.sqrt(NZ));
    const tilesY = Math.ceil(NZ / tilesX);
    const W = NX * tilesX, H = NY * tilesY;
    if (W > this.glc.maxTex || H > this.glc.maxTex) throw new Error('Izgara dokusu GPU sınırını aşıyor.');
    // Işınım kaynak toplamı için kaba bloklar (4×4×4 hücre)
    const BS = 4;
    const NB = [Math.ceil(NX / BS), Math.ceil(NY / BS), Math.ceil(NZ / BS)];
    const BT = Math.ceil(Math.sqrt(NB[2]));
    const rad = { BS, NB, BT, W: NB[0] * BT, H: NB[1] * Math.ceil(NB[2] / BT) };
    this.grid = { NX, NY, NZ, dx, tilesX, tilesY, W, H, Lx, Ly: NY * dx, Lz: NZ * dx, cells: NX * NY * NZ, rad };
    this._allocate();
    this.reset();
  }

  _allocate() {
    const g = this.glc;
    const gl = this.gl;
    const { W, H, NX, NY } = this.grid;
    this._free();
    const f = {};
    f.vel = g.pingPong(W, H);
    f.sca = g.pingPong(W, H);
    f.aux = g.pingPong(W, H);
    f.tmp1 = g.target(W, H);
    f.tmp2 = g.target(W, H);
    f.scaT = g.pingPong(W, H);
    f.auxT = g.pingPong(W, H);
    f.velT = g.pingPong(W, H);
    f.curl = g.target(W, H);
    f.type = g.target(W, H, { internal: gl.R8, format: gl.RED, type: gl.UNSIGNED_BYTE, filter: gl.NEAREST });
    f.mocc = g.target(W, H, { internal: gl.R8, format: gl.RED, type: gl.UNSIGNED_BYTE, filter: gl.NEAREST });
    this._moccOn = false;
    const rOpts = { internal: g.fmtR, format: gl.RED, type: g.typeR, filter: gl.NEAREST };
    f.div = g.target(W, H, rOpts);
    // Kütle ağırlıklı adveksiyonun yan çıktıları: (S_adv, Y_P); geri adım için ikinci tampon
    f.sadv = g.target(W, H);
    f.u2a = g.target(W, H);
    f.u2b = g.target(W, H);
    f.p = g.pingPong(W, H, rOpts);
    // Işınım: blok kaynakları ve blok ışınım alanı
    const R = this.grid.rad;
    const cOpts = { internal: g.fmtField, format: gl.RGBA, type: g.typeField, filter: gl.NEAREST };
    f.radS = g.target(R.W, R.H, cOpts);
    f.radF = g.target(R.W, R.H, cOpts);
    f.radChains = [[], []];
    {
      let w = R.W, h = R.H;
      while (w > 1 || h > 1) {
        w = Math.max(1, Math.ceil(w / 4));
        h = Math.max(1, Math.ceil(h / 4));
        f.radChains[0].push(g.target(w, h, cOpts));
        f.radChains[1].push(g.target(w, h, cOpts));
      }
    }
    const sOpts = { internal: g.fmtField, format: gl.RGBA, type: g.typeField, filter: gl.NEAREST };
    f.solid = g.pingPong(NX, NY, sOpts);
    // İstatistik indirgeme zincirleri
    f.statSum = g.target(W, H, sOpts);
    f.statMax = g.target(W, H, sOpts);
    f.statSum2 = g.target(W, H, sOpts);
    f.statLum = g.target(W, H, sOpts);
    f.chains = [[], [], [], []];
    let w = W, h = H;
    while (w > 1 || h > 1) {
      w = Math.max(1, Math.ceil(w / 4));
      h = Math.max(1, Math.ceil(h / 4));
      for (let k = 0; k < 4; k++) f.chains[k].push(g.target(w, h, sOpts));
    }
    this.F = f;
    this._readBuf = new Float32Array(4);
  }

  _free() {
    if (!this.F) return;
    const g = this.glc;
    const f = this.F;
    ['vel', 'sca', 'aux', 'scaT', 'auxT', 'velT', 'p', 'solid'].forEach((k) => g.destroyPingPong(f[k]));
    ['tmp1', 'tmp2', 'curl', 'type', 'mocc', 'div', 'sadv', 'u2a', 'u2b', 'statSum', 'statMax', 'statSum2', 'statLum', 'radS', 'radF'].forEach((k) => g.destroyTarget(f[k]));
    f.chains.forEach((ch) => ch.forEach((t) => g.destroyTarget(t)));
    f.radChains.forEach((ch) => ch.forEach((t) => g.destroyTarget(t)));
    g.clearMRTCache();
    this.F = null;
    this._typeKey = null;
  }

  /**
   * Hücre türü dokusunu analitik geometriden yeniden üretir. Fizik
   * geçişleri komşu türlerini tek bir doku okumasıyla alır; geometri
   * değişmedikçe (mum, jet) bu geçiş atlanır.
   */
  _updateTypes(force) {
    const geo = this.geo;
    const key = geo.mode + '|' + geo.src0.join(',') + '|' + geo.src1.join(',') + '|' + geo.src2.join(',') + '|m' + (this._moccKey || 0);
    if (!force && key === this._typeKey) return;
    this._typeKey = key;
    const u = this.commonU();
    delete u.uType;
    u.uMOcc = this.F.mocc;
    u.uMOccOn = this._moccOn ? 1 : 0;
    this.glc.pass(this.P.celltype, this.F.type, u);
  }

  /**
   * Model hücreleri: Uint8Array(NX·NY·NZ), x en hızlı; null = model alanda değil.
   * Atlas düzenine (z dilimi → karo) yerleştirilip R8 dokuya yazılır.
   */
  setModelOccupancy(occ) {
    const gl = this.gl;
    const { NX, NY, NZ, W, H, tilesX } = this.grid;
    const on = !!occ && occ.length === NX * NY * NZ;
    if (on) {
      const data = new Uint8Array(W * H);
      for (let z = 0; z < NZ; z++) {
        const tx = z % tilesX, ty = Math.floor(z / tilesX);
        for (let y = 0; y < NY; y++) {
          const src = (z * NY + y) * NX, dst = (ty * NY + y) * W + tx * NX;
          for (let x = 0; x < NX; x++) data[dst + x] = occ[src + x] ? 255 : 0;
        }
      }
      gl.bindTexture(gl.TEXTURE_2D, this.F.mocc.tex.handle);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, W, H, gl.RED, gl.UNSIGNED_BYTE, data);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
      gl.bindTexture(gl.TEXTURE_2D, null);
    }
    if (!on && !this._moccOn) return false;
    this._moccOn = on;
    this._moccKey = (this._moccKey || 0) + 1;
    this._updateTypes(true);
    return true;
  }

  /* -------------------------------------------------------------- */
  /* Fizik paketini ve geometriyi güncelle                           */
  /* -------------------------------------------------------------- */
  updatePhysics() {
    const st = this.state;
    st.dxMeters = this.grid.dx;
    this.phys = FL.buildPhysicsPack(st);
    const fuel = this.phys.fuel;
    const { Lx, Ly, Lz, dx } = this.grid;
    // Kaynak ekseni bir hücre merkezine oturtulur (çift sayılı ızgarada simetri için)
    const cx = (Math.floor(this.grid.NX / 2) + 0.5) * dx;
    const cz = (Math.floor(this.grid.NZ / 2) + 0.5) * dx;
    const src = SOURCE_CODE[st.source];
    const geo = { mode: src, src0: [0, 0, 0, 0], src1: [0, 0, 0, 0], src2: [0, 0, 0, 0] };
    const mm = 1e-3;
    if (st.source === 'jet') {
      const Ri = Math.max((st.nozzleD * mm) / 2, 0.75 * dx);
      const Ro = Ri + Math.max(0.6 * mm, 1.2 * dx);
      const hT = 0.12 * Ly;
      const coflowOn = st.coflow > 0 ? 1 : 0;
      const Rco = coflowOn ? Math.max(Ro + 5 * dx, 0.36 * Lx) : 0;
      geo.src0 = [cx, cz, Ri, Ro];
      geo.src1 = [hT, Rco, st.jetU / 100, st.coflow / 100];
      geo.src2 = [this.phys.YF1, st.Tamb, coflowOn, 0];
      geo.anchor = [cx, hT, cz];
      geo.ign = [cx, hT + 3 * mm + 2 * dx, cz, Math.max(2.5 * mm, 2.5 * dx)];
      geo.charL = 2 * Ri;
      geo.charU = st.jetU / 100;
    } else if (st.source === 'candle') {
      const Rc = Math.min(0.15 * Lx, 10 * mm);
      // Mum gövdesi alan yüksekliğiyle büyümez: en çok 1,8 cm
      const hc = Math.min(0.25 * Ly, 0.018);
      const rw = 0.6 * mm;
      const lw = 6 * mm;
      geo.src0 = [cx, cz, Rc, hc];
      geo.src1 = [rw, lw, st.wickRate, 980];
      geo.src2 = [330, 0, 0, 0];
      geo.anchor = [cx, hc, cz];
      geo.ign = [cx, hc + lw + 1.5 * mm, cz, Math.max(2.5 * mm, 2 * dx)];
      geo.charL = 2 * rw + 4 * mm;
      geo.charU = 0;
    } else if (st.source === 'droplet') {
      if (!this.droplet) this._initDroplet();
      const d = this.droplet;
      // Damla konumu ve tutucu lif sıfırlamada sabitlenir; canlı g değişimi damlayı zıplatmaz
      const cy = d.layoutGround ? 0.38 * Ly : 0.5 * Ly;
      geo.src0 = [cx, cy, cz, d.alive ? d.d / 2 : 0];
      geo.src1 = [fuel.Tb, d.Yfs, d.mdot, d.rhoFilm || 0.3];
      geo.src2 = [0.00007, d.layoutGround ? 1 : 0, 0, 0];
      geo.anchor = [cx, cy, cz];
      geo.ign = [cx + d.d0 / 2 + 1.6 * mm, cy, cz, Math.max(1.8 * mm, 2 * dx)];
      geo.charL = d.d;
      geo.charU = st.flow / 100;
    } else if (st.source === 'sheet') {
      const kc = Math.floor(this.grid.NZ / 2);
      const zc = (kc + 0.5) * dx;
      const w = Math.min(st.sheetW / 100, 0.7 * Lx);
      const h = Math.min(st.sheetH / 100, 0.72 * Ly);
      const y0 = 0.12 * Ly;
      geo.src0 = [zc, cx - w / 2, cx + w / 2, y0];
      geo.src1 = [y0 + h, fuel.areal * (1 - fuel.inert), fuel.inert, Math.max(2 * dx, 1.5 * mm)];
      geo.src2 = [0, 0, 0, 0];
      geo.anchor = [cx, y0, zc];
      const igY = st.sheetIgnTop ? y0 + h - 2 * mm : y0 + 2 * mm;
      geo.ign = [cx, igY, zc, Math.max(3 * mm, 2.5 * dx)];
      geo.charL = h;
      geo.charU = st.flow / 100;
    } else {
      // Kaynak yok: alan boş; tutuşturucu yalnız havayı ısıtır
      geo.anchor = [cx, 0.3 * Ly, cz];
      geo.ign = [cx, 0.3 * Ly, cz, Math.max(2.5 * mm, 2 * dx)];
      geo.charL = 0.01;
      geo.charU = st.flow / 100;
    }
    this.geo = geo;
  }

  /**
   * Fitil (tür 4) veya damla (tür 5) yüzeyine komşu gaz hücresi yüzlerinin
   * toplam sayısı. GPU'daki cellType ile aynı geometri; toplam buhar
   * debisi bu yüzlere eşit paylaştırılır.
   */
  countSourceFaces() {
    const geo = this.geo;
    const { NX, NY, NZ, dx } = this.grid;
    const key = geo.mode + ':' + geo.src0.join(',') + ':' + geo.src1[0] + ':' + geo.src1[1];
    if (this._facesKey === key) return this._faces;
    const s0 = geo.src0, s1 = geo.src1;
    const sdCylY = (x, y, z, cx, cz, r, y0, y1) => {
      const dxr = Math.hypot(x - cx, z - cz) - r;
      const dyr = Math.max(y0 - y, y - y1);
      return Math.min(Math.max(dxr, dyr), 0) + Math.hypot(Math.max(dxr, 0), Math.max(dyr, 0));
    };
    const type = (i, j, k) => {
      if (i < 0 || j < 0 || k < 0 || i >= NX || j >= NY || k >= NZ) return -1;
      const x = (i + 0.5) * dx, y = (j + 0.5) * dx, z = (k + 0.5) * dx;
      if (geo.mode === 1) {
        if (sdCylY(x, y, z, s0[0], s0[1], s0[2], -1, s0[3]) < 0) return 1;
        const rw = Math.max(s1[0], 0.55 * dx);
        if (sdCylY(x, y, z, s0[0], s0[1], rw, s0[3] - dx, s0[3] + s1[1]) < 0) return 4;
        return 0;
      }
      if (geo.mode === 2) {
        if (s0[3] > 0 && Math.hypot(x - s0[0], y - s0[1], z - s0[2]) < Math.max(s0[3], 0.5 * dx)) return 5;
        return 0;
      }
      return 0;
    };
    const src = geo.mode === 1 ? 4 : 5;
    // Yalnız kaynak çevresindeki kutuyu tara
    const R = geo.mode === 1 ? Math.max(s1[0], dx) + 2 * dx : Math.max(s0[3], dx) + 2 * dx;
    const cy = geo.mode === 1 ? s0[3] + s1[1] / 2 : s0[1];
    const cxw = s0[0], czw = geo.mode === 1 ? s0[1] : s0[2];
    const hy = geo.mode === 1 ? s1[1] / 2 + 2 * dx : R;
    const i0 = Math.max(0, Math.floor((cxw - R) / dx)), i1 = Math.min(NX - 1, Math.ceil((cxw + R) / dx));
    const k0 = Math.max(0, Math.floor((czw - R) / dx)), k1 = Math.min(NZ - 1, Math.ceil((czw + R) / dx));
    const j0 = Math.max(0, Math.floor((cy - hy) / dx)), j1 = Math.min(NY - 1, Math.ceil((cy + hy) / dx));
    let faces = 0;
    for (let k = k0; k <= k1; k++)
      for (let j = j0; j <= j1; j++)
        for (let i = i0; i <= i1; i++) {
          if (type(i, j, k) !== 0) continue;
          if (type(i + 1, j, k) === src) faces++;
          if (type(i - 1, j, k) === src) faces++;
          if (type(i, j + 1, k) === src) faces++;
          if (type(i, j - 1, k) === src) faces++;
          if (type(i, j, k + 1) === src) faces++;
          if (type(i, j, k - 1) === src) faces++;
        }
    this._facesKey = key;
    this._faces = faces;
    return faces;
  }

  /** Buhar enjeksiyonu uniform'u: (yüz başına kg/s, buhar sıcaklığı, geri besleme, 0) */
  injectU() {
    const st = this.state;
    if (st.source === 'candle') {
      // wickRate: Dünya koşulunda (1 g, durgun hava) fitilin buhar debisi.
      // Diğer koşullarda alevden gelen ısı (Nusselt) oranında ölçeklenir.
      const faces = Math.max(1, this.countSourceFaces());
      const conv = FL.wickConvection(st, this.phys.amb, this.phys.Tad);
      this.wickConv = conv;
      return [(st.wickRate * 1e-6 * conv.ratio) / faces, 650, 1, 0];
    }
    if (st.source === 'droplet' && this.droplet && this.droplet.alive) {
      const faces = Math.max(1, this.countSourceFaces());
      return [this.droplet.mdot / faces, this.phys.fuel.Tb, 0, 0];
    }
    return [0, 0, 0, 0];
  }

  _initDroplet() {
    const st = this.state;
    const d0 = st.dropletD * 1e-3;
    this.droplet = {
      d0, d: d0, alive: true, K: 0, mdot: 0, Yfs: 0.18, rhoFilm: 0.3, B: 0,
      hot: false, cool: false, tBurn: 0, history: [],
      layoutGround: st.gravity > 0.05,
    };
  }

  commonU() {
    const gr = this.grid;
    const geo = this.geo;
    return {
      uN: [gr.NX, gr.NY, gr.NZ],
      uTilesX: gr.tilesX,
      uDx: gr.dx,
      uMode: geo.mode,
      uSrc0: geo.src0,
      uSrc1: geo.src1,
      uSrc2: geo.src2,
      uSolid: this.F.solid.read,
      uType: this.F.type,
      uNB: gr.rad.NB,
      uBT: gr.rad.BT,
      uBS: gr.rad.BS,
    };
  }

  thermoU() {
    const ph = this.phys;
    const st = this.state;
    return {
      uFuel: ph.fuelProps,
      uDil: ph.dilProps,
      uDilCond: ph.dilCond,
      uP: ph.P,
      uTamb: st.Tamb,
      uYoAmb: ph.amb.Yo,
      uRad: [st.radiation ? 1 : 0, st.gasRadMult, st.sootRadMult, this.radOn() ? 1 : 0],
      // Güvenlik sınırları: hiçbir hücre adyabatik alev sıcaklığını (ya da
      // tutuşturucu sıcaklığını) belirgin biçimde aşamaz; hız fiziksel ölçeğin
      // birkaç katıyla sınırlanır. Sayısal bir hata kendini besleyip alanı
      // doldurmasın diye.
      uTcap: Math.max(ph.Tad || 2400, st.ignT || 0) + 150,
      uVcap: this.velocityCap(),
    };
  }

  /** Işınım alanı (kaynak toplamı, yeniden soğurma) etkin mi */
  radOn() {
    return !!(this.state.radiation && this.state.radModel !== 'thin');
  }

  /**
   * Işınım alanını güncelle: önce 4×4×4 bloklarda net yayılan güç ve güç
   * ağırlıklı merkez, sonra her blokta G − 4σT∞⁴ = Σ P/(4πr²) ve alan
   * sınırlarındaki ışınım akısı. Işınım ışık hızında kurulur; her adımda
   * yarı-durağan kabul edilir.
   */
  solveRadiation(base) {
    const g = this.glc, f = this.F, P = this.P, gr = this.grid;
    g.pass(P.radSource, f.radS, Object.assign({}, base, { uSca: f.sca.read, uAux: f.aux.read }));
    g.pass(P.radField, f.radF, Object.assign({}, base, { uSrcR: f.radS, uBoxR: [gr.Lx, gr.Ly, gr.Lz] }));
  }

  velocityCap() {
    const st = this.state;
    const uB = Math.sqrt(Math.max(st.gravity, 0) * FL.C.G0 * 0.4 * (this.grid ? this.grid.Ly : 0.08) * Math.max((this.phys.Tad || 2000) / st.Tamb - 1, 0));
    return Math.max(3, 4 * uB, (4 * (st.jetU || 0)) / 100, (4 * (st.flow || 0)) / 100, (2.5 * (st.wind || 0)) / 100);
  }

  /** Basılı tutma ya da bir tıklamanın bıraktığı söndürme süresi */
  quenching() {
    return !!(this.supActive || (this.supHold != null && this.simTime < this.supHold));
  }

  /** CO₂ tüpü boşalıyor mu (basılı tutma ya da bir tıklamanın süresi) */
  smothering() {
    return !!(this.smoActive || (this.smoHold != null && this.simTime < this.smoHold));
  }

  /** CO₂ bulutunun yarıçapı: alevi ve kaynağı (fitil, nozul, damla) birlikte örter */
  smotherRadius(kU) {
    const a = this.geo && this.geo.anchor ? this.geo.anchor : [0, 0, 0];
    const c = kU.uSupC;
    const d = Math.hypot(c[0] - a[0], c[1] - a[1], c[2] - a[2]);
    return Math.min(0.06, Math.max(kU.uSup[2] * 1.15, (d + 0.008) / 0.55));
  }

  /** Jetin hedefi: alevin ağırlık merkezi, yoksa kaynağın biraz üstü */
  quenchAim() {
    const a = this.geo && this.geo.anchor ? this.geo.anchor : [0, 0, 0];
    const s = this.stats;
    if (s && s.valid && s.hrr > 0.05 && isFinite(s.cx) && isFinite(s.cy)) return [s.cx, s.cy, s.cz];
    return [a[0], a[1] + 0.012, a[2]];
  }

  /** Yatay rüzgâr vektörü [m/s]: yön 0° = +x, 90° = +z (yukarıdan bakışta saat yönü tersine) */
  windVec() {
    const st = this.state;
    const U = (st.wind || 0) / 100;
    const a = ((st.windDir || 0) * Math.PI) / 180;
    return [U * Math.cos(a), 0, U * Math.sin(a)];
  }

  constrainU() {
    const st = this.state;
    const on = this.quenching() ? 1 : 0;
    const aim = this.quenchAim();
    const h = this.stats && this.stats.valid && this.stats.flameH > 0 ? this.stats.flameH : 0.02;
    const radius = Math.min(0.04, Math.max(0.016, 0.5 * h + 0.012));
    return {
      uFlow: st.flow / 100,
      uDraft: st.draft / 100,
      uWind: this.windVec(),
      uTime: this.simTime,
      uSup: [on, aim[1], radius, 1.8],
      uSupC: [aim[0], aim[1], aim[2], 0],
    };
  }

  /* -------------------------------------------------------------- */
  /* Sıfırlama                                                      */
  /* -------------------------------------------------------------- */
  reset() {
    this.simTime = 0;
    this.history = [];
    this.droplet = null;
    this.extinctTimer = 0;
    this.flameOn = false;
    this.supHold = -1;
    this.smoActive = false;
    this.smoHold = -1;
    this.events = [];
    this.statsReady = false;
    this.ignTimer = 0;
    this.sheetFront = [];
    this.spread = NaN;
    this._gen++;
    this._statsInFlight = false;
    this._sheetInFlight = false;
    this.updatePhysics();
    const g = this.glc;
    const f = this.F;
    const st = this.state;
    const base = Object.assign({}, this.commonU(), this.thermoU(), this.constrainU());
    // Levha
    g.pass(this.P.sheetInit, f.solid.write, Object.assign({}, base, { uTamb: st.Tamb }));
    f.solid.swap();
    g.pass(this.P.sheetInit, f.solid.write, Object.assign({}, base, { uTamb: st.Tamb }));
    f.solid.swap();
    base.uSolid = f.solid.read;
    this._updateTypes(true);
    const amb = [st.Tamb, 0, this.phys.amb.Yo, 0];
    for (let k = 0; k < 2; k++) {
      g.pass(this.P.init, f.sca.write, Object.assign({}, base, { uValue: amb, uKind: 0, uWallT: this._wallT() }));
      f.sca.swap();
      g.pass(this.P.init, f.vel.write, Object.assign({}, base, { uValue: [0, st.flow / 100, 0, 0], uKind: 1 }));
      f.vel.swap();
      g.pass(this.P.init, f.aux.write, Object.assign({}, base, { uValue: [0, 0, 0, 0], uKind: 2 }));
      f.aux.swap();
    }
    g.clearTarget(f.p.read, [0, 0, 0, 0]);
    g.clearTarget(f.p.write, [0, 0, 0, 0]);
    g.clearTarget(f.curl, [0, 0, 0, 0]);
    g.clearTarget(f.radS, [0, 0, 0, 0]);
    g.clearTarget(f.radF, [0, 0, 0, 0]);
    this.stats.valid = false;
  }

  _wallT() {
    const st = this.state;
    if (st.source === 'candle') return 330;
    return st.Tamb;
  }

  ignite(seconds) {
    // Ateşle, süren söndürücü darbesini keser (yoksa kıvılcım hemen bastırılırdı)
    this.supHold = -1;
    this.supActive = false;
    this.smoHold = -1;
    this.smoActive = false;
    this.ignTimer = seconds || 0.35;
    this._event('Tutuşturma', 'ignite');
  }

  /* -------------------------------------------------------------- */
  /* Zaman adımı                                                    */
  /* -------------------------------------------------------------- */
  /**
   * En büyük yayınım katsayısı: sıcak gazda α(T), en küçük Lewis sayısıyla D = α/Le.
   * Açık şemanın kararlılığı: Δt_s · D_maks / Δx² ≤ 1/6 (güvenlik payıyla).
   */
  maxDiffusivity() {
    const st = this.state;
    const s = this.stats;
    const Tm = FL.clamp(Math.max(s.valid ? s.Tmax : 0, this.flameOn || this.ignTimer > 0 ? this.phys.Tad : 0, st.ignT || 0, 1200), 600, 3200);
    const alpha = FL.thermalDiffusivity(Tm, this.phys.P, this.phys.amb) * st.diffScale;
    const leMin = st.lewis ? Math.min(this.phys.fuel.Le, 1.0) : 1.0;
    return alpha / leMin;
  }

  diffusionSubsteps(dt) {
    const a = (dt * this.maxDiffusivity()) / (this.grid.dx * this.grid.dx);
    return FL.clamp(Math.ceil((6 * a) / 0.85), 1, 32);
  }

  computeDt(frameDt) {
    const st = this.state;
    const { dx, Ly } = this.grid;
    // GPU'dan gelen u_maks birkaç kare gecikmeli olabilir (ya da hiç gelmeyebilir);
    // sıcak alanda hız, yüzdürme ölçeği √(g·L·(T_ad/T∞−1)) ile de alttan sınırlanır.
    const s = this.stats;
    const hot = this.flameOn || this.ignTimer > 0 || (s.valid && s.Tmax > 600);
    const uBuoy = hot ? Math.sqrt(st.gravity * FL.C.G0 * 0.4 * Ly * Math.max(this.phys.Tad / st.Tamb - 1, 0)) : 0;
    const umax = Math.max(s.valid ? s.umax : 0.3, uBuoy, hot ? 0.3 : 0.05, st.flow / 100, st.source === 'jet' ? (2 * st.jetU) / 100 : 0);
    // Gaz jeti: hızlı, ince kesme katmanı büyük adımda sönüyor (CFL 3'te alev tutuşturucu kapanınca
    // üfleniyor); jet en çok 1,6 ile yürür. Mum, damla ve levha CFL 3'te kararlıdır.
    const cfl = st.source === 'jet' ? Math.min(st.cfl, 1.6) : st.cfl;
    const dtCfl = (cfl * dx) / umax;
    // Difüzyon sayısı a = Δt·D/Δx² ≤ diffA; açık alt adım sayısı en çok 32 kalır
    const dMax = this.maxDiffusivity();
    const dtDiff = (Math.min(st.diffA, (32 * 0.85) / 6) * dx * dx) / Math.max(dMax, 1e-9);
    let dt = Math.min(dtCfl, dtDiff, st.dtMax / 1000);
    let n = Math.ceil(frameDt / dt - 1e-6);
    // Kare hızı yöneticisi tavanı geçici olarak indirebilir (subCap): kare süresi korunur,
    // benzetim ağır çekime geçer, Δt ve sonuç değişmez.
    const cap = Math.max(1, Math.min(st.maxSub, this.subCap > 0 ? this.subCap : st.maxSub));
    if (n > cap) {
      n = cap;
    } else {
      dt = frameDt / n;
    }
    return { dt, n, dtCfl, dtDiff };
  }

  step(frameDt) {
    const plan = this.computeDt(frameDt);
    for (let i = 0; i < plan.n; i++) this.substep(plan.dt);
    this.lastPlan = plan;
    this.frame++;
    return plan;
  }

  substep(dt) {
    const g = this.glc;
    const P = this.P;
    const f = this.F;
    const st = this.state;
    this._updateCPUModels(dt);
    this.updatePhysics();
    const cU = this.commonU();
    const tU = this.thermoU();
    const kU = this.constrainU();
    const base = Object.assign({}, cU, tU, kU);

    // --- Tutuşturucu (söndürücü açıkken kıvılcım kesilir) ---
    const quenching = this.quenching();
    const smothering = this.smothering();
    let ignT = 0;
    if (quenching || smothering) this.ignTimer = 0;
    else if (this.ignTimer > 0) {
      ignT = st.ignT;
      this.ignTimer -= dt;
    }

    // --- 0) Katı levha ---
    if (st.source === 'sheet') {
      const fuel = this.phys.fuel;
      g.pass(P.sheet, f.solid.write, Object.assign({}, base, {
        uPrev: f.solid.read, uSca: f.sca.read, uDt: dt,
        uPyro: [fuel.pyroA, fuel.pyroE / FL.C.R, fuel.pyroDH, fuel.areal],
        uSheetP: [fuel.cS, fuel.emis, st.flameRadFeedback, fuel.inert],
        uCInert: fuel.cInert ?? fuel.cS,
        // Tutuşturucu, levhayı piroliz hızının 0,5 1/s olduğu sıcaklığa kadar ısıtır
        uSheetX: [fuel.pyroE / (FL.C.R * Math.log(fuel.pyroA / 0.5)), fuel.cpVap ?? 1500],
        uIgn: this.geo.ign, uIgnT: ignT,
      }));
      f.solid.swap();
      base.uSolid = f.solid.read;
      // Yanıp tükenen levha hücreleri gaza dönüşür: türler her adımda güncellenir
      this._updateTypes(true);
    } else {
      this._updateTypes(false);
    }

    // --- 1) Hız adveksiyonu (MacCormack) ---
    const mcS = st.maccormack ? 1 : 0;
    g.pass(P.advect, f.tmp1, Object.assign({}, base, { uVel: f.vel.read, uField: f.vel.read, uDt: dt }));
    if (mcS) {
      g.pass(P.advect, f.tmp2, Object.assign({}, base, { uVel: f.vel.read, uField: f.tmp1, uDt: -dt }));
      g.pass(P.maccormack, f.vel.write, Object.assign({}, base, {
        uVel: f.vel.read, uField: f.vel.read, uHat: f.tmp1, uTilde: f.tmp2, uDt: dt, uStrength: 1,
      }));
    } else {
      g.pass(P.maccormack, f.vel.write, Object.assign({}, base, {
        uVel: f.vel.read, uField: f.vel.read, uHat: f.tmp1, uTilde: f.tmp1, uDt: dt, uStrength: 0,
      }));
    }
    const velOld = f.vel.read;
    f.vel.swap();

    // --- 2) Skaler adveksiyonu: korunan değişkenler (ρ, ρT, ρY) ile MacCormack ---
    g.pass(P.advectU, g.mrt([f.tmp1.tex, f.u2a.tex]), Object.assign({}, base, { uVel: velOld, uField: f.sca.read, uAuxOld: f.aux.read, uDt: dt }));
    if (mcS) {
      g.pass(P.advect, g.mrt([f.tmp2.tex]), Object.assign({}, base, { uVel: velOld, uField: f.tmp1, uDt: -dt }));
      g.pass(P.advect, g.mrt([f.u2b.tex]), Object.assign({}, base, { uVel: velOld, uField: f.u2a, uDt: -dt }));
    }
    g.pass(P.correctU, g.mrt([f.sca.write.tex, f.sadv.tex]), Object.assign({}, base, {
      uVel: velOld, uField: f.sca.read, uAuxOld: f.aux.read,
      uHat: f.tmp1, uHat2: f.u2a, uTil: f.tmp2, uTil2: f.u2b, uDt: dt, uStrength: mcS,
    }));
    f.sca.swap();
    g.pass(P.advect, f.aux.write, Object.assign({}, base, { uVel: velOld, uField: f.aux.read, uDt: dt }));
    f.aux.swap();

    // --- 2b) Işınımla ısı transferi (kaynak toplamı) ---
    if (this.radOn()) this.solveRadiation(base);

    // --- 3) Kimya + kaynaklar (MRT) ---
    const fuel = this.phys.fuel;
    const coolOn = st.coolFlame && fuel.coolFlame ? 1 : 0;
    const combU = Object.assign({}, base, {
      uSca: f.sca.read, uAux: f.aux.read, uVel: f.vel.read, uSadv: f.sadv, uDt: dt, uG: f.radF,
      uFlowIn: st.flow / 100, uAuxMax: g.float32RT ? 1e9 : 6e4,
      uKin: this.phys.kin,
      uSoot: [st.soot ? 1 : 0, fuel.sootProp * st.sootMult, st.sootOx, 0],
      // Ozon katkısı: O₃ → O₂ + O; O atomu düşük sıcaklık zincirini başlatır
      // (RH + O → R + OH), soğuk alev kimyasını hızlandırır (Ju vd., ozonlu soğuk
      // difüzyon alevleri). Basit model: hız çarpanı 1 + 2,5·(% O₃).
      uCool: [coolOn, 2.6e5 * st.kinScale * (1 + 2.5 * Math.max(st.ozone || 0, 0)), 6000, 0.14],
      uIgn: this.geo.ign, uIgnT: quenching ? -1 : ignT,
      uSupS: [quenching ? 1 : 0, kU.uSup[2], 25, 0],
      // CO₂ bulutu: (açık, yarıçap [m], O₂ yer değiştirme hızı [1/s], 0)
      uSmo: [smothering ? 1 : 0, this.smotherRadius(kU), 14, 0],
      uWallT: this._wallT(),
      uSideAmbient: 1,
      uInject: quenching ? [0, 0, 0, 0] : this.injectU(),
    });
    g.pass(P.combust, g.mrt([f.sca.write.tex, f.aux.write.tex]), combU);
    f.sca.swap();
    f.aux.swap();

    // --- 4) Difüzyon: korunumlu, açık alt adımlı ---
    const lewis = [fuel.Le, 1.1, st.lewis ? 1 : 0, 0];
    const nD = this.diffusionSubsteps(dt);
    this.lastDiffSub = nD;
    for (let k = 0; k < nD; k++) {
      const first = k === 0;
      const last = k === nD - 1;
      const srcS = first ? f.sca.read : f.scaT.read;
      const srcA = first ? f.aux.read : f.auxT.read;
      const dstS = last ? f.sca.write : f.scaT.write;
      const dstA = last ? f.aux.write : f.auxT.write;
      g.pass(P.diffuse, g.mrt([dstS.tex, dstA.tex]), Object.assign({}, base, {
        uRhsS: f.sca.read, uCurS: srcS, uRhsA: f.aux.read, uCurA: srcA,
        uDtSub: dt / nD, uDt: dt, uLast: last ? 1 : 0, uLewis: lewis, uDiffScale: st.diffScale,
      }));
      if (!last) { f.scaT.swap(); f.auxT.swap(); }
    }
    f.sca.swap();
    f.aux.swap();

    // --- 5) Vortisite ---
    if (st.vorticity > 0) g.pass(P.curl, f.curl, Object.assign({}, base, { uVel: f.vel.read }));

    // --- 6) Kuvvetler ---
    const gv = this.gravityVector();
    g.pass(P.forces, f.vel.write, Object.assign({}, base, {
      uVel: f.vel.read, uSca: f.sca.read, uAux: f.aux.read, uCurl: f.curl,
      uGrav: gv, uEps: st.vorticity, uDt: dt, uWamb: this.phys.amb.W,
    }));
    f.vel.swap();

    // --- 7) Viskozite ---
    const nV = Math.max(1, st.viscIters | 0);
    for (let k = 0; k < nV; k++) {
      const src = k === 0 ? f.vel.read : f.velT.read;
      const last = k === nV - 1;
      const dst = last ? f.vel.write : f.velT.write;
      g.pass(P.viscosity, dst, Object.assign({}, base, {
        uRhs: f.vel.read, uCur: src, uSca: f.sca.read, uAux: f.aux.read,
        uDt: dt, uPr: 0.7, uDiffScale: st.diffScale,
      }));
      if (!last) f.velT.swap();
    }
    f.vel.swap();

    // --- 8) Basınç izdüşümü ---
    g.pass(P.divergence, f.div, Object.assign({}, base, { uVel: f.vel.read, uAux: f.aux.read, uExpansion: st.expansion ? 1 : 0 }));
    const nP = Math.max(1, st.pressureIters | 0);
    for (let k = 0; k < nP; k++) {
      for (let color = 0; color < 2; color++) {
        g.pass(P.pressure, f.p.write, Object.assign({}, base, { uP: f.p.read, uDiv: f.div, uColor: color, uOmega: st.sor }));
        f.p.swap();
      }
    }
    g.pass(P.subtract, f.vel.write, Object.assign({}, base, { uVel: f.vel.read, uP: f.p.read }));
    f.vel.swap();

    this.simTime += dt;
  }

  gravityVector() {
    const st = this.state;
    const g0 = st.gravity * FL.C.G0;
    let gx = 0, gy = -g0, gz = 0;
    if (st.gJitter > 0) {
      // g-sarsıntısı: ISS'teki titreşim ortamının basit modeli (birkaç Hz)
      const t = this.simTime;
      const a = st.gJitter * 1e-6 * FL.C.G0 * 100;
      gx += a * Math.sin(2 * Math.PI * 3.1 * t);
      gy += a * Math.sin(2 * Math.PI * 1.7 * t + 1.3);
      gz += a * Math.sin(2 * Math.PI * 4.3 * t + 0.4);
    }
    return [gx, gy, gz];
  }

  /* -------------------------------------------------------------- */
  /* CPU modelleri: damla d²-yasası                                  */
  /* -------------------------------------------------------------- */
  _updateCPUModels(dt) {
    const st = this.state;
    if (st.source !== 'droplet') return;
    if (!this.droplet) this._initDroplet();
    const d = this.droplet;
    if (!d.alive) return;
    const fuel = FL.FUELS[st.fuel];
    if (!fuel.rhoL) return;
    const amb = FL.ambientComposition(st.o2 / 100, st.diluent);
    // Tutuşturucu çalışırken damla yüzeyi de ısınır (sıcak tel / kıvılcım)
    const hot = this.flameOn || this.ignTimer > 0;
    const cool = !hot && this.stats.valid && this.stats.cool > 0.002 && st.coolFlame && fuel.coolFlame;
    // Yüzeydeki buhar kütle kesri: sıcak alevde kaynamaya yakın; aksi halde Clausius–Clapeyron
    const Ts = hot ? fuel.Tb - 4 : cool ? fuel.Tb - 30 : Math.min(st.Tamb, fuel.Tb - 40);
    const Psat = st.pressure * 1000 * Math.exp((fuel.Lv * fuel.W / FL.C.R) * (1 / fuel.Tb - 1 / Ts));
    const X = FL.clamp(Psat / (st.pressure * 1000), 0, 0.98);
    d.Yfs = (X * fuel.W) / (X * fuel.W + (1 - X) * amb.W);
    const res = FL.dropletBurning(fuel, amb, st.pressure * 1000, st.Tamb, d.d, st.gravity * FL.C.G0, st.flow / 100, hot, cool, hot ? undefined : d.Yfs);
    d.K = res.K;
    d.B = res.B;
    d.hot = hot;
    d.cool = cool;
    d.rRatio = res.rRatio;
    d.rhoFilm = res.rhoFilm;
    d.mdot = res.mdot;
    const d2 = d.d * d.d - d.K * dt;
    if (d2 <= Math.pow(0.12e-3, 2)) {
      d.d = 0;
      d.alive = false;
      this._event('Damla tükendi', 'burnout');
    } else {
      d.d = Math.sqrt(d2);
    }
    d.tBurn += dt;
  }

  /* -------------------------------------------------------------- */
  /* İstatistikler                                                  */
  /* -------------------------------------------------------------- */
  /**
   * GPU indirgemesi ile istatistikleri hesaplar. Varsayılan yol
   * engellemez: sonuç 1–3 kare sonra glc.pollReads() içinde uygulanır.
   * opts.sync = true ise hemen okunur (testler, dışa aktarma).
   */
  computeStats(opts) {
    const sync = (opts && opts.sync) || !this.asyncReads;
    if (!sync && this._statsInFlight) return null;
    const g = this.glc;
    const f = this.F;
    const base = Object.assign({}, this.commonU(), this.thermoU());
    const em = this.emis;
    g.pass(this.P.stats, g.mrt([f.statSum.tex, f.statMax.tex, f.statSum2.tex, f.statLum.tex]), Object.assign({}, base, {
      uSca: f.sca.read, uAux: f.aux.read, uVel: f.vel.read, uGs: f.radF,
      uHrrThr: this.state.hrrThr, uAnchor: this.geo.anchor,
      uLumOn: em ? 1 : 0,
      uLUT: em ? em.lut : null, uLUTRange: em ? em.lutRange : [300, 3400],
      uSootGain: em ? em.sootGain : 0, uChemCol: em ? em.chem : [0, 0, 0], uCoolCol: em ? em.cool : [0, 0, 0],
    }));
    const srcs = [f.statSum, f.statMax, f.statSum2, f.statLum];
    const ops = [0, 1, 0, 0];
    const chains = f.chains.slice();
    if (this.radOn()) {
      srcs.push(f.radF, f.radF);
      ops.push(0, 1);
      chains.push(f.radChains[0], f.radChains[1]);
    }
    const finals = [];
    for (let k = 0; k < srcs.length; k++) {
      let src = srcs[k];
      for (const t of chains[k]) {
        g.pass(this.P.reduce, t, { uSrc: src.tex || src, uOp: ops[k] });
        src = t;
      }
      finals.push(src);
    }
    const ctx = { t: this.simTime, gen: this._gen, d: this.droplet ? this.droplet.d : NaN };
    if (sync) {
      this._applyStats(finals.map((t) => g.readPixels(t, 0, 0, 1, 1, new Float32Array(4))), ctx);
      return this.stats;
    }
    this._statsInFlight = true;
    g.readAsync(finals.map((t) => ({ target: t, w: 1, h: 1 })), (out) => {
      if (ctx.gen !== this._gen) return;
      this._statsInFlight = false;
      this._applyStats(out, ctx);
    });
    return null;
  }

  _applyStats(out, ctx) {
    const s = this.stats;
    const last = this.history[this.history.length - 1];
    if (last && ctx.t <= last.t) return s;
    const [a, m, b, lum, rs, rm] = out;
    // Işınımla ısı transferi (P1): alanı terk eden ve katılara giden ışınım
    if (rs && rm) {
      s.radOut = rs[2];       // alan sınırlarına ulaşan ışınım gücü [W]
      s.qWallMax = rm[1];     // en büyük duvar akısı [W/m²]
      s.qFloorMax = rm[3];    // masaya gelen en büyük akı [W/m²]
      s.Gex = rm[0];
    } else {
      s.radOut = NaN; s.qWallMax = NaN; s.qFloorMax = NaN; s.Gex = NaN;
    }
    s.hrr = a[0];
    s.qrad = a[1];
    s.soot = a[2];
    s.cool = a[3];
    s.Tmax = m[0];
    s.umax = m[1];
    s.yTip = m[2];
    s.rMax = m[3];
    s.cx = a[0] > 1e-6 ? b[0] / a[0] : this.geo.anchor[0];
    s.cy = a[0] > 1e-6 ? b[1] / a[0] : this.geo.anchor[1] + 0.01;
    s.cz = a[0] > 1e-6 ? b[2] / a[0] : this.geo.anchor[2];
    s.lumY = Math.max(b[3], 0);
    s.lumR = lum ? Math.max(lum[0], 0) : 0;
    s.lumG = lum ? Math.max(lum[1], 0) : 0;
    s.lumB = lum ? Math.max(lum[2], 0) : 0;
    // Işık kaynağı: yatayda ısı salınımı merkezinde, düşeyde ışık ağırlıklı (kurum bölgesi)
    s.lx = s.cx;
    s.lz = s.cz;
    s.ly = s.lumY > 1e-9 && lum ? lum[3] / s.lumY : s.cy;
    s.valid = isFinite(s.hrr) && isFinite(s.Tmax);
    s.chiRad = s.hrr > 1e-3 ? s.qrad / s.hrr : 0;
    s.flameH = s.yTip > 0 ? Math.max(0, s.yTip - this.geo.anchor[1]) : 0;
    // Alev var/yok (söndü) mantığı: kısa süreli düşüşleri yok say
    const thr = this.state.source === 'droplet' ? 0.05 : 0.2;
    if (s.hrr > thr && s.Tmax > 1100) {
      if (!this.flameOn) this._event('Alev oluştu', 'flame', ctx.t);
      this.flameOn = true;
      this.extinctTimer = 0;
    } else if (this.flameOn) {
      this.extinctTimer += 1;
      if (this.extinctTimer > 6) {
        this.flameOn = false;
        this._event('Sönme', 'extinct', ctx.t);
      }
    }
    this.statsReady = true;
    this.history.push({
      t: ctx.t,
      hrr: s.hrr, Tmax: s.Tmax, chi: s.chiRad, H: s.flameH * 1000, soot: s.soot,
      d2: this.state.source === 'droplet' && isFinite(ctx.d) ? Math.pow(ctx.d * 1000, 2) : NaN,
      cool: s.cool, r: s.rMax * 1000, lum: s.lumY, qw: s.qWallMax / 1000,
    });
    if (this.history.length > this.maxHistory) this.history.shift();
    return s;
  }

  /** Levha ortasındaki piroliz cephesinin konumu → yayılma hızı (yalnız tek sütun okunur) */
  measureSheetFront(opts) {
    if (this.state.source !== 'sheet') return;
    const sync = (opts && opts.sync) || !this.asyncReads;
    if (!sync && this._sheetInFlight) return;
    const { NX, NY, dx } = this.grid;
    const i = Math.floor(NX / 2);
    const ctx = { t: this.simTime, gen: this._gen, y0: this.geo.src0[3], y1: this.geo.src1[0] };
    const apply = (col) => {
      let yHi = -1, yLo = Infinity;
      for (let j = 0; j < NY; j++) {
        const m = col[j * 4 + 1];
        const y = (j + 0.5) * dx;
        if (y >= ctx.y0 && y <= ctx.y1 && m < 0.5) { yHi = Math.max(yHi, y); yLo = Math.min(yLo, y); }
      }
      if (yHi < 0) return;
      const front = this.state.sheetIgnTop ? yLo : yHi;
      this.sheetFront.push([ctx.t, front * 1000]);
      if (this.sheetFront.length > 120) this.sheetFront.shift();
      const tail = this.sheetFront.slice(-40);
      const fit = FL.linfit(tail.map((p) => p[0]), tail.map((p) => p[1]));
      this.spread = fit ? Math.abs(fit.b) : NaN;
    };
    const target = this.F.solid.read;
    if (sync) { apply(this.glc.readPixels(target, i, 0, 1, NY)); return; }
    this._sheetInFlight = true;
    this.glc.readAsync([{ target, x: i, y: 0, w: 1, h: NY }], (out) => {
      if (ctx.gen !== this._gen) return;
      this._sheetInFlight = false;
      apply(out[0]);
    });
  }

  /** Dışa aktarma için CSV */
  historyCSV() {
    const rows = ['t_s;HRR_W;Tmax_K;chi_rad;alev_boyu_mm;kurum_ug;d2_mm2;soguk_alev_W;alev_yaricapi_mm;isik_siddeti_cd;duvar_isinim_akisi_kW_m2'];
    for (const h of this.history) {
      rows.push([h.t, h.hrr, h.Tmax, h.chi, h.H, h.soot, h.d2, h.cool, h.r, h.lum, h.qw].map((v) => (isFinite(v) ? Number(v).toPrecision(6) : '')).join(';'));
    }
    return rows.join('\n');
  }
}

// none: deney düzeneği yok (yalnız sahne nesneleri ve yangın efektleri); çözücüde katı ve yakıt kaynağı bulunmaz
const SOURCE_CODE = { jet: 0, candle: 1, droplet: 2, sheet: 3, none: 4 };
FL.SOURCE_CODE = SOURCE_CODE;
FL.Simulation = Simulation;
