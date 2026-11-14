/* =====================================================================
 * Alev Laboratuvarı — Varsayılan durum ve deney senaryoları
 * ---------------------------------------------------------------------
 * Senaryolar, NASA'nın mikrogravite yanma deneylerinin TİPİNİ temsil
 * eder (CFM mum alevleri, FLEX damla yanması, ACME gaz alevleri,
 * Saffire katı yakıt yangını, keşif atmosferi çalışmaları). Değerler
 * deneylerin birebir koşulları değil, aynı fiziksel rejimi üreten
 * temsili parametrelerdir.
 * ===================================================================== */
import { FL } from '../core/fl.js';

FL.DEFAULTS = {
  preset: 'earth-candle',
  // Kaynak & yakıt
  source: 'candle',
  fuel: 'PARAFFIN',
  jetU: 25,            // cm/s, ortalama çıkış hızı
  nozzleD: 4,          // mm
  fuelDilution: 0,     // % N2 (mol)
  coflow: 0,           // cm/s
  dropletD: 3,         // mm
  wickRate: 1.6,       // mg/s, fitilden en yüksek buhar debisi
  sheetW: 3,           // cm
  sheetH: 6,           // cm
  sheetIgnTop: false,
  flameRadFeedback: 0.08,
  // Ortam
  gravity: 1,          // g/g0
  gJitter: 0,          // µg
  o2: 21,              // % mol
  pressure: 101.325,   // kPa
  diluent: 'N2',
  Tamb: 295,           // K
  flow: 0,             // cm/s
  draft: 0.6,          // cm/s
  depth: 0,            // cm; 0 = genişliğe eşit (Z)
  ozone: 0,            // oksitleyicide O₃, % mol (soğuk alev kimyasını hızlandırır)
  wind: 0,             // cm/s, yatay
  windDir: 0,          // derece (0 = +x)
  // Fizik
  soot: true,
  sootMult: 1,
  sootOx: 1,
  radiation: true,
  radModel: 'rt',      // 'thin' (optik ince kayıp) | 'rt' (kaynak toplamı: yeniden soğurma, duvar akısı)
  gasRadMult: 1,
  sootRadMult: 1,
  coolFlame: true,
  kinScale: 1,
  lewis: true,
  expansion: true,
  vorticity: 0.25,
  ignT: 1900,
  // Çözücü
  resolution: 32,      // gerçek zamana yakın akış için (40–48: daha keskin alev, belirgin biçimde daha yavaş)
  domain: 4,           // cm (genişlik)
  aspect: 1.8,
  pressureIters: 16,
  sor: 1.6,
  viscIters: 4,
  timeScale: 1,
  maxSub: 12,          // kare başına alt adım tavanı (60 Hz'e göre); gerçek zamana yetişmek için
  cfl: 3,              // büyük adım: benzetim gerçek hızda akar (1,6: daha temkinli, ~2 kat yavaş)
  diffA: 2.5,
  dtMax: 6,            // ms
  maccormack: true,
  diffScale: 1,
  hrrThr: 2,           // MW/m³
  // Görüntü
  view: 'real',
  exposure: 0,
  autoExposure: true,
  chemGain: 1,
  sootGain: 1,
  coolGain: 1,
  bloom: 0.32,
  vignette: 0.2,
  stepCells: 0.7,
  renderScale: 0.75,
  adaptive: true,      // kare hızına göre görüntü çözünürlüğünü ayarla
  taa: true,           // zamansal biriktirme (yumuşatma + gürültü giderme)
  tonemap: 'agx',
  shadows: true,
  fov: 38,
  ambientLight: 4,
  floor: true,
  floorGrid: true,
  schMode: 'gray',
  schGain: 1,
  slice: false,
  sliceField: 'T',
  sliceAxis: 'z',
  slicePos: 0.5,
  falseTmax: 2300,
  falseHRR: 300,
  falseSoot: 4,
  falseU: 80,
  falseYf: 0.4,
  falseRad: 10,        // kW/m², ışınım akısı ölçeği
  // Fiziksel kamera (Blender kamerası gibi): görüntü yalnız gerçek bir kameranın görebildiği kadar
  camPhys: false,
  camSensor: 'apsc',
  camFocal: 35,        // mm
  camFstop: 8,
  camShutter: 0.004,   // s (1/250)
  camISO: 400,
  camAE: 'A',          // 'M' manuel, 'A' diyafram öncelikli (obtüratör otomatik)
  camEV: 0,            // otomatik pozlama telafisi
  camFocus: 0,         // cm; 0 = otomatik (alevin ışık merkezine)
  camWB: 5500,         // K
  camNoise: true,
  camVig: true,
  camGlare: 0.03,      // mercek içi saçılma (perdeleyici parlama) kesri
  camView: 'standard', // 'standard' (sRGB, kırpma) | 'agx'
  camHelpers: false,   // fiziksel kamerada yardımcı çizimler (kutu, ölçek, etiket)
  // Sahne kamerası nesnesi (Blender'daki kamera gibi taşınır ve döndürülür)
  camLook: true,       // kameradan bak (Blender: Numpad 0); kapalıyken editör görünümü + kamera nesnesi
  camSet: false,       // kamera konumu kullanıcı/hizalama ile belirlendi mi
  camX: 0.12, camY: 0.05, camZ: 0.2,   // m, dünya koordinatı
  camYaw: 30, camPitch: 8, camRoll: 0, // derece
  camGizmo: 'move',    // 'move' taşı | 'rotate' döndür | 'zoom' ölçekle (görüş açısı)
  // Veri kümesi
  dsFrames: 48,
  dsInterval: 0.05,    // s, benzetim zamanı
  dsWidth: 640,        // px
  dsJitter: 0,         // derece, kamera yönünde kare başına rastgele sapma
  dsMask: true,
  autoRotate: false,
  chartSeries: 'hrr',
  // Sahne modeli (GLB) ve yanıcılık görünümü
  model: 'none',       // 'none' | co2 | sfog | valve | panel | cabin | '+' ile birleşik nesne listesi (ör. 'co2+sfog')
  modelX: 0,           // cm, varsayılan yerleşime göre kaydırma
  modelZ: 0,           // cm
  modelRot: 0,         // derece, y ekseni çevresinde
  modelSolid: true,    // alana giren parçalar çözücüde katı hücre olur
  flamView: false,     // parçaları yanıcılık rengiyle göster
  flamMode: 'class',   // 'class' modelin sınıfı | 'atm' bu atmosferde (O₂ ve LOI)
  roomLight: 0,        // lx, tavan lambasının döşemede verdiği aydınlık (0: kapalı)
  // Yangın ve patlama efektleri
  fxTool: 'none',      // sahneye tıklayınca: 'none' | 'spark' kıvılcım | 'charge' patlayıcı | 'agent' söndürücü
  fxYield: 0.05,       // MJ, patlayıcının enerjisi
  fxO2Link: true,      // nesne yangını kabin O₂'sini tüketir ve akış çözücüsüne geri yazar
  fxDeplete: 0.3,      // kabin O₂ tükenme hızı çarpanı (1 = fiziksel, 0 = yaşam desteği tüketimi karşılar)
  cabinVent: 15,       // cm/s, mekik kabininde havalandırma (ECLSS fanları); mikrogravitede alevi besleyen tek akış
  // Yapay zekâ (cockpit_fire_model): tutuşturucu girdileri ve öngörüyü ileri sarma
  aiIgnPower: 100,     // W
  aiIgnTime: 20,       // s
  aiLead: 0,           // s, öngörülen cepheyi bu kadar ileri göster
  // Arka plan: 'auto' kabinde ve mikrogravitede yörünge, 'lab' deney odası, 'orbit' her zaman yörünge
  backdrop: 'auto',
  earthLum: 220,       // cd/m², Dünya'nın gündüz yüzünün görüntüdeki ışıklılığı
  sunLight: 600,       // lx, yörüngede model yüzeylerine gelen güneş aydınlığı (0: kapalı)
  realTime: true,      // gerçek zaman öncelikli: kare hızı düşse de alt adım kısılmaz (benzetim ağır çekime geçmez)
  targetFps: 60,       // kare hızı yöneticisinin güvence altına aldığı hız (0: ekran tazeleme hızı); çizim sınırlanmaz
};

