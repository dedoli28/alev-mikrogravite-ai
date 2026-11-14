/* =====================================================================
 * Alev Laboratuvarı — Model sahnesi
 * ---------------------------------------------------------------------
 * Bir GLB modelini benzetim sahnesine gerçek ölçekte yerleştirir:
 *   - Görünürlük: üçgenler, ışın yürütmeyle aynı kamera ve alt piksel
 *     kaymasıyla bir G-tamponuna (ışın boyu uzaklık, normal, parça) çizilir.
 *     Işın yürütücü bu yüzeyi diğer katılar gibi aynı BRDF, alev ışığı,
 *     yumuşak gölge ve ortam kapatmayla gölgelendirir; alev hacmini örter.
 *   - Gölge ve ortam kapatma: model uzayında işaretli uzaklık alanı (3B doku).
 *   - Çözücü: model hesaplama alanına girerse içinde kalan hücreler katı olur.
 *   - Kesit görünümü: kabinin dışından bakarken kameraya bakan kabuk
 *     panelleri gizlenir (bebek evi görünümü).
 *   - Seçim: imleç altındaki parça CPU'da ışın–üçgen kesişimiyle bulunur.
 * ===================================================================== */
import { FL } from '../core/fl.js';

const M4 = () => FL.M4;
const SDF_CAP = 16;   // voksel

/* ------------------------------------------------------------------ */
/* G-tamponu gölgelendiricileri                                         */
/* ------------------------------------------------------------------ */
const VS = `#version 300 es
precision highp float;
precision highp sampler2D;
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNor;
layout(location = 2) in float aPid;
uniform mat4 uVP;
uniform mat4 uModel;
uniform vec2 uJitter;
uniform sampler2D uPart;
out vec3 vW;
out vec3 vN;
out vec3 vL;
flat out float vPid;
void main() {
  int pid = int(aPid + 0.5);
  int st = int(texelFetch(uPart, ivec2(pid, 2), 0).a + 0.5);
  if ((st & 1) == 0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); vW = vec3(0.0); vN = vec3(0.0, 1.0, 0.0); vL = vec3(0.0); vPid = 0.0; return; }
  vec4 w = uModel * vec4(aPos, 1.0);
  vW = w.xyz;
  vL = aPos;
  vN = mat3(uModel) * aNor;
  vPid = aPid;
  vec4 c = uVP * w;
  // Işın yürütücü pikseli ndc + jitter yönünde örnekler: geometri ters yönde kaydırılır
  c.xy -= uJitter * c.w;
  gl_Position = c;
}
`;
const FS = `#version 300 es
precision highp float;
precision highp sampler2D;
precision highp sampler3D;
in vec3 vW;
in vec3 vN;
in vec3 vL;
flat in float vPid;
uniform vec3 uCamPos;
uniform sampler2D uPart;
// Yanık izi: yangın hücrelerinin ısısı (R) ve kömürleşmesi (G), model uzayında hacim dokusu.
// Burada (küçük gölgelendiricide) örneklenir; ışın yürütücü yalnız sonucu okur.
uniform float uFxOn;
uniform sampler3D uFxBurn;
uniform vec3 uFxBGo;             // yanık ızgarasının ilk hücre merkezi (model uzayı)
uniform float uFxBGd;            // voksel [m]
uniform vec3 uFxBGn;
uniform sampler2D uFxNoise;      // döşenebilir fBm (kanal başına ayrı alan)
uniform float uFxNoiseK;         // yanık kenarı gürültüsünün uzamsal frekansı [1/m]
uniform float uFxTime;
layout(location = 0) out vec4 oG0;   // (ışın boyu uzaklık [m], normal)
layout(location = 1) out vec4 oG1;   // (parça + 1, ısı, kömürleşme, kor titreşimi)
void main() {
  vec3 n = normalize(vN);
  vec3 v = uCamPos - vW;
  // İki yüzlü malzemeler: normal her zaman kameraya bakar
  if (dot(n, v) < 0.0) n = -n;
  oG0 = vec4(length(v), n);
  vec3 burn = vec3(0.0, 0.0, 0.5);
  if (uFxOn > 0.5) {
    vec3 gq = (vL - uFxBGo) / uFxBGd;
    if (all(greaterThan(gq, vec3(-0.5))) && all(lessThan(gq, uFxBGn - 0.5))) {
      vec2 bv = textureLod(uFxBurn, (gq + 0.5) / uFxBGn, 0.0).rg;
      bool glass = texelFetch(uPart, ivec2(int(vPid + 0.5), 1), 0).z > 0.5;
      if (bv.x + bv.y > 0.004 && !glass) {
        // Üç düzlemli gürültü, düzgün alanı düzensiz, organik bir yanık kenarına çevirir
        vec3 bw = abs(n);
        bw /= bw.x + bw.y + bw.z;
        vec3 bp = vL * uFxNoiseK;
        float bn = textureLod(uFxNoise, bp.yz, 0.0).g * bw.x + textureLod(uFxNoise, bp.xz, 0.0).g * bw.y + textureLod(uFxNoise, bp.xy, 0.0).g * bw.z;
        float flick = textureLod(uFxNoise, bp.xy * 1.6 + bp.z * 0.9 + vec2(uFxTime * 0.11, -uFxTime * 0.07), 0.0).b;
        burn = vec3(bv.x, smoothstep(bn * 0.7, bn * 0.7 + 0.3, bv.y * 1.3), flick);
      }
    }
  }
  oG1 = vec4(vPid + 1.0, burn);
}
`;

