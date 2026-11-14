/* =====================================================================
 * Alev Laboratuvarı — Termokimya ve taşınım özellikleri
 * ---------------------------------------------------------------------
 * Bu modül CPU tarafında çalışır. GPU çözücüsüne gönderilecek tüm
 * fiziksel sabitleri ve karışım özelliklerini hesaplar:
 *   - Yakıt veritabanı (Westbrook & Dryer 1981 tek adımlı kinetik)
 *   - Seyreltici gazlar (N2, CO2, He, Ar)
 *   - Ortam oksijen kütle kesri, stokiyometrik karışım kesri
 *   - Adyabatik alev sıcaklığı tahmini (sabit basınç, ısı kapasitesi
 *     sıcaklığa doğrusal bağımlı, yüksek sıcaklıkta ayrışma düzeltmesi)
 *   - Spalding transfer sayısı ve d²-yasası yanma hız sabiti
 *   - Boyutsuz sayılar (Gr, Re, Fr, Ri, Da)
 * Birimler: SI (m, s, kg, K, Pa, J, W), aksi belirtilmedikçe.
 * ===================================================================== */
import { FL } from '../core/fl.js';

/* ------------------------------------------------------------------ */
/* Evrensel sabitler                                                   */
/* ------------------------------------------------------------------ */
const C = {
  R: 8.314462618,          // J/(mol K)
  R_CAL: 1.987204,         // cal/(mol K)
  SIGMA: 5.670374419e-8,   // Stefan–Boltzmann, W/(m² K⁴)
  G0: 9.80665,             // standart yerçekimi, m/s²
  P_ATM: 101325,           // Pa
  W_O2: 0.031999,          // kg/mol
  W_N2: 0.028014,
  W_CO2: 0.044010,
  W_H2O: 0.018015,
  W_HE: 0.0040026,
  W_AR: 0.039948,
  RHO_SOOT: 1800,          // kg/m³, kurum yoğunluğu
  KENT_SOOT: 1862,         // κ_P = 1862 fv T  [1/m] (Kent & Honnery)
  SOOT_KE: 4.9,            // Rayleigh soğurma sabiti κ_λ = Ke fv / λ
};
FL.C = C;

/* ------------------------------------------------------------------ */
/* Seyreltici gaz özellikleri                                           */
/* cp(T) = a + b T  [J/(kg K)], λ(T) = l0 (T/300)^ln  [W/(m K)]          */
/* ------------------------------------------------------------------ */
const DILUENTS = {
  N2: {
    id: 'N2', name: 'Azot (N₂)', W: C.W_N2,
    cpA: 975, cpB: 0.155, l0: 0.0259, ln: 0.80,
    note: 'Hava benzeri referans atmosfer.',
  },
  CO2: {
    id: 'CO2', name: 'Karbondioksit (CO₂)', W: C.W_CO2,
    cpA: 780, cpB: 0.31, l0: 0.0166, ln: 1.05,
    radiating: true,
    note: 'Yüksek ısı kapasitesi ve ışınım: alev sıcaklığını düşürür (Mars atmosferi, söndürücü).',
  },
  HE: {
    id: 'HE', name: 'Helyum (He)', W: C.W_HE,
    cpA: 5193, cpB: 0.0, l0: 0.155, ln: 0.72,
    note: 'Çok yüksek ısıl yayınım: alev kalınlaşır, kurum azalır.',
  },
  AR: {
    id: 'AR', name: 'Argon (Ar)', W: C.W_AR,
    cpA: 520, cpB: 0.0, l0: 0.0177, ln: 0.73,
    note: 'Düşük ısı kapasitesi: daha sıcak alev.',
  },
};
FL.DILUENTS = DILUENTS;