FL.PRESETS = [
  {
    id: 'earth-candle',
    name: 'Dünya · Mum alevi (1 g)',
    group: 'Mum',
    desc: 'Yüzdürme kuvveti sıcak gazı yukarı çeker; alev uzun, kurumlu ve sarıdır. Taban bölgesinde zayıf mavi CH* ışıması görülür. Alevin 10–15 Hz civarı titreşimi yüzdürme kararsızlığından gelir.',
    set: { source: 'candle', fuel: 'PARAFFIN', gravity: 1, o2: 21, pressure: 101.325, diluent: 'N2', flow: 0, draft: 0.6, domain: 4, aspect: 1.8, floor: true },
    focus: 0.55,
  },
  {
    id: 'iss-candle',
    name: 'ISS · Mum alevi (mikro-g)',
    group: 'Mum',
    desc: 'Yüzdürme yokken oksijen fitile yalnız difüzyonla ulaşır. Alev küreye yakın, küçük ve mavi olur; kurum azalır, ışınım kaybı nedeniyle sönmeye yakın çalışır (CFM tipi deneyler).',
    set: { source: 'candle', fuel: 'PARAFFIN', gravity: 0, o2: 21, pressure: 101.325, diluent: 'N2', flow: 0, draft: 0, domain: 4, aspect: 1.0, floor: false },
    focus: 0.5,
  },
  {
    id: 'flex-heptane',
    name: 'FLEX tipi · n-Heptan damlası (0 g)',
    group: 'Damla',
    desc: 'Küresel simetrik difüzyon alevi. Damla çapının karesi zamanla doğrusal azalır (d²-yasası). Grafikte d² serisini seçerek yanma hız sabiti K\'yı ölçün.',
    set: { source: 'droplet', fuel: 'C7H16', gravity: 0, o2: 21, pressure: 101.325, diluent: 'N2', flow: 0, draft: 0, dropletD: 3, domain: 6, aspect: 1.0, floor: false, coolFlame: true, chartSeries: 'd2' },
    focus: 0.5,
  },
  {
    id: 'flex-large',
    name: 'FLEX tipi · Büyük damla, %18 O₂ (ışınımsal sönme)',
    group: 'Damla',
    desc: 'Büyük damlada alev yarıçapı ve ışınım kaybı büyür; sıcak alev ışınımla söner, ardından düşük sıcaklık kimyası ile "soğuk alev" evresi başlayabilir (FLEX deneylerinin öne çıkan bulgusu).',
    set: { source: 'droplet', fuel: 'C7H16', gravity: 0, o2: 18, pressure: 101.325, diluent: 'N2', flow: 0, draft: 0, dropletD: 5, domain: 8, aspect: 1.0, floor: false, coolFlame: true, gasRadMult: 1.6, chartSeries: 'hotcool' },
    focus: 0.5,
  },
  {
    id: 'earth-droplet',
    name: 'Dünya · n-Heptan damlası (1 g)',
    group: 'Damla',
    desc: 'Aynı damla yerçekiminde: alev yukarı uzar, damlanın üstünde kurum oluşur ve doğal taşınım buharlaşmayı hızlandırır (K artar).',
    set: { source: 'droplet', fuel: 'C7H16', gravity: 1, o2: 21, pressure: 101.325, diluent: 'N2', flow: 0, draft: 0.3, dropletD: 3, domain: 4.4, aspect: 1.8, floor: false, chartSeries: 'd2' },
    focus: 0.5,
  },
  {
    id: 'methane-jet',
    name: 'Dünya · Metan jet difüzyon alevi',
    group: 'Gaz alevleri',
    desc: 'Laminer jet alevi. Metanın kurum eğilimi düşüktür; alev tabanı mavi, uç kısmı az kurumlu. Jet hızı ile alev boyu yaklaşık doğrusal artar (Roper korelasyonu).',
    set: { source: 'jet', fuel: 'CH4', gravity: 1, o2: 21, pressure: 101.325, diluent: 'N2', flow: 0, draft: 0.5, jetU: 30, nozzleD: 4, coflow: 0, fuelDilution: 0, domain: 4, aspect: 2.0, floor: true },
    focus: 0.45,
  },
  {
    id: 'acme-ethylene',
    name: 'ACME tipi · Etilen eş-akış alevi (0 g)',
    group: 'Gaz alevleri',
    desc: 'Mikrogravitede eş-akışlı laminer alev: yüzdürme olmadığından alev genişler, kalış süresi uzar ve kurum birikimi artar. Seyreltme ile kurum sınırına yaklaşılır.',
    set: { source: 'jet', fuel: 'C2H4', gravity: 0, o2: 21, pressure: 101.325, diluent: 'N2', flow: 0, draft: 0, jetU: 18, nozzleD: 3, coflow: 10, fuelDilution: 30, domain: 4, aspect: 1.6, floor: false },
    focus: 0.45,
  },
  {
    id: 'hydrogen-jet',
    name: 'Hidrojen jeti (görünmez alev)',
    group: 'Gaz alevleri',
    desc: 'Hidrojen alevinde kurum ve CH* yoktur; gözle neredeyse görünmez. Termal kamera görünümüne geçerek alevi görün. Düşük Lewis sayısı (≈0,3) alev yapısını değiştirir.',
    set: { source: 'jet', fuel: 'H2', gravity: 1, o2: 21, pressure: 101.325, diluent: 'N2', flow: 0, draft: 0.5, jetU: 60, nozzleD: 3, coflow: 0, fuelDilution: 0, domain: 4, aspect: 2.0, floor: true },
    focus: 0.45,
  },
  {
    id: 'saffire',
    name: 'Saffire tipi · Kumaş levha, 20 cm/s akış (0 g)',
    group: 'Katı yakıt',
    desc: 'Uzay aracı kabin malzemesi yangını: ince pamuk-cam elyaf kumaş, eş yönlü zorlanmış akışta alt kenardan tutuşur. Piroliz cephesi akış yönünde ilerler; cam elyaf iskelet geride kalır.',
    set: { source: 'sheet', fuel: 'CELLULOSE', gravity: 0, o2: 21, pressure: 101.325, diluent: 'N2', flow: 20, draft: 0, sheetW: 3, sheetH: 6, sheetIgnTop: false, domain: 6, aspect: 1.6, floor: false },
    focus: 0.5,
  },
  {
    id: 'earth-sheet',
    name: 'Dünya · Kumaş levha, yukarı doğru yayılma',
    group: 'Katı yakıt',
    desc: 'Yerçekiminde alt kenardan tutuşan levhada alev, yüzdürme ile hızlanan sıcak gaz sayesinde yukarı doğru hızla yayılır.',
    set: { source: 'sheet', fuel: 'CELLULOSE', gravity: 1, o2: 21, pressure: 101.325, diluent: 'N2', flow: 0, draft: 0.4, sheetW: 3, sheetH: 6, sheetIgnTop: false, domain: 6, aspect: 1.6, floor: true },
    focus: 0.5,
  },
  {
    id: 'exploration',
    name: 'Keşif atmosferi · 56,5 kPa, %34 O₂, Ay g',
    group: 'Katı yakıt',
    desc: 'NASA\'nın keşif görevleri için değerlendirdiği düşük basınçlı, oksijence zengin kabin atmosferi. Oksijen kesri arttıkça yanıcılık artar; düşük basınç ise ışınım ve difüzyonu değiştirir.',
    set: { source: 'sheet', fuel: 'CELLULOSE', gravity: 0.165, o2: 34, pressure: 56.5, diluent: 'N2', flow: 0, draft: 0.2, sheetW: 3, sheetH: 6, sheetIgnTop: false, domain: 6, aspect: 1.6, floor: true },
    focus: 0.5,
  },
  {
    id: 'pmma-opposed',
    name: 'PMMA levha · Karşı akışta yayılma (0 g)',
    group: 'Katı yakıt',
    desc: 'Üst kenardan tutuşturulan PMMA levhada akış alevin önünden gelir (karşı akış). Yayılma yavaştır ve oksijen/akış hızına çok duyarlıdır; düşük akışta alev söner.',
    set: { source: 'sheet', fuel: 'PMMA', gravity: 0, o2: 21, pressure: 101.325, diluent: 'N2', flow: 10, draft: 0, sheetW: 3, sheetH: 6, sheetIgnTop: true, domain: 6, aspect: 1.6, floor: false },
    focus: 0.5,
  },
  {
    id: 'mars-candle',
    name: 'Mars g · Mum, CO₂ zengin seyreltici',
    group: 'Mum',
    desc: 'Varsayımsal habitat: 0,38 g ve %30 O₂ / CO₂ seyreltici. CO₂\'nin yüksek ısı kapasitesi alev sıcaklığını düşürür; yüzdürme Dünya\'dakinin yaklaşık üçte biridir.',
    set: { source: 'candle', fuel: 'PARAFFIN', gravity: 0.38, o2: 30, pressure: 101.325, diluent: 'CO2', flow: 0, draft: 0.3, domain: 4, aspect: 1.7, floor: true },
    focus: 0.5,
  },
];

