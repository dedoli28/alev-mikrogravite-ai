/* =====================================================================
 * Mekik kabini: boşta kalan oksijen borularını bağlar
 * ---------------------------------------------------------------------
 * Kaynak modelde (tools/models-src/mekik_kabini.glb) dört oksijen ucu
 * hiçbir yere bağlı değildi:
 *   1. Ana O₂ hattının arka ucu (x = 4,40 m, döşeme altı)
 *   2. Kabin O₂ vanasının giriş borusu (döşeme üstünde, boşta)
 *   3. Kabin O₂ vanasının çıkış borusu (yukarı bakıyor, boşta)
 *   4. Acil oksijen üretecinin (SFOG) çıkış borusu
 *   5. Ana hattın ön yükselticisi (döşemenin 5 cm altında bitiyor)
 * Bu araç, eksen ve çapları mevcut borularla eşleşen dirsekli borular,
 * bağlantı blokları, döşeme ve perde geçişleri, kelepçeler ve bir çek valf
 * ekler; sonucu src/assets/models/mekik_kabini.glb olarak yazar.
 *
 * Akış şeması:
 *   PRSD O₂ tankı ─(arka perde geçişi)─┐
 *                                      ├─ ana hat (döşeme altı) ─ dirsek ─ yükseltici ─ VANA ─ kabin O₂ paneli
 *   SFOG ─ çek valf ─(döşeme geçişi)───┘
 *   ana hattın ön ucu ─ ön perde geçişi (uçuş güvertesi kask O₂ hattı)
 *
 * Kullanım: node tools/o2-baglanti.mjs
 * Çakışma denetimi: her güzergâh, kabindeki tüm parçaların sınır kutularına
 * karşı 5 mm adımla taranır; beklenmeyen bir temas olursa araç durur.
 * ===================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(here, 'models-src', 'mekik_kabini.glb');
const OUT = path.join(here, '..', 'src', 'assets', 'models', 'mekik_kabini.glb');

/* ------------------------------------------------------------------ */
/* GLB okuma                                                           */
/* ------------------------------------------------------------------ */
const file = fs.readFileSync(SRC);
const jsonLen = file.readUInt32LE(12);
const gltf = JSON.parse(file.subarray(20, 20 + jsonLen).toString('utf8'));
const binLen = file.readUInt32LE(20 + jsonLen);
let bin = Buffer.from(file.subarray(28 + jsonLen, 28 + jsonLen + binLen));

if (gltf.nodes.some((n) => n.name === 'O2_Baglantilari')) {
  console.error('Model zaten bağlantıları içeriyor.');
  process.exit(1);
}

/* ------------------------------------------------------------------ */
/* Küçük vektör yardımcıları                                           */
/* ------------------------------------------------------------------ */
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => mul(a, 1 / (len(a) || 1));
const anyPerp = (t) => norm(Math.abs(t[1]) < 0.9 ? cross(t, [0, 1, 0]) : cross(t, [1, 0, 0]));

