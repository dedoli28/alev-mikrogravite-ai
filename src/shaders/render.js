/* =====================================================================
 * Alev Laboratuvarı — Hacimsel ışın yürütme (ray marching) ve son işlem
 * ---------------------------------------------------------------------
 * Fiziksel görüntü modu (ışınım transfer denklemi, saçılmasız):
 *   dL_λ/ds = j_λ − κ_λ L_λ
 *   Kurum: κ_λ = 4,9·f_v/λ (Rayleigh), j_λ = κ_λ B_λ(T). Planck yasası CIE 1931
 *   renk eşleme fonksiyonlarıyla doğrusal sRGB'ye tümlenir (LUT, termokimya).
 *   Mavi bölge: CH* (431 nm), C₂* Swan bantları ve CO₂* süreklisi; ısı salınım
 *   hızıyla orantılı kemilüminesans. Soğuk alev: HCHO* (yoğunlaştırılmış kamera).
 *   Renk ve parlaklık yalnız benzetimin T, f_v ve HRR alanlarından gelir.
 * Bilimsel modlar: termal kamera, sıcaklık, HRR, kurum, hız, türler,
 * Schlieren (yoğunluk gradyanı).
 *
 * Görüntü hattı:
 *   raymarch (MRT: ışıma + derinlik/OPD) → zamansal biriktirme (TAA)
 *   → parlama zinciri → bileşim (Catmull–Rom büyütme, film eğrisi)
 * Işıma, yarım duyarlıklı hedefte taşmaması için önceden pozlanır
 * (pre-exposure); bileşimde yalnız oran uygulanır.
 * ===================================================================== */
import { FL } from '../core/fl.js';

const COLORMAPS = `
vec3 inferno(float t) {
  t = clamp(t, 0.0, 1.0);
  const vec3 c0 = vec3(0.0002189403691192265, 0.001651004631001012, -0.01948089843709184);
  const vec3 c1 = vec3(0.1065134194856116, 0.5639564367884091, 3.932712388889277);
  const vec3 c2 = vec3(11.60249308247187, -3.972853965665698, -15.9423941062914);
  const vec3 c3 = vec3(-41.70399613139459, 17.43639888205313, 44.35414519872813);
  const vec3 c4 = vec3(77.162935699427, -33.40235894210092, -81.80730925738993);
  const vec3 c5 = vec3(-71.31942824499214, 32.62606426397723, 73.20951985803202);
  const vec3 c6 = vec3(25.13112622477341, -12.24266895238567, -23.07032500287172);
  return clamp(c0 + t * (c1 + t * (c2 + t * (c3 + t * (c4 + t * (c5 + t * c6))))), 0.0, 1.0);
}

vec3 turbo(float x) {
  x = clamp(x, 0.0, 1.0);
  const vec4 kR4 = vec4(0.13572138, 4.61539260, -42.66032258, 132.13108234);
  const vec4 kG4 = vec4(0.09140261, 2.19418839, 4.84296658, -14.18503333);
  const vec4 kB4 = vec4(0.10667330, 12.64194608, -60.58204836, 110.36276771);
  const vec2 kR2 = vec2(-152.94239396, 59.28637943);
  const vec2 kG2 = vec2(4.27729857, 2.82956604);
  const vec2 kB2 = vec2(-89.90310912, 27.34824973);
  vec4 v4 = vec4(1.0, x, x * x, x * x * x);
  vec2 v2 = v4.zw * v4.z;
  return clamp(vec3(dot(v4, kR4) + dot(v2, kR2), dot(v4, kG4) + dot(v2, kG2), dot(v4, kB4) + dot(v2, kB2)), 0.0, 1.0);
}

vec3 coolwarm(float t) {
  t = clamp(t, 0.0, 1.0);
  vec3 a = vec3(0.23, 0.30, 0.75), m = vec3(0.87, 0.87, 0.87), b = vec3(0.71, 0.02, 0.15);
  return t < 0.5 ? mix(a, m, t * 2.0) : mix(m, b, t * 2.0 - 1.0);
}
`;
FL.SHADERS.colormaps = COLORMAPS;

/* Arayüzdeki renk ölçeği göstergeleri için aynı haritaların JS karşılıkları */
FL.COLORMAP_STOPS = {
  inferno: ['#000004', '#1b0c41', '#4a0c6b', '#781c6d', '#a52c60', '#cf4446', '#ed6925', '#fb9b06', '#f7d13d', '#fcffa4'],
  turbo: ['#30123b', '#4662d7', '#36aaf9', '#1ae4b6', '#72fe5e', '#c8ef34', '#faba39', '#f66b19', '#ca2a04', '#7a0403'],
  coolwarm: ['#3b4cc0', '#7b9ff9', '#c0d4f5', '#dddddd', '#f2cbb7', '#ee8468', '#b40426'],
};

