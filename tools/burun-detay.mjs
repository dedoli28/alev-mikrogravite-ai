/* =====================================================================
 * Mekik kabini: burun bölümü ve eğimli 6 camlı kokpit çatısı
 * ---------------------------------------------------------------------
 * Kaynak modelde ön duvar düz bir plakaydı, altı pencere de plakaya
 * yapıştırılmış düz levhalardı. Gerçek Orbiter'ın ön gövdesine göre:
 *
 *   • BURUN GÖVDESİ (x = -2,30 … 0 m): ön perdeden öne doğru incelen,
 *     süper elips kesitli, küt burunlu gövde. Uç: takviyeli karbon-karbon
 *     (RCC) burun başlığı; karın: siyah silika karo (HRSI); üst: beyaz
 *     karo (LRSI). Karo derzleri, ön iniş takımı kapısı çizgisi, 14 ön
 *     RCS itici portu.
 *   • KOKPİT ÇATISI: uçuş güvertesinin önünde, kaş çizgisinden (y = 3,03)
 *     tavana (y = 3,60) yükselen, planda "V" biçiminde kıvrılan altı
 *     eğimli cam: ortada iki büyük ön cam (3, 4), yanlarda iki ön-yan
 *     cam (2, 5), uçlarda iki yan cam (1, 6). Camlar çerçeve plakasının
 *     önünde 8 mm içeride durur; dikmeler ve profiller çıkıntılıdır.
 *   • Sol duvar, çatının altına kadar kırpılır (çatı ile çakışmasın).
 *
 * Başarım: yaklaşık 6 bin üçgen (kabin toplamı 23,7 bin). Burun gövdesi
 * "sdf: false" işaretlidir: uzaklık alanı ızgarasına girmez, kabin içi
 * gölge çözünürlüğü değişmez. Çatı parçaları "kesit" işaretlidir: kamera
 * kabinin üstüne çıkınca gizlenir (tavan zaten çizilmez), kabin içi
 * görünür kalır.
 *
 * Kullanım (sıra önemli):
 *   node tools/o2-baglanti.mjs   # kaynak model → O₂ bağlantıları
 *   node tools/burun-detay.mjs   # üzerine burun + camlar
 * ===================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(here, '..', 'src', 'assets', 'models', 'mekik_kabini.glb');

/* ------------------------------------------------------------------ */
/* GLB okuma                                                           */
/* ------------------------------------------------------------------ */
const file = fs.readFileSync(FILE);
const jsonLen = file.readUInt32LE(12);
const gltf = JSON.parse(file.subarray(20, 20 + jsonLen).toString('utf8'));
const binLen = file.readUInt32LE(20 + jsonLen);
let bin = Buffer.from(file.subarray(28 + jsonLen, 28 + jsonLen + binLen));

if (gltf.nodes.some((n) => n.name === 'Burun_Kismi')) {
  console.error('Model zaten burun bölümünü içeriyor. Önce `node tools/o2-baglanti.mjs` ile kaynağı yeniden üretin.');
  process.exit(1);
}
if (!gltf.nodes.some((n) => n.name === 'O2_Baglantilari')) {
  console.error('Önce `node tools/o2-baglanti.mjs` çalıştırın (burun, O₂ bağlantılı modelin üzerine eklenir).');
  process.exit(1);
}

/* ------------------------------------------------------------------ */
/* Vektör yardımcıları                                                  */
/* ------------------------------------------------------------------ */
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => mul(a, 1 / (len(a) || 1));
const lerp = (a, b, t) => add(mul(a, 1 - t), mul(b, t));
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const sgnPow = (v, e) => Math.sign(v) * Math.pow(Math.abs(v), e);

class Geo {
  constructor() { this.p = []; this.n = []; this.i = []; }
  get count() { return this.p.length / 3; }
  v(p, n) { this.p.push(p[0], p[1], p[2]); this.n.push(n[0], n[1], n[2]); return this.count - 1; }
  tri(a, b, c) { this.i.push(a, b, c); }
  quad(a, b, c, d) { this.tri(a, b, c); this.tri(a, c, d); }
  /** Düz gölgeli dörtgen (köşe sırası çevresel) */
  flatQuad(P, n) {
    const q = P.map((p) => this.v(p, n));
    this.quad(q[0], q[1], q[2], q[3]);
  }
  /** Düz gölgeli üçgen */
  flatTri(a, b, c) {
    const n = norm(cross(sub(b, a), sub(c, a)));
    this.tri(this.v(a, n), this.v(b, n), this.v(c, n));
  }
}

