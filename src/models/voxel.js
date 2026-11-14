/* =====================================================================
 * Alev Laboratuvarı — Model vokselleştirme
 * ---------------------------------------------------------------------
 * 1. İşaretli uzaklık alanı (SDF): gölge ve ortam kapatma ışınları için.
 *    Yüzeye yakın bantta üçgene en yakın nokta uzaklığı tam hesaplanır,
 *    uzak alan 3×3×3 pahlı uzaklık dönüşümüyle (iki geçiş) doldurulur.
 * 2. İç/dış: her parça (kapalı ağ) için eksene paralel ışınlarla çift-tek
 *    kesişim sayımı. Parçalar birbirine geçse de birleşimleri doğru çıkar.
 *    Aynı yordam çözücü ızgarasındaki katı hücreleri de üretir.
 * Uzun işler, arayüz donmasın diye parçalara bölünüp ana iş parçacığına
 * nefes aldırılarak yapılır.
 * ===================================================================== */
import { FL } from '../core/fl.js';

const yieldFrame = () => new Promise((r) => setTimeout(r, 0));

/** Nokta–üçgen en yakın uzaklığın karesi (Ericson, Real-Time Collision Detection 5.1.5) */
function distTri2(px, py, pz, ax, ay, az, bx, by, bz, cx, cy, cz) {
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  let qx, qy, qz;
  if (d1 <= 0 && d2 <= 0) { qx = ax; qy = ay; qz = az; }
  else {
    const bpx = px - bx, bpy = py - by, bpz = pz - bz;
    const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
    if (d3 >= 0 && d4 <= d3) { qx = bx; qy = by; qz = bz; }
    else {
      const vc = d1 * d4 - d3 * d2;
      if (vc <= 0 && d1 >= 0 && d3 <= 0) {
        const v = d1 / (d1 - d3);
        qx = ax + v * abx; qy = ay + v * aby; qz = az + v * abz;
      } else {
        const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
        const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
        if (d6 >= 0 && d5 <= d6) { qx = cx; qy = cy; qz = cz; }
        else {
          const vb = d5 * d2 - d1 * d6;
          if (vb <= 0 && d2 >= 0 && d6 <= 0) {
            const w = d2 / (d2 - d6);
            qx = ax + w * acx; qy = ay + w * acy; qz = az + w * acz;
          } else {
            const va = d3 * d6 - d5 * d4;
            if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
              const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
              qx = bx + w * (cx - bx); qy = by + w * (cy - by); qz = bz + w * (cz - bz);
            } else {
              const den = 1 / (va + vb + vc);
              const v = vb * den, w = vc * den;
              qx = ax + abx * v + acx * w; qy = ay + aby * v + acy * w; qz = az + abz * v + acz * w;
            }
          }
        }
      }
    }
  }
  const dx = px - qx, dy = py - qy, dz = pz - qz;
  return dx * dx + dy * dy + dz * dz;
}

/**
 * Parça listesindeki kapalı ağların birleşiminin ızgara hücre merkezlerinde
 * içte olup olmadığı. Işınlar +x yönünde, (y, z) sütun başına.
 *   parts: [{ pos: Float32Array, idx: Uint32Array, lo, hi }] (ızgara ile aynı uzay)
 *   grid : { o: [x0, y0, z0] (ilk hücre merkezi), d, n: [nx, ny, nz] }
 *   out  : Uint8Array(nx·ny·nz), x en hızlı; 1 = içte
 */