/* ------------------------------------------------------------------ */
/* Dünya dönüşümleri ve sınır kutuları (çakışma denetimi)              */
/* ------------------------------------------------------------------ */
const parent = {};
gltf.nodes.forEach((n, i) => (n.children || []).forEach((c) => (parent[c] = i)));
function localM(n) {
  const t = n.translation || [0, 0, 0], q = n.rotation || [0, 0, 0, 1], s = n.scale || [1, 1, 1];
  const [x, y, z, w] = q;
  return [
    (1 - 2 * (y * y + z * z)) * s[0], 2 * (x * y + z * w) * s[0], 2 * (x * z - y * w) * s[0], 0,
    2 * (x * y - z * w) * s[1], (1 - 2 * (x * x + z * z)) * s[1], 2 * (y * z + x * w) * s[1], 0,
    2 * (x * z + y * w) * s[2], 2 * (y * z - x * w) * s[2], (1 - 2 * (x * x + y * y)) * s[2], 0,
    t[0], t[1], t[2], 1,
  ];
}
function mm(a, b) {
  const r = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let k = 0; k < 4; k++) for (let q = 0; q < 4; q++) r[c * 4 + q] += a[k * 4 + q] * b[c * 4 + k];
  return r;
}
function worldM(i) {
  let m = localM(gltf.nodes[i]);
  for (let p = parent[i]; p != null; p = parent[p]) m = mm(localM(gltf.nodes[p]), m);
  return m;
}
const tp = (m, v) => [0, 1, 2].map((r) => m[r] * v[0] + m[4 + r] * v[1] + m[8 + r] * v[2] + m[12 + r]);
const boxes = [];
gltf.nodes.forEach((n, i) => {
  if (n.mesh == null) return;
  const a = gltf.accessors[gltf.meshes[n.mesh].primitives[0].attributes.POSITION];
  const m = worldM(i);
  const lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
  for (let k = 0; k < 8; k++) {
    const p = tp(m, [k & 1 ? a.max[0] : a.min[0], k & 2 ? a.max[1] : a.min[1], k & 4 ? a.max[2] : a.min[2]]);
    for (let c = 0; c < 3; c++) { lo[c] = Math.min(lo[c], p[c]); hi[c] = Math.max(hi[c], p[c]); }
  }
  boxes.push({ name: n.name, lo, hi });
});
const nodeBox = (name) => boxes.find((b) => b.name === name);

/* ------------------------------------------------------------------ */
/* Geometri üreticileri (konum, normal, indis)                         */
/* ------------------------------------------------------------------ */
class Geo {
  constructor() { this.p = []; this.n = []; this.i = []; }
  get count() { return this.p.length / 3; }
  v(p, n) { this.p.push(...p); this.n.push(...n); return this.count - 1; }
  tri(a, b, c) { this.i.push(a, b, c); }
}

/** Dirsekli boru merkez çizgisi: köşeler yay ile yuvarlatılır */
function filletPath(pts, rb) {
  const out = [pts[0]];
  for (let k = 1; k < pts.length - 1; k++) {
    const a = pts[k - 1], b = pts[k], c = pts[k + 1];
    const d0 = norm(sub(b, a)), d1 = norm(sub(c, b));
    const cosT = FLclamp(dot(d0, d1), -1, 1);
    const theta = Math.acos(cosT);
    if (theta < 1e-4) { out.push(b); continue; }
    const r = Array.isArray(rb) ? rb[k - 1] : rb;
    const tlen = r * Math.tan(theta / 2);
    if (tlen > len(sub(b, a)) * 0.999 || tlen > len(sub(c, b)) * 0.999) throw new Error('Dirsek yarıçapı segmentten uzun: köşe ' + k);
    const s0 = sub(b, mul(d0, tlen)), s1 = add(b, mul(d1, tlen));
    // Yay merkezi: s0'dan, d0'a dik ve büküm düzleminde r uzaklıkta
    const nrm = norm(sub(d1, mul(d0, cosT)));
    const ctr = add(s0, mul(nrm, r));
    const steps = Math.max(6, Math.ceil(theta / (Math.PI / 24)));
    const u0 = sub(s0, ctr);
    const ax = norm(cross(d0, d1));
    for (let s = 0; s <= steps; s++) {
      const ang = (theta * s) / steps;
      // u0'ı ax çevresinde döndür (Rodrigues)
      const cs = Math.cos(ang), sn = Math.sin(ang);
      const u = add(add(mul(u0, cs), mul(cross(ax, u0), sn)), mul(ax, dot(ax, u0) * (1 - cs)));
      out.push(add(ctr, u));
    }
    void s1;
  }
  out.push(pts[pts.length - 1]);
  return out;
}
function FLclamp(x, a, b) { return Math.max(a, Math.min(b, x)); }

