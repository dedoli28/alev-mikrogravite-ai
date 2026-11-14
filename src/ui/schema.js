/* =====================================================================
 * Alev Laboratuvarı — Denetim şeması
 * ---------------------------------------------------------------------
 * Sekme → bölüm → denetim. Her denetim bir "etki sınıfı" taşır:
 *   live    → sonraki adımda geçerli
 *   reset   → alanlar ortam koşullarına sıfırlanır
 *   rebuild → ızgara yeniden ayrılır
 * adv: true olan denetimler yalnız "Gelişmiş" açıkken görünür.
 * ===================================================================== */
import { FL } from '../core/fl.js';

const fmt = (x, d) => FL.fmt(x, d);
const isSrc = (...s) => (st) => s.includes(st.source);
const isView = (...v) => (st) => v.includes(st.view);
const hasModel = (st) => !!st.model && st.model !== 'none';

/** Yerçekimi: 0, 10⁻ⁿ biçimi veya ondalık */
function gravityText(g) {
  if (g === 0) return '0';
  if (g < 1e-3) {
    const e = Math.floor(Math.log10(g) + 1e-9);
    const m = g / Math.pow(10, e);
    const ms = m.toFixed(1).replace('.', ',');
    return (ms === '1,0' ? '' : ms + '×') + '10' + FL.sup(e);
  }
  return fmt(g, 3);
}
FL.gravityText = gravityText;
FL.gToSlider = (g) => (g <= 0 ? -6.5 : FL.clamp(Math.log10(g), -6.4, 0.35));
FL.sliderToG = (v) => (v <= -6.45 ? 0 : Math.pow(10, v));

FL.VIEW_MODES = [
  { id: 'real', name: 'Gerçekçi', desc: 'Göz ya da kamera: kurum akkorluğu ve mavi kemilüminesans' },
  { id: 'ir', name: 'Termal kamera', desc: 'CO₂, H₂O ve kurumun toplam ışınımı' },
  { id: 'temp', name: 'Sıcaklık', desc: 'Hacimsel sıcaklık alanı' },
  { id: 'hrr', name: 'Isı salınımı', desc: 'Tepkime bölgesi (HRR, logaritmik)' },
  { id: 'soot', name: 'Kurum', desc: 'Kurum hacim kesri f_v' },
  { id: 'vel', name: 'Hız', desc: 'Sıcak gazda hız büyüklüğü |u|' },
  { id: 'species', name: 'Türler', desc: 'Yakıt (yeşil) ve O₂ tükenmesi (mavi)' },
  { id: 'schlieren', name: 'Schlieren', desc: 'Yoğunluk gradyanı — laboratuvar optiği' },
  { id: 'rad', name: 'Işınım akısı', desc: 'Alevin ışınımı G − G∞ ve masaya gelen ışınım ısı akısı' },
  { id: 'ai', name: 'Yapay zekâ tahmini', kbd: 'A', desc: 'Kokpit yangın modeli: parçaların risk haritası ve öngörülen alev cephesi' },
];

