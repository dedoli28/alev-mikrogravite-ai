/* =====================================================================
 * Alev Laboratuvarı — Ortak GLSL kodu
 * ---------------------------------------------------------------------
 * 3B ızgara, 2B "atlas" dokusunda dilimler halinde saklanır:
 *   z dilimi → (tx, ty) = (z mod tilesX, z div tilesX) karosu
 * Böylece her fizik adımı tek bir tam ekran çizimi ile tüm hacmi
 * günceller. Örnekleme texelFetch ile yapılır: Edge, Opera ve ANGLE
 * kayan noktalı dokuda texture() türevini ya da doğrusal süzmeyi
 * bozunca alev alanı sıfırlanıyordu.
 *
 * Hücre türleri (cellType):
 *   0 gaz
 *   1 eylemsiz katı (nozul, mum gövdesi, numune çerçevesi)
 *   2 yakıt girişi (nozul kanalı)
 *   3 eş-akış hava girişi
 *   4 fitil (gözenekli buhar kaynağı)
 *   5 damla iç bölgesi (doymuş buhar)
 *   6 katı yakıt levhası (piroliz yüzeyi)
 * ===================================================================== */
import { FL } from '../core/fl.js';

FL.SHADERS = FL.SHADERS || {};

FL.SHADERS.vsQuad = `#version 300 es
layout(location = 0) in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

FL.SHADERS.header = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
`;