/** Boru: merkez çizgisi boyunca halkalar (paralel taşınan çerçeve) + uç kapakları */
function tube(g, centre, r, seg = 20, caps = true) {
  const n = centre.length;
  const tan = centre.map((p, k) => norm(sub(centre[Math.min(k + 1, n - 1)], centre[Math.max(k - 1, 0)])));
  let nx = anyPerp(tan[0]);
  const rings = [];
  for (let k = 0; k < n; k++) {
    if (k > 0) {
      // Paralel taşıma: önceki normali yeni teğete dik düzleme izdüşür
      nx = norm(sub(nx, mul(tan[k], dot(nx, tan[k]))));
    }
    const ny = cross(tan[k], nx);
    const ring = [];
    for (let s = 0; s < seg; s++) {
      const a = (2 * Math.PI * s) / seg;
      const d = add(mul(nx, Math.cos(a)), mul(ny, Math.sin(a)));
      ring.push(g.v(add(centre[k], mul(d, r)), d));
    }
    rings.push(ring);
  }
  for (let k = 0; k < n - 1; k++) {
    for (let s = 0; s < seg; s++) {
      const a = rings[k][s], b = rings[k][(s + 1) % seg], c = rings[k + 1][s], d = rings[k + 1][(s + 1) % seg];
      g.tri(a, b, c); g.tri(b, d, c);
    }
  }
  if (caps) {
    for (const [k, sgn] of [[0, -1], [n - 1, 1]]) {
      const t = mul(tan[k], sgn);
      const c = g.v(centre[k], t);
      const ring = rings[k].map((vi) => g.v(g.p.slice(vi * 3, vi * 3 + 3), t));
      for (let s = 0; s < seg; s++) {
        if (sgn > 0) g.tri(c, ring[s], ring[(s + 1) % seg]);
        else g.tri(c, ring[(s + 1) % seg], ring[s]);
      }
    }
  }
}

/** Eksen boyunca silindir (flanş, geçiş bileziği, çek valf gövdesi) */
function cylinder(g, centre, axis, r, length, seg = 24) {
  const t = norm(axis);
  tube(g, [sub(centre, mul(t, length / 2)), add(centre, mul(t, length / 2))], r, seg, true);
}

/** Boru halkası (kelepçe): iç ve dış yüzey + yan yüzler */
function ringClamp(g, centre, axis, rIn, rOut, width, seg = 24) {
  const t = norm(axis), nx = anyPerp(t), ny = cross(t, nx);
  const h = width / 2;
  const layers = [[rOut, -h], [rOut, h], [rIn, h], [rIn, -h]];
  const normals = [(d) => d, (d) => d, (d) => mul(d, -1), (d) => mul(d, -1)];
  const faceIdx = [];
  // Dört yüz: dış silindir, üst halka, iç silindir, alt halka (keskin kenar için ayrı köşeler)
  const faces = [[0, 1, 'side', 1], [1, 2, 'cap', 1], [2, 3, 'side', -1], [3, 0, 'cap', -1]];
  for (const [la, lb, kind, sg] of faces) {
    const A = [], B = [];
    for (let s = 0; s < seg; s++) {
      const a = (2 * Math.PI * s) / seg;
      const d = add(mul(nx, Math.cos(a)), mul(ny, Math.sin(a)));
      const nA = kind === 'side' ? normals[la](d) : mul(t, sg);
      const pa = add(add(centre, mul(d, layers[la][0])), mul(t, layers[la][1]));
      const pb = add(add(centre, mul(d, layers[lb][0])), mul(t, layers[lb][1]));
      A.push(g.v(pa, nA)); B.push(g.v(pb, nA));
    }
    for (let s = 0; s < seg; s++) {
      const s1 = (s + 1) % seg;
      g.tri(A[s], B[s], A[s1]); g.tri(A[s1], B[s], B[s1]);
    }
    faceIdx.push(A, B);
  }
  void faceIdx;
}