FL.voxelInside = async function (parts, grid, out, budgetMs = 12) {
  const [nx, ny, nz] = grid.n;
  const d = grid.d, o = grid.o;
  const res = out || new Uint8Array(nx * ny * nz);
  const xs = new Float64Array(256);
  let t0 = performance.now();
  // Işının tam köşe/kenardan geçmesini önleyen küçük, düzensiz kaydırma
  const jy = 0.0137 * d, jz = 0.0291 * d;
  for (const p of parts) {
    const j0 = Math.max(0, Math.ceil((p.lo[1] - o[1]) / d)), j1 = Math.min(ny - 1, Math.floor((p.hi[1] - o[1]) / d));
    const k0 = Math.max(0, Math.ceil((p.lo[2] - o[2]) / d)), k1 = Math.min(nz - 1, Math.floor((p.hi[2] - o[2]) / d));
    if (j1 < j0 || k1 < k0) continue;
    const i0 = Math.max(0, Math.ceil((p.lo[0] - o[0]) / d)), i1 = Math.min(nx - 1, Math.floor((p.hi[0] - o[0]) / d));
    if (i1 < i0) continue;
    const P = p.pos, I = p.idx;
    const ntri = I.length / 3;
    // Üçgenlerin (y, z) sınırları: sütun başına hızlı eleme
    const tb = new Float32Array(ntri * 4);
    for (let t = 0; t < ntri; t++) {
      const a = I[3 * t] * 3, b = I[3 * t + 1] * 3, c = I[3 * t + 2] * 3;
      tb[4 * t] = Math.min(P[a + 1], P[b + 1], P[c + 1]); tb[4 * t + 1] = Math.max(P[a + 1], P[b + 1], P[c + 1]);
      tb[4 * t + 2] = Math.min(P[a + 2], P[b + 2], P[c + 2]); tb[4 * t + 3] = Math.max(P[a + 2], P[b + 2], P[c + 2]);
    }
    for (let k = k0; k <= k1; k++) {
      const z = o[2] + k * d + jz;
      for (let j = j0; j <= j1; j++) {
        const y = o[1] + j * d + jy;
        let n = 0;
        for (let t = 0; t < ntri; t++) {
          if (y < tb[4 * t] || y > tb[4 * t + 1] || z < tb[4 * t + 2] || z > tb[4 * t + 3]) continue;
          const a = I[3 * t] * 3, b = I[3 * t + 1] * 3, c = I[3 * t + 2] * 3;
          // (y, z) düzleminde ağırlık merkezi koordinatları
          const y0 = P[a + 1], z0 = P[a + 2], y1 = P[b + 1], z1 = P[b + 2], y2 = P[c + 1], z2 = P[c + 2];
          const den = (y1 - y0) * (z2 - z0) - (y2 - y0) * (z1 - z0);
          if (Math.abs(den) < 1e-18) continue;
          const u = ((y - y0) * (z2 - z0) - (y2 - y0) * (z - z0)) / den;
          const v = ((y1 - y0) * (z - z0) - (y - y0) * (z1 - z0)) / den;
          if (u < 0 || v < 0 || u + v > 1) continue;
          if (n < xs.length) xs[n++] = P[a] + u * (P[b] - P[a]) + v * (P[c] - P[a]);
        }
        if (n < 2) continue;
        const arr = xs.subarray(0, n).sort();
        const row = (k * ny + j) * nx;
        for (let q = 0; q + 1 < n; q += 2) {
          const ia = Math.max(i0, Math.ceil((arr[q] - o[0]) / d));
          const ib = Math.min(i1, Math.floor((arr[q + 1] - o[0]) / d));
          for (let i = ia; i <= ib; i++) res[row + i] = 1;
        }
      }
      if (performance.now() - t0 > budgetMs) { await yieldFrame(); t0 = performance.now(); }
    }
  }
  return res;
};

/**
 * İşaretli uzaklık alanı. Dönüş: Float32Array, voksel biriminde, [-cap, cap].
 *   band: tam hesaplanan bant kalınlığı (voksel)
 */