/** Çokgen üçgenleme (kulak kesme, basit çokgen, 2B) → indis üçlüleri */
function earClip(poly) {
  const n = poly.length;
  let area = 0;
  for (let i = 0; i < n; i++) { const a = poly[i], b = poly[(i + 1) % n]; area += a[0] * b[1] - b[0] * a[1]; }
  const idx = [...Array(n).keys()];
  if (area < 0) idx.reverse();
  const cr = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const inTri = (p, a, b, c) => cr(a, b, p) >= -1e-12 && cr(b, c, p) >= -1e-12 && cr(c, a, p) >= -1e-12;
  const out = [];
  let guard = 0;
  while (idx.length > 3 && guard++ < 10000) {
    let cut = false;
    for (let k = 0; k < idx.length; k++) {
      const i0 = idx[(k + idx.length - 1) % idx.length], i1 = idx[k], i2 = idx[(k + 1) % idx.length];
      const a = poly[i0], b = poly[i1], c = poly[i2];
      if (cr(a, b, c) <= 1e-12) continue;
      let ok = true;
      for (const j of idx) {
        if (j === i0 || j === i1 || j === i2) continue;
        if (inTri(poly[j], a, b, c)) { ok = false; break; }
      }
      if (!ok) continue;
      out.push([i0, i1, i2]);
      idx.splice(k, 1);
      cut = true;
      break;
    }
    if (!cut) throw new Error('Çokgen üçgenlenemedi');
  }
  out.push([idx[0], idx[1], idx[2]]);
  return out;
}

/**
 * Çokgen levha: poly (u,v) → toXYZ(u, v, t) ile 3B'ye taşınır, t0…t1 kalınlık.
 * Kapaklar ±eksen, yan yüzler dışa bakar.
 */
function slab(g, poly, toXYZ, t0, t1, axisN) {
  const tris = earClip(poly);
  const N0 = mul(axisN, -1), N1 = axisN;
  for (const [a, b, c] of tris) {
    g.flatTri(toXYZ(...poly[a], t1), toXYZ(...poly[b], t1), toXYZ(...poly[c], t1));
    g.flatTri(toXYZ(...poly[a], t0), toXYZ(...poly[c], t0), toXYZ(...poly[b], t0));
  }
  void N0; void N1;
  // Yan yüzler: dışa bakan yön, çokgenin ağırlık merkezinden uzağa
  let cu = 0, cv = 0;
  for (const p of poly) { cu += p[0]; cv += p[1]; }
  const cen = toXYZ(cu / poly.length, cv / poly.length, (t0 + t1) / 2);
  for (let k = 0; k < poly.length; k++) {
    const a = poly[k], b = poly[(k + 1) % poly.length];
    const P = [toXYZ(...a, t0), toXYZ(...b, t0), toXYZ(...b, t1), toXYZ(...a, t1)];
    let n = norm(cross(sub(P[1], P[0]), sub(P[3], P[0])));
    const mid = mul(add(P[0], P[2]), 0.5);
    if (dot(n, sub(mid, cen)) < 0) n = mul(n, -1);
    g.flatQuad(P, n);
  }
}

