/* =====================================================================
 * Alev Laboratuvarı — Ölçüm şeridi, zaman serisi grafiği, renk ölçeği,
 * 3B kaplama (alan çerçevesi, ölçek çubuğu, yerçekimi oku)
 * ===================================================================== */
import { FL } from '../core/fl.js';

const fmt = (x, d) => FL.fmt(x, d);

/* ------------------------------------------------------------------ */
/* Seriler                                                             */
/* ------------------------------------------------------------------ */
FL.SERIES = [
  { id: 'hrr', label: 'HRR', name: 'Isı salınım hızı', unit: 'W', get: (h) => h.hrr, digits: 3, color: '#ff9a3c' },
  { id: 'Tmax', label: 'T', name: 'En yüksek sıcaklık', unit: 'K', get: (h) => h.Tmax, digits: 4, color: '#ff6a3d' },
  { id: 'H', label: 'Boy', name: 'Alev boyu', unit: 'mm', get: (h) => h.H, digits: 3, color: '#ffd60a', when: (st) => st.source !== 'droplet' },
  { id: 'r', label: 'r', name: 'Alev yarıçapı', unit: 'mm', get: (h) => h.r, digits: 3, color: '#ffd60a', when: (st) => st.source === 'droplet' },
  { id: 'chi', label: 'χ', name: 'Işınım kesri', unit: '', get: (h) => h.chi, digits: 3, color: '#bf5af2' },
  { id: 'qw', label: 'q_r', name: 'Duvar ışınım akısı (maks)', unit: 'kW/m²', get: (h) => h.qw, digits: 3, color: '#ff6a3d', when: (st) => st.radiation && st.radModel !== 'thin' },
  { id: 'lum', label: 'Işık', name: 'Işık şiddeti (görünür)', unit: 'cd', get: (h) => h.lum, digits: 3, color: '#ffe08a' },
  { id: 'soot', label: 'Kurum', name: 'Kurum kütlesi', unit: 'µg', get: (h) => h.soot, digits: 3, color: '#a1a1aa' },
  { id: 'd2', label: 'd²', name: 'Damla çapının karesi', unit: 'mm²', get: (h) => h.d2, digits: 3, color: '#5b8cff', when: (st) => st.source === 'droplet' },
  { id: 'cool', label: 'Soğuk', name: 'Soğuk alev HRR', unit: 'W', get: (h) => h.cool, digits: 3, color: '#64d2ff', when: (st) => st.coolFlame && FL.FUELS[st.fuel] && FL.FUELS[st.fuel].coolFlame },
  {
    id: 'hotcool', label: 'Alev', name: 'Sıcak ve soğuk alev', unit: 'W', digits: 3, color: '#ff9a3c',
    when: (st) => st.coolFlame && FL.FUELS[st.fuel] && FL.FUELS[st.fuel].coolFlame,
    layers: [
      { name: 'Sıcak', color: '#ff9a3c', get: (h) => h.hrr, axis: 'l' },
      { name: 'Soğuk', color: '#64d2ff', get: (h) => h.cool, axis: 'r' },
    ],
  },
];