/** Kaynak değişince uygun yakıt */
FL.DEFAULT_FUEL = { jet: 'CH4', candle: 'PARAFFIN', droplet: 'C7H16', sheet: 'CELLULOSE', none: 'PARAFFIN' };

/**
 * Konum: yerçekimi, basınç, oksijen, seyreltici, sıcaklık ve akışı birlikte kurar.
 * Değerler o konumun tipik atmosferidir (yüzey ya da insanlı kabin).
 */
FL.PLACES = [
  {
    id: 'earth', name: 'Dünya · deniz seviyesi', short: 'Deniz',
    note: '1 g₀, 101,3 kPa, %21 O₂ ve azot. Oda sıcaklığında hafif hava akımı; alev uzun ve kurumlu.',
    set: { gravity: 1, gJitter: 0, o2: 21, pressure: 101.325, diluent: 'N2', Tamb: 295, flow: 0, draft: 0.6 },
  },
  {
    id: 'iss', name: 'ISS kabini', short: 'ISS',
    note: 'Mikrogravite, deniz seviyesi basıncında hava. Kabin havalandırması yaklaşık 8 cm/s, küçük g-sarsıntısı.',
    set: { gravity: 1e-6, gJitter: 15, o2: 21, pressure: 101.3, diluent: 'N2', Tamb: 295, flow: 8, draft: 0 },
  },
  {
    id: 'space', name: 'Sakin uzay', short: 'Uzay',
    note: '0 g ve durgun hava. Taşınım yok; alev küreye yakın, oksijen yalnız difüzyonla gelir ve ışınımla sönebilir.',
    set: { gravity: 0, gJitter: 0, o2: 21, pressure: 101.325, diluent: 'N2', Tamb: 295, flow: 0, draft: 0 },
  },
  {
    id: 'moon', name: 'Ay habitatı', short: 'Ay',
    note: '0,165 g₀. NASA keşif atmosferi: 56,5 kPa ve %34 O₂. Düşük basınç difüzyonu hızlandırır, yüksek oksijen yanmayı kolaylaştırır.',
    set: { gravity: 0.165, gJitter: 0, o2: 34, pressure: 56.5, diluent: 'N2', Tamb: 295, flow: 5, draft: 0.1 },
  },
  {
    id: 'mars-hab', name: 'Mars habitatı', short: 'Habitat',
    note: '0,38 g₀, 70 kPa, %30 O₂ ve CO₂ seyreltici. CO₂ alevi soğutur ve ışınımı artırır; yüzdürme Dünya’nın yaklaşık üçte biridir.',
    set: { gravity: 0.38, gJitter: 0, o2: 30, pressure: 70, diluent: 'CO2', Tamb: 293, flow: 4, draft: 0.15 },
  },
  {
    id: 'mars-air', name: 'Mars yüzeyi', short: 'Mars',
    note: 'Gerçek yüzey gazı: 0,38 g₀, 0,64 kPa, %0,13 O₂, geri kalanı CO₂, yaklaşık −63 °C. Bu atmosferde alev tutunamaz; difüzyon çok hızlı olduğundan çözücü yavaşlar.',
    set: { gravity: 0.38, gJitter: 0, o2: 0.13, pressure: 0.64, diluent: 'CO2', Tamb: 210, flow: 0, draft: 2 },
  },
];

