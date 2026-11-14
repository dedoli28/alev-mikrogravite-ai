/* =====================================================================
 * Alev Laboratuvarı — Işık tarzları
 * ---------------------------------------------------------------------
 * Bir tarz, sahnedeki dört ışığı birlikte kurar:
 *   ortam   yarım küre ışığı: gökyüzü (üst) ve zemin (alt) rengi [cd/m²]
 *   lamba   konumlu, boyutlu ana ışık (yumuşak gölge), döşemede [lx] ve renk
 *   güneş   paralel ışık (gölgeli) [lx], renk ve yön; yörünge arka planında
 *           gökyüzünde güneş diski olarak da görünür
 *   dolgu   gölgesiz ikinci paralel ışık (karşı ışık / Dünya ışığı) [lx]
 * Alevin kendi ışığı her tarzda ayrıca eklenir (fiziksel, ışık şiddetinden).
 *
 * "Klasik" tarz eski davranıştır: beyaz ortam, Görüntü › Sahne'deki tavan
 * lambası ve güneş kaydırıcıları. Diğer tarzlar kendi değerlerini kullanır;
 * hepsi "Işık şiddeti" çarpanıyla ölçeklenir.
 * ===================================================================== */
import { FL } from '../core/fl.js';

const norm = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
/** Yön: azimut (0° = +x, 90° = +z) ve yükseklik açısından */
const dirFrom = (az, el) => {
  const a = (az * Math.PI) / 180, e = (el * Math.PI) / 180;
  return [Math.cos(e) * Math.cos(a), Math.sin(e), Math.cos(e) * Math.sin(a)];
};
/** Dünya'nın merkezine doğru (arka plan gölgelendiricisindeki EARTH_C): Dünya ışığının geldiği yön */
const EARTH_DIR = norm([-25, -132, -55]);

FL.LIGHT_STYLES = [
  { id: 'auto', name: 'Otomatik', desc: 'Mekikte yörünge güneşi, masa üstü nesnelerde stüdyo, yalnız alev deneyinde klasik loş oda' },
  {
    id: 'sun', name: 'Yörünge güneşi', desc: 'Sert, sıcak beyaz güneş ve gölgeleri; alttan mavi Dünya ışığı; kabin lambası kısık',
    amb: 7, sky: [0.75, 0.86, 1.0], gnd: [0.35, 0.5, 0.85],
    key: 320, keyCol: [1.0, 0.93, 0.82],
    sun: 1500, sunCol: [1.0, 0.96, 0.88], sunState: true, disc: 1,
    fill: 190, fillCol: [0.42, 0.62, 1.0], fillDir: EARTH_DIR,
  },
  {
    id: 'golden', name: 'Gün doğumu', desc: 'Ufka yakın turuncu güneş, uzun gölgeler, mor-mavi gölge tonları',
    amb: 3.5, sky: [0.55, 0.5, 0.95], gnd: [0.45, 0.3, 0.55],
    key: 60, keyCol: [1.0, 0.82, 0.62],
    sun: 1100, sunCol: [1.0, 0.56, 0.24], sunState: true, sunEl: 9, disc: 1,
    fill: 70, fillCol: [0.45, 0.4, 1.0], fillDir: EARTH_DIR,
  },
  {
    id: 'studio', name: 'Stüdyo', desc: 'Üç nokta: sıcak ana ışık, soğuk dolgu, arkadan kenar ışığı. Nesneler en okunur haliyle',
    amb: 7, sky: [0.8, 0.88, 1.0], gnd: [0.55, 0.47, 0.4],
    key: 520, keyCol: [1.0, 0.93, 0.82],
    sun: 380, sunCol: [0.78, 0.88, 1.0], sunDir: norm([-0.55, 0.5, -0.67]),
    fill: 150, fillCol: [0.7, 0.82, 1.0], fillDir: norm([-0.75, 0.3, 0.6]),
  },
  {
    id: 'cabin', name: 'Kabin LED', desc: 'Soğuk beyaz kabin aydınlatması, güneş yok: uçuş sırasındaki çalışma ışığı',
    amb: 9, sky: [0.88, 0.94, 1.0], gnd: [0.6, 0.64, 0.7],
    key: 480, keyCol: [0.86, 0.94, 1.0],
    sun: 0, fill: 60, fillCol: [0.8, 0.9, 1.0], fillDir: norm([0.4, 0.2, 0.9]),
  },
  {
    id: 'emergency', name: 'Acil durum', desc: 'Kısık kırmızı acil aydınlatma: alev ve duman öne çıkar',
    amb: 0.9, sky: [1.0, 0.2, 0.14], gnd: [0.5, 0.06, 0.05],
    key: 110, keyCol: [1.0, 0.1, 0.06],
    sun: 0, fill: 14, fillCol: [1.0, 0.25, 0.15], fillDir: norm([0.5, 0.3, 0.8]),
  },
  {
    id: 'night', name: 'Gece yüzü', desc: 'Güneş Dünya’nın arkasında: yalnız soluk mavi ışık ve alevin kendi ışığı',
    amb: 0.8, sky: [0.3, 0.45, 1.0], gnd: [0.12, 0.18, 0.5],
    key: 0, sun: 0, fill: 22, fillCol: [0.35, 0.5, 1.0], fillDir: norm([-0.4, 0.75, 0.5]),
  },
  {
    id: 'dark', name: 'Yalnız alev', desc: 'Bütün ışıklar kapalı: sahneyi yalnız alev aydınlatır',
    amb: 0.12, sky: [1, 1, 1], gnd: [0.3, 0.3, 0.3], key: 0, sun: 0, fill: 0,
  },
  { id: 'classic', name: 'Klasik (elle)', desc: 'Beyaz oda ışığı; tavan lambası, ortam ve güneş kaydırıcılarla ayarlanır' },
];