/* ------------------------------------------------------------------ */
/* Zaman serisi grafiği                                                  */
/* ------------------------------------------------------------------ */
class Chart {
  constructor(root) {
    this.root = root;
    this.canvas = root.querySelector('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.segHost = root.querySelector('.chart-seg');
    this.valEl = root.querySelector('.chart-val');
    this.nameEl = root.querySelector('.chart-name');
    this.footL = root.querySelector('.chart-foot-l');
    this.footR = root.querySelector('.chart-foot-r');
    this.series = 'hrr';
    this.onSelect = null;
    this._sig = '';
    this.hover = null;
    this.canvas.addEventListener('pointermove', (e) => {
      const r = this.canvas.getBoundingClientRect();
      this.hover = e.clientX - r.left;
      this.dirty = true;
    });
    this.canvas.addEventListener('pointerleave', () => { this.hover = null; this.dirty = true; });
  }

  buildButtons(st) {
    const list = FL.SERIES.filter((s) => !s.when || s.when(st));
    if (!list.find((s) => s.id === this.series)) {
      this.series = list[0].id;
      if (this.onSelect) this.onSelect(this.series);
    }
    const sig = list.map((s) => s.id).join('|');
    if (sig !== this._sig) {
      this._sig = sig;
      this.segHost.innerHTML = '';
      this.seg = FL.makeSeg(list.map((s) => ({ value: s.id, label: s.label })), (id) => {
        this.series = id;
        if (this.onSelect) this.onSelect(id);
        this.seg.set(id);
        this.dirty = true;
      }, { small: true, label: 'Grafik serisi' });
      this.segHost.appendChild(this.seg.el);
    }
    // Seri başka bir yoldan (senaryo, kaynak) değişmiş olabilir: her zaman işaretle
    this.seg.set(this.series);
  }

  draw(sim, st) {
    const cv = this.canvas;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(10, cv.clientWidth), h = Math.max(10, cv.clientHeight);
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
    }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const ser = FL.SERIES.find((s) => s.id === this.series) || FL.SERIES[0];
    this.nameEl.textContent = ser.name;
    if (ser.layers) { this.drawLayers(sim, st, ser, w, h); return; }
    const hist = sim.history;
    const pad = { l: 44, r: 10, t: 8, b: 8 };
    const pw = w - pad.l - pad.r, ph = h - pad.t - pad.b;
    const pts = [];
    for (const e of hist) {
      const v = ser.get(e);
      if (isFinite(v)) pts.push([e.t, v]);
    }
    ctx.font = '500 10px "JetBrains Mono", ui-monospace, monospace';
    ctx.textBaseline = 'middle';
    if (pts.length < 2) {
      ctx.fillStyle = 'rgba(235,235,245,0.38)';
      ctx.textAlign = 'center';
      ctx.font = '12px "Barlow", system-ui, sans-serif';
      ctx.fillText('Veri bekleniyor — alevi başlatmak için Ateşle', w / 2, h / 2);
      this.valEl.textContent = '—';
      this.footL.textContent = '';
      this.footR.textContent = '';
      return;
    }
    const t0 = pts[0][0], t1 = pts[pts.length - 1][0];
    let vmin = Infinity, vmax = -Infinity;
    for (const p of pts) { vmin = Math.min(vmin, p[1]); vmax = Math.max(vmax, p[1]); }
    if (ser.id === 'Tmax') vmin = Math.min(vmin, st.Tamb);
    else vmin = Math.min(0, vmin);
    if (vmax - vmin < 1e-9) vmax = vmin + 1;
    vmax += (vmax - vmin) * 0.1;
    const X = (t) => pad.l + ((t - t0) / Math.max(t1 - t0, 1e-6)) * pw;
    const Y = (v) => pad.t + ph - ((v - vmin) / (vmax - vmin)) * ph;

    // Yatay kılavuz çizgileri
    ctx.lineWidth = 1;
    ctx.textAlign = 'right';
    for (let i = 0; i <= 3; i++) {
      const v = vmin + ((vmax - vmin) * i) / 3;
      const y = Math.round(Y(v)) + 0.5;
      ctx.strokeStyle = i === 0 ? 'rgba(255,255,255,0.14)' : 'rgba(255,255,255,0.06)';
      ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke();
      ctx.fillStyle = 'rgba(235,235,245,0.4)';
      ctx.fillText(fmt(v, 2), pad.l - 6, y);
    }
    // Olay işaretleri
    ctx.textAlign = 'left';
    ctx.font = '10px "Barlow", system-ui, sans-serif';
    let lastX = -1e9, lane = 0;
    for (const ev of sim.events) {
      if (ev.t < t0 || ev.t > t1) continue;
      const x = Math.round(X(ev.t)) + 0.5;
      lane = x - lastX < 70 ? (lane + 1) % 3 : 0;
      lastX = x;
      ctx.strokeStyle = 'rgba(235,235,245,0.22)';
      ctx.setLineDash([2, 3]);
      ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, pad.t + ph); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(235,235,245,0.5)';
      ctx.fillText(ev.label, x + 4, pad.t + 6 + lane * 12);
    }
    // Alan dolgusu + çizgi
    const col = ser.color;
    const grad = ctx.createLinearGradient(0, pad.t, 0, pad.t + ph);
    grad.addColorStop(0, col + '40');
    grad.addColorStop(1, col + '00');
    ctx.beginPath();
    ctx.moveTo(X(pts[0][0]), Y(vmin));
    for (const p of pts) ctx.lineTo(X(p[0]), Y(p[1]));
    ctx.lineTo(X(pts[pts.length - 1][0]), Y(vmin));
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(X(p[0]), Y(p[1])) : ctx.moveTo(X(p[0]), Y(p[1]))));
    ctx.strokeStyle = col;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.stroke();
    const last = pts[pts.length - 1];
    ctx.beginPath();
    ctx.arc(X(last[0]), Y(last[1]), 2.5, 0, Math.PI * 2);
    ctx.fillStyle = col;
    ctx.fill();

    // d² doğrusal uydurma
    let foot = '';
    if (ser.id === 'd2' && sim.droplet) {
      const fit = this.d2Fit(sim);
      if (fit) {
        ctx.strokeStyle = 'rgba(235,235,245,0.55)';
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(X(fit.tA), Y(fit.a + fit.b * fit.tA));
        ctx.lineTo(X(fit.tB), Y(fit.a + fit.b * fit.tB));
        ctx.stroke();
        ctx.setLineDash([]);
        foot = 'K = ' + fmt(-fit.b, 3) + ' mm²/s · R² ' + fmt(fit.r2, 3);
      }
    }

    // Fareyle okuma: en yakın örnek
    let shown = last;
    if (this.hover !== null && this.hover >= pad.l && this.hover <= w - pad.r) {
      const tH = t0 + ((this.hover - pad.l) / pw) * (t1 - t0);
      let best = pts[0];
      for (const p of pts) if (Math.abs(p[0] - tH) < Math.abs(best[0] - tH)) best = p;
      shown = best;
      const x = Math.round(X(best[0])) + 0.5;
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, pad.t + ph); ctx.stroke();
      ctx.beginPath(); ctx.arc(x, Y(best[1]), 3.5, 0, Math.PI * 2);
      ctx.fillStyle = '#fff'; ctx.fill();
      ctx.strokeStyle = col; ctx.lineWidth = 1.5; ctx.stroke();
      foot = 't = ' + fmt(best[0], 4) + ' s';
    }
    this.valEl.textContent = fmt(shown[1], ser.digits) + (ser.unit ? ' ' + ser.unit : '');
    this.footL.textContent = fmt(t0, 3) + ' – ' + fmt(t1, 3) + ' s';
    this.footR.textContent = foot;
  }

  /** İki eksen: sıcak alev solda, soğuk alev sağda. Ölçekler ayrıdır; ikisi de görünür. */
  drawLayers(sim, st, ser, w, h) {
    const ctx = this.ctx;
    const hist = sim.history;
    const pad = { l: 44, r: 46, t: 8, b: 8 };
    const pw = w - pad.l - pad.r, ph = h - pad.t - pad.b;
    const packs = ser.layers.map((layer) => {
      const pts = [];
      for (const e of hist) {
        const v = layer.get(e);
        if (isFinite(v)) pts.push([e.t, v]);
      }
      return { layer, pts };
    });
    ctx.font = '500 10px "JetBrains Mono", ui-monospace, monospace';
    ctx.textBaseline = 'middle';
    if (!packs[0] || packs[0].pts.length < 2) {
      ctx.fillStyle = 'rgba(235,235,245,0.38)';
      ctx.textAlign = 'center';
      ctx.font = '12px "Barlow", system-ui, sans-serif';
      ctx.fillText('Veri bekleniyor — alevi başlatmak için Ateşle', w / 2, h / 2);
      this.valEl.textContent = '—';
      this.footL.textContent = '';
      this.footR.textContent = '';
      return;
    }
    const span = (pts) => {
      let mn = 0, mx = 0;
      for (const p of pts) { mn = Math.min(mn, p[1]); mx = Math.max(mx, p[1]); }
      if (mx - mn < 1e-9) mx = mn + 1;
      mx += (mx - mn) * 0.1;
      return { min: mn, max: mx };
    };
    const left = span(packs.filter((p) => p.layer.axis !== 'r').flatMap((p) => p.pts));
    const right = span(packs.filter((p) => p.layer.axis === 'r').flatMap((p) => p.pts));
    const t0 = packs[0].pts[0][0], t1 = packs[0].pts[packs[0].pts.length - 1][0];
    const X = (t) => pad.l + ((t - t0) / Math.max(t1 - t0, 1e-6)) * pw;
    const Y = (v, s) => pad.t + ph - ((v - s.min) / (s.max - s.min)) * ph;
    ctx.lineWidth = 1;
    ctx.textAlign = 'right';
    for (let i = 0; i <= 3; i++) {
      const v = left.min + ((left.max - left.min) * i) / 3;
      const y = Math.round(Y(v, left)) + 0.5;
      ctx.strokeStyle = i === 0 ? 'rgba(255,255,255,0.14)' : 'rgba(255,255,255,0.06)';
      ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke();
      ctx.fillStyle = 'rgba(255,154,60,0.8)';
      ctx.fillText(fmt(v, 2), pad.l - 6, y);
      const vr = right.min + ((right.max - right.min) * i) / 3;
      ctx.textAlign = 'left';
      ctx.fillStyle = 'rgba(100,210,255,0.85)';
      ctx.fillText(fmt(vr, 2), w - pad.r + 6, y);
      ctx.textAlign = 'right';
    }
    for (const pack of packs) {
      const s = pack.layer.axis === 'r' ? right : left;
      const col = pack.layer.color;
      ctx.beginPath();
      pack.pts.forEach((p, i) => (i ? ctx.lineTo(X(p[0]), Y(p[1], s)) : ctx.moveTo(X(p[0]), Y(p[1], s))));
      ctx.strokeStyle = col;
      ctx.lineWidth = 1.5;
      ctx.lineJoin = 'round';
      ctx.stroke();
    }
    let hi = packs[0].pts.length - 1;
    let foot = 'sol sıcak · sağ soğuk';
    if (this.hover !== null && this.hover >= pad.l && this.hover <= w - pad.r) {
      const tH = t0 + ((this.hover - pad.l) / pw) * (t1 - t0);
      let best = 0, bd = Infinity;
      packs[0].pts.forEach((p, i) => { const d = Math.abs(p[0] - tH); if (d < bd) { bd = d; best = i; } });
      hi = best;
      const x = Math.round(X(packs[0].pts[hi][0])) + 0.5;
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, pad.t + ph); ctx.stroke();
      for (const pack of packs) {
        const s = pack.layer.axis === 'r' ? right : left;
        const p = pack.pts[Math.min(hi, pack.pts.length - 1)];
        ctx.beginPath(); ctx.arc(x, Y(p[1], s), 3, 0, Math.PI * 2);
        ctx.fillStyle = pack.layer.color; ctx.fill();
      }
      foot = 't = ' + fmt(packs[0].pts[hi][0], 4) + ' s';
    }
    const hot = packs[0].pts[Math.min(hi, packs[0].pts.length - 1)];
    const cool = packs[1] ? packs[1].pts[Math.min(hi, packs[1].pts.length - 1)] : null;
    this.valEl.textContent = fmt(hot[1], 3) + ' W' + (cool ? ' · soğuk ' + fmt(cool[1], 3) + ' W' : '');
    this.footL.textContent = fmt(t0, 3) + ' – ' + fmt(t1, 3) + ' s';
    this.footR.textContent = foot;
  }

  d2Fit(sim) {
    // Yalnız sıcak alevin sürdüğü ve d²'nin azaldığı son bölüm
    const xs = [], ys = [];
    const h = sim.history;
    for (let i = Math.max(0, h.length - 400); i < h.length; i++) {
      const e = h[i];
      if (isFinite(e.d2) && e.hrr > 0.05 && e.d2 > 0) { xs.push(e.t); ys.push(e.d2); }
    }
    const f = FL.linfit(xs, ys);
    if (!f || f.b >= 0) return null;
    f.tA = xs[0]; f.tB = xs[xs.length - 1];
    return f;
  }
}
FL.Chart = Chart;