/* ------------------------------------------------------------------ */
/* Yakıt veritabanı                                                     */
/*  A, Ea, a, b : Westbrook & Dryer (1981) tek adımlı global kinetik     */
/*                ω = A exp(-Ea/RT) [F]^a [O2]^b,  [ ] mol/cm³           */
/*  dHc   : alt ısıl değer [J/kg]                                       */
/*  s     : stokiyometrik O2/yakıt kütle oranı                          */
/*  Wp    : ürünlerin (CO2+H2O) ortalama mol kütlesi                    */
/*  sootProp : göreli kurum eğilimi (etilen = 1)                        */
/*  c2ch  : C2* / CH* kemilüminesans oranı                               */
/*  Le    : yakıt Lewis sayısı (havada)                                 */
/* ------------------------------------------------------------------ */
const FUELS = {
  CH4: {
    id: 'CH4', name: 'Metan (CH₄)', formula: 'CH4',
    W: 0.016043, A: 8.3e5, Ea: 30.0, a: -0.3, b: 1.3,
    dHc: 50.0e6, s: 3.989, Wp: 0.02670, sootProp: 0.12,
    c2ch: 0.08, co2star: 0.6, Le: 0.97,
    kinBoost: 60,
    phase: 'gas', sources: ['jet'],
    note: 'Düşük kurum eğilimi; jet alevi mavi tabanlı, sarı uçlu.',
  },
  C3H8: {
    id: 'C3H8', name: 'Propan (C₃H₈)', formula: 'C3H8',
    W: 0.044097, A: 8.6e11, Ea: 30.0, a: 0.1, b: 1.65,
    dHc: 46.35e6, s: 3.628, Wp: 0.03122, sootProp: 0.55,
    c2ch: 0.1, co2star: 0.6, Le: 1.80,
    kinBoost: 4,
    phase: 'gas', sources: ['jet'],
    note: 'Orta düzey kurum; Le > 1.',
  },
  C2H4: {
    id: 'C2H4', name: 'Etilen (C₂H₄)', formula: 'C2H4',
    W: 0.028054, A: 2.0e12, Ea: 30.0, a: 0.1, b: 1.65,
    dHc: 47.2e6, s: 3.422, Wp: 0.03100, sootProp: 1.00,
    c2ch: 0.2, co2star: 0.6, Le: 1.25,
    kinBoost: 3,
    phase: 'gas', sources: ['jet'],
    note: 'Kurum çalışmaları için referans yakıt (ACME tipi deneyler).',
  },
  C7H16: {
    id: 'C7H16', name: 'n-Heptan (C₇H₁₆)', formula: 'C7H16',
    W: 0.100204, A: 5.1e11, Ea: 30.0, a: 0.25, b: 1.5,
    dHc: 44.56e6, s: 3.513, Wp: 0.03014, sootProp: 0.85,
    c2ch: 0.12, co2star: 0.6, Le: 2.8,
    phase: 'liquid', sources: ['droplet', 'jet'],
    // Sıvı özellikleri (damla modeli)
    rhoL: 684, Tb: 371.6, Lv: 3.17e5, cpL: 2240,
    coolFlame: true,
    note: 'İki aşamalı tutuşma: düşük sıcaklıkta "soğuk alev" (FLEX deneyleri).',
  },
  H2: {
    id: 'H2', name: 'Hidrojen (H₂)', formula: 'H2',
    W: 0.002016, A: 1.8e13, Ea: 35.0, a: 1.0, b: 0.5,
    dHc: 119.96e6, s: 7.937, Wp: C.W_H2O, sootProp: 0.0,
    c2ch: 0.0, co2star: 0.0, Le: 0.30, h2o: true,
    phase: 'gas', sources: ['jet'],
    note: 'Kurum ve CH* yok: gün ışığında neredeyse görünmez alev.',
  },
  PARAFFIN: {
    id: 'PARAFFIN', name: 'Parafin mumu (≈C₂₅H₅₂)', formula: 'C25H52',
    W: 0.35269, A: 5.1e11, Ea: 30.0, a: 0.25, b: 1.5,
    dHc: 43.0e6, s: 3.47, Wp: 0.0300, sootProp: 1.25,
    // Le: fitilden çıkan C₂₅ buharı alevin karanlık çekirdeğinde (≈ 900–1300 K)
    // küçük parçalara (C₂H₂, C₂H₄, CH₄, H₂) kraklanır; tepkime bölgesine yayınan
    // etkin yakıt hafiftir. C₂₅ buharının Le≈2,5 değeri yayınımı 2,5 kat yavaşlatıp
    // alevi Roper korelasyonunun (≈2,7 cm) ve gerçek mum alevinin (3–4 cm) iki katı
    // uzunluğa çıkarıyordu. Etkin değer 1,2 (C₂H₂/C₂H₄ karışımı).
    c2ch: 0.12, co2star: 0.6, Le: 1.2,
    phase: 'solid-melt', sources: ['candle'],
    Tvap: 620,
    note: 'Fitil ile taşınan buhar; karanlık çekirdekte kraklanır, etkin Lewis sayısı küçük parçalarınkidir. Kinetik n-heptan ile yaklaşıklanmıştır.',
  },
  CELLULOSE: {
    id: 'CELLULOSE', name: 'Pamuk-cam elyaf kumaş (selüloz)', formula: 'C6H10O5',
    W: 0.16214, A: 8.6e11, Ea: 30.0, a: 0.1, b: 1.65,
    dHc: 16.1e6, s: 1.184, Wp: 0.0258, sootProp: 0.25,
    c2ch: 0.08, co2star: 0.6, Le: 1.4,
    phase: 'solid', sources: ['sheet'],
    // SIBAL kumaşı: %75 pamuk + %25 cam elyaf, 18,2 mg/cm², 0,32 mm. Piroliz kinetiği,
    // ısıl kapasiteler ve yayıcılık Olson vd. (Combust. Flame 2023) yüzey enerji dengesinden
    pyroA: 1.626e11, pyroE: 161.44e3, pyroDH: 3.0e5,
    areal: 0.182, inert: 0.25, cS: 1260, cInert: 700, emis: 0.8,
    color: [0.86, 0.84, 0.78],
    note: 'Saffire tipi ince kumaş; cam elyaf iskelet yandıktan sonra kalır.',
  },
  PMMA: {
    id: 'PMMA', name: 'PMMA (pleksiglas)', formula: 'C5H8O2',
    W: 0.10012, A: 8.6e11, Ea: 30.0, a: 0.1, b: 1.65,
    dHc: 25.2e6, s: 1.918, Wp: 0.0298, sootProp: 0.70,
    c2ch: 0.1, co2star: 0.6, Le: 1.9,
    phase: 'solid', sources: ['sheet'],
    pyroA: 8.5e12, pyroE: 188.0e3, pyroDH: 8.7e5,
    areal: 0.060, inert: 0.0, cS: 1460, emis: 0.92,
    color: [0.70, 0.80, 0.86],
    note: 'Termoplastik; tamamen gazlaşır, levhada delik açılır.',
  },
};
FL.FUELS = FUELS;