/* sRGB onaltılık → doğrusal */
function hexLin(h) {
  const v = parseInt(h.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255].map((c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
}

class ModelScene {
  constructor(glc) {
    this.glc = glc;
    this.gl = glc.gl;
    this.def = null;
    this.ready = false;
    this.loading = null;
    this.parts = [];
    this.hover = -1;
    this.selected = new Set();
    this.mode = 'class';
    this.o2 = 21;
    this.version = 0;          // yerleşim/ızgara değişimi sayacı
    this._srcCache = new Map();
    this.prog = glc.program('modelGBuffer', FS, VS);
    // Model yokken de bağlı kalacak boş 3B doku (örnekleyici türleri çakışmasın)
    this.dummy3D = this._tex3D(1, 1, 1, new Uint8Array([255]));
    this.dummyPart = glc.texture(1, 3, { internal: this.gl.RGBA32F, type: this.gl.FLOAT, data: new Float32Array(12), filter: this.gl.NEAREST });
    this.M = FL.M4.identity();
    this.Minv = FL.M4.identity();
  }

  /* -------------------------------------------------------------- */
  /* Yükleme                                                        */
  /* -------------------------------------------------------------- */
  async load(def, onProgress) {
    const token = {};
    this._token = token;
    this.ready = false;
    this.def = def;
    const say = (f, t) => onProgress && onProgress(f, t);
    say(0.05, 'Model indiriliyor');
    let g;
    if (def.composite) {
      // Birden çok nesne: her biri ayrı indirilir, tek sahnede yan yana birleştirilir
      const list = [];
      for (const d of def.defs) {
        const buf = await (await fetch(d.url)).arrayBuffer();
        if (this._token !== token) return false;
        list.push({ def: d, glb: FL.parseGLB(buf) });
      }
      say(0.15, 'Nesneler yerleştiriliyor');
      g = mergeObjects(list);
    } else {
      const buf = await (await fetch(def.url)).arrayBuffer();
      if (this._token !== token) return false;
      say(0.15, 'Ağ çözümleniyor');
      g = FL.parseGLB(buf);
      for (const p of g.parts) p.obj = def.short;
    }
    // Kabin: gömülü modellerin parçaları kendi GLB'lerindeki gerçek malzemeyle çizilir
    const srcMats = new Map();
    for (const p of g.parts) {
      const k = p.extras.kaynak;
      if (k && !srcMats.has(k)) {
        const m = FL.MODELS.find((x) => x.file === k);
        if (m) srcMats.set(k, await this._sourceMaterials(m));
      }
    }
    if (this._token !== token) return false;
    this._build(g, srcMats);
    say(0.3, 'Uzaklık alanı hesaplanıyor');
    await this._buildSDF(token, (f) => say(0.3 + 0.65 * f, 'Uzaklık alanı hesaplanıyor'));
    if (this._token !== token) return false;
    this.ready = true;
    this.version++;
    say(1, 'Hazır');
    return true;
  }

  unload() {
    this._token = null;
    this.ready = false;
    this.def = null;
    this._freeGPU();
    this.parts = [];
    this.hover = -1;
    this.selected.clear();
    this.version++;
  }

  async _sourceMaterials(m) {
    if (this._srcCache.has(m.id)) return this._srcCache.get(m.id);
    const g = FL.parseGLB(await (await fetch(m.url)).arrayBuffer());
    const map = new Map();
    for (const p of g.parts) map.set(p.name.replace(/\.\d+$/, ''), p.material);
    this._srcCache.set(m.id, map);
    return map;
  }

  /** Parça tablosu, birleşik köşe tamponu, kabuk paneli bilgisi */
  _build(g, srcMats) {
    const gl = this.gl;
    this._freeGPU();
    this.root = { name: g.name, extras: g.extras };
    const parts = [];
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const p of g.parts) {
      const m = p.material;
      // Saydam hacimler (kabin havası) ve görüş için saydam yapılan tavan çizilmez
      if (m.alpha < 0.35) continue;
      const ex = p.extras;
      const info = FL.materialInfo(ex.malzeme, ex.sim_sinifi);
      const level = FL.partLevel(ex);
      // Gerçekçi görünüm: kendi PBR'ı (tek başına model), kaynak modelinki (kabine gömülü) ya da malzeme tablosu
      let alb = m.base.slice(), rough = m.rough, metal = m.metal;
      const fromSrc = ex.kaynak && srcMats.get(ex.kaynak);
      const srcM = fromSrc ? fromSrc.get(p.name.replace(/\.\d+$/, '')) : null;
      if (srcM) { alb = srcM.base.slice(); rough = srcM.rough; metal = srcM.metal; }
      else if (/^Seviye_|^Yapi_|^Cam_/.test(m.name) && info.pbr) {
        alb = info.pbr.slice(0, 3); rough = info.pbr[3]; metal = info.pbr[4];
      } else if (/^Seviye_|^Yapi_/.test(m.name)) {
        alb = [0.5, 0.5, 0.5]; rough = 0.6; metal = 0;
      }
      if (/^Cam_/.test(m.name)) { alb = [0.012, 0.02, 0.03]; rough = 0.05; metal = 0; }
      const shell = p.path.includes('Basinc_Kabini');
      const part = {
        id: parts.length, name: p.name, label: FL.partLabel(p.name), group: FL.partGroupName(p.name),
        path: p.path, extras: ex, info, level, alb, rough, metal, glass: /^Cam_/.test(m.name),
        pos: p.pos, nor: p.nor, idx: p.idx, lo: p.lo, hi: p.hi, shell, visible: true,
        // Parçanın ait olduğu sahne nesnesi (CO₂ tüpü, SFOG...) ve patlamada parçalanma durumu
        obj: p.obj || null, destroyed: false,
        // Gövde dışına taşan, iç gölgeye karışmayan parçalar (burun gövdesi): uzaklık alanına girmez
        noSdf: ex.sdf === false,
      };
      parts.push(part);
      for (let c = 0; c < 3; c++) { lo[c] = Math.min(lo[c], p.lo[c]); hi[c] = Math.max(hi[c], p.hi[c]); }
    }
    this.parts = parts;
    this.lo = lo; this.hi = hi;
    // Kabuk panelleri: ince eksen ve dışa bakan yön
    const ctr = [0, 1, 2].map((c) => 0.5 * (lo[c] + hi[c]));
    for (const p of parts) {
      if (!p.shell) continue;
      const ext = [0, 1, 2].map((c) => p.hi[c] - p.lo[c]);
      const ax = ext.indexOf(Math.min(...ext));
      const big = ext.filter((e, c) => c !== ax).every((e) => e > 0.8);
      if (!big || ext[ax] > 0.15) { p.shell = false; continue; }
      const pc = 0.5 * (p.lo[ax] + p.hi[ax]);
      p.cut = { ax, side: Math.sign(pc - ctr[ax]) || 1, plane: pc };
    }
    // Açık kesit bayrağı (extras.kesit = { eksen, taraf, duzlem }): kamera o düzlemin "taraf" yönüne
    // geçince parça gizlenir. Kokpit çatısı: kamera kabinin üstüne çıkınca (tavan zaten çizilmez) kalkar.
    for (const p of parts) {
      const k = p.extras.kesit;
      if (k && Number.isFinite(k.eksen) && Number.isFinite(k.duzlem)) p.cut = { ax: k.eksen, side: k.taraf < 0 ? -1 : 1, plane: k.duzlem };
    }

    // Birleşik köşe tamponu: konum, normal, parça kimliği
    let nv = 0, ni = 0;
    for (const p of parts) { nv += p.pos.length / 3; ni += p.idx.length; }
    const pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3), pid = new Float32Array(nv);
    const idx = new Uint32Array(ni);
    let ov = 0, oi = 0;
    for (const p of parts) {
      pos.set(p.pos, ov * 3);
      nor.set(p.nor, ov * 3);
      pid.fill(p.id, ov, ov + p.pos.length / 3);
      for (let k = 0; k < p.idx.length; k++) idx[oi + k] = p.idx[k] + ov;
      ov += p.pos.length / 3;
      oi += p.idx.length;
    }
    this.triCount = ni / 3;
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const mk = (data, loc, n) => {
      const b = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, n, gl.FLOAT, false, 0, 0);
      return b;
    };
    const bufs = [mk(pos, 0, 3), mk(nor, 1, 3), mk(pid, 2, 1)];
    const ib = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    this.gpu = { vao, bufs, ib, count: ni };

    // Parça tablosu: satır 0 (albedo, pürüzlülük), 1 (metalik, seviye, cam, -), 2 (yanıcılık rengi, durum)
    const n = parts.length;
    this.partData = new Float32Array(n * 12);
    for (const p of parts) {
      const o0 = p.id * 4, o1 = (n + p.id) * 4;
      this.partData.set([p.alb[0], p.alb[1], p.alb[2], p.rough], o0);
      this.partData.set([p.metal, p.level, p.glass ? 1 : 0, 0], o1);
    }
    this.partTex = this.glc.texture(n, 3, { internal: gl.RGBA32F, type: gl.FLOAT, data: this.partData, filter: gl.NEAREST });
    this._paintParts();
  }

  _freeGPU() {
    const gl = this.gl;
    if (this.gpu) {
      gl.deleteVertexArray(this.gpu.vao);
      this.gpu.bufs.forEach((b) => gl.deleteBuffer(b));
      gl.deleteBuffer(this.gpu.ib);
      this.gpu = null;
    }
    if (this.partTex) { this.glc.destroyTexture(this.partTex); this.partTex = null; }
    if (this.sdfTex) { gl.deleteTexture(this.sdfTex.handle); this.sdfTex = null; }
  }

  _tex3D(nx, ny, nz, data) {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_3D, t);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.R8, nx, ny, nz, 0, gl.RED, gl.UNSIGNED_BYTE, data);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    for (const w of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, w, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_BASE_LEVEL, 0);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAX_LEVEL, 0);
    gl.bindTexture(gl.TEXTURE_3D, null);
    return { handle: t, is3D: true, w: nx, h: ny, d: nz };
  }

  /** Model uzayında SDF: en uzun kenar ~150 voksel, 3 voksel kenar payı */
  async _buildSDF(token, prog) {
    // Cam ve ince saydam olmayan her şey gölge düşürür. Burun gibi "sdf: false" parçalar ızgaraya girmez:
    // ızgara yalnız kabin hacmini kaplar, böylece burun kabin içi gölge çözünürlüğünü düşürmez.
    const parts = this.parts.filter((p) => !p.glass && !p.noSdf);
    const slo = [Infinity, Infinity, Infinity], shi = [-Infinity, -Infinity, -Infinity];
    for (const p of parts) for (let c = 0; c < 3; c++) { slo[c] = Math.min(slo[c], p.lo[c]); shi[c] = Math.max(shi[c], p.hi[c]); }
    const ext = [0, 1, 2].map((c) => shi[c] - slo[c]);
    const L = Math.max(...ext);
    const res = this.def.large ? 156 : 132;
    const d = L / (res - 8);
    const n = ext.map((e) => Math.max(4, Math.ceil(e / d) + 7));
    const o = [0, 1, 2].map((c) => 0.5 * (slo[c] + shi[c]) - 0.5 * (n[c] - 1) * d);
    const grid = { o, d, n };
    const dist = await FL.voxelSDF(parts, grid, { cap: SDF_CAP, progress: prog, alive: () => this._token === token });
    if (!dist || this._token !== token) return;
    const data = new Uint8Array(dist.length);
    for (let q = 0; q < dist.length; q++) data[q] = Math.max(0, Math.min(255, Math.round((dist[q] / SDF_CAP * 0.5 + 0.5) * 255)));
    if (this.sdfTex) this.gl.deleteTexture(this.sdfTex.handle);
    this.sdfTex = this._tex3D(n[0], n[1], n[2], data);
    this.sdfGrid = grid;
  }

  /* -------------------------------------------------------------- */
  /* Yerleşim                                                       */
  /* -------------------------------------------------------------- */
  /**
   * Model → dünya dönüşümü. Küçük modeller masaya, deney kutusunun arkasına
   * oturur; kabin modelinde deney kutusu orta güverte döşemesindedir.
   */
  place(st, grid) {
    if (!this.def || !this.parts.length) return;
    const def = this.def;
    const a = ((st.modelRot || 0) * Math.PI) / 180;
    const c = Math.cos(a), s = Math.sin(a);
    const box = [grid.Lx, grid.Ly, grid.Lz];
    const mx = (st.modelX || 0) / 100, mz = (st.modelZ || 0) / 100;
    let T;
    const rot = (p) => [c * p[0] + s * p[2], p[1], -s * p[0] + c * p[2]];
    if (def.anchor) {
      const r = rot(def.anchor);
      T = [box[0] / 2 + mx - r[0], -def.anchor[1], box[2] / 2 + mz - r[2]];
    } else {
      // Dönmüş sınır kutusu
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (let k = 0; k < 8; k++) {
        const p = rot([k & 1 ? this.hi[0] : this.lo[0], k & 2 ? this.hi[1] : this.lo[1], k & 4 ? this.hi[2] : this.lo[2]]);
        for (let q = 0; q < 3; q++) { lo[q] = Math.min(lo[q], p[q]); hi[q] = Math.max(hi[q], p[q]); }
      }
      T = [box[0] / 2 + mx - 0.5 * (lo[0] + hi[0]), -lo[1], -0.015 + mz - hi[2]];
    }
    const M = new Float32Array([c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, T[0], T[1], T[2], 1]);
    const key = Array.from(M).map((v) => v.toFixed(6)).join(',');
    if (key !== this._placeKey) { this._placeKey = key; this.version++; }
    this.M = M;
    this.Minv = FL.M4.invert(M);
    this.rotC = c; this.rotS = s; this.T = T;
    // Dünya sınır kutusu
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let k = 0; k < 8; k++) {
      const p = FL.M4.transformPoint(M, [k & 1 ? this.hi[0] : this.lo[0], k & 2 ? this.hi[1] : this.lo[1], k & 4 ? this.hi[2] : this.lo[2]]);
      for (let q = 0; q < 3; q++) { lo[q] = Math.min(lo[q], p[q]); hi[q] = Math.max(hi[q], p[q]); }
    }
    this.worldLo = lo; this.worldHi = hi;
  }

  /** Kesit görünümü: kameraya bakan kabuk panellerini gizle (yalnız kabinin dışından) */
  updateCutaway(eye) {
    if (!this.ready) return;
    const l = FL.M4.transformPoint(this.Minv, eye);
    const inside = l[0] > this.lo[0] && l[0] < this.hi[0] && l[1] > this.lo[1] && l[1] < this.hi[1] && l[2] > this.lo[2] && l[2] < this.hi[2];
    let changed = false;
    for (const p of this.parts) {
      if (!p.cut) continue;
      const vis = inside || p.cut.side * (l[p.cut.ax] - p.cut.plane) < 0;
      if (vis !== p.visible) { p.visible = vis; changed = true; }
    }
    if (changed) this._paintParts();
  }

  /* -------------------------------------------------------------- */
  /* Yanıcılık boyaması ve seçim                                    */
  /* -------------------------------------------------------------- */
  setFlam(mode, o2) {
    if (mode === this.mode && Math.abs(o2 - this.o2) < 1e-6) return;
    this.mode = mode;
    this.o2 = o2;
    this._paintParts();
  }

  colorOf(p) {
    // Yapay zekâ görünümü: modelin öngördüğü risk (FL.AIView.paint yazar)
    if (this.mode === 'ai') return p.aiHex || '#3a4350';
    if (this.mode === 'atm') return FL.FLAM_VERDICTS[FL.flamVerdict(p.info, this.o2)].color;
    return FL.FLAM_LEVELS[p.level].color;
  }

  setHover(id) {
    if (id === this.hover) return false;
    this.hover = id;
    this._paintParts();
    return true;
  }

  setSelection(ids) {
    this.selected = new Set(ids);
    this._paintParts();
  }

  _paintParts() {
    if (!this.partTex) return;
    const n = this.parts.length;
    const lin = new Map();
    for (const p of this.parts) {
      const hex = this.colorOf(p);
      if (!lin.has(hex)) lin.set(hex, hexLin(hex));
      const c = lin.get(hex);
      // Patlamada parçalanan parça çizilmez (yerine enkaz uçar)
      const st = (p.visible && !p.destroyed ? 1 : 0) | (p.id === this.hover ? 2 : 0) | (this.selected.has(p.id) ? 4 : 0) | (this.mode === 'ai' && p.aiNext ? 8 : 0);
      this.partData.set([c[0], c[1], c[2], st], (2 * n + p.id) * 4);
    }
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.partTex.handle);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 2, n, 1, gl.RGBA, gl.FLOAT, this.partData, 2 * n * 4);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  /** Dünya ışınıyla en yakın görünür parça (−1: yok) */
  pick(ro, rd) {
    if (!this.ready) return { id: -1 };
    const o = FL.M4.transformPoint(this.Minv, ro);
    const c = this.rotC, s = this.rotS;
    // Ters dönüş (yalnız y çevresinde)
    const d = [c * rd[0] - s * rd[2], rd[1], s * rd[0] + c * rd[2]];
    let best = Infinity, bestId = -1;
    for (const p of this.parts) {
      if (!p.visible || p.destroyed) continue;
      if (!rayBox(o, d, p.lo, p.hi, best)) continue;
      const P = p.pos, I = p.idx;
      for (let t = 0; t < I.length; t += 3) {
        const h = rayTri(o, d, P, I[t] * 3, I[t + 1] * 3, I[t + 2] * 3);
        if (h > 0 && h < best) { best = h; bestId = p.id; }
      }
    }
    return { id: bestId, t: best };
  }

  /* -------------------------------------------------------------- */
  /* Çözücü: alan içindeki katı hücreler                             */
  /* -------------------------------------------------------------- */
  async occupancy(gr) {
    if (!this.ready) return null;
    const lo = this.worldLo, hi = this.worldHi;
    if (hi[0] < 0 || hi[1] < 0 || hi[2] < 0 || lo[0] > gr.Lx || lo[1] > gr.Ly || lo[2] > gr.Lz) return null;
    // Alanla kesişen parçaları dünya uzayına taşı
    const M = this.M;
    const parts = [];
    for (const p of this.parts) {
      const wlo = [Infinity, Infinity, Infinity], whi = [-Infinity, -Infinity, -Infinity];
      for (let k = 0; k < 8; k++) {
        const q = FL.M4.transformPoint(M, [k & 1 ? p.hi[0] : p.lo[0], k & 2 ? p.hi[1] : p.lo[1], k & 4 ? p.hi[2] : p.lo[2]]);
        for (let a = 0; a < 3; a++) { wlo[a] = Math.min(wlo[a], q[a]); whi[a] = Math.max(whi[a], q[a]); }
      }
      if (whi[0] < 0 || whi[1] < 0 || whi[2] < 0 || wlo[0] > gr.Lx || wlo[1] > gr.Ly || wlo[2] > gr.Lz) continue;
      const pos = new Float32Array(p.pos.length);
      for (let k = 0; k < pos.length; k += 3) {
        const x = p.pos[k], y = p.pos[k + 1], z = p.pos[k + 2];
        pos[k] = M[0] * x + M[8] * z + M[12];
        pos[k + 1] = y + M[13];
        pos[k + 2] = M[2] * x + M[10] * z + M[14];
      }
      parts.push({ pos, idx: p.idx, lo: wlo, hi: whi });
    }
    if (!parts.length) return null;
    const occ = await FL.voxelInside(parts, { o: [0.5 * gr.dx, 0.5 * gr.dx, 0.5 * gr.dx], d: gr.dx, n: [gr.NX, gr.NY, gr.NZ] });
    let any = 0;
    for (let q = 0; q < occ.length; q++) any += occ[q];
    return any ? occ : null;
  }

  /* -------------------------------------------------------------- */
  /* Çizim                                                           */
  /* -------------------------------------------------------------- */
  /** G-tamponu: ışın yürütme hedefiyle aynı boyut */
  ensureTargets(w, h) {
    const gl = this.gl;
    if (this.gb && this.gb.w === w && this.gb.h === h) return;
    this.freeTargets();
    const g = this.glc;
    const o = { internal: g.fmtField, type: g.typeField, filter: gl.NEAREST };
    const t0 = g.texture(w, h, o), t1 = g.texture(w, h, o);
    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t0.handle, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, t1.handle, 0);
    const rb = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, rb);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (!ok) throw new Error('Model G-tamponu kurulamadı');
    this.gb = { fb, rb, t0, t1, w, h };
  }

  freeTargets() {
    if (!this.gb) return;
    const gl = this.gl;
    gl.deleteFramebuffer(this.gb.fb);
    gl.deleteRenderbuffer(this.gb.rb);
    this.glc.destroyTexture(this.gb.t0);
    this.glc.destroyTexture(this.gb.t1);
    this.gb = null;
  }

  /** fxU: yanık izi uniform'ları (FL.FxRenderer.burnUniforms) */
  renderGBuffer(cam, jitter, w, h, fxU) {
    if (!this.ready || !this.gpu) return false;
    this.ensureTargets(w, h);
    const gl = this.gl;
    const P = this.prog;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.gb.fb);
    gl.viewport(0, 0, w, h);
    gl.clearBufferfv(gl.COLOR, 0, [0, 0, 0, 0]);
    gl.clearBufferfv(gl.COLOR, 1, [0, 0, 0, 0]);
    gl.clearBufferfi(gl.DEPTH_STENCIL, 0, 1, 0);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    gl.disable(gl.CULL_FACE);
    gl.useProgram(P.handle);
    this.glc.setUniform(P, 'uVP', cam.vp);
    this.glc.setUniform(P, 'uModel', this.M);
    this.glc.setUniform(P, 'uJitter', jitter);
    this.glc.setUniform(P, 'uCamPos', cam.eye);
    this.glc.bindSampler(P, 'uPart', this.partTex, 0);
    if (fxU) {
      this.glc.bindSampler(P, 'uFxBurn', fxU.uFxBurn, 1);
      this.glc.bindSampler(P, 'uFxNoise', fxU.uFxNoise, 2);
      for (const k of ['uFxOn', 'uFxBGo', 'uFxBGd', 'uFxBGn', 'uFxNoiseK', 'uFxTime']) this.glc.setUniform(P, k, fxU[k]);
    }
    gl.bindVertexArray(this.gpu.vao);
    gl.drawElements(gl.TRIANGLES, this.gpu.count, gl.UNSIGNED_INT, 0);
    gl.bindVertexArray(null);
    gl.disable(gl.DEPTH_TEST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return true;
  }

  /** Işın yürütücünün model uniform'ları */
  uniforms(on, flam) {
    if (!on || !this.ready || !this.gb) {
      return { uMOn: 0, uMSdf: this.dummy3D, uMPart: this.dummyPart, uGB0: this.dummyPart, uGB1: this.dummyPart, uMFlam: 0 };
    }
    const g = this.sdfGrid;
    return {
      uMOn: 1,
      uGB0: this.gb.t0, uGB1: this.gb.t1,
      uMPart: this.partTex,
      uMSdf: this.sdfTex,
      uMInv: this.Minv,
      uMGo: g.o, uMGd: g.d, uMGn: g.n,
      uMCap: SDF_CAP * g.d,
      uMFlam: flam ? 1 : 0,
    };
  }
}