FL.SHADERS.raymarch = () => FL.SHADERS.header + FL.SHADERS.common + FL.SHADERS.thermo + COLORMAPS + FL.RADC + `
in vec2 vUv;
uniform sampler2D uSca;
uniform sampler2D uAux;
uniform sampler2D uVel;
uniform sampler2D uLUT;          // 512×2: satır 0 kurum, satır 1 gri cisim
uniform vec2 uLUTRange;          // (Tmin, Tmax)
uniform mat4 uInvVP;
uniform vec3 uCamPos;
uniform vec2 uJitter;            // alt piksel kayması (NDC)
uniform vec3 uBox;               // alan boyutu [m]
uniform int uView;               // görüntü modu
uniform float uMaskPass;         // 1: yer gerçeği maskesi (katı, zemin, arka plan siyah)
uniform sampler2D uGr;           // ışınım alanı (kaba bloklar): (G − G∞, duvar akısı, -, masa akısı)
uniform float uStep;             // adım (hücre cinsinden); GPU bütçesi bunu büyütebilir
uniform vec3 uChemCol;           // HRR [W/m³] başına kemilüminesans ışıması (sRGB doğrusal)
uniform vec3 uCoolCol;           // soğuk alev HRR başına ışıma
uniform vec3 uSootAbs;           // Ke/λ (R,G,B) [1/m], f_v = 1 için
uniform float uSootGain;         // LUT ölçeği × kullanıcı kurum ışıması kazancı
uniform float uChemGain;
uniform float uCoolGain;
uniform int uFrame;
uniform vec4 uLight;             // alev ışık kaynağı: konum + ışık şiddeti [cd]
uniform vec3 uLightCol;
uniform float uLightR;           // ışık kaynağının etkin yarıçapı [m] (yumuşak gölge, sonlu kaynak)
uniform float uAmbientL;         // ortam aydınlatması [cd/m²]
uniform vec4 uSlice;             // (açık, alan, eksen, konum 0..1)
uniform vec2 uSliceRange;
uniform float uSliceGain;        // fiziksel modda kesitin HDR ölçeği
uniform float uFloor;            // 0 yok, 1 masa, 2 masa + ızgara
uniform vec3 uSheetColor;
uniform float uSheetInert;
uniform float uGlowGain;
uniform float uFalseRange;       // bilimsel modlar için ölçek
uniform float uPreExp;           // ön pozlama çarpanı
uniform float uWamb;             // ortam ortalama mol kütlesi
uniform float uShadows;          // yumuşak gölge + AO açık
uniform float uFloorFade;        // masanın kararma uzaklığı [m]
// Yerleştirilmiş model (GLB): G-tamponu görünürlüğü, parça tablosu, model uzayında SDF
uniform float uMOn;
uniform sampler2D uGB0;          // (ışın boyu uzaklık, normal)
uniform sampler2D uGB1;          // (parça + 1)
uniform sampler2D uMPart;        // satır 0 (albedo, pürüzlülük), 1 (metalik, seviye, cam), 2 (yanıcılık rengi, durum)
uniform highp sampler3D uMSdf;   // R8: işaretli uzaklık, [−uMCap, uMCap]
uniform mat4 uMInv;              // dünya → model
uniform vec3 uMGo;               // SDF ızgarasının ilk hücre merkezi (model uzayı)
uniform float uMGd;              // voksel [m]
uniform vec3 uMGn;               // voksel sayısı
uniform float uMCap;
uniform float uMFlam;            // yanıcılık görünümü
uniform float uExpTot;           // toplam pozlama çarpanı (pozlamadan bağımsız renkler için)
uniform vec4 uKey;               // tavan lambası: konum + ışık şiddeti [cd] (0: kapalı)
uniform float uKeyR;             // lamba yarıçapı [m]
// Işık tarzı (FL.lightRig): renkli yarım küre ortam ışığı, lamba rengi, gölgeli güneş, gölgesiz dolgu
uniform vec3 uKeyCol;            // lamba rengi
#define KEY_COL uKeyCol
uniform vec3 uAmbSky;            // yukarı bakan yüzeye gelen ortam ışıklılığı [cd/m²]
uniform vec3 uAmbGnd;            // aşağı bakan yüzeye gelen
uniform vec3 uSunCol;            // güneş (paralel ışık) rengi
uniform float uSunReach;         // güneş gölge ışınının boyu [m] (sahne ölçeği)
uniform vec4 uFill;              // dolgu ışığı: yön + aydınlık [lx]
uniform vec3 uFillCol;
vec3 ambCol(vec3 n) { return mix(uAmbGnd, uAmbSky, 0.5 + 0.5 * n.y); }
// Yangın efektleri ve uzay arka planı. Pahalı kısımlar bu gölgelendiricide değildir (derleme süresi):
// yanık izi model G-tamponunda (uGB1.yzw), Dünya ve yıldızlar ayrı bir geçişte (uBgTex) hesaplanır.
uniform float uFxNit;            // kor ışıması ölçeği [cd/m²]
uniform float uBackdrop;         // 0 laboratuvar, 1 yörünge
uniform sampler2D uBgTex;        // uzay arka planı (aynı kamera, aynı alt piksel kayması)
uniform vec3 uSunDir;
uniform float uSunE;             // model yüzeylerine gelen güneş aydınlığı [lx] (0: kapalı)
// Yapay zekâ görünümü (uView == 9): modelin öngördüğü alev cephesi, tutuşma noktası başına
uniform vec4 uAiOrg[4];          // xyz tutuşma noktası [m], w öngörülen cephe yarıçapı şimdi [m] (< 0: kapalı)
uniform vec4 uAiPar[4];          // (öngörülen son yayılma yarıçapı [m], eş-zaman aralığı [m], çizgi sayısı, -)
uniform float uAiPx;             // bir pikselin gördüğü açı [rad] (çizgi kalınlığı için)
layout(location = 0) out vec4 oColor;
layout(location = 1) out vec4 oAux;   // (derinlik [m], OPD [m], katı maskesi, 0)

// ------------------------------------------------------------------
// İşaretli mesafe yardımcıları
// ------------------------------------------------------------------
float smax(float a, float b, float k) {
  float h = clamp(0.5 - 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) + k * h * (1.0 - h);
}
float smin(float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}
// y eksenli dönel yuvarlatılmış dikdörtgen: r ∈ [r0, r1], y ∈ [y0, y1], köşe yarıçapı rr
float sdRevRect(vec3 p, vec2 c, float r0, float r1, float y0, float y1, float rr) {
  vec2 q = vec2(length(p.xz - c), p.y);
  vec2 ctr = vec2(0.5 * (r0 + r1), 0.5 * (y0 + y1));
  vec2 h = max(vec2(0.5 * (r1 - r0), 0.5 * (y1 - y0)) - rr, vec2(0.0));
  vec2 d = abs(q - ctr) - h;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - rr;
}
float sdRoundBox(vec3 p, vec3 c, vec3 h, float r) {
  vec3 q = abs(p - c) - (h - r);
  return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0) - r;
}

// ------------------------------------------------------------------
// Sahne geometrisi (katılar) — benzetimdeki hücre geometrisinin
// pürüzsüz, görsel olarak ayrıntılandırılmış karşılığı
// mat: 1 çelik, 2 parafin, 3 fitil, 4 sıvı damla, 5 levha, 6 çerçeve,
//      7 lif, 8 bal peteği, 9 erimiş parafin havuzu
// ------------------------------------------------------------------
vec2 sceneSDF(vec3 p) {
  float d = 1e9;
  float mat = 0.0;
  if (uMode == 0) {
    float Ri = uSrc0.z, Ro = uSrc0.w, hT = uSrc1.x;
    float rr = min(0.0003, 0.45 * (Ro - Ri));
    float tube = sdRevRect(p, uSrc0.xy, Ri, Ro, -0.03, hT, rr);
    if (tube < d) { d = tube; mat = 1.0; }
    if (uSrc2.z > 0.5) {
      float wall = max(1.2 * uDx, 0.0006);
      float co = sdRevRect(p, uSrc0.xy, uSrc1.y, uSrc1.y + wall, -0.03, hT, 0.00025);
      if (co < d) { d = co; mat = 1.0; }
      float hc = sdRevRect(p, uSrc0.xy, Ro, uSrc1.y, -0.03, hT - 2.5 * uDx, 0.0001);
      if (hc < d) { d = hc; mat = 8.0; }
    }
  } else if (uMode == 1) {
    vec2 c = uSrc0.xy;
    float Rc = uSrc0.z, hc = uSrc0.w;
    float body = sdRevRect(p, c, -Rc, Rc, -0.03, hc, 0.0012);
    // Erime havuzu: fitil çevresinde sığ, kenarı yumuşak çanak
    float poolR = 0.78 * Rc;
    vec3 pc = vec3(c.x, hc, c.y);
    vec3 e = (p - pc) / vec3(poolR, 0.0022, poolR);
    float dish = (length(e) - 1.0) * 0.0022;
    float wax = smax(body, -dish, 0.0009);
    // Sıvı parafin: çanağı belirli bir seviyeye kadar doldurur
    float liquid = max(max(dish, p.y - (hc - 0.0009)), body);
    if (wax < d) { d = wax; mat = 2.0; }
    if (liquid < d) { d = liquid; mat = 9.0; }
    // Fitil: hafif kıvrık, uca doğru incelen, kömürleşmiş pamuk
    float rw = max(uSrc1.x, 0.00045), lw = uSrc1.y;
    float hy = clamp((p.y - hc) / max(lw, 1e-3), 0.0, 1.0);
    vec3 q = p;
    q.x -= 0.22 * lw * hy * hy;
    float r = rw * (1.0 - 0.3 * hy * hy);
    vec3 pa = q - vec3(c.x, clamp(q.y, hc - 0.004, hc + lw - r), c.y);
    float wick = (length(pa) - r) * 0.8;
    if (wick < d) { d = wick; mat = 3.0; }
  } else if (uMode == 2) {
    if (uSrc0.w > 0.0) {
      float dr = sdSphere(p, uSrc0.xyz, uSrc0.w);
      if (dr < d) { d = dr; mat = 4.0; }
    }
    if (uSrc2.y > 0.5) {
      vec2 dd = p.yz - uSrc0.yz;
      float fib = max(length(dd) - max(uSrc2.x, 0.00008), -(abs(p.x - uSrc0.x) - uSrc0.w * 0.6));
      // Lifin damlayı tuttuğu küçük boncuk
      float bead = sdSphere(p, uSrc0.xyz, max(uSrc2.x, 0.00008) * 2.2);
      fib = min(fib, bead);
      if (fib < d) { d = fib; mat = 7.0; }
    }
  } else if (uMode == 3) {
    float th = 0.0004;
    vec3 c = vec3(0.5 * (uSrc0.y + uSrc0.z), 0.5 * (uSrc0.w + uSrc1.x), (float(sheetLayer()) + 0.5) * uDx);
    vec3 h = vec3(0.5 * (uSrc0.z - uSrc0.y), 0.5 * (uSrc1.x - uSrc0.w), th);
    float sh = sdBox(p, c, h);
    if (sh < d) { d = sh; mat = 5.0; }
    float fw = uSrc1.w;
    float zc = c.z;
    float rr = 0.00035;
    float l = sdRoundBox(p, vec3(uSrc0.y - fw * 0.5, c.y - fw * 0.5, zc), vec3(fw * 0.5, h.y + fw * 0.5, fw * 0.6), rr);
    float r = sdRoundBox(p, vec3(uSrc0.z + fw * 0.5, c.y - fw * 0.5, zc), vec3(fw * 0.5, h.y + fw * 0.5, fw * 0.6), rr);
    float b = sdRoundBox(p, vec3(c.x, uSrc0.w - fw * 0.5, zc), vec3(h.x + fw, fw * 0.5, fw * 0.6), rr);
    float fr = min(l, min(r, b));
    // Çerçeveyi zemine bağlayan ayak
    float leg = sdRoundBox(p, vec3(c.x, 0.5 * (uSrc0.w - fw), zc), vec3(fw * 0.6, 0.5 * (uSrc0.w - fw) + 0.001, fw * 0.6), rr);
    fr = min(fr, leg);
    if (fr < d) { d = fr; mat = 6.0; }
  }
  return vec2(d, mat);
}

vec3 sceneNormal(vec3 p) {
  float e = 0.00005;
  vec2 k = vec2(1.0, -1.0);
  return normalize(k.xyy * sceneSDF(p + k.xyy * e).x + k.yyx * sceneSDF(p + k.yyx * e).x +
                   k.yxy * sceneSDF(p + k.yxy * e).x + k.xxx * sceneSDF(p + k.xxx * e).x);
}

// Modelin işaretli uzaklığı (ızgara dışında kutuya uzaklık eklenir)
float modelSDF(vec3 p) {
  if (uMOn < 0.5) return 1e9;
  vec3 l = (uMInv * vec4(p, 1.0)).xyz;
  vec3 g = (l - uMGo) / uMGd;
  vec3 gc = clamp(g, vec3(0.0), uMGn - 1.0);
  float outside = length(g - gc) * uMGd;
  float v = texture(uMSdf, (gc + 0.5) / uMGn).r;
  return (v * 2.0 - 1.0) * uMCap + outside;
}
// Gölge ve ortam kapatma: analitik katılar + model
float occSDF(vec3 p) {
  return min(sceneSDF(p).x, modelSDF(p));
}

float traceSolids(vec3 ro, vec3 rd, float tmax, out float mat) {
  float t = 0.0;
  mat = 0.0;
  for (int i = 0; i < 128; i++) {
    vec2 h = sceneSDF(ro + rd * t);
    if (h.x < 0.00003 + t * 0.0002) { mat = h.y; return t; }
    t += max(h.x * 0.9, 0.00002);
    if (t > tmax) break;
  }
  return 1e9;
}

// Alevin sonlu boyutlu kaynağından yumuşak gölge (yarı gölge açısı ≈ R / mesafe)
// t0: başlangıç uzaklığı (kaba model SDF'sinde yüzeyin kendini gölgelememesi için)
// Adım üst sınırı ışık uzaklığıyla ölçeklenir: model ölçeğinde de (≈ m) ışına sığar.
// R: ışık kaynağının yarıçapı (yarı gölge açısı ≈ R / uzaklık)
float softShadowR(vec3 ro, vec3 rd, float tmax, float t0, float R) {
  if (uShadows < 0.5) return 1.0;
  float k = tmax / max(R, 1e-4);
  float res = 1.0;
  float t = t0;
  float smax = max(0.003, tmax * 0.035);
  for (int i = 0; i < 48; i++) {
    float h = occSDF(ro + rd * t);
    res = min(res, k * h / t);
    t += clamp(h, 0.0002, smax);
    if (res < 0.002 || t > tmax) break;
  }
  res = clamp(res, 0.0, 1.0);
  return res * res * (3.0 - 2.0 * res);
}
float softShadow(vec3 ro, vec3 rd, float tmax, float t0) { return softShadowR(ro, rd, tmax, t0, uLightR); }
float softShadow(vec3 ro, vec3 rd, float tmax) { return softShadow(ro, rd, tmax, 0.0004); }

// Tavan lambası (oda / kabin aydınlatması): küresel alan ışığı, ışık şiddeti uKey.w [cd]
// Döndürür: yüzeye gelen aydınlık [lx] × gölge, L: ışık yönü
float keyLight(vec3 p, vec3 n, float off, out vec3 L, out float aw) {
  L = vec3(0.0, 1.0, 0.0);
  aw = 0.0;
  if (uKey.w <= 0.0) return 0.0;
  vec3 Lv = uKey.xyz - p;
  float r2 = max(dot(Lv, Lv), 1e-6);
  float d = sqrt(r2);
  L = Lv / d;
  aw = clamp(uKeyR / (2.0 * d), 0.0, 0.8);
  if (dot(n, L) <= 0.0) return 0.0;
  float E = uKey.w / (r2 + uKeyR * uKeyR);
  // Gölge ışını lambanın kendi gövdesine (ve hemen üstündeki tavana) kadar yürümez
  return E * softShadowR(p + n * off, L, max(d - 1.2 * uKeyR, 0.5 * d), off * 1.4 + 0.0004, uKeyR);
}

// SDF tabanlı ortam kapatma (temas gölgeleri); s: yarıçap ölçeği
float calcAO(vec3 p, vec3 n, float s) {
  if (uShadows < 0.5) return 1.0;
  float occ = 0.0, sca = 1.0;
  for (int i = 0; i < 5; i++) {
    float h = s * (0.0004 + 0.0032 * float(i) / 4.0);
    float d = occSDF(p + h * n);
    occ += (h - d) * sca;
    sca *= 0.75;
  }
  return clamp(1.0 - 95.0 / s * occ, 0.0, 1.0);
}
float calcAO(vec3 p, vec3 n) { return calcAO(p, n, 1.0); }

vec2 boxHit(vec3 ro, vec3 rd, vec3 bmin, vec3 bmax) {
  vec3 inv = 1.0 / rd;
  vec3 t0 = (bmin - ro) * inv;
  vec3 t1 = (bmax - ro) * inv;
  vec3 tmin = min(t0, t1), tmax = max(t0, t1);
  float tn = max(max(tmin.x, tmin.y), tmin.z);
  float tf = min(min(tmax.x, tmax.y), tmax.z);
  return vec2(max(tn, 0.0), tf);
}

// Kara cisim tablosu 512×2. texture() burada da türev yüzünden kararır.
vec3 lutRow(float T, int row) {
  float u = clamp((T - uLUTRange.x) / (uLUTRange.y - uLUTRange.x), 0.0, 1.0);
  float x = u * 511.0;
  int i0 = clamp(int(x), 0, 511);
  int i1 = min(i0 + 1, 511);
  float f = x - float(i0);
  return mix(texelFetch(uLUT, ivec2(i0, row), 0).rgb, texelFetch(uLUT, ivec2(i1, row), 0).rgb, f);
}
vec3 lutSoot(float T) { return lutRow(T, 0); }
vec3 lutGray(float T) { return lutRow(T, 1); }

// ------------------------------------------------------------------
// Fiziksel tabanlı yüzey yansıması (GGX + Lambert)
// aw: küresel kaynak için pürüzlülük genişletmesi (R / 2d)
// ------------------------------------------------------------------
vec3 brdf(vec3 n, vec3 V, vec3 L, vec3 alb, float rough, vec3 F0, float metal, float aw) {
  vec3 H = normalize(V + L);
  float ndl = max(dot(n, L), 0.0);
  float ndv = max(dot(n, V), 1e-3);
  float ndh = max(dot(n, H), 0.0);
  float vdh = max(dot(V, H), 0.0);
  float a = clamp(rough * rough + aw, 0.003, 1.0);
  float a2 = a * a;
  float dd = ndh * ndh * (a2 - 1.0) + 1.0;
  float D = a2 / (PI * dd * dd);
  float k = a * 0.5;
  float G = ndv / (ndv * (1.0 - k) + k) * ndl / (ndl * (1.0 - k) + k);
  vec3 F = F0 + (1.0 - F0) * pow(1.0 - vdh, 5.0);
  vec3 spec = D * G * F / (4.0 * ndv * max(ndl, 1e-3));
  vec3 diff = (1.0 - F) * (1.0 - metal) * alb / PI;
  return (diff + spec) * ndl;
}

vec3 envSpec(vec3 n, vec3 V, vec3 F0, float rough, float ao) {
  float ndv = max(dot(n, V), 0.0);
  vec3 F = F0 + (max(vec3(1.0 - rough), F0) - F0) * pow(1.0 - ndv, 5.0);
  // Deney odasının loş tavan/duvar yansıması: yukarı bakan yüzeyler daha aydınlık
  return F * ambCol(reflect(-V, n)) * ao * 0.9;
}

// ------------------------------------------------------------------
// Katı yüzey gölgelendirme: alevden gelen ışık (sonlu kaynak, yumuşak
// gölge) + ortam aydınlatması + akkor yayınım
// ------------------------------------------------------------------
vec3 shadeSolid(vec3 p, vec3 rd, float mat) {
  vec3 n = sceneNormal(p);
  vec3 V = -rd;
  vec3 Lv = uLight.xyz - p;
  float r2 = max(dot(Lv, Lv), 1e-8);
  float dist = sqrt(r2);
  vec3 L = Lv / dist;
  float E = uLight.w / (r2 + uLightR * uLightR);   // aydınlık [lx], sonlu kaynakla sınırlı
  float aw = clamp(uLightR / (2.0 * dist), 0.0, 0.8);
  // İnce levhada alev iki yüzde de yanar ve ışık kaynağı levha düzlemine yakındır;
  // SDF gölge ışını levhanın kendisini sıyırıp onu gölgede bırakırdı. Levha için
  // gölge yerine sonlu kaynağın açısal boyutuyla sarmalanmış aydınlatma kullanılır.
  float sh = uLight.w > 0.0 ? (mat == 5.0 ? 1.0 : softShadow(p + n * 0.00025, L, dist)) : 0.0;
  float ao = calcAO(p, n);
  vec3 lightRGB = uLightCol * E * sh;
  vec3 amb = ambCol(n) * ao;
  vec3 cell = toCell(p + n * uDx * 1.2);
  float Tloc = S(uSca, cell).r;
  vec3 col = vec3(0.0);

  if (mat == 1.0 || mat == 6.0) {
    // Fırçalanmış paslanmaz çelik
    vec3 F0 = vec3(0.56, 0.57, 0.58);
    float rough = mat == 6.0 ? 0.42 : 0.32;
    col = brdf(n, V, L, vec3(0.0), rough, F0, 1.0, aw) * lightRGB + envSpec(n, V, F0, rough, ao);
  } else if (mat == 8.0) {
    // Bal peteği akış düzenleyici: altıgen hücre deseni
    vec2 h = (p.xz - uSrc0.xy) / 0.0011;
    vec2 r = vec2(1.0, 1.7320508);
    vec2 a = mod(h, r) - r * 0.5;
    vec2 b = mod(h - r * 0.5, r) - r * 0.5;
    vec2 g = dot(a, a) < dot(b, b) ? a : b;
    float cellEdge = smoothstep(0.38, 0.46, length(g));
    vec3 alb = mix(vec3(0.02), vec3(0.16), cellEdge);
    col = brdf(n, V, L, alb, 0.6, vec3(0.04), 0.0, aw) * lightRGB + alb * amb;
  } else if (mat == 2.0) {
    // Parafin: yarı saydam; tepe kısmı alevin ışığını içeride saçar (alt yüzey saçılımı)
    vec3 alb = vec3(0.93, 0.90, 0.83);
    float wrap = max((dot(n, L) + 0.5) / 1.5, 0.0);
    float depth = max(uSrc0.w - p.y, 0.0);
    float sss = exp(-depth / 0.007);
    col = alb / PI * lightRGB * wrap * 0.85 + alb * amb;
    // Işık mumun gövdesinden geçerek sıcak tonda yayılır (sh gölgesinden bağımsız)
    col += alb * vec3(1.0, 0.62, 0.32) * uLightCol * E * 0.22 * sss / PI;
    col += brdf(n, V, L, vec3(0.0), 0.45, vec3(0.04), 0.0, aw) * lightRGB + envSpec(n, V, vec3(0.04), 0.45, ao);
  } else if (mat == 9.0) {
    // Erimiş parafin havuzu: berrak sıvı; alevin parlak yansıması ve içten ışıma
    vec3 F0 = vec3(0.035);
    col = brdf(n, V, L, vec3(0.0), 0.04, F0, 0.0, aw) * lightRGB + envSpec(n, V, F0, 0.04, ao);
    col += vec3(0.95, 0.72, 0.45) * uLightCol * E * 0.12 / PI;
  } else if (mat == 3.0) {
    // Fitil: kömürleşmiş pamuk, ucu akkor
    vec3 alb = vec3(0.035, 0.03, 0.026);
    col = brdf(n, V, L, alb, 0.85, vec3(0.03), 0.0, aw) * lightRGB + alb * amb;
    float tip = smoothstep(uSrc0.w + uSrc1.y * 0.4, uSrc0.w + uSrc1.y, p.y);
    // Fitil ucu kömürleşmiş pamuktur (ε ≈ 0,9) ve ~1000 K'e ısınır: koyu kızıl akkor
    col += lutGray(clamp(Tloc, 300.0, 1050.0)) * 0.9 * uGlowGain * tip;
  } else if (mat == 4.0) {
    // Sıvı yakıt damlası: Fresnel yansıma, alev ışığının kırılarak içten geçişi
    vec3 F0 = vec3(0.035);
    float ndv = max(dot(n, V), 0.0);
    float fres = 0.035 + 0.965 * pow(1.0 - ndv, 5.0);
    col = brdf(n, V, L, vec3(0.0), 0.03, F0, 0.0, aw) * lightRGB;
    col += vec3(0.85, 0.9, 1.0) * uLightCol * E * 0.05 * max(dot(-n, L), 0.0);
    col += fres * ambCol(reflect(-V, n)) * 0.9 + 0.015 * ambCol(n);
  } else if (mat == 5.0) {
    // Katı yakıt levhası: yanma ilerledikçe kömürleşme ve akkor piroliz cephesi
    ivec3 cc = ivec3(floor(p / uDx));
    vec4 st = texelFetch(uSolid, ivec2(clamp(cc.x, 0, uN.x - 1), clamp(cc.y, 0, uN.y - 1)), 0);
    float m = st.g;
    float burnt = 1.0 - m;
    vec3 alb = mix(uSheetColor, mix(vec3(0.05, 0.045, 0.04), vec3(0.55, 0.55, 0.52), uSheetInert), smoothstep(0.05, 0.9, burnt));
    float wsz = clamp(uLightR / max(dist, 1e-4), 0.0, 1.0);
    float wrap = (abs(dot(n, L)) + wsz) / (1.0 + wsz);
    col = alb / PI * lightRGB * wrap + alb * amb;
    col += lutGray(st.r) * 0.9 * uGlowGain;
  } else if (mat == 7.0) {
    // Kuvars lif
    vec3 alb = vec3(0.1);
    col = brdf(n, V, L, alb, 0.15, vec3(0.04), 0.0, aw) * lightRGB + alb * amb + envSpec(n, V, vec3(0.04), 0.15, ao);
    col += lutGray(Tloc) * 0.8 * uGlowGain * smoothstep(1000.0, 1600.0, Tloc);
  }
  return col;
}

// Zemin: mat koyu laboratuvar tezgâhı; alevin ışığı, katıların yumuşak gölgesi
// ve temas gölgesi; isteğe bağlı 1 cm ızgara
vec3 shadeFloor(vec3 p, vec3 rd) {
  vec3 n = vec3(0.0, 1.0, 0.0);
  vec3 Lv = uLight.xyz - p;
  float r2 = max(dot(Lv, Lv), 1e-8);
  float dist = sqrt(r2);
  vec3 L = Lv / dist;
  float E = uLight.w / (r2 + uLightR * uLightR);
  float sh = uLight.w > 0.0 ? softShadow(p + n * 0.0002, L, dist) : 0.0;
  float ao = 1.0;
  if (uShadows > 0.5) {
    float d0 = sceneSDF(p + n * 0.0025).x;
    ao = clamp(0.35 + 0.65 * d0 / 0.0025, 0.0, 1.0);
    if (uMOn > 0.5) {
      // Modelin masaya düşen temas gölgesi (iki ölçek)
      float h1 = 1.5 * uMGd, h2 = 5.0 * uMGd;
      float a1 = clamp(0.3 + 0.7 * modelSDF(p + n * h1) / h1, 0.0, 1.0);
      float a2 = clamp(0.55 + 0.45 * modelSDF(p + n * h2) / h2, 0.0, 1.0);
      ao = min(ao, a1 * a2);
    }
  }
  vec3 alb = vec3(0.05, 0.052, 0.058);
  if (uFloor > 1.5) {
    vec2 gp = p.xz / 0.01;
    vec2 g = abs(fract(gp + 0.5) - 0.5) / (fwidth(gp) * 1.2 + 1e-5);
    float line = 1.0 - min(min(g.x, g.y), 1.0);
    alb = mix(alb, vec3(0.13, 0.14, 0.16), line * 0.55);
  }
  float aw = clamp(uLightR / (2.0 * dist), 0.0, 0.8);
  vec3 col = brdf(n, -rd, L, alb, 0.55, vec3(0.035), 0.0, aw) * uLightCol * E * sh + alb * ambCol(n) * ao;
  vec3 Lk; float awk;
  float foff = 0.0006 + (uMOn > 0.5 ? 0.6 * uMGd : 0.0);
  float Ek = keyLight(p, n, foff, Lk, awk);
  if (Ek > 0.0) col += brdf(n, -rd, Lk, alb, 0.55, vec3(0.035), 0.0, awk) * KEY_COL * Ek;
  if (uSunE > 0.0 && uSunDir.y > 0.0) {
    float ss = softShadowR(p + n * foff, uSunDir, uSunReach, foff * 1.4 + 0.0004, uSunReach * 0.025);
    col += brdf(n, -rd, uSunDir, alb, 0.55, vec3(0.035), 0.0, 0.01) * uSunCol * uSunE * ss;
  }
  if (uFill.w > 0.0) col += brdf(n, -rd, uFill.xyz, alb, 0.55, vec3(0.035), 0.0, 0.1) * uFillCol * uFill.w * ao;
  float fade = exp(-length(p.xz - uBox.xz * 0.5) / uFloorFade);
  return col * fade;
}

vec3 burnGlow(float kelvin) {
  float t = clamp((kelvin - 800.0) / 2200.0, 0.0, 1.0);
  return vec3(1.0, pow(t, 1.6) * 0.9 + 0.02, pow(t, 4.0) * 0.75) * (0.06 + 3.2 * t * t * t);
}

// ------------------------------------------------------------------
// Model yüzeyi (GLB parçası): katılarla aynı ışık modeli. Gölge ve ortam
// kapatma model uzayındaki SDF'den; ölçekler voksel boyuyla büyür.
// ------------------------------------------------------------------
const vec3 ACCENT = vec3(0.078, 0.238, 0.930);   // #4f86f7 (doğrusal)
// burn: G-tamponundan (ısı, kömürleşme, titreşim)
vec3 shadeMesh(vec3 p, vec3 n, vec3 rd, int pid, vec3 burn, out bool flatOut) {
  vec4 m0 = texelFetch(uMPart, ivec2(pid, 0), 0);
  vec4 m1 = texelFetch(uMPart, ivec2(pid, 1), 0);
  vec4 m2 = texelFetch(uMPart, ivec2(pid, 2), 0);
  int st = int(m2.a + 0.5);
  bool hov = (st & 2) != 0, sel = (st & 4) != 0;
  vec3 V = -rd;
  float vox = uMGd;
  float ao = calcAO(p + n * 0.3 * vox, n, max(1.0, 2.5 * vox / 0.0036));
  float ndv = max(dot(n, V), 0.0);
  float rim = pow(1.0 - ndv, 3.0);
  flatOut = uMFlam > 0.5;
  if (flatOut) {
    // Yanıcılık görünümü: sınıf rengi, kameradan yumuşak ışık; pozlamadan bağımsız
    float lam = 0.42 + 0.58 * ndv;
    float hemi = 0.86 + 0.14 * n.y;
    vec3 c = m2.rgb * lam * hemi * mix(0.5, 1.0, ao);
    // Yapay zekâ: yanan parçanın yanında, tutuşması öngörülen "sıradaki" parça (macenta, yanıp söner)
    if ((st & 8) != 0) c = mix(c, vec3(1.0, 0.1, 0.65), 0.3 + 0.22 * sin(uAiPar[0].w * 5.0)) + vec3(1.0, 0.2, 0.8) * rim * 0.5;
    if (sel) c = mix(c, vec3(1.0), 0.18) + vec3(0.55, 0.7, 1.0) * rim * 0.9;
    if (hov) c += vec3(0.5) * (0.25 + rim);
    return c;
  }
  vec3 alb = m0.rgb;
  float rough = clamp(m0.a, 0.04, 1.0);
  float metal = m1.x;
  bool glass = m1.z > 0.5;
  // Yanık izi: kömürleşen yüzey kararır, matlaşır, metalik parlaklığını yitirir
  float bHeat = burn.x, bChar = burn.y, bFlick = burn.z;
  if (bChar > 0.0) {
    alb = mix(alb, vec3(0.016, 0.014, 0.013), bChar * 0.97);
    rough = mix(rough, 0.96, bChar);
    metal *= 1.0 - bChar;
  }
  vec3 F0 = glass ? vec3(0.04) : mix(vec3(0.04), alb, metal);
  vec3 Lv = uLight.xyz - p;
  float r2 = max(dot(Lv, Lv), 1e-8);
  float dist = sqrt(r2);
  vec3 L = Lv / dist;
  float E = uLight.w / (r2 + uLightR * uLightR);
  float aw = clamp(uLightR / (2.0 * dist), 0.0, 0.8);
  float sh = uLight.w > 0.0 && dot(n, L) > 0.0 ? softShadow(p + n * (0.6 * vox + 0.0003), L, dist, 0.8 * vox) : 0.0;
  vec3 lightRGB = uLightCol * E * sh;
  vec3 amb = ambCol(n) * ao;
  vec3 col;
  if (glass) {
    col = brdf(n, V, L, vec3(0.0), rough, F0, 0.0, aw) * lightRGB + envSpec(n, V, F0, rough, ao) + alb * amb;
  } else {
    col = brdf(n, V, L, alb, rough, F0, metal, aw) * lightRGB + alb * (1.0 - metal) * amb + envSpec(n, V, F0, rough, ao);
  }
  vec3 Lk; float awk;
  float Ek = keyLight(p, n, 0.6 * vox + 0.0003, Lk, awk);
  if (Ek > 0.0) col += brdf(n, V, Lk, glass ? vec3(0.0) : alb, rough, F0, glass ? 0.0 : metal, awk) * KEY_COL * Ek;
  // Güneş (yörünge arka planı): paralel ışık. Ayrı bir gölge ışını yürütülmez (gölgelendiricinin
  // derleme süresi); ortam kapatma girintileri karartır.
  if (uSunE > 0.0 && dot(n, uSunDir) > 0.0) {
    // Gölge ışını model uzaklık alanında yürür: güneş camlardan (uzaklık alanında yoklar) içeri girer
    float ss = softShadowR(p + n * (0.6 * vox + 0.0003), uSunDir, uSunReach, 0.8 * vox, uSunReach * 0.025);
    col += brdf(n, V, uSunDir, glass ? vec3(0.0) : alb, rough, F0, glass ? 0.0 : metal, 0.01) * uSunCol * uSunE * ss * (0.6 + 0.4 * ao);
  }
  // Dolgu (karşı ışık, Dünya ışığı): gölgesiz, ortam kapatmayla sınırlanır
  if (uFill.w > 0.0) col += brdf(n, V, uFill.xyz, glass ? vec3(0.0) : alb, rough, F0, glass ? 0.0 : metal, 0.12) * uFillCol * uFill.w * ao;
  // Camın ardı: uzay ve Dünya (kırılma ihmal edilir: aynı pikselin arka planı)
  if (glass && uBackdrop > 0.5) {
    float fr = 0.04 + 0.96 * pow(1.0 - ndv, 5.0);
    col += texelFetch(uBgTex, ivec2(gl_FragCoord.xy), 0).rgb * (1.0 - fr) * 0.9;
  }
  // Kor ve yanma cephesi ışıması
  if (bHeat > 0.0) {
    // Yüzey sıcaklığı T = 480 + 1250·ısı [K]; gözle görülür kızarma ~800 K'de başlar (Draper noktası)
    float ember = smoothstep(0.22, 0.45, bHeat) * (0.55 + 0.9 * bFlick);
    col += burnGlow(480.0 + 1250.0 * bHeat) * ember * 1.8 * uFxNit;
    float front = bChar * (1.0 - bChar) * 4.0;
    col += vec3(1.0, 0.3, 0.04) * front * bHeat * 3.0 * uFxNit;
  }
  // Seçim ve imleç: denetim mavisi kenar ışığı (görüntü biriminde)
  float hl = (sel ? 0.9 : 0.0) + (hov ? 0.6 : 0.0);
  if (hl > 0.0) col += ACCENT * (0.12 + rim) * hl * 0.5 / max(uExpTot, 1e-12);
  return col;
}

// Yapay zekâ görünümü: gerçekleşen yanık (koyu) ve yanan cephe (camgöbeği) ile modelin öngörüsü
// (macenta: öngörülen cephe ve yanmış bölge; beyaz kesikli: öngörülen son yayılma sınırı)
vec3 aiOverlay(vec3 c, vec3 p, vec3 burn, float px) {
  c = mix(c, c * 0.16, burn.y * 0.85);
  c += vec3(0.05, 0.75, 1.0) * smoothstep(0.2, 0.5, burn.x) * 0.9;
  px = max(px, 1e-5);
  for (int i = 0; i < 4; i++) {
    vec4 o = uAiOrg[i];
    if (o.w < 0.0) continue;
    vec4 q = uAiPar[i];
    float d = length(p - o.xyz);
    float inside = 1.0 - smoothstep(o.w - px, o.w + px, d);
    c = mix(c, vec3(1.0, 0.12, 0.72), inside * 0.38);
    float front = 1.0 - smoothstep(1.2, 2.6, abs(d - o.w) / px);
    c = mix(c, vec3(1.0, 0.3, 0.88), front);
    if (q.y > 0.0 && d > o.w && d < q.x) {
      float k = (d - o.w) / q.y;
      float iso = 1.0 - smoothstep(0.7, 1.7, abs(fract(k + 0.5) - 0.5) * q.y / px);
      c = mix(c, vec3(1.0, 0.62, 0.92), iso * 0.5 * step(k, q.z + 0.5));
    }
    float dash = step(0.5, fract((p.x + p.y + p.z) / (14.0 * px)));
    float fin = 1.0 - smoothstep(1.0, 2.2, abs(d - q.x) / px);
    c = mix(c, vec3(1.0), fin * dash * 0.9);
    // Tutuşma noktası: beyaz nokta ve sabit piksel boyutlu macenta halka (uzaktan da seçilir)
    c = mix(c, vec3(1.0, 0.3, 0.88), (1.0 - smoothstep(1.0, 2.2, abs(d / px - 12.0))) * 0.9);
    c = mix(c, vec3(1.0), 1.0 - smoothstep(3.0, 5.0, d / px));
  }
  return c;
}

// Bilimsel alan değeri (kesit ve sahte renk modları)
float fieldValue(int f, vec3 cp, out vec3 colOut) {
  vec4 s = S(uSca, cp);
  vec4 a = S(uAux, cp);
  float v = 0.0;
  if (f == 0) { v = (s.r - uSliceRange.x) / (uSliceRange.y - uSliceRange.x); colOut = inferno(v); }
  else if (f == 1) { v = log(1.0 + a.r) / log(1.0 + uSliceRange.y); colOut = inferno(v); }
  else if (f == 2) { v = s.a / max(uSliceRange.y, 1e-6); colOut = turbo(v); }
  else if (f == 3) { vec3 vv = S(uVel, cp).xyz; v = length(vv) / max(uSliceRange.y, 1e-6); colOut = turbo(v); }
  else if (f == 4) { v = s.g / max(uSliceRange.y, 1e-6); colOut = turbo(v); }
  else if (f == 5) { v = s.b / max(uYoAmb, 1e-6); colOut = coolwarm(1.0 - v); }
  else if (f == 6) { v = a.b / max(uSliceRange.y, 1e-6); colOut = coolwarm(0.5 + 0.5 * v); }
  else { v = a.g; colOut = turbo(v); }
  return v;
}

// Zamansal olarak düşük tutarsızlıklı titreşim: iç içe gradyan gürültüsü + altın oran
float ign(vec2 px, int frame) {
  float n = fract(52.9829189 * fract(0.06711056 * px.x + 0.00583715 * px.y));
  return fract(n + float(frame % 64) * 0.61803398875);
}

void main() {
  vec2 ndc = vUv * 2.0 - 1.0 + uJitter;
  vec4 p0 = uInvVP * vec4(ndc, -1.0, 1.0);
  vec4 p1 = uInvVP * vec4(ndc, 1.0, 1.0);
  p0 /= p0.w; p1 /= p1.w;
  vec3 ro = uCamPos;
  vec3 rd = normalize(p1.xyz - p0.xyz);

  bool falseColor = uView != 0;
  // Arka plan: loş deney odası, üstten hafif aydınlık
  vec3 bg = falseColor ? vec3(0.014, 0.015, 0.018) : vec3(uAmbientL * 0.012) * (0.75 + 0.5 * clamp(rd.y + 0.3, 0.0, 1.0));
  if (uBackdrop > 0.5 && !falseColor) bg = texelFetch(uBgTex, ivec2(gl_FragCoord.xy), 0).rgb;
  float tFloor = 1e9;
  if (uFloor > 0.5 && rd.y < -1e-4) {
    float tf = -ro.y / rd.y;
    if (tf > 0.0) tFloor = tf;
  }

  vec2 tb = boxHit(ro, rd, vec3(0.0), uBox);
  bool hitBox = tb.y > tb.x;
  float mat = 0.0;
  float tSolid = 1e9;
  if (hitBox) {
    float t0s = max(tb.x - 0.002, 0.0);
    tSolid = traceSolids(ro + rd * t0s, rd, tb.y - t0s + 0.004, mat);
    if (tSolid < 1e8) tSolid += t0s;
  }
  // Model yüzeyi (G-tamponu): aynı ışın, aynı alt piksel kayması
  int mpid = -1;
  vec3 mN = vec3(0.0, 1.0, 0.0);
  vec3 mBurn = vec3(0.0);
  if (uMOn > 0.5) {
    vec4 gb = texelFetch(uGB0, ivec2(gl_FragCoord.xy), 0);
    if (gb.x > 0.0 && gb.x < tSolid) {
      tSolid = gb.x;
      mat = 20.0;
      mN = normalize(gb.yzw);
      vec4 g1 = texelFetch(uGB1, ivec2(gl_FragCoord.xy), 0);
      mpid = int(g1.x + 0.5) - 1;
      mBurn = g1.yzw;
    }
  }
  float tEnd = min(tSolid, tFloor);

  // Kesit düzlemi
  float tSlice = 1e9;
  vec3 sliceCol = vec3(0.0);
  if (uSlice.x > 0.5) {
    int ax = int(uSlice.z);
    float planePos = uSlice.w * uBox[ax];
    float den = rd[ax];
    if (abs(den) > 1e-6) {
      float ts = (planePos - ro[ax]) / den;
      vec3 ps = ro + rd * ts;
      if (ts > 0.0 && ts < tEnd && all(greaterThanEqual(ps, vec3(0.0))) && all(lessThanEqual(ps, uBox))) {
        tSlice = ts;
        vec3 cc;
        fieldValue(int(uSlice.y), toCell(ps), cc);
        sliceCol = cc;
      }
    }
  }

  vec3 L = vec3(0.0);
  vec3 trans = vec3(1.0);
  float opd = 0.0;
  float tW = 0.0, wSum = 0.0;
  if (hitBox) {
    float ds = uStep * uDx;
    float t = tb.x + ds * ign(gl_FragCoord.xy, uFrame);
    float tStop = min(min(tb.y, tEnd), tSlice);
    // Boş alan atlama: soğuk ve kurumsuz gazda kaba adım. Sıcak bir örneğe kaba adımla
    // varılırsa bir kaba adım geri dönülür ve en az 'fine' örnek boyunca ince adımla
    // ilerlenir (ince tepkime kabuğu atlanmaz, ışın sınırda salınmaz).
    // Hız, tür ve Schlieren kipleri soğuk gazı da gösterir; onlarda atlama yapılmaz.
    bool canSkip = uView != 5 && uView != 6 && uView != 7 && uView != 8;
    const float COARSE = 2.5;
    bool skipped = false;
    int fine = 0;
    for (int i = 0; i < 420; i++) {
      if (t > tStop) break;
      vec3 pw = ro + rd * t;
      vec3 cp = toCell(pw);
      vec4 s = S(uSca, cp);
      float T = s.r;
      bool hot = T > uTamb + 25.0 || s.a > 0.02;
      if (canSkip && !hot) {
        if (fine > 0) { fine--; t += ds; skipped = false; continue; }
        t += ds * COARSE;
        skipped = true;
        continue;
      }
      if (canSkip && skipped) {
        t = max(tb.x, t - ds * COARSE);
        skipped = false;
        fine = 4;
        continue;
      }
      fine = 4;
      vec4 a = S(uAux, cp);
      float fv = max(s.a, 0.0) * 1e-6;
      float wgt = 0.0;
      if (uView == 0) {
        // Kurum: j = κ_λ B_λ(T) (LUT), κ_λ = 4,9 f_v / λ; tepkime bölgesi: kemilüminesans
        vec3 em = fv * lutSoot(T) * uSootGain;
        em += max(a.r, 0.0) * 1e6 * uChemCol * uChemGain;
        em += max(a.a, 0.0) * 1e6 * uCoolCol * uCoolGain;
        vec3 kap = fv * uSootAbs;
        vec3 tau = kap * ds;
        // Hücre içinde yayınım–soğurma çözümü: ∫ j e^{−κs} ds = j (1 − e^{−τ}) / κ
        vec3 att = exp(-tau);
        vec3 contrib = mix(em * ds, em * (1.0 - att) / max(kap, vec3(1e-9)), step(vec3(1e-4), tau));
        L += trans * contrib;
        wgt = dot(trans * contrib, vec3(0.2126, 0.7152, 0.0722));
        trans *= att;
      } else if (uView == 1) {
        // Termal kamera: gri gaz + kurum toplam Planck ortalama yayınımı
        float Yp = a.g;
        float Yd = max(1.0 - s.g - s.b - Yp, 0.0);
        float invW = invMolar(s.g, s.b, Yp, Yd);
        float kap = kappaPlanck(max(T, 200.0), Yp, Yd, invW, fv) * 4.0 + 0.002;
        float B = SIGMA_SB * pow(T, 4.0) / PI;
        float att = exp(-kap * ds);
        L += trans * vec3(B * (1.0 - att));
        wgt = trans.r * B * (1.0 - att);
        trans *= vec3(att);
      } else if (uView == 7) {
        // Schlieren: ışın boyunca kırılma indisi farkının integrali, (n − n∞) ∝ (ρ/ρ∞ − 1)
        float Yp = a.g;
        float Yd = max(1.0 - s.g - s.b - Yp, 0.0);
        float W = 1.0 / invMolar(s.g, s.b, Yp, Yd);
        float dr = (W / uWamb) * (uTamb / max(T, 150.0)) - 1.0;
        opd += dr * ds;
        wgt = abs(dr);
      } else {
        vec3 cc;
        float v;
        float op;
        if (uView == 2) {
          v = (T - uTamb) / max(uFalseRange - uTamb, 1.0);
          cc = inferno(0.12 + 0.88 * v);
          op = smoothstep(0.02, 0.25, v) * 140.0;
        } else if (uView == 3) {
          v = log(1.0 + max(a.r, 0.0)) / log(1.0 + uFalseRange);
          cc = inferno(0.15 + 0.85 * v);
          op = smoothstep(0.03, 0.2, v) * 260.0;
        } else if (uView == 4) {
          v = s.a / max(uFalseRange, 1e-6);
          cc = mix(vec3(0.55, 0.5, 0.45), turbo(v), 0.75);
          op = smoothstep(0.01, 0.15, v) * 300.0;
        } else if (uView == 8) {
          // Işınım: gelen ışınımın ortam üstü kısmı G − 4σT∞⁴ (log ölçek)
          float Gex = max(CSv(uGr, cp).r, 0.0);
          v = log(1.0 + Gex / 20.0) / log(1.0 + uFalseRange * 1000.0 / 20.0);
          cc = inferno(0.1 + 0.9 * clamp(v, 0.0, 1.0));
          // Yalnız yüksek akılı çekirdek görünsün; duvarlar arkadan okunabilsin
          op = smoothstep(0.45, 1.0, v) * 30.0;
        } else if (uView == 5) {
          vec3 vv = S(uVel, cp).xyz;
          v = length(vv) / max(uFalseRange, 1e-6);
          cc = turbo(v);
          op = smoothstep(0.03, 0.3, v) * smoothstep(uTamb + 30.0, uTamb + 300.0, T) * 120.0;
        } else if (uView == 9) {
          // Yapay zekâ görünümü: gerçekleşen alev (tepkime bölgesi) camgöbeği-beyaz
          v = log(1.0 + max(a.r, 0.0)) / log(1.0 + uFalseRange);
          cc = mix(vec3(0.05, 0.75, 1.0), vec3(1.0), clamp(v, 0.0, 1.0));
          op = smoothstep(0.03, 0.2, v) * 260.0;
        } else {
          // Türler: yakıt (yeşil) ve oksijen tükenmesi (mavi)
          float yf = s.g / max(uFalseRange, 1e-6);
          float od = clamp(1.0 - s.b / max(uYoAmb, 1e-6), 0.0, 1.0);
          cc = vec3(0.15, 0.95, 0.45) * yf + vec3(0.25, 0.45, 1.0) * od;
          v = max(yf, od);
          op = smoothstep(0.03, 0.3, v) * 120.0;
        }
        float al = 1.0 - exp(-op * ds);
        L += trans * cc * al;
        wgt = trans.r * al;
        trans *= 1.0 - al;
      }
      tW += t * wgt;
      wSum += wgt;
      if (max(trans.r, max(trans.g, trans.b)) < 0.004) break;
      t += ds;
    }
  }

  // Arkadaki: kesit, katı, zemin, arka plan
  vec3 behind = bg;
  float solidMask = 0.0;
  float tBehind = 1e9;
  float surfHeat = 0.0, surfChar = 0.0;   // model yüzeyinin yanık izi (bilimsel görünümler için)
  if (tSlice < 1e8) {
    behind = falseColor ? sliceCol : sliceCol * uSliceGain;
    tBehind = tSlice;
  } else if (tSolid < tFloor && tSolid < 1e8) {
    vec3 ps = ro + rd * tSolid;
    if (mat == 20.0 && falseColor && uMFlam < 0.5) {
      // Bilimsel görünümler: model pozlamadan bağımsız "kil" gölgelendirmesiyle çizilir
      // (biçim okunur, veri renkleriyle yarışmaz); yüzeyin ısısı ve isi görünüme göre boyanır
      vec4 mA = texelFetch(uMPart, ivec2(max(mpid, 0), 0), 0);
      float ndv = abs(dot(mN, rd));
      float lumA = clamp(dot(mA.rgb, vec3(0.3, 0.5, 0.2)), 0.0, 1.0);
      behind = vec3(0.03 + 0.1 * ndv) * (0.5 + 0.9 * sqrt(lumA)) * (0.85 + 0.15 * mN.y);
      surfHeat = mBurn.x;
      surfChar = mBurn.y;
      behind = mix(behind, vec3(0.01), surfChar * 0.75);
    } else if (mat == 20.0) {
      bool flatC;
      behind = shadeMesh(ps, mN, rd, max(mpid, 0), mBurn, flatC);
      if (flatC) { if (!falseColor) behind /= max(uExpTot, 1e-12); }
      else if (falseColor) behind = behind / (behind + 1.0) * 0.6 + 0.05;
      if (uView == 9) behind = aiOverlay(pow(max(behind, vec3(0.0)), vec3(1.0 / 2.2)), ps, mBurn, tSolid * uAiPx);
    } else {
      behind = shadeSolid(ps, rd, mat);
      if (falseColor) behind = behind / (behind + 1.0) * 0.6 + 0.05;
    }
    solidMask = 1.0;
    tBehind = tSolid;
  } else if (uView == 8 && hitBox && tb.y < tFloor - 1e-4) {
    // Işınım görünümü: alanın arka duvarları ışınım akısı ölçen panellerdir
    vec3 pe = ro + rd * tb.y;
    float q = max(CSv(uGr, toCell(pe)).g, 0.0);
    float vq = log(1.0 + q / 20.0) / log(1.0 + uFalseRange * 1000.0 / 20.0);
    behind = inferno(0.05 + 0.95 * clamp(vq, 0.0, 1.0)) * 0.75;
    tBehind = tb.y;
  } else if (tFloor < 1e8) {
    vec3 pf = ro + rd * tFloor;
    behind = shadeFloor(pf, rd);
    if (uView == 8 && all(greaterThanEqual(pf.xz, vec2(0.0))) && all(lessThanEqual(pf.xz, uBox.xz))) {
      // Masaya gelen ışınım ısı akısı q = Σ P cos θ / (4πr²) (oda ışınımı üstü)
      float q = max(CSv(uGr, toCell(vec3(pf.x, 0.5 * uDx, pf.z))).a, 0.0);
      float vq = log(1.0 + q / 20.0) / log(1.0 + uFalseRange * 1000.0 / 20.0);
      behind = inferno(0.05 + 0.95 * clamp(vq, 0.0, 1.0)) * 0.9;
    } else if (falseColor) behind = vec3(0.02, 0.022, 0.028) + 0.04 * behind / (behind + 1.0);
    tBehind = tFloor;
  }

  // Yanan / kızgın model yüzeyi: kor ~800 K üstünde (T = 480 + 1250·ısı)
  float Tsurf = mix(uTamb, 480.0 + 1250.0 * surfHeat, smoothstep(0.0, 0.06, surfHeat));
  if (surfHeat > 0.0 || surfChar > 0.0) {
    if (uView == 2) {
      float vT = clamp((Tsurf - uTamb) / max(uFalseRange - uTamb, 1.0), 0.0, 1.0);
      behind = mix(behind, inferno(0.12 + 0.88 * vT), smoothstep(0.02, 0.2, vT));
    } else if (uView == 3) {
      float fr = clamp(surfChar * (1.0 - surfChar) * 4.0 * surfHeat * 1.6 + 0.5 * surfHeat * (1.0 - surfChar), 0.0, 1.0);
      behind = mix(behind, inferno(0.15 + 0.85 * fr), smoothstep(0.04, 0.3, fr));
    } else if (uView == 4) {
      behind = mix(behind, mix(vec3(0.55, 0.5, 0.45), turbo(surfChar), 0.75) * 0.55, surfChar * 0.85);
    } else if (uView == 8) {
      float qs = SIGMA_SB * (pow(Tsurf, 4.0) - pow(uTamb, 4.0));
      float vq = clamp(log(1.0 + qs / 20.0) / log(1.0 + uFalseRange * 1000.0 / 20.0), 0.0, 1.0);
      behind = mix(behind, inferno(0.05 + 0.95 * vq) * 0.9, smoothstep(0.02, 0.2, vq));
    } else if (uView == 6) {
      behind += vec3(0.25, 0.45, 1.0) * surfHeat * 0.5;
    }
  }
  if (uMaskPass > 0.5) behind = vec3(0.0);
  vec3 outc;
  if (uView == 1) {
    // Termal kamera: log ölçekli ışıma → inferno. Arkadaki yüzey kendi sıcaklığında ışır;
    // ortam sıcaklığındaki nesneler de yayıcılık / bakış açısı farkıyla soluk biçimde seçilir.
    float lo = SIGMA_SB * pow(uTamb, 4.0) / PI;
    float I = L.r + trans.r * SIGMA_SB * pow(solidMask > 0.5 ? Tsurf : uTamb, 4.0) / PI;
    float hi = SIGMA_SB * pow(uFalseRange, 4.0) / PI * 0.25;
    float v = max(log(I / lo) / log(hi / lo), 0.0);
    if (solidMask > 0.5 && tSlice > 1e8) v += trans.r * min(dot(behind, vec3(0.3333)), 0.22) * 0.9;
    outc = inferno(clamp(v, 0.0, 1.0));
  } else if (uView == 7) {
    outc = vec3(0.0);
  } else {
    outc = L + trans * behind;
  }
  outc *= uPreExp;
  // Yarım duyarlıklı hedef ve zamansal biriktirme 6e4 üstünde bozulur.
  if (any(isnan(outc)) || any(isinf(outc))) outc = vec3(0.0);
  outc = min(max(outc, vec3(0.0)), vec3(80.0));

  // Yeniden izdüşüm derinliği: yayınım ağırlıklı ortalama derinlik; yoksa arkadaki yüzey
  float depth;
  if (wSum > 1e-6 && (tBehind > 1e8 || wSum > 0.05 * dot(behind, vec3(0.33)))) depth = tW / wSum;
  else if (tBehind < 1e8) depth = tBehind;
  else depth = hitBox ? 0.5 * (tb.x + tb.y) : length(uBox * 0.5 - ro);
  oColor = vec4(outc, 1.0);
  // .a: katı yüzeye ışın boyu uzaklık (yangın efektlerinin örtülmesi ve yumuşak kesişimi)
  oAux = vec4(depth, opd, solidMask, min(min(tSolid, tFloor), 6.0e4));
}
`;