FL.voxelSDF = async function (parts, grid, opts = {}) {
  const [nx, ny, nz] = grid.n;
  const d = grid.d, o = grid.o;
  const band = opts.band || 2.5, cap = opts.cap || 16;
  const N = nx * ny * nz;
  const dist = new Float32Array(N).fill(cap);
  let t0 = performance.now();
  const prog = opts.progress || (() => {});
  const alive = opts.alive || (() => true);
  let triDone = 0, triTotal = 0;
  for (const p of parts) triTotal += p.idx.length / 3;
  for (const p of parts) {
    const P = p.pos, I = p.idx;
    triDone += I.length / 3;
    prog(0.6 * triDone / triTotal);
    if (!alive()) return null;
    for (let t = 0; t < I.length; t += 3) {
      const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
      const ax = P[a], ay = P[a + 1], az = P[a + 2], bx = P[b], by = P[b + 1], bz = P[b + 2], cx = P[c], cy = P[c + 1], cz = P[c + 2];
      const r = band * d;
      const i0 = Math.max(0, Math.floor((Math.min(ax, bx, cx) - r - o[0]) / d)), i1 = Math.min(nx - 1, Math.ceil((Math.max(ax, bx, cx) + r - o[0]) / d));
      const j0 = Math.max(0, Math.floor((Math.min(ay, by, cy) - r - o[1]) / d)), j1 = Math.min(ny - 1, Math.ceil((Math.max(ay, by, cy) + r - o[1]) / d));
      const k0 = Math.max(0, Math.floor((Math.min(az, bz, cz) - r - o[2]) / d)), k1 = Math.min(nz - 1, Math.ceil((Math.max(az, bz, cz) + r - o[2]) / d));
      // Üçgen düzlemine uzaklıkla hızlı eleme (büyük duvar üçgenleri)
      let nxx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
      let nyy = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
      let nzz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      const nl = Math.hypot(nxx, nyy, nzz) || 1;
      nxx /= nl; nyy /= nl; nzz /= nl;
      for (let k = k0; k <= k1; k++) {
        const pz = o[2] + k * d;
        for (let j = j0; j <= j1; j++) {
          const py = o[1] + j * d;
          const row = (k * ny + j) * nx;
          for (let i = i0; i <= i1; i++) {
            const px = o[0] + i * d;
            const pl = Math.abs((px - ax) * nxx + (py - ay) * nyy + (pz - az) * nzz);
            if (pl > r) continue;
            const q = Math.sqrt(distTri2(px, py, pz, ax, ay, az, bx, by, bz, cx, cy, cz)) / d;
            if (q < dist[row + i]) dist[row + i] = q;
          }
        }
      }
      if (performance.now() - t0 > 12) { await yieldFrame(); t0 = performance.now(); }
    }
  }
  // Uzak alan: iki geçişli pahlı uzaklık dönüşümü (1, √2, √3)
  const s2 = Math.SQRT2, s3 = Math.sqrt(3);
  const fw = [];
  for (let dz = -1; dz <= 0; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    if (dz === 0 && (dy > 0 || (dy === 0 && dx >= 0))) continue;
    const m = Math.abs(dx) + Math.abs(dy) + Math.abs(dz);
    fw.push([dx, dy, dz, m === 1 ? 1 : m === 2 ? s2 : s3]);
  }
  // Komşu ofsetleri doğrusal indis farkı olarak; kenar katmanı atlanır (orada değer bant/kapak kalır)
  const offs = Int32Array.from(fw.map(([a, b, c]) => (c * ny + b) * nx + a));
  const wts = Float32Array.from(fw.map((f) => f[3]));
  const nf = offs.length;
  const pass = async (sgn) => {
    for (let kq = 1; kq < nz - 1; kq++) {
      const k = sgn > 0 ? kq : nz - 1 - kq;
      for (let jq = 1; jq < ny - 1; jq++) {
        const j = sgn > 0 ? jq : ny - 1 - jq;
        const row = (k * ny + j) * nx;
        for (let iq = 1; iq < nx - 1; iq++) {
          const id = row + (sgn > 0 ? iq : nx - 1 - iq);
          let v = dist[id];
          for (let f = 0; f < nf; f++) {
            const c = dist[id + sgn * offs[f]] + wts[f];
            if (c < v) v = c;
          }
          dist[id] = v;
        }
      }
      if (performance.now() - t0 > 12) { await yieldFrame(); t0 = performance.now(); }
    }
  };
  await pass(1);
  prog(0.72);
  await pass(-1);
  prog(0.84);
  if (!alive()) return null;
  // İşaret
  const inside = await FL.voxelInside(parts, grid);
  for (let q = 0; q < N; q++) {
    const v = Math.min(dist[q], cap);
    dist[q] = inside[q] ? -v : v;
  }
  return dist;
};
