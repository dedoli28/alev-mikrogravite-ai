/* =====================================================================
 * Alev Laboratuvarı — Yanıcılık görüntüleme modülü
 * ---------------------------------------------------------------------
 * Sahnedeki modelin parçalarını iki ölçütle renklendirir ve listeler:
 *   Model sınıfı   : modelin kendi yanıcılık seviyesi (0 Yanmaz … 3 Yüksek)
 *   Bu atmosferde  : ortamın O₂ yüzdesi ile malzemenin LOI aralığı
 * Lejant satırına tıklamak o sınıftaki tüm parçaları, listedeki bir grubu
 * seçmek o grubu sahnede vurgular. Seçimin ayrıntı kartı malzemeyi, LOI'yi,
 * bu atmosferdeki durumu ve notları gösterir.
 * ===================================================================== */
import { FL } from '../core/fl.js';

const fmt = (x, d) => FL.fmt(x, d);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const VERDICT_ORDER = ['ox', 'burn', 'edge', 'out', 'none'];

class FlamPanel {
  constructor(root, opts) {
    this.root = root;
    this.o = opts || {};
    this.sel = null;          // { kind: 'level' | 'group', key }
    this._key = '';
    root.addEventListener('click', (e) => this._click(e));
  }

  /** Grup özeti: aynı ad + malzeme + sınıf birlikte sayılır */
  _groups(scene, st) {
    const map = new Map();
    for (const p of scene.parts) {
      const verdict = FL.flamVerdict(p.info, st.o2);
      const cat = st.flamMode === 'atm' ? verdict : String(p.level);
      const key = cat + '|' + p.group + '|' + p.info.text;
      let g = map.get(key);
      if (!g) {
        g = { key, cat, label: p.label, ids: [], level: p.level, verdict, info: p.info, extras: p.extras, name: p.name };
        map.set(key, g);
      }
      g.ids.push(p.id);
    }
    const rank = (g) => (st.flamMode === 'atm' ? 10 - VERDICT_ORDER.indexOf(g.verdict) : g.level);
    return [...map.values()].sort((a, b) => rank(b) - rank(a) || b.ids.length - a.ids.length || a.label.localeCompare(b.label, 'tr'));
  }

  _cats(st) {
    if (st.flamMode === 'atm') return VERDICT_ORDER.map((k) => Object.assign({ key: k }, FL.FLAM_VERDICTS[k]));
    return FL.FLAM_LEVELS.slice().reverse().map((l) => Object.assign({ key: String(l.id) }, l));
  }