/* ------------------------------------------------------------------ */
/* Uzay arka planı: ışın yürütücüyle aynı kamera ve alt piksel kayması   */
/* ------------------------------------------------------------------ */
FL.SHADERS.backdrop = () => FL.SHADERS.header + `
in vec2 vUv;
uniform mat4 uInvVP;
uniform vec2 uJitter;
uniform vec3 uSunDir;
uniform float uSpaceL;           // Dünya'nın gündüz yüzünün ışıklılığı [cd/m²]
uniform float uSpaceT;           // yavaş dönüş için zaman [s]
uniform float uPreExp;
uniform vec4 uSunDisc;           // güneş diski: renk × ışıklılık [cd/m²] (w: açık)
out vec4 oColor;
// ------------------------------------------------------------------
// Uzaydan Dünya'ya bakış: analitik küre (geometri yok), işlemsel kıtalar,
// bulutlar, gündüz/gece sınırı, atmosfer halesi ve yıldızlar. Sonsuzdadır
// (paralaks yok): kamera konumu değil yalnız bakış yönü kullanılır.
// ------------------------------------------------------------------
float bgHash(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}
float bgNoise(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = mix(mix(bgHash(i), bgHash(i + vec3(1, 0, 0)), f.x), mix(bgHash(i + vec3(0, 1, 0)), bgHash(i + vec3(1, 1, 0)), f.x), f.y);
  float b = mix(mix(bgHash(i + vec3(0, 0, 1)), bgHash(i + vec3(1, 0, 1)), f.x), mix(bgHash(i + vec3(0, 1, 1)), bgHash(i + vec3(1, 1, 1)), f.x), f.y);
  return mix(a, b, f.z);
}
float bgFbm(vec3 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { v += a * bgNoise(p); p = p * 2.03 + 17.1; a *= 0.5; }
  return v / 0.96875;
}
const vec3 EARTH_C = vec3(-25.0, -132.0, -55.0);
const float EARTH_R = 120.0;
vec3 spaceBackdrop(vec3 rd) {
  vec3 col = vec3(0.0);
  // Yıldızlar: yön uzayında seyrek hücreler
  vec3 q = rd * 190.0;
  vec3 id = floor(q);
  float h = bgHash(id);
  if (h > 0.988) {
    vec3 f = fract(q) - 0.5 - (vec3(bgHash(id + 1.7), bgHash(id + 5.3), bgHash(id + 9.1)) - 0.5) * 0.6;
    float w = bgHash(id + 2.0);
    float br = 0.25 + 1.4 * pow(bgHash(id + 4.0), 3.0);
    col += vec3(0.8 + 0.2 * w, 0.85, 1.0 - 0.2 * w) * br * smoothstep(0.16, 0.0, length(f)) * 0.06;
  }
  float b = dot(rd, EARTH_C);
  float cc = dot(EARTH_C, EARTH_C) - EARTH_R * EARTH_R;
  float disc = b * b - cc;
  if (b > 0.0 && disc > 0.0) {
    float t = b - sqrt(disc);
    vec3 n = normalize(rd * t - EARTH_C);
    // Yavaş dönüş (y ekseni)
    float ang = uSpaceT * 0.004;
    vec3 m = vec3(cos(ang) * n.x + sin(ang) * n.z, n.y, -sin(ang) * n.x + cos(ang) * n.z);
    float continents = bgFbm(m * 2.4 + 3.7);
    float land = smoothstep(0.5, 0.56, continents);
    vec3 ocean = vec3(0.012, 0.05, 0.16);
    vec3 ground = mix(vec3(0.05, 0.11, 0.04), vec3(0.2, 0.16, 0.09), bgFbm(m * 9.0));
    vec3 surface = mix(ocean, ground, land);
    float clouds = smoothstep(0.5, 0.72, bgFbm(m * 4.3 + vec3(uSpaceT * 0.002, 9.1, 0.0)) * 0.7 + bgFbm(m * 13.0) * 0.3);
    surface = mix(surface, vec3(0.85), clouds * 0.85);
    float light = dot(n, uSunDir);
    float day = smoothstep(-0.12, 0.45, light);
    float rim = pow(1.0 - max(dot(n, -rd), 0.0), 3.5);
    col = surface * (0.02 + 1.25 * day) + vec3(0.25, 0.5, 1.0) * rim * (0.1 + 0.9 * day) * 1.3;
  } else if (b > 0.0) {
    // Atmosfer halesi: uzvun hemen dışında ince mavi kabuk
    float dmin = sqrt(max(dot(EARTH_C, EARTH_C) - b * b, 0.0));
    float hh = (dmin - EARTH_R) / (EARTH_R * 0.018);
    vec3 n = normalize(rd * b - EARTH_C);
    float day = smoothstep(-0.2, 0.4, dot(n, uSunDir));
    col += vec3(0.3, 0.55, 1.0) * exp(-max(hh, 0.0) * 2.6) * day * 1.1;
  }
  col *= uSpaceL;
  // Güneş: Dünya'nın önünde değilse disk, taç ve geniş hale. Gerçek diskin (0,27°) birkaç katı
  // çizilir ki görüntüde seçilsin; ışıklılığı doyuma gider, parlama zinciri halesini büyütür.
  if (uSunDisc.w > 0.5 && !(b > 0.0 && disc > 0.0)) {
    float c = dot(rd, uSunDir);
    float ang = acos(clamp(c, -1.0, 1.0));
    float core = 1.0 - smoothstep(0.012, 0.016, ang);
    float corona = exp(-ang * 55.0) * 0.22 + exp(-ang * 11.0) * 0.004;
    // Işın çatalı: ince, dönen dört kol (mercek kırınımı izlenimi)
    vec3 t1 = normalize(cross(uSunDir, vec3(0.0, 1.0, 0.0)));
    vec3 t2 = cross(uSunDir, t1);
    vec2 q2 = vec2(dot(rd, t1), dot(rd, t2));
    float spikes = (exp(-abs(q2.x) * 300.0) + exp(-abs(q2.y) * 300.0)) * exp(-ang * 26.0) * 0.06 * step(0.0, c);
    col += uSunDisc.rgb * (core + corona + spikes);
  }
  return col;
}

void main() {
  vec2 ndc = vUv * 2.0 - 1.0 + uJitter;
  vec4 p0 = uInvVP * vec4(ndc, -1.0, 1.0);
  vec4 p1 = uInvVP * vec4(ndc, 1.0, 1.0);
  p0 /= p0.w; p1 /= p1.w;
  vec3 rd = normalize(p1.xyz - p0.xyz);
  oColor = vec4(min(spaceBackdrop(rd), vec3(6.0e4)), 1.0);
}
`;

