/* =====================================================================
 * Alev Laboratuvarı — Fizik shader'ları
 * ---------------------------------------------------------------------
 * Düşük Mach sayılı, değişken yoğunluklu reaktif akış:
 *   ∂u/∂t + (u·∇)u = −∇p/ρ + ν∇²u + (1 − T/T∞) g + f_vc
 *   ∇·u = S,  S = (1/T) DT/Dt |kimya+ışınım   (ısıl genleşme)
 *   ∂φ/∂t + (u·∇)φ = ∇·(D_φ ∇φ) + ω_φ
 * Operatör ayırma ile her alt adım:
 *   1) MacCormack adveksiyon (hız, sıcaklık/türler)
 *   2) Kaynaklar + kimya + kurum + ışınım (MRT)
 *   3) Örtük difüzyon (Jacobi), değişken α(T)
 *   4) Vortisite + kuvvetler + sınır koşulları
 *   5) Örtük viskozite
 *   6) Basınç izdüşümü (kırmızı-siyah SOR)
 * ===================================================================== */
import { FL } from '../core/fl.js';

const H = () => FL.SHADERS.header + FL.SHADERS.common;
const HT = () => FL.SHADERS.header + FL.SHADERS.common + FL.SHADERS.thermo;

/* ------------------------------------------------------------------ */
/* Sınır ve engel koşulları (hız) — birkaç pass'ta ortak               */
/* ------------------------------------------------------------------ */
const CONSTRAIN = `
uniform float uFlow;      // zorlanmış eş-akış hızı (+y) [m/s]
uniform float uDraft;     // ortam hava akımı bozuntu genliği [m/s]
uniform float uTime;
uniform vec4  uSup;       // söndürücü: (açık, 0, yarıçap, hız)
uniform vec4  uSupC;      // söndürücü hedefi [m], w kullanılmaz
uniform vec3  uWind;      // yatay rüzgâr (oda havasının alana göre hızı) [m/s]

vec3 constrainVel(ivec3 c, vec3 u) {
  int ct = cellType(c);
  vec3 w = worldPos(c);
  if (ct == 1 || ct == 4 || ct == 5 || ct == 6) return vec3(0.0);
  if (ct == 2) {
    float r = length(w.xz - uSrc0.xy) / uSrc0.z;
    // Poiseuille profili; kanal 3 hücreden darsa hücre ortalaması ≈ tıkaç akışı
    float prof = uSrc0.z > 3.0 * uDx ? 2.0 * max(1.0 - r * r, 0.0) : 1.0;
    return vec3(0.0, uSrc1.z * prof, 0.0);
  }
  if (ct == 3) return vec3(0.0, uSrc1.w, 0.0);
  // Not: damla ve fitil yüzeyindeki Stefan akışı, basınç izdüşümündeki kütle
  // kaynağı (∇·u = ṁ'''/ρ) ile kendiliğinden oluşur; burada ayrıca dayatılmaz.
  if (c.y == 0) {
    // Alt sınır: ortam/zorlanmış akış girişi, düşük genlikli oda akımı bozuntusu
    float nx = vnoise(vec3(w.xz * 60.0, uTime * 3.0)) - 0.5;
    float nz = vnoise(vec3(w.zx * 60.0 + 17.0, uTime * 3.0)) - 0.5;
    return vec3(nx * uDraft + uWind.x, uFlow, nz * uDraft + uWind.z);
  }
  if (uSup.x > 0.5) {
    // Söndürücü jeti alevin içinden geçer: +x yönünde, fitili süpürür
    float d = length(w.yz - uSupC.yz);
    if (d < uSup.z) {
      float core = smoothstep(uSup.z, 0.2 * uSup.z, d);
      return mix(u, vec3(uSup.w, 0.0, 0.0), core);
    }
  }
  return u;
}
`;

/* ------------------------------------------------------------------ */
/* Yarı-Lagrange adveksiyon (RK2 geri izleme)                          */
/* ------------------------------------------------------------------ */
FL.SHADERS.advect = () => H() + `
uniform sampler2D uVel;
uniform sampler2D uField;
uniform float uDt;
out vec4 o;

vec3 traceBack(vec3 p, float dt) {
  vec3 v1 = S(uVel, p).xyz;
  vec3 mid = p - 0.5 * dt * v1 / uDx;
  vec3 v2 = S(uVel, mid).xyz;
  return p - dt * v2 / uDx;
}

void main() {
  ivec3 c = cellCoord();
  if (outsideGrid(c)) { o = vec4(0.0); return; }
  vec3 p = vec3(c);
  o = S(uField, traceBack(p, uDt));
}
`;

/* ------------------------------------------------------------------ */
/* Skaler adveksiyonu: korunan değişkenlerle MacCormack                 */
/* ------------------------------------------------------------------ */
/*
 * Değişken yoğunluklu akışta T ve kütle kesirleri hacimce değil kütlece
 * karışır. Bu yüzden adveksiyon, korunan değişkenler üzerinde yapılır:
 *   U = (ρ, ρT, ρY_F, ρY_O),  U₂ = (ρY_P, f_v)
 * Bunların hacimce (üç doğrusal) enterpolasyonu kütle ve entalpi korunumlu
 * karışımdır: Ŷ = Σwρ_iY_i / Σwρ_i. İşlemci doğrusal kaldığı için MacCormack
 * düzeltmesi tutarlıdır. Sonra T = ρT/ρ, Y = ρY/ρ bulunur.
 * Hacimce T/Y enterpolasyonu (önceki yöntem) yarı yarıya hidrojen–hava
 * hücresinde yakıt kesrini 0,065 yerine 0,5 verir, 2000 K ürün ile 300 K
 * havayı 516 K yerine 1150 K'e karıştırır: yakıt ve enerji yoktan var olur.
 * Taşınan kütle ρ ile durum denkleminden gelen ρ(T,Y) arasındaki fark
 * (c_p ve mol kütlesi farkı) genleşme kaynağına eklenir: S_adv = ln(ρ/ρ_DD)/Δt.
 */
const UFUNC = `
vec4 consU(vec4 s, float Yp, out vec2 u2) {
  float T = max(s.r, 150.0);
  float rho = rhoMix(T, invMolar(s.g, s.b, Yp, max(1.0 - s.g - s.b - Yp, 0.0)));
  u2 = vec2(rho * Yp, s.a);
  return vec4(rho, rho * T, rho * s.g, rho * s.b);
}
// İz: nozul girişi sabit kütle akılı bir sınırdır. İz giriş düzlemini geçerse
// kalan süre gerçek giriş hızıyla geriye sürülür; çıkışta ısınıp hızlanan gaz
// girişten beslenenden fazla yakıt çekemez.
vec3 departure(ivec3 c, float dt) {
  vec3 p = vec3(c);
  vec3 v1 = S(uVel, p).xyz;
  vec3 mid = p - 0.5 * dt * v1 / uDx;
  vec3 v2 = S(uVel, mid).xyz;
  vec3 q = p - dt * v2 / uDx;
  if (uMode == 0 && dt > 0.0 && cellType(c) == 0) {
    float yFace = uSrc1.x / uDx - 0.5;
    if (p.y > yFace && q.y < yFace && v2.y > 1e-6) {
      ivec3 under = ivec3(floor(vec3(q.x, yFace - 0.5, q.z) + 0.5));
      int ut = cellType(clamp(under, ivec3(0), uN - 1));
      if (ut == 2 || ut == 3) {
        float vin = ut == 2 ? uSrc1.z : uSrc1.w;
        float tReach = (p.y - yFace) * uDx / v2.y;
        q.y = yFace - max(dt - tReach, 0.0) * vin / uDx;
      }
    }
  }
  return clamp(q, vec3(0.0), vec3(uN) - 1.0);
}
`;

/* İleri adım: SCA/AUX → Û, Û₂ */
FL.SHADERS.advectU = () => HT() + `
uniform sampler2D uVel;
uniform sampler2D uField;   // SCA (T, Y_F, Y_O, f_v)
uniform sampler2D uAuxOld;  // Y_P
uniform float uDt;
layout(location = 0) out vec4 oU;
layout(location = 1) out vec4 oU2;
` + UFUNC + `
void main() {
  ivec3 c = cellCoord();
  if (outsideGrid(c)) { oU = vec4(0.0); oU2 = vec4(0.0); return; }
  vec3 q = departure(c, uDt);
  ivec3 b = ivec3(floor(q));
  vec3 f = q - vec3(b);
  vec4 U = vec4(0.0);
  vec2 U2 = vec2(0.0);
  float ws = 0.0;
  bool selfGas = !isSolidType(cellType(c));
  for (int k = 0; k < 2; k++)
  for (int j = 0; j < 2; j++)
  for (int i = 0; i < 2; i++) {
    float w = (i == 0 ? 1.0 - f.x : f.x) * (j == 0 ? 1.0 - f.y : f.y) * (k == 0 ? 1.0 - f.z : f.z);
    if (w <= 0.0) continue;
    ivec3 n = min(b + ivec3(i, j, k), uN - 1);
    // Katı köşeler atlanır, ağırlıklar akışkan köşelere yeniden dağıtılır:
    // katının içinden gaz (ve yakıt) gelmez. Hayalet değerden örneklemek, yüzey
    // yanındaki zengin yakıtı yukarı akış tarafına taşıyıp yakıtı çoğaltırdı.
    if (selfGas && isSolidType(cellType(n))) continue;
    vec2 u2;
    U += w * consU(F(uField, n), F(uAuxOld, n).g, u2);
    U2 += w * u2;
    ws += w;
  }
  if (ws > 1e-4) { U /= ws; U2 /= ws; }
  else { vec2 u2; U = consU(F(uField, c), F(uAuxOld, c).g, u2); U2 = u2; }
  oU = U;
  oU2 = vec4(U2, 0.0, 0.0);
}
`;

