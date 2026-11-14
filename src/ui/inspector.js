/* =====================================================================
 * Alev Laboratuvarı — Denetçi (inspector) paneli
 * ---------------------------------------------------------------------
 * Şemadan üretilen sekmeli panel. Satır düzeni: etiket + düzenlenebilir
 * değer alanı, altında kaydırıcı. Etikete çift tıklamak senaryo
 * varsayılanına döndürür; değiştirilmiş değerler bir nokta ile işaretlenir.
 * ===================================================================== */
import { FL } from '../core/fl.js';

const fmt = (x, d) => FL.fmt(x, d);
const h = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
};
const same = (a, b) => (typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b)) : a === b);

function storageGet(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
function storageSet(k, v) { try { window.localStorage.setItem(k, v); } catch (e) { /* depolama kapalı */ } }

/* ------------------------------------------------------------------ */
/* Bölümlü denetim (segmented control) — kayan seçim göstergesi          */
/* ------------------------------------------------------------------ */
function makeSeg(options, onPick, opts) {
  const o = opts || {};
  const el = h('div', 'seg' + (o.small ? ' seg-sm' : '') + (o.wrap ? ' seg-wrap' : ''));
  el.setAttribute('role', 'radiogroup');
  if (o.label) el.setAttribute('aria-label', o.label);
  el.style.setProperty('--n', options.length);
  const thumb = h('span', 'seg-thumb');
  el.appendChild(thumb);
  const btns = options.map((op, i) => {
    const b = h('button', 'seg-btn', op.label);
    b.type = 'button';
    b.setAttribute('role', 'radio');
    b.dataset.i = i;
    if (op.tip) b.dataset.tip = op.tip;
    b.addEventListener('click', () => onPick(op.value, i));
    b.addEventListener('keydown', (e) => {
      const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (!d) return;
      e.preventDefault();
      const j = (i + d + options.length) % options.length;
      btns[j].focus();
      onPick(options[j].value, j);
    });
    el.appendChild(b);
    return b;
  });
  const match = o.match || same;
  return {
    el,
    set(v) {
      let idx = -1;
      options.forEach((op, i) => { if (match(v, op.value)) idx = i; });
      btns.forEach((b, i) => {
        const on = i === idx;
        b.classList.toggle('on', on);
        b.setAttribute('aria-checked', on ? 'true' : 'false');
        b.tabIndex = on || (idx < 0 && i === 0) ? 0 : -1;
      });
      el.classList.toggle('none', idx < 0);
      el.style.setProperty('--i', Math.max(idx, 0));
    },
  };
}
FL.makeSeg = makeSeg;

/* ------------------------------------------------------------------ */
/* Araç ipucu: tek bir yüzen öğe, gecikmeli gösterim                      */
/* ------------------------------------------------------------------ */
const Tip = {
  el: null, timer: 0, owner: null,
  init() {
    this.el = h('div', 'tip');
    this.el.id = 'tip';
    this.el.setAttribute('role', 'tooltip');
    this.el.hidden = true;
    document.body.appendChild(this.el);
    const show = (t, delay) => {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.show(t), delay);
    };
    document.addEventListener('pointerover', (e) => {
      const t = e.target.closest && e.target.closest('[data-tip]');
      if (t && e.pointerType === 'mouse') show(t, 420);
      else if (!t) this.hide();
    });
    document.addEventListener('focusin', (e) => {
      const t = e.target.closest && e.target.closest('[data-tip]');
      if (t && t.matches(':focus-visible')) show(t, 200);
      else this.hide();
    });
    document.addEventListener('pointerdown', (e) => {
      const t = e.target.closest && e.target.closest('.info[data-tip]');
      if (t && e.pointerType !== 'mouse') { if (this.owner === t && !this.el.hidden) this.hide(); else this.show(t); return; }
      this.hide();
    });
    window.addEventListener('scroll', () => this.hide(), true);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') this.hide(); });
  },
  show(t) {
    if (!t.isConnected) return;
    const text = typeof t._tip === 'function' ? t._tip() : t.dataset.tip;
    if (!text) return;
    this.owner = t;
    this.el.textContent = text;
    this.el.hidden = false;
    const r = t.getBoundingClientRect();
    const tw = this.el.offsetWidth, th = this.el.offsetHeight;
    let x, y;
    if (t.dataset.tipSide === 'right') {
      // Sol paneldeki düğmeler: ipucu sağda, düğmenin ortasına hizalı
      x = r.right + 10;
      y = Math.max(8, Math.min(window.innerHeight - th - 8, r.top + r.height / 2 - th / 2));
    } else {
      x = r.left + r.width / 2 - tw / 2;
      x = Math.max(8, Math.min(window.innerWidth - tw - 8, x));
      y = r.bottom + 8;
      if (y + th > window.innerHeight - 8) y = r.top - th - 8;
    }
    this.el.style.transform = 'translate(' + Math.round(x) + 'px,' + Math.round(y) + 'px)';
  },
  hide() {
    clearTimeout(this.timer);
    if (this.el) this.el.hidden = true;
    this.owner = null;
  },
};
FL.Tip = Tip;