/* ------------------------------------------------------------------ */
/* Zamansal biriktirme (TAA): yeniden izdüşüm + komşuluk kırpma        */
/* ------------------------------------------------------------------ */
FL.SHADERS.temporal = () => FL.SHADERS.header + `
in vec2 vUv;
uniform sampler2D uCur;
uniform sampler2D uDepth;
uniform sampler2D uHist;
uniform mat4 uInvVP;
uniform mat4 uPrevVP;
uniform vec3 uCamPos;
uniform vec2 uTexel;
uniform float uAlpha;      // yeni karenin ağırlığı
uniform float uExpRatio;   // geçmişin ön pozlamasını bu kareye taşı
uniform int uValid;
out vec4 o;

vec3 tm(vec3 c) { return c / (1.0 + max(c.r, max(c.g, c.b))); }
vec3 itm(vec3 c) {
  float m = min(max(c.r, max(c.g, c.b)), 0.97);
  return c / max(1.0 - m, 1e-3);
}

void main() {
  vec3 c = tm(texture(uCur, vUv).rgb);
  if (uValid == 0) { o = vec4(itm(c), 1.0); return; }
  vec3 m1 = c, m2 = c * c, mn = c, mx = c;
  for (int j = -1; j <= 1; j++)
  for (int i = -1; i <= 1; i++) {
    if (i == 0 && j == 0) continue;
    vec3 s = tm(texture(uCur, vUv + vec2(float(i), float(j)) * uTexel).rgb);
    m1 += s; m2 += s * s; mn = min(mn, s); mx = max(mx, s);
  }
  m1 /= 9.0; m2 /= 9.0;
  vec3 sig = sqrt(max(m2 - m1 * m1, 0.0));
  vec3 lo = max(mn, m1 - 1.25 * sig), hi = min(mx, m1 + 1.25 * sig);

  float d = texture(uDepth, vUv).r;
  vec2 ndc = vUv * 2.0 - 1.0;
  vec4 a = uInvVP * vec4(ndc, -1.0, 1.0);
  vec4 b = uInvVP * vec4(ndc, 1.0, 1.0);
  a /= a.w; b /= b.w;
  vec3 wp = uCamPos + normalize(b.xyz - a.xyz) * d;
  vec4 q = uPrevVP * vec4(wp, 1.0);
  vec2 puv = q.xy / q.w * 0.5 + 0.5;
  if (q.w <= 0.0 || any(lessThan(puv, vec2(0.0))) || any(greaterThan(puv, vec2(1.0)))) { o = vec4(itm(c), 1.0); return; }
  vec3 h = tm(texture(uHist, puv).rgb * uExpRatio);
  h = clamp(h, lo, hi);
  o = vec4(itm(mix(h, c, uAlpha)), 1.0);
}
`;