/* Düzeltme: MacCormack (U üzerinde, min–maks sınırlayıcı) → SCA ve (S_adv, Y_P) */
FL.SHADERS.correctU = () => HT() + `
uniform sampler2D uVel;
uniform sampler2D uField;   // SCA^n
uniform sampler2D uAuxOld;  // AUX^n (Y_P)
uniform sampler2D uHat;     // Û
uniform sampler2D uHat2;    // Û₂
uniform sampler2D uTil;     // Ũ = A⁻¹(Û)
uniform sampler2D uTil2;
uniform float uDt;
uniform float uStrength;    // 0 = birinci derece, 1 = MacCormack
layout(location = 0) out vec4 oSca;
layout(location = 1) out vec4 oS;
` + UFUNC + `
void main() {
  ivec3 c = cellCoord();
  if (outsideGrid(c)) { oSca = vec4(0.0); oS = vec4(0.0); return; }
  vec4 Uh = F(uHat, c);
  vec2 U2h = F(uHat2, c).xy;
  vec4 U = Uh;
  vec2 U2 = U2h;
  if (uStrength > 0.0) {
    vec2 u2n;
    vec4 Un = consU(F(uField, c), F(uAuxOld, c).g, u2n);
    vec4 res = Uh + 0.5 * uStrength * (Un - F(uTil, c));
    vec2 res2 = U2h + 0.5 * uStrength * (u2n - F(uTil2, c).xy);
    // Sınırlayıcı ilkel değişkenler (T, Y, f_v) üzerinde: düzeltilmiş durum,
    // kalkış hücresi köşelerindeki değer aralığının dışına çıkarsa tüm vektör
    // birinci derece çözüme döner. Bileşen bileşen geri düşmek ρ ile ρY'yi
    // ayrıştırır; Y = ρY/ρ fiziksel sınırı aşar, yakıt ve enerji yoktan oluşur.
    vec3 q = departure(c, uDt);
    ivec3 b = ivec3(floor(q));
    vec4 mn = vec4(1e30), mx = vec4(-1e30);
    vec2 mn2 = vec2(1e30), mx2 = vec2(-1e30);
    bool selfSolid = isSolidType(cellType(c));
    for (int k = 0; k < 2; k++)
    for (int j = 0; j < 2; j++)
    for (int i = 0; i < 2; i++) {
      ivec3 n = min(b + ivec3(i, j, k), uN - 1);
      if (!selfSolid && isSolidType(cellType(n))) continue;
      vec4 sn = F(uField, n);
      vec4 pr = vec4(sn.r, sn.g, sn.b, F(uAuxOld, n).g);
      mn = min(mn, pr); mx = max(mx, pr);
      mn2 = min(mn2, vec2(sn.a, 0.0)); mx2 = max(mx2, vec2(sn.a, 0.0));
    }
    bool ok = mn.x < 1e29 && res.x > 1e-6;
    if (ok) {
      vec4 pr = vec4(res.y, res.z, res.w, res2.x) / res.x;
      vec4 tol = vec4(1.0, 1e-4, 1e-4, 1e-4);
      ok = all(greaterThanEqual(pr, mn - tol)) && all(lessThanEqual(pr, mx + tol))
        && res2.y >= mn2.x - 1e-3 && res2.y <= mx2.x + 1e-3;
    }
    if (ok) { U = res; U2 = res2; }
  }
  float rho = max(U.x, 1e-6);
  float T = clamp(U.y / rho, 150.0, 3600.0);
  float Yf = clamp(U.z / rho, 0.0, 1.0);
  float Yo = clamp(U.w / rho, 0.0, 1.0);
  float Yp = clamp(U2.x / rho, 0.0, 1.0);
  float sumY = Yf + Yo + Yp;
  if (sumY > 1.0) { Yf /= sumY; Yo /= sumY; Yp /= sumY; }
  float fv = max(U2.y, 0.0);
  float rhoEOS = rhoMix(T, invMolar(Yf, Yo, Yp, max(1.0 - Yf - Yo - Yp, 0.0)));
  float sAdv = log(rho / max(rhoEOS, 1e-9)) / max(uDt, 1e-6);
  oSca = vec4(T, Yf, Yo, fv);
  oS = vec4(clamp(sAdv, -400.0, 1500.0), Yp, 0.0, 0.0);
}
`;

/* ------------------------------------------------------------------ */
/* Işınımla ısı transferi: kaynak toplamı (optik ince + yeniden soğurma) */
/* ------------------------------------------------------------------ */
/*
 * Gelen ışınım G = ∫ I dΩ [W/m²]. Laboratuvar ölçeğindeki alevlerde (κL ≪ 1)
 * ışınım yolu boyunca neredeyse hiç soğurulmaz; G, alevin her hacim öğesinin
 * yaydığı gücün 1/(4πr²) ile seyrelmiş toplamıdır (görüş faktörü yaklaşımı):
 *     G(x) = 4σT∞⁴ + Σ_k P_k / (4π |x − x_k|²),   P_k = ∫ 4σκ (T⁴ − T∞⁴) dV
 * Bu, ışınım aktarım denkleminin optik ince sınırdaki tam çözümüdür ve P1
 * gibi difüzyon yaklaşımlarının ince ortamdaki hatasını taşımaz. Kaynaklar
 * 4×4×4 hücrelik bloklarda toplanır (güç ağırlıklı merkez), G bloklarda
 * hesaplanıp hücrelere üç doğrusal olarak dağıtılır.
 * Gazdaki ışınım kaynağı: q_r = κ (G − 4σT⁴) → yayınım − yeniden soğurma.
 * Duvar akısı: q_w = Σ P_k cos θ / (4π r²), alan sınırlarında (duvar, tavan,
 * masa) — alevin çevresine verdiği ışınım yükü.
 */
const RADC = `
uniform ivec3 uNB;   // kaba blok sayısı
uniform int uBT;     // kaba atlas: x yönünde döşeme
uniform int uBS;     // blok kenarı (hücre)
ivec2 cTexel(ivec3 b) {
  b = clamp(b, ivec3(0), uNB - 1);
  int ty = b.z / uBT;
  int tx = b.z - ty * uBT;
  return ivec2(tx * uNB.x + b.x, ty * uNB.y + b.y);
}
ivec3 cCoord() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int tx = p.x / uNB.x, ty = p.y / uNB.y;
  return ivec3(p.x - tx * uNB.x, p.y - ty * uNB.y, ty * uBT + tx);
}
// Hücre indeksi uzayındaki p konumunda kaba alanın üç doğrusal değeri
vec4 CSv(sampler2D t, vec3 p) {
  vec3 q = clamp((p + 0.5) / float(uBS) - 0.5, vec3(0.0), vec3(uNB) - 1.0);
  ivec3 b0 = ivec3(floor(q));
  vec3 f = q - vec3(b0);
  vec4 r = vec4(0.0);
  for (int k = 0; k < 2; k++)
  for (int j = 0; j < 2; j++)
  for (int i = 0; i < 2; i++) {
    float w = (i == 0 ? 1.0 - f.x : f.x) * (j == 0 ? 1.0 - f.y : f.y) * (k == 0 ? 1.0 - f.z : f.z);
    r += w * texelFetch(t, cTexel(b0 + ivec3(i, j, k)), 0);
  }
  return r;
}
`;
FL.RADC = RADC;

/* Blok kaynakları: (P [W], güç ağırlıklı merkez x, y, z [m]) */
FL.SHADERS.radSource = () => HT() + RADC + `
uniform sampler2D uSca;
uniform sampler2D uAux;
out vec4 o;
void main() {
  ivec3 b = cCoord();
  if (b.z >= uNB.z) { o = vec4(0.0); return; }
  float Ta2 = uTamb * uTamb;
  float Ea = 4.0 * SIGMA_SB * Ta2 * Ta2;
  float dV = uDx * uDx * uDx;
  float P = 0.0;
  vec3 cw = vec3(0.0);
  for (int k = 0; k < 8; k++) { if (k >= uBS) break;
  for (int j = 0; j < 8; j++) { if (j >= uBS) break;
  for (int i = 0; i < 8; i++) { if (i >= uBS) break;
    ivec3 c = b * uBS + ivec3(i, j, k);
    if (!inDomain(c) || cellType(c) != 0) continue;
    vec4 s = F(uSca, c);
    float T = max(s.r, 150.0);
    if (T < uTamb + 20.0 && s.a < 1e-3) continue;
    float Yp = F(uAux, c).g;
    float Yd = max(1.0 - s.g - s.b - Yp, 0.0);
    float invW = invMolar(s.g, s.b, Yp, Yd);
    float kap = kappaPlanck(T, Yp, Yd, invW, max(s.a, 0.0) * 1e-6);
    float T2 = T * T;
    float p = max(kap * (4.0 * SIGMA_SB * T2 * T2 - Ea), 0.0) * dV;
    P += p;
    cw += p * worldPos(c);
  }}}
  vec3 cen = P > 1e-12 ? cw / P : (vec3(b * uBS) + 0.5 * float(uBS)) * uDx;
  o = vec4(P, cen);
}
`;

