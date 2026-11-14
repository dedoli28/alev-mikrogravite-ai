/* =====================================================================
 * Alev Laboratuvarı — Yangın ve patlama efektleri: gölgelendiriciler
 * ---------------------------------------------------------------------
 * Parçacıklar durumsuzdur: CPU yalnız doğum parametrelerini bir kez yazar,
 * hareketi köşe gölgelendiricisi kapalı biçimde hesaplar. Canlı parçacık
 * başına kare maliyeti yoktur.
 *
 *   drag > 0 : gazla taşınan (alev, duman). Uç hıza (yüzdürme + gaz akışı)
 *              üstel olarak yaklaşır.
 *   drag = 0 : balistik (vakum, kıvılcım). Sabit ivme.
 *
 * Renkler fiziksel birimdedir: ışıklılık [cd/m²] × ön pozlama. Böylece
 * efektler, ışın yürütücünün alevi ve fiziksel kamera (ISO, obtüratör,
 * diyafram) ile aynı pozlamadan geçer.
 * ===================================================================== */
import { FL } from '../core/fl.js';

const HEAD = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
`;

/* Görüntüdeki kara cisim rengi (800–3000 K): çekirdek sarı-beyaz, uçlar kırmızı */
const BLACKBODY = `
vec3 blackbody(float kelvin) {
  float t = clamp((kelvin - 800.0) / 2200.0, 0.0, 1.0);
  vec3 tint = vec3(1.0, pow(t, 1.6) * 0.9 + 0.02, pow(t, 4.0) * 0.75);
  return tint * (0.06 + 3.2 * t * t * t);
}
`;

const particleVS = (sparks) => HEAD + (sparks ? '#define SPARKS 1\n' : '') + `
layout(location = 0) in vec2 corner;
layout(location = 1) in vec4 aPosBirth;   // konum, doğum zamanı
layout(location = 2) in vec4 aVelLife;    // ilk hız, ömür
layout(location = 3) in vec4 aTermDrag;   // uç hız (ya da ivme), sürüklenme
layout(location = 4) in vec4 aSizeKind;   // boyut0, boyut1, tür, tohum
layout(location = 5) in vec4 aParams;     // sıcaklık|albedo, şiddet|opaklık, mavi|iç ışık, dönüş

uniform mat4 uViewM;
uniform mat4 uProjM;
uniform float uTime;
// Gaz sızdırmaz hacim (kabin): içinde doğan gaz duvardan geçmez, duvar boyunca yayılır
uniform vec3 uBoxLo;
uniform vec3 uBoxHi;
uniform float uBoxOn;
uniform float uFloorY;

out vec2 vUv;
out float vAge;
out float vSize;
out float vKind;
out float vSeed;
out vec4 vParams;
out vec4 vWorld;
out float vSpeed;

void main() {
  vSpeed = 0.0;
  float t = uTime - aPosBirth.w;
  float life = aVelLife.w;
  float age = life > 0.0 ? t / life : 2.0;
  if (t < 0.0 || age >= 1.0) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    vUv = vec2(0.0); vAge = 1.0; vSize = 0.0; vKind = 0.0; vSeed = 0.0; vParams = vec4(0.0); vWorld = vec4(0.0);
    return;
  }

  float drag = aTermDrag.w;
  vec3 position;
  vec3 velocity;
  if (drag < 0.001) {
    position = aPosBirth.xyz + aVelLife.xyz * t + 0.5 * aTermDrag.xyz * t * t;
    velocity = aVelLife.xyz + aTermDrag.xyz * t;
  } else {
    float decay = exp(-drag * t);
    position = aPosBirth.xyz + aTermDrag.xyz * t + (aVelLife.xyz - aTermDrag.xyz) * (1.0 - decay) / drag;
    velocity = aTermDrag.xyz + (aVelLife.xyz - aTermDrag.xyz) * decay;
  }

  vSpeed = length(velocity);
  float seed = aSizeKind.w;
  float kind = aSizeKind.z;
  float size = mix(aSizeKind.x, aSizeKind.y, pow(age, 0.75));

  float contained = 0.0;
  if (uBoxOn > 0.5) {
    vec3 tol = vec3(0.3);
    if (all(greaterThan(aPosBirth.xyz, uBoxLo - tol)) && all(lessThan(aPosBirth.xyz, uBoxHi + tol))) {
      contained = 1.0;
      float margin = min(size * 0.55, 0.5);
      vec3 lo = uBoxLo + margin, hi = max(uBoxHi - margin, lo);
      vec3 c = clamp(position, lo, hi);
      vec3 ex = position - c;
      float excess = length(ex);
      if (excess > 0.0) {
        // Duvara ulaşan gaz duvar boyunca yayılır: tavanın altında duman katmanı böyle oluşur
        vec3 r = vec3(fract(seed * 7.31), fract(seed * 13.7), fract(seed * 3.17)) - 0.5;
        vec3 tang = r * (1.0 - step(vec3(1e-6), abs(ex)));
        position = clamp(c + tang * excess * 1.6, lo, hi);
        velocity *= 0.3;
      }
    }
  }
  if (uFloorY > -1.0e5) position.y = max(position.y, uFloorY + min(size * 0.3, 0.2));

  vec4 mv = uViewM * vec4(position, 1.0);
  vec2 viewVel = (uViewM * vec4(velocity, 0.0)).xy;
  float speed = length(viewVel);

  float angle = seed * 6.2831853 + aParams.w * t;
  vec2 axis = vec2(sin(angle), cos(angle));
  float stretch = 1.0;