/* ------------------------------------------------------------------ */
/* Parlama (bloom): enerji koruyan aşağı/yukarı örnekleme              */
/* ------------------------------------------------------------------ */
FL.SHADERS.down = () => FL.SHADERS.header + `
in vec2 vUv;
uniform sampler2D uSrc;
uniform vec2 uTexel;
uniform int uKaris;    // ilk seviyede parlak tek piksellerin (ateş böceği) baskınlığını azalt
out vec4 o;
vec3 fetch(vec2 off) {
  vec3 c = texture(uSrc, vUv + uTexel * off).rgb;
  if (any(isnan(c)) || any(isinf(c))) c = vec3(0.0);
  return c;
}
float kw(vec3 c) { return uKaris == 1 ? 1.0 / (1.0 + dot(c, vec3(0.2126, 0.7152, 0.0722))) : 1.0; }
void main() {
  // 13 örnekli aşağı örnekleme (Jimenez 2014)
  vec3 a = fetch(vec2(-2, 2)), b = fetch(vec2(0, 2)), c = fetch(vec2(2, 2));
  vec3 d = fetch(vec2(-2, 0)), e = fetch(vec2(0, 0)), f = fetch(vec2(2, 0));
  vec3 g = fetch(vec2(-2, -2)), h = fetch(vec2(0, -2)), i = fetch(vec2(2, -2));
  vec3 j = fetch(vec2(-1, 1)), k = fetch(vec2(1, 1)), l = fetch(vec2(-1, -1)), m = fetch(vec2(1, -1));
  vec3 g0 = (j + k + l + m) * 0.25;
  vec3 g1 = (a + b + d + e) * 0.25, g2 = (b + c + e + f) * 0.25;
  vec3 g3 = (d + e + g + h) * 0.25, g4 = (e + f + h + i) * 0.25;
  float w0 = kw(g0) * 0.5, w1 = kw(g1) * 0.125, w2 = kw(g2) * 0.125, w3 = kw(g3) * 0.125, w4 = kw(g4) * 0.125;
  vec3 r = (g0 * w0 + g1 * w1 + g2 * w2 + g3 * w3 + g4 * w4) / (w0 + w1 + w2 + w3 + w4);
  o = vec4(max(r, 0.0), 1.0);
}
`;