/** Eksenlere hizalı kutu (bağlantı bloğu, kelepçe ayağı, perde plakası) */
function box(g, lo, hi) {
  const F = [
    [[1, 0, 0], [[hi[0], lo[1], lo[2]], [hi[0], hi[1], lo[2]], [hi[0], hi[1], hi[2]], [hi[0], lo[1], hi[2]]]],
    [[-1, 0, 0], [[lo[0], lo[1], hi[2]], [lo[0], hi[1], hi[2]], [lo[0], hi[1], lo[2]], [lo[0], lo[1], lo[2]]]],
    [[0, 1, 0], [[lo[0], hi[1], lo[2]], [lo[0], hi[1], hi[2]], [hi[0], hi[1], hi[2]], [hi[0], hi[1], lo[2]]]],
    [[0, -1, 0], [[lo[0], lo[1], hi[2]], [lo[0], lo[1], lo[2]], [hi[0], lo[1], lo[2]], [hi[0], lo[1], hi[2]]]],
    [[0, 0, 1], [[hi[0], lo[1], hi[2]], [hi[0], hi[1], hi[2]], [lo[0], hi[1], hi[2]], [lo[0], lo[1], hi[2]]]],
    [[0, 0, -1], [[lo[0], lo[1], lo[2]], [lo[0], hi[1], lo[2]], [hi[0], hi[1], lo[2]], [hi[0], lo[1], lo[2]]]],
  ];
  for (const [n, q] of F) {
    const a = g.v(q[0], n), b = g.v(q[1], n), c = g.v(q[2], n), d = g.v(q[3], n);
    g.tri(a, b, c); g.tri(a, c, d);
  }
}
const boxC = (g, c, h) => box(g, sub(c, h), add(c, h));

/* ------------------------------------------------------------------ */
/* Ölçüler (kaynak modelden okunur)                                    */
/* ------------------------------------------------------------------ */
const main = nodeBox('Kabin_O2_Hatti');                       // ana hat: kare kesit 36 mm
const yMain = -0.70, zMain = -1.60, xAft = main.hi[0];          // 4,40
const inlet = nodeBox('Boru_Giris');                            // vana girişi, r = 12 mm, z boyunca
const outlet = nodeBox('Boru_Cikis');                           // vana çıkışı, yukarı
const sfog = nodeBox('Oksijen_Cikis_Borusu');                   // SFOG çıkışı, r = 8 mm, yukarı
const panel = nodeBox('Kabin_Basinc_O2_Paneli');
const R = 0.012;                                                // vana boruları
const RS = 0.008;                                               // SFOG borusu
const xV = 0.5 * (inlet.lo[0] + inlet.hi[0]);                   // 4,40
const yIn = 0.5 * (inlet.lo[1] + inlet.hi[1]);                  // 0,12
const zIn = inlet.hi[2];                                        // 0,23 (giriş borusunun ucu)
const zOut = outlet.lo[2] + R;                                  // çıkış borusunun ekseni
const yOut = outlet.hi[1];                                      // 0,37
const xS = sfog.hi[0] - RS, zS = 0.5 * (sfog.lo[2] + sfog.hi[2]), yS = sfog.hi[1];
const yUnder = -0.55;                                           // döşeme altı güzergâh yüksekliği
const zRise = zIn + 0.07;                                       // yükselticinin z konumu
const ySf = -0.20;                                              // SFOG kolu: su tanklarının ve nem ayırıcının üstünden