/* ------------------------------------------------------------------ */
/* Ölçüm şeridi                                                          */
/* ------------------------------------------------------------------ */
class Readouts {
  constructor(el) {
    this.el = el;
    this.cells = {};
    this._sig = '';
  }

  defs(st) {
    const list = [
      { id: 'T', k: 'T maks', u: 'K', sw: true, tip: 'Hesaplama alanındaki en yüksek gaz sıcaklığı' },
      { id: 'hrr', k: 'Isı salınımı', u: 'W', tip: 'Toplam ısı salınım hızı (HRR)' },
    ];
    if (st.coolFlame && FL.FUELS[st.fuel] && FL.FUELS[st.fuel].coolFlame) {
      list.push({ id: 'cool', k: 'Soğuk alev', u: 'W', tip: 'Düşük sıcaklık kimyasının ısı salınımı. Sıcak alev söndükten sonra bu eğri ayakta kalabilir.' });
    }
    list.push(
      { id: 'chi', k: 'χ ışınım', u: '', tip: 'Işınımla kaybedilen ısı kesri q_rad / HRR' },
    );
    if (st.source === 'droplet') {
      list.push({ id: 'd', k: 'Damla çapı', u: 'mm' }, { id: 'K', k: 'K', u: 'mm²/s', tip: 'd²-yasası yanma hız sabiti' }, { id: 'rr', k: 'r_alev/r_s', u: '', tip: 'Alev yarıçapının damla yarıçapına oranı' });
    } else {
      list.push({ id: 'H', k: 'Alev boyu', u: 'mm', tip: 'Kaynaktan alev ucuna (HRR eşiği) yükseklik' });
    }
    if (st.source === 'sheet') list.push({ id: 'spread', k: 'Yayılma', u: 'mm/s', tip: 'Piroliz cephesinin ilerleme hızı' });
    if (st.radiation && st.radModel !== 'thin') list.push({ id: 'qw', k: 'Duvar ışınım akısı', u: 'kW/m²', tip: 'Hesaplama alanının sınırlarına (duvarlar, tavan, masa) gelen en büyük ışınım ısı akısı. Alevin çevresindeki kişi ve donanımın maruz kaldığı ışınım yükünün ölçüsü.' });
    list.push({ id: 'lum', k: 'Işık şiddeti', u: 'cd', tip: 'Alevin görünür ışık şiddeti: kurum kara cisim ışıması ve CH* ışıması, CIE parlaklık eğrisiyle ağırlıklı (1 cd ≈ bir mum)' });
    list.push({ id: 'soot', k: 'Kurum', u: 'µg' }, { id: 'u', k: 'u maks', u: 'cm/s' }, { id: 'Tad', k: 'T_ad kuram', u: 'K', tip: 'Adyabatik alev sıcaklığı (denge, kayıpsız)' });
    return list;
  }

  build(st) {
    const defs = this.defs(st);
    const sig = defs.map((d) => d.id).join('|');
    if (sig === this._sig) return;
    this._sig = sig;
    this.el.innerHTML = '';
    this.cells = {};
    for (const d of defs) {
      const c = document.createElement('div');
      c.className = 'ro';
      if (d.tip) c.dataset.tip = d.tip;
      c.innerHTML = '<span class="ro-k">' + d.k + '</span><span class="ro-v">' + (d.sw ? '<i class="ro-sw"></i>' : '') + '<span class="ro-n">—</span><span class="ro-u">' + d.u + '</span></span>';
      this.el.appendChild(c);
      this.cells[d.id] = { n: c.querySelector('.ro-n'), sw: c.querySelector('.ro-sw') };
    }
  }

  set(id, text) {
    const c = this.cells[id];
    if (c && c.n._last !== text) { c.n.textContent = text; c.n._last = text; }
  }