FL.SHADERS.common = `
// ---------------------------------------------------------------
// Izgara ve atlas
// ---------------------------------------------------------------
uniform ivec3 uN;        // hücre sayısı (NX, NY, NZ)
uniform int   uTilesX;   // atlas yatay karo sayısı
uniform float uDx;       // hücre boyu [m]

// Geometri parametreleri (dünya koordinatı, metre)
uniform int  uMode;      // 0 jet, 1 mum, 2 damla, 3 levha
uniform vec4 uSrc0;
uniform vec4 uSrc1;
uniform vec4 uSrc2;
uniform sampler2D uSolid; // levha durumu: (Ts, m, mdot'', 0), boyut NX×NY

const float PI = 3.14159265359;
const float SIGMA_SB = 5.670374e-8;
const float RU = 8.314462;
const float W_O2 = 0.031999;

ivec3 cellCoord() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int tx = p.x / uN.x;
  int ty = p.y / uN.y;
  return ivec3(p.x - tx * uN.x, p.y - ty * uN.y, ty * uTilesX + tx);
}

bool outsideGrid(ivec3 c) {
  return c.z >= uN.z;
}

bool inDomain(ivec3 c) {
  return all(greaterThanEqual(c, ivec3(0))) && all(lessThan(c, uN));
}

ivec2 texelOf(ivec3 c) {
  c = clamp(c, ivec3(0), uN - 1);
  int ty = c.z / uTilesX;
  int tx = c.z - ty * uTilesX;
  return ivec2(tx * uN.x + c.x, ty * uN.y + c.y);
}

vec4 F(sampler2D t, ivec3 c) {
  return texelFetch(t, texelOf(c), 0);
}

ivec2 sliceOrigin(int z) {
  int ty = z / uTilesX;
  int tx = z - ty * uTilesX;
  return ivec2(tx * uN.x, ty * uN.y);
}

// Dilim içinde çift doğrusal. Karo kenarında komşu z dilimine taşmaz.
vec4 sampleSlice(sampler2D t, ivec2 origin, vec2 p) {
  ivec2 i0 = ivec2(floor(p));
  vec2 f = clamp(p - vec2(i0), vec2(0.0), vec2(1.0));
  ivec2 i1 = i0 + ivec2(1, 1);
  ivec2 hi = ivec2(uN.x - 1, uN.y - 1);
  i0 = clamp(i0, ivec2(0), hi);
  i1 = clamp(i1, ivec2(0), hi);
  vec4 s00 = texelFetch(t, origin + ivec2(i0.x, i0.y), 0);
  vec4 s10 = texelFetch(t, origin + ivec2(i1.x, i0.y), 0);
  vec4 s01 = texelFetch(t, origin + ivec2(i0.x, i1.y), 0);
  vec4 s11 = texelFetch(t, origin + ivec2(i1.x, i1.y), 0);
  return mix(mix(s00, s10, f.x), mix(s01, s11, f.x), f.y);
}

// p: hücre indeksi (hücre i'nin merkezi = i). Her zaman texelFetch:
// Edge, Opera ve ANGLE texture()/textureLod ile kayan nokta alanını siyah döndürür,
// adveksiyon her karede alevi siler ve fitilde yalnız kıvılcım kalır.
vec4 S(sampler2D t, vec3 p) {
  p = clamp(p, vec3(0.0), vec3(uN) - 1.0);
  float z0f = floor(p.z);
  int z0 = int(z0f);
  int z1 = min(z0 + 1, uN.z - 1);
  float fz = p.z - z0f;
  vec4 a = sampleSlice(t, sliceOrigin(z0), p.xy);
  if (z1 == z0) return a;
  return mix(a, sampleSlice(t, sliceOrigin(z1), p.xy), fz);
}

vec3 worldPos(ivec3 c) {
  return (vec3(c) + 0.5) * uDx;
}

vec3 toCell(vec3 w) {
  return w / uDx - 0.5;
}

// ---------------------------------------------------------------
// İşaretli mesafe fonksiyonları (render ile ortak)
// ---------------------------------------------------------------
float sdCylY(vec3 p, vec2 c, float r, float y0, float y1) {
  vec2 d = vec2(length(p.xz - c) - r, max(y0 - p.y, p.y - y1));
  return min(max(d.x, d.y), 0.0) + length(max(d, 0.0));
}

float sdSphere(vec3 p, vec3 c, float r) {
  return length(p - c) - r;
}

float sdBox(vec3 p, vec3 c, vec3 h) {
  vec3 q = abs(p - c) - h;
  return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0);
}

// Levha hücre katmanı
int sheetLayer() {
  return int(floor(uSrc0.x / uDx));
}

bool inSheetExtent(vec3 w) {
  return w.x >= uSrc0.y && w.x <= uSrc0.z && w.y >= uSrc0.w && w.y <= uSrc1.x;
}

vec4 sheetState(ivec3 c) {
  return texelFetch(uSolid, ivec2(clamp(c.x, 0, uN.x - 1), clamp(c.y, 0, uN.y - 1)), 0);
}

// ---------------------------------------------------------------
// Hücre türü
//   cellTypeGeo: analitik geometri (pahalı; yalnız tür dokusu üretilirken)
//   cellType   : tür dokusundan tek okuma; alan dışında analitik değere düşer
// ---------------------------------------------------------------
int cellTypeGeo(ivec3 c) {
  vec3 w = worldPos(c);
  if (uMode == 0) {
    // Gaz jeti: uSrc0 = (cx, cz, Ri, Ro); uSrc1 = (hTube, Rco, Ujet, Uco); uSrc2 = (YF1, Tfuel, coflowOn, 0)
    float r = length(w.xz - uSrc0.xy);
    if (w.y < uSrc1.x) {
      if (r < uSrc0.z) return 2;
      if (r < uSrc0.w) return 1;
      if (uSrc2.z > 0.5) {
        float wall = 1.2 * uDx;
        if (r < uSrc1.y) return (w.y < uSrc1.x - 2.0 * uDx) ? 3 : 0;
        if (r < uSrc1.y + wall) return 1;
      }
    }
    return 0;
  } else if (uMode == 1) {
    // Mum: uSrc0 = (cx, cz, Rc, hc); uSrc1 = (rw, lw, wickRate, Tvap)
    if (sdCylY(w, uSrc0.xy, uSrc0.z, -1.0, uSrc0.w) < 0.0) return 1;
    float rw = max(uSrc1.x, 0.55 * uDx);
    if (sdCylY(w, uSrc0.xy, rw, uSrc0.w - uDx, uSrc0.w + uSrc1.y) < 0.0) return 4;
    return 0;
  } else if (uMode == 2) {
    // Damla: uSrc0 = (cx, cy, cz, rd); uSrc1 = (Tb, Yfs, mdot, rhoFilm); uSrc2 = (rFiber, fiberOn, 0, 0)
    if (uSrc0.w > 0.0 && sdSphere(w, uSrc0.xyz, max(uSrc0.w, 0.5 * uDx)) < 0.0) return 5;
    if (uSrc2.y > 0.5) {
      // Asılı tutma lifi (yer deneylerinde) — yatay, x ekseni boyunca
      vec2 d = w.yz - uSrc0.yz;
      if (length(d) < max(uSrc2.x, 0.45 * uDx) && abs(w.x - uSrc0.x) > uSrc0.w * 0.8) return 1;
    }
    return 0;
  } else if (uMode == 3) {
    // Levha: uSrc0 = (zc, x0, x1, y0); uSrc1 = (y1, m0c, inert, frameW)
    int kc = sheetLayer();
    if (c.z == kc && inSheetExtent(w)) {
      vec4 st = sheetState(c);
      if (st.g + uSrc1.z > 0.02) return 6;
      return 0;
    }
    // Numune tutucu çerçeve (sol, sağ ve alt kenar)
    if (abs(c.z - kc) <= 1) {
      float fw = uSrc1.w;
      bool sideL = w.x >= uSrc0.y - fw && w.x < uSrc0.y && w.y >= uSrc0.w - fw && w.y <= uSrc1.x;
      bool sideR = w.x > uSrc0.z && w.x <= uSrc0.z + fw && w.y >= uSrc0.w - fw && w.y <= uSrc1.x;
      bool base = w.y >= uSrc0.w - fw && w.y < uSrc0.w && w.x >= uSrc0.y - fw && w.x <= uSrc0.z + fw;
      if (sideL || sideR || base) return 1;
    }
    return 0;
  }
  return 0;
}

uniform sampler2D uType;   // R8: hücre türü / 255, atlas düzeninde
int cellType(ivec3 c) {
  if (!inDomain(c)) return cellTypeGeo(c);
  return int(texelFetch(uType, texelOf(c), 0).r * 255.0 + 0.5);
}

bool isSolidType(int t) {
  return t == 1 || t == 4 || t == 5 || t == 6;
}

// ---------------------------------------------------------------
// Basit karma (hash) gürültü — bölge dışı küçük hava akımı tohumları
// ---------------------------------------------------------------
float hash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}

float vnoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float n000 = hash13(i);
  float n100 = hash13(i + vec3(1, 0, 0));
  float n010 = hash13(i + vec3(0, 1, 0));
  float n110 = hash13(i + vec3(1, 1, 0));
  float n001 = hash13(i + vec3(0, 0, 1));
  float n101 = hash13(i + vec3(1, 0, 1));
  float n011 = hash13(i + vec3(0, 1, 1));
  float n111 = hash13(i + vec3(1, 1, 1));
  return mix(mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
             mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y), f.z);
}
`;