#ifdef SPARKS
  axis = speed > 0.0001 ? viewVel / speed : axis;
  stretch = 1.0 + speed * 0.011 / max(size, 0.0005);
#else
  // Alev hareket yönüne yatar; duman ve durgun alev rastgele yönde kalır
  if (kind < 0.5) {
    float lean = clamp(speed * 1.6 * 0.075 / max(aSizeKind.x, 0.004), 0.0, 1.0);
    vec2 dir = speed > 0.0001 ? viewVel / speed : axis;
    axis = normalize(mix(axis, dir, lean) + vec2(0.0, 0.0001));
    stretch = 1.0 + 0.95 * lean;
  }
#endif

  vec2 perp = vec2(axis.y, -axis.x);
  vec2 offset = (perp * corner.x + axis * corner.y * stretch) * size;
  mv.xy += offset;
  vec3 camRight = vec3(uViewM[0][0], uViewM[1][0], uViewM[2][0]);
  vec3 camUp = vec3(uViewM[0][1], uViewM[1][1], uViewM[2][1]);
  vWorld = vec4(position + camRight * offset.x + camUp * offset.y, contained);

  vUv = corner;
  vAge = age;
  vSize = size;
  vKind = kind;
  vSeed = seed;
  vParams = aParams;
  gl_Position = uProjM * mv;
}
`;

/* Sahne derinliği: ışın yürütücünün aux.a kanalı (katı yüzeye ışın boyu uzaklık, m) */
const SOFT_DEPTH = `
uniform sampler2D uDepth;
uniform vec2 uInvViewport;
uniform vec3 uCamPos;
uniform float uSoft;
uniform vec3 uBoxLo;
uniform vec3 uBoxHi;
in vec4 vWorld;

// Parçacıklar derinlik eki olmayan düşük çözünürlüklü tampona çizilir;
// örtülme ve yumuşak kesişim sahne derinliğinden gelir.
float softDepth(float size) {
  float sceneT = texture(uDepth, gl_FragCoord.xy * uInvViewport).a;
  float fragT = length(vWorld.xyz - uCamPos);
  return clamp((sceneT - fragT) / (size * 0.55 + uSoft) + 0.35, 0.0, 1.0);
}

// Pano, temsil ettiği gazdan geniştir: kabin duvarından taşan kısım kırpılır
float containClip() {
  if (vWorld.w < 0.5) return 1.0;
  vec3 d = min(vWorld.xyz - uBoxLo, uBoxHi - vWorld.xyz);
  float w = max(uSoft * 4.0, 0.02);
  return smoothstep(0.0, w, d.x) * smoothstep(0.0, w, d.y) * smoothstep(0.0, w, d.z);
}
`;

const fireFS = () => HEAD + `
uniform sampler2D uNoise;
uniform float uGain;        // cd/m² × ön pozlama
// 0 gerçekçi · 1 termal / sıcaklık · 2 yer gerçeği maskesi · 3 ısı salınımı · 4 kurum · 5 hız ·
// 6 türler · 7 Schlieren (yoğunluk açığı) · 8 ışınım · 9 yapay zekâ görünümü
uniform int uFxView;
uniform vec2 uHeatRange;    // (T_ortam, T_üst) sahte renk ölçeği
uniform float uVelRange;    // hız görünümünün üst sınırı [m/s]
in float vSpeed;
in vec2 vUv;
in float vAge;
in float vSize;
in float vKind;
in float vSeed;
in vec4 vParams;
` + SOFT_DEPTH + BLACKBODY + FL.SHADERS.colormaps + `
out vec4 oColor;