  update(sim, st) {
    this.build(st);
    const s = sim.stats;
    this.set('T', s.valid ? fmt(s.Tmax, 4) : '—');
    if (this.cells.T && this.cells.T.sw) {
      const sw = this.cells.T.sw;
      if (s.valid && s.Tmax > 900) {
        const c = FL.blackbodyCSS(FL.clamp(s.Tmax, 900, 3500));
        const css = 'rgb(' + c.map((v) => Math.round(v * 255)).join(',') + ')';
        sw.style.background = css;
        sw.style.boxShadow = '0 0 6px ' + css;
        sw.classList.add('on');
      } else sw.classList.remove('on');
    }
    this.set('hrr', s.valid ? fmt(s.hrr, 3) : '—');
    if (this.cells.cool) this.set('cool', s.valid ? fmt(s.cool, 3) : '—');
    this.set('chi', s.valid && s.hrr > 0.01 ? fmt(s.chiRad, 2) : '—');
    this.set('H', s.valid && s.flameH > 0 ? fmt(s.flameH * 1000, 3) : '—');
    this.set('soot', s.valid ? fmt(s.soot, 2) : '—');
    this.set('lum', s.valid && isFinite(s.lumY) ? fmt(s.lumY, 3) : '—');
    if (this.cells.qw) this.set('qw', s.valid && isFinite(s.qWallMax) ? fmt(Math.max(s.qWallMax, 0) / 1000, 3) : '—');
    this.set('u', s.valid ? fmt(s.umax * 100, 3) : '—');
    this.set('Tad', fmt(sim.phys.Tad, 4));
    if (sim.droplet) {
      const d = sim.droplet;
      this.set('d', d.alive ? fmt(d.d * 1000, 3) : 'bitti');
      this.set('K', fmt(d.K * 1e6, 3));
      const rr = d.alive && s.rMax > 0 ? s.rMax / (d.d / 2) : NaN;
      this.set('rr', isFinite(rr) ? fmt(rr, 3) : '—');
    }
    this.set('spread', isFinite(sim.spread) ? fmt(sim.spread, 3) : '—');
  }
}
FL.Readouts = Readouts;

/* ------------------------------------------------------------------ */
/* Renk ölçeği göstergesi                                                */
/* ------------------------------------------------------------------ */
const cssGrad = (stops) => 'linear-gradient(90deg,' + stops.join(',') + ')';
const SLICE_INFO = {
  T: { name: 'Sıcaklık', map: 'inferno', range: (st) => [fmt(st.Tamb, 3), fmt(st.falseTmax, 4) + ' K'] },
  hrr: { name: 'HRR (log)', map: 'inferno', range: (st) => ['0', fmt(st.falseHRR, 3) + ' MW/m³'] },
  soot: { name: 'Kurum f_v', map: 'turbo', range: (st) => ['0', fmt(st.falseSoot, 2) + ' ppm'] },
  vel: { name: 'Hız |u|', map: 'turbo', range: (st) => ['0', fmt(st.falseU, 3) + ' cm/s'] },
  fuel: { name: 'Yakıt Y_F', map: 'turbo', range: (st) => ['0', fmt(st.falseYf, 2)] },
  o2: { name: 'Oksijen Y_O₂', map: 'coolwarm', rev: true, range: () => ['0', 'ortam'] },
  div: { name: 'Genleşme S', map: 'coolwarm', range: () => ['−200', '+200 1/s'] },
  prod: { name: 'Ürünler Y_P', map: 'turbo', range: () => ['0', '1'] },
};

class Legend {
  constructor(el) {
    this.el = el;
    this._last = '';
  }

  update(st, renderer) {
    const m = FL.VIEW_MODES.find((v) => v.id === st.view) || FL.VIEW_MODES[0];
    let html = '<div class="lg-title"><span>' + m.name + '</span>';
    if (st.camPhys && st.camLook) {
      html = '<div class="lg-title"><span>Fiziksel kamera</span><span class="lg-meta">' + (st.camAE === 'A' ? 'A' : 'M') + ' · ISO ' + Math.round(st.camISO) + ' · ' + (st.camView === 'agx' ? 'AgX' : 'sRGB') + '</span></div>';
      html += '<div class="lg-sub">Görünür ışık, doyma, gürültü, alan derinliği ve obtüratör bulanıklığı gerçek bir kameradaki gibi. Ölçüm yardımcıları gizli.</div>';
      if (html !== this._last) { this.el.innerHTML = html; this._last = html; }
      return;
    }
    if (st.view === 'real') {
      const ev = st.autoExposure ? renderer.autoEV + st.exposure : st.exposure;
      html += '<span class="lg-meta">' + (st.autoExposure ? 'oto ' : '') + 'EV ' + (ev >= 0 ? '+' : '') + fmt(ev, 2) + ' · ' + ({ agx: 'AgX', aces: 'ACES', neutral: 'Nötr' }[st.tonemap] || '') + '</span>';
    }
    html += '</div>';
    const bar = (map, lo, hi, rev) => {
      const stops = FL.COLORMAP_STOPS[map].slice();
      if (rev) stops.reverse();
      return '<div class="lg-bar" style="background:' + cssGrad(stops) + '"></div><div class="lg-range"><span>' + lo + '</span><span>' + hi + '</span></div>';
    };
    if (st.view === 'temp') html += bar('inferno', fmt(st.Tamb, 3) + ' K', fmt(st.falseTmax, 4) + ' K');
    else if (st.view === 'ir') html += bar('inferno', fmt(st.Tamb, 3) + ' K', '≈' + fmt(st.falseTmax, 4) + ' K');
    else if (st.view === 'hrr') html += bar('inferno', '0', fmt(st.falseHRR, 3) + ' MW/m³');
    else if (st.view === 'soot') html += bar('turbo', '0', fmt(st.falseSoot, 2) + ' ppm');
    else if (st.view === 'vel') html += bar('turbo', '0', fmt(st.falseU, 3) + ' cm/s');
    else if (st.view === 'species') html += '<div class="lg-chips"><span><i style="background:#26f273"></i>Yakıt</span><span><i style="background:#4073ff"></i>O₂ tükenmesi</span></div>';
    else if (st.view === 'ai') {
      html += '<div class="lg-bar" style="background:linear-gradient(90deg,#2f9e6c,#96be46,#ecc440,#f08038,#e2363e)"></div><div class="lg-range"><span>düşük risk</span><span>yüksek risk</span></div>';
      html += '<div class="lg-chips lg-wrap"><span><i style="background:#3a4350"></i>Yanmaz</span><span><i style="background:#ff4de0"></i>Öngörülen cephe</span><span><i style="background:#0dc0ff"></i>Gerçekleşen alev</span></div>';
      html += '<div class="lg-sub">' + (FL.AI && FL.AI.ready ? 'cockpit_fire_model: tutuşma ve sürme olasılığı' : 'Model yükleniyor…') + '</div>';
    } else if (st.view === 'rad') {
      html += bar('inferno', '0', fmt(st.falseRad, 3) + ' kW/m² (log)');
      html += '<div class="lg-sub">' + (st.radiation && st.radModel !== 'thin'
        ? 'Duvarlar ve masa: gelen ışınım ısı akısı · hacimde G − 4σT∞⁴'
        : 'Işınım alanı kapalı (Çözücü › Fizik › Işınım modeli)') + '</div>';
    } else if (st.view === 'schlieren') {
      html += st.schMode === 'color'
        ? '<div class="lg-bar" style="background:' + cssGrad(FL.COLORMAP_STOPS.turbo) + '"></div><div class="lg-range"><span>gradyan yönü</span><span>0–360°</span></div>'
        : '<div class="lg-bar" style="background:linear-gradient(90deg,#111,#6b6b6b,#eee)"></div><div class="lg-range"><span>−∂n/∂x</span><span>+∂n/∂x</span></div>';
    }
    if (st.slice) {
      const si = SLICE_INFO[st.sliceField] || SLICE_INFO.T;
      const r = si.range(st);
      html += '<div class="lg-sub">Kesit · ' + si.name + ' · ' + st.sliceAxis + ' = %' + fmt(st.slicePos * 100, 3) + '</div>' + bar(si.map, r[0], r[1], si.rev);
    }
    if (html !== this._last) {
      this.el.innerHTML = html;
      this._last = html;
    }
  }
}
FL.Legend = Legend;