/* Işınım alanı (bloklarda): (G − 4σT∞⁴, duvar akısı maks, duvardan çıkan güç, masa akısı) */
FL.SHADERS.radField = () => HT() + RADC + `
uniform sampler2D uSrcR;
uniform vec3 uBoxR;     // alan boyutu [m]
out vec4 o;
void main() {
  ivec3 b = cCoord();
  if (b.z >= uNB.z) { o = vec4(0.0); return; }
  float h = float(uBS) * uDx;
  vec3 lo = vec3(b) * h;
  vec3 hi = min(lo + h, uBoxR);
  vec3 x = 0.5 * (lo + hi);
  float a2 = 0.25 * h * h;            // kaynak boyutu düzeltmesi (tekillik yok)
  float G = 0.0;
  // Bu blok alan sınırına değiyorsa yüz merkezleri (en çok 3 yüz)
  bool fx = b.x == 0 || b.x == uNB.x - 1, fy = b.y == 0 || b.y == uNB.y - 1, fz = b.z == 0 || b.z == uNB.z - 1;
  vec3 px = vec3(b.x == 0 ? 0.0 : uBoxR.x, x.y, x.z), nx = vec3(b.x == 0 ? 1.0 : -1.0, 0.0, 0.0);
  vec3 py = vec3(x.x, b.y == 0 ? 0.0 : uBoxR.y, x.z), ny = vec3(0.0, b.y == 0 ? 1.0 : -1.0, 0.0);
  vec3 pz = vec3(x.x, x.y, b.z == 0 ? 0.0 : uBoxR.z), nz = vec3(0.0, 0.0, b.z == 0 ? 1.0 : -1.0);
  float qx = 0.0, qy = 0.0, qz = 0.0;
  for (int bz = 0; bz < 64; bz++) { if (bz >= uNB.z) break;
  for (int by = 0; by < 128; by++) { if (by >= uNB.y) break;
  for (int bx = 0; bx < 64; bx++) { if (bx >= uNB.x) break;
    vec4 s = texelFetch(uSrcR, cTexel(ivec3(bx, by, bz)), 0);
    if (s.x <= 0.0) continue;
    vec3 d = s.yzw - x;
    G += s.x / (12.566371 * (dot(d, d) + a2));
    if (fx) { vec3 e = s.yzw - px; float r2 = dot(e, e) + a2; qx += s.x * max(dot(e, nx), 0.0) * inversesqrt(r2) / (12.566371 * r2); }
    if (fy) { vec3 e = s.yzw - py; float r2 = dot(e, e) + a2; qy += s.x * max(dot(e, ny), 0.0) * inversesqrt(r2) / (12.566371 * r2); }
    if (fz) { vec3 e = s.yzw - pz; float r2 = dot(e, e) + a2; qz += s.x * max(dot(e, nz), 0.0) * inversesqrt(r2) / (12.566371 * r2); }
  }}}
  vec3 ext = hi - lo;
  float Pw = (fx ? qx * ext.y * ext.z : 0.0) + (fy ? qy * ext.x * ext.z : 0.0) + (fz ? qz * ext.x * ext.y : 0.0);
  float qmax = max(fx ? qx : 0.0, max(fy ? qy : 0.0, fz ? qz : 0.0));
  float qfloor = b.y == 0 ? qy : 0.0;
  o = vec4(G, qmax, Pw, qfloor);
}
`;


/* ------------------------------------------------------------------ */
/* MacCormack düzeltmesi + min/max sınırlayıcı                          */
/* φ^{n+1} = φ̂ + ½(φ^n − φ̃),  φ̃ = A^{-1}(φ̂)                            */
/* ------------------------------------------------------------------ */
FL.SHADERS.maccormack = () => H() + `
uniform sampler2D uVel;
uniform sampler2D uField;   // φ^n
uniform sampler2D uHat;     // φ̂ = A(φ^n)
uniform sampler2D uTilde;   // φ̃ = A⁻¹(φ̂)
uniform float uDt;
uniform float uStrength;    // 0 = saf yarı-Lagrange, 1 = tam MacCormack
out vec4 o;

void main() {
  ivec3 c = cellCoord();
  if (outsideGrid(c)) { o = vec4(0.0); return; }
  vec3 p = vec3(c);
  vec3 v1 = S(uVel, p).xyz;
  vec3 mid = p - 0.5 * uDt * v1 / uDx;
  vec3 v2 = S(uVel, mid).xyz;
  vec3 q = clamp(p - uDt * v2 / uDx, vec3(0.0), vec3(uN - 1));

  vec4 phiHat = F(uHat, c);
  vec4 res = phiHat + 0.5 * uStrength * (F(uField, c) - F(uTilde, c));

  // Kalkış hücresinin 8 köşesinden yerel uç değerler (aşma/altına düşme engeli)
  ivec3 b = ivec3(floor(q));
  vec4 mn = vec4(1e30), mx = vec4(-1e30);
  for (int k = 0; k < 2; k++)
  for (int j = 0; j < 2; j++)
  for (int i = 0; i < 2; i++) {
    vec4 v = F(uField, b + ivec3(i, j, k));
    mn = min(mn, v);
    mx = max(mx, v);
  }
  // Sınırlayıcı: aşan bileşenlerde yarı-Lagrange değerine dön
  bvec4 bad = bvec4(res.x < mn.x || res.x > mx.x, res.y < mn.y || res.y > mx.y,
                    res.z < mn.z || res.z > mx.z, res.w < mn.w || res.w > mx.w);
  o = vec4(bad.x ? phiHat.x : res.x, bad.y ? phiHat.y : res.y,
           bad.z ? phiHat.z : res.z, bad.w ? phiHat.w : res.w);
}
`;