/* Kaynak tipleri */
const SOURCES = {
  jet: { id: 'jet', name: 'Gaz jeti (nozul)', code: 0 },
  candle: { id: 'candle', name: 'Mum (fitil)', code: 1 },
  droplet: { id: 'droplet', name: 'Yakıt damlası', code: 2 },
  sheet: { id: 'sheet', name: 'İnce katı yakıt levhası', code: 3 },
};
FL.SOURCES = SOURCES;

/* ------------------------------------------------------------------ */
/* Yardımcılar                                                         */
/* ------------------------------------------------------------------ */
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const lerp = (a, b, t) => a + (b - a) * t;
FL.clamp = clamp;
FL.lerp = lerp;

/** Türkçe sayı biçimlendirme (anlamlı basamak) */
FL.fmt = function (x, digits) {
  if (x === undefined || x === null || !isFinite(x)) return '—';
  const d = digits === undefined ? 3 : digits;
  const ax = Math.abs(x);
  if (ax !== 0 && (ax < 1e-3 || ax >= 1e6)) {
    const e = Math.floor(Math.log10(ax));
    const m = x / Math.pow(10, e);
    return m.toFixed(Math.max(0, d - 1)).replace('.', ',') + '×10' + FL.sup(e);
  }
  let dec = Math.max(0, d - 1 - Math.floor(Math.log10(ax || 1)));
  dec = Math.min(dec, 4);
  return x.toFixed(dec).replace('.', ',');
};
const SUP = { '-': '⁻', 0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹' };
FL.sup = function (n) {
  return String(n).split('').map((c) => SUP[c] || c).join('');
};

/** En küçük kareler doğrusu y = a + b·x (d²-yasası eğimi, yayılma hızı) */
FL.linfit = function (xs, ys) {
  const n = xs.length;
  if (n < 4) return null;
  let sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i]; sy += ys[i]; sxx += xs[i] * xs[i]; sxy += xs[i] * ys[i]; syy += ys[i] * ys[i];
  }
  const den = n * sxx - sx * sx;
  if (Math.abs(den) < 1e-12) return null;
  const b = (n * sxy - sx * sy) / den;
  const a = (sy - b * sx) / n;
  const r2den = (n * sxx - sx * sx) * (n * syy - sy * sy);
  const r2 = r2den > 0 ? Math.pow(n * sxy - sx * sy, 2) / r2den : 0;
  return { a, b, r2, n };
};

/* ------------------------------------------------------------------ */
/* Özgül ısı modelleri                                                  */
/* ------------------------------------------------------------------ */
// Oksijen ve ürünler (CO2+H2O karışımı) için doğrusal cp(T)
const CP_O2 = { a: 880, b: 0.150 };
const CP_PROD = { a: 1000, b: 0.400 };
const CP_PROD_H2O = { a: 1600, b: 0.570 };
const CP_FUEL = { a: 1400, b: 1.2 };     // hidrokarbon buharı (kaba)

/**
 * Karışım cp [J/(kg K)].
 * Yüksek sıcaklıkta (T > 1800 K) CO2/H2O ayrışmasının etkisi, etkin
 * ısı kapasitesine eklenen bir terimle yaklaşıklanır. Bu sayede tek
 * adımlı kimya ile adyabatik sıcaklık ~100–150 K fazla tahmin edilmez.
 */
function cpMix(T, Yf, Yo, Yp, dil, fuel) {
  const Yd = Math.max(0, 1 - Yf - Yo - Yp);
  const prod = fuel && fuel.h2o ? CP_PROD_H2O : CP_PROD;
  let cp =
    Yf * (CP_FUEL.a + CP_FUEL.b * T) +
    Yo * (CP_O2.a + CP_O2.b * T) +
    Yp * (prod.a + prod.b * T) +
    Yd * (dil.cpA + dil.cpB * T);
  cp += 0.55 * Math.max(T - 1800, 0) * (Yp > 0 ? Math.min(1, Yp * 4) : 0);
  return cp;
}
FL.cpMix = cpMix;

/* ------------------------------------------------------------------ */
/* Atmosfer bileşimi                                                    */
/* ------------------------------------------------------------------ */
/**
 * Oksijen mol kesri X_O2 ve seyreltici verildiğinde ortam kütle
 * kesirlerini ve ortalama mol kütlesini döndürür.
 */