/** Oksitleyici: yalnız oksijen kesri ve seyreltici gaz. Basınç ve yerçekimi durur. */
FL.OXIDIZERS = [
  { id: 'air', name: 'Hava', short: 'Hava', o2: 21, diluent: 'N2', note: 'Kuru hava: %21 O₂, gerisi azot.' },
  { id: 'rich', name: 'Oksijence zengin hava', short: '%30', o2: 30, diluent: 'N2', note: '%30 O₂. Alev daha sıcak ve daha kısa; kurum artabilir.' },
  { id: 'oxygen', name: 'Saf oksijen', short: 'O₂', o2: 100, diluent: 'N2', note: 'Seyreltici yok. Alev çok sıcak, küçük ve parlak.' },
  { id: 'o2co2', name: 'Oksijen / karbondioksit', short: 'CO₂', o2: 21, diluent: 'CO2', note: 'Aynı oksijen, CO₂ seyreltici: yüksek ısı kapasitesi ve ışınım, daha soğuk alev.' },
  { id: 'o2he', name: 'Oksijen / helyum', short: 'He', o2: 21, diluent: 'HE', note: 'Helyum ısıl yayınımı büyütür; alev kalınlaşır, kurum azalır.' },
  { id: 'o2ar', name: 'Oksijen / argon', short: 'Ar', o2: 21, diluent: 'AR', note: 'Argonun ısı kapasitesi düşük; alev havadakinden sıcaktır.' },
  { id: 'marsgas', name: 'Mars atmosferi', short: 'Mars', o2: 0.13, diluent: 'CO2', note: 'Yüzey gazının bileşimi: %0,13 O₂, gerisi CO₂. Basıncı konumdan ayrıca ayarlayın.' },
];