FL.UI_TABS = [
  {
    id: 'experiment', title: 'Deney',
    sections: [
      { id: 'scenario', title: 'Senaryo', custom: 'scenario' },
      {
        id: 'source', title: 'Kaynak ve yakıt',
        items: [
          {
            key: 'source', type: 'seg', label: 'Kaynak', effect: 'reset',
            options: () => [
              { value: 'none', label: 'Yok' },
              { value: 'candle', label: 'Mum' }, { value: 'jet', label: 'Gaz jeti' },
              { value: 'droplet', label: 'Damla' }, { value: 'sheet', label: 'Levha' },
            ],
          },
          {
            key: 'fuel', type: 'select', label: 'Yakıt', effect: 'live',
            options: (st) => Object.values(FL.FUELS).filter((f) => f.sources.includes(st.source)).map((f) => ({ value: f.id, label: f.name })),
            help: (st) => (FL.FUELS[st.fuel] ? FL.FUELS[st.fuel].note : ''),
          },
          { key: 'jetU', type: 'range', label: 'Jet ortalama hızı', min: 2, max: 150, step: 1, unit: 'cm/s', digits: 3, effect: 'live', when: isSrc('jet') },
          { key: 'nozzleD', type: 'range', label: 'Nozul iç çapı', min: 1, max: 12, step: 0.1, unit: 'mm', digits: 2, effect: 'live', when: isSrc('jet') },
          { key: 'fuelDilution', type: 'range', label: 'Yakıtta N₂ seyreltmesi', min: 0, max: 85, step: 1, unit: '%', digits: 2, effect: 'live', when: isSrc('jet') },
          { key: 'coflow', type: 'range', label: 'Eş-akış (hava) hızı', min: 0, max: 40, step: 0.5, unit: 'cm/s', digits: 3, effect: 'reset', when: isSrc('jet'), fmt: (v) => (v > 0 ? fmt(v, 3) : 'kapalı'), help: 'Nozulu çevreleyen bal peteği düzenleyiciden gelen hava akışı (ACME tipi brülör).' },
          { key: 'dropletD', type: 'range', label: 'Başlangıç çapı d₀', min: 1, max: 8, step: 0.1, unit: 'mm', digits: 2, effect: 'reset', when: isSrc('droplet') },
          { key: 'wickRate', type: 'range', label: 'Fitil buhar debisi', min: 0.2, max: 6, step: 0.05, unit: 'mg/s', digits: 3, effect: 'live', when: isSrc('candle'), help: 'Gerçek bir mumun yanma hızı yaklaşık 1–2 mg/s\'dir. Bu üst sınır, alevden fitile geri gelen ısıya göre ölçeklenir.' },
          { key: 'sheetW', type: 'range', label: 'Levha genişliği', min: 1, max: 4.5, step: 0.1, unit: 'cm', digits: 2, effect: 'reset', when: isSrc('sheet') },
          { key: 'sheetH', type: 'range', label: 'Levha yüksekliği', min: 2, max: 7, step: 0.1, unit: 'cm', digits: 2, effect: 'reset', when: isSrc('sheet') },
          { key: 'sheetIgnTop', type: 'toggle', label: 'Üst kenardan tutuştur (karşı akış)', effect: 'live', when: isSrc('sheet') },
          { key: 'flameRadFeedback', type: 'range', label: 'Alev ışınımı geri beslemesi', min: 0, max: 0.4, step: 0.01, digits: 2, effect: 'live', when: isSrc('sheet'), adv: true, help: 'Alevden levhaya gelen ışınımın gri-gaz salım katsayısı.' },
        ],
      },
      {
        id: 'model', title: 'Sahne nesneleri',
        items: [
          {
            key: 'model', type: 'select', label: 'Nesneler', effect: 'live',
            // Birden çok nesne sol paneldeki Nesneler listesinden (M) eklenir; seçili birleşim burada da görünür
            options: (st) => {
              const list = [{ value: 'none', label: 'Yok' }].concat(FL.MODELS.map((m) => ({ value: m.id, label: m.name })));
              const cur = FL.modelById(st.model);
              if (cur && cur.composite) list.push({ value: cur.id, label: cur.name });
              return list;
            },
            help: (st) => { const m = FL.modelById(st.model); return m ? m.desc + '. Gerçek ölçekte (1:1) yerleşir; küçük nesneler masaya, deney kutusunun arkasına yan yana oturur. Kabinde deney orta güverte döşemesindedir. Birden çok nesne eklemek için sol paneldeki Nesneler listesini (M) kullanın.' : 'Deneyin yanına uzay aracı donanımı yerleştirir: her nesne ayrı eklenir ve çıkarılır (sol panel, M). Alevin ışığı nesneleri aydınlatır, gölge düşürür; yanıcı parçaları tutuşturabilir.'; },
          },
          { key: 'modelRot', type: 'range', label: 'Döndür (y ekseni)', min: -180, max: 180, step: 5, unit: '°', digits: 3, effect: 'live', when: hasModel },
          { key: 'modelX', type: 'range', label: 'Kaydır X', min: -250, max: 250, step: 0.5, unit: 'cm', digits: 3, effect: 'live', when: hasModel },
          { key: 'modelZ', type: 'range', label: 'Kaydır Z', min: -250, max: 250, step: 0.5, unit: 'cm', digits: 3, effect: 'live', when: hasModel, help: 'Negatif değer modeli kameradan uzaklaştırır. Model hesaplama alanına girerse içine düşen hücreler katı olur ve akış çevresinden dolaşır.' },
          { key: 'modelSolid', type: 'toggle', label: 'Alana giren parçalar katı engel', effect: 'live', when: hasModel, help: 'Açıkken modelin hesaplama kutusunun içinde kalan bölümü çözücüde eylemsiz katı hücre olur (alev ve akış onun çevresinden geçer). Malzemenin kendisi bu sürümde yanmaz; yanıcılığı Yanıcılık modülünde değerlendirilir.' },
          { key: 'flamView', type: 'toggle', label: 'Yanıcılık görünümü (Y)', effect: 'live', when: hasModel },
          {
            key: 'flamMode', type: 'seg', label: 'Renk ölçütü', effect: 'live', when: (s) => hasModel(s) && s.flamView,
            options: () => [{ value: 'class', label: 'Model sınıfı' }, { value: 'atm', label: 'Bu atmosferde' }],
            help: 'Model sınıfı: modelin kendi 0–3 yanıcılık seviyesi. Bu atmosferde: ortamın O₂ yüzdesi malzemenin sınırlayıcı oksijen indisi (LOI) aralığıyla karşılaştırılır; Ortam › Oksijen kaydırıcısını değiştirince renkler güncellenir.',
          },
        ],
      },
      { id: 'modelInfo', title: 'Model bilgisi', custom: 'kv', kv: 'modelInfo', when: hasModel },
      {
        id: 'fx', title: 'Yangın ve patlama',
        items: [
          {
            key: 'fxTool', type: 'seg', label: 'Tıklama aracı', effect: 'live',
            options: () => [{ value: 'none', label: 'Kapalı' }, { value: 'spark', label: 'Kıvılcım' }, { value: 'charge', label: 'Patlayıcı' }, { value: 'agent', label: 'Söndürücü' }],
            help: 'Sahnede tıklanan noktaya uygulanır (sürükleme görünümü döndürmeye devam eder). Bir parça ancak yakıt + ısı + oksitleyici bir aradayken yanar: tutuşup tutuşmadığı ve nedeni sol alttaki günlükte yazar. Hazır senaryolar sol paneldeki Yangın düğmesindedir (N).',
          },
          { key: 'fxYield', type: 'range', label: 'Patlayıcı enerjisi', min: 0.005, max: 3, step: 0.005, unit: 'MJ', digits: 3, effect: 'live',
            help: 'Ateş topu yarıçapı ≈ 0,5·∛E metre (E: MJ). 0,05 MJ ≈ 12 g TNT; 1 MJ ≈ 240 g TNT. Vakumda şok dalgası ve asılı duman olmaz; parçalar düz çizgide uçar.' },
          { key: 'fxO2Link', type: 'toggle', label: 'Yangın kabin oksijenini tüketir', effect: 'live',
            help: 'Açıkken nesne yangınının tükettiği oksijen Ortam › Oksijen değerine geri yazılır: kabin havası fakirleştikçe akış çözücüsündeki alev de (mum, levha) zayıflar ve yangın yakıt bitmeden sönebilir. O₂ kaynağı yarılırsa yüzde yükselir. Alanı sıfırlamak (R) başlangıç değerini geri getirir.' },
          { key: 'fxDeplete', type: 'range', label: 'O₂ tükenme hızı', min: 0, max: 8, step: 0.25, unit: '×', digits: 3, effect: 'live',
            help: '1 = fiziksel: yangın kabin havasındaki oksijeni gerçek hızında tüketir. Yüzey yangınının yayılması izlenebilsin diye hızlandırıldığından varsayılan 0,3 alınır: alev kabinde yayılacak zamanı bulur, sonra oksijen azaldıkça zayıflayıp söner. 0 = yaşam destek sistemi tüketimi karşılar (oksijen düşmez, yangın yakıt bitene kadar yayılır). Büyük değerlerde yangın yakıt bitmeden boğulur.' },
          { key: 'cabinVent', type: 'range', label: 'Kabin havalandırması', min: 0, max: 40, step: 1, unit: 'cm/s', digits: 3, effect: 'live',
            help: 'Mekik kabinindeki fanların dolaştırdığı hava (yalnız kabin modelinde). Mikrogravitede yüzdürme olmadığından alevi taze oksijenle besleyen tek şey budur: 0 yapılırsa alev kendi yanma ürünlerinde boğulur; ~15 cm/s en iyi beslemeyi verir. Yangında fanları kapatmak bu yüzden ilk müdahaledir.' },
        ],
      },
      {
        id: 'env', title: 'Ortam',
        items: [
          {
            type: 'bundle', bundle: true, id: 'place', key: '_place', label: 'Konum',
            help: 'Seçilen konum yerçekimini, basıncı, oksijeni, seyrelticiyi, sıcaklığı ve akışı birlikte kurar. Sonraki kaydırıcılar bu değerlerin üzerine yazılır.',
            options: () => FL.PLACES.map((p) => ({ value: p.id, label: p.short, tip: p.name })),
            watch: ['gravity', 'gJitter', 'o2', 'pressure', 'diluent', 'Tamb', 'flow', 'draft', 'wind', 'windDir'],
            current: (st) => { const p = FL.PLACES.find((x) => FL.matchPlace(x, st)); return p ? p.id : null; },
            apply: (id) => { const p = FL.PLACES.find((x) => x.id === id); return p ? { set: p.set, name: p.name } : null; },
            note: (st) => {
              const p = FL.PLACES.find((x) => FL.matchPlace(x, st));
              return (p ? p.note : 'Özel ortam — hazır bir konumla birebir eşleşmiyor.') + ' ' + FL.envSummary(st);
            },
          },
          {
            type: 'bundle', bundle: true, id: 'oxidizer', key: '_oxidizer', label: 'Oksitleyici',
            help: 'Oksijen kesri ve onu dengeleyen gaz. Basınç ve yerçekimi değişmez.',
            options: () => FL.OXIDIZERS.map((o) => ({ value: o.id, label: o.short, tip: o.name })),
            watch: ['o2', 'diluent'],
            current: (st) => { const o = FL.OXIDIZERS.find((x) => FL.matchOxidizer(x, st)); return o ? o.id : null; },
            apply: (id) => {
              const o = FL.OXIDIZERS.find((x) => x.id === id);
              return o ? { set: { o2: o.o2, diluent: o.diluent }, name: o.name } : null;
            },
            note: (st) => {
              const o = FL.OXIDIZERS.find((x) => FL.matchOxidizer(x, st));
              const dil = FL.DILUENTS[st.diluent];
              return o ? o.note : 'Özel karışım: O₂ %' + FL.fmt(st.o2, 3) + ', ' + (dil ? dil.name : st.diluent) + '.';
            },
          },
          { key: 'gravity', type: 'gravity', label: 'Yerçekimi', unit: 'g₀', effect: 'live', help: 'Yüzdürme kuvveti (1 − ρ∞/ρ)·g ile ölçeklenir. Sıfıra yakın değerlerde taşınımın yerini difüzyon alır.' },
          { key: 'o2', type: 'range', label: 'Oksijen (mol)', min: 0, max: 100, step: 0.01, unit: '%', digits: 3, effect: 'live' },
          { key: 'pressure', type: 'range', label: 'Basınç', min: 0.4, max: 200, step: 0.01, unit: 'kPa', digits: 4, effect: 'live', help: 'Yoğunluk, difüzyon katsayıları (∝ 1/P) ve gaz ışınımı (∝ P) değişir. Mars yüzeyi yaklaşık 0,6 kPa’dır.' },
          { key: 'diluent', type: 'select', label: 'Seyreltici gaz', effect: 'live', options: () => Object.values(FL.DILUENTS).map((d) => ({ value: d.id, label: d.name })) },
          { key: 'Tamb', type: 'range', label: 'Ortam sıcaklığı', min: 180, max: 600, step: 1, unit: 'K', digits: 4, effect: 'live' },
          { key: 'flow', type: 'range', label: 'Zorlanmış akış (+y)', min: 0, max: 60, step: 0.5, unit: 'cm/s', digits: 3, effect: 'live', help: 'Kabin havalandırması ya da deney kanalı akışı; alttan girer.' },
          { key: 'wind', type: 'range', label: 'Rüzgâr hızı', min: 0, max: 100, step: 0.5, unit: 'cm/s', digits: 3, effect: 'live', help: 'Yatay hava akımı: alan kenarlarından rüzgâr yönünde girer. Alev rüzgâr altına yatar; güçlü rüzgâr alevi tabandan koparıp söndürebilir (üfleme sınırı).' },
          { key: 'windDir', type: 'range', label: 'Rüzgâr yönü', min: 0, max: 355, step: 5, unit: '°', digits: 3, effect: 'live', help: 'Rüzgârın estiği yön, yukarıdan bakışta: 0° = +x (ekranda sağa), 90° = +z (kameraya doğru), 180° = −x, 270° = −z.' },
          { key: 'draft', type: 'range', label: 'Oda hava akımı', min: 0, max: 5, step: 0.05, unit: 'cm/s', digits: 2, effect: 'live', adv: true, help: 'Küçük, rastgele bir bozuntu. Yerçekiminde alevin doğal titreşimini tetikler.' },
          { key: 'gJitter', type: 'range', label: 'g-sarsıntısı', min: 0, max: 100, step: 1, unit: 'µg', digits: 2, effect: 'live', adv: true, help: 'ISS titreşim ortamının basit modeli (1,7–4,3 Hz bileşenler).' },
        ],
      },
      {
        id: 'phys', title: 'Fizik modelleri', open: false,
        items: [
          { key: 'radiation', type: 'toggle', label: 'Işınımla ısı transferi', effect: 'live' },
          { key: 'radModel', type: 'seg', label: 'Işınım modeli', effect: 'live', when: (s) => s.radiation, options: () => [{ value: 'rt', label: 'Işınım alanı' }, { value: 'thin', label: 'Optik ince' }], help: 'Işınım alanı: alevin her hacim öğesinin yaydığı ışınım 1/(4πr²) ile seyrelerek toplanır (optik ince ortamda ışınım aktarım denkleminin tam çözümü). Gaz bu ışınımın bir kısmını yeniden soğurur; duvarlara, tavana ve masaya gelen ışınım ısı akısı hesaplanır. Optik ince: yalnız yayınım kaybı, alan hesaplanmaz.' },
          { key: 'soot', type: 'toggle', label: 'Kurum modeli', effect: 'live' },
          { key: 'coolFlame', type: 'toggle', label: 'Soğuk alev kimyası', effect: 'live', help: 'Yalnız n-heptan için: 600–800 K aralığında NTC davranışlı ikinci tepkime yolu. Soğuk alev ışığı uyarılmış formaldehitten (CH₂O*) gelir: CH₃O• + •OH → CH₂O* + H₂O. Tayfı birkaç banttır, mor ve mavi bantlar baskındır.' },
          { key: 'ozone', type: 'range', label: 'Ozon katkısı (O₃)', min: 0, max: 5, step: 0.1, unit: '%', digits: 2, effect: 'live', when: (s) => s.coolFlame, help: 'Oksitleyiciye eklenen ozon O₃ → O₂ + O ile oksijen atomu verir; düşük sıcaklık zincirini başlatarak soğuk alevi hızlandırır ve kararlı soğuk difüzyon alevleri oluşturmaya yardım eder. Ana oksitleyici yine O₂’dir. Not: ozon yüksek derişimde kararsızdır ve patlayıcı biçimde ayrışabilir; deneylerde yalnız birkaç yüzde kullanılır.' },
          { key: 'lewis', type: 'toggle', label: 'Tercihli difüzyon (Le ≠ 1)', effect: 'live' },
          { key: 'expansion', type: 'toggle', label: 'Isıl genleşme (∇·u = S)', effect: 'live', help: 'Kapatılırsa akış sıkıştırılamaz kabul edilir; alev genişlemesi kaybolur.' },
          { key: 'kinScale', type: 'range', label: 'Kinetik ön çarpanı A', min: 0.05, max: 5, step: 0.05, log: true, pre: '×', digits: 2, effect: 'live', help: 'Westbrook–Dryer A katsayısının çarpanı. Küçük değerler sönmeyi kolaylaştırır.' },
          { key: 'ignT', type: 'range', label: 'Tutuşturucu sıcaklığı', min: 1000, max: 2600, step: 10, unit: 'K', digits: 4, effect: 'live' },
          { key: 'sootMult', type: 'range', label: 'Kurum oluşumu', min: 0, max: 4, step: 0.05, pre: '×', digits: 2, effect: 'live', when: (s) => s.soot, adv: true },
          { key: 'sootOx', type: 'range', label: 'Kurum oksidasyonu', min: 0, max: 4, step: 0.05, pre: '×', digits: 2, effect: 'live', when: (s) => s.soot, adv: true },
          { key: 'gasRadMult', type: 'range', label: 'Gaz (CO₂/H₂O) ışınımı', min: 0, max: 4, step: 0.05, pre: '×', digits: 2, effect: 'live', when: (s) => s.radiation, adv: true },
          { key: 'sootRadMult', type: 'range', label: 'Kurum ışınımı', min: 0, max: 4, step: 0.05, pre: '×', digits: 2, effect: 'live', when: (s) => s.radiation, adv: true },
          { key: 'vorticity', type: 'range', label: 'Vortisite hapsetme ε', min: 0, max: 2, step: 0.01, digits: 2, effect: 'live', adv: true, help: 'Sayısal sönümle kaybolan küçük girdapları geri kazandırır (sayısal bir düzeltme).' },
        ],
      },
    ],
  },
  {
    id: 'view', title: 'Görüntü',
    sections: [
      {
        id: 'mode', title: 'Görünüm',
        items: [
          { key: 'view', type: 'list', label: 'Görünüm modu', effect: 'live', options: () => FL.VIEW_MODES.map((m, i) => ({ value: m.id, label: m.name, desc: m.desc, kbd: m.kbd || String(i + 1) })) },
          { key: 'schMode', type: 'seg', label: 'Schlieren tipi', effect: 'live', when: isView('schlieren'), options: () => [{ value: 'gray', label: 'Bıçak kenarı' }, { value: 'color', label: 'Renkli' }] },
          { key: 'schGain', type: 'range', label: 'Schlieren duyarlılığı', min: 0.1, max: 10, step: 0.05, log: true, pre: '×', digits: 2, effect: 'live', when: isView('schlieren') },
          { key: 'falseTmax', type: 'range', label: 'Ölçek üst sınırı', min: 600, max: 3200, step: 10, unit: 'K', digits: 4, effect: 'live', when: isView('temp', 'ir') },
          { key: 'falseHRR', type: 'range', label: 'HRR ölçeği', min: 5, max: 3000, step: 5, log: true, unit: 'MW/m³', digits: 3, effect: 'live', when: isView('hrr') },
          { key: 'falseSoot', type: 'range', label: 'Kurum ölçeği', min: 0.05, max: 20, step: 0.05, log: true, unit: 'ppm', digits: 2, effect: 'live', when: isView('soot') },
          { key: 'falseU', type: 'range', label: 'Hız ölçeği', min: 1, max: 300, step: 1, log: true, unit: 'cm/s', digits: 3, effect: 'live', when: isView('vel') },
          { key: 'falseRad', type: 'range', label: 'Işınım akısı ölçeği', min: 0.2, max: 100, step: 0.1, log: true, unit: 'kW/m²', digits: 3, effect: 'live', when: isView('rad'), help: 'Hacimde G − G∞ (gelen ışınımın oda ışınımı üstündeki kısmı), tabanda masaya gelen ışınım ısı akısı. Oda ışınımı 4σT∞⁴ ≈ 1,7 kW/m² çıkarılmıştır.' },
          { key: 'falseYf', type: 'range', label: 'Yakıt kesri ölçeği', min: 0.02, max: 1, step: 0.01, digits: 2, effect: 'live', when: isView('species') },
        ],
      },
      {
        id: 'camera', title: 'Fiziksel kamera',
        items: [
          { key: 'camPhys', type: 'toggle', label: 'Fiziksel kamera', effect: 'live', help: 'Görüntüyü gerçek bir kameranın çekeceği gibi üretir (Blender kamerası gibi): odak uzaklığı ve sensör görüş açısını, diyafram alan derinliğini, obtüratör hareket bulanıklığını, ISO gürültüyü belirler; parlak bölgeler doyar. Kamera yalnız görünür ışığı görür, ölçüm yardımcıları gizlenir. Yapay zekâ eğitim verisi için tasarlandı.' },
          { key: 'camLook', type: 'toggle', label: 'Kameradan bak (0)', effect: 'live', when: (s) => s.camPhys, help: 'Açık: görüntü sahne kamerasından, tüm kamera etkileriyle. Sürükle = kamerayı döndür, Shift/sağ sürükle = kaydır, tekerlek = ileri/geri, Ctrl + tekerlek = odak uzaklığı (optik yakınlaştırma). Kapalı: editör görünümü; kamera nesnesi sahnede görünür, okları (taşı) ve halkaları (döndür) sürükleyerek yerleştirilir.' },
          { key: 'camGizmo', type: 'seg', label: 'Kamera aracı', effect: 'live', when: (s) => s.camPhys && !s.camLook, options: () => [{ value: 'move', label: 'Taşı (W)' }, { value: 'rotate', label: 'Döndür (E)' }, { value: 'zoom', label: 'Ölçekle (Q)' }],
            help: 'Taşı: renkli oklar eksen boyunca, beyaz merkez noktası serbest taşır. Döndür: halkalar sapma/yunuslama/yuvarlanma. Ölçekle: köşe küpleri görüş açısını (odak uzaklığı) büyütür/küçültür, sarı ok kamerayı ileri/geri götürür.' },
          {
            key: '_camAlign', type: 'buttons', label: '', when: (s) => s.camPhys,
            buttons: [
              { label: 'Görünüme hizala', action: 'camAlignView', tip: 'Kamerayı şu anki editör görüşünün yerine ve yönüne koyar (Blender: Ctrl+Alt+Numpad 0)' },
              { label: 'Aleve çevir', action: 'camAimFlame', tip: 'Kamerayı yerinde döndürerek alevin ışık merkezine çevirir' },
            ],
          },
          { key: 'camX', type: 'range', label: 'Konum X', min: -0.5, max: 1, step: 0.001, unit: 'cm', digits: 3, effect: 'live', when: (s) => s.camPhys, adv: true, fmt: (v) => fmt(v * 100, 3), parse: (v) => v / 100 },
          { key: 'camY', type: 'range', label: 'Konum Y', min: -0.5, max: 1, step: 0.001, unit: 'cm', digits: 3, effect: 'live', when: (s) => s.camPhys, adv: true, fmt: (v) => fmt(v * 100, 3), parse: (v) => v / 100 },
          { key: 'camZ', type: 'range', label: 'Konum Z', min: -0.5, max: 1, step: 0.001, unit: 'cm', digits: 3, effect: 'live', when: (s) => s.camPhys, adv: true, fmt: (v) => fmt(v * 100, 3), parse: (v) => v / 100 },
          { key: 'camYaw', type: 'range', label: 'Sapma (yaw)', min: -180, max: 180, step: 0.5, unit: '°', digits: 3, effect: 'live', when: (s) => s.camPhys, adv: true },
          { key: 'camPitch', type: 'range', label: 'Yunuslama (pitch)', min: -89, max: 89, step: 0.5, unit: '°', digits: 3, effect: 'live', when: (s) => s.camPhys, adv: true },
          { key: 'camRoll', type: 'range', label: 'Yuvarlanma (roll)', min: -180, max: 180, step: 0.5, unit: '°', digits: 3, effect: 'live', when: (s) => s.camPhys, adv: true },
          { key: 'camSensor', type: 'select', label: 'Sensör', effect: 'live', when: (s) => s.camPhys, options: () => Object.entries(FL.SENSORS).map(([k, v]) => ({ value: k, label: v.name })) },
          { key: 'camFocal', type: 'range', label: 'Odak uzaklığı', min: 8, max: 300, step: 1, log: true, unit: 'mm', digits: 3, effect: 'live', when: (s) => s.camPhys },
          { key: 'camFstop', type: 'range', label: 'Diyafram', min: 1.2, max: 22, step: 0.1, log: true, pre: 'f/', digits: 2, effect: 'live', when: (s) => s.camPhys, help: 'Açıklık çapı = odak uzaklığı / N. Küçük N: daha çok ışık, daha sığ alan derinliği.' },
          { key: 'camAE', type: 'seg', label: 'Pozlama', effect: 'live', when: (s) => s.camPhys, options: () => [{ value: 'A', label: 'Diyafram öncelikli' }, { value: 'M', label: 'Manuel' }] },
          { key: 'camShutter', type: 'range', label: 'Obtüratör', min: 1 / 8000, max: 1, step: 0.00001, log: true, unit: 's', effect: 'live', when: (s) => s.camPhys && s.camAE === 'M', fmt: (v) => (v >= 0.3 ? fmt(v, 2) : '1/' + Math.round(1 / v)), parse: (v) => (v > 1 ? 1 / v : v), help: 'Pozlama süresi. Alev 10–15 Hz titrer: 1/30 s titreşimi bulandırır, 1/2000 s dondurur. Kutuya 250 yazmak 1/250 s demektir.' },
          { key: 'camEV', type: 'range', label: 'Pozlama telafisi', min: -4, max: 4, step: 0.1, unit: 'EV', digits: 2, effect: 'live', when: (s) => s.camPhys && s.camAE === 'A', fmt: (v) => (v > 0 ? '+' : '') + fmt(v, 2), help: 'Otomatik pozlama alevin en parlak bölgesini doymanın %85’ine getirir. +1 EV iki kat daha uzun pozlar (çekirdek doyar, mavi taban belirginleşir).' },
          { key: 'camISO', type: 'range', label: 'ISO', min: 50, max: 25600, step: 1, log: true, digits: 4, effect: 'live', when: (s) => s.camPhys, help: 'Sensör kazancı. Yüksek ISO daha parlak ama daha gürültülü görüntü verir (foton ve okuma gürültüsü).' },
          { key: 'camFocus', type: 'range', label: 'Odak mesafesi', min: 0, max: 100, step: 0.5, unit: 'cm', digits: 3, effect: 'live', when: (s) => s.camPhys, fmt: (v) => (v <= 0 ? 'oto' : fmt(v, 3)), help: '0 = otomatik: alevin ışık merkezine odaklanır.' },
          { key: 'camWB', type: 'range', label: 'Beyaz dengesi', min: 1500, max: 10000, step: 50, unit: 'K', digits: 4, effect: 'live', when: (s) => s.camPhys, help: 'Bu renk sıcaklığındaki ışık nötr görünür. Gün ışığı (5500 K) ayarında mum alevi turuncu, 1900 K ayarında beyaza yakın çıkar.' },
          { key: 'camView', type: 'seg', label: 'Görünüm dönüşümü', effect: 'live', when: (s) => s.camPhys, options: () => [{ value: 'standard', label: 'Standart (sRGB)' }, { value: 'agx', label: 'AgX' }], help: 'Standart: doğrusal sensör değeri doğrudan sRGB, doyan bölge kırpılır (çoğu kameranın JPEG çıktısı gibi). AgX: Blender’ın film benzeri eğrisi, doyma yumuşak.' },
          { key: 'camNoise', type: 'toggle', label: 'Sensör gürültüsü', effect: 'live', when: (s) => s.camPhys },
          { key: 'camVig', type: 'toggle', label: 'Doğal vinyet (cos⁴θ)', effect: 'live', when: (s) => s.camPhys },
          { key: 'camGlare', type: 'range', label: 'Mercek içi saçılma', min: 0, max: 0.3, step: 0.005, digits: 2, effect: 'live', when: (s) => s.camPhys, adv: true },
          { key: 'camHelpers', type: 'toggle', label: 'Yardımcı çizimler', effect: 'live', when: (s) => s.camPhys, help: 'Alan kutusu, ölçek çubuğu, ölçüler. Kamera görüntüsüne karışmaz (veri kümesine yazılmaz).' },
        ],
      },
      {
        id: 'exposure', title: 'Pozlama ve ışıma', when: (s) => s.view === 'real' && !s.camPhys,
        items: [
          { key: 'autoExposure', type: 'toggle', label: 'Otomatik pozlama', effect: 'live' },
          { key: 'exposure', type: 'range', label: 'Pozlama telafisi', min: -6, max: 10, step: 0.1, unit: 'EV', digits: 2, effect: 'live', fmt: (v) => (v > 0 ? '+' : '') + fmt(v, 2) },
          { key: 'tonemap', type: 'seg', label: 'Ton eşleme', effect: 'live', options: () => [{ value: 'agx', label: 'AgX' }, { value: 'aces', label: 'ACES' }, { value: 'neutral', label: 'Nötr' }], help: 'AgX parlak alev çekirdeğini ton kaymadan beyaza yumuşatır. ACES daha kontrastlı, Nötr renkleri en az değiştirir.' },
          { key: 'chemGain', type: 'range', label: 'Kemilüminesans (CH*, C₂*)', min: 0, max: 30, step: 0.1, pre: '×', digits: 2, effect: 'live', help: '1 fiziksel değerdir. Mavi bölgeyi incelemek için artırın.' },
          { key: 'sootGain', type: 'range', label: 'Kurum ışıması', min: 0, max: 4, step: 0.05, pre: '×', digits: 2, effect: 'live' },
          { key: 'coolGain', type: 'range', label: 'Soğuk alev (HCHO*)', min: 0, max: 2000, step: 10, pre: '×', digits: 3, effect: 'live', adv: true, help: 'Gerçekte çıplak gözle görülmez; yoğunlaştırılmış kamera eşdeğeri.' },
          { key: 'bloom', type: 'range', label: 'Mercek parlaması', min: 0, max: 2, step: 0.01, digits: 2, effect: 'live' },
        ],
      },
      {
        id: 'slice', title: 'Kesit düzlemi',
        items: [
          { key: 'slice', type: 'toggle', label: 'Kesit düzlemini göster', effect: 'live' },
          {
            key: 'sliceField', type: 'select', label: 'Alan', effect: 'live', when: (s) => s.slice,
            options: () => [
              { value: 'T', label: 'Sıcaklık T' }, { value: 'hrr', label: 'Isı salınım hızı' },
              { value: 'soot', label: 'Kurum f_v' }, { value: 'vel', label: 'Hız |u|' },
              { value: 'fuel', label: 'Yakıt Y_F' }, { value: 'o2', label: 'Oksijen Y_O₂' },
              { value: 'div', label: 'Genleşme kaynağı S' }, { value: 'prod', label: 'Ürünler Y_P' },
            ],
          },
          { key: 'sliceAxis', type: 'seg', label: 'Eksen', effect: 'live', when: (s) => s.slice, options: () => [{ value: 'x', label: 'x' }, { value: 'y', label: 'y' }, { value: 'z', label: 'z' }] },
          { key: 'slicePos', type: 'range', label: 'Konum', min: 0, max: 1, step: 0.005, unit: '%', digits: 3, effect: 'live', when: (s) => s.slice, fmt: (v) => fmt(v * 100, 3), parse: (v) => v / 100 },
        ],
      },
      {
        id: 'scene', title: 'Sahne',
        items: [
          {
            key: 'ambientLight', type: 'seg', label: 'Oda ışığı', effect: 'live',
            options: () => [{ value: 0.6, label: 'Karanlık' }, { value: 4, label: 'Loş' }, { value: 20, label: 'Aydınlık' }],
            match: (v, o) => Math.abs(v - o) < 1e-6,
          },
          { key: 'roomLight', type: 'range', label: 'Tavan lambası', min: 0, max: 1500, step: 10, unit: 'lx', digits: 4, effect: 'live', fmt: (v) => (v > 0 ? fmt(v, 4) : 'kapalı'),
            help: 'Sahnenin üstünde boyutlu bir LED lamba (≈4000 K). Değer, lambanın döşemede verdiği aydınlıktır: ofis ≈ 300–500 lx, uzay aracı kabini ≈ 100–500 lx. Model ve masa gölgesini bu ışık da düşürür. Kabin modelinde lamba orta güverte tavan aydınlatmasının yerindedir. Mumun yanında: 1 cd’lik alev 10 cm’de yalnız ≈ 100 lx verir.' },
          { key: 'ambientLight', id: 'ambientLightFine', type: 'range', label: 'Ortam aydınlığı', min: 0, max: 40, step: 0.1, unit: 'cd/m²', digits: 2, effect: 'live', adv: true },
          {
            key: 'backdrop', type: 'seg', label: 'Arka plan (B)', effect: 'live',
            options: () => [{ value: 'auto', label: 'Otomatik' }, { value: 'lab', label: 'Deney odası' }, { value: 'orbit', label: 'Yörünge' }],
            help: 'Yörünge: uzaydan Dünya’ya bakış (kıtalar, bulutlar, gündüz/gece sınırı, atmosfer halesi) ve yıldızlar; kabin camlarından da görünür. Otomatik: kabin modelinde ve mikrogravitede yörünge, diğer konumlarda deney odası. Yörüngede masa çizilmez. Yer gerçeği maskesinde arka plan her zaman siyahtır.',
          },
          { key: 'earthLum', type: 'range', label: 'Dünya parlaklığı', min: 0, max: 3000, step: 10, unit: 'cd/m²', digits: 4, effect: 'live', when: (s) => s.backdrop !== 'lab', adv: true,
            help: 'Güneş alan Dünya’nın gerçek ışıklılığı ≈ 5–10 bin cd/m²’dir: 1 g mum aleviyle aynı mertebe, mikrogravitenin sönük mavi alevinden yüz kat parlak. Varsayılan değer alev görünsün diye kısılmıştır (koyu cam filtre gibi).' },
          { key: 'sunLight', type: 'range', label: 'Güneş ışığı', min: 0, max: 5000, step: 50, unit: 'lx', digits: 4, effect: 'live', when: (s) => s.backdrop !== 'lab', adv: true, fmt: (v) => (v > 0 ? fmt(v, 4) : 'kapalı'),
            help: 'Yörünge arka planında model yüzeylerine gelen paralel güneş ışığı (modelin kendi gölgesiyle). Gerçek değer ≈ 130 bin lx’tir; kabin içi aydınlatmayla birlikte pozlanabilsin diye kısılmıştır.' },
          { key: 'floor', type: 'toggle', label: 'Masa yüzeyi', effect: 'live' },
          { key: 'floorGrid', type: 'toggle', label: '1 cm ızgara', effect: 'live', when: (s) => s.floor },
          { key: 'shadows', type: 'toggle', label: 'Yumuşak gölge ve temas gölgesi', effect: 'live' },
          { key: 'autoRotate', type: 'toggle', label: 'Otomatik dönüş', effect: 'live' },
          { key: 'fov', type: 'range', label: 'Görüş açısı', min: 15, max: 75, step: 1, unit: '°', digits: 2, effect: 'live', adv: true },
          { key: 'vignette', type: 'range', label: 'Vinyet', min: 0, max: 1, step: 0.01, digits: 2, effect: 'live', adv: true },
        ],
      },
      {
        id: 'quality', title: 'Kalite',
        items: [
          { key: 'taa', type: 'toggle', label: 'Zamansal yumuşatma (TAA)', effect: 'live', help: 'Alt piksel kaydırmalı kareleri yeniden izdüşümle birleştirir: kenarlar yumuşar, ışın yürütme gürültüsü kaybolur.' },
          { key: 'adaptive', type: 'toggle', label: 'Kare hızı yöneticisi', effect: 'live', help: 'Kare hızı hedefin altına düşerse yükü en az görünen yerden geri verir: önce kare başına çözücü alt adımı (benzetim ağır çekime geçer, sonuç değişmez), sonra görüntü çözünürlüğü, ışın adımı ve efekt parçacığı yoğunluğu. Toparlanınca yavaşça geri açar. Seviye, Çözücü › Durum’da görünür.' },
          { key: 'realTime', type: 'toggle', label: 'Gerçek zaman öncelikli', effect: 'live', help: 'Açıkken benzetim gerçek hızında akmaya çalışır: yük artınca kare hızı düşer, alev ağır çekime geçmez; görüntü kalitesi ancak 30 fps altında kısılır. Kapalıyken öncelik kare hızındadır: yönetici alt adımları kısar ve benzetim yavaşlar. Gaz jeti küçük zaman adımı gerektirdiği için her durumda gerçek zamanın altında kalır.' },
          {
            key: 'targetFps', type: 'seg', label: 'Kare hızı hedefi', effect: 'live', when: (s) => s.adaptive && !s.realTime,
            options: () => [{ value: 30, label: '30' }, { value: 60, label: '60' }, { value: 120, label: '120' }, { value: 0, label: 'Ekran' }],
            help: 'Yöneticinin altına düşülmesine izin vermediği kare hızı. Çizim sınırlanmaz: ekran daha hızlıysa (120–240 Hz) aradaki kareler yalnız görüntüdür ve ekranın hızında akar; akış çözücüsü saniyede en çok 60 adım atar. “Ekran”: hedef ekranın tazeleme hızıdır (benzetim daha çok yavaşlayabilir).',
          },
          { key: 'renderScale', type: 'range', label: 'Görüntü çözünürlüğü', min: 0.3, max: 1.5, step: 0.05, unit: '%', digits: 3, effect: 'live', fmt: (v) => fmt(v * 100, 3), parse: (v) => v / 100 },
          { key: 'stepCells', type: 'range', label: 'Işın adımı', min: 0.3, max: 2, step: 0.05, unit: 'hücre', digits: 2, effect: 'live', adv: true, help: 'Küçük adım daha keskin, daha yavaş.' },
        ],
      },
    ],
  },
  {
    id: 'analysis', title: 'Analiz',
    sections: [
      { id: 'theory', title: 'Kuram ve ölçüm', custom: 'kv', kv: 'theoryKV' },
      { id: 'data', title: 'Veri', custom: 'data' },
      {
        id: 'dataset', title: 'Yapay zekâ veri kümesi', custom: 'dataset',
        items: [
          { key: 'dsFrames', type: 'range', label: 'Kare sayısı', min: 1, max: 600, step: 1, digits: 3, effect: 'live' },
          { key: 'dsInterval', type: 'range', label: 'Kare aralığı', min: 0.005, max: 1, step: 0.005, log: true, unit: 's', digits: 2, effect: 'live', help: 'İki kare arasında geçen benzetim zamanı.' },
          { key: 'dsWidth', type: 'range', label: 'Görüntü genişliği', min: 128, max: 2048, step: 16, unit: 'px', digits: 4, effect: 'live', help: 'Yükseklik sensör en-boy oranından gelir.' },
          { key: 'dsJitter', type: 'range', label: 'Kamera yön sapması', min: 0, max: 30, step: 0.5, unit: '°', digits: 2, effect: 'live', help: 'Her karede kamera yönü bu kadar rastgele döner (çeşitlilik için). 0 = sabit kamera.' },
          { key: 'dsMask', type: 'toggle', label: 'Tepkime bölgesi maskesi', effect: 'live', help: 'Her kareyle birlikte alevin tepkime bölgesinin (HRR) aynı kameradan ikili maskesi: bölütleme modelleri için yer gerçeği.' },
        ],
      },
      { id: 'notes', title: 'Model ve varsayımlar', custom: 'notes', open: false },
      { id: 'refs', title: 'Kaynaklar ve standartlar', custom: 'notes', html: () => FL.REFERENCES },
    ],
  },
  {
    id: 'solver', title: 'Çözücü',
    sections: [
      {
        id: 'grid', title: 'Izgara',
        items: [
          { key: 'resolution', type: 'select', label: 'Çözünürlük (x)', effect: 'rebuild', num: true, options: () => [32, 40, 48, 56, 64, 72, 80, 96].map((n) => ({ value: n, label: n + ' hücre' })) },
          { key: 'domain', type: 'range', label: 'Alan genişliği', min: 2, max: 14, step: 0.1, unit: 'cm', digits: 3, effect: 'rebuild' },
          { key: 'aspect', type: 'range', label: 'Yükseklik / genişlik', min: 0.5, max: 4, step: 0.05, digits: 3, effect: 'rebuild' },
          { key: 'depth', type: 'range', label: 'Alan derinliği (Z)', min: 0, max: 14, step: 0.1, unit: 'cm', digits: 3, effect: 'rebuild', help: '0 = genişliğe eşit. Araç çubuğundaki X·Y·Z kutularıyla da ayarlanır.' },
        ],
      },
      {
        id: 'time', title: 'Zaman adımı',
        items: [
          { key: 'timeScale', type: 'range', label: 'Zaman ölçeği', min: 0.05, max: 4, step: 0.05, log: true, pre: '×', digits: 2, effect: 'live' },
          { key: 'maxSub', type: 'range', label: 'Kare başına alt adım', min: 1, max: 16, step: 1, digits: 2, effect: 'live' },
          { key: 'cfl', type: 'range', label: 'CFL sayısı', min: 0.3, max: 4, step: 0.05, digits: 2, effect: 'live', help: 'Zaman adımı Δt = CFL·Δx / u_maks. Büyük değer benzetimi hızlandırır (varsayılan 3 ile mum, damla ve levha gerçek zamanda akar); küçük değer daha temkinlidir. Gaz jeti en çok 1,6 ile yürür: daha büyük adımda alev üflenir.' },
          { key: 'diffA', type: 'range', label: 'Difüzyon sayısı sınırı', min: 0.3, max: 4.5, step: 0.05, log: true, digits: 2, effect: 'live', help: 'a = D·Δt/Δx² için üst sınır. Difüzyon korunumlu açık alt adımlarla çözülür; alt adım sayısı ≈ 7·a. Küçük değer daha kısa zaman adımı demektir.' },
          { key: 'dtMax', type: 'range', label: 'En büyük Δt', min: 0.2, max: 16, step: 0.1, log: true, unit: 'ms', digits: 2, effect: 'live' },
        ],
      },
      {
        id: 'iter', title: 'Yinelemeler',
        items: [
          { key: 'pressureIters', type: 'range', label: 'Basınç SOR', min: 2, max: 80, step: 1, digits: 2, effect: 'live' },
          { key: 'sor', type: 'range', label: 'SOR gevşetme ω', min: 1, max: 1.9, step: 0.01, digits: 3, effect: 'live' },
          { key: 'viscIters', type: 'range', label: 'Viskozite', min: 1, max: 16, step: 1, digits: 2, effect: 'live' },
          { key: 'maccormack', type: 'toggle', label: 'MacCormack adveksiyonu', effect: 'live' },
          { key: 'diffScale', type: 'range', label: 'Taşınım katsayıları', min: 0.2, max: 4, step: 0.05, pre: '×', digits: 2, effect: 'live' },
          { key: 'hrrThr', type: 'range', label: 'Alev bölgesi eşiği', min: 0.1, max: 50, step: 0.1, log: true, unit: 'MW/m³', digits: 2, effect: 'live' },
        ],
      },
      { id: 'info', title: 'Durum', custom: 'kv', kv: 'solverInfo' },
      { id: 'perf', title: 'GPU profili (D)', custom: 'kv', kv: 'perfInfo', open: false },
    ],
  },
];