FL.SHADERS.up = () => FL.SHADERS.header + `
in vec2 vUv;
uniform sampler2D uSrc;     // düşük çözünürlük
uniform sampler2D uBase;    // aynı seviyedeki aşağı örneklenmiş görüntü
uniform vec2 uTexel;
uniform float uRadius;
out vec4 o;
void main() {
  vec2 t = uTexel * uRadius;
  vec3 s = texture(uSrc, vUv + vec2(-t.x, t.y)).rgb * 1.0 + texture(uSrc, vUv + vec2(0.0, t.y)).rgb * 2.0
         + texture(uSrc, vUv + vec2(t.x, t.y)).rgb * 1.0 + texture(uSrc, vUv + vec2(-t.x, 0.0)).rgb * 2.0
         + texture(uSrc, vUv).rgb * 4.0 + texture(uSrc, vUv + vec2(t.x, 0.0)).rgb * 2.0
         + texture(uSrc, vUv + vec2(-t.x, -t.y)).rgb * 1.0 + texture(uSrc, vUv + vec2(0.0, -t.y)).rgb * 2.0
         + texture(uSrc, vUv + vec2(t.x, -t.y)).rgb * 1.0;
  // Seviyeler eşit ağırlıkla karışır; sonuç ortalama kalır (enerji korunur)
  o = vec4(mix(texture(uBase, vUv).rgb, s / 16.0, 0.5), 1.0);
}
`;