/**
 * Nesneleri tek sahnede birleştirir: her biri kendi varsayılan yönüne döndürülür (def.rot),
 * tabanı masaya, arkası ortak bir hizaya oturtulur ve x boyunca aralıklı dizilir.
 * Parçalar hangi nesneye ait olduklarını (obj) taşır; yanıcılık ve yangın modülleri
 * her nesneyi ayrı değerlendirir.
 */
function mergeObjects(list) {
  const GAP = 0.05;
  const parts = [];
  let cursor = 0;
  for (const { def, glb } of list) {
    const a = ((def.rot || 0) * Math.PI) / 180;
    const c = Math.cos(a), s = Math.sin(a);
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    const rotated = glb.parts.map((p) => {
      const n = p.pos.length / 3;
      const pos = new Float32Array(p.pos.length), nor = new Float32Array(p.nor.length);
      for (let k = 0; k < n; k++) {
        const x = p.pos[k * 3], y = p.pos[k * 3 + 1], z = p.pos[k * 3 + 2];
        pos[k * 3] = c * x + s * z; pos[k * 3 + 1] = y; pos[k * 3 + 2] = -s * x + c * z;
        const nx = p.nor[k * 3], ny = p.nor[k * 3 + 1], nz = p.nor[k * 3 + 2];
        nor[k * 3] = c * nx + s * nz; nor[k * 3 + 1] = ny; nor[k * 3 + 2] = -s * nx + c * nz;
        for (let q = 0; q < 3; q++) { const v = pos[k * 3 + q]; if (v < lo[q]) lo[q] = v; if (v > hi[q]) hi[q] = v; }
      }
      return { p, pos, nor };
    });
    const T = [cursor - lo[0], -lo[1], -hi[2]];
    for (const r of rotated) {
      const plo = [Infinity, Infinity, Infinity], phi = [-Infinity, -Infinity, -Infinity];
      for (let k = 0; k < r.pos.length; k += 3) {
        for (let q = 0; q < 3; q++) {
          const v = (r.pos[k + q] += T[q]);
          if (v < plo[q]) plo[q] = v;
          if (v > phi[q]) phi[q] = v;
        }
      }
      parts.push(Object.assign({}, r.p, { pos: r.pos, nor: r.nor, lo: plo, hi: phi, obj: def.short, path: [def.id].concat(r.p.path || []) }));
    }
    cursor += hi[0] - lo[0] + GAP;
  }
  return { name: list.map((x) => x.def.short).join(' + '), extras: {}, parts };
}