const routes = {
  // 1) Ana hat arka ucu → döşeme altında +z → döşemeden yukarı → vana girişi
  supply: { r: R, rb: [0.045, 0.045, 0.03], pts: [[xV, yMain, zMain], [xV, yUnder, zMain], [xV, yUnder, zRise], [xV, yIn, zRise], [xV, yIn, zIn - 0.004]] },
  // 2) Vana çıkışı → yukarı → hava kilidi kapağının yanından → O₂ paneline
  panel: { r: R, rb: [0.03, 0.03, 0.022, 0.022], pts: [[xV, yOut - 0.004, zOut], [xV, 0.43, zOut], [xV, 0.43, -0.56], [xV, 1.50, -0.56], [4.45, 1.50, -0.56], [4.45, panel.lo[1] + 0.004, -0.56]] },
  // 3) SFOG çıkışı → ateşleyicinin üstünden → döşemeden aşağı → vana besleme yükselticisine (T)
  sfog: { r: RS, rb: [0.025, 0.035, 0.035, 0.035], pts: [[xS, yS - 0.003, zS], [xS, 0.40, zS], [3.0, 0.40, zS], [3.0, ySf, zS], [3.0, ySf, zRise], [xV - R + 0.003, ySf, zRise]] },
  // 4) Ana hat ön yükselticisi → ön perde geçişi
  fwd: { r: R, rb: [0.025], pts: [[0.40, -0.115, zMain], [0.40, -0.08, zMain], [-0.02, -0.08, zMain]] },
  // 5) Arka perde geçişi (PRSD O₂ besleme) → ana hat arka ucu
  aft: { r: R, rb: [], pts: [[xV, yMain, zMain], [4.52, yMain, zMain]] },
};

/* ------------------------------------------------------------------ */
/* Çakışma denetimi                                                    */
/* ------------------------------------------------------------------ */
// Bilerek temas eden parçalar (bağlanılan borular, geçilen döşeme/perde, hacimler)
const allowed = {
  supply: ['Kabin_O2_Hatti', 'Boru_Giris', 'Flans_Giris', 'Orta_Guverte_Zemini', 'Alt_Bolme_Tabani'],
  panel: ['Boru_Cikis', 'Flans_Cikis', 'Kabin_Basinc_O2_Paneli'],
  sfog: ['Oksijen_Cikis_Borusu', 'Orta_Guverte_Zemini', 'Kartus_Govde'],
  fwd: ['Kabin_O2_Hatti', 'On_Perde'],
  aft: ['Kabin_O2_Hatti', 'Arka_Perde'],
};
const volumes = /^Hava_/;
let clash = 0;
const centres = {};
for (const [id, rt] of Object.entries(routes)) {
  const c = rt.pts.length > 2 ? filletPath(rt.pts, rt.rb) : rt.pts;
  centres[id] = c;
  for (let k = 0; k < c.length - 1; k++) {
    const a = c[k], b = c[k + 1];
    const L = len(sub(b, a));
    const n = Math.max(1, Math.ceil(L / 0.005));
    for (let s = 0; s <= n; s++) {
      const p = add(a, mul(sub(b, a), s / n));
      for (const bx of boxes) {
        if (volumes.test(bx.name) || allowed[id].includes(bx.name)) continue;
        if (p[0] + rt.r > bx.lo[0] && p[0] - rt.r < bx.hi[0] && p[1] + rt.r > bx.lo[1] && p[1] - rt.r < bx.hi[1] && p[2] + rt.r > bx.lo[2] && p[2] - rt.r < bx.hi[2]) {
          if (clash < 20) console.log('Çakışma', id, bx.name, p.map((v) => v.toFixed(3)).join(', '));
          clash++;
        }
      }
    }
  }
}
if (clash) { console.error(clash + ' çakışma: güzergâhları düzeltin.'); process.exit(2); }