void main() {
  float r = length(vUv);
  if (r >= 1.0) discard;
  float soft = softDepth(vSize);
  if (soft <= 0.0) discard;

  float temperature = vParams.x;
  float intensity = vParams.y;
  vec3 color = vec3(0.0);
  float alpha = 0.0;

  if (vKind > 1.5) {
    // Parlama: çok parlak bir kaynağın çevresinde saçılan ışık
    if (uFxView != 0) discard;
    float glow = max(0.0, exp(-r * r * 5.0) - 0.0067);
    float fade = 1.0 - vAge;
    // (ışıklılık alev gövdesinin üçte biri: çevreye saçılan ışık kaynağın kendisinden sönüktür)
    color = blackbody(temperature) * glow * fade * fade * intensity * uGain * 0.3;
  } else {
    vec2 offset = vec2(fract(vSeed * 37.31), fract(vSeed * 91.73));
    vec2 nuv = vUv * 0.21 + offset;
    nuv.y -= vAge * 0.32;
    float n = texture(uNoise, nuv).r * 0.62
            + texture(uNoise, nuv * 2.7 + vec2(0.31, vAge * 0.25)).g * 0.38;

    // Gaz yandıkça dışından içine doğru aşınan gürültülü bir kütle
    float tip = vUv.y * 0.42 * step(0.0, vUv.y);
    float body = (1.0 - r - tip) * 1.55 + (n - 0.5) * 1.5 - vAge * 0.9;
    float mask = smoothstep(0.0, 0.5, body);
    float fadeIn = smoothstep(0.0, 0.1, vAge);
    float core = clamp(body, 0.0, 1.0);
    float cover = mask * fadeIn * 0.5;
    float kelvin = temperature * (1.0 - 0.45 * vAge) * (0.8 + 0.25 * core);

    if (uFxView == 2) {
      // Yer gerçeği: tepkime bölgesi (alev gövdesi) beyaz
      float m = step(0.12, cover * intensity);
      color = vec3(m);
      alpha = m;
    } else if (uFxView == 1) {
      float v = clamp((kelvin - uHeatRange.x) / max(uHeatRange.y - uHeatRange.x, 1.0), 0.0, 1.0);
      alpha = min(cover * 1.6 * smoothstep(0.02, 0.3, v), 1.0);
      color = inferno(0.12 + 0.88 * v) * alpha;
    } else if (uFxView == 3) {
      // Isı salınımı: tepkime kabuğu (genç, yoğun gaz) en parlak
      float v = clamp(intensity * (0.35 + 0.65 * core) * (1.0 - 0.6 * vAge), 0.0, 1.0);
      alpha = min(cover * 1.7 * smoothstep(0.03, 0.25, v), 1.0);
      color = inferno(0.15 + 0.85 * v) * alpha;
    } else if (uFxView == 4) {
      // Kurum: sarı (kurumlu) alev gövdesi; mavi, kurumsuz alevde yok
      float v = clamp((1.0 - vParams.z) * (0.3 + 0.7 * core) * intensity, 0.0, 1.0);
      alpha = min(cover * 1.5 * smoothstep(0.02, 0.2, v), 1.0);
      color = mix(vec3(0.55, 0.5, 0.45), turbo(v), 0.75) * alpha;
    } else if (uFxView == 5) {
      // Hız: yanan gazın hızı
      float v = clamp(vSpeed / max(uVelRange, 1e-4), 0.0, 1.0);
      alpha = min(cover * 1.5, 1.0);
      color = turbo(v) * alpha;
    } else if (uFxView == 6) {
      // Türler: çekirdekte yakıt buharı (yeşil), kabukta oksijen tükenmesi (mavi)
      float fuelV = smoothstep(0.35, 0.95, core) * (1.0 - vAge);
      alpha = min(cover * 1.5, 1.0);
      color = (vec3(0.15, 0.95, 0.45) * fuelV + vec3(0.25, 0.45, 1.0) * (1.0 - 0.6 * fuelV)) * alpha;
    } else if (uFxView == 7) {
      // Schlieren: sıcak gazın yoğunluk açığı (bileşik geçişte gradyanı alınır)
      alpha = min(cover * 1.4 * clamp((kelvin - 400.0) / 1400.0, 0.0, 1.0), 1.0);
      color = vec3(alpha);
    } else if (uFxView == 8) {
      // Işınım: yayılan güç ∝ T⁴ (log ölçek)
      float e = intensity * pow(kelvin / 2000.0, 4.0) * (0.4 + 0.6 * core);
      float v = clamp(log(1.0 + 12.0 * e) / log(13.0), 0.0, 1.0);
      alpha = min(cover * 1.5 * smoothstep(0.02, 0.25, v), 1.0);
      color = inferno(0.1 + 0.9 * v) * alpha;
    } else if (uFxView == 9) {
      // Yapay zekâ görünümü: gerçekleşen (benzetimdeki) alev camgöbeği-beyaz
      alpha = min(cover * 1.6, 1.0);
      color = mix(vec3(0.05, 0.75, 1.0), vec3(1.0), smoothstep(0.3, 0.95, core)) * alpha * (0.6 + 0.4 * intensity);
    } else {
      // Yayınım + soğurma: üst üste binen alevler sınırsız toplanmaz, renk en sıcak
      // katmana yakınsar; sarı çekirdek / turuncu gövde / kırmızı uç korunur.
      vec3 hot = blackbody(kelvin) * 1.7;
      // Kurumsuz alev mavidir (CH*/C₂* ışıması): her alevin tabanı ve mikrogravite alevinin tamamı
      float wholeFlame = smoothstep(0.3, 0.6, vParams.z);
      float blueMix = vParams.z * mix(1.0 - smoothstep(0.0, 0.3, vAge), 1.0, wholeFlame);
      blueMix = clamp(blueMix + (1.0 - core) * 0.3 * vParams.z * wholeFlame, 0.0, 1.0);
      vec3 blue = vec3(0.12, 0.38, 1.9) * (0.3 + 0.7 * core);
      vec3 emission = mix(hot, blue, blueMix) * intensity;
      color = emission * cover * uGain;
      alpha = cover * clamp(dot(emission, vec3(0.3, 0.5, 0.2)) * 0.8, 0.0, 1.0);
    }
  }

  soft *= containClip();
  oColor = vec4(color * soft, alpha * soft);
}
`;

const smokeFS = () => HEAD + `
uniform sampler2D uNoise;
uniform float uGain;        // ön pozlama
uniform float uAmbL;        // ortam ışıklılığı [cd/m²]
uniform vec4 uKey;          // tavan lambası: konum + ışık şiddeti [cd]
uniform vec4 uFire;         // yangın ışığı: konum + ışık şiddeti [cd]
uniform vec3 uFireCol;
uniform vec4 uSun;          // güneş yönü + aydınlık [lx]
uniform float uGlowNit;     // alevin yakınındaki dumanın iç ışığı [cd/m²]
uniform int uFxView;        // 0 gerçekçi, 4 kurum (sahte renk), 9 yapay zekâ (soluk gri)
in vec2 vUv;
in float vAge;
in float vSize;
in float vSeed;
in vec4 vParams;
` + SOFT_DEPTH + BLACKBODY + FL.SHADERS.colormaps + `
out vec4 oColor;