function ambientComposition(xO2, dilId) {
  const dil = DILUENTS[dilId] || DILUENTS.N2;
  const x = clamp(xO2, 0.0005, 1.0);
  const mO = x * C.W_O2;
  const mD = (1 - x) * dil.W;
  const Yo = mO / (mO + mD);
  const W = x * C.W_O2 + (1 - x) * dil.W;
  return { Yo, Yd: 1 - Yo, W, xO2: x, dil };
}
FL.ambientComposition = ambientComposition;

/** Gaz yoğunluğu (ideal gaz) */
function density(P, T, W) {
  return (P * W) / (C.R * T);
}
FL.density = density;

/** Karışım ısıl iletkenliği [W/(m K)] — mol kesri ağırlıklı */
function conductivity(T, xDil, dil) {
  const lAir = 0.0263 * Math.pow(T / 300, 0.8);
  const lDil = dil.l0 * Math.pow(T / 300, dil.ln);
  return xDil * lDil + (1 - xDil) * lAir;
}
FL.conductivity = conductivity;

/** Isıl yayınım α = λ/(ρ cp) [m²/s] */
function thermalDiffusivity(T, P, amb) {
  const rho = density(P, T, amb.W);
  const cp = amb.dil.cpA + amb.dil.cpB * T;
  const cpMixAmb = amb.Yo * (CP_O2.a + CP_O2.b * T) + amb.Yd * cp;
  const lam = conductivity(T, 1 - amb.xO2, amb.dil);
  return lam / (rho * cpMixAmb);
}
FL.thermalDiffusivity = thermalDiffusivity;

/* ------------------------------------------------------------------ */
/* Stokiyometri ve alev sıcaklığı                                       */
/* ------------------------------------------------------------------ */
/**
 * Burke–Schumann karışım kesri: Z_st = 1 / (1 + s Y_F,1 / Y_O,∞)
 * Y_F,1 : yakıt akımındaki yakıt kütle kesri (seyreltme ile < 1)
 */
function stoichMixtureFraction(fuel, Yo_inf, YF1) {
  return 1 / (1 + (fuel.s * YF1) / Yo_inf);
}
FL.stoichMixtureFraction = stoichMixtureFraction;

/**
 * Adyabatik alev sıcaklığı (stokiyometrik difüzyon alevi için).
 * Enerji: ∫ cp dT = Z_st Y_F1 ΔHc, sabit noktadan sayısal çözüm.
 */
function adiabaticFlameTemperature(fuel, amb, T0, YF1, Tfuel) {
  const Zst = stoichMixtureFraction(fuel, amb.Yo, YF1);
  const Tin = Zst * (Tfuel || T0) + (1 - Zst) * T0;
  // Ürün karışımı (stokiyometride)
  const Yf0 = Zst * YF1;
  const Yp = Yf0 * (1 + fuel.s);
  const Yo = 0;
  const qtot = Yf0 * fuel.dHc;
  let T = Tin;
  const dT = 2.0;
  let q = 0;
  while (q < qtot && T < 4000) {
    q += cpMix(T + dT / 2, 0, Yo, Yp, amb.dil, fuel) * dT;
    T += dT;
  }
  return { T, Zst };
}
FL.adiabaticFlameTemperature = adiabaticFlameTemperature;

/* ------------------------------------------------------------------ */
/* Damla yanması: Spalding B ve d²-yasası                               */
/* ------------------------------------------------------------------ */
/**
 * K = 8 (λ/cp)_g / ρ_L · ln(1 + B)
 * B = [cp (T∞ − T_b) + Y_O∞ ΔHc / s] / L_v
 * Doğal/zorlanmış taşınım için Ranz–Marshall tipi düzeltme:
 *   Nu/Nu0 = (2 + 0.6 Gr^{1/4} Pr^{1/3}) / 2  ya da Re ile benzeri
 * hotFlame=false ise yalnız buharlaşma (yanma terimi olmadan).
 */