/* ------------------------------------------------------------------ */
/* Parçalar                                                            */
/* ------------------------------------------------------------------ */
const matIdx = (name) => {
  const i = gltf.materials.findIndex((m) => m.name === name);
  if (i < 0) throw new Error('Malzeme yok: ' + name);
  return i;
};
const M_O2 = matIdx('Seviye_3_Yuksek');
const M_INERT = matIdx('Seviye_0_Yanmaz');
const M_PTFE = matIdx('Seviye_1_Dusuk');
const O2 = { yanicilik_seviyesi: 3, yanicilik_etiketi: 'Yuksek', malzeme: 'Paslanmaz (O2 tasir)', sim_sinifi: 'oksijen_hatti' };
const AL = { yanicilik_seviyesi: 0, yanicilik_etiketi: 'Yanmaz', malzeme: 'Al', sim_sinifi: 'inert_metal' };
const SS = { yanicilik_seviyesi: 0, yanicilik_etiketi: 'Yanmaz', malzeme: 'Paslanmaz celik', sim_sinifi: 'inert_metal' };
const BR = { yanicilik_seviyesi: 0, yanicilik_etiketi: 'Yanmaz', malzeme: 'Pirinc', sim_sinifi: 'inert_metal' };
const PTFE = { yanicilik_seviyesi: 1, yanicilik_etiketi: 'Dusuk', malzeme: 'PTFE', sim_sinifi: 'polimer_conta' };

const parts = [];
function part(name, mat, extras, build) {
  const g = new Geo();
  build(g);
  parts.push({ name, mat, extras: Object.assign({ eklenen: 'o2-baglanti' }, extras), g });
}

// Borular
part('O2_Besleme_Yukselticisi', M_O2, O2, (g) => tube(g, centres.supply, R));
part('O2_Panel_Hatti', M_O2, O2, (g) => tube(g, centres.panel, R));
part('SFOG_O2_Hatti', M_O2, O2, (g) => tube(g, centres.sfog, RS, 16));
part('O2_On_Perde_Hatti', M_O2, O2, (g) => tube(g, centres.fwd, R));
part('O2_Arka_Perde_Hatti', M_O2, O2, (g) => tube(g, centres.aft, R));

// Ana hat uçlarındaki bağlantı blokları (kare kesitli hattı yuvarlak boruya geçirir)
part('O2_Arka_Dirsek_Blogu', M_INERT, SS, (g) => boxC(g, [xV - 0.006, yMain, zMain], [0.026, 0.026, 0.026]));
part('O2_On_Dirsek_Blogu', M_INERT, SS, (g) => boxC(g, [0.40, -0.09, zMain], [0.024, 0.024, 0.024]));
part('SFOG_T_Baglanti', M_INERT, SS, (g) => {
  cylinder(g, [xV, ySf, zRise], [0, 1, 0], 0.018, 0.05);
  cylinder(g, [xV - 0.022, ySf, zRise], [1, 0, 0], 0.013, 0.024);
});

// Vana uçlarına rakor (somun + PTFE conta): mevcut borulara oturan kısa bilezik
part('Vana_Giris_Rakoru', M_INERT, BR, (g) => cylinder(g, [xV, yIn, zIn - 0.012], [0, 0, 1], 0.017, 0.022, 6));
part('Vana_Giris_Contasi', M_PTFE, PTFE, (g) => cylinder(g, [xV, yIn, zIn - 0.0245], [0, 0, 1], 0.0175, 0.003));
part('Vana_Cikis_Rakoru', M_INERT, BR, (g) => cylinder(g, [xV, yOut - 0.012, zOut], [0, 1, 0], 0.017, 0.022, 6));
part('Vana_Cikis_Contasi', M_PTFE, PTFE, (g) => cylinder(g, [xV, yOut - 0.0245, zOut], [0, 1, 0], 0.0175, 0.003));
part('SFOG_Cikis_Rakoru', M_INERT, BR, (g) => cylinder(g, [xS, yS - 0.008, zS], [0, 1, 0], 0.012, 0.016, 6));