void main() {
  float r = length(vUv);
  if (r >= 1.0) discard;
  float soft = softDepth(vSize);
  if (soft <= 0.0) discard;

  vec2 offset = vec2(fract(vSeed * 53.17), fract(vSeed * 17.89));
  vec2 nuv = vUv * 0.17 + offset + vec2(0.0, vAge * 0.06);
  float n = texture(uNoise, nuv).r * 0.6 + texture(uNoise, nuv * 3.1 + 0.47).g * 0.4;

  float body = (1.0 - r) * 1.45 + (n - 0.5) * 1.35 - 0.12;
  float mask = smoothstep(0.0, 0.75, body);
  float fade = smoothstep(0.0, 0.12, vAge) * (1.0 - smoothstep(0.5, 1.0, vAge));
  float alpha = mask * fade * vParams.y * soft * containClip();
  if (alpha < 0.003) discard;
  if (uFxView == 4) {
    // Kurum görünümü: duman, taşıdığı kurum yoğunluğuyla (opaklık) renklenir
    float a4 = min(alpha * 1.6, 1.0);
    oColor = vec4(mix(vec3(0.55, 0.5, 0.45), turbo(clamp(0.15 + 1.6 * vParams.y * mask, 0.0, 1.0)), 0.75) * a4, a4);
    return;
  }
  if (uFxView == 9) {
    oColor = vec4(vec3(0.32, 0.36, 0.42) * alpha * 0.5, alpha * 0.5);
    return;
  }

  // Ucuz hacim gölgelendirmesi: puf, sahne ışıklarıyla aydınlanan bir küre gibi
  float density = 0.7 + 0.3 * (n * 2.0 - 0.5);
  vec3 E = vec3(uAmbL * 3.14159);
  vec3 lk = uKey.xyz - vWorld.xyz;
  float dk = max(dot(lk, lk), 0.01);
  E += vec3(1.0, 0.96, 0.9) * uKey.w / dk * 0.7;
  vec3 lf = uFire.xyz - vWorld.xyz;
  float df = max(dot(lf, lf), 0.02);
  E += uFireCol * uFire.w / df * 0.6;
  E += vec3(1.0, 0.96, 0.9) * uSun.w * (0.35 + 0.4 * r);
  vec3 lit = vec3(vParams.x) * E / 3.14159 * density;
  // Aleve yakın duman içeriden aydınlanır
  float glow = vParams.z * pow(1.0 - vAge, 3.0);
  lit += blackbody(1750.0) * glow * (0.5 + 0.5 * mask) * uGlowNit;

  oColor = vec4(lit * uGain * alpha, alpha);
}
`;

const sparkFS = () => HEAD + `
uniform float uGain;
uniform sampler2D uDepth;
uniform vec2 uInvViewport;
uniform vec3 uCamPos;
in vec2 vUv;
in float vAge;
in vec4 vParams;
in vec4 vWorld;
` + BLACKBODY + `
out vec4 oColor;