function dropletBurning(fuel, amb, P, Tinf, d, g, Uinf, hotFlame, coolFlame, Ys) {
  if (!fuel.rhoL) return { K: 0, B: 0, mdot: 0, Tf: Tinf, rFlame: 0 };
  const Tfilm = hotFlame ? 0.5 * (fuel.Tb + 1700) : 0.5 * (fuel.Tb + Tinf);
  const rhoF = density(P, Tfilm, amb.W);
  const cpg = amb.Yo * (CP_O2.a + CP_O2.b * Tfilm) + amb.Yd * (amb.dil.cpA + amb.dil.cpB * Tfilm);
  const lam = conductivity(Tfilm, 1 - amb.xO2, amb.dil) * 0.44; // yakıt buharı katkısı ile azalan etkin λ (n-heptan için K ≈ 0,7 mm²/s)
  let B;
  if (hotFlame) {
    B = (cpg * (Tinf - fuel.Tb) + (amb.Yo * fuel.dHc) / fuel.s) / fuel.Lv;
  } else if (coolFlame) {
    // Soğuk alevde yaklaşık %10–15 ısı salınımı
    B = (cpg * (Tinf - fuel.Tb) + (0.12 * amb.Yo * fuel.dHc) / fuel.s) / fuel.Lv;
  } else {
    B = (cpg * (Tinf - fuel.Tb)) / fuel.Lv;
  }
  // Kütle aktarım sayısı B_M = Y_s / (1 − Y_s): yanma yokken buharlaşmayı belirler
  if (Ys !== undefined) B = Math.max(B, Ys / Math.max(1 - Ys, 0.02));
  B = Math.max(B, 1e-4);
  let K = ((8 * lam) / (cpg * fuel.rhoL)) * Math.log(1 + B);
  // Taşınım düzeltmesi
  const alpha = lam / (rhoF * cpg);
  const nu = 0.7 * alpha;
  const Pr = 0.7;
  const beta = 1 / Tinf;
  const dTn = hotFlame ? 1400 : Math.max(Tinf - fuel.Tb, 1);
  const Gr = (g * beta * dTn * d * d * d) / (nu * nu);
  const Re = (Uinf * d) / nu;
  const nuFree = 2 + 0.6 * Math.pow(Math.max(Gr, 0), 0.25) * Math.pow(Pr, 1 / 3);
  const nuForced = 2 + 0.6 * Math.sqrt(Math.max(Re, 0)) * Math.pow(Pr, 1 / 3);
  const corr = Math.max(nuFree, nuForced) / 2;
  K *= corr;
  const mdot = (Math.PI * d * fuel.rhoL * K) / 4; // kg/s
  // Alev konumu (yarı-küresel kuram): r_f / r_s = ln(1+B) / ln(1 + Y_O∞/s)
  const rRatio = hotFlame ? Math.log(1 + B) / Math.log(1 + amb.Yo / fuel.s) : 0;
  return { K, B, mdot, Gr, Re, corr, rRatio, rhoFilm: rhoF };
}
FL.dropletBurning = dropletBurning;

/* ------------------------------------------------------------------ */
/* Mum fitili: taşınımla ısı geri beslemesi                            */
/* ------------------------------------------------------------------ */
/**
 * Fitilden buharlaşma, alevden fitile gelen ısıyla orantılıdır; bu da
 * Nusselt sayısıyla ölçeklenir (Ranz–Marshall: Nu = 2 + 0,6·max(Gr^¼, Re^½)·Pr^⅓).
 * Dünya'da (1 g, durgun hava) Nu referanstır; mikro-g'de doğal taşınım kaybolur,
 * Nu → 2 ve buharlaşma yaklaşık yarıya iner. Zorlanmış akış (ISS havalandırması)
 * Re üzerinden geri kazandırır. Dönüş: (oran, Nu, Nu_ref).
 */
function wickConvection(state, amb, Tad) {
  const L = 0.005;                                   // fitil + alev tabanı ölçeği [m]
  const Tinf = state.Tamb;
  const Tf = Math.max(Math.min(Tad, 2000), Tinf + 100);
  const P = state.pressure * 1000;
  const nuOf = (g, U) => {
    const Tm = 0.5 * (Tf + Tinf);
    const nu = 0.7 * thermalDiffusivity(Tm, P, amb);
    const Gr = (g * (Tf - Tinf) / Tinf * L * L * L) / (nu * nu);
    const Re = (U * L) / nu;
    const Pr3 = Math.pow(0.7, 1 / 3);
    return 2 + 0.6 * Math.max(Math.pow(Math.max(Gr, 0), 0.25), Math.sqrt(Math.max(Re, 0))) * Pr3;
  };
  // Referans: aynı gaz, deniz seviyesi basıncı, 1 g, durgun
  const ref = (() => {
    const Tm = 0.5 * (Tf + Tinf);
    const nu = 0.7 * thermalDiffusivity(Tm, C.P_ATM, amb);
    const Gr = (C.G0 * (Tf - Tinf) / Tinf * L * L * L) / (nu * nu);
    return 2 + 0.6 * Math.pow(Gr, 0.25) * Math.pow(0.7, 1 / 3);
  })();
  const Nu = nuOf(state.gravity * C.G0, (state.flow || 0) / 100);
  return { ratio: Nu / ref, Nu, NuRef: ref };
}
FL.wickConvection = wickConvection;

/* ------------------------------------------------------------------ */
/* Boyutsuz sayılar                                                    */
/* ------------------------------------------------------------------ */
function dimensionless(opts) {
  const { g, L, U, Tf, Tinf, P, amb } = opts;
  const Tm = 0.5 * (Tf + Tinf);
  const alpha = thermalDiffusivity(Tm, P, amb);
  const nu = 0.7 * alpha;
  const beta = 1 / Tinf;
  const dT = Math.max(Tf - Tinf, 1);
  const Gr = (g * beta * dT * L * L * L) / (nu * nu);
  const Re = (U * L) / nu;
  const Fr = g > 0 ? (U * U) / (g * L) : Infinity;
  const Ri = Re > 0 ? Gr / (Re * Re) : Infinity;
  // Yüzdürme ile oluşan karakteristik hız ve difüzif hız
  const Ub = Math.sqrt(Math.max(g * L * dT / Tinf, 0));
  const Ud = alpha / L;
  let regime;
  if (Ri > 10 && Ub > 3 * Ud) regime = 'Yüzdürme baskın (doğal taşınım)';
  else if (Re > 1 && (Ri < 0.1 || g === 0)) regime = U > 3 * Ud ? 'Momentum baskın (zorlanmış akış)' : 'Difüzyon baskın';
  else if (Ub < 3 * Ud && U < 3 * Ud) regime = 'Difüzyon baskın (mikrogravite)';
  else regime = 'Karma taşınım';
  return { Gr, Re, Fr, Ri, alpha, nu, Ub, Ud, regime };
}
FL.dimensionless = dimensionless;