/* ------------------------------------------------------------------ */
/* 2B kaplama: alan çerçevesi, ölçek çubuğu, yerçekimi oku, etiketler    */
/* ------------------------------------------------------------------ */
class Overlay {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.showBox = true;
  }

  draw(renderer, sim, st, w, h, dpr, safe) {
    const cv = this.canvas;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
    }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const gr = sim.grid;
    const B = [gr.Lx, gr.Ly, gr.Lz];
    const P = (p) => renderer.project(p, w, h);
    const mono = '500 10.5px "JetBrains Mono", ui-monospace, monospace';

    // Fiziksel kamera: vizör çerçevesi ve ayar satırı; yardımcı çizimler isteğe bağlı
    if (st.camPhys && renderer.camFrame) {
      const F = renderer.camFrame, k = w / F.viewW;
      const fx = F.x * k, fy = F.y * k, fw = F.w * k, fh = F.h * k;
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.lineWidth = 1;
      ctx.strokeRect(fx + 0.5, fy + 0.5, fw - 1, fh - 1);
      const ci = renderer.camInfo;
      if (ci) {
        const sh = ci.shutter_s >= 0.3 ? FL.fmt(ci.shutter_s, 2) + ' s' : '1/' + Math.round(1 / ci.shutter_s) + ' s';
        const txt = Math.round(ci.focal_mm) + ' mm  ·  f/' + FL.fmt(ci.fstop, 2) + '  ·  ' + sh + (st.camAE === 'A' ? ' (A)' : '') + '  ·  ISO ' + Math.round(ci.iso)
          + '  ·  ' + Math.round(ci.wb_K) + ' K  ·  odak ' + FL.fmt(ci.focus_m * 100, 3) + ' cm' + (ci.focus_auto ? ' (oto)' : '');
        ctx.font = mono;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'bottom';
        const tw = ctx.measureText(txt).width + 14;
        const ty = Math.min(fy + fh - 8, h - 70);
        ctx.fillStyle = 'rgba(8,11,16,0.62)';
        ctx.fillRect(fx + 8, ty - 17, tw, 19);
        ctx.fillStyle = 'rgba(235,240,250,0.92)';
        ctx.fillText(txt, fx + 15, ty);
      }
      if (!st.camHelpers) return;
    }

    // Deney düzeneği yokken (yalnız sahne nesneleri) boş deney kutusu, ölçüleri ve ölçek çubuğu çizilmez
    const rig = st.source !== 'none';
    // Hesaplama alanı kenarları (arkadakiler daha soluk)
    if (this.showBox && rig) {
      const corners = [];
      for (let i = 0; i < 8; i++) corners.push([(i & 1) * B[0], ((i >> 1) & 1) * B[1], ((i >> 2) & 1) * B[2]]);
      const edges = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(255,255,255,0.07)';
      ctx.beginPath();
      for (const [a, b] of edges) {
        const pa = P(corners[a]), pb = P(corners[b]);
        if (pa && pb) { ctx.moveTo(pa[0], pa[1]); ctx.lineTo(pb[0], pb[1]); }
      }
      ctx.stroke();
      // Köşe işaretleri
      ctx.strokeStyle = 'rgba(255,255,255,0.28)';
      ctx.beginPath();
      for (const [a, b] of edges) {
        const pa = P(corners[a]), pb = P(corners[b]);
        if (!pa || !pb) continue;
        const dx = pb[0] - pa[0], dy = pb[1] - pa[1];
        const L = Math.hypot(dx, dy);
        if (L < 1) continue;
        const k = Math.min(10, L * 0.2) / L;
        ctx.moveTo(pa[0], pa[1]); ctx.lineTo(pa[0] + dx * k, pa[1] + dy * k);
        ctx.moveTo(pb[0], pb[1]); ctx.lineTo(pb[0] - dx * k, pb[1] - dy * k);
      }
      ctx.stroke();
    }

    // Kutu kenar ölçüleri: her eksende kameraya en yakın kenarın ortasına (cm)
    if (this.showBox && rig) {
      const cm = (v) => FL.fmtCm(v * 100) + ' cm';
      const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
      const pick = (edges, score) => {
        let best = null, bs = -Infinity;
        for (const [a, b] of edges) {
          const pa = P(a), pb = P(b), pm = P(mid(a, b));
          if (!pa || !pb || !pm) continue;
          const sc = score(pm);
          if (sc > bs) { bs = sc; best = { pa, pb, pm }; }
        }
        return best;
      };
      const [X, Y, Z] = B;
      const xs = pick([[[0, 0, 0], [X, 0, 0]], [[0, 0, Z], [X, 0, Z]]], (p) => p[1]);
      const zs = pick([[[0, 0, 0], [0, 0, Z]], [[X, 0, 0], [X, 0, Z]]], (p) => -p[0]);  // soldaki: grafik paneline girmesin
      const ys = pick([[[0, 0, 0], [0, Y, 0]], [[X, 0, 0], [X, Y, 0]], [[0, 0, Z], [0, Y, Z]], [[X, 0, Z], [X, Y, Z]]], (p) => p[0]);
      ctx.font = mono;
      ctx.textBaseline = 'middle';
      const tag = (e, text, side) => {
        if (!e) return;
        const dx = e.pb[0] - e.pa[0], dy = e.pb[1] - e.pa[1];
        const L = Math.hypot(dx, dy);
        if (L < 40) return;
        let nx = -dy / L, ny = dx / L;
        if (side === 'down' && ny < 0) { nx = -nx; ny = -ny; }
        if (side === 'right' && nx < 0) { nx = -nx; ny = -ny; }
        const x = e.pm[0] + nx * 14, y = e.pm[1] + ny * 12;
        const w = ctx.measureText(text).width + 10;
        ctx.fillStyle = 'rgba(10,14,20,0.72)';
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(x - w / 2, y - 8, w, 16, 4); else ctx.rect(x - w / 2, y - 8, w, 16);
        ctx.fill();
        ctx.fillStyle = 'rgba(200,215,240,0.85)';
        ctx.textAlign = 'center';
        ctx.fillText(text, x, y + 0.5);
      };
      tag(xs, 'X ' + cm(X), 'down');
      tag(zs, 'Z ' + cm(Z), 'down');
      tag(ys, 'Y ' + cm(Y), 'right');

      // Alev tavana ya da yan duvara dayandıysa kutunun o yüzü turuncu yanar
      const s = sim.stats;
      if (s.valid && sim.flameOn) {
        // Zorlanmış akışta sıcak gazın tepeden çıkması doğaldır; uyarı yalnız durgun ortamda
        const topHit = s.flameH > 0 && s.yTip > Y - 2.5 * gr.dx && (st.flow || 0) < 1;
        if (topHit) {
          ctx.strokeStyle = 'rgba(255,154,60,0.85)';
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          const tc = [[0, Y, 0], [X, Y, 0], [X, Y, Z], [0, Y, Z]].map(P);
          if (tc.every(Boolean)) { ctx.moveTo(tc[0][0], tc[0][1]); for (let i = 1; i < 4; i++) ctx.lineTo(tc[i][0], tc[i][1]); ctx.closePath(); ctx.stroke(); }
          const pt = P([X / 2, Y, Z / 2]);
          if (pt) {
            ctx.fillStyle = 'rgba(255,170,100,0.95)';
            ctx.textAlign = 'center';
            ctx.font = '600 12px "Barlow Semi Condensed", "Barlow", sans-serif';
            ctx.fillText('Alev alanın tepesine ulaştı · Y\'yi büyütün', pt[0], pt[1] - 16);
            ctx.font = mono;
          }
        }
      }
    }

    // Dikey 1 cm ölçek çubuğu: kaynak yüksekliğinden başlar, alev boyuyla kıyaslanır
    const ya = FL.clamp(sim.geo.anchor[1], 0.002, B[1] - 0.012);
    const p0 = P([0, ya, B[2]]), p1 = P([0, ya + 0.01, B[2]]);
    if (rig && p0 && p1) {
      ctx.strokeStyle = 'rgba(255,255,255,0.6)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(p0[0], p0[1]); ctx.lineTo(p1[0], p1[1]);
      ctx.moveTo(p0[0] - 3.5, p0[1]); ctx.lineTo(p0[0] + 3.5, p0[1]);
      ctx.moveTo(p1[0] - 3.5, p1[1]); ctx.lineTo(p1[0] + 3.5, p1[1]);
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      ctx.font = mono;
      ctx.textBaseline = 'middle';
      const xl = Math.min(p0[0], p1[0]) - 8;
      // Dar ekranda etiket sola taşmasın: çubuğun sağına yaz
      if (xl < 34) { ctx.textAlign = 'left'; ctx.fillText('1 cm', Math.max(p0[0], p1[0]) + 8, (p0[1] + p1[1]) / 2); }
      else { ctx.textAlign = 'right'; ctx.fillText('1 cm', xl, (p0[1] + p1[1]) / 2); }
    }

    // Rüzgâr oku: alan tabanında, rüzgârın estiği yönde
    if ((st.wind || 0) > 0.2) {
      const a = ((st.windDir || 0) * Math.PI) / 180;
      const L = 0.38 * Math.min(B[0], B[2]);
      const cx = B[0] / 2, cz = B[2] / 2;
      const dx = Math.cos(a), dz = Math.sin(a);
      const pa = P([cx - dx * L * 0.5, 0, cz - dz * L * 0.5]);
      const pb = P([cx + dx * L * 0.5, 0, cz + dz * L * 0.5]);
      if (pa && pb) {
        const ang = Math.atan2(pb[1] - pa[1], pb[0] - pa[0]);
        ctx.strokeStyle = 'rgba(100,210,255,0.85)';
        ctx.fillStyle = 'rgba(100,210,255,0.85)';
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(pa[0], pa[1]); ctx.lineTo(pb[0], pb[1]); ctx.stroke();
        ctx.save();
        ctx.translate(pb[0], pb[1]); ctx.rotate(ang);
        ctx.beginPath(); ctx.moveTo(6, 0); ctx.lineTo(-4, -5); ctx.lineTo(-4, 5); ctx.closePath(); ctx.fill();
        ctx.restore();
        ctx.font = mono;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillText('rüzgâr ' + FL.fmt(st.wind, 3) + ' cm/s', (pa[0] + pb[0]) / 2, Math.max(pa[1], pb[1]) + 8);
      }
    }

    // Yerçekimi göstergesi
    const g = st.gravity;
    const gx = (safe && safe.gx) || w - 40, gy = (safe && safe.gy) || 96;
    ctx.save();
    ctx.translate(gx, gy);
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(0, 0, 20, 0, Math.PI * 2); ctx.stroke();
    const on = g > 0.01;
    ctx.strokeStyle = on ? 'rgba(255,255,255,0.85)' : 'rgba(235,235,245,0.45)';
    ctx.fillStyle = ctx.strokeStyle;
    const lenA = g > 0 ? 4 + 11 * FL.clamp((Math.log10(g) + 6) / 6.3, 0, 1) : 0;
    if (lenA > 0) {
      const c = P([B[0] / 2, B[1] / 2, B[2] / 2]);
      const c2 = P([B[0] / 2, B[1] / 2 - 0.01, B[2] / 2]);
      let ang = Math.PI / 2;
      if (c && c2) ang = Math.atan2(c2[1] - c[1], c2[0] - c[0]);
      ctx.rotate(ang);
      ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.moveTo(-lenA * 0.4, 0); ctx.lineTo(lenA, 0); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(lenA + 5, 0); ctx.lineTo(lenA - 1, -3.5); ctx.lineTo(lenA - 1, 3.5); ctx.closePath(); ctx.fill();
      ctx.rotate(-ang);
    } else {
      ctx.beginPath(); ctx.arc(0, 0, 2.5, 0, Math.PI * 2); ctx.fill();
    }
    ctx.font = mono;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = 'rgba(235,235,245,0.7)';
    ctx.fillText(FL.gravityText(g) + ' g₀', 0, 26);
    ctx.restore();

    // Sahne kamerası nesnesi (editör görünümünde): görüş piramidi + tutamaçlar
    if (st.camPhys && !st.camLook) this.drawSceneCamera(ctx, renderer, sim, st, w, h, P);
    else this.handles = null;

    // Damla etiketi
    if (st.source === 'droplet' && sim.droplet && sim.droplet.alive) {
      const a = sim.geo.anchor;
      const r = sim.droplet.d / 2;
      const pa = P([a[0] + r, a[1], a[2]]);
      if (pa) {
        ctx.strokeStyle = 'rgba(255,255,255,0.45)';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(pa[0] + 2, pa[1]); ctx.lineTo(pa[0] + 36, pa[1] - 24); ctx.lineTo(pa[0] + 104, pa[1] - 24); ctx.stroke();
        ctx.fillStyle = 'rgba(255,255,255,0.9)';
        ctx.font = mono;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        ctx.fillText('d = ' + fmt(sim.droplet.d * 1000, 3) + ' mm', pa[0] + 38, pa[1] - 29);
      }
    }
  }
}