void main() {
  float across = exp(-vUv.x * vUv.x * 7.0);
  float along = 1.0 - vUv.y * vUv.y;
  float shape = across * along * along;
  if (shape < 0.01) discard;
  float sceneT = texture(uDepth, gl_FragCoord.xy * uInvViewport).a;
  if (length(vWorld.xyz - uCamPos) > sceneT + 0.002) discard;
  float fade = 1.0 - vAge * vAge;
  float kelvin = vParams.x * (1.0 - 0.45 * vAge);
  oColor = vec4(blackbody(kelvin) * shape * fade * vParams.y * uGain, 1.0);
}
`;

const MAX_SHOCK = 4;

/* Sahne + parçacık tamponu; şok dalgası kırılması ve ısı titreşimi aynı geçişte */
const compositeFS = () => HEAD + `
in vec2 vUv;
uniform sampler2D tScene;
uniform sampler2D tParticles;
uniform sampler2D uNoise;
uniform vec4 uShock[${MAX_SHOCK}];
uniform float uShockWidth[${MAX_SHOCK}];
uniform float uAspect;
uniform float uTime;
uniform float uHaze;
out vec4 oColor;

void main() {
  vec2 uv = vUv;
  vec2 push = vec2(0.0);

  // Şok cephesi: arkasındakini kıran ince bir sıkışmış gaz kabuğu
  for (int i = 0; i < ${MAX_SHOCK}; i++) {
    float strength = uShock[i].w;
    if (strength <= 0.0) continue;
    vec2 d = uv - uShock[i].xy;
    d.x *= uAspect;
    float dist = length(d);
    float x = (dist - uShock[i].z) / uShockWidth[i];
    if (abs(x) < 1.0) {
      float f = 1.0 - x * x;
      vec2 dir = d / max(dist, 0.0001);
      dir.x /= uAspect;
      push -= dir * f * f * strength;
    }
  }
  uv += push;

  vec4 particles = texture(tParticles, uv);

  // Isı titreşimi: sahnenin önündeki sıcak gaz içinden geçen ışığı büker
  float heat = clamp(max(particles.r, particles.a) * 1.5, 0.0, 1.0) * uHaze;
  vec2 shimmer = vec2(0.0);
  if (heat > 0.004) {
    vec2 n = texture(uNoise, vUv * vec2(uAspect, 1.0) * 1.7 + vec2(0.0, -uTime * 0.35)).ba - 0.5;
    shimmer = n * heat * 0.006;
  }

  vec3 scene;
  if (dot(push, push) > 0.0) {
    // Şok cephesinde hafif renk ayrışması
    scene.r = texture(tScene, uv + shimmer + push * 0.22).r;
    scene.g = texture(tScene, uv + shimmer).g;
    scene.b = texture(tScene, uv + shimmer - push * 0.22).b;
  } else {
    scene = texture(tScene, uv + shimmer).rgb;
  }

  oColor = vec4(scene * (1.0 - clamp(particles.a, 0.0, 1.0)) + particles.rgb, 1.0);
}
`;

/* Enkaz: tek örneklenmiş çizim; kızgın parçalar ışır */
const debrisVS = () => HEAD + `
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNor;
layout(location = 2) in vec4 iPosHeat;
layout(location = 3) in vec4 iAxisAngle;
layout(location = 4) in vec4 iScale;
layout(location = 5) in vec3 iColor;
uniform mat4 uVP;
out vec3 vW;
out vec3 vN;
out vec3 vCol;
out float vHeat;