function envClose(a, b, tol) { return Math.abs(a - b) <= tol; }

FL.matchPlace = function (place, st) {
  const s = place.set;
  const gTol = Math.max(1e-9, 0.03 * Math.max(s.gravity, 1e-8));
  return envClose(st.gravity, s.gravity, gTol)
    && st.diluent === s.diluent
    && envClose(st.o2, s.o2, Math.max(0.05, 0.03 * s.o2))
    && envClose(st.pressure, s.pressure, Math.max(0.04, 0.03 * s.pressure))
    && envClose(st.Tamb, s.Tamb, 2)
    && envClose(st.flow, s.flow, 0.6)
    && envClose(st.draft, s.draft, 0.12)
    && envClose(st.gJitter, s.gJitter, 2);
};

FL.matchOxidizer = function (ox, st) {
  const tol = ox.o2 < 1 ? 0.04 : 0.55;
  return st.diluent === ox.diluent && envClose(st.o2, ox.o2, tol);
};

FL.envSummary = function (st) {
  const dil = FL.DILUENTS[st.diluent];
  let flow = st.flow > 0.2 ? 'akış ' + FL.fmt(st.flow, 3) + ' cm/s' : 'durgun';
  if ((st.wind || 0) > 0.2) flow += ' · rüzgâr ' + FL.fmt(st.wind, 3) + ' cm/s, ' + Math.round(st.windDir || 0) + '°';
  return FL.gravityText(st.gravity) + ' g₀ · ' + FL.fmt(st.pressure, 4) + ' kPa · O₂ %' + FL.fmt(st.o2, 3)
    + ' · ' + (dil ? dil.name : st.diluent) + ' · ' + Math.round(st.Tamb - 273.15) + ' °C · ' + flow;
};