/** Arayüz için: bu durumda hangi tarz geçerli (yalnız durumdan; kabin = 'cabin' modeli) */
const styleOfState = (s) => FL.lightStyleFor(s, { model: !!FL.modelById && !!FL.modelById(s.model), large: s.model === 'cabin' });
FL.lightClassic = (s) => styleOfState(s).id === 'classic';
FL.lightHasSun = (s) => { const y = styleOfState(s); return y.id === 'classic' ? s.backdrop !== 'lab' : !!y.sunState; };
FL.lightStyleOfState = styleOfState;

const OFF3 = [0, 0, 0];
const UP = [0, 1, 0];

/** Otomatik tarzın bu sahnede karşılığı */
FL.lightStyleFor = function (st, ctx) {
  let id = st.lightStyle || 'auto';
  if (id === 'auto') id = !ctx.model ? 'classic' : ctx.large ? 'sun' : 'studio';
  return FL.LIGHT_STYLES.find((s) => s.id === id && s.id !== 'auto') || FL.LIGHT_STYLES[FL.LIGHT_STYLES.length - 1];
};

/**
 * Bu kare için ışık düzeni.
 * ctx: { model: sahnede nesne var mı, large: kabin mi, orbit: yörünge arka planı mı }
 * Döner: { id, amb, sky[3], gnd[3] (cd/m²), keyLx, keyCol, sunE, sunCol, sunDir, sunDisc, fill[4], fillCol }
 */
FL.lightRig = function (st, ctx) {
  const s = FL.lightStyleFor(st, ctx);
  const sunState = norm(dirFrom(st.sunAz ?? 125, st.sunEl ?? 32));
  if (s.id === 'classic') {
    const A = st.ambientLight;
    return {
      id: 'classic', amb: A, sky: [A, A, A], gnd: [0.2 * A, 0.2 * A, 0.2 * A],
      keyLx: Math.max(0, st.roomLight || 0), keyCol: [1.0, 0.96, 0.9],
      sunE: ctx.orbit ? Math.max(st.sunLight || 0, 0) : 0, sunCol: [1.0, 0.96, 0.9], sunDir: sunState, sunDisc: ctx.orbit ? 1 : 0,
      fill: [UP[0], UP[1], UP[2], 0], fillCol: OFF3,
    };
  }
  const g = FL.clamp(st.lightGain ?? 1, 0, 4);
  const A = s.amb * g;
  const sunDir = s.sunDir || sunState;
  const fd = s.fillDir || UP;
  return {
    id: s.id, amb: A,
    sky: s.sky.map((c) => c * A), gnd: s.gnd.map((c) => c * A * 0.45),
    keyLx: (s.key || 0) * g, keyCol: s.keyCol || [1, 1, 1],
    sunE: (s.sun || 0) * g, sunCol: s.sunCol || [1, 1, 1], sunDir,
    // Güneş diski yalnız yörünge arka planında ve güneşi olan tarzlarda görünür
    sunDisc: ctx.orbit && s.disc && s.sun > 0 ? 1 : 0,
    fill: [fd[0], fd[1], fd[2], (s.fill || 0) * g], fillCol: s.fillCol || OFF3,
  };
};