/* ------------------------------------------------------------------ */
/* Fiziksel kamera: obtüratör (pozlama süresi boyunca birikim)          */
/* ------------------------------------------------------------------ */
/*
 * Sensör, obtüratör açık kaldığı süre (t) boyunca gelen ışığı toplar. Alev
 * 10–15 Hz titrer; 1/30 s'de titreşim bulanır, 1/2000 s'de donar. Her kare,
 * önceki birikimle benzetim zamanı adımına göre karıştırılır:
 *     acc ← acc + (1 − e^{−Δt/t}) (cur − acc)
 * Kamera hareket ederse ya da sahne sıfırlanırsa birikim baştan başlar.
 */
FL.SHADERS.shutter = () => FL.SHADERS.header + `
in vec2 vUv;
uniform sampler2D uCur;
uniform sampler2D uAcc;
uniform float uA;          // karışım oranı
uniform float uRatio;      // ön pozlama değiştiyse geçmişin ölçeği
out vec4 o;
void main() {
  vec3 c = texture(uCur, vUv).rgb;
  vec3 h = texture(uAcc, vUv).rgb * uRatio;
  o = vec4(mix(h, c, uA), 1.0);
}
`;

/* ------------------------------------------------------------------ */
/* Fiziksel kamera: alan derinliği (ince mercek, karışıklık çemberi)    */
/* ------------------------------------------------------------------ */
/*
 * İnce mercek: odak uzaklığı d_f'deki düzlem keskin; d uzaklığındaki noktanın
 * sensördeki karışıklık çemberi çapı  c = A · f · |d − d_f| / (d · (d_f − f)),
 * A = f/N açıklık çapı. c piksele çevrilir (sensör genişliği → kare genişliği).
 * Toplayıcı (gather) bulanıklık: her örnek, kendi çemberi bu pikseli
 * kapsıyorsa katkı verir (önde bulanık nesne, arkada keskin nesneye taşar).
 */
FL.SHADERS.dof = () => FL.SHADERS.header + `
in vec2 vUv;
uniform sampler2D uSrc;
uniform sampler2D uDepthT;  // .r: ışın boyunca derinlik [m]
uniform vec2 uTexel;
uniform vec3 uDof;          // (K [piksel·m], d_f [m], en büyük yarıçap [piksel])
out vec4 o;
float cocPx(float d) {
  d = max(d, 1e-4);
  return min(uDof.x * abs(d - uDof.y) / d, uDof.z);
}
void main() {
  vec3 c0 = texture(uSrc, vUv).rgb;
  float r0 = cocPx(texture(uDepthT, vUv).r) * 0.5;
  if (uDof.z < 0.5) { o = vec4(c0, 1.0); return; }
  vec3 acc = c0;
  float wsum = 1.0;
  float R = uDof.z * 0.5;
  const int N = 40;
  for (int i = 1; i < N; i++) {
    // altın açı sarmalı: diskte düzgün örnekler
    float fi = float(i);
    float rr = sqrt(fi / float(N)) * R;
    float an = fi * 2.39996323;
    vec2 off = vec2(cos(an), sin(an)) * rr;
    vec2 uv = vUv + off * uTexel;
    float ri = cocPx(texture(uDepthT, uv).r) * 0.5;
    // örneğin çemberi bu pikseli kapsıyor mu; ya da bu pikselin kendi çemberi örneği kapsıyor mu
    float w = clamp(max(ri, min(r0, ri + 1.0)) - rr + 1.0, 0.0, 1.0);
    w /= max(ri * ri, 1.0);
    acc += texture(uSrc, uv).rgb * w;
    wsum += w;
  }
  o = vec4(acc / wsum, 1.0);
}
`;