/** Yerçekimi hızlı seçimleri */
FL.GRAVITY_PRESETS = [
  { label: '0', g: 0 },
  { label: 'ISS 10⁻⁶', g: 1e-6 },
  { label: 'Ay', g: 0.165 },
  { label: 'Mars', g: 0.38 },
  { label: 'Dünya', g: 1 },
  { label: '2 g', g: 2 },
];

/** Senaryo değişse de korunan görüntü ve çözücü tercihleri */
FL.VIEW_PREFS = ['view', 'exposure', 'autoExposure', 'chemGain', 'sootGain', 'bloom', 'vignette', 'stepCells', 'renderScale',
  'adaptive', 'taa', 'tonemap', 'shadows', 'floorGrid', 'schMode', 'schGain', 'fov', 'ambientLight', 'resolution',
  'camPhys', 'camSensor', 'camFocal', 'camFstop', 'camShutter', 'camISO', 'camAE', 'camEV', 'camFocus', 'camWB', 'camNoise', 'camVig', 'camGlare', 'camView', 'camHelpers', 'camLook', 'camSet', 'camX', 'camY', 'camZ', 'camYaw', 'camPitch', 'camRoll', 'camGizmo',
  'dsFrames', 'dsInterval', 'dsWidth', 'dsJitter', 'dsMask',
  'pressureIters', 'viscIters', 'maxSub', 'timeScale', 'slice', 'sliceField', 'sliceAxis', 'slicePos', 'autoRotate',
  'model', 'modelX', 'modelZ', 'modelRot', 'modelSolid', 'flamView', 'flamMode', 'roomLight',
  'fxTool', 'fxYield', 'fxO2Link', 'backdrop', 'earthLum', 'sunLight', 'targetFps', 'realTime'];

/** Bir durumu senaryoya göre üret */
FL.stateForPreset = function (id, current) {
  const p = FL.PRESETS.find((x) => x.id === id) || FL.PRESETS[0];
  const base = Object.assign({}, FL.DEFAULTS);
  // Görüntü tercihlerini koru
  if (current) {
    FL.VIEW_PREFS.forEach((k) => { if (current[k] !== undefined) base[k] = current[k]; });
  }
  Object.assign(base, p.set);
  base.preset = p.id;
  return { state: base, preset: p };
};