  update(scene, st) {
    if (!scene || !scene.ready) {
      const k = 'empty|' + (scene && scene.def ? scene.def.id : '');
      if (k === this._key) return;
      this._key = k;
      this.root.innerHTML = this._head(scene && scene.def ? scene.def.name : 'Model yok') +
        '<p class="flam-empty">' + (scene && scene.def ? 'Model yükleniyor…' : 'Soldaki <b>Model</b> düğmesinden bir model seçin.') + '</p>';
      FL.hydrateIcons(this.root);
      return;
    }
    const o2r = Math.round(st.o2 * 10) / 10;
    const key = scene.def.id + '|' + st.flamMode + '|' + o2r + '|' + Math.round(st.pressure * 10) + '|' + (this.sel ? this.sel.kind + this.sel.key : '');
    if (key === this._key) return;
    this._key = key;
    const groups = this._groups(scene, st);
    this.groups = groups;
    const cats = this._cats(st);
    const counts = {};
    for (const g of groups) counts[g.cat] = (counts[g.cat] || 0) + g.ids.length;
    const pO2 = (st.o2 / 100) * st.pressure;
    let html = this._head(scene.def.name);
    html += '<div class="seg flam-seg" role="radiogroup" aria-label="Renk ölçütü">' +
      '<button type="button" role="radio" data-mode="class" aria-checked="' + (st.flamMode !== 'atm') + '">Model sınıfı</button>' +
      '<button type="button" role="radio" data-mode="atm" aria-checked="' + (st.flamMode === 'atm') + '">Bu atmosferde</button></div>';
    html += '<div class="flam-atm"><span>O₂ %' + fmt(st.o2, 3) + '</span><span>' + fmt(st.pressure, 4) + ' kPa</span><span>pO₂ ' + fmt(pO2, 3) + ' kPa</span></div>';
    html += '<div class="flam-legend">';
    for (const c of cats) {
      const n = counts[c.key] || 0;
      if (!n && st.flamMode === 'atm' && c.key === 'edge') continue;
      const on = this.sel && this.sel.kind === 'cat' && this.sel.key === c.key;
      html += '<button type="button" class="flam-lv' + (on ? ' on' : '') + '" data-cat="' + c.key + '"' + (n ? '' : ' disabled') + '>' +
        '<i style="background:' + c.color + '"></i><span class="flam-lv-n">' + c.name + '</span><span class="flam-lv-d">' + c.desc + '</span>' +
        '<span class="flam-lv-c">' + n + '</span></button>';
    }
    html += '</div>';
    html += '<div class="flam-list" role="listbox" aria-label="Parçalar">';
    const color = (g) => (st.flamMode === 'atm' ? FL.FLAM_VERDICTS[g.verdict].color : FL.FLAM_LEVELS[g.level].color);
    for (const g of groups) {
      const on = this.sel && this.sel.kind === 'group' && this.sel.key === g.key;
      const loi = g.info.loi ? '%' + g.info.loi[0] + (g.info.loi[1] !== g.info.loi[0] ? '–' + g.info.loi[1] : '') : g.info.oxidizer ? 'O₂' : '—';
      html += '<button type="button" role="option" class="flam-row' + (on ? ' on' : '') + '" aria-selected="' + on + '" data-group="' + esc(g.key) + '">' +
        '<i style="background:' + color(g) + '"></i><span class="flam-row-n">' + esc(g.label) + (g.ids.length > 1 ? ' <em>×' + g.ids.length + '</em>' : '') + '</span>' +
        '<span class="flam-row-m">' + esc(g.info.label || '—') + '</span><span class="flam-row-l" data-tip="Sınırlayıcı oksijen indisi (yaklaşık)">' + loi + '</span></button>';
    }
    html += '</div>';
    html += this._detail(scene, st);
    html += '<p class="flam-note">' + esc(scene.root.extras.not_ || 'Seviyeler malzeme türüne göre eğitim amaçlı sınıflandırmadır.') +
      ' LOI değerleri yaklaşıktır (1 g, oda sıcaklığı); mikrogravitede yavaş hava akışı ince malzemeleri daha düşük O₂’de de yakabilir. NASA-STD-6001B Test 1’in yerine geçmez.</p>';
    this.root.innerHTML = html;
    FL.hydrateIcons(this.root);
    const onRow = this.root.querySelector('.flam-row.on');
    if (onRow) onRow.scrollIntoView({ block: 'nearest' });
  }

  _head(sub) {
    return '<header class="flam-head"><div><div class="flam-title">Yanıcılık</div><div class="flam-sub">' + esc(sub) + '</div></div>' +
      '<button type="button" class="ct-btn ct-sm" data-act="close" data-icon="close" aria-label="Yanıcılık modülünü kapat" data-tip="Kapat (Y)"></button></header>';
  }