/* ------------------------------------------------------------------ */
/* Denetçi                                                              */
/* ------------------------------------------------------------------ */
class Inspector {
  /**
   * opts: { getState, getDefault(key), onChange(key, value, effect, isInput), actions, onTab }
   */
  constructor(root, opts) {
    this.root = root;
    this.o = opts;
    this.ctls = [];
    this.sections = [];
    this.advanced = storageGet('fl-adv') === '1';
    this.tab = storageGet('fl-tab') || 'experiment';
    if (!FL.UI_TABS.find((t) => t.id === this.tab)) this.tab = 'experiment';
    if (!Tip.el) Tip.init();
    this.build();
  }

  get st() { return this.o.getState(); }

  build() {
    const root = this.root;
    root.innerHTML = '';
    const head = h('div', 'insp-head');
    this.tabSeg = makeSeg(FL.UI_TABS.map((t) => ({ value: t.id, label: t.title })), (v) => this.setTab(v), { label: 'Denetçi sekmeleri' });
    this.tabSeg.el.classList.add('seg-tabs');
    head.appendChild(this.tabSeg.el);
    root.appendChild(head);

    const scroll = h('div', 'insp-scroll');
    this.panes = {};
    for (const tab of FL.UI_TABS) {
      const pane = h('div', 'insp-pane');
      pane.dataset.tab = tab.id;
      pane.setAttribute('role', 'tabpanel');
      for (const sec of tab.sections) pane.appendChild(this.makeSection(sec));
      scroll.appendChild(pane);
      this.panes[tab.id] = pane;
    }
    root.appendChild(scroll);
    this.scroll = scroll;

    const foot = h('div', 'insp-foot');
    const adv = h('label', 'check');
    adv.innerHTML = '<input type="checkbox"><span class="box"></span><span>Gelişmiş denetimler</span>';
    const advInp = adv.querySelector('input');
    advInp.checked = this.advanced;
    advInp.addEventListener('change', () => this.setAdvanced(advInp.checked));
    foot.appendChild(adv);
    foot.appendChild(h('span', 'foot-legend', '<i class="eff eff-reset"></i>alanı sıfırlar'));
    root.appendChild(foot);
    this.setTab(this.tab, true);
  }

  setTab(id, silent) {
    this.tab = id;
    storageSet('fl-tab', id);
    this.tabSeg.set(id);
    for (const k in this.panes) this.panes[k].hidden = k !== id;
    if (!silent && this.scroll) this.scroll.scrollTop = 0;
    if (this.o.onTab) this.o.onTab(id);
  }

  setAdvanced(on) {
    this.advanced = on;
    storageSet('fl-adv', on ? '1' : '0');
    this.refreshVisibility();
  }