// Döşeme geçişleri (bilezik, döşemenin üstünde ve altında)
const floorTop = 0, floorBot = -0.05;
for (const [nm, x, z, r] of [['Doseme_Gecisi_Vana', xV, zRise, R], ['Doseme_Gecisi_SFOG', 3.0, zS, RS]]) {
  part(nm + '_Ust', M_INERT, AL, (g) => ringClamp(g, [x, floorTop + 0.004, z], [0, 1, 0], r, r + 0.012, 0.008));
  part(nm + '_Alt', M_INERT, AL, (g) => ringClamp(g, [x, floorBot - 0.004, z], [0, 1, 0], r, r + 0.012, 0.008));
}

// Perde geçişleri: flanş plakası + bilezik
part('Arka_Perde_O2_Gecisi', M_INERT, Object.assign({}, SS, { not: 'PRSD O2 tanklarindan besleme' }), (g) => {
  box(g, [4.494, yMain - 0.035, zMain - 0.035], [4.5, yMain + 0.035, zMain + 0.035]);
  cylinder(g, [4.484, yMain, zMain], [1, 0, 0], 0.02, 0.02);
});
part('On_Perde_O2_Gecisi', M_INERT, Object.assign({}, SS, { not: 'Ucus guvertesi kask O2 hattina' }), (g) => {
  box(g, [0, -0.08 - 0.03, zMain - 0.03], [0.006, -0.08 + 0.03, zMain + 0.03]);
  cylinder(g, [0.016, -0.08, zMain], [1, 0, 0], 0.02, 0.02);
});

// Panel girişi: panel altına vidalı geçiş
part('O2_Panel_Gecisi', M_INERT, SS, (g) => {
  box(g, [4.425, panel.lo[1] - 0.006, -0.585], [4.475, panel.lo[1], -0.535]);
  cylinder(g, [4.45, panel.lo[1] - 0.016, -0.56], [0, 1, 0], 0.018, 0.02, 6);
});

// SFOG hattında çek valf: kabin hattından SFOG'a geri akışı önler
part('SFOG_Cek_Valfi', M_INERT, Object.assign({}, BR, { not: 'Geri akis onleyici' }), (g) => {
  cylinder(g, [3.7, ySf, zRise], [1, 0, 0], 0.016, 0.06);
  cylinder(g, [3.66, ySf, zRise], [1, 0, 0], 0.012, 0.018, 6);
  cylinder(g, [3.74, ySf, zRise], [1, 0, 0], 0.012, 0.018, 6);
});

// Duvar kelepçeleri: arka perdeye (x = 4,50) uzanan ayaklı halkalar
const clampsAft = [[yUnder, -1.0], [yUnder, -0.2], [0.8, -0.56], [1.2, -0.56]];
clampsAft.forEach(([y, z], k) => {
  const vertical = y > 0;
  const axis = vertical ? [0, 1, 0] : [0, 0, 1];
  part('O2_Kelepce_' + (k + 1), M_INERT, AL, (g) => {
    ringClamp(g, [xV, y, z], axis, R, R + 0.004, 0.014);
    box(g, [xV + R + 0.002, y - 0.006, z - 0.006], [4.5, y + 0.006, z + 0.006]);
  });
});
// SFOG hattı: yan duvara (z = 2,00) ve döşemenin altına asılı kelepçeler
[[3.0, 0.2, zS, [0, 1, 0]], [3.0, ySf, 1.2, [0, 0, 1]], [3.0, ySf, 0.7, [0, 0, 1]], [3.4, ySf, zRise, [1, 0, 0]], [4.1, ySf, zRise, [1, 0, 0]]].forEach(([x, y, z, axis], k) => {
  part('SFOG_Kelepce_' + (k + 1), M_INERT, AL, (g) => {
    ringClamp(g, [x, y, z], axis, RS, RS + 0.004, 0.012);
    if (axis[1] === 1) box(g, [x - 0.005, y - 0.005, z + RS + 0.002], [x + 0.005, y + 0.005, 2.0]);
    else box(g, [x - 0.005, y + RS + 0.002, z - 0.005], [x + 0.005, floorBot, z + 0.005]);
  });
});