/** Dikdörtgen kesitli kiriş (a → b), 'up' yönünde yükseklik, yanlara genişlik */
function beam(g, a, b, up, wid, hgt) {
  const d = norm(sub(b, a));
  let s = cross(d, up);
  if (len(s) < 1e-6) s = cross(d, [1, 0, 0]);
  s = norm(s);
  const u = norm(cross(s, d));
  const hw = wid / 2, hh = hgt / 2;
  const C = [];
  for (const [sx, uy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) C.push([mul(s, sx * hw), mul(u, uy * hh)]);
  const ring = (p) => C.map(([ds, du]) => add(p, add(ds, du)));
  const A = ring(a), B = ring(b);
  const faceN = [mul(u, -1), s, u, mul(s, -1)];
  for (let k = 0; k < 4; k++) g.flatQuad([A[k], A[(k + 1) % 4], B[(k + 1) % 4], B[k]], faceN[k]);
  g.flatQuad([A[3], A[2], A[1], A[0]], mul(d, -1));
  g.flatQuad([B[0], B[1], B[2], B[3]], d);
}

/* ------------------------------------------------------------------ */
/* Burun gövdesi: süper elips kesitli ardışık halkalar                  */
/* ------------------------------------------------------------------ */
const XT = -3.20, LN = 3.20;               // burun ucu ve uzunluğu
const Y_TIP = 0.90, Y_TOP = 3.04, Y_BOT = -0.95;
const A_HALF = 2.07;                       // taban yarı genişliği (duvarın dış yüzü + 8 mm)
const N_RING = 72, N_ST = 34;

/** s ∈ [0,1] (uçtan tabana) → kesit parametreleri */
function sect(s) {
  const top = Y_TIP + (Y_TOP - Y_TIP) * Math.pow(s, 0.8);                  // üst çizgi: neredeyse doğrusal yükselen kaş
  const bot = Y_TIP + (Y_BOT - Y_TIP) * (1 - Math.pow(1 - s, 1.8));        // alt çizgi: tabanda yatay
  const a = A_HALF * Math.pow(1 - Math.pow(1 - s, 2.0), 0.9);              // plan: küt uç, tabanda duvara teğet
  const p = 2 + 3 * Math.pow(s, 1.5);                                      // elips → yuvarlatılmış dikdörtgen
  return { yc: (top + bot) / 2, b: (top - bot) / 2, a, p };
}
function surf(s, th) {
  const S = sect(clamp01(s));
  const e = 2 / S.p;
  return [XT + LN * clamp01(s), S.yc + S.b * sgnPow(Math.sin(th), e), S.a * sgnPow(Math.cos(th), e)];
}
function surfN(s, th) {
  const ds = 1e-3, dt = 1e-3;
  const sa = Math.min(1, s + ds), sb = Math.max(0, s - ds);
  const dS = sub(surf(sa, th), surf(sb, th));
  const dT = sub(surf(s, th + dt), surf(s, th - dt));
  let n = norm(cross(dT, dS));
  // Dışa bakan: halka merkezinden uzağa
  const S = sect(s), c = [XT + LN * s, S.yc, 0];
  if (dot(n, sub(surf(s, th), c)) < 0) n = mul(n, -1);
  return n;
}

// Izgara: köşe konumları ve (komşu üçgenlerden) yumuşak normaller
const stS = [];
for (let k = 0; k < N_ST; k++) stS.push(Math.pow(k / (N_ST - 1), 1.35));
const gridP = [], gridY = [];
for (let k = 0; k < N_ST; k++) {
  const row = [];
  for (let i = 0; i < N_RING; i++) row.push(surf(stS[k], (2 * Math.PI * i) / N_RING));
  gridP.push(row);
}
const gridN = gridP.map((r) => r.map(() => [0, 0, 0]));
for (let k = 0; k < N_ST - 1; k++) {
  for (let i = 0; i < N_RING; i++) {
    const i1 = (i + 1) % N_RING;
    const a = gridP[k][i], b = gridP[k][i1], c = gridP[k + 1][i], d = gridP[k + 1][i1];
    for (const [t0, t1, t2, n0, n1, n2] of [[a, b, c, [k, i], [k, i1], [k + 1, i]], [b, d, c, [k, i1], [k + 1, i1], [k + 1, i]]]) {
      const fn = cross(sub(t1, t0), sub(t2, t0));
      for (const [kk, ii] of [n0, n1, n2]) gridN[kk][ii] = add(gridN[kk][ii], fn);
    }
  }
}
for (let k = 0; k < N_ST; k++) for (let i = 0; i < N_RING; i++) {
  let n = norm(gridN[k][i]);
  const S = sect(stS[k]), c = [XT + LN * stS[k], S.yc, 0];
  if (k === 0 || dot(n, sub(gridP[k][i], c)) < 0) {
    // uç noktasında ya da ters yönlü: elle dışa bakan
    n = k === 0 ? [-1, 0, 0] : mul(n, -1);
  }
  gridN[k][i] = n;
}

const S_CAP = 0.55 / LN;                     // RCC başlık: uçtan 55 cm
/** Halka noktası karın bölgesinde mi (siyah karo)? */
const isBelly = (k, i) => {
  const S = sect(stS[k]);
  return gridP[k][i][1] < S.yc - 0.12 * S.b;
};
/** Izgaranın seçilen dörtgenlerinden parça üretir */
function hullPart(filter) {
  const g = new Geo();
  const map = new Map();
  const vid = (k, i) => {
    const key = k * N_RING + i;
    if (!map.has(key)) map.set(key, g.v(gridP[k][i], gridN[k][i]));
    return map.get(key);
  };
  for (let k = 0; k < N_ST - 1; k++) {
    for (let i = 0; i < N_RING; i++) {
      const i1 = (i + 1) % N_RING;
      if (!filter(k, i)) continue;
      const a = vid(k, i), b = vid(k, i1), c = vid(k + 1, i), d = vid(k + 1, i1);
      if (k === 0) g.tri(a, c, d);                     // uç halkası tek noktada birleşir
      else { g.tri(a, b, c); g.tri(b, d, c); }
    }
  }
  return g;
}
const capK = stS.findIndex((s) => s >= S_CAP);
const gHullCap = hullPart((k) => k < capK);
const gHullBelly = hullPart((k, i) => k >= capK && isBelly(k, i) && isBelly(k + 1, i) && isBelly(k, (i + 1) % N_RING));
const gHullTop = hullPart((k, i) => k >= capK && !(isBelly(k, i) && isBelly(k + 1, i) && isBelly(k, (i + 1) % N_RING)));

/* Yüzeye oturan şerit (derz, kapı çizgisi): (s, θ) noktaları */
function ribbon(g, pts, width, lift) {
  const P = [], Nn = [], W = [];
  for (const [s, th] of pts) {
    const n = surfN(s, th);
    P.push(add(surf(s, th), mul(n, lift))); Nn.push(n);
  }
  for (let k = 0; k < P.length; k++) {
    const t = norm(sub(P[Math.min(k + 1, P.length - 1)], P[Math.max(k - 1, 0)]));
    W.push(norm(cross(Nn[k], t)));
  }
  const L = [], R = [];
  for (let k = 0; k < P.length; k++) {
    L.push(g.v(add(P[k], mul(W[k], -width / 2)), Nn[k]));
    R.push(g.v(add(P[k], mul(W[k], width / 2)), Nn[k]));
  }
  for (let k = 0; k < P.length - 1; k++) { g.tri(L[k], R[k], L[k + 1]); g.tri(R[k], R[k + 1], L[k + 1]); }
}
const sOf = (x) => (x - XT) / LN;
const gSeams = new Geo();
for (const d of [0.9, 1.3, 1.7, 2.1, 2.5, 2.85]) {
  const pts = [];
  for (let i = 0; i <= 96; i++) pts.push([sOf(XT + d), (2 * Math.PI * i) / 96]);
  ribbon(gSeams, pts, 0.008, 0.004);
}
// Karın üzerinde iki boyuna derz
for (const dth of [-0.55, 0.55]) {
  const pts = [];
  for (let i = 0; i <= 30; i++) pts.push([sOf(XT + 0.6 + 2.5 * (i / 30)), 1.5 * Math.PI + dth]);
  ribbon(gSeams, pts, 0.008, 0.004);
}
// RCC birleşim halkası
const gCapRing = new Geo();
{
  const pts = [];
  for (let i = 0; i <= 96; i++) pts.push([S_CAP, (2 * Math.PI * i) / 96]);
  ribbon(gCapRing, pts, 0.03, 0.008);
}
// Ön iniş takımı kapısı: karın ortasında dikdörtgen çizgi
const gGear = new Geo();
{
  const x0 = XT + 1.0, x1 = XT + 2.1, dth = 0.12, c = 1.5 * Math.PI;
  const edge = (a, b) => { const pts = []; for (let i = 0; i <= 14; i++) pts.push([sOf(a[0] + (b[0] - a[0]) * (i / 14)), c + a[1] + (b[1] - a[1]) * (i / 14)]); return pts; };
  ribbon(gGear, edge([x0, -dth], [x1, -dth]), 0.02, 0.006);
  ribbon(gGear, edge([x0, dth], [x1, dth]), 0.02, 0.006);
  ribbon(gGear, edge([x0, -dth], [x0, dth]), 0.02, 0.006);
  ribbon(gGear, edge([x1, -dth], [x1, dth]), 0.02, 0.006);
  ribbon(gGear, edge([(x0 + x1) / 2, -dth], [(x0 + x1) / 2, dth]), 0.012, 0.006);
}
// Ön RCS itici portları: üstte 2×3, her yanda 2×2
const gRCS = new Geo();
{
  const ports = [];
  for (const d of [1.1, 1.5, 1.9]) for (const sg of [-1, 1]) ports.push([sOf(XT + d), Math.PI / 2 + sg * 0.12]);
  for (const side of [1, -1]) for (const d of [1.5, 1.9]) for (const dth of [0.20, 0.42]) {
    ports.push([sOf(XT + d), side > 0 ? dth : Math.PI - dth]);
  }
  for (const [s, th] of ports) {
    const n = surfN(s, th);
    const C = add(surf(s, th), mul(n, 0.004));
    let t = norm(sub(surf(Math.min(1, s + 0.002), th), surf(s, th)));
    t = norm(sub(t, mul(n, dot(t, n))));
    const w = cross(n, t);
    const R = 0.042, SEG = 14;
    const c0 = gRCS.v(C, n);
    const ring = [];
    for (let i = 0; i < SEG; i++) {
      const a = (2 * Math.PI * i) / SEG;
      ring.push(gRCS.v(add(C, add(mul(t, Math.cos(a) * R * 1.25), mul(w, Math.sin(a) * R))), n));
    }
    for (let i = 0; i < SEG; i++) gRCS.tri(c0, ring[i], ring[(i + 1) % SEG]);
  }
}

/* ------------------------------------------------------------------ */
/* Kokpit çatısı: altı eğimli cam                                       */
/* ------------------------------------------------------------------ */
const SILL_Y = 3.04, ROOF_Y = 3.60, RUN = 0.34, ZW = 2.06;
// Kaş çizgisi (x, z), z ≥ 0 yarısı. Güneş siperliği ve kontrol listesi gibi ön güverte parçaları x ≥ 0'da
// durduğu için ön cam hattı |z| ≤ 1,5 aralığında x ≈ 0 civarında kalır (ortada hafif ileri V); yalnız
// dış yan camlar geriye, duvara doğru sarılır.
const BH = [[-0.12, 0.0], [-0.04, 0.80], [0.04, 1.50], [0.56, ZW]];
// Her parçanın "yatay iç normali" (kabine ve geriye doğru) ve tavan kenarı
const e2 = (a, b) => { const d = [b[0] - a[0], b[1] - a[1]]; const l = Math.hypot(d[0], d[1]); return [d[0] / l, d[1] / l]; };
const lines = [];
for (let i = 0; i < 3; i++) {
  const e = e2(BH[i], BH[i + 1]);
  const nrm = [e[1], -e[0]];                       // x bileşeni > 0: geriye ve merkeze doğru
  lines.push({ p: [BH[i][0] + nrm[0] * RUN, BH[i][1] + nrm[1] * RUN], d: e });
}
const hitZ = (ln, z) => { const mu = (z - ln.p[1]) / ln.d[1]; return [ln.p[0] + ln.d[0] * mu, z]; };
const hitLn = (a, b) => {
  const det = a.d[0] * -b.d[1] - a.d[1] * -b.d[0];
  const rx = b.p[0] - a.p[0], rz = b.p[1] - a.p[1];
  const mu = (rx * -b.d[1] - rz * -b.d[0]) / det;
  return [a.p[0] + a.d[0] * mu, a.p[1] + a.d[1] * mu];
};
const TH = [hitZ(lines[0], 0), hitLn(lines[0], lines[1]), hitLn(lines[1], lines[2]), hitZ(lines[2], ZW)];
const B3 = (v, sgn) => [v[0], SILL_Y, sgn * v[1]];
const T3 = (v, sgn) => [v[0], ROOF_Y, sgn * v[1]];

// Facet i (0 merkez, 1 ön-yan, 2 yan), taraf sgn (+1 sol/+z, −1 sağ/−z)
const facets = [];
for (const sgn of [1, -1]) {
  for (let i = 0; i < 3; i++) {
    const c = [B3(BH[i], sgn), B3(BH[i + 1], sgn), T3(TH[i + 1], sgn), T3(TH[i], sgn)];
    let n = norm(cross(sub(c[1], c[0]), sub(c[3], c[0])));
    if (n[1] < 0) n = mul(n, -1);
    facets.push({ i, sgn, c, n });
  }
}
// Cam numaraları: 1 = +z yan, 2 = +z ön-yan, 3 = +z ön, 4 = −z ön, 5 = −z ön-yan, 6 = −z yan
const order = [[1, 2], [1, 1], [1, 0], [-1, 0], [-1, 1], [-1, 2]];
const facetOf = (sgn, i) => facets.find((f) => f.sgn === sgn && f.i === i);

const KESIT = { eksen: 1, taraf: 1, duzlem: 3.65 };
const inset = (c, w) => {
  const uLen = len(sub(c[1], c[0])), vLen = len(sub(c[3], c[0]));
  const u0 = w / uLen, v0 = w / vLen;
  const P = (u, v) => lerp(lerp(c[0], c[1], u), lerp(c[3], c[2], u), v);
  return [P(u0, v0), P(1 - u0, v0), P(1 - u0, 1 - v0), P(u0, 1 - v0)];
};

/* ------------------------------------------------------------------ */
/* Parçaları topla                                                      */
/* ------------------------------------------------------------------ */
const matIdx = (name) => {
  const i = gltf.materials.findIndex((m) => m.name === name);
  if (i < 0) throw new Error('Malzeme yok: ' + name);
  return i;
};
const M_GREY = matIdx('Yapi_Gri_Seviye0');
const M_DARK = matIdx('Seviye_0_Yanmaz_Koyu');
const inertEx = (malzeme, extra) => Object.assign({
  yanicilik_seviyesi: 0, yanicilik_etiketi: 'Yanmaz', malzeme, sim_sinifi: 'inert_metal', eklenen: 'burun-detay',
}, extra || {});
const HULL = (m) => inertEx(m, { sdf: false });
const CATI = (m) => inertEx(m, { kesit: KESIT });

const hullParts = [], catiParts = [];
const hp = (name, mat, ex, g) => hullParts.push({ name, mat, extras: ex, g });
const cp = (name, mat, ex, g) => catiParts.push({ name, mat, extras: ex, g });

hp('Burun_Kapagi_RCC', M_GREY, HULL('Karbon-karbon RCC burun basligi'), gHullCap);
hp('Burun_Govdesi_Karin', M_GREY, HULL('Seramik isi kalkani karosu HRSI'), gHullBelly);
hp('Burun_Govdesi_Ust', M_GREY, HULL('Beyaz isi kalkani karosu LRSI'), gHullTop);
hp('Burun_Karo_Derzleri', M_DARK, HULL('Seramik isi kalkani karosu HRSI'), gSeams);
hp('Burun_RCC_Birlesim_Halkasi', M_GREY, HULL('Karbon-karbon RCC burun basligi'), gCapRing);
hp('Burun_Tekerlek_Kapisi_Cizgisi', M_DARK, HULL('Seramik isi kalkani karosu HRSI'), gGear);
hp('Burun_RCS_Portlari', M_DARK, HULL('Karbon-karbon RCC burun basligi'), gRCS);

// Camlar ve çerçeve plakaları
order.forEach(([sgn, i], k) => {
  const f = facetOf(sgn, i);
  const gF = new Geo(), gG = new Geo();
  gF.flatQuad(f.c, f.n);
  gG.flatQuad(inset(f.c, 0.05).map((p) => add(p, mul(f.n, 0.008))), f.n);
  cp('On_Pencere_Cercevesi_' + (k + 1), M_GREY, CATI('Al 2219 cerceve'), gF);
  cp('On_Pencere_' + (k + 1), matIdx('Cam_' + k), CATI('Silika cam (3 kat)'), gG);
});

// Dikmeler: facet birleşimlerinde (kaş → tavan) çıkıntılı kirişler
const gPosts = new Geo();
for (const sgn of [1, -1]) for (let j = 0; j <= 3; j++) {
  if (j === 0 && sgn === -1) continue;               // merkez dikme tek
  const a = add(B3(BH[j], sgn), [0, 0.004, 0]), b = add(T3(TH[j], sgn), [0, 0, 0]);
  const fi = facetOf(sgn, Math.min(j, 2));
  const up = fi.n;
  beam(gPosts, add(a, mul(up, 0.012)), add(b, mul(up, 0.012)), up, 0.05, 0.024);
}
cp('Pencere_Dikmeleri', M_GREY, CATI('Al 2219 cerceve'), gPosts);
// Kaş (alt) ve tavan (üst) profilleri
const gSill = new Geo(), gRoof = new Geo();
for (const sgn of [1, -1]) for (let j = 0; j < 3; j++) {
  const fi = facetOf(sgn, j), up = fi.n;
  beam(gSill, add(B3(BH[j], sgn), mul(up, 0.012)), add(B3(BH[j + 1], sgn), mul(up, 0.012)), up, 0.07, 0.024);
  beam(gRoof, add(T3(TH[j], sgn), mul(up, 0.012)), add(T3(TH[j + 1], sgn), mul(up, 0.012)), up, 0.07, 0.024);
}
cp('Pencere_Kasi_Profili', M_GREY, CATI('Al 2219 cerceve'), gSill);
cp('Cati_On_Kenar_Profili', M_GREY, CATI('Al 2219 cerceve'), gRoof);

// Kaş rafı: ön perde ile cam altı arasındaki yatay levha (beyaz karo)
const gShelf = new Geo();
{
  // Çevre: (0,−ZW) → (0,+ZW) → kaş (+z yarısı, uçtan merkeze) → kaş (−z yarısı, merkezden uca)
  const plus = BH.slice().reverse();                   // z = ZW … 0
  const minus = BH.slice(1).map(([x, z]) => [x, -z]);  // z = −0,95 … −ZW
  const XF = -0.14, ZS = ZW + 0.015;                    // raf: önde 14 cm çıkıntılı kaş, duvarın üstünü örter
  const loop = [[XF, -ZS], [XF, ZS], [BH[3][0], ZS], ...plus.slice(1), ...minus.slice(0, 2), [BH[3][0], -ZS]];
  slab(gShelf, loop, (u, v, t) => [u, t, v], SILL_Y - 0.14, SILL_Y, [0, 1, 0]);
}
hullParts.push({ name: 'Kas_Rafi', mat: M_GREY, extras: CATI('Beyaz isi kalkani karosu LRSI'), g: gShelf, toCati: true });

/* Sol duvar: çatının altına kırpılmış çokgen */
const wallNode = gltf.nodes.findIndex((n) => n.name === 'Iskele_Duvari_Sol');
{
  const wn = gltf.nodes[wallNode];
  if (wn.translation || wn.rotation || wn.scale || wn.matrix) throw new Error('Duvar düğümünde dönüşüm var');
  const g = new Geo();
  const poly = [[0, -0.95], [4.56, -0.95], [4.56, 3.60], [TH[3][0], ROOF_Y], [BH[3][0], SILL_Y], [0, SILL_Y]];
  slab(g, poly, (u, v, t) => [u, v, t], 2.0, 2.06, [0, 0, 1]);
  wn._oldMat = gltf.meshes[wn.mesh].primitives[0].material;
  wn._newGeo = g;
}

/* ------------------------------------------------------------------ */
/* Çarpışma denetimi: çatı yüzeyleri, kabin parçalarının kutularıyla    */
/* ------------------------------------------------------------------ */
{
  const parent = {};
  gltf.nodes.forEach((n, i) => (n.children || []).forEach((c) => (parent[c] = i)));
  const localM = (n) => {
    const t = n.translation || [0, 0, 0], q = n.rotation || [0, 0, 0, 1], s = n.scale || [1, 1, 1];
    const [x, y, z, w] = q;
    return [
      (1 - 2 * (y * y + z * z)) * s[0], 2 * (x * y + z * w) * s[0], 2 * (x * z - y * w) * s[0], 0,
      2 * (x * y - z * w) * s[1], (1 - 2 * (x * x + z * z)) * s[1], 2 * (y * z + x * w) * s[1], 0,
      2 * (x * z + y * w) * s[2], 2 * (y * z - x * w) * s[2], (1 - 2 * (x * x + y * y)) * s[2], 0,
      t[0], t[1], t[2], 1,
    ];
  };
  const mm = (a, b) => {
    const r = new Array(16).fill(0);
    for (let c = 0; c < 4; c++) for (let k = 0; k < 4; k++) for (let q = 0; q < 4; q++) r[c * 4 + q] += a[k * 4 + q] * b[c * 4 + k];
    return r;
  };
  const worldM = (i) => {
    let m = localM(gltf.nodes[i]);
    for (let p = parent[i]; p != null; p = parent[p]) m = mm(localM(gltf.nodes[p]), m);
    return m;
  };
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
  const skip = /^(Hava_|Tavan_Seffaf|Iskele_Duvari_Sol|On_Perde|On_Pencere|Pencere_Cercevesi)/;
  let clash = 0;
  for (const f of facets) {
    for (let a = 0; a <= 12; a++) for (let b = 0; b <= 8; b++) {
      const p = lerp(lerp(f.c[0], f.c[1], a / 12), lerp(f.c[3], f.c[2], a / 12), b / 8);
      for (const bx of boxes) {
        if (skip.test(bx.name)) continue;
        if (p[0] > bx.lo[0] - 0.003 && p[0] < bx.hi[0] + 0.003 && p[1] > bx.lo[1] - 0.003 && p[1] < bx.hi[1] + 0.003 && p[2] > bx.lo[2] - 0.003 && p[2] < bx.hi[2] + 0.003) {
          if (clash++ < 12) console.log('Çatı çakışması:', bx.name, p.map((v) => v.toFixed(2)).join(', '));
        }
      }
    }
  }
  console.log(clash ? clash + ' çatı örnek noktası parçalara değiyor' : 'Çatı: kabin parçalarıyla çakışma yok');
}

/* ------------------------------------------------------------------ */
/* Eski pencereleri ve çerçeveyi kaldır, yenileri ekle                  */
/* ------------------------------------------------------------------ */
const gBasinc = gltf.nodes.find((n) => n.name === 'Basinc_Kabini');
const oldNames = /^(On_Pencere_\d|Pencere_Cercevesi_Ust)$/;
gBasinc.children = gBasinc.children.filter((c) => !oldNames.test(gltf.nodes[c].name));

function pushView(buf, target) {
  const pad = (4 - (bin.length % 4)) % 4;
  if (pad) bin = Buffer.concat([bin, Buffer.alloc(pad)]);
  const off = bin.length;
  bin = Buffer.concat([bin, buf]);
  gltf.bufferViews.push({ buffer: 0, byteOffset: off, byteLength: buf.length, target });
  return gltf.bufferViews.length - 1;
}
function addMesh(name, mat, g) {
  const pos = new Float32Array(g.p), nor = new Float32Array(g.n);
  const big = g.count > 65535;
  const idx = big ? new Uint32Array(g.i) : new Uint16Array(g.i);
  const lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
  for (let k = 0; k < pos.length; k += 3) for (let c = 0; c < 3; c++) { lo[c] = Math.min(lo[c], pos[k + c]); hi[c] = Math.max(hi[c], pos[k + c]); }
  const vP = pushView(Buffer.from(pos.buffer), 34962);
  const vN = pushView(Buffer.from(nor.buffer), 34962);
  const vI = pushView(Buffer.from(idx.buffer), 34963);
  const aP = gltf.accessors.push({ bufferView: vP, componentType: 5126, count: g.count, type: 'VEC3', min: lo, max: hi }) - 1;
  const aN = gltf.accessors.push({ bufferView: vN, componentType: 5126, count: g.count, type: 'VEC3' }) - 1;
  const aI = gltf.accessors.push({ bufferView: vI, componentType: big ? 5125 : 5123, count: g.i.length, type: 'SCALAR' }) - 1;
  return gltf.meshes.push({ name, primitives: [{ attributes: { POSITION: aP, NORMAL: aN }, indices: aI, material: mat }] }) - 1;
}

// Sol duvar: yeni ağ, eski malzemeyle
{
  const wn = gltf.nodes[wallNode];
  wn.mesh = addMesh('Iskele_Duvari_Sol', wn._oldMat, wn._newGeo);
  delete wn._newGeo; delete wn._oldMat;
}

let triTotal = 0;
const mkGroup = (name, list, extras) => {
  const kids = [];
  for (const p of list) {
    triTotal += p.g.i.length / 3;
    const mesh = addMesh(p.name, p.mat, p.g);
    kids.push(gltf.nodes.push({ name: p.name, mesh, extras: p.extras }) - 1);
  }
  return gltf.nodes.push({ name, children: kids, extras }) - 1;
};
const hullOnly = hullParts.filter((p) => !p.toCati);
const catiOnly = [...catiParts, ...hullParts.filter((p) => p.toCati)];
const grpHull = mkGroup('Burun_Kismi', hullOnly, { aciklama: 'Orbiter benzeri burun: RCC baslik, HRSI karin, LRSI ust, RCS portlari (tools/burun-detay.mjs)' });
const grpCati = mkGroup('Ucus_Guvertesi_Cati', catiOnly, { aciklama: 'Egimli 6 camli kokpit cati (tools/burun-detay.mjs)' });
const root = gltf.scenes[0].nodes[0];
gltf.nodes[root].children.push(grpHull, grpCati);
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
fs.writeFileSync(FILE, Buffer.concat([header, jh, json, bh, bin]));
console.log((hullOnly.length + catiOnly.length) + ' parça, ' + triTotal + ' üçgen eklendi → ' + path.relative(process.cwd(), FILE) + ' (' + (fs.statSync(FILE).size / 1024).toFixed(0) + ' KB)');