/* Termofiziksel özellik fonksiyonları — fizik shader'ları paylaşır */
FL.SHADERS.thermo = `
// Yakıt: (W, dHc, s, Wp); seyreltici: (W, cpA, cpB, ışınımlı); iletkenlik: (l0, ln, xDil, h2o)
uniform vec4 uFuel;
uniform vec4 uDil;
uniform vec4 uDilCond;
uniform float uP;        // basınç [Pa]
uniform float uTamb;     // ortam sıcaklığı [K]
uniform float uYoAmb;    // ortam O2 kütle kesri

float cpMix(float T, float Yf, float Yo, float Yp, float Yd) {
  float cpP = uDilCond.w > 0.5 ? (1600.0 + 0.57 * T) : (1000.0 + 0.40 * T);
  float cp = Yf * (1400.0 + 1.2 * T)
           + Yo * (880.0 + 0.150 * T)
           + Yp * cpP
           + Yd * (uDil.y + uDil.z * T);
  // Ayrışma (dissosiyasyon) için etkin ısı kapasitesi artışı
  cp += 0.55 * max(T - 1800.0, 0.0) * min(1.0, Yp * 4.0);
  return max(cp, 300.0);
}

float invMolar(float Yf, float Yo, float Yp, float Yd) {
  return Yf / uFuel.x + Yo / W_O2 + Yp / uFuel.w + Yd / uDil.x;
}

float rhoMix(float T, float invW) {
  return uP / (RU * T * invW);
}

float conductivity(float T) {
  float lAir = 0.0263 * pow(T / 300.0, 0.8);
  float lDil = uDilCond.x * pow(T / 300.0, uDilCond.y);
  return uDilCond.z * lDil + (1.0 - uDilCond.z) * lAir;
}

// Optik ince Planck ortalama soğurma katsayısı [1/m]
uniform vec4 uRad;   // (açık, gaz çarpanı, kurum çarpanı, P1 modeli açık)
float kappaPlanck(float T, float Yp, float Yd, float invW, float fv) {
  float Patm = uP / 101325.0;
  float Xp = (Yp / uFuel.w) / invW;
  float t = 1000.0 / T;
  float kg = Patm * Xp * (0.25 + 9.0 * t * t);
  if (uDil.w > 0.5) {
    float Xd = (Yd / uDil.x) / invW;
    kg += Patm * Xd * (0.15 + 6.0 * t * t);
  }
  float ks = 1862.0 * fv * T;
  return uRad.y * kg + uRad.z * ks;
}
`;