/* ------------------------------------------------------------------ */
/* Yanma, kurum, ışınım ve kaynak terimleri (MRT)                       */
/* SCA = (T, Y_F, Y_O2, fv[ppm]),  AUX = (HRR[MW/m³], Y_P, S[1/s], HRR_cool) */
/* ------------------------------------------------------------------ */
FL.SHADERS.combust = () => HT() + RADC + `
uniform sampler2D uSca;
uniform sampler2D uAux;
uniform float uDt;
uniform vec4 uKin;        // (A, Ta, a, b) — Westbrook–Dryer
uniform vec4 uSoot;       // (açık, eğilim×çarpan, oksidasyon çarpanı, 0)
uniform vec4 uCool;       // (açık, A_lt, Ta_lt, ısı kesri)
uniform vec4 uIgn;        // tutuşturucu konumu (x,y,z) ve yarıçap
uniform float uIgnT;      // tutuşturucu sıcaklığı (0 = kapalı)
uniform vec4 uSupS;       // söndürücü: (açık, jet yarıçapı [m], karışma hızı [1/s], 0)
uniform vec4 uSupC;       // söndürücü jetinin ekseni (x boyunca), y–z konumu [m]
uniform float uTcap;      // sıcaklık güvenlik sınırı [K]
uniform sampler2D uG;     // alevin gelen ışınımı G − 4σT∞⁴ (kaba bloklar) [W/m²]
uniform vec4 uSmo;        // CO₂ tüpü: (açık, yarıçap [m], O₂ yer değiştirme hızı [1/s], 0)
uniform float uAuxMax;    // aux.r/a üst sınırı [MW/m³]
uniform float uWallT;     // eylemsiz katı sıcaklığı
uniform float uSideAmbient; // yan sınırlar ortam değerine sabitlensin mi
uniform vec4 uInject;     // (yüz başına buhar debisi [kg/s], buhar sıcaklığı, geri besleme kullan, 0)
uniform sampler2D uVel;   // sınırlarda akış yönü (içeri / dışarı)
uniform float uFlowIn;    // tabandan giren zorlanmış akış [m/s]
uniform sampler2D uSadv;  // adveksiyon kütle tutarlılığı kaynağı [1/s]

layout(location = 0) out vec4 oSca;
layout(location = 1) out vec4 oAux;

vec4 ambientSca() { return vec4(uTamb, 0.0, uYoAmb, 0.0); }

// Fitil geri beslemesi (0..1). Sıvı parafin kılcal etkiyle fitil boyunca yükselir;
// buharlaşma için gereken ısı fitil ucunu saran alevden gelir. Bu yüzden besleme
// tüm fitil için tek bir değerdir: fitil ucu çevresindeki (~3 mm yarıçap, ~6 mm
// yükseklik) en sıcak gaz. Alev uzaklaşırsa (mikro-g, düşük O₂) besleme azalır,
// alev sönerse fitil soğur ve buhar kesilir.
float wickFeedback() {
  ivec3 tip = ivec3(floor(vec3(uSrc0.x, uSrc0.w + uSrc1.y, uSrc0.y) / uDx));
  int r = clamp(int(0.003 / uDx + 0.5), 1, 4);
  int up = clamp(int(0.006 / uDx + 0.5), 2, 8);
  float Tnb = 0.0;
  for (int k = -1; k <= 1; k++)
  for (int i = -1; i <= 1; i++)
  for (int dy = -2; dy <= 8; dy += 2) {
    if (dy > up) break;
    ivec3 n = tip + ivec3(i * r, dy, k * r);
    if (cellType(n) == 0) Tnb = max(Tnb, F(uSca, n).r);
  }
  return smoothstep(500.0, 1200.0, Tnb);
}

// Kaynak yüzeyine (fitil/damla) komşu yüz sayısı
int sourceFaces(ivec3 c, int srcType) {
  int n = 0;
  if (cellType(c + ivec3(1, 0, 0)) == srcType) n++;
  if (cellType(c - ivec3(1, 0, 0)) == srcType) n++;
  if (cellType(c + ivec3(0, 1, 0)) == srcType) n++;
  if (cellType(c - ivec3(0, 1, 0)) == srcType) n++;
  if (cellType(c + ivec3(0, 0, 1)) == srcType) n++;
  if (cellType(c - ivec3(0, 0, 1)) == srcType) n++;
  return n;
}

void main() {
  ivec3 c = cellCoord();
  if (outsideGrid(c)) { oSca = vec4(0.0); oAux = vec4(0.0); return; }
  vec3 w = worldPos(c);
  vec4 s = F(uSca, c);
  vec4 a = F(uAux, c);
  int ct = cellType(c);

  // ---------------- Katı/kaynak hücreleri ----------------
  // Sıcaklık sınır koşulu katının kendisinden gelir (Dirichlet). Türler için katı
  // yüzeyler geçirimsizdir: katı hücre, gaz komşularının ortalamasını "hayalet"
  // değer olarak taşır (sıfır gradyan). Böylece yarı-Lagrange adveksiyonunun
  // üç doğrusal örneklemesi yüzey yanındaki yakıtı ve oksijeni sıfırla karıştırıp
  // sayısal olarak silmez; fitil ve damladan verilen yakıtın tamamı yanmaya ulaşır.
  if (ct == 1 || ct == 4 || ct == 5 || ct == 6) {
    vec4 gs = vec4(0.0);
    float gp = 0.0, ng = 0.0;
    ivec3 offs[6] = ivec3[6](ivec3(1,0,0), ivec3(-1,0,0), ivec3(0,1,0), ivec3(0,-1,0), ivec3(0,0,1), ivec3(0,0,-1));
    for (int i = 0; i < 6; i++) {
      ivec3 n = c + offs[i];
      if (!inDomain(n) || cellType(n) != 0) continue;
      gs += F(uSca, n);
      gp += F(uAux, n).g;
      ng += 1.0;
    }
    vec4 ghost = ng > 0.0 ? gs / ng : vec4(0.0);
    float Tb = uWallT;
    if (ct == 5) Tb = uSrc1.x;
    else if (ct == 6) Tb = sheetState(c).r;
    else if (ct == 4) {
      // Fitil: sıcaklığı alevden geri gelen ısı ile belirlenir (ucu ~1000 K).
      // Söndürücü açıkken (uIgnT < 0) fitil de soğur, yoksa gazı yeniden yakar.
      float fbw = uIgnT < 0.0 ? 0.0 : wickFeedback();
      Tb = mix(uTamb + 20.0, uSrc1.w, fbw);
    }
    oSca = vec4(Tb, ghost.g, ghost.b, ghost.a);
    oAux = vec4(0.0, ng > 0.0 ? gp / ng : 0.0, 0.0, 0.0);
    return;
  }
  if (ct == 2) { oSca = vec4(uSrc2.y, uSrc2.x, 0.0, 0.0); oAux = vec4(0.0); return; }
  if (ct == 3) { oSca = ambientSca(); oAux = vec4(0.0); return; }

  // ---------------- Dış sınırlar ----------------
  // Yan yüzler ve taban: içeri akış varsa taze ortam gazı (Dirichlet), dışarı akış
  // varsa sıfır gradyan (iç komşunun değeri). Zorlanmış akış yokken taban bir masa
  // yüzeyidir: türler için geçirimsiz (sıfır gradyan), sıcaklık ortamda.
  // Böylece aşağı sürüklenen yakıt ya da ürünler sınırda yapay olarak silinmez.
  bool side = c.x == 0 || c.x == uN.x - 1 || c.z == 0 || c.z == uN.z - 1;
  if (c.y == 0 || (side && uSideAmbient > 0.5)) {
    vec3 nrm = vec3(c.x == 0 ? -1.0 : (c.x == uN.x - 1 ? 1.0 : 0.0),
                    c.y == 0 ? -1.0 : 0.0,
                    c.z == 0 ? -1.0 : (c.z == uN.z - 1 ? 1.0 : 0.0));
    vec3 ub = F(uVel, c).xyz;
    float un = dot(ub, nrm);
    bool floorWall = c.y == 0 && uFlowIn < 1e-4 && !side;
    if (floorWall || un > 1e-4) {
      ivec3 inner = c - ivec3(nrm);
      inner = clamp(inner, ivec3(0), uN - 1);
      vec4 si = F(uSca, inner);
      vec4 ai = F(uAux, inner);
      if (floorWall) si.r = uTamb;
      oSca = si;
      oAux = vec4(0.0, ai.g, 0.0, 0.0);
    } else {
      oSca = ambientSca(); oAux = vec4(0.0);
    }
    return;
  }

  float T = clamp(s.r, 150.0, 3600.0);
  float Yf = clamp(s.g, 0.0, 1.0);
  float Yo = clamp(s.b, 0.0, 1.0);
  float fv = max(s.a, 0.0) * 1e-6;
  // Ürün kesri, skalerlerle aynı kütle ağırlıklı adveksiyondan gelir
  float Yp = clamp(texelFetch(uSadv, ivec2(gl_FragCoord.xy), 0).g, 0.0, 1.0);
  float Smass = 0.0;   // kütle kaynağı ile hacim genleşmesi [1/s]

  // ---------------- Fitil / damla yüzeyinden buhar enjeksiyonu ----------------
  if ((uMode == 1 || uMode == 2) && uInject.x > 0.0) {
    int nf = sourceFaces(c, uMode == 1 ? 4 : 5);
    if (nf > 0) {
      float fbk = uInject.z > 0.5 ? wickFeedback() : 1.0;
      float Yd0 = max(1.0 - Yf - Yo - Yp, 0.0);
      float rho0 = rhoMix(T, invMolar(Yf, Yo, Yp, Yd0));
      float mdot = uInject.x * float(nf) * fbk;          // kg/s
      float dm = mdot * uDt / (rho0 * uDx * uDx * uDx);  // eklenen kütle / hücre kütlesi
      dm = min(dm, 0.8);
      Yf = (Yf + dm) / (1.0 + dm);
      Yo = Yo / (1.0 + dm);
      Yp = Yp / (1.0 + dm);
      fv = fv / (1.0 + dm);
      T = (T + uInject.y * dm) / (1.0 + dm);
      // Eklenen kütle, yeni yoğunlukta ne kadar hacim kaplar: ΔV/V = (1+dm)ρ₀/ρ₁ − 1
      float rho1 = rhoMix(T, invMolar(Yf, Yo, Yp, max(1.0 - Yf - Yo - Yp, 0.0)));
      Smass += ((1.0 + dm) * rho0 / rho1 - 1.0) / uDt;
    }
  }

  // ---------------- Levhadan piroliz gazı enjeksiyonu ----------------
  if (uMode == 3) {
    int kc = sheetLayer();
    if (abs(c.z - kc) == 1 && inSheetExtent(w)) {
      vec4 st = sheetState(c);
      float Yd0 = max(1.0 - Yf - Yo - Yp, 0.0);
      float rho0 = rhoMix(T, invMolar(Yf, Yo, Yp, Yd0));
      float dm = 0.5 * st.b * uDt / (rho0 * uDx);   // eklenen kütle kesri
      dm = min(dm, 0.5);
      Yf = (Yf + dm) / (1.0 + dm);
      Yo = Yo / (1.0 + dm);
      Yp = Yp / (1.0 + dm);
      fv = fv / (1.0 + dm);
      T = (T + st.r * dm) / (1.0 + dm);
      float rho1 = rhoMix(T, invMolar(Yf, Yo, Yp, max(1.0 - Yf - Yo - Yp, 0.0)));
      Smass += ((1.0 + dm) * rho0 / rho1 - 1.0) / uDt;
    }
  }

  // ---------------- Tutuşturucu (sıcak tel / kıvılcım) ----------------
  bool inIgniter = false;
  if (uIgnT > 0.0) {
    // Levhada tutuşturucu, Saffire'daki gibi ön kenar boyunca gerilmiş bir teldir
    vec3 ic = uIgn.xyz;
    if (uMode == 3) ic.x = clamp(w.x, uSrc0.y, uSrc0.z);
    float d = length(w - ic) / uIgn.w;
    if (d < 1.0) {
      // Isıl zaman sabiti olan sonlu güçlü bir ısıtıcı: sıcaklık uIgnT'ye τ ile
      // yaklaşır. Anlık (Dirichlet) ısıtma, S = ln(T/T₀)/Δt'yi Δt ile ters orantılı
      // yapar; küçük adımda genleşme hızı patlar ve Δt daha da küçülür.
      float f = 1.0 - d * d;
      float r = 1.0 - exp(-uDt / 0.004);
      T = max(T, T + (uIgnT - T) * f * r);
      inIgniter = true;
    }
  }

  // ---------------- Söndürücü: inert gaz jeti ----------------
  // Jet çekirdeğindeki hücrelere seyreltici gaz (ortam sıcaklığında) karışır:
  // oksijen kesri ve sıcaklık jetin içinde düşer, jet hızı (constrainVel) bu
  // gazı alevin üzerine taşır. Jetin dışındaki alan olduğu gibi kalır.
  if (uSupS.x > 0.5) {
    float dj = length(w.yz - uSupC.yz) / uSupS.y;
    if (dj < 1.0) {
      float core = 1.0 - smoothstep(0.35, 1.0, dj);
      float mixk = core * (1.0 - exp(-uSupS.z * uDt));
      Yo *= 1.0 - mixk;
      Yf *= 1.0 - mixk;
      Yp *= 1.0 - mixk;
      T = mix(T, uTamb, mixk);
    }
  }

  // ---------------- CO₂ tüpü: oksijenden koparma (boğma) ----------------
  // Alevin çevresi inert gaz bulutuyla dolar: bulut içindeki O₂, seyreltici
  // ile yer değiştirir; gaz bir miktar soğur (CO₂'nin genleşmesi ve ısı
  // kapasitesi). Yakıt beslemesi sürer; alev oksijensiz kaldığı için söner.
  if (uSmo.x > 0.5) {
    float ds = length(w - uSupC.xyz) / uSmo.y;
    if (ds < 1.0) {
      float k = (1.0 - smoothstep(0.55, 1.0, ds)) * (1.0 - exp(-uSmo.z * uDt));
      Yo *= 1.0 - k;
      T = mix(T, uTamb, 0.25 * k);
    }
  }

  float T0 = T;
  float Yd = max(1.0 - Yf - Yo - Yp, 0.0);
  float invW = invMolar(Yf, Yo, Yp, Yd);
  float invW0 = invW;
  float rho = rhoMix(T, invW);
  float cp = cpMix(T, Yf, Yo, Yp, Yd);

  // ---------------- Tek adımlı global kimya ----------------
  float hrr = 0.0;
  float lim = min(Yf, Yo / uFuel.z);
  if (T > 450.0 && lim > 1e-9) {
    float cF = rho * Yf / uFuel.x * 1e-6;   // mol/cm³
    float cO = rho * Yo / W_O2 * 1e-6;
    float k = uKin.x * exp(-uKin.y / T) * pow(max(cF, 1e-16), uKin.z) * pow(max(cO, 1e-16), uKin.w);
    float omega = k * 1e6 * uFuel.x;          // kg/(m³ s) yakıt tüketimi
    float x = omega * uDt / (rho * lim);
    float dYf = lim * (1.0 - exp(-min(x, 60.0)));
    Yf -= dYf;
    Yo -= uFuel.z * dYf;
    Yp += (1.0 + uFuel.z) * dYf;
    float q = dYf * uFuel.y;                  // J/kg
    // Entalpi dengesi ∫c_p dT = q, c_p(T) ile (yamuk kuralı, sabit nokta).
    // c_p'yi soğuk gazın sıcaklığında almak, bir adımda tam yanan hücrede
    // sıcaklığı adyabatik alev sıcaklığının 500–1000 K üstüne çıkarır.
    float YdN = max(1.0 - Yf - Yo - Yp, 0.0);
    float cp0 = cpMix(T, Yf, Yo, Yp, YdN);
    float T1 = T + q / cp0;
    for (int it = 0; it < 4; it++) {
      float cpA = 0.5 * (cp0 + cpMix(T1, Yf, Yo, Yp, YdN));
      T1 = T + q / cpA;
    }
    T = min(T1, max(T, uTcap));
    hrr = rho * q / uDt;                      // W/m³
  }

  // ---------------- Düşük sıcaklık kimyası (soğuk alev, NTC) ----------------
  float hrrCool = 0.0;
  if (uCool.x > 0.5 && T > 450.0 && T < 1050.0) {
    float limc = min(Yf, Yo / uFuel.z);
    if (limc > 1e-7) {
      float ntc = 1.0 / (1.0 + exp((T - 790.0) / 32.0));
      float kl = uCool.y * exp(-uCool.z / T) * ntc * Yo;
      float dY = 0.5 * limc * (1.0 - exp(-kl * uDt));
      float qf = uCool.w;
      Yf -= dY;
      Yo -= uFuel.z * qf * dY;
      Yp += (1.0 + uFuel.z * qf) * dY;
      float q = dY * uFuel.y * qf;
      T += q / cp;
      hrrCool = rho * q / uDt;
    }
  }

  // ---------------- Kurum: çekirdeklenme, yüzey büyümesi, oksidasyon ----------------
  // İki denklemli modellerin tek denklemli indirgemesi (Moss–Brookes / Leung–Lindstedt
  // biçimi): çekirdeklenme ∝ ρ·Y_F·e^{−21100/T}, yüzey büyümesi ∝ Y_F·f_v·e^{−12100/T}.
  // Pirolize uğrayan yakıt 1400 K altında kurum öncülü (PAH) üretmez. Büyüme,
  // laminer difüzyon alevlerinde ölçülen 5–10 ppm tepe değerinde doyar.
  // Tutuşturucunun içi kurum tutmaz: orada yakıt değil sıcak inert gaz vardır.
  if (uSoot.x > 0.5) {
    float form = 0.0;
    float grow = 0.0;
    if (T > 1400.0 && Yf > 0.004 && !inIgniter) {
      form = 2.0e5 * uSoot.y * rho * Yf * exp(-21100.0 / T) / 1800.0;
      grow = 4.0e3 * uSoot.y * Yf * exp(-12100.0 / T) * max(1.0 - fv / 1.0e-5, 0.0);
    }
    // Oksidasyon hızı [1/s] = yüzey hızı × (6/ρ_s d_p), d_p ≈ 30 nm:
    //  O₂: Nagle–Strickland-Constable, düşük kısmi basınç sınırı
    //      ω = 120·p_O₂ e^{−19680/T} kg/m²s  →  k ≈ 1,3·10⁷ X_O₂ P[atm] e^{−19680/T}
    //  OH: Neoh tipi; OH, alev ucunda O₂ ile ürünlerin denge/üst-denge OH'si
    //      kadar (∝ √X_O₂·e^{−E/T}); 1800 K, %2 O₂'de ~300 1/s, 1400 K'de ~2 1/s.
    // Böylece kurum alev ucunda yanıp biter (dumansız mum); soğuyan ya da
    // oksijensiz kalan alevde kurum kaçar (isli/tüten alev).
    float XO2 = Yo / W_O2 / invW;
    float Patm = uP / 101325.0;
    float ox = uSoot.z * (1.33e7 * XO2 * Patm * exp(-19680.0 / T)
             + 3.7e10 * sqrt(max(XO2, 0.0) * Patm) * exp(-30000.0 / T))
             + 2.0e-7 * uSoot.z * hrr / max(rho, 0.01) * 1e-3;   // tepkime bölgesindeki OH
    fv = fv + (form + grow * fv) * uDt;
    fv *= exp(-ox * uDt);
    fv = clamp(fv, 0.0, 2.5e-5);
  } else {
    fv = 0.0;
  }

  // ---------------- Işınım: yayınım ve yeniden soğurma ----------------
  if (uRad.x > 0.5) {
    float kap = kappaPlanck(T, Yp, Yd, invW, fv);
    float T2 = T * T;
    float Eb = 4.0 * SIGMA_SB * T2 * T2;
    float Gin;
    { float Ta2 = uTamb * uTamb; Gin = 4.0 * SIGMA_SB * Ta2 * Ta2; }        // oda (çevre) ışınımı
    if (uRad.w > 0.5) Gin += CSv(uG, vec3(c)).r;                           // alevin kendi ışınımı
    float qr = kap * (Gin - Eb);                                          // W/m³
    float rhoN = rhoMix(T, invMolar(Yf, Yo, Yp, Yd));
    float Tn = T + qr * uDt / (rhoN * cp);
    // Işınım, sıcaklığı ışınım sıcaklığının (G/4σ)^¼ öte yanına geçiremez
    float Trad = pow(max(Gin, 1.0) / (4.0 * SIGMA_SB), 0.25);
    T = qr < 0.0 ? max(Tn, min(T, Trad)) : min(Tn, max(T, Trad));
  }

  // ---------------- Isıl genleşme kaynağı ∇·u = S ----------------
  // Düşük Mach sayılı süreklilik: ∇·u = D(ln T)/Dt − D(ln W)/Dt  (+ kütle kaynağı)
  float invW1 = invMolar(max(Yf, 0.0), max(Yo, 0.0), Yp, max(1.0 - Yf - Yo - Yp, 0.0));
  float Sx = (log(T / T0) + log(invW1 / invW0)) / uDt + Smass;
  // Adveksiyonun sayısal karışmasından doğan hacim (kütle tutarlılığı)
  if (ct == 0) Sx += texelFetch(uSadv, ivec2(gl_FragCoord.xy), 0).r;
  Sx = clamp(Sx, -600.0, 3000.0);
  // Kurum hacim kesri gazla birlikte genleşir: D(fv)/Dt = −fv ∇·u.
  // Yalnız genleşme uygulanır; yarı-Lagrange adveksiyonu sıkışan bölgelerde
  // değerleri zaten korur (çift sayımı önler).
  fv *= exp(-max(Sx, 0.0) * uDt);

  oSca = vec4(clamp(T, 150.0, max(uTcap, uTamb + 50.0)), max(Yf, 0.0), max(Yo, 0.0), fv * 1e6);
  // Yarım duyarlık yedeğinde 65504 üstü Inf olur ve komşu hücreleri zehirler;
  // 32 bit dokularda üst sınır yoktur (alev tabanında tek adımda tam yanma
  // 10¹² W/m³ mertebesine çıkabilir, kesilirse ısı bütçesi eksik sayılır).
  oAux = vec4(min(max(hrr, 0.0) * 1e-6, uAuxMax), clamp(Yp, 0.0, 1.0), Sx, min(max(hrrCool, 0.0) * 1e-6, uAuxMax));
}
`;