/* ------------------------------------------------------------------ */
/* GLB'ye ekle ve yaz                                                   */
/* ------------------------------------------------------------------ */
function pushView(buf, target) {
  const pad = (4 - (bin.length % 4)) % 4;
  if (pad) bin = Buffer.concat([bin, Buffer.alloc(pad)]);
  const off = bin.length;
  bin = Buffer.concat([bin, buf]);
  gltf.bufferViews.push({ buffer: 0, byteOffset: off, byteLength: buf.length, target });
  return gltf.bufferViews.length - 1;
}
const childIdx = [];
for (const p of parts) {
  const pos = new Float32Array(p.g.p), nor = new Float32Array(p.g.n);
  const big = p.g.count > 65535;
  const idx = big ? new Uint32Array(p.g.i) : new Uint16Array(p.g.i);
  const lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
  for (let k = 0; k < pos.length; k += 3) for (let c = 0; c < 3; c++) { lo[c] = Math.min(lo[c], pos[k + c]); hi[c] = Math.max(hi[c], pos[k + c]); }
  const vP = pushView(Buffer.from(pos.buffer), 34962);
  const vN = pushView(Buffer.from(nor.buffer), 34962);
  const vI = pushView(Buffer.from(idx.buffer), 34963);
  const aP = gltf.accessors.push({ bufferView: vP, componentType: 5126, count: p.g.count, type: 'VEC3', min: lo, max: hi }) - 1;
  const aN = gltf.accessors.push({ bufferView: vN, componentType: 5126, count: p.g.count, type: 'VEC3' }) - 1;
  const aI = gltf.accessors.push({ bufferView: vI, componentType: big ? 5125 : 5123, count: p.g.i.length, type: 'SCALAR' }) - 1;
  const mesh = gltf.meshes.push({ name: p.name, primitives: [{ attributes: { POSITION: aP, NORMAL: aN }, indices: aI, material: p.mat }] }) - 1;
  childIdx.push(gltf.nodes.push({ name: p.name, mesh, extras: p.extras }) - 1);
}
const group = gltf.nodes.push({ name: 'O2_Baglantilari', children: childIdx, extras: { aciklama: 'Bos kalan O2 uclarini baglayan borular (tools/o2-baglanti.mjs)' } }) - 1;
const root = gltf.scenes[0].nodes[0];
gltf.nodes[root].children.push(group);
gltf.buffers[0].byteLength = bin.length;

let json = Buffer.from(JSON.stringify(gltf), 'utf8');
if (json.length % 4) json = Buffer.concat([json, Buffer.alloc(4 - (json.length % 4), 0x20)]);
if (bin.length % 4) bin = Buffer.concat([bin, Buffer.alloc(4 - (bin.length % 4))]);
const header = Buffer.alloc(12);
header.writeUInt32LE(0x46546c67, 0);
header.writeUInt32LE(2, 4);
header.writeUInt32LE(12 + 8 + json.length + 8 + bin.length, 8);
const jh = Buffer.alloc(8); jh.writeUInt32LE(json.length, 0); jh.writeUInt32LE(0x4e4f534a, 4);
const bh = Buffer.alloc(8); bh.writeUInt32LE(bin.length, 0); bh.writeUInt32LE(0x004e4942, 4);
fs.writeFileSync(OUT, Buffer.concat([header, jh, json, bh, bin]));
console.log(parts.length + ' parça eklendi → ' + path.relative(process.cwd(), OUT) + ' (' + (fs.statSync(OUT).size / 1024).toFixed(0) + ' KB)');
for (const [id, c] of Object.entries(centres)) {
  let L = 0;
  for (let k = 0; k < c.length - 1; k++) L += len(sub(c[k + 1], c[k]));
  console.log('  ' + id + ': ' + (L * 100).toFixed(0) + ' cm');
}