/* ------------------------------------------------------------------ */
/* Işınım: kara cisim + CIE 1931 renk eşleme fonksiyonları             */
/* ------------------------------------------------------------------ */
// Wyman, Sloan & Shirley (2013) çok-loblu analitik CMF yaklaşımı
function g3(x, mu, s1, s2) {
  const t = (x - mu) / (x < mu ? s1 : s2);
  return Math.exp(-0.5 * t * t);
}
function cieXYZ(lambdaNm) {
  const l = lambdaNm;
  const x = 1.056 * g3(l, 599.8, 37.9, 31.0) + 0.362 * g3(l, 442.0, 16.0, 26.7) - 0.065 * g3(l, 501.1, 20.4, 26.2);
  const y = 0.821 * g3(l, 568.8, 46.9, 40.5) + 0.286 * g3(l, 530.9, 16.3, 31.1);
  const z = 1.217 * g3(l, 437.0, 11.8, 36.0) + 0.681 * g3(l, 459.0, 26.0, 13.8);
  return [x, y, z];
}
FL.cieXYZ = cieXYZ;

/** CIE XYZ → doğrusal sRGB (D65) */
function xyzToLinearSRGB(X, Y, Z) {
  return [
    3.2406 * X - 1.5372 * Y - 0.4986 * Z,
    -0.9689 * X + 1.8758 * Y + 0.0415 * Z,
    0.0557 * X - 0.204 * Y + 1.057 * Z,
  ];
}
FL.xyzToLinearSRGB = xyzToLinearSRGB;

/** Planck spektral ışıması B_λ(T) [W/(m² sr m)] */
const C1 = 1.191042972e-16; // 2hc² [W m²/sr]
const C2 = 1.438776877e-2;  // hc/k [m K]
function planck(lambdaM, T) {
  const x = C2 / (lambdaM * T);
  if (x > 700) return 0;
  return C1 / (Math.pow(lambdaM, 5) * (Math.exp(x) - 1));
}
FL.planck = planck;

/**
 * Gamut dışı rengi (negatif bileşenler) beyaza doğru karıştırarak
 * parlaklığı koruyup sRGB'ye sığdırır.
 */
function desaturateToGamut(rgb) {
  const m = Math.min(rgb[0], rgb[1], rgb[2]);
  if (m >= 0) return rgb;
  const Y = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  if (Y <= 0) return [Math.max(0, rgb[0]), Math.max(0, rgb[1]), Math.max(0, rgb[2])];
  const t = -m / (Y - m);
  return rgb.map((c) => c + (Y - c) * t);
}
FL.desaturateToGamut = desaturateToGamut;

/**
 * Işınım tablosu (LUT). Satır 0: kurum (κ_λ = Ke/λ, birim fv başına),
 * Satır 1: gri cisim (ε = 1). Değerler fotometrik ölçekte (683 lm/W)
 * doğrusal sRGB "cd/m² eşdeğeri" yayınım katsayıları.
 *   Satır 0 birimi: [cd/m² eşd. / m] fv=1 için  → shader'da fv·ds ile çarpılır
 *   Satır 1 birimi: [cd/m² eşd.]                  → yüzey ışıması
 */
function buildRadiationLUT(n, Tmin, Tmax) {
  const data = new Float32Array(n * 2 * 4);
  const dl = 5; // nm
  for (let i = 0; i < n; i++) {
    const T = Tmin + ((Tmax - Tmin) * i) / (n - 1);
    let Xs = 0, Ys = 0, Zs = 0, Xg = 0, Yg = 0, Zg = 0;
    for (let l = 380; l <= 780; l += dl) {
      const lm = l * 1e-9;
      const B = planck(lm, T) * dl * 1e-9; // W/(m² sr) bant
      const cmf = cieXYZ(l);
      const ks = C.SOOT_KE / lm;            // 1/m (fv=1)
      Xs += cmf[0] * ks * B; Ys += cmf[1] * ks * B; Zs += cmf[2] * ks * B;
      Xg += cmf[0] * B; Yg += cmf[1] * B; Zg += cmf[2] * B;
    }
    const s = xyzToLinearSRGB(Xs * 683, Ys * 683, Zs * 683);
    const gb = xyzToLinearSRGB(Xg * 683, Yg * 683, Zg * 683);
    const sS = desaturateToGamut(s);
    const gS = desaturateToGamut(gb);
    data.set([sS[0], sS[1], sS[2], Ys * 683], i * 4);
    data.set([gS[0], gS[1], gS[2], Yg * 683], (n + i) * 4);
  }
  return { data, n, Tmin, Tmax };
}
FL.buildRadiationLUT = buildRadiationLUT;