/* ------------------------------------------------------------------ */
/* Difüzyon: akı biçiminde, tam korunumlu, açık alt adımlı               */
/* ------------------------------------------------------------------ */
/*
 *   ρ⁰_i c_p (T_i' − T_i) = Δt_s/Δx² Σ_f λ_f (T_n − T_i)
 *   ρ⁰_i (Y_i' − Y_i)     = Δt_s/Δx² Σ_f (ρD)_f (Y_n − Y_i)
 *   λ_f = ½(λ_i + λ_n),  (ρD)_f = ½((λ/c_p)_i + (λ/c_p)_n) / Le
 * Her yüzün akısı iki hücre için eşit ve zıt işaretlidir; ρ⁰ (adım başındaki
 * hücre yoğunluğu) alt adımlar boyunca sabit tutulur. Böylece tür kütlesi ve
 * enerji tam korunur. Alt adım sayısı kararlılık sınırından (Σ katsayı < 1)
 * hesaplanır. Örtük Jacobi yakınsamadığında kütle korunmuyordu: hızlı yayılan
 * hidrojende (Le ≈ 0,3) yakıt kendiliğinden artıyordu.
 * Son alt adım, difüzyonun yoğunluk değişimini genleşme kaynağına ekler:
 *   S_d = ln(ρ⁰ / ρ(T', Y')) / Δt
 */