/* ------------------------------------------------------------------ */
/* Son işlem: Catmull–Rom büyütme, pozlama, film eğrisi, sRGB, titreşim */
/* ------------------------------------------------------------------ */
FL.SHADERS.composite = () => FL.SHADERS.header + COLORMAPS + `
in vec2 vUv;
uniform sampler2D uHDR;
uniform sampler2D uBloom;
uniform sampler2D uAuxT;     // (derinlik, OPD, katı maskesi)
uniform vec2 uSrcSize;
uniform float uExposure;     // ön pozlamaya göre kalan çarpan
uniform float uBloomAmt;
uniform int uFalse;          // bilimsel mod: ton eşleme yok
uniform int uSchlieren;      // 0 kapalı, 1 bıçak kenarı, 2 renkli
uniform float uSchGain;
uniform sampler2D uFxPt;     // nesne yangınının sıcak gazı (yoğunluk açığı, .a)
uniform float uFxSch;        // 1: Schlieren'e nesne yangını da katılır
uniform vec2 uSchScale;      // (1/görüş genişliği, 1/görüş yüksekliği) × duyarlılık [1/m]
uniform int uTonemap;        // 0 AgX, 1 ACES, 2 Nötr
uniform int uFrame;
uniform float uVignette;
uniform vec2 uViewport;
// Fiziksel kamera
uniform vec4 uCam;           // (açık, görünüm dönüşümü 0 Standart/1 AgX, gürültü, doğal vinyet)
uniform vec3 uWB;            // beyaz dengesi kazançları (doğrusal)
uniform vec2 uSensorN;       // (doyma elektronu, okuma gürültüsü e⁻)
uniform vec4 uFrameR;        // kamera karesi (x0, y0, w, h) [cihaz pikseli, alttan]
uniform vec2 uTanHalf;       // kare yarı açılarının tanjantı (yatay, dikey)
out vec4 o;

// Piksel/kare başına bağımsız Gauss gürültü (Box–Muller)
vec3 gauss3(vec2 p, float f) {
  vec3 u1 = fract(sin(vec3(dot(p, vec2(12.9898, 78.233)), dot(p, vec2(39.3468, 11.135)), dot(p, vec2(73.156, 52.235))) + f * 0.6180339) * 43758.5453);
  vec3 u2 = fract(sin(vec3(dot(p, vec2(26.651, 36.287)), dot(p, vec2(91.731, 17.481)), dot(p, vec2(55.517, 64.932))) + f * 0.7548776) * 24634.6345);
  return sqrt(-2.0 * log(max(u1, 1e-7))) * cos(6.2831853 * u2);
}

vec3 sampleCatmullRom(sampler2D tex, vec2 uv, vec2 size) {
  vec2 sp = uv * size;
  vec2 tp1 = floor(sp - 0.5) + 0.5;
  vec2 f = sp - tp1;
  vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  vec2 w3 = f * f * (-0.5 + 0.5 * f);
  vec2 w12 = w1 + w2;
  vec2 o12 = w2 / w12;
  vec2 tp0 = (tp1 - 1.0) / size;
  vec2 tp3 = (tp1 + 2.0) / size;
  vec2 tp12 = (tp1 + o12) / size;
  vec3 r = vec3(0.0);
  r += texture(tex, vec2(tp0.x, tp0.y)).rgb * w0.x * w0.y;
  r += texture(tex, vec2(tp12.x, tp0.y)).rgb * w12.x * w0.y;
  r += texture(tex, vec2(tp3.x, tp0.y)).rgb * w3.x * w0.y;
  r += texture(tex, vec2(tp0.x, tp12.y)).rgb * w0.x * w12.y;
  r += texture(tex, vec2(tp12.x, tp12.y)).rgb * w12.x * w12.y;
  r += texture(tex, vec2(tp3.x, tp12.y)).rgb * w3.x * w12.y;
  r += texture(tex, vec2(tp0.x, tp3.y)).rgb * w0.x * w3.y;
  r += texture(tex, vec2(tp12.x, tp3.y)).rgb * w12.x * w3.y;
  r += texture(tex, vec2(tp3.x, tp3.y)).rgb * w3.x * w3.y;
  return max(r, 0.0);
}

// AgX (Sobotka; Wrensch'in en küçük yaklaşımı): parlak alev çekirdeğinde ton kaymasız beyaza yumuşak geçiş
vec3 agxContrast(vec3 x) {
  vec3 x2 = x * x, x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}
vec3 agx(vec3 v) {
  const mat3 m = mat3(0.842479062253094, 0.0423282422610123, 0.0423756549057051,
                      0.0784335999999992, 0.878468636469772, 0.0784336,
                      0.0792237451477643, 0.0791661274605434, 0.879142973793104);
  const mat3 mi = mat3(1.19687900512017, -0.0528968517574562, -0.0529716355144438,
                       -0.0980208811401368, 1.15190312990417, -0.0980434501171241,
                       -0.0990297440797205, -0.0989611768448433, 1.15107367264116);
  const float lo = -12.47393, hi = 4.026069;
  v = m * max(v, vec3(1e-10));
  v = clamp(log2(v), lo, hi);
  v = (v - lo) / (hi - lo);
  v = agxContrast(v);
  v = mi * v;
  return pow(clamp(v, 0.0, 1.0), vec3(2.2));
}
// ACES (Hill uydurması)
vec3 aces(vec3 c) {
  const mat3 mIn = mat3(0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777);
  const mat3 mOut = mat3(1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602);
  c = mIn * c;
  vec3 a = c * (c + 0.0245786) - 0.000090537;
  vec3 b = c * (0.983729 * c + 0.4329510) + 0.238081;
  return clamp(mOut * (a / b), 0.0, 1.0);
}
// Khronos PBR Nötr
vec3 neutral(vec3 c) {
  const float sc = 0.76, ds = 0.15;
  float x = min(c.r, min(c.g, c.b));
  float off = x < 0.08 ? x - 6.25 * x * x : 0.04;
  c -= off;
  float peak = max(c.r, max(c.g, c.b));
  if (peak < sc) return c;
  float d = 1.0 - sc;
  float np = 1.0 - d * d / (peak + d - sc);
  c *= np / peak;
  float g = 1.0 - 1.0 / (ds * (peak - np) + 1.0);
  return mix(c, vec3(np), g);
}

vec3 toSRGB(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}

float rand(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

void main() {
  vec3 col;
  if (uSchlieren > 0) {
    // Bıçak kenarı Schlieren: görüntü düzlemindeki OPD gradyanı. Dikey bıçak (∂/∂x)
    // yükselen sıcak gaz sütununun duvarlarını gösterir (klasik mum Schlieren fotoğrafı).
    vec2 tx = 1.0 / uSrcSize;
    float oN = texture(uAuxT, vUv + vec2(0.0, tx.y)).g, oS = texture(uAuxT, vUv - vec2(0.0, tx.y)).g;
    float oE = texture(uAuxT, vUv + vec2(tx.x, 0.0)).g, oW = texture(uAuxT, vUv - vec2(tx.x, 0.0)).g;
    // uv başına türev → görüntü düzleminde metre başına (uSchScale), bıçak kenarı duyarlılığıyla
    vec2 g = vec2(oE - oW, oN - oS) * 0.5 / tx * uSchScale * uSchGain;
    if (uFxSch > 0.5) {
      // Nesne yangını: sıcak gaz daha seyrek (n − n∞ < 0); ekran uzayında yoğunluk açığının gradyanı
      vec2 tp = tx * 3.0;
      float pE = texture(uFxPt, vUv + vec2(tp.x, 0.0)).a, pW = texture(uFxPt, vUv - vec2(tp.x, 0.0)).a;
      float pN = texture(uFxPt, vUv + vec2(0.0, tp.y)).a, pS = texture(uFxPt, vUv - vec2(0.0, tp.y)).a;
      g -= vec2((pE - pW) * tx.y / tx.x, pN - pS) * 0.5 / tp.y * 0.011 * uSchGain;
    }
    float solid = texture(uAuxT, vUv).b;
    if (uSchlieren == 1) {
      col = vec3(clamp(0.42 + g.x, 0.0, 1.0));
      col = pow(col, vec3(2.2));
    } else {
      float ang = atan(g.y, g.x) / 6.2831853 + 0.5;
      float mag = clamp(length(g) * 1.6, 0.0, 1.0);
      col = mix(vec3(0.05), turbo(ang), mag);
    }
    col = mix(col, vec3(0.006), solid);
    col = toSRGB(col);
  } else {
    vec3 hdr = sampleCatmullRom(uHDR, vUv, uSrcSize);
    vec3 bl = texture(uBloom, vUv).rgb;
    if (uCam.x > 0.5) {
      // Sensör: doğrusal ışınım (doyma = 1) → beyaz dengesi → doğal vinyet → foton ve
      // okuma gürültüsü → kırpma (doyma) → görünüm dönüşümü → sRGB
      vec3 x = mix(hdr, bl, clamp(uBloomAmt, 0.0, 1.0)) * uExposure;
      x *= uWB;
      vec2 fp = (gl_FragCoord.xy - uFrameR.xy) / uFrameR.zw * 2.0 - 1.0;   // kare içi −1..1
      if (uCam.w > 0.5) {
        vec2 tn = fp * uTanHalf;
        float c2 = 1.0 / (1.0 + dot(tn, tn));
        x *= c2 * c2;                                   // cos⁴θ
      }
      if (uCam.z > 0.5) {
        vec3 e = max(x, 0.0) * uSensorN.x;                // elektron
        vec3 sig = sqrt(e + uSensorN.y * uSensorN.y) / uSensorN.x;
        x += sig * gauss3(gl_FragCoord.xy, float(uFrame % 997));
      }
      col = uCam.y > 0.5 ? agx(x) : clamp(x, 0.0, 1.0);
      col = toSRGB(col);
      // Kare dışı: kenardan uzaklaştıkça yumuşakça kararır, kare sınırında ince sıcak çizgi
      vec2 ov = max(abs(fp) - 1.0, 0.0);
      float outd = length(ov);
      if (outd > 0.0) col *= mix(0.42, 0.12, smoothstep(0.0, 0.25, outd));
      vec2 ed = abs(abs(fp) - 1.0) / max(fwidth(fp), vec2(1e-5));
      float line = (1.0 - smoothstep(0.5, 1.5, min(ed.x, ed.y))) * step(max(abs(fp).x, abs(fp).y), 1.0 + 2.0 * max(fwidth(fp).x, fwidth(fp).y));
      col = mix(col, vec3(1.0, 0.72, 0.42), 0.6 * line);
    } else if (uFalse == 1) {
      col = hdr + bl * uBloomAmt * 0.6;
      col = clamp(col, 0.0, 1.0);
    } else {
      vec3 x = mix(hdr, bl, clamp(uBloomAmt, 0.0, 1.0)) * uExposure;
      col = uTonemap == 0 ? agx(x) : uTonemap == 1 ? aces(x) : neutral(x);
      col = toSRGB(col);
    }
  }
  vec2 q = vUv - 0.5;
  q.x *= uViewport.x / max(uViewport.y, 1.0);
  if (uCam.x < 0.5) col *= 1.0 - uVignette * dot(q, q) * 0.9;
  col += (rand(gl_FragCoord.xy + float(uFrame % 97)) - 0.5) / 255.0;
  o = vec4(col, 1.0);
}
`;

/* Otomatik pozlama için parlaklık (ışıklılık) çıkarma */
FL.SHADERS.luminance = () => FL.SHADERS.header + `
in vec2 vUv;
uniform sampler2D uSrc;
uniform float uFloorY;     // log-ortalamada alt sınır (önceden pozlanmış birim)
uniform float uInvN;       // 1 / piksel sayısı: toplam yarım duyarlıkta taşmasın
out vec4 o;
void main() {
  vec3 c = texture(uSrc, vUv).rgb;
  float Y = dot(c, vec3(0.2126, 0.7152, 0.0722));
  // Merkez ağırlığı: sahne ölçümü (toplam zinciri) görüntünün ortasına daha duyarlı
  vec2 d = vUv - 0.5;
  float w = exp(-dot(d, d) * 4.0) * uInvN;
  o = vec4(Y, log(max(Y, max(uFloorY, 1e-12))) * w, w, Y);
}
`;