/** Tek bir spektral çizginin doğrusal sRGB rengi (birim Y=1'e normalize edilmemiş) */
function lineColor(lambdaNm) {
  const c = cieXYZ(lambdaNm);
  const rgb = xyzToLinearSRGB(c[0] * 683, c[1] * 683, c[2] * 683);
  return desaturateToGamut(rgb);
}
FL.lineColor = lineColor;

/** Bant (geniş spektrum, gauss) emisyon rengi */
function bandColor(center, width) {
  let X = 0, Y = 0, Z = 0, wsum = 0;
  for (let l = 360; l <= 780; l += 2) {
    const w = Math.exp(-0.5 * Math.pow((l - center) / width, 2));
    const c = cieXYZ(l);
    X += c[0] * w; Y += c[1] * w; Z += c[2] * w; wsum += w;
  }
  const rgb = xyzToLinearSRGB((X / wsum) * 683, (Y / wsum) * 683, (Z / wsum) * 683);
  return desaturateToGamut(rgb);
}
FL.bandColor = bandColor;

/** Kemilüminesans tayf renkleri (CH* 431 nm, C2* Swan 516 nm, CO2* süreklisi, HCHO* soğuk alev) */
FL.CHEMI = {
  CH: lineColor(431.4),
  C2: (function () {
    // Swan bantları: 516.5 (Δv=0), 473.7 (Δv=+1), 563.5 (Δv=-1)
    const a = lineColor(516.5), b = lineColor(473.7), c = lineColor(563.5);
    return [0.6 * a[0] + 0.25 * b[0] + 0.15 * c[0], 0.6 * a[1] + 0.25 * b[1] + 0.15 * c[1], 0.6 * a[2] + 0.25 * b[2] + 0.15 * c[2]];
  })(),
  CO2: bandColor(405, 55),
  // Soğuk alev: uyarılmış formaldehit CH₂O* (Ã¹A₂ → X̃¹A₁) Emeléus bantları.
  // Tayf birkaç bantlıdır; mor ve mavi bantlar baskındır (≈ 395–435 nm).
  // Oluşum: CH₃O• + •OH → CH₂O* + H₂O ;  CH₃O• + CHₙO• → CH₂O* + CHₙOH
  HCHO: (function () {
    const bands = [[368.5, 0.25], [384.5, 0.45], [395.2, 0.8], [412.4, 0.9], [423.2, 1.0], [433.9, 0.75], [452.4, 0.5], [469.6, 0.35], [490.0, 0.15]];
    let X = 0, Y = 0, Z = 0, ws = 0;
    for (const [c0, a] of bands) {
      for (let l = c0 - 6; l <= c0 + 6; l += 1) {
        const w = a * Math.exp(-0.5 * Math.pow((l - c0) / 2.0, 2));
        const c = cieXYZ(l);
        X += c[0] * w; Y += c[1] * w; Z += c[2] * w; ws += w;
      }
    }
    return desaturateToGamut(xyzToLinearSRGB((X / ws) * 683, (Y / ws) * 683, (Z / ws) * 683));
  })(),
  H2O: bandColor(700, 60), // H2 alevlerinde çok zayıf görünür kırmızı/turuncu
};

/** Kurumun RGB soğurma katsayıları (fv=1 için, 1/m): κ_λ = Ke/λ */
FL.SOOT_ABS_RGB = [C.SOOT_KE / 610e-9, C.SOOT_KE / 550e-9, C.SOOT_KE / 465e-9];

/* ------------------------------------------------------------------ */
/* Fiziksel kamera: sensörler ve beyaz dengesi                          */
/* ------------------------------------------------------------------ */
/** Sensör boyutları [mm] ve taban ISO'da piksel doyma kapasitesi [e⁻] (≈ 20 MP) */
FL.SENSORS = {
  ff: { name: 'Tam kare (36 × 24)', w: 36, h: 24, fwc: 50000 },
  apsc: { name: 'APS-C (23,5 × 15,6)', w: 23.5, h: 15.6, fwc: 30000 },
  m43: { name: 'Mikro 4/3 (17,3 × 13)', w: 17.3, h: 13, fwc: 20000 },
  one: { name: '1 inç (13,2 × 8,8)', w: 13.2, h: 8.8, fwc: 15000 },
  mv: { name: 'Makine görüşü 2/3" (8,8 × 6,6)', w: 8.8, h: 6.6, fwc: 12000 },
  phone: { name: 'Telefon 1/1,3" (9,8 × 7,4)', w: 9.8, h: 7.4, fwc: 6000 },
};