  makeSection(sec) {
    const wrap = h('section', 'sec');
    wrap.dataset.sec = sec.id;
    // Açılışta yalnız Deney › Senaryo açık gelir; diğer bölümler kapalı (tıklayınca açılır)
    const open = sec.id === 'scenario';
    const head = h('button', 'sec-head', '<span class="sec-title">' + sec.title + '</span>' + FL.icon('chevron', 'sec-chev'));
    head.type = 'button';
    head.setAttribute('aria-expanded', open ? 'true' : 'false');
    const body = h('div', 'sec-body');
    // Gövde, yüksekliği 0fr → 1fr geçişiyle açılan bir kırpma kutusunda durur
    const clip = h('div', 'sec-clip');
    clip.appendChild(body);
    wrap.classList.toggle('open', open);
    head.addEventListener('click', () => {
      const now = !wrap.classList.contains('open');
      wrap.classList.toggle('open', now);
      head.setAttribute('aria-expanded', now ? 'true' : 'false');
    });
    wrap.appendChild(head);
    wrap.appendChild(clip);
    if (sec.custom) this.makeCustom(sec, body);
    else for (const it of sec.items) body.appendChild(this.makeControl(it));
    this.sections.push({ sec, wrap });
    return wrap;
  }

  makeCustom(sec, body) {
    const a = this.o.actions || {};
    if (sec.custom === 'scenario') {
      body.classList.add('pad');
      body.innerHTML =
        '<div class="scn-card"><div class="scn-group" id="scnGroup"></div><div class="scn-name" id="scnName"></div>' +
        '<p class="scn-desc" id="scnDesc"></p><div class="scn-tags" id="scnTags"></div></div>' +
        '<div class="btn-row"><button type="button" class="btn" id="btnScenarios" data-icon="scenarios">Senaryolar…</button>' +
        '<button type="button" class="btn" id="btnRestore" data-icon="reset" data-tip="Tüm deney değerlerini bu senaryonun varsayılanlarına döndürür">Varsayılanlar</button></div>';
      FL.hydrateIcons(body);
      body.querySelector('#btnScenarios').addEventListener('click', () => a.openScenarios && a.openScenarios());
      body.querySelector('#btnRestore').addEventListener('click', () => a.restorePreset && a.restorePreset());
    } else if (sec.custom === 'kv') {
      body.classList.add('pad');
      body.innerHTML = '<dl class="kv" id="' + sec.kv + '"></dl>';
    } else if (sec.custom === 'data') {
      body.classList.add('pad');
      body.innerHTML =
        '<p class="muted">Zaman serisi (HRR, T<sub>maks</sub>, χ<sub>rad</sub>, alev boyu, kurum, d², soğuk alev) noktalı virgülle ayrılmış CSV olarak; doğrudan bir tabloya aktarılabilir.</p>' +
        '<div class="btn-row"><button type="button" class="btn" id="btnCSV" data-icon="download">CSV indir</button>' +
        '<button type="button" class="btn" id="btnCopyCSV" data-icon="copy">Kopyala</button>' +
        '<button type="button" class="btn btn-icon" id="btnClearHist" data-icon="trash" aria-label="Geçmişi temizle" data-tip="Geçmişi temizle"></button></div>' +
        '<p class="muted small" id="histCount"></p>';
      FL.hydrateIcons(body);
      body.querySelector('#btnCSV').addEventListener('click', () => a.downloadCSV && a.downloadCSV());
      body.querySelector('#btnCopyCSV').addEventListener('click', () => a.copyCSV && a.copyCSV());
      body.querySelector('#btnClearHist').addEventListener('click', () => a.clearHistory && a.clearHistory());
    } else if (sec.custom === 'dataset') {
      // Ayar satırları + dışa aktarma düğmesi
      for (const it of sec.items || []) body.appendChild(this.makeControl(it));
      const box = h('div', 'pad-x');
      box.innerHTML =
        '<p class="muted">Fiziksel kameranın gördüğü görüntüler ve her kare için yer gerçeği (ısı salınımı, sıcaklık, alev boyu, ışık şiddeti, ışınım akısı, senaryo ve kamera parametreleri) tek bir .zip dosyasında. Görüntüler yalnız gerçek bir kameranın göreceği bilgiyi taşır; etiketler benzetimin kendisinden gelir.</p>' +
        '<div class="btn-row"><button type="button" class="btn" id="btnDataset" data-icon="download">Veri kümesini kaydet (.zip)</button></div>' +
        '<p class="muted small" id="dsStatus"></p>';
      body.appendChild(box);
      FL.hydrateIcons(box);
      box.querySelector('#btnDataset').addEventListener('click', () => a.captureDataset && a.captureDataset());
    } else if (sec.custom === 'notes') {
      body.classList.add('pad', 'notes');
      body.innerHTML = sec.html ? sec.html() : FL.MODEL_NOTES;
    }
  }