  _detail(scene, st) {
    if (!this.sel || this.sel.kind !== 'group') {
      return '<p class="flam-hint">Sahnede bir parçaya tıklayın ya da listeden seçin.</p>';
    }
    const g = (this.groups || []).find((x) => x.key === this.sel.key);
    if (!g) return '';
    const lv = FL.FLAM_LEVELS[g.level];
    const vd = FL.FLAM_VERDICTS[g.verdict];
    const info = g.info;
    const rows = [];
    rows.push(['Malzeme', esc(info.label || '—') + (info.fuelName ? '<br><span class="muted-i">yanıcı bileşen: ' + info.fuelName + '</span>' : '')]);
    rows.push(['Model sınıfı', '<i class="chip" style="background:' + lv.color + '"></i>' + lv.id + ' · ' + lv.name + ' — ' + lv.desc]);
    if (info.loi) rows.push(['LOI (yaklaşık)', '%' + info.loi[0] + (info.loi[1] !== info.loi[0] ? '–' + info.loi[1] : '') + ' O₂']);
    let why = '';
    if (g.verdict === 'burn') why = 'O₂ %' + fmt(st.o2, 3) + ' ≥ LOI üst sınırı';
    else if (g.verdict === 'edge') why = 'O₂ %' + fmt(st.o2, 3) + ' LOI aralığında: kalınlığa ve akışa bağlı';
    else if (g.verdict === 'out') why = 'O₂ %' + fmt(st.o2, 3) + ' < LOI alt sınırı (' + fmt(info.loi[0] - st.o2, 2) + ' puan pay)';
    else if (g.verdict === 'ox') why = info.sfog ? 'Kendi oksijenini üretir: ortam O₂’sinden bağımsız yanar' : 'Sızıntıda çevresinin O₂ yüzdesini yükseltir';
    else why = 'Bu basınçta yanıcı bileşen yok';
    rows.push(['Bu atmosferde', '<i class="chip" style="background:' + vd.color + '"></i>' + vd.name + ' — ' + why]);
    if (g.extras.sim_sinifi) rows.push(['Benzetim sınıfı', '<code>' + esc(g.extras.sim_sinifi) + '</code>']);
    if (g.ids.length > 1) rows.push(['Adet', String(g.ids.length)]);
    let notes = info.note ? '<p class="flam-dnote">' + esc(info.note) + '</p>' : '';
    if (info.sfog) {
      notes += '<p class="flam-dnote">1997’de Mir istasyonunda böyle bir katı yakıtlı oksijen mumu tutuştu. Mum kendi oksijenini ürettiği için alev, söndürücülere rağmen kartuş tükenene dek sürdü. ' +
        (scene.root.extras.hikaye ? '' : '') + '</p>';
    }
    if (g.extras.eklenen === 'o2-baglanti') notes += '<p class="flam-dnote">Bu parça, kaynak modelde boşta kalan O₂ uçlarını bağlamak için eklendi.</p>';
    if (g.extras.not) notes += '<p class="flam-dnote">' + esc(g.extras.not) + '</p>';
    return '<div class="flam-detail"><div class="flam-dtitle">' + esc(g.label) + '</div><dl class="kv">' +
      rows.map((r) => '<dt>' + r[0] + '</dt><dd>' + r[1] + '</dd>').join('') + '</dl>' + notes + '</div>';
  }

  /** Sahnede tıklanan parçanın grubunu seç */
  selectPart(id) {
    const g = (this.groups || []).find((x) => x.ids.includes(id));
    if (!g) { this.clear(); return; }
    this.sel = { kind: 'group', key: g.key };
    this._key = '';
    if (this.o.onSelect) this.o.onSelect(g.ids);
  }

  clear() {
    this.sel = null;
    this._key = '';
    if (this.o.onSelect) this.o.onSelect([]);
  }

  /** Model ya da ölçüt değişince seçim geçersiz kalabilir */
  reset() {
    this.sel = null;
    this._key = '';
  }

  _click(e) {
    const b = e.target.closest('button');
    if (!b || !this.root.contains(b)) return;
    if (b.dataset.act === 'close') { if (this.o.onClose) this.o.onClose(); return; }
    if (b.dataset.mode) { if (this.o.onMode) this.o.onMode(b.dataset.mode); return; }
    if (b.dataset.cat) {
      const same = this.sel && this.sel.kind === 'cat' && this.sel.key === b.dataset.cat;
      if (same) { this.clear(); return; }
      this.sel = { kind: 'cat', key: b.dataset.cat };
      this._key = '';
      const ids = [];
      for (const g of this.groups || []) if (g.cat === b.dataset.cat) ids.push(...g.ids);
      if (this.o.onSelect) this.o.onSelect(ids);
      return;
    }
    if (b.dataset.group) {
      const same = this.sel && this.sel.kind === 'group' && this.sel.key === b.dataset.group;
      if (same) { this.clear(); return; }
      const g = (this.groups || []).find((x) => x.key === b.dataset.group);
      if (!g) return;
      this.sel = { kind: 'group', key: g.key };
      this._key = '';
      if (this.o.onSelect) this.o.onSelect(g.ids, true);
    }
  }
}
FL.FlamPanel = FlamPanel;

/** İmleç altı ipucu: parça adı, malzeme, sınıf */
FL.flamTipHTML = function (p, st) {
  const lv = FL.FLAM_LEVELS[p.level];
  const vd = FL.FLAM_VERDICTS[FL.flamVerdict(p.info, st.o2)];
  return '<div class="ft-n">' + esc(p.label) + '</div><div class="ft-m">' + esc(p.info.label || '—') + '</div>' +
    '<div class="ft-r"><i style="background:' + lv.color + '"></i>' + lv.name + '<i style="background:' + vd.color + ';margin-left:10px"></i>' + vd.name + ' (O₂ %' + fmt(st.o2, 3) + ')</div>';
};