/** Kara cismin doğrusal sRGB rengi (Y = 1) */
function blackbodyLinear(T) {
  let X = 0, Y = 0, Z = 0;
  for (let l = 380; l <= 780; l += 5) {
    const B = planck(l * 1e-9, T);
    const c = cieXYZ(l);
    X += c[0] * B; Y += c[1] * B; Z += c[2] * B;
  }
  const rgb = xyzToLinearSRGB(X / Y, 1, Z / Y);
  return rgb.map((v) => Math.max(v, 1e-4));
}

/**
 * Beyaz dengesi kazançları (doğrusal sRGB, von Kries). Seçilen renk sıcaklığındaki
 * ışık nötr (gri) görünür: 5500 K gün ışığı ayarında mum alevi turuncu, 1900 K
 * ayarında beyaza yakın çıkar. 6504 K ≈ sRGB beyazında kazançlar ≈ 1.
 */
const _wbCache = new Map();
FL.wbGains = function (T) {
  const k = Math.round(T / 10) * 10;
  if (_wbCache.has(k)) return _wbCache.get(k);
  const ref = blackbodyLinear(6504), c = blackbodyLinear(k);
  const g = [ref[0] / c[0], ref[1] / c[1], ref[2] / c[2]];
  const n = g[1];
  const out = g.map((v) => v / n);
  _wbCache.set(k, out);
  return out;
};

/** Bir sıcaklığın kara cisim kromatikliği (arayüz göstergeleri için sRGB 0..1) */
FL.blackbodyCSS = function (T) {
  let X = 0, Y = 0, Z = 0;
  for (let l = 380; l <= 780; l += 10) {
    const B = planck(l * 1e-9, T);
    const c = cieXYZ(l);
    X += c[0] * B; Y += c[1] * B; Z += c[2] * B;
  }
  let rgb = xyzToLinearSRGB(X / Y, 1, Z / Y);
  rgb = desaturateToGamut(rgb);
  const m = Math.max(rgb[0], rgb[1], rgb[2]);
  return rgb.map((c) => {
    const v = Math.max(0, c / m);
    return v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  });
};

/* ------------------------------------------------------------------ */
/* GPU için fizik parametre paketi                                     */
/* ------------------------------------------------------------------ */
/**
 * Tüm ortam/yakıt seçimlerinden shader uniform'larına aktarılacak
 * sayısal paketi üretir. Burada yapılan dönüşümler:
 *   Ea [kcal/mol] → Ta [K]
 *   Seyreltici cp ve λ katsayıları
 *   Yakıt akımı kütle kesri (N2 ile seyreltme)
 */
// Adyabatik sıcaklık sayısal integrali her alt adımda yeniden hesaplanmasın
const tadCache = new Map();
function cachedTad(fuel, amb, Tamb, YF1) {
  const key = fuel.id + '|' + amb.xO2 + '|' + amb.dil.id + '|' + Tamb + '|' + YF1;
  let v = tadCache.get(key);
  if (!v) {
    v = adiabaticFlameTemperature(fuel, amb, Tamb, YF1, Tamb);
    if (tadCache.size > 256) tadCache.clear();
    tadCache.set(key, v);
  }
  return v;
}

function buildPhysicsPack(state) {
  const fuel = FUELS[state.fuel];
  const amb = ambientComposition(state.o2 / 100, state.diluent);
  const P = state.pressure * 1000;
  const Ta = (fuel.Ea * 1000) / C.R_CAL;
  const xFuelDil = clamp(state.fuelDilution / 100, 0, 0.95);
  // Seyreltilmiş yakıt akımı: mol kesri → kütle kesri (N2 ile)
  const YF1 = (1 - xFuelDil) * fuel.W / ((1 - xFuelDil) * fuel.W + xFuelDil * C.W_N2);
  const Tad = cachedTad(fuel, amb, state.Tamb, YF1);
  // Izgara verim katsayısı: ~0,1–0,5 mm kalınlıktaki tepkime bölgesi ızgarada çözülemez;
  // hücre ortalamalı sıcaklıkta Arrhenius hızı olduğundan küçük kalır. Ön üstel katsayı,
  // hücre boyu ve yakıta bağlı bir katsayı ile ölçeklenir (kalınlaştırılmış alev benzeri kalibrasyon).
  const dxmm = (state.dxMeters || 1e-3) * 1000;
  const kinEff = (fuel.kinBoost || 1) * clamp(dxmm / 0.5, 1, 6);
  return {
    fuel, amb, P, Ta, YF1,
    Tad: Tad.T, Zst: Tad.Zst,
    // shader paketleri
    kin: [fuel.A * state.kinScale * kinEff, Ta, fuel.a, fuel.b],
    kinEff,
    fuelProps: [fuel.W, fuel.dHc, fuel.s, fuel.Wp],
    dilProps: [amb.dil.W, amb.dil.cpA, amb.dil.cpB, amb.dil.radiating ? 1 : 0],
    dilCond: [amb.dil.l0, amb.dil.ln, 1 - amb.xO2, fuel.h2o ? 1 : 0],
    lewis: [fuel.Le, 1.1, state.lewis ? 1 : 0, 0],
  };
}
FL.buildPhysicsPack = buildPhysicsPack;