FL.SHADERS.diffuse = () => HT() + `
uniform sampler2D uRhsS;   // adım başı (ρ⁰ ve S_d için)
uniform sampler2D uRhsA;
uniform sampler2D uCurS;   // geçerli alt adım
uniform sampler2D uCurA;
uniform float uDtSub;
uniform float uDt;
uniform int uLast;
uniform vec4 uLewis;       // (Le_F, Le_O, Lewis etkileri açık, 0)
uniform float uDiffScale;
layout(location = 0) out vec4 oS;
layout(location = 1) out vec4 oA;

float rhoOf(vec4 s, float Yp) {
  return rhoMix(max(s.r, 150.0), invMolar(s.g, s.b, Yp, max(1.0 - s.g - s.b - Yp, 0.0)));
}

void main() {
  ivec3 c = cellCoord();
  if (outsideGrid(c)) { oS = vec4(0.0); oA = vec4(0.0); return; }
  vec4 sc = F(uCurS, c);
  vec4 ac = F(uCurA, c);
  vec4 a0 = F(uRhsA, c);
  int ct = cellType(c);
  if (ct != 0 || c.y == 0) { oS = sc; oA = vec4(a0.r, ac.g, a0.b, a0.a); return; }

  vec4 s0 = F(uRhsS, c);
  float rho0 = rhoOf(s0, a0.g);
  float Yp = ac.g;
  float T = max(sc.r, 150.0);
  float cp = cpMix(T, sc.g, sc.b, Yp, max(1.0 - sc.g - sc.b - Yp, 0.0));
  float lam = conductivity(T) * uDiffScale;
  float lc = lam / cp;
  float leF = uLewis.z > 0.5 ? uLewis.x : 1.0;
  float leO = uLewis.z > 0.5 ? uLewis.y : 1.0;
  float k = uDtSub / (uDx * uDx);

  float dT = 0.0;
  vec3 dY = vec3(0.0);   // (Y_F, Y_O, f_v)
  float dP = 0.0;
  ivec3 off[6] = ivec3[6](ivec3(1,0,0), ivec3(-1,0,0), ivec3(0,1,0), ivec3(0,-1,0), ivec3(0,0,1), ivec3(0,0,-1));
  for (int i = 0; i < 6; i++) {
    ivec3 n = c + off[i];
    if (!inDomain(n)) continue;            // açık sınır hücresinin dışı: akı yok
    int nt = cellType(n);
    vec4 sn = F(uCurS, n);
    float pn = F(uCurA, n).g;
    float Tn = max(sn.r, 150.0);
    float lamN = conductivity(Tn) * uDiffScale;
    dT += 0.5 * (lam + lamN) * (Tn - T);
    // Katılar türler için geçirimsizdir. Giriş hücreleri (nozul, eş-akış) sabit kütle
    // akılıdır: tür, girişten yalnız adveksiyonla gelir (Danckwerts koşulu).
    if (nt != 0) continue;
    float lcN = lamN / cpMix(Tn, sn.g, sn.b, pn, max(1.0 - sn.g - sn.b - pn, 0.0));
    float g = 0.5 * (lc + lcN);
    dY += g * vec3((sn.g - sc.g) / leF, (sn.b - sc.b) / leO, 0.002 * (sn.a - sc.a));
    dP += g * (pn - Yp) / 1.15;
  }
  vec4 sNew = vec4(T + k * dT / (rho0 * cp), max(sc.g + k * dY.x / rho0, 0.0), max(sc.b + k * dY.y / rho0, 0.0), max(sc.a + k * dY.z / rho0, 0.0));
  float YpN = clamp(Yp + k * dP / rho0, 0.0, 1.0);
  oS = sNew;
  float Sb = a0.b;
  if (uLast == 1) {
    float Sd = log(rho0 / max(rhoOf(sNew, YpN), 1e-9)) / uDt;
    Sb = clamp(a0.b + Sd, -800.0, 3000.0);
  }
  oA = vec4(a0.r, YpN, Sb, a0.a);
}
`;

/* ------------------------------------------------------------------ */
/* Vortisite ω = ∇ × u                                                   */
/* ------------------------------------------------------------------ */
FL.SHADERS.curl = () => H() + `
uniform sampler2D uVel;
out vec4 o;
void main() {
  ivec3 c = cellCoord();
  if (outsideGrid(c)) { o = vec4(0.0); return; }
  vec3 xp = F(uVel, c + ivec3(1, 0, 0)).xyz, xm = F(uVel, c - ivec3(1, 0, 0)).xyz;
  vec3 yp = F(uVel, c + ivec3(0, 1, 0)).xyz, ym = F(uVel, c - ivec3(0, 1, 0)).xyz;
  vec3 zp = F(uVel, c + ivec3(0, 0, 1)).xyz, zm = F(uVel, c - ivec3(0, 0, 1)).xyz;
  float inv = 0.5 / uDx;
  vec3 w = vec3((yp.z - ym.z) - (zp.y - zm.y),
                (zp.x - zm.x) - (xp.z - xm.z),
                (xp.y - xm.y) - (yp.x - ym.x)) * inv;
  o = vec4(w, length(w));
}
`;

/* ------------------------------------------------------------------ */
/* Kuvvetler: yüzdürme (tam yoğunluk oranı) + vortisite hapsetme        */
/* a_b = (1 − ρ∞/ρ) g = (1 − T/T∞ · W∞/W) g                              */
/* ------------------------------------------------------------------ */
FL.SHADERS.forces = () => HT() + CONSTRAIN + `
uniform sampler2D uVel;
uniform sampler2D uSca;
uniform sampler2D uAux;
uniform sampler2D uCurl;
uniform vec3 uGrav;      // yerçekimi vektörü [m/s²] (g-sarsıntısı dahil)
uniform float uEps;      // vortisite hapsetme katsayısı
uniform float uDt;
uniform float uWamb;     // ortam ortalama mol kütlesi
uniform float uVcap;     // hız güvenlik sınırı [m/s]
out vec4 o;

void main() {
  ivec3 c = cellCoord();
  if (outsideGrid(c)) { o = vec4(0.0); return; }
  vec3 u = F(uVel, c).xyz;
  vec4 s = F(uSca, c);
  float Yp = F(uAux, c).g;
  float T = max(s.r, 150.0);
  float Yd = max(1.0 - s.g - s.b - Yp, 0.0);
  float W = 1.0 / invMolar(s.g, s.b, Yp, Yd);
  // ρ/ρ∞ = (W/W∞)(T∞/T)
  float rhoRatio = (W / uWamb) * (uTamb / T);
  vec3 acc = (1.0 - 1.0 / rhoRatio) * uGrav;
  // (1 − ρ∞/ρ) g : sıcak (hafif) gaz g'nin tersine ivmelenir
  acc = clamp(acc, vec3(-200.0), vec3(200.0));

  if (uEps > 0.0) {
    float wl = F(uCurl, c + ivec3(1,0,0)).w - F(uCurl, c - ivec3(1,0,0)).w;
    float wd = F(uCurl, c + ivec3(0,1,0)).w - F(uCurl, c - ivec3(0,1,0)).w;
    float wb = F(uCurl, c + ivec3(0,0,1)).w - F(uCurl, c - ivec3(0,0,1)).w;
    vec3 g = vec3(wl, wd, wb);
    float gl = length(g);
    if (gl > 1e-8) {
      vec3 N = g / gl;
      vec3 om = F(uCurl, c).xyz;
      // f = ε·h·(N × ω): bir ivmedir; alt adım sayısından bağımsız kalması için Δt'ye bölünmez
      acc += 8.0 * uEps * uDx * cross(N, om);
    }
  }
  u += uDt * acc;
  // Uzak alan süngeri: alan, sakin bir odanın küçük bir parçasıdır. Açık yan
  // sınırlarda düzgün bir yatay akış (ör. söndürücü jetinin bıraktığı momentum)
  // hiçbir şeyle sönümlenmez ve alev saniyelerce yatık kalırdı. Kenardaki üç
  // hücrede yatay hız, sakin oda havasına doğru gevşetilir; sürüklenme (entrainment)
  // için gereken içeri akışı basınç izdüşümü yeniden kurar.
  // Rüzgâr varsa kenarlar sakin hava yerine rüzgâr hızına gevşetilir: rüzgâr
  // yönündeki yüzden girer, karşı yüzden çıkar.
  int db = min(min(c.x, uN.x - 1 - c.x), min(c.z, uN.z - 1 - c.z));
  if (db < 3) {
    float sig = 12.0 * (1.0 - float(db) / 3.0);
    u.xz = uWind.xz + (u.xz - uWind.xz) * exp(-sig * uDt);
  }
  float um = length(u);
  if (um > uVcap) u *= uVcap / um;
  u = constrainVel(c, u);
  o = vec4(u, 0.0);
}
`;

