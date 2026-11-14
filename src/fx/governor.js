/* =====================================================================
 * Alev Laboratuvarı — Kare hızı yöneticisi
 * ---------------------------------------------------------------------
 * ignition-fx'in kalite yöneticisinin bu projeye uyarlanmış hali. Kare
 * süresini izler; düşüş sürerse yükü en az görünen yerden geri verir,
 * toparlanınca yavaşça geri açar (iki seviye arasında salınmaz).
 *
 * Bu projede karenin pahalı kısmı görüntü değil, akış çözücüsünün kare
 * başına çalıştırdığı yüzlerce geçiştir. Bu yüzden ilk feda edilen şey
 * görüntü kalitesi değil, kare başına alt adım sayısıdır: benzetim ağır
 * çekime geçer, sonuç değişmez. Görüntü çözünürlüğü, ışın adımı, parçacık
 * yoğunluğu ve alev tamponunun çözünürlüğü ancak ondan sonra kısılır.
 * ===================================================================== */
import { FL } from '../core/fl.js';

/**
 * sub      : kare başına alt adım tavanının (Çözücü › En çok alt adım) kesri
 * scale    : görüntü çözünürlüğü çarpanı
 * boost    : ışın yürütme adımı çarpanı
 * density  : efekt parçacığı yoğunluğu (parçacıklar büyür, hacim aynı kalır)
 * particle : alev/duman tamponunun çözünürlük oranı
 */
const LEVELS = [
  { name: 'Tam', sub: 1, scale: 1, boost: 1, density: 1, particle: 0.5 },
  { name: 'Yüksek', sub: 0.67, scale: 1, boost: 1, density: 0.85, particle: 0.5 },
  { name: 'Dengeli', sub: 0.5, scale: 0.9, boost: 1.1, density: 0.7, particle: 0.5 },
  { name: 'Orta', sub: 0.34, scale: 0.8, boost: 1.25, density: 0.58, particle: 0.5 },
  { name: 'Hafif', sub: 0.34, scale: 0.65, boost: 1.45, density: 0.45, particle: 0.4 },
  { name: 'Düşük', sub: 0.17, scale: 0.55, boost: 1.65, density: 0.34, particle: 0.34 },
];

/**
 * Ekranın tazeleme hızı. requestAnimationFrame zaman damgaları dikey eşlemeye hizalıdır:
 * kareler arası süre tazeleme aralığının tam katıdır. Ağır karelerde (çözücü adımı) aralık
 * iki-üç kat olur; bu yüzden ortalama değil, yeterince sık görülen en kısa aralık alınır.
 * Sayaçlar zamanla söner: ara sıra üst üste gelen iki geri çağrı yanlış yüksek hız öğretmez.
 */
const RATES = [240, 165, 144, 120, 100, 90, 75, 72, 60, 50, 48, 30];
const HITS = new Map();
let refreshFps = 0;
let decayAt = 0;
FL.observeFrame = function (ms, now) {
  if (!(ms > 2.5 && ms < 60)) return refreshFps;
  for (const r of RATES) {
    const iv = 1000 / r;
    if (Math.abs(ms - iv) < 0.09 * iv) { HITS.set(r, (HITS.get(r) || 0) + 1); break; }
  }
  if (now - decayAt > 8000) {
    decayAt = now;
    for (const [r, n] of HITS) HITS.set(r, n * 0.5);
  }
  let best = 0;
  for (const r of RATES) if ((HITS.get(r) || 0) >= 8 && r > best) best = r;
  if (best) refreshFps = best;
  return refreshFps;
};

class FrameGovernor {
  constructor(options = {}) {
    this.targetFps = options.targetFps ?? 60;  // güvence altına alınan en düşük kare hızı
    this.auto = true;
    this.levelIndex = 0;
    this.fps = 60;
    this.frameMs = 1000 / 60;
    this._smoothedMs = 1000 / 60;
    this._below = 0;
    this._above = 0;
    this._cooldown = 6;   // açılış ve ilk derlemeler ölçüme karışmasın
    this._refreshMs = 0;
    this._elapsed = 0;
    this._retryAt = 0;
    this._retryDelay = 15;
  }

  get level() { return LEVELS[this.levelIndex]; }
  get levels() { return LEVELS; }

  /** Ekranın tazeleme hızı (öğrenilene kadar 60) */
  get refreshFps() { return this._refreshMs > 0 ? 1000 / this._refreshMs : 60; }

  /**
   * Hedef: istenen kare hızı ile ekran tazeleme hızından küçük olanı. Çizim sınırlanmaz;
   * hedef, yöneticinin altına düşmesine izin vermediği değerdir.
   */
  get target() {
    const r = this.refreshFps;
    return this.targetFps > 0 ? Math.min(this.targetFps, r) : r;
  }

  setAuto(auto) {
    if (this.auto === !!auto) return;
    this.auto = !!auto;
    this._below = 0;
    this._above = 0;
    if (!this.auto) this.levelIndex = 0;
  }

  setLevel(index) {
    const clamped = Math.max(0, Math.min(LEVELS.length - 1, index));
    if (clamped === this.levelIndex) return;
    this.levelIndex = clamped;
    this._below = 0;
    this._above = 0;
    this._cooldown = 1.2;
  }

  /** Uzun bir duraklamadan (sekme gizli, yükleme) sonra ölçümü baştan al */
  resume(seconds = 1) {
    this._below = 0;
    this._above = 0;
    this._cooldown = Math.max(this._cooldown, seconds);
  }

  /** @param dt önceki kareden beri geçen gerçek süre [s] */
  update(dt) {
    const ms = Math.min(250, dt * 1000);
    this._elapsed += dt;
    this._smoothedMs += (ms - this._smoothedMs) * 0.08;
    this.frameMs = this._smoothedMs;
    this.fps = 1000 / this._smoothedMs;

    const r = FL.observeFrame(ms, this._elapsed * 1000);
    if (r > 0) this._refreshMs = 1000 / r;
    if (!this.auto) return;
    if (this._cooldown > 0) { this._cooldown -= dt; return; }

    const target = this.target;
    const low = target * 0.82;
    const high = target * 0.95;
    if (this.fps < low) {
      // Daha derin düşüşe daha çabuk yanıt
      this._below += dt * (this.fps < target * 0.6 ? 2.5 : 1);
      this._above = 0;
      if (this._below > 0.8 && this.levelIndex < LEVELS.length - 1) {
        // Az önce bırakılan seviye ağırdı: yeniden denemeden önce her seferinde daha uzun bekle
        this._retryAt = this._elapsed + this._retryDelay;
        this._retryDelay = Math.min(120, this._retryDelay * 2);
        this.setLevel(this.levelIndex + 1);
      }
    } else if (this.fps > high) {
      // Hedefin çok üstündeyse (geçici bir takılma yüzünden kısılmışsa) beklemeden geri aç
      const ample = this.fps > target * 1.3;
      this._above += dt * (ample ? 4 : 1);
      this._below = 0;
      if (this._above > 5 && (ample || this._elapsed >= this._retryAt) && this.levelIndex > 0) this.setLevel(this.levelIndex - 1);
    } else {
      this._below = Math.max(0, this._below - dt);
      this._above = 0;
    }
  }
}

FL.FrameGovernor = FrameGovernor;
FL.GOVERNOR_LEVELS = LEVELS;