/* ------------------------------------------------------------------ */
/* Model notları                                                        */
/* ------------------------------------------------------------------ */
FL.MODEL_NOTES = `
<p>Bu simülatör, gerçek zamanlı çalışabilmek için fiziksel olarak tutarlı fakat sadeleştirilmiş modeller kullanır. Sonuçlar nitel ve yarı nicel karşılaştırma içindir; sayısal değerler deney verisiyle kalibre edilmelidir.</p>
<h4>Akış</h4>
<ul>
<li>Düşük Mach sayılı, değişken yoğunluklu Navier–Stokes. Yüzdürme terimi Boussinesq değil, tam yoğunluk oranıyla: <code>(1 − ρ∞/ρ)·g</code>.</li>
<li>Isıl genleşme ve mol sayısı değişimi, basınç izdüşümünde <code>∇·u = −(1/ρ)·Dρ/Dt</code> kaynağı olarak yer alır (tepkime, difüzyon ve sayısal karışım katkıları ayrı ayrı hesaplanır).</li>
<li>Skaler adveksiyon korunan değişkenlerle yapılır: <code>ρ, ρT, ρY</code> taşınır, sonra <code>T, Y</code> bulunur. Böylece sıcak ürünle soğuk havanın karışımı enerji ve kütle bakımından doğrudur; yakıt yoktan var olmaz. RK2 geri izlemeli MacCormack, min–maks sınırlayıcı. Basınç: kırmızı-siyah SOR.</li>
<li>Isı ve tür difüzyonu açık, akı biçiminde (korunumlu) ve alt adımlıdır: hücreler arası akı simetrik olduğundan toplam enerji ve tür kütlesi korunur. λ(T), cp(T), ρ(T, W) yerel olarak hesaplanır, D ∝ 1/P, tür başına Lewis sayısı.</li>
<li>Katı yüzeyler (fitil, nozul, damla, levha) için hayalet hücre değerleri kullanılır: enterpolasyon katının içine sıfır yakıt görmez, yüzeyde yapay yakıt kaybı olmaz. Nozul girişi sabit kütle akılıdır.</li>
<li>Açık sınırlar akış yönüne duyarlıdır: giren akışta ortam koşulu, çıkan akışta sıfır gradyan. Zemin geçirimsizdir. Yan kenarlarda ince bir sönümleme (sünger) katmanı, alanın sakin bir odanın parçası olduğunu temsil eder: söndürücü jetinin bıraktığı yatay akım birkaç yüz milisaniyede söner.</li>
<li>Rüzgâr: yatay oda havası akımı; yan sınırlardaki sönümleme katmanı hızı rüzgâr vektörüne gevşetir, böylece rüzgâr bir yüzden girip karşı yüzden çıkar.</li>
</ul>
<h4>Söndürme</h4>
<ul>
<li><b>Söndür</b> (üfleme): alevin üzerine hızlı inert gaz jeti; alev akımla tabandan koparılır, kıvılcım ve yakıt beslemesi kesilir.</li>
<li><b>CO₂ tüpü</b> (boğma): alevin ve kaynağın çevresi inert gaz bulutuyla dolar, O₂ seyreltici gazla yer değiştirir ve gaz bir miktar soğur. Yakıt beslemesi sürer; alev oksijensiz kaldığı için söner. Yer değiştirme modeli seyreltici türün kendisini ayrıca taşımaz.</li>
</ul>
<h4>Kimya</h4>
<ul>
<li>Tutuşturucu, ısıl zaman sabiti ~4 ms olan sonlu güçlü bir ısıtıcıdır (anlık sıcaklık dayatması küçük adımlarda sayısal patlamaya yol açar).</li>
<li>Isı salınımında sıcaklık, entalpi dengesi ∫c_p(T)dT = q ile bulunur (c_p sıcaklıkla ve ayrışmayla artar); böylece hiçbir hücre adyabatik alev sıcaklığını aşmaz.</li>
<li>Tek adımlı global kinetik (Westbrook &amp; Dryer, 1981). H₂ için yaklaşık global ifade. Hız, adım içinde analitik olarak sınırlandırılır.</li>
<li>Yüksek sıcaklık ayrışması, etkin ısı kapasitesi artışı ile yaklaşıklanır; adyabatik sıcaklık ±100 K mertebesinde doğrudur.</li>
<li>n-Heptan soğuk alevi: NTC (negatif sıcaklık katsayısı) ağırlıklı ikinci tepkime, ~%14 ısı salınımı. Nitel modeldir.</li>
<li>Soğuk alev ışığı uyarılmış formaldehitten (CH₂O*) gelir: <code>CH₃O• + •OH → CH₂O* + H₂O</code>, <code>CH₃O• + CHₙO• → CH₂O* + CHₙOH</code>. Tayf, 370–490 nm arasındaki Emeléus bantlarından oluşur; mor ve mavi bantlar (≈395–435 nm) baskındır. Görüntüde bu bantların CIE rengi kullanılır.</li>
<li>Ozon (O₃) katkısı: O₃ → O₂ + O ile oluşan oksijen atomları düşük sıcaklık zincirini başlatır; soğuk alev hız sabiti 1 + 2,5·(%O₃) ile çarpılır (nitel). Ana oksitleyici O₂’dir.</li>
<li>Izgara (≈0,5–2 mm) gerçek tepkime bölgesinden (0,1–0,5 mm) kalındır. Ön üstel katsayı, hücre boyuna ve yakıta bağlı bir verim katsayısı ile ölçeklenir (Çözücü › Durum). Alev tabanının tutunması ve sönme sınırları ızgaraya duyarlıdır.</li>
</ul>
<h4>Kurum ve ışınım</h4>
<ul>
<li>Kurum: sıcaklığa bağlı çekirdeklenme ve yüzey büyümesi; oksidasyon O₂ ile (Nagle–Strickland-Constable) ve alev ucundaki OH ile (Neoh tipi, ∝ √X_O₂·e^(−E/T)). Kurum alev ucunda yanıp biter; soğuyan ya da oksijensiz alevde kaçar (isli alev). Yakıta göre eğilim katsayısı.</li>
<li>Işınımla ısı transferi: alevin her hacim öğesi <code>P = 4σκ(T⁴ − T∞⁴)dV</code> güç yayar. Laboratuvar ölçeğindeki alevler optik incedir (κL ≪ 1); ışınım yolda soğurulmaz ve gelen ışınım <code>G(x) = 4σT∞⁴ + Σ P/(4πr²)</code> olur (ışınım aktarım denkleminin optik ince sınırdaki tam çözümü). Kaynaklar 4×4×4 hücrelik bloklarda toplanır. Gaz bu ışınımın bir kısmını yeniden soğurur: <code>q_r = κ(G − 4σT⁴)</code>. Alan sınırlarına gelen akı <code>q_w = Σ P cos θ/(4πr²)</code>; duvar, tavan ve masadaki en büyük değer ölçülür, sınırlara ulaşan toplam güç yayılan güce eşittir (enerji denetimi). P1 gibi difüzyon yaklaşımları bu ince ortamda ışınımı yanlış dağıtır; bu yüzden kullanılmadı.</li>
<li>κ: Planck ortalaması; <code>κ_kurum = 1862·f_v·T</code>, CO₂/H₂O için basınç ve mol kesriyle ölçeklenen gri gaz yaklaşıklığı. Saçılma ihmal edilir. Optik ince seçenekte G = 4σT∞⁴ alınır: <code>q = 4σκ(T⁴ − T∞⁴)</code>.</li>
<li>Levha yüzeyine alevden gelen ışınım, ızgaranın çözemediği yakın alev bölgesi için ayrıca kalibre edilmiş gri-gaz geri beslemesiyle verilir (Saffire yayılma hızına göre).</li>
<li>Görüntü: kurum için Rayleigh rejimi <code>κ_λ = 4,9·f_v/λ</code>, Planck yasası ve CIE 1931 renk eşleme fonksiyonları ile spektral entegrasyon. Sarı gövde kurumun kara cisim ışımasıdır. CH* ve C₂* yalnız kurumun olmadığı tepkime tabanında, sarıyı bastırmayacak kadar görünür. Kıvılcımın çekirdeği kurum tutmaz; kenarı tutar.</li>
<li>Işıma yarım duyarlıklı hedefe önceden pozlanarak yazılır. Sahneyi aydınlatan ışığın rengi, şiddeti ve konumu, alevin hacim ışımasının <code>I = ∫ j dV</code> integralinden hesaplanır (Durum panelindeki ışık şiddeti, cd). Alev boyutlu bir kaynak olarak yumuşak gölge düşürür.</li>
<li>Schlieren: ışın boyunca <code>∫(ρ/ρ∞ − 1) ds</code> optik yol farkının görüntü düzlemindeki yatay türevi (dikey bıçak kenarı); renkli kipte türev yönü renk tonuyla, büyüklüğü doygunlukla gösterilir.</li>
</ul>
<h4>Kaynaklar</h4>
<ul>
<li>Damla: d²-yasası, Spalding transfer sayısı B, doğal/zorlanmış taşınım için Ranz–Marshall tipi düzeltme. Yüzey buhar kesri Clausius–Clapeyron ile.</li>
<li>Mum: parafin buharı (C₂₅) karanlık çekirdekte kraklanır; tepkime bölgesine yayınan etkin yakıt hafif olduğu için Lewis sayısı 1,2 alınır. 1,6 mg/s buharda alev ~3,5–4 cm boyundadır (Roper korelasyonu ≈2,7 cm reaksiyon boyu; gerçek mum 3–4 cm). Fitil ucundan buharlaşma; hız, fitil ucundaki gaz sıcaklığına (alevden geri gelen ısı) bağlıdır. Taşınımla ısı aktarımı Ranz–Marshall tipi Nusselt sayısıyla ölçeklenir: 0 g'de yalnız iletim kaldığı için mum Dünya'dakinin yaklaşık yarısı hızla yanar.</li>
<li>Katı levha: ısıl olarak ince yakıt; Arrhenius piroliz, iletim, yeniden ışınım ve alev ışınımı ile ısı dengesi. Kumaş, Saffire'da yakılan SIBAL'dir (%75 pamuk, %25 cam elyaf, 18,2 mg/cm²). Yayılma hızı Saffire-I ölçümüyle karşılaştırılır; Saffire ve BASS eş-akış verileri için Olson vd. (2023). Yüzeyden üflenen piroliz gazının ısı akısını azaltması film kuramıyla hesaba katılır. Tutuşturucu, deneydeki gibi ön kenar boyunca gerilmiş sıcak teldir.</li>
</ul>
<h4>Fiziksel kamera ve veri kümesi</h4>
<ul>
<li>İğne deliği + ince mercek (Blender kamerası gibi): görüş açısı <code>2·atan(sensör/(2f))</code>; alan derinliği karışıklık çemberiyle <code>c = (f/N)·f·|d − d_f| / (d·(d_f − f))</code>.</li>
<li>Pozlama ISO 12232 doyma tabanlı hızla: piksel = L/L_sat, <code>L_sat = 78·N²/(0,65·ISO·t)</code> cd/m². Doyan bölge kırpılır (alev çekirdeği gerçek fotoğraflardaki gibi beyaza kaçar).</li>
<li>Obtüratör: pozlama süresi boyunca birikim (alevin 10–15 Hz titreşimi uzun pozlamada bulanır). Gürültü: foton (Poisson) + okuma gürültüsü; doyma elektronu sensör kapasitesi × 100/ISO. Beyaz dengesi: von Kries, kara cisim beyazı. Doğal vinyet cos⁴θ.</li>
<li>Kamera yalnız görünür ışığı görür; ölçüm yardımcıları, yanlış renkli görünümler ve ışınım alanı kamera görüntüsüne girmez. Veri kümesi her kare için görüntü, aynı kameradan tepkime bölgesi maskesi ve benzetimin yer gerçeğini (HRR, T, alev boyu, ışık şiddeti, ışınım akısı, senaryo, kamera iç ve dış parametreleri) içerir.</li>
</ul>
<h4>Kaynakça notu</h4>
<ul>
<li>J. D. Clark, <i>Ignition! An Informal History of Liquid Rocket Propellants</i> (1972), ilk bölümleri ile tutarlılık: tutuşma gecikmesinin sıcaklığa güçlü bağımlılığı (Arrhenius kinetiği), stokiyometriden uzak karışımın ve su/inert seyrelticinin alev sıcaklığını düşürmesi (yakıt seyreltmesi, seyreltici gaz), tutuşmanın Schlieren ile izlenmesi (Schlieren görünümü), sarı kurum ışıması ile mavi-beyaz kimyasal ışıma ayrımı (görüntü modeli), ozonun güçlü ama depolanamayan bir oksitleyici olması (ozon katkısı yalnız birkaç yüzde, soğuk alev için).</li>
</ul>
<h4>Senaryolar</h4>
<p>"FLEX tipi", "ACME tipi", "Saffire tipi" ifadeleri, NASA deneylerinin incelediği fiziksel rejimi temsil eder; deneylerin birebir koşulları değildir. Konum düğmeleri de öyledir: "Mars yüzeyi" ölçülmüş yüzey atmosferidir, "Mars habitatı" ve "Ay habitatı" insanlı kabin önerileridir.</p>
`;