/* ------------------------------------------------------------------ */
/* Örtük viskozite: ν(T) = Pr · α(T)                                     */
/* ------------------------------------------------------------------ */
FL.SHADERS.viscosity = () => HT() + CONSTRAIN + `
uniform sampler2D uRhs;
uniform sampler2D uCur;
uniform sampler2D uSca;
uniform sampler2D uAux;
uniform float uDt;
uniform float uPr;
uniform float uDiffScale;
out vec4 o;

float muAt(ivec3 n) {
  vec4 s = F(uSca, n);
  float Yp = F(uAux, n).g;
  float T = max(s.r, 150.0);
  float Yd = max(1.0 - s.g - s.b - Yp, 0.0);
  return uPr * conductivity(T) / cpMix(T, s.g, s.b, Yp, Yd);   // μ = Pr λ/cp
}

void main() {
  ivec3 c = cellCoord();
  if (outsideGrid(c)) { o = vec4(0.0); return; }
  vec3 u0 = F(uRhs, c).xyz;
  if (cellType(c) != 0 || c.y == 0) { o = vec4(constrainVel(c, u0), 0.0); return; }
  vec4 s = F(uSca, c);
  float Yp = F(uAux, c).g;
  float T = max(s.r, 150.0);
  float Yd = max(1.0 - s.g - s.b - Yp, 0.0);
  float rho = rhoMix(T, invMolar(s.g, s.b, Yp, Yd));
  float mu = muAt(c);
  float k = uDt / (uDx * uDx) * uDiffScale / rho;
  vec3 num = u0;
  float den = 1.0;
  ivec3 off[6] = ivec3[6](ivec3(1,0,0), ivec3(-1,0,0), ivec3(0,1,0), ivec3(0,-1,0), ivec3(0,0,1), ivec3(0,0,-1));
  for (int i = 0; i < 6; i++) {
    ivec3 n = c + off[i];
    if (!inDomain(n)) continue;
    float a = k * 0.5 * (mu + muAt(n));
    num += a * F(uCur, n).xyz;   // katı komşular hız = 0 (kaymazlık)
    den += a;
  }
  o = vec4(constrainVel(c, num / den), 0.0);
}
`;

/* ------------------------------------------------------------------ */
/* Diverjans: r = ∇·u* − S                                              */
/* ------------------------------------------------------------------ */
FL.SHADERS.divergence = () => H() + `
uniform sampler2D uVel;
uniform sampler2D uAux;
uniform float uExpansion;   // ısıl genleşme açık (1) / kapalı (0)
out vec4 o;
void main() {
  ivec3 c = cellCoord();
  if (outsideGrid(c)) { o = vec4(0.0); return; }
  if (isSolidType(cellType(c))) { o = vec4(0.0); return; }
  float div = (F(uVel, c + ivec3(1,0,0)).x - F(uVel, c - ivec3(1,0,0)).x
             + F(uVel, c + ivec3(0,1,0)).y - F(uVel, c - ivec3(0,1,0)).y
             + F(uVel, c + ivec3(0,0,1)).z - F(uVel, c - ivec3(0,0,1)).z) * (0.5 / uDx);
  float Sx = F(uAux, c).b * uExpansion;
  o = vec4(div - Sx, 0.0, 0.0, 0.0);
}
`;

/* ------------------------------------------------------------------ */
/* Basınç Poisson: kırmızı-siyah ardışık aşırı gevşetme (SOR)           */
/* Sınırlar: yanlar/üst açık (p=0), alt Neumann, katılar Neumann        */
/* ------------------------------------------------------------------ */
const PRESSURE_NB = `
float pNb(ivec3 n, float pc) {
  if (n.y < 0) return pc;                                    // alt: Neumann
  if (!inDomain(n)) return 0.0;                              // açık sınır
  if (isSolidType(cellType(n))) return pc;                   // katı: Neumann
  return F(uP, n).r;
}
`;
FL.SHADERS.pressure = () => H() + `
uniform sampler2D uP;
uniform sampler2D uDiv;
uniform int uColor;
uniform float uOmega;
out vec4 o;
` + PRESSURE_NB + `
void main() {
  ivec3 c = cellCoord();
  if (outsideGrid(c)) { o = vec4(0.0); return; }
  float p = F(uP, c).r;
  int parity = (c.x + c.y + c.z) & 1;
  if (parity != uColor || isSolidType(cellType(c))) { o = vec4(p, 0.0, 0.0, 0.0); return; }
  float sum = pNb(c + ivec3(1,0,0), p) + pNb(c - ivec3(1,0,0), p)
            + pNb(c + ivec3(0,1,0), p) + pNb(c - ivec3(0,1,0), p)
            + pNb(c + ivec3(0,0,1), p) + pNb(c - ivec3(0,0,1), p);
  float pn = (sum - uDx * uDx * F(uDiv, c).r) / 6.0;
  o = vec4(mix(p, pn, uOmega), 0.0, 0.0, 0.0);
}
`;

/* ------------------------------------------------------------------ */
/* Gradyan çıkarma: u = u* − ∇p, sonra sınır koşulları                    */
/* ------------------------------------------------------------------ */
FL.SHADERS.subtract = () => H() + CONSTRAIN + `
uniform sampler2D uVel;
uniform sampler2D uP;
out vec4 o;
` + PRESSURE_NB + `
void main() {
  ivec3 c = cellCoord();
  if (outsideGrid(c)) { o = vec4(0.0); return; }
  vec3 u = F(uVel, c).xyz;
  float p = F(uP, c).r;
  vec3 g = vec3(pNb(c + ivec3(1,0,0), p) - pNb(c - ivec3(1,0,0), p),
                pNb(c + ivec3(0,1,0), p) - pNb(c - ivec3(0,1,0), p),
                pNb(c + ivec3(0,0,1), p) - pNb(c - ivec3(0,0,1), p)) * (0.5 / uDx);
  u -= g;
  u = clamp(u, vec3(-25.0), vec3(25.0));
  o = vec4(constrainVel(c, u), 0.0);
}
`;