function rayBox(o, d, lo, hi, tmax) {
  let t0 = 0, t1 = tmax;
  for (let a = 0; a < 3; a++) {
    const inv = 1 / d[a];
    let ta = (lo[a] - o[a]) * inv, tb = (hi[a] - o[a]) * inv;
    if (ta > tb) { const t = ta; ta = tb; tb = t; }
    t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
    if (t1 < t0) return false;
  }
  return true;
}

/** Möller–Trumbore */
function rayTri(o, d, P, a, b, c) {
  const e1x = P[b] - P[a], e1y = P[b + 1] - P[a + 1], e1z = P[b + 2] - P[a + 2];
  const e2x = P[c] - P[a], e2y = P[c + 1] - P[a + 1], e2z = P[c + 2] - P[a + 2];
  const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < 1e-14) return -1;
  const inv = 1 / det;
  const tx = o[0] - P[a], ty = o[1] - P[a + 1], tz = o[2] - P[a + 2];
  const u = (tx * px + ty * py + tz * pz) * inv;
  if (u < 0 || u > 1) return -1;
  const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
  const v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv;
  if (v < 0 || u + v > 1) return -1;
  return (e2x * qx + e2y * qy + e2z * qz) * inv;
}

FL.ModelScene = ModelScene;
void M4;