vec3 rot(vec3 v, vec3 k, float a) {
  float c = cos(a), s = sin(a);
  return v * c + cross(k, v) * s + k * dot(k, v) * (1.0 - c);
}

void main() {
  vec3 p = rot(aPos * iScale.xyz, iAxisAngle.xyz, iAxisAngle.w) + iPosHeat.xyz;
  vW = p;
  vN = rot(aNor / max(iScale.xyz, vec3(1e-6)), iAxisAngle.xyz, iAxisAngle.w);
  vCol = iColor;
  vHeat = iPosHeat.w;
  gl_Position = iScale.x > 0.0 ? uVP * vec4(p, 1.0) : vec4(0.0, 0.0, 2.0, 1.0);
}
`;

const debrisFS = () => HEAD + `
in vec3 vW;
in vec3 vN;
in vec3 vCol;
in float vHeat;
uniform sampler2D uDepth;
uniform vec2 uInvViewport;
uniform vec3 uCamPos;
uniform float uGain;
uniform float uAmbL;
uniform vec4 uKey;
uniform vec4 uFire;
uniform vec3 uFireCol;
uniform vec4 uSun;
uniform float uGlowNit;
out vec4 oColor;

void main() {
  float sceneT = texture(uDepth, gl_FragCoord.xy * uInvViewport).a;
  vec3 v = uCamPos - vW;
  if (length(v) > sceneT + 0.002) discard;
  vec3 n = normalize(vN);
  if (dot(n, v) < 0.0) n = -n;
  vec3 alb = vCol * (1.0 - 0.6 * smoothstep(0.1, 0.6, vHeat));
  vec3 E = vec3(uAmbL * 3.14159);
  vec3 lk = uKey.xyz - vW;
  float dk = max(dot(lk, lk), 0.01);
  E += vec3(1.0, 0.96, 0.9) * uKey.w / dk * max(dot(n, lk / sqrt(dk)), 0.0);
  vec3 lf = uFire.xyz - vW;
  float df = max(dot(lf, lf), 0.02);
  E += uFireCol * uFire.w / df * max(dot(n, lf / sqrt(df)), 0.0);
  E += vec3(1.0, 0.96, 0.9) * uSun.w * max(dot(n, uSun.xyz), 0.0);
  vec3 col = alb * E / 3.14159;
  float t = clamp(vHeat, 0.0, 1.0);
  col += vec3(1.0, pow(t, 1.6) * 0.8 + 0.02, pow(t, 4.0) * 0.5) * (5.0 * t * t * t * t) * uGlowNit;
  oColor = vec4(col * uGain, 1.0);
}
`;

FL.FX_SHADERS = { particleVS, fireFS, smokeFS, sparkFS, compositeFS, debrisVS, debrisFS, MAX_SHOCK };
