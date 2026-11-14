/* =====================================================================
 * Alev Laboratuvarı — GLB (glTF 2.0 ikili) okuyucu
 * ---------------------------------------------------------------------
 * Yalnız bu projenin modellerinin kullandığı alt küme: üçgen ilkelleri,
 * POSITION / NORMAL öznitelikleri, 8/16/32 bit indisler, düğüm hiyerarşisi
 * (TRS veya matris), pbrMetallicRoughness malzemeleri ve "extras".
 * Her ağ örneği (mesh'i olan düğüm) ayrı bir "parça" olur; köşeler modelin
 * kök uzayına dönüştürülmüş olarak saklanır.
 * ===================================================================== */
import { FL } from '../core/fl.js';

const COMP = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
const NCOMP = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

function localMatrix(n) {
  if (n.matrix) return n.matrix.slice();
  const t = n.translation || [0, 0, 0], q = n.rotation || [0, 0, 0, 1], s = n.scale || [1, 1, 1];
  const [x, y, z, w] = q;
  return [
    (1 - 2 * (y * y + z * z)) * s[0], 2 * (x * y + z * w) * s[0], 2 * (x * z - y * w) * s[0], 0,
    2 * (x * y - z * w) * s[1], (1 - 2 * (x * x + z * z)) * s[1], 2 * (y * z + x * w) * s[1], 0,
    2 * (x * z + y * w) * s[2], 2 * (y * z - x * w) * s[2], (1 - 2 * (x * x + y * y)) * s[2], 0,
    t[0], t[1], t[2], 1,
  ];
}
function mul4(a, b) {
  const r = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let k = 0; k < 4; k++) {
    const bk = b[c * 4 + k];
    if (bk === 0) continue;
    for (let q = 0; q < 4; q++) r[c * 4 + q] += a[k * 4 + q] * bk;
  }
  return r;
}

/**
 * GLB'yi çözümler.
 * Dönüş: { name, extras, parts: [{ name, path, extras, material, pos, nor, idx, lo, hi }] }
 *   pos/nor: Float32Array (kök uzayı), idx: Uint32Array
 */