  /* -------------------------------------------------------------- */
  /* Denetim satırları                                                */
  /* -------------------------------------------------------------- */
  makeLabel(it, forId) {
    const lab = h('div', 'row-label');
    const l = h(forId ? 'label' : 'span', 'lbl', it.label);
    if (forId) l.htmlFor = forId;
    lab.appendChild(h('span', 'mod-dot'));
    lab.appendChild(l);
    if (it.effect === 'reset' || it.effect === 'rebuild') {
      const eff = h('i', 'eff eff-reset');
      eff.dataset.tip = it.effect === 'rebuild' ? 'Değiştirmek ızgarayı yeniden kurar ve alanı sıfırlar' : 'Değiştirmek alanı sıfırlar';
      lab.appendChild(eff);
    }
    if (it.help) {
      const b = h('button', 'info', FL.icon('info'));
      b.type = 'button';
      b.setAttribute('aria-label', it.label + ' hakkında');
      b._tip = () => (typeof it.help === 'function' ? it.help(this.st) : it.help);
      b.dataset.tip = '1';
      // Onay kutusu etiketinin içinde: tıklama kutuyu değiştirmesin
      b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); });
      lab.appendChild(b);
    }
    if (it.type !== 'toggle') {
      // Çift tıklama: senaryo varsayılanına dön
      l.addEventListener('dblclick', (e) => { e.preventDefault(); this.resetKey(it); });
      l.title = 'Çift tıklayarak varsayılana döndürün';
    }
    return lab;
  }

  resetKey(it) {
    if (it.bundle) {
      const set = {};
      for (const k of it.watch) {
        const d = this.o.getDefault(k);
        if (d !== undefined) set[k] = d;
      }
      if (this.o.actions && this.o.actions.applyEnv) this.o.actions.applyEnv(set, 'Ortam varsayılanları');
      return;
    }
    const d = this.o.getDefault(it.key);
    if (d === undefined) return;
    this.o.onChange(it.key, d, it.effect, false);
  }

  valueText(it, v) {
    if (it.type === 'gravity') return FL.gravityText(v);
    if (it.fmt) return it.fmt(v);
    return (it.pre || '') + fmt(v, it.digits === undefined ? 3 : it.digits);
  }

  makeValueField(it, onCommit) {
    const box = h('div', 'val');
    const inp = h('input', 'val-in');
    inp.type = 'text';
    inp.inputMode = 'decimal';
    inp.spellcheck = false;
    inp.autocomplete = 'off';
    inp.setAttribute('aria-label', it.label + ' değeri');
    box.appendChild(inp);
    if (it.unit) box.appendChild(h('span', 'unit', it.unit));
    let cur = null;
    const parse = (s) => {
      s = String(s).trim().replace(/×/g, '').replace(/\s/g, '').replace(',', '.');
      if (it.type === 'gravity') {
        const m = /^10\^?(-?\d+)$/.exec(s) || /^10([⁻⁰¹²³⁴⁵⁶⁷⁸⁹]+)$/.exec(s);
        if (m) {
          const map = { '⁻': '-', '⁰': 0, '¹': 1, '²': 2, '³': 3, '⁴': 4, '⁵': 5, '⁶': 6, '⁷': 7, '⁸': 8, '⁹': 9 };
          const e = m[1].split('').map((c) => (c in map ? map[c] : c)).join('');
          return Math.pow(10, Number(e));
        }
      }
      if (s.toLowerCase() === 'kapalı') return 0;
      const v = parseFloat(s);
      return isFinite(v) ? v : NaN;
    };
    const commit = () => {
      let v = parse(inp.value);
      if (!isFinite(v)) { inp.value = this.valueText(it, cur); return; }
      if (it.parse) v = it.parse(v);
      if (it.type === 'gravity') v = FL.clamp(v, 0, 2.2);
      else {
        if (it.step && !it.log) v = Math.round(v / it.step) * it.step;
        v = FL.clamp(v, it.min, it.max);
        v = Number(v.toPrecision(10));
      }
      onCommit(v);
    };
    inp.addEventListener('focus', () => { setTimeout(() => inp.select(), 0); });
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); inp.blur(); }
      else if (e.key === 'Escape') { inp.value = this.valueText(it, cur); inp.blur(); }
      else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && it.type === 'range') {
        e.preventDefault();
        const dir = e.key === 'ArrowUp' ? 1 : -1;
        const mul = e.shiftKey ? 10 : 1;
        let v = it.log ? cur * Math.pow(1.05, dir * mul) : cur + dir * it.step * mul;
        v = Number(FL.clamp(v, it.min, it.max).toPrecision(10));
        onCommit(v);
        setTimeout(() => inp.select(), 0);
      }
    });
    inp.addEventListener('blur', () => { if (document.activeElement !== inp) inp.value = this.valueText(it, cur); });
    inp.addEventListener('change', commit);
    return {
      el: box,
      set: (v) => { cur = v; if (document.activeElement !== inp) inp.value = this.valueText(it, v); },
    };
  }

  makeControl(it) {
    const id = 'ctl-' + (it.id || it.key);
    const row = h('div', 'row row-' + it.type);
    row.dataset.key = it.key;
    let set;

    if (it.type === 'bundle') {
      row.classList.add('row-bundle');
      row.appendChild(this.makeLabel(it, ''));
      const seg = makeSeg(it.options(this.st), (id) => {
        const pack = it.apply(id);
        if (pack && this.o.actions && this.o.actions.applyEnv) this.o.actions.applyEnv(pack.set, pack.name);
      }, { wrap: true, small: true, label: it.label });
      row.appendChild(seg.el);
      const note = h('p', 'bundle-note');
      row.appendChild(note);
      set = () => {
        seg.set(it.current(this.st));
        note.textContent = it.note(this.st);
      };
    } else if (it.type === 'range' || it.type === 'gravity') {
      const top = h('div', 'row-top');
      top.appendChild(this.makeLabel(it, id));
      const val = this.makeValueField(it, (v) => this.o.onChange(it.key, v, it.effect, false));
      top.appendChild(val.el);
      const inp = h('input', 'slider');
      inp.type = 'range';
      inp.id = id;
      if (it.type === 'gravity') { inp.min = -6.5; inp.max = 0.35; inp.step = 0.01; }
      else if (it.log) { inp.min = Math.log10(it.min); inp.max = Math.log10(it.max); inp.step = 0.001; }
      else { inp.min = it.min; inp.max = it.max; inp.step = it.step; }
      const toVal = (raw) => {
        const r = parseFloat(raw);
        if (it.type === 'gravity') return FL.sliderToG(r);
        if (it.log) {
          let v = Math.pow(10, r);
          v = Math.round(v / it.step) * it.step;
          return Number(FL.clamp(v, it.min, it.max).toPrecision(10));
        }
        return r;
      };
      const toRaw = (v) => (it.type === 'gravity' ? FL.gToSlider(v) : it.log ? Math.log10(Math.max(v, it.min)) : v);
      const paint = () => {
        const p = ((parseFloat(inp.value) - parseFloat(inp.min)) / (parseFloat(inp.max) - parseFloat(inp.min))) * 100;
        inp.style.setProperty('--p', FL.clamp(p, 0, 100).toFixed(2) + '%');
      };
      inp.addEventListener('input', () => {
        const v = toVal(inp.value);
        val.set(v);
        paint();
        this.o.onChange(it.key, v, it.effect, true);
      });
      inp.addEventListener('change', () => this.o.onChange(it.key, toVal(inp.value), it.effect, false));
      inp.addEventListener('dblclick', () => this.resetKey(it));
      row.appendChild(top);
      row.appendChild(inp);
      let gseg = null;
      if (it.type === 'gravity') {
        gseg = makeSeg(FL.GRAVITY_PRESETS.map((gp) => ({ value: gp.g, label: gp.label })), (g) => this.o.onChange('gravity', g, 'live', false),
          { small: true, label: 'Hazır yerçekimi değerleri', match: (a, b) => (b === 0 ? a === 0 : Math.abs(a - b) / b < 0.02) });
        row.appendChild(gseg.el);
      }
      set = (v) => {
        if (document.activeElement !== inp) inp.value = toRaw(v);
        val.set(v);
        paint();
        if (gseg) gseg.set(v);
      };
    } else if (it.type === 'select') {
      const top = h('div', 'row-top');
      top.appendChild(this.makeLabel(it, id));
      row.appendChild(top);
      const wrap = h('div', 'select');
      const sel = h('select');
      sel.id = id;
      wrap.appendChild(sel);
      wrap.insertAdjacentHTML('beforeend', '<svg class="select-chev" viewBox="0 0 12 12" aria-hidden="true"><path d="M3.5 4.8L6 2.5l2.5 2.3M3.5 7.2L6 9.5l2.5-2.3" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>');
      sel.addEventListener('change', () => this.o.onChange(it.key, it.num ? Number(sel.value) : sel.value, it.effect, false));
      row.appendChild(wrap);
      set = (v) => {
        const opts = it.options(this.st);
        const sig = opts.map((o) => o.value).join('|');
        if (sel.dataset.sig !== sig) {
          sel.innerHTML = '';
          opts.forEach((o) => {
            const op = document.createElement('option');
            op.value = o.value;
            op.textContent = o.label;
            sel.appendChild(op);
          });
          sel.dataset.sig = sig;
        }
        sel.value = String(v);
      };
    } else if (it.type === 'seg') {
      const top = h('div', 'row-top');
      top.appendChild(this.makeLabel(it));
      row.appendChild(top);
      const seg = makeSeg(it.options(this.st), (v) => this.o.onChange(it.key, v, it.effect, false), { label: it.label, match: it.match });
      row.appendChild(seg.el);
      set = (v) => seg.set(v);
    } else if (it.type === 'list') {
      const list = h('div', 'mode-list');
      list.setAttribute('role', 'radiogroup');
      list.setAttribute('aria-label', it.label);
      const opts = it.options(this.st);
      const items = opts.map((o, i) => {
        const b = h('button', 'mode-item',
          '<span class="mode-sw mode-sw-' + o.value + '"></span><span class="mode-txt"><span class="mode-name">' + o.label + '</span><span class="mode-desc">' + o.desc + '</span></span><kbd>' + o.kbd + '</kbd>');
        b.type = 'button';
        b.setAttribute('role', 'radio');
        b.addEventListener('click', () => this.o.onChange(it.key, o.value, it.effect, false));
        b.addEventListener('keydown', (e) => {
          const d = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
          if (!d) return;
          e.preventDefault();
          const j = (i + d + opts.length) % opts.length;
          items[j].focus();
          this.o.onChange(it.key, opts[j].value, it.effect, false);
        });
        list.appendChild(b);
        return b;
      });
      row.appendChild(list);
      set = (v) => items.forEach((b, i) => {
        const on = opts[i].value === v;
        b.classList.toggle('on', on);
        b.setAttribute('aria-checked', on ? 'true' : 'false');
        b.tabIndex = on ? 0 : -1;
      });
    } else if (it.type === 'buttons') {
      // Eylem düğmeleri (ör. kamerayı hizala); durum tutmaz
      const box = h('div', 'btn-row btn-row-tight');
      for (const b of it.buttons) {
        const el = h('button', 'btn', b.label);
        el.type = 'button';
        if (b.icon) el.dataset.icon = b.icon;
        if (b.tip) el.dataset.tip = b.tip;
        el.addEventListener('click', () => this.o.actions && this.o.actions[b.action] && this.o.actions[b.action]());
        box.appendChild(el);
      }
      FL.hydrateIcons && FL.hydrateIcons(box);
      row.appendChild(box);
      set = () => {};
    } else if (it.type === 'toggle') {
      row.classList.add('row-check');
      const lab = h('label', 'check');
      lab.innerHTML = '<input type="checkbox" id="' + id + '"><span class="box"></span>';
      const inp = lab.querySelector('input');
      const l = this.makeLabel(it);
      lab.appendChild(l);
      inp.addEventListener('change', () => this.o.onChange(it.key, inp.checked, it.effect, false));
      row.appendChild(lab);
      set = (v) => { inp.checked = !!v; };
    }

    const ctl = { it, row, set: set || (() => {}) };
    this.ctls.push(ctl);
    return row;
  }

  /** Tüm denetimleri duruma eşitle */
  sync() {
    const st = this.st;
    for (const c of this.ctls) {
      if (c.it.bundle) { c.set(); c.row.classList.remove('modified'); continue; }
      c.set(st[c.it.key]);
      const d = this.o.getDefault(c.it.key);
      c.row.classList.toggle('modified', d !== undefined && !same(st[c.it.key], d));
    }
    this.refreshVisibility();
  }

  /** Yalnız tek bir anahtarın satırlarını güncelle (kaydırma sırasında ucuz yol) */
  syncKey(key) {
    const st = this.st;
    for (const c of this.ctls) {
      if (c.it.bundle) {
        if (c.it.watch && c.it.watch.includes(key)) c.set();
        continue;
      }
      if (c.it.key !== key) continue;
      c.set(st[key]);
      const d = this.o.getDefault(key);
      c.row.classList.toggle('modified', d !== undefined && !same(st[key], d));
    }
  }

  refreshVisibility() {
    const st = this.st;
    for (const c of this.ctls) {
      const vis = (c.it.when ? c.it.when(st) : true) && (!c.it.adv || this.advanced);
      c.row.hidden = !vis;
    }
    for (const s of this.sections) {
      const vis = s.sec.when ? s.sec.when(st) : true;
      s.wrap.hidden = !vis;
    }
  }

  setKV(id, rows) {
    const el = document.getElementById(id);
    if (!el) return;
    let html = '';
    for (const r of rows) html += '<dt>' + r[0] + '</dt><dd>' + r[1] + '</dd>';
    if (el._last !== html) {
      el.innerHTML = html;
      el._last = html;
    }
  }

  setScenario(preset) {
    const q = (id) => this.root.querySelector('#' + id);
    if (!q('scnName')) return;
    q('scnGroup').textContent = preset.group;
    q('scnName').textContent = preset.name;
    q('scnDesc').textContent = preset.desc;
    q('scnTags').innerHTML = FL.presetTags(preset).map((t) => '<span class="tag">' + t + '</span>').join('');
  }
}
FL.Inspector = Inspector;

/** Senaryo özet etiketleri (g, O₂, P, yakıt) */
FL.presetTags = function (p) {
  const s = Object.assign({}, FL.DEFAULTS, p.set);
  const fuel = FL.FUELS[s.fuel];
  return [
    'g ' + FL.gravityText(s.gravity) + ' g₀',
    'O₂ %' + fmt(s.o2, 3),
    fmt(s.pressure, 3) + ' kPa',
    fuel ? fuel.name.split(' (')[0] : s.fuel,
  ];
};