/* Sahne kamerası çizimi ve tutamaç seçimi (Overlay'e eklenir) */
Overlay.prototype.drawSceneCamera = function (ctx, renderer, sim, st, w, h, P) {
  const gr = sim.grid;
  const Lm = Math.max(gr.Lx, gr.Ly, gr.Lz);
  const B = FL.sceneCamBasis(st);
  const C = B.pos;
  const sensor = FL.SENSORS[st.camSensor] || FL.SENSORS.ff;
  const tanH = sensor.w / (2 * st.camFocal), tanV = sensor.h / (2 * st.camFocal);
  const add = (a, b, k) => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
  const pc = P(C);
  this.handles = [];
  if (!pc) return;
  const sel = !!this.active || !!this.hover;
  // Kamera nesnesi: arkada kutu gövde + vizör, önde yarı saydam görüntü düzlemi ve
  // kesikli görüş kenarları; "yukarı" yönü üst kenardaki kısa çentikle gösterilir
  const d0 = 0.28 * Lm;
  const ctr = add(C, B.f, d0);
  const hw = d0 * tanH, hh = d0 * tanV;
  const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => add(add(ctr, B.rt, sx * hw), B.up, sy * hh)).map(P);
  const ink = sel ? '255,170,90' : '255,214,160';
  if (corners.every(Boolean)) {
    // Görüntü düzlemi: yumuşak dolgu + köşe parantezleri
    ctx.fillStyle = 'rgba(' + ink + ',0.07)';
    ctx.beginPath();
    corners.forEach((q, i) => (i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1])));
    ctx.closePath(); ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(' + ink + ',0.95)';
    ctx.beginPath();
    for (let i = 0; i < 4; i++) {
      const q = corners[i], a = corners[(i + 1) % 4], b = corners[(i + 3) % 4];
      ctx.moveTo(q[0] + (a[0] - q[0]) * 0.22, q[1] + (a[1] - q[1]) * 0.22);
      ctx.lineTo(q[0], q[1]);
      ctx.lineTo(q[0] + (b[0] - q[0]) * 0.22, q[1] + (b[1] - q[1]) * 0.22);
    }
    ctx.stroke();
    // Görüş kenarları kesikli
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = 'rgba(' + ink + ',0.5)';
    ctx.beginPath();
    for (const q of corners) { ctx.moveTo(pc[0], pc[1]); ctx.lineTo(q[0], q[1]); }
    ctx.stroke();
    ctx.setLineDash([]);
    // Yukarı çentiği
    const n0 = P(add(ctr, B.up, hh)), n1 = P(add(ctr, B.up, hh * 1.3));
    if (n0 && n1) {
      ctx.lineWidth = 3; ctx.lineCap = 'round';
      ctx.strokeStyle = 'rgba(' + ink + ',0.95)';
      ctx.beginPath(); ctx.moveTo(n0[0], n0[1]); ctx.lineTo(n1[0], n1[1]); ctx.stroke();
      ctx.lineCap = 'butt';
    }
  }
  // Gövde: merceğin arkasında küçük kutu (8 köşe), üstünde vizör tümseği
  {
    const bw = 0.07 * Lm, bh = 0.05 * Lm, bd = 0.08 * Lm;
    const v = [];
    for (const z of [0, -bd]) for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) v.push(P(add(add(add(C, B.f, z - 0.01 * Lm), B.rt, sx * bw / 2), B.up, sy * bh / 2)));
    if (v.every(Boolean)) {
      const faces = [[0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4], [2, 3, 7, 6], [1, 2, 6, 5], [0, 3, 7, 4]];
      ctx.fillStyle = 'rgba(28,30,38,0.55)';
      ctx.strokeStyle = 'rgba(' + ink + ',0.9)';
      ctx.lineWidth = 1.2;
      for (const f of faces) {
        ctx.beginPath();
        f.forEach((i, j) => (j ? ctx.lineTo(v[i][0], v[i][1]) : ctx.moveTo(v[i][0], v[i][1])));
        ctx.closePath(); ctx.fill(); ctx.stroke();
      }
    }
    // Mercek halkası
    const rl = Math.max(0.018 * Lm, 1e-6), lp0 = P(add(C, B.rt, rl));
    if (lp0) {
      ctx.strokeStyle = 'rgba(' + ink + ',0.95)';
      ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.arc(pc[0], pc[1], Math.max(Math.hypot(lp0[0] - pc[0], lp0[1] - pc[1]), 5), 0, Math.PI * 2); ctx.stroke();
    }
  }
  // Odak noktasına kesikli çizgi
  const lp = renderer.light.cd > 0 ? renderer.light.pos : null;
  if (lp) {
    const pl = P(lp);
    if (pl) {
      ctx.setLineDash([3, 4]);
      ctx.strokeStyle = 'rgba(255,190,120,0.45)';
      ctx.beginPath(); ctx.moveTo(pc[0], pc[1]); ctx.lineTo(pl[0], pl[1]); ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  const hov = this.hover, act = this.active;
  const isOn = (hd) => (act && act.type === hd.type && act.axis === hd.axis) || (hov && hov.type === hd.type && hov.axis === hd.axis);
  const arrow = (a, b, col, on) => {
    ctx.strokeStyle = 'rgba(' + col + ',' + (on ? 1 : 0.85) + ')';
    ctx.fillStyle = ctx.strokeStyle;
    ctx.lineWidth = on ? 3.2 : 2.2;
    ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
    const dx = b[0] - a[0], dy = b[1] - a[1], Lp = Math.hypot(dx, dy);
    if (Lp > 6) {
      const ux = dx / Lp, uy = dy / Lp;
      ctx.beginPath();
      ctx.moveTo(b[0] + ux * 9, b[1] + uy * 9);
      ctx.lineTo(b[0] - uy * 5, b[1] + ux * 5);
      ctx.lineTo(b[0] + uy * 5, b[1] - ux * 5);
      ctx.closePath(); ctx.fill();
    }
  };
  if (st.camGizmo === 'rotate') {
    // Döndür: yatay halka (sapma), dikey halka (yunuslama), bakış çevresinde halka (yuvarlanma)
    const R = 0.13 * Lm;
    const rings = [
      { type: 'yaw', col: '61,220,132', u: [1, 0, 0], v: [0, 0, 1] },
      { type: 'pitch', col: '255,90,78', u: B.f, v: [0, 1, 0] },
      { type: 'roll', col: '91,140,255', u: B.rt, v: B.up, r: 0.75 },
    ];
    for (const rg of rings) {
      const rr = R * (rg.r || 1);
      const pts = [];
      for (let i = 0; i <= 48; i++) {
        const a = (i / 48) * Math.PI * 2;
        const q = P([C[0] + rr * (Math.cos(a) * rg.u[0] + Math.sin(a) * rg.v[0]), C[1] + rr * (Math.cos(a) * rg.u[1] + Math.sin(a) * rg.v[1]), C[2] + rr * (Math.cos(a) * rg.u[2] + Math.sin(a) * rg.v[2])]);
        if (q) pts.push(q);
      }
      const hd = { type: rg.type, pts };
      ctx.strokeStyle = 'rgba(' + rg.col + ',' + (isOn(hd) ? 1 : 0.8) + ')';
      ctx.lineWidth = isOn(hd) ? 3 : 2;
      ctx.beginPath();
      pts.forEach((q, i) => (i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1])));
      ctx.stroke();
      this.handles.push(hd);
    }
  } else if (st.camGizmo === 'zoom') {
    // Ölçekle: köşe küpleri görüş açısını (odak uzaklığını) büyütür/küçültür,
    // sarı ok kamerayı bakış yönünde ileri/geri götürür (dolly)
    const pctr = P(ctr);
    if (pctr && corners.every(Boolean)) {
      corners.forEach((q, i) => {
        const dx = q[0] - pctr[0], dy = q[1] - pctr[1], R = Math.hypot(dx, dy);
        const hd = { type: 'fov', axis: i, p: q, dir: R > 1e-3 ? [dx / R, dy / R] : [1, 0], R: Math.max(R, 4) };
        const on = isOn(hd);
        const s = on ? 6 : 4.5;
        ctx.fillStyle = on ? 'rgba(255,170,90,1)' : 'rgba(255,210,120,0.9)';
        ctx.strokeStyle = 'rgba(20,20,26,0.9)';
        ctx.lineWidth = 1;
        ctx.fillRect(q[0] - s, q[1] - s, 2 * s, 2 * s);
        ctx.strokeRect(q[0] - s, q[1] - s, 2 * s, 2 * s);
        this.handles.push(hd);
      });
    }
    const len = 0.2 * Lm;
    const pa = P(add(C, B.f, d0 * 1.05)), pb = P(add(C, B.f, d0 * 1.05 + len));
    if (pa && pb) {
      const dx = pb[0] - pa[0], dy = pb[1] - pa[1], Lp = Math.hypot(dx, dy);
      const hd = { type: 'dolly', a: pa, b: pb, dir: Lp > 1e-3 ? [dx / Lp, dy / Lp] : [1, 0], ppm: Lp / len };
      arrow(pa, pb, '255,206,84', isOn(hd));
      this.handles.push(hd);
    }
  } else {
    // Taşı: dünya eksenleri boyunca oklar (X kırmızı, Y yeşil, Z mavi)
    const len = 0.17 * Lm;
    const cols = ['255,90,78', '61,220,132', '91,140,255'];
    for (let ax = 0; ax < 3; ax++) {
      const e = [0, 0, 0]; e[ax] = 1;
      const pe = P(add(C, e, len));
      if (!pe) continue;
      const dx = pe[0] - pc[0], dy = pe[1] - pc[1];
      const Lp = Math.hypot(dx, dy);
      const hd = { type: 'axis', axis: ax, a: pc, b: pe, dir: Lp > 1e-3 ? [dx / Lp, dy / Lp] : [1, 0], ppm: Lp / len };
      arrow(pc, pe, cols[ax], isOn(hd));
      this.handles.push(hd);
    }
  }
  // Merkez: serbest taşıma (ekran düzleminde sürükle, Blender'daki G gibi)
  const fh = { type: 'free', p: pc };
  const fOn = isOn(fh);
  ctx.fillStyle = fOn ? 'rgba(255,170,90,1)' : 'rgba(240,244,252,0.95)';
  ctx.strokeStyle = 'rgba(20,20,26,0.8)';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.arc(pc[0], pc[1], fOn ? 6 : 4.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  this.handles.push(fh);
  // Etiket: kamera nesnesinin altında, tutamaçlarla çakışmadan
  let ly = pc[1];
  for (const q of corners) if (q) ly = Math.max(ly, q[1]);
  ctx.font = '600 11.5px "Barlow Semi Condensed", "Barlow", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const lx = corners.every(Boolean) ? (pc[0] + corners.reduce((s2, q) => s2 + q[0], 0) / 4) / 2 : pc[0];
  const lab = 'Kamera · ' + Math.round(st.camFocal) + ' mm · ' + Math.round((2 * Math.atan(tanH) * 180) / Math.PI) + '° görüş';
  ctx.fillStyle = 'rgba(10,12,18,0.6)';
  const tw = ctx.measureText(lab).width;
  ctx.fillRect(lx - tw / 2 - 5, ly + 12, tw + 10, 17);
  ctx.fillStyle = sel ? 'rgba(255,190,120,1)' : 'rgba(240,244,252,0.95)';
  ctx.fillText(lab, lx, ly + 14);
};

/** Ekran noktasındaki tutamaç (yoksa null) */
Overlay.prototype.pickGizmo = function (x, y) {
  if (!this.handles) return null;
  let best = null, bd = 10;
  const segD = (a, b) => {
    const vx = b[0] - a[0], vy = b[1] - a[1];
    const t = FL.clamp(((x - a[0]) * vx + (y - a[1]) * vy) / Math.max(vx * vx + vy * vy, 1e-6), 0, 1);
    return Math.hypot(x - a[0] - vx * t, y - a[1] - vy * t);
  };
  for (const hd of this.handles) {
    let d = 1e9;
    if (hd.type === 'axis' || hd.type === 'dolly') d = segD(hd.a, hd.b) - 2;
    else if (hd.type === 'fov') d = Math.hypot(x - hd.p[0], y - hd.p[1]) - 4;
    else if (hd.type === 'free') d = Math.hypot(x - hd.p[0], y - hd.p[1]) - 5;
    else for (let i = 1; i < hd.pts.length; i++) d = Math.min(d, segD(hd.pts[i - 1], hd.pts[i]));
    if (d < bd) { bd = d; best = hd; }
  }
  return best;
};

FL.Overlay = Overlay;