FL.parseGLB = function (buffer) {
  const dv = new DataView(buffer);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error('GLB değil');
  const jsonLen = dv.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 20, jsonLen)));
  let off = 20 + jsonLen;
  let bin = null;
  while (off < buffer.byteLength) {
    const len = dv.getUint32(off, true), type = dv.getUint32(off + 4, true);
    if (type === 0x004e4942) bin = new Uint8Array(buffer, off + 8, len);
    off += 8 + len;
  }
  if (!bin) throw new Error('GLB ikili bölümü yok');

  const accCache = new Map();
  function accessor(i) {
    if (accCache.has(i)) return accCache.get(i);
    const a = json.accessors[i];
    const bv = json.bufferViews[a.bufferView];
    const C = COMP[a.componentType];
    const n = NCOMP[a.type];
    const byteOff = bin.byteOffset + (bv.byteOffset || 0) + (a.byteOffset || 0);
    const stride = bv.byteStride || 0;
    let arr;
    if (!stride || stride === n * C.BYTES_PER_ELEMENT) {
      // Hizalı olmayabilir: kopyala
      arr = new C(buffer.slice(byteOff, byteOff + a.count * n * C.BYTES_PER_ELEMENT));
    } else {
      arr = new C(a.count * n);
      const src = new DataView(buffer, byteOff);
      for (let k = 0; k < a.count; k++) for (let c = 0; c < n; c++) {
        const o = k * stride + c * C.BYTES_PER_ELEMENT;
        arr[k * n + c] = C === Float32Array ? src.getFloat32(o, true) : C === Uint16Array ? src.getUint16(o, true) : C === Uint32Array ? src.getUint32(o, true) : src.getUint8(o);
      }
    }
    accCache.set(i, arr);
    return arr;
  }

  const mats = (json.materials || []).map((m) => {
    const p = m.pbrMetallicRoughness || {};
    const bc = p.baseColorFactor || [1, 1, 1, 1];
    return {
      name: m.name || '',
      base: bc.slice(0, 3),
      alpha: bc[3] === undefined ? 1 : bc[3],
      metal: p.metallicFactor === undefined ? 1 : p.metallicFactor,
      rough: p.roughnessFactor === undefined ? 1 : p.roughnessFactor,
    };
  });
  const defMat = { name: '', base: [0.8, 0.8, 0.8], alpha: 1, metal: 0, rough: 0.6 };

  const parts = [];
  const scene = json.scenes[json.scene || 0];
  const walk = (ni, parentM, path, inherited) => {
    const n = json.nodes[ni];
    const M = mul4(parentM, localMatrix(n));
    const ex = Object.assign({}, inherited, n.extras || {});
    const p2 = path.concat([n.name || 'düğüm' + ni]);
    if (n.mesh != null) {
      const mesh = json.meshes[n.mesh];
      // Normal matrisi: üst 3×3'ün ters devriği (ölçek tekdüzeyse aynı)
      const nm = normalMatrix(M);
      mesh.primitives.forEach((pr, pi) => {
        if (pr.mode !== undefined && pr.mode !== 4) return;
        const P = accessor(pr.attributes.POSITION);
        const nv = P.length / 3;
        const pos = new Float32Array(nv * 3);
        const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
        for (let k = 0; k < nv; k++) {
          const x = P[3 * k], y = P[3 * k + 1], z = P[3 * k + 2];
          for (let c = 0; c < 3; c++) {
            const v = M[c] * x + M[4 + c] * y + M[8 + c] * z + M[12 + c];
            pos[3 * k + c] = v;
            if (v < lo[c]) lo[c] = v;
            if (v > hi[c]) hi[c] = v;
          }
        }
        let idx;
        if (pr.indices != null) idx = Uint32Array.from(accessor(pr.indices));
        else { idx = new Uint32Array(nv); for (let k = 0; k < nv; k++) idx[k] = k; }
        let nor;
        if (pr.attributes.NORMAL != null) {
          const N = accessor(pr.attributes.NORMAL);
          nor = new Float32Array(nv * 3);
          for (let k = 0; k < nv; k++) {
            const x = N[3 * k], y = N[3 * k + 1], z = N[3 * k + 2];
            const a = nm[0] * x + nm[3] * y + nm[6] * z, b = nm[1] * x + nm[4] * y + nm[7] * z, c = nm[2] * x + nm[5] * y + nm[8] * z;
            const l = Math.hypot(a, b, c) || 1;
            nor[3 * k] = a / l; nor[3 * k + 1] = b / l; nor[3 * k + 2] = c / l;
          }
        } else {
          nor = flatNormals(pos, idx);
        }
        parts.push({
          name: n.name || mesh.name || 'parça',
          path: p2,
          extras: ex,
          material: pr.material != null ? mats[pr.material] : defMat,
          pos, nor, idx, lo, hi,
          primitive: pi,
        });
      });
    }
    // Alt düğümlere yalnız kaynak bilgisi aktarılır; malzeme/seviye her parçanın kendisinindir
    const pass = {};
    if (ex.kaynak) pass.kaynak = ex.kaynak;
    (n.children || []).forEach((c) => walk(c, M, p2, pass));
  };
  const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  scene.nodes.forEach((ni) => walk(ni, I, [], {}));
  const rootNode = scene.nodes.length === 1 ? json.nodes[scene.nodes[0]] : null;
  return { name: rootNode ? rootNode.name : 'Sahne', extras: rootNode && rootNode.extras ? rootNode.extras : {}, parts, materials: mats };
};

function normalMatrix(M) {
  const a = M[0], b = M[1], c = M[2], d = M[4], e = M[5], f = M[6], g = M[8], h = M[9], i = M[10];
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C || 1;
  // Ters devrik (sütun öncelikli 3×3)
  return [
    A / det, B / det, C / det,
    -(b * i - c * h) / det, (a * i - c * g) / det, -(a * h - b * g) / det,
    (b * f - c * e) / det, -(a * f - c * d) / det, (a * e - b * d) / det,
  ];
}

function flatNormals(pos, idx) {
  const nor = new Float32Array(pos.length);
  for (let t = 0; t < idx.length; t += 3) {
    const i0 = idx[t] * 3, i1 = idx[t + 1] * 3, i2 = idx[t + 2] * 3;
    const ux = pos[i1] - pos[i0], uy = pos[i1 + 1] - pos[i0 + 1], uz = pos[i1 + 2] - pos[i0 + 2];
    const vx = pos[i2] - pos[i0], vy = pos[i2 + 1] - pos[i0 + 1], vz = pos[i2 + 2] - pos[i0 + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const i of [i0, i1, i2]) { nor[i] += nx; nor[i + 1] += ny; nor[i + 2] += nz; }
  }
  for (let k = 0; k < nor.length; k += 3) {
    const l = Math.hypot(nor[k], nor[k + 1], nor[k + 2]) || 1;
    nor[k] /= l; nor[k + 1] /= l; nor[k + 2] /= l;
  }
  return nor;
}
