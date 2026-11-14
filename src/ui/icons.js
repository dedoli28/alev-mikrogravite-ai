/* =====================================================================
 * Alev Laboratuvarı — Çizgi simgeler (24×24, 1,6 px kontur)
 * ===================================================================== */
import { FL } from '../core/fl.js';

const P = {
  flame: '<path d="M12 21c-3.6 0-6-2.5-6-5.8 0-2.6 1.5-4.4 3-6 .9-1 1.7-2.1 2-3.7.1-.4.6-.6.9-.3 2.6 2.2 4.1 5.2 4.1 7.4.6-.4 1-1.1 1.2-1.9.1-.4.6-.5.9-.2.9 1.1 1.9 2.9 1.9 4.7 0 3.3-2.4 5.8-6 5.8z"/><path d="M12 21c-1.5 0-2.6-1.1-2.6-2.6 0-1.6 1.3-2.5 2.6-4 1.3 1.5 2.6 2.4 2.6 4 0 1.5-1.1 2.6-2.6 2.6z"/>',
  extinguish: '<path d="M4 8h9.5a2.5 2.5 0 1 0-2.5-2.5"/><path d="M4 12h14.5a2.5 2.5 0 1 1-2.5 2.5"/><path d="M4 16h7a2 2 0 1 1-2 2"/>',
  tank: '<path d="M9 8.5h6a1.5 1.5 0 0 1 1.5 1.5v9.5a1.5 1.5 0 0 1-1.5 1.5H9a1.5 1.5 0 0 1-1.5-1.5V10A1.5 1.5 0 0 1 9 8.5z"/><path d="M10.5 8.5V6h3v2.5"/><path d="M13.5 6.5h3.5l2 2"/><path d="M10 4.5h4"/>',
  play: '<path d="M8 5.5v13a.6.6 0 0 0 .9.5l10.3-6.5a.6.6 0 0 0 0-1L8.9 5a.6.6 0 0 0-.9.5z" fill="currentColor" stroke="none"/>',
  pause: '<rect x="6.5" y="5" width="3.6" height="14" rx="1" fill="currentColor" stroke="none"/><rect x="13.9" y="5" width="3.6" height="14" rx="1" fill="currentColor" stroke="none"/>',
  reset: '<path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3"/><path d="M4.5 4.5v3.8h3.8"/>',
  step: '<path d="M6 6.5v11a.5.5 0 0 0 .8.4l7.7-5.5a.5.5 0 0 0 0-.8L6.8 6.1a.5.5 0 0 0-.8.4z"/><path d="M18 6v12"/>',
  camera: '<path d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2l1.4-2h6.2l1.4 2h2A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z"/><circle cx="12" cy="12.8" r="3.4"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  keyboard: '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 10h.01M10 10h.01M13 10h.01M16 10h.01M7 13h.01M16 13h.01M9.5 13h4.5" stroke-width="2"/>',
  sidebar: '<rect x="3.5" y="5" width="17" height="14" rx="2"/><path d="M14.5 5v14"/><path d="M16.5 8.5h2M16.5 11h2M16.5 13.5h2"/>',
  chart: '<path d="M4 19h16"/><path d="M5 15l4-5 3.5 3L19 6"/>',
  fit: '<path d="M4 9V5.5A1.5 1.5 0 0 1 5.5 4H9M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9M20 15v3.5a1.5 1.5 0 0 1-1.5 1.5H15M9 20H5.5A1.5 1.5 0 0 1 4 18.5V15"/>',
  front: '<rect x="6" y="6" width="12" height="12" rx="1"/><path d="M12 9v6M9 12h6"/>',
  side: '<path d="M6 8l6-3 6 3v8l-6 3-6-3z"/><path d="M12 11v8M6 8l6 3 6-3"/>',
  top: '<path d="M12 4l8 4-8 4-8-4z"/><path d="M4 12l8 4 8-4M4 16l8 4 8-4" opacity=".55"/>',
  orbit: '<path d="M20 12a8 8 0 0 1-14.3 4.9"/><path d="M4 12a8 8 0 0 1 14.3-4.9"/><path d="M18.5 3.5v3.8h-3.8M5.5 20.5v-3.8h3.8"/>',
  chevron: '<path d="M9 6l6 6-6 6"/>',
  chevronDown: '<path d="M6 9l6 6 6-6"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5"/><path d="M12 7.6v.1" stroke-width="2.2"/>',
  close: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  search: '<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5"/>',
  download: '<path d="M12 4v11"/><path d="M7.5 10.5L12 15l4.5-4.5"/><path d="M5 19h14"/>',
  copy: '<rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V6.5A1.5 1.5 0 0 0 14.5 5h-8A1.5 1.5 0 0 0 5 6.5v8A1.5 1.5 0 0 0 6.5 16H8"/>',
  trash: '<path d="M5 7h14M10 7V5h4v2M7 7l.8 11.2a1.5 1.5 0 0 0 1.5 1.3h5.4a1.5 1.5 0 0 0 1.5-1.3L17 7"/>',
  scenarios: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
  warning: '<path d="M12 4.5l8.5 15h-17z"/><path d="M12 10v4.5"/><path d="M12 17.2v.1" stroke-width="2.2"/>',
  check: '<path d="M5.5 12.5l4.2 4.2L18.5 8"/>',
  minus: '<path d="M6 12h12"/>',
  film: '<rect x="3.5" y="5.5" width="17" height="13" rx="2"/><path d="M7.5 5.5v13M16.5 5.5v13M3.5 9.5h4M3.5 14.5h4M16.5 9.5h4M16.5 14.5h4"/>',
  drop: '<path d="M12 3.8c3 3.6 5.5 6.7 5.5 9.9a5.5 5.5 0 0 1-11 0c0-3.2 2.5-6.3 5.5-9.9z"/>',
  planet: '<circle cx="12" cy="12" r="5.6"/><path d="M5.2 15.6c-2.1 1.9-2.9 3.5-2.2 4.3 1.2 1.3 6.3-1.3 11.3-5.8s8.1-9.4 6.9-10.7c-.7-.8-2.5-.3-4.8 1.1"/>',
  gravity: '<path d="M12 4v11"/><path d="M8 11.5l4 4 4-4"/><path d="M5 19.5h14"/>',
  layers: '<path d="M12 4.5l8 4-8 4-8-4z"/><path d="M4 12.5l8 4 8-4"/><path d="M4 16.5l8 4 8-4"/>',
  sliders: '<path d="M5 7h8M17 7h2M5 12h2M11 12h8M5 17h10M19 17h0"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="17" r="2"/>',
  ai: '<rect x="7" y="7" width="10" height="10" rx="1.8"/><path d="M10 10.2h4v3.6h-4z"/><path d="M9.5 4v3M14.5 4v3M9.5 17v3M14.5 17v3M4 9.5h3M4 14.5h3M17 9.5h3M17 14.5h3"/>',
  sun: '<circle cx="12" cy="12" r="3.6"/><path d="M12 3.5v2.4M12 18.1v2.4M3.5 12h2.4M18.1 12h2.4M6 6l1.7 1.7M16.3 16.3L18 18M18 6l-1.7 1.7M7.7 16.3L6 18"/>',
  spark: '<path d="M13 3.5L6.5 13h4.2L9.8 20.5 17.5 10.5h-4.3z"/>',
  cube: '<path d="M12 3.8l7.5 4.1v8.2L12 20.2l-7.5-4.1V7.9z"/><path d="M4.5 7.9L12 12l7.5-4.1M12 12v8.2"/>',
  hazard: '<path d="M12 3.5l8.5 4.5v5.4c0 3.6-3.4 6.2-8.5 7.6-5.1-1.4-8.5-4-8.5-7.6V8z"/><path d="M12 8.2c1.9 2 3 3.6 3 5.1a3 3 0 0 1-6 0c0-1 .5-1.9 1.2-2.7.2.8.6 1.3 1.2 1.5-.2-1.4.1-2.6.6-3.9z"/>',
  book: '<path d="M5 5.5A1.5 1.5 0 0 1 6.5 4H18v14H6.5A1.5 1.5 0 0 0 5 19.5z"/><path d="M5 19.5A1.5 1.5 0 0 0 6.5 21H18v-3"/><path d="M9 8h5"/>',
};

FL.icon = function (name, cls) {
  return '<svg class="ico' + (cls ? ' ' + cls : '') + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (P[name] || '') + '</svg>';
};

/** data-icon özniteliği taşıyan öğelere simgeyi yerleştir */
FL.hydrateIcons = function (root) {
  (root || document).querySelectorAll('[data-icon]').forEach((el) => {
    if (el.querySelector('svg.ico')) return;
    el.insertAdjacentHTML('afterbegin', FL.icon(el.dataset.icon));
  });
};