/* ------------------------------------------------------------------ */
/* Kaynaklar, doğrulama ölçütleri ve uzay standartları                  */
/* ------------------------------------------------------------------ */
FL.REFERENCES = `
<p>Simülatördeki her model bileşeni yayımlanmış bir çalışmaya ya da uzay deneyi ölçümüne dayanır. Aşağıda doğrulama ölçütleri, ilgili uzay standartları ve kaynakların uygulamada nerede kullanıldığı yer alır.</p>
<h4>Doğrulama ölçütleri</h4>
<table class="ref-tbl">
<thead><tr><th>Ölçüt</th><th>Referans</th><th>Senaryo</th></tr></thead>
<tbody>
<tr><td>Levhada eş-akışlı alev yayılma hızı (0 g, 20 cm/s, SIBAL kumaş) <a href="https://ntrs.nasa.gov/citations/20180005168" target="_blank" rel="noopener">[Saffire-I]</a></td><td>1,8 mm/s</td><td>Levha · 0 g</td></tr>
<tr><td>Mum alevinin biçimi, 0 g: küresele yakın, soluk mavi, kurumsuz <a href="https://ntrs.nasa.gov/citations/20000005087" target="_blank" rel="noopener">[4]</a></td><td>nitel</td><td>Mum · Uzay</td></tr>
<tr><td>Mum alevi boyu, 1 g, deniz seviyesi [7]</td><td>≈3–4 cm</td><td>Mum · Deniz</td></tr>
<tr><td>Damla çapının karesi zamanla doğrusal azalır, eğim K sabittir [6]</td><td>d² ∝ t</td><td>Damla</td></tr>
</tbody>
</table>
<h4>Uzay standartlarıyla ilişki</h4>
<ul>
<li><b>NASA-STD-7009A</b> (2016), <i>Standard for Models and Simulations</i>. Bir modelin güvenilirliğini doğrulama, geçerleme, girdi verisinin kökeni, sonuç belirsizliği ve sağlamlık gibi etkenlerle değerlendirir. Yukarıdaki doğrulama ölçütleri ve “Model ve varsayımlar” bölümündeki sınırlar bu çerçeveye göre düzenlenmiştir.</li>
<li><b>NASA-STD-6001B</b> (2011), <i>Flammability, Offgassing, and Compatibility Requirements and Test Procedures</i>. Test 1, malzemelerde yukarı yönlü alev yayılmasını tarar.</li>
<li><b>ECSS-Q-ST-70-21C</b> (5 Şubat 2010), <i>Flammability testing for the screening of space materials</i> (EN 16602-70-21). Avrupa uzay programlarında aynı amaçlı tarama standardıdır.</li>
<li><b>ISO 14624-1</b>, <i>Space systems — Safety and compatibility of materials — Part 1: Determination of upward flammability of materials</i>.</li>
<li><b>NASA/TP-2010-216134</b>, Exploration Atmospheres Working Group önerileri ve 2012 güncellemesi: 8,2 psia (56,5 kPa) ve %34 O₂. “Ay habitatı” konumu bu atmosferi kullanır.</li>
<li><b>ISO 12232</b>, dijital fotoğraf makinelerinde pozlama indeksi. Fiziksel kameranın doyma tabanlı pozlaması buna göredir.</li>
</ul>
<p class="disclaimer">Bu simülatör bir eğitim ve keşif aracıdır; yukarıdaki standartlara göre sertifikalı değildir ve malzeme yanabilirlik testlerinin yerine geçmez. Levha senaryosu, bu testlerin yanıt aradığı soruyu (bir malzeme belirli bir kabin atmosferinde alevi taşır mı?) görselleştirir. NASA-STD-7009A ile ilişki bir öz değerlendirmedir, bağımsız bir denetim değildir.</p>
<h4>Bilimsel kaynaklar</h4>
<ol>
<li>Westbrook, C. K., Dryer, F. L. (1981). Simplified reaction mechanisms for the oxidation of hydrocarbon fuels in flames. <i>Combustion Science and Technology</i>, 27, 31–43. — Tek adımlı global kinetik.</li>
<li>Olson, S. L., Ruff, G. A., Ferkul, P. V., Owens, J. C., Easton, J. W., Liao, Y.-T., T’ien, J. S., Urban, D. L. (2023). The effect of duct size, sample size, and fuel composition on concurrent flame spread over large cellulose samples in microgravity. <i>Combustion and Flame</i>, 248, 112559. — Saffire ve BASS eş-akış yayılma verileri, SIBAL kumaşı.</li>
<li>Ferkul, P. V. vd. (2017). The Saffire Experiment: Large-scale combustion aboard spacecraft. <i>10th U.S. National Combustion Meeting</i>. NASA Saffire-I sonuç özeti: <a href="https://ntrs.nasa.gov/citations/20180005168" target="_blank" rel="noopener">NTRS 20180005168</a>. — Levha yayılma hızının doğrulaması.</li>
<li>Dietrich, D. L., Ross, H. D., Shu, Y., T’ien, J. S. (2000). Candle flames in non-buoyant atmospheres. <i>Combustion Science and Technology</i>, 156, 1–24. <a href="https://ntrs.nasa.gov/citations/20000005087" target="_blank" rel="noopener">NTRS 20000005087</a>. — Mikrogravitede mum alevi (Uzay Mekiği ve Mir).</li>
<li>Nayagam, V., Dietrich, D. L., Ferkul, P. V., Hicks, M. C., Williams, F. A. (2012). Can cool flames support quasi-steady alkane droplet burning? <i>Combustion and Flame</i>, 159, 3583–3588. — FLEX deneyleri, n-heptan soğuk alevi.</li>
<li>Godsave, G. A. E. (1953); Spalding, D. B. (1953). <i>Fourth Symposium (International) on Combustion</i>. — Damla yanmasında d²-yasası ve transfer sayısı B.</li>
<li>Roper, F. G. (1977). The prediction of laminar jet diffusion flame sizes: Part I. Theoretical model. <i>Combustion and Flame</i>, 29, 219–226. — Alev boyu korelasyonu.</li>
<li>Ranz, W. E., Marshall, W. R. (1952). Evaporation from drops. <i>Chemical Engineering Progress</i>, 48, 141–146. — Taşınım düzeltmesi.</li>
<li>Nagle, J., Strickland-Constable, R. F. (1962). Oxidation of carbon between 1000–2000 °C. <i>Proceedings of the Fifth Conference on Carbon</i>, 1, 154–164. — Kurumun O₂ ile oksidasyonu.</li>
<li>Neoh, K. G., Howard, J. B., Sarofim, A. F. (1981). Soot oxidation in flames. <i>Particulate Carbon: Formation During Combustion</i>, Plenum, 261–282. — Kurumun OH ile oksidasyonu.</li>
<li>Modest, M. F. (2013). <i>Radiative Heat Transfer</i>, 3. baskı, Academic Press. — Optik ince ışınım, kurumun spektral soğurma katsayısı.</li>
<li>CIE (1931). Standart kolorimetrik gözlemci. — Alevin spektral ışımasının renge çevrilmesi.</li>
</ol>
`;