/* ------------------------------------------------------------------ */
/* İnce katı yakıt levhası: ısıl denge + Arrhenius piroliz              */
/* Doku boyutu NX × NY (levha x–y düzleminde, z = zc)                   */
/* ------------------------------------------------------------------ */
FL.SHADERS.sheet = () => HT() + `
uniform sampler2D uPrev;     // (Ts, m, mdot'', 0)
uniform sampler2D uSca;
uniform float uDt;
uniform vec4 uPyro;          // (A, Ta, ΔH_p, m0 toplam)
uniform vec4 uSheetP;        // (c_s, ε, alev ışınımı geri besleme, eylemsiz kesir)
uniform float uCInert;       // eylemsiz iskeletin özgül ısısı (cam elyaf)
uniform vec2 uSheetX;        // (tutuşturucunun ısıtabileceği en yüksek sıcaklık, piroliz gazı c_p)
uniform vec4 uIgn;
uniform float uIgnT;
out vec4 o;

void main() {
  ivec2 ij = ivec2(gl_FragCoord.xy);
  vec4 st = texelFetch(uPrev, ij, 0);
  vec3 w = (vec3(float(ij.x), float(ij.y), 0.0) + 0.5) * uDx;
  if (!inSheetExtent(w)) { o = vec4(uTamb, 0.0, 0.0, 0.0); return; }
  int kc = sheetLayer();
  float Ts = st.r;
  float m = st.g;
  float Tg1 = F(uSca, ivec3(ij, kc - 1)).r;
  float Tg2 = F(uSca, ivec3(ij, kc + 1)).r;

  // Isı akıları (birim alan): iletim, ışınım kaybı ve alev ışınımı geri beslemesi.
  // Piroliz gazının yüzeyden üflenmesi (Stefan akışı) ilk hücre içinde çözülemez;
  // film kuramı düzeltmesi β/(e^β − 1), β = ṁ″c_p Δ/λ, iletimi buna göre azaltır.
  float l1 = conductivity(0.5 * (Tg1 + Ts));
  float l2 = conductivity(0.5 * (Tg2 + Ts));
  float bk = 0.5 * st.b * uSheetX.y * uDx;
  float b1 = max(bk / l1, 1e-4), b2 = max(bk / l2, 1e-4);
  float qc = (l1 * (Tg1 - Ts) * b1 / (exp(b1) - 1.0) + l2 * (Tg2 - Ts) * b2 / (exp(b2) - 1.0)) / uDx;
  float Ts2 = Ts * Ts, Ta2 = uTamb * uTamb;
  float qloss = 2.0 * uSheetP.y * SIGMA_SB * (Ts2 * Ts2 - Ta2 * Ta2);
  float Tgm = max(Tg1, Tg2);
  // Alev ışınımı bitişik (yakıtça zengin, görece soğuk) hücreden değil, birkaç
  // milimetre ötedeki alev cephesinden gelir
  float Tf = Tgm;
  for (int k = 2; k <= 4; k++) {
    if (float(k) * uDx > 6e-3) break;
    Tf = max(Tf, max(F(uSca, ivec3(ij, kc - k)).r, F(uSca, ivec3(ij, kc + k)).r));
  }
  float Tf2 = Tf * Tf;
  float qfr = uSheetP.z * SIGMA_SB * max(Tf2 * Tf2 - Ts2 * Ts2, 0.0);

  // Arrhenius piroliz: dm/dt = −A exp(−Ta/Ts) m
  float r = uPyro.x * exp(-uPyro.y / max(Ts, 250.0));
  float mNew = m * exp(-min(r * uDt, 50.0));
  float mdot = uPyro.w * (1.0 - uSheetP.w) * (m - mNew) / uDt;   // kg/(m² s)

  float thermalMass = max(uPyro.w * ((1.0 - uSheetP.w) * m * uSheetP.x + uSheetP.w * uCInert), 1.5);
  float dTs = uDt * (qc + qfr - qloss - mdot * uPyro.z) / thermalMass;
  float TsNew = Ts + dTs;
  // Gazdan daha sıcak olamaz (iletimle ısınma sınırı)
  TsNew = clamp(TsNew, uTamb - 5.0, max(max(Tgm, Ts), uTamb));

  // Sıcak tel: ~60 kW/m² akı, yalnız lifler piroliz sıcaklığına ulaşana dek. Ötesini alev
  // ısıtmalı; yoksa ön kenar, alev kendini taşıyamadan yanıp tükenir
  if (uIgnT > 0.0 && abs(w.y - uIgn.y) < uIgn.w * 1.2 && TsNew < uSheetX.x) {
    TsNew = min(TsNew + uDt * 6.0e4 / thermalMass, uSheetX.x);
  }
  o = vec4(TsNew, mNew, mdot, 0.0);
}
`;

/* ------------------------------------------------------------------ */
/* İstatistik: hücre bazında toplam ve maksimumlar (MRT ×3)              */
/* ------------------------------------------------------------------ */
FL.SHADERS.stats = () => HT() + RADC + `
uniform sampler2D uSca;
uniform sampler2D uAux;
uniform sampler2D uVel;
uniform float uHrrThr;     // alev bölgesi eşiği [MW/m³]
uniform vec3 uAnchor;      // alev uzunluğu / yarıçapı referans noktası
// Görüntüyle aynı yayınım katsayısı: ışık şiddeti I = ∫ j dV (optik ince)
uniform sampler2D uLUT;
uniform vec2 uLUTRange;
uniform float uSootGain;
uniform vec3 uChemCol;
uniform vec3 uCoolCol;
uniform float uLumOn;
uniform sampler2D uGs;    // alevin gelen ışınımı (kaba bloklar)
layout(location = 0) out vec4 oSum;
layout(location = 1) out vec4 oMax;
layout(location = 2) out vec4 oSum2;
layout(location = 3) out vec4 oLum;

vec3 lutSootS(float T) {
  float u = clamp((T - uLUTRange.x) / (uLUTRange.y - uLUTRange.x), 0.0, 1.0) * 511.0;
  int i0 = clamp(int(u), 0, 511);
  int i1 = min(i0 + 1, 511);
  return mix(texelFetch(uLUT, ivec2(i0, 0), 0).rgb, texelFetch(uLUT, ivec2(i1, 0), 0).rgb, u - float(i0));
}

void main() {
  ivec3 c = cellCoord();
  if (outsideGrid(c) || cellType(c) != 0) { oSum = vec4(0.0); oMax = vec4(0.0); oSum2 = vec4(0.0); oLum = vec4(0.0); return; }
  vec3 w = worldPos(c);
  vec4 s = F(uSca, c);
  vec4 a = F(uAux, c);
  vec3 v = F(uVel, c).xyz;
  float dV = uDx * uDx * uDx;
  float T = s.r;
  float fv = s.a * 1e-6;
  float Yp = a.g;
  float Yd = max(1.0 - s.g - s.b - Yp, 0.0);
  float invW = invMolar(s.g, s.b, Yp, Yd);
  // Net ışınım kaybı (yayınım − yeniden soğurma)
  float qr = 0.0;
  {
    float k = kappaPlanck(max(T, 150.0), Yp, Yd, invW, fv);
    float Gin = 4.0 * SIGMA_SB * pow(uTamb, 4.0) + (uRad.w > 0.5 ? CSv(uGs, vec3(c)).r : 0.0);
    qr = k * (4.0 * SIGMA_SB * pow(T, 4.0) - Gin);
  }
  float hrr = a.r * 1e6;
  bool flame = a.r > uHrrThr;
  oSum = vec4(hrr * dV, qr * dV, fv * 1800.0 * dV * 1e9, a.a * 1e6 * dV);
  oMax = vec4(T, length(v), flame ? w.y : 0.0, flame ? length(w - uAnchor) : 0.0);
  vec3 j = vec3(0.0);
  if (uLumOn > 0.5) {
    j = fv * lutSootS(T) * uSootGain + max(a.r, 0.0) * 1e6 * uChemCol + max(a.a, 0.0) * 1e6 * uCoolCol;
  }
  vec3 I = j * dV;                                  // ışık şiddeti katkısı [cd]
  float IY = dot(I, vec3(0.2126, 0.7152, 0.0722));
  oSum2 = vec4(hrr * dV * w, IY);
  oLum = vec4(I, IY * w.y);
}
`;

/* ------------------------------------------------------------------ */
/* 4×4 indirgeme (toplam ya da maksimum)                                */
/* ------------------------------------------------------------------ */
FL.SHADERS.reduce = () => FL.SHADERS.header + `
uniform sampler2D uSrc;
uniform int uOp;          // 0 toplam, 1 maksimum
out vec4 o;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy) * 4;
  ivec2 sz = textureSize(uSrc, 0);
  vec4 acc = uOp == 0 ? vec4(0.0) : vec4(-1e30);
  for (int j = 0; j < 4; j++)
  for (int i = 0; i < 4; i++) {
    ivec2 q = p + ivec2(i, j);
    if (q.x < sz.x && q.y < sz.y) {
      vec4 v = texelFetch(uSrc, q, 0);
      acc = uOp == 0 ? acc + v : max(acc, v);
    }
  }
  o = acc;
}
`;

/* ------------------------------------------------------------------ */
/* Başlatma: sabit değer + geometri koşulları                            */
/* ------------------------------------------------------------------ */
FL.SHADERS.init = () => HT() + CONSTRAIN + `
uniform vec4 uValue;
uniform int uKind;    // 0 SCA, 1 VEL, 2 diğer
uniform float uWallT;
out vec4 o;
void main() {
  ivec3 c = cellCoord();
  if (outsideGrid(c)) { o = vec4(0.0); return; }
  if (uKind == 1) { o = vec4(constrainVel(c, uValue.xyz), 0.0); return; }
  if (uKind == 0) {
    int ct = cellType(c);
    if (ct == 1) { o = vec4(uWallT, 0.0, 0.0, 0.0); return; }
    if (ct == 2) { o = vec4(uSrc2.y, uSrc2.x, 0.0, 0.0); return; }
    if (ct == 5) { o = vec4(uSrc1.x, 0.0, 0.0, 0.0); return; }
  }
  o = uValue;
}
`;

/* Hücre türü dokusu: geometri değiştiğinde bir kez üretilir */
FL.SHADERS.celltype = () => H() + `
// Sahneye yerleştirilen modelin alan içindeki hücreleri (CPU'da vokselleştirilir): eylemsiz katı
uniform sampler2D uMOcc;
uniform float uMOccOn;
out vec4 o;
void main() {
  ivec3 c = cellCoord();
  if (outsideGrid(c)) { o = vec4(0.0); return; }
  int t = cellTypeGeo(c);
  if (t == 0 && uMOccOn > 0.5 && texelFetch(uMOcc, texelOf(c), 0).r > 0.5) t = 1;
  o = vec4(float(t) / 255.0, 0.0, 0.0, 1.0);
}
`;

/* Levha başlatma */
FL.SHADERS.sheetInit = () => FL.SHADERS.header + FL.SHADERS.common + `
uniform float uTamb;
out vec4 o;
void main() {
  ivec2 ij = ivec2(gl_FragCoord.xy);
  vec3 w = (vec3(float(ij.x), float(ij.y), 0.0) + 0.5) * uDx;
  o = inSheetExtent(w) ? vec4(uTamb, 1.0, 0.0, 0.0) : vec4(uTamb, 0.0, 0.0, 0.0);
}
`;
