/* =====================================================================
 * Alev Laboratuvarı — Model kitaplığı ve yanıcılık verisi
 * ---------------------------------------------------------------------
 * Modeller (Blender'dan GLB) gerçek ölçekte (metre) gelir. Her parçanın
 * yanıcılık seviyesi modelin "extras" alanındadır (yanicilik_seviyesi);
 * yalnız tek başına modellerde yoksa "sim_sinifi" üzerinden, kabin
 * modelindeki aynı parçaların seviyesiyle eşleştirilir.
 *
 * "Bu atmosferde" değerlendirmesi, malzemenin sınırlayıcı oksijen indisini
 * (LOI, ASTM D2863 / ISO 4589-2: alevi oda sıcaklığında, 1 g'de, aşağı
 * doğru yanarken sürdüren en düşük O₂ hacim yüzdesi) ortamın O₂ yüzdesiyle
 * karşılaştırır. LOI değerleri literatürde yaygın verilen yaklaşık
 * aralıklardır; kalınlık, katkı maddesi, akış ve yerçekimi bunları değiştirir.
 * NASA-STD-6001B Test 1'in yerine geçmez.
 * ===================================================================== */
import { FL } from '../core/fl.js';
import urlCO2 from '../assets/models/co2_sondurucu.glb?url';
import urlSFOG from '../assets/models/oksijen_ureteci_sfog.glb?url';
import urlValve from '../assets/models/yakit_oksijen_hatti_vana.glb?url';
import urlPanel from '../assets/models/kabin_paneli_kablo_demeti.glb?url';
import urlCabin from '../assets/models/mekik_kabini.glb?url';

/* ------------------------------------------------------------------ */
/* Model kataloğu                                                       */
/* ------------------------------------------------------------------ */
FL.MODELS = [
  {
    id: 'co2', name: 'CO₂ söndürücü', short: 'CO₂ tüpü', url: urlCO2, file: 'co2_sondurucu.glb', rot: 180,
    desc: 'Duvar braketli taşınabilir CO₂ söndürücü, kauçuk hortum ve huni',
  },
  {
    id: 'sfog', name: 'Oksijen üreteci (SFOG)', short: 'SFOG', url: urlSFOG, file: 'oksijen_ureteci_sfog.glb', rot: 180,
    desc: 'Katı yakıtlı oksijen mumu; Mir 1997 yangını. Tabanda lateks kirlilik',
  },
  {
    id: 'valve', name: 'O₂ hattı ve vana', short: 'O₂ vanası', url: urlValve, file: 'yakit_oksijen_hatti_vana.glb',
    desc: 'Pirinç vana, PTFE contalı flanşlar, paslanmaz çelik O₂ boruları',
  },
  {
    id: 'panel', name: 'Kabin paneli ve kablo demeti', short: 'Kablolar', url: urlPanel, file: 'kabin_paneli_kablo_demeti.glb',
    desc: 'Alüminyum panel, PTFE yalıtımlı kablo demeti, polimer klipsler',
  },
  {
    id: 'cabin', name: 'Mekik mürettebat kabini', short: 'Kabin', url: urlCabin, file: 'mekik_kabini.glb', large: true,
    desc: 'Orta güverte, uçuş güvertesi, Orbiter biçimli burun (RCC başlık, karo, RCS portları) ve eğimli 6 camlı kokpit çatısı; döşeme altı; diğer dört model yerleşik. Deney orta güvertede',
    // Deney kutusunun kabinde oturduğu nokta: orta güverte döşemesinde, O₂ vanasına ve hava kilidine yakın boş alan
    anchor: [3.6, 0, -0.3],
    // Orta güverte tavan aydınlatması (sağ armatürün arka ucu, model uzayı)
    lamp: [3.0, 1.95, -0.72], lampR: 0.35,
  },
];
/**
 * Sahne nesneleri. Durumdaki "model" anahtarı tek bir kimlik ('co2') ya da '+' ile
 * birleştirilmiş nesne listesidir ('co2+sfog+panel'): her nesne ayrı eklenip çıkarılır,
 * sahnede yan yana durur. Kabin kendi içinde diğer dört modeli taşıdığı için tek başınadır.
 */
const COMPOSITE = new Map();
FL.modelIds = (id) => String(id || '').split('+').filter((x) => FL.MODELS.some((m) => m.id === x));
FL.modelKey = (ids) => {
  const order = FL.MODELS.map((m) => m.id);
  const set = [...new Set(ids)].filter((x) => order.includes(x));
  if (set.includes('cabin')) return 'cabin';
  return set.sort((a, b) => order.indexOf(a) - order.indexOf(b)).join('+') || 'none';
};
FL.modelById = (id) => {
  const ids = FL.modelIds(id);
  if (!ids.length) return null;
  if (ids.length === 1) return FL.MODELS.find((m) => m.id === ids[0]);
  const key = FL.modelKey(ids);
  if (!COMPOSITE.has(key)) {
    const defs = FL.modelIds(key).map((x) => FL.MODELS.find((m) => m.id === x));
    COMPOSITE.set(key, {
      id: key, composite: true, defs,
      name: defs.map((d) => d.short).join(' + '), short: defs.length + ' nesne',
      file: defs.map((d) => d.file).join(', '),
      desc: defs.map((d) => d.name).join(', ') + ': her biri ayrı nesne, yan yana',
    });
  }
  return COMPOSITE.get(key);
};
/** Bir nesneyi sahneye ekle / çıkar; yeni "model" anahtarını döndürür */
FL.modelToggle = (current, id) => {
  if (id === 'none') return 'none';
  const ids = FL.modelIds(current);
  if (id === 'cabin') return ids.includes('cabin') ? 'none' : 'cabin';
  // Mekik kabini seçiliyken başka nesne eklenemez (kabin onları zaten içinde taşır)
  if (ids.includes('cabin')) return FL.modelKey(ids);
  const set = ids.filter((x) => x !== 'cabin');
  const i = set.indexOf(id);
  if (i >= 0) set.splice(i, 1); else set.push(id);
  return FL.modelKey(set);
};

/* ------------------------------------------------------------------ */
/* Yanıcılık seviyeleri (modelin kendi ölçeği ve renkleri)              */
/* ------------------------------------------------------------------ */
FL.FLAM_LEVELS = [
  { id: 0, name: 'Yanmaz', desc: 'Kabin atmosferinde yanmaz', color: '#4fab59' },
  { id: 1, name: 'Düşük', desc: 'Tutuşsa da kendiliğinden söner', color: '#e3cf45' },
  { id: 2, name: 'Orta', desc: 'Yanar ve alevi yayar', color: '#ed8a24' },
  { id: 3, name: 'Yüksek', desc: 'Kolay tutuşur ya da oksitleyicidir', color: '#d42a1d' },
];
/* "Bu atmosferde" kipinin sınıfları */
FL.FLAM_VERDICTS = {
  none: { name: 'Yanmaz', desc: 'Yanıcı bileşen yok', color: '#4fab59' },
  out: { name: 'Söner', desc: 'O₂ < LOI aralığı', color: '#7fb6d8' },
  edge: { name: 'Sınırda', desc: 'O₂, LOI aralığının içinde', color: '#e3cf45' },
  burn: { name: 'Yanar', desc: 'O₂ ≥ LOI aralığının üstü', color: '#d42a1d' },
  ox: { name: 'Oksitleyici', desc: 'O₂ taşır ya da üretir: çevresini zenginleştirir', color: '#b05cd6' },
};

/** Tek başına modellerde seviye yoksa simülasyon sınıfından (kabin modeliyle aynı eşleme) */
const SIM_CLASS_LEVEL = {
  inert_metal: 0, sondurucu_CO2: 0, sondurucu_cikis: 1, polimer_conta: 1, polimer_yalitim: 1,
  polimer_hortum: 2, yanici_polimer: 2, oksijen_hatti: 3, oksijen_kaynagi: 3, yanici_kontaminant: 3,
};

/* ------------------------------------------------------------------ */
/* Malzeme tablosu                                                      */
/* ------------------------------------------------------------------ */
/* re: "malzeme" metninde aranan desen. loi: [alt, üst] % O₂ (yaklaşık).
 * Bileşik malzemelerde ("Al + kaucuk kayis") eşleşen en düşük LOI alınır.
 * pbr: gerçekçi görünüm (doğrusal albedo, pürüzlülük, metalik)            */
const MATS = [
  { id: 'latex', re: /lateks/i, name: 'Doğal kauçuk lateks', loi: [17, 19], pbr: [0.62, 0.48, 0.22, 0.75, 0] },
  { id: 'paper', re: /ka[gğ][iı]t|atik/i, name: 'Kâğıt / selüloz', loi: [18, 19], pbr: [0.78, 0.76, 0.72, 0.85, 0] },
  { id: 'cotton', re: /pamuk/i, name: 'Pamuk', loi: [18, 19], pbr: [0.74, 0.72, 0.68, 0.9, 0] },
  { id: 'fabric', re: /kuma[sş]|g[iı]da/i, name: 'Kumaş, gıda ambalajı', loi: [18, 21], pbr: [0.66, 0.62, 0.54, 0.85, 0] },
  { id: 'polyester', re: /polyester/i, name: 'Polyester', loi: [20, 22], pbr: [0.42, 0.45, 0.52, 0.85, 0] },
  { id: 'rubber', re: /ka[uü][cç]uk/i, name: 'Kauçuk', loi: [18, 26], pbr: [0.025, 0.025, 0.028, 0.75, 0] },
  { id: 'nylon', re: /naylon/i, name: 'Naylon (PA)', loi: [21, 25], pbr: [0.72, 0.7, 0.64, 0.8, 0] },
  { id: 'plastic', re: /plastik|polimer/i, name: 'Plastik (genel)', loi: [18, 26], pbr: [0.06, 0.065, 0.075, 0.5, 0] },
  { id: 'liion', re: /li-?iyon/i, name: 'Li-iyon pil', loi: [18, 26], pbr: [0.06, 0.065, 0.075, 0.5, 0], note: 'Isıl kaçakta kendi ısısını ve yanıcı gazını üretir; ortam O₂’sinden bağımsız tutuşabilir.' },
  { id: 'elec', re: /elektronik|lcd|tu[sş] tak/i, name: 'Elektronik (PCB, kablo, kasa)', loi: [20, 30], pbr: [0.045, 0.05, 0.055, 0.42, 0] },
  { id: 'pc', re: /polikarbonat|\bpc\b/i, name: 'Polikarbonat', loi: [25, 27], pbr: [0.78, 0.8, 0.82, 0.2, 0] },
  { id: 'motor', re: /motor/i, name: 'Elektrik motoru sargısı', loi: [22, 30], pbr: null },
  { id: 'nomex', re: /nomex/i, name: 'Nomex (aramid)', loi: [28, 30], pbr: [0.7, 0.66, 0.54, 0.9, 0] },
  { id: 'kapton', re: /kapton/i, name: 'Kapton (poliimid)', loi: [37, 46], pbr: [0.62, 0.36, 0.08, 0.35, 0] },
  { id: 'ptfe', re: /ptfe/i, name: 'PTFE (Teflon)', loi: [95, 95], pbr: [0.82, 0.82, 0.78, 0.4, 0] },
];
// Yanmaz malzemeler (görünüm ve not)
const INERT = [
  // Burun ısı koruması (Orbiter): takviyeli karbon-karbon başlık, siyah silika karo (karın), beyaz karo (üst)
  { id: 'rcc', re: /rcc/i, name: 'Takviyeli karbon-karbon (RCC)', pbr: [0.045, 0.045, 0.05, 0.38, 0], note: 'Burun başlığı: yeniden girişte ~1650 °C’ye dayanır. Yanmaz.' },
  { id: 'hrsi', re: /hrsi/i, name: 'Silika ısı kalkanı karosu (HRSI, siyah)', pbr: [0.022, 0.022, 0.025, 0.55, 0], note: 'Yüksek sıcaklık yüzey yalıtımı: karın ve burun. Yanmaz.' },
  { id: 'lrsi', re: /lrsi/i, name: 'Silika ısı kalkanı karosu (LRSI, beyaz)', pbr: [0.74, 0.75, 0.76, 0.72, 0], note: 'Düşük sıcaklık yüzey yalıtımı: gövde üstü. Yanmaz.' },
  { id: 'brass', re: /pirin[cç]/i, name: 'Pirinç', pbr: [0.82, 0.62, 0.3, 0.32, 1], note: 'Oksijen sistemlerinde tercih edilir: saf O₂’de bile tutuşmaya dirençlidir.' },
  { id: 'ss', re: /paslanmaz/i, name: 'Paslanmaz çelik', pbr: [0.56, 0.57, 0.58, 0.28, 1], note: 'Kabin basınçlarında yanmaz; yüksek basınçlı saf O₂’de ince kesitler yanabilir (NASA-STD-6001 Test 17).' },
  { id: 'steel', re: /[cç]elik/i, name: 'Çelik', pbr: [0.5, 0.51, 0.53, 0.32, 1], note: 'Kabin basınçlarında yanmaz.' },
  { id: 'lioh', re: /lityum hidroksit|lioh/i, name: 'Lityum hidroksit', pbr: [0.82, 0.82, 0.8, 0.7, 0], note: 'CO₂ tutucu; yanmaz.' },
  { id: 'glass', re: /cam|silika/i, name: 'Cam', pbr: [0.02, 0.035, 0.05, 0.06, 0], glass: true },
  { id: 'honey', re: /bal pete/i, name: 'Alüminyum bal peteği', pbr: [0.52, 0.53, 0.53, 0.55, 0], note: 'Yanmaz.' },
  { id: 'al2219', re: /al 2219/i, name: 'Alüminyum 2219 (basınç kabuğu)', pbr: [0.6, 0.61, 0.6, 0.6, 0], note: 'Yanmaz. İç yüzey boyalı.' },
  { id: 'alcase', re: /al kutu/i, name: 'Alüminyum dolap', pbr: [0.66, 0.63, 0.55, 0.55, 0], note: 'Kutu yanmaz; içerik yanar.' },
  { id: 'al', re: /\bal\b|alumin/i, name: 'Alüminyum', pbr: [0.91, 0.92, 0.92, 0.42, 1], note: 'Kabin basınçlarında yanmaz; saf O₂’de ve yüksek basınçta yanabilir (NASA-STD-6001 Test 17).' },
];

/** Modeldeki ASCII malzeme adını okunur Türkçeye çevirir ("Paslanmaz_Celik" → "Paslanmaz çelik") */
const MAT_TR = [
  [/_/g, ' '], [/\bCelik\b/gi, 'çelik'], [/Kaucuk/gi, 'kauçuk'], [/Pirinc/gi, 'pirinç'], [/Kagit/gi, 'kâğıt'],
  [/kumas/gi, 'kumaş'], [/gida/gi, 'gıda'], [/tasir/gi, 'taşır'], [/yalitim/gi, 'yalıtım'], [/kopuk/gi, 'köpük'],
  [/kilif/gi, 'kılıf'], [/kapli/gi, 'kaplı'], [/atik/gi, 'atık'], [/tus takimi/gi, 'tuş takımı'], [/kayis/gi, 'kayış'],
  [/bal pete\b/gi, 'bal peteği'], [/Silika cam/gi, 'Silika cam'], [/Lityum/gi, 'Lityum'], [/\bAl kutu\b/g, 'Al kutu'],
  [/icerik/gi, 'içerik'], [/regulator/gi, 'regülatör'], [/isi kalkani/gi, 'ısı kalkanı'], [/karosu/gi, 'karosu'], [/cerceve/gi, 'çerçeve'], [/basligi/gi, 'başlığı'], [/Beyaz/g, 'Beyaz'], [/Seramik/g, 'Seramik'], [/\bO2\b/g, 'O₂'], [/\bN2\b/g, 'N₂'],
];
FL.prettyMaterial = function (s) {
  let t = String(s || '');
  for (const [a, b] of MAT_TR) t = t.replace(a, b);
  t = t.replace(/\bAluminyum\b/g, 'Alüminyum').replace(/\bAl\b(?! kutu)/g, 'Al');
  return t.charAt(0).toUpperCase() + t.slice(1);
};

/** Bir parçanın malzeme bilgisini çözer */
FL.materialInfo = function (malzeme, sim) {
  const s = malzeme || '';
  const fuels = MATS.filter((m) => m.re.test(s));
  let worst = null;
  for (const m of fuels) if (!worst || m.loi[0] < worst.loi[0]) worst = m;
  const inert = INERT.find((m) => m.re.test(s)) || null;
  const oxidizer = /O2 ta[sş][iı]r/i.test(s) || sim === 'oksijen_hatti' || sim === 'oksijen_kaynagi';
  const sfog = sim === 'oksijen_kaynagi';
  let note = (worst && worst.note) || (inert && inert.note) || '';
  if (oxidizer) {
    note = sfog
      ? 'Katı yakıtlı oksijen mumu (ör. sodyum klorat / lityum perklorat): ısıtıldığında O₂ açığa çıkarır; çevresindeki yağ, lateks ya da toz gibi kirleticiler bu oksijende kolayca tutuşur.'
      : 'Boru metali kabin basıncında yanmaz; tehlike, sızıntıda çevredeki O₂ yüzdesinin yükselmesi ve yüksek basınçlı O₂’de hızlı sıkışma ya da parçacık çarpmasıyla tutuşmadır (bu yüzden O₂ hatlarında pirinç vana ve PTFE conta kullanılır).';
  }
  return {
    text: s,
    label: FL.prettyMaterial(s),
    fuels,
    loi: worst ? worst.loi : null,
    fuelName: worst ? worst.name : null,
    inert,
    oxidizer,
    sfog,
    note,
    pbr: (fuels.find((m) => m.pbr) || {}).pbr || (inert ? inert.pbr : null),
    glass: !!(inert && inert.glass) && !fuels.length,
  };
};

/** Seviye: extras.yanicilik_seviyesi, yoksa simülasyon sınıfı */
FL.partLevel = function (extras) {
  if (extras && Number.isFinite(extras.yanicilik_seviyesi)) return extras.yanicilik_seviyesi;
  if (extras && extras.sim_sinifi in SIM_CLASS_LEVEL) return SIM_CLASS_LEVEL[extras.sim_sinifi];
  return 0;
};

/**
 * Ortam O₂ yüzdesinde parça ne yapar?
 *   ox   : oksitleyici (O₂ hattı, O₂ kaynağı) — yakıt değil, tehlike çevresinde
 *   none : yanıcı bileşen yok
 *   out / edge / burn : LOI aralığına göre
 */
FL.flamVerdict = function (info, o2) {
  if (info.oxidizer) return 'ox';
  if (!info.loi) return 'none';
  if (o2 < info.loi[0]) return 'out';
  if (o2 < info.loi[1]) return 'edge';
  return 'burn';
};

/** Görünüm için grup adı: "Dolap_R3_C5" → "Dolap", "Hortum.001" → "Hortum", "Anahtar_F12" → "Anahtar" */
FL.partGroupName = function (name) {
  return name
    .replace(/\.\d+$/, '')
    .replace(/_R\d+_C\d+$/, '')
    .replace(/_[A-Z]?\d+$/, '')
    .replace(/_(Sol|Sag|Ust|Alt|SolUst|SolAlt|SagUst|SagAlt|L|R)$/, '');
};

/** Görünür ad: alt çizgileri boşluk yap, Türkçe karakterleri geri getir (yaygın sözcükler) */
const TR = [
  [/Sondurucu/g, 'Söndürücü'], [/Ureteci/g, 'Üreteci'], [/Kartus/g, 'Kartuş'], [/Govde/g, 'Gövde'], [/Kelepce/g, 'Kelepçe'],
  [/Cikis/g, 'Çıkış'], [/Giris/g, 'Giriş'], [/Atesle/g, 'Ateşle'], [/Atesleyici/g, 'Ateşleyici'], [/Tup/g, 'Tüp'],
  [/OrtaGuverte/g, 'Orta güverte'], [/UcusGuverte/g, 'Uçuş güvertesi'], [/\bO2\b/g, 'O₂'], [/\bN2\b/g, 'N₂'], [/Ucus/g, 'Uçuş'], [/Guverte/g, 'Güverte'], [/Dosem/g, 'Döşem'], [/Gecis/g, 'Geçiş'], [/Bolme/g, 'Bölme'],
  [/Cerceve/g, 'Çerçeve'], [/Civata/g, 'Cıvata'], [/Isik/g, 'Işık'], [/Cop/g, 'Çöp'], [/Torba/g, 'Torba'],
  [/Kopuk/g, 'Köpük'], [/Kucak/g, 'Kucak'], [/Basinc/g, 'Basınç'], [/Hatti/g, 'Hattı'], [/Yukseltici/g, 'Yükseltici'],
  [/Cek_Valfi/g, 'Çek valfi'], [/Blogu/g, 'Bloğu'], [/Baglanti/g, 'Bağlantı'], [/Dedektoru/g, 'Dedektörü'], [/Firin/g, 'Fırın'],
  [/Kapagi/g, 'Kapağı'], [/Kanali/g, 'Kanalı'], [/Ayirici/g, 'Ayırıcı'], [/Fani/g, 'Fanı'], [/Deposu/g, 'Deposu'],
  [/Tanki/g, 'Tankı'], [/Iskele/g, 'İskele'], [/Duvari/g, 'Duvarı'], [/On_/g, 'Ön_'], [/Tabani/g, 'Tabanı'],
  [/Zemini/g, 'Zemini'], [/Burun/g, 'Burun'], [/Karin/g, 'Karın'], [/Ust/g, 'Üst'], [/Cati/g, 'Çatı'], [/Pencere/g, 'Pencere'], [/Dikmeleri/g, 'Dikmeleri'], [/Kasi/g, 'Kaşı'], [/Kas_Rafi/g, 'Kaş rafı'], [/Rafi/g, 'Rafı'], [/Derzleri/g, 'Derzleri'], [/Tekerlek/g, 'Tekerlek'], [/Kapisi/g, 'Kapısı'], [/Cizgisi/g, 'Çizgisi'], [/Portlari/g, 'Portları'], [/Birlesim/g, 'Birleşim'], [/Halkasi/g, 'Halkası'], [/Kenar/g, 'Kenar'], [/Profili/g, 'Profili'], [/Seffaf/g, 'Şeffaf'], [/Gövde/g, 'Gövde'], [/Kontaminant/g, 'Kirletici'], [/Lateks/g, 'lateks'],
];
FL.partLabel = function (name) {
  let s = FL.partGroupName(name);
  for (const [a, b] of TR) s = s.replace(a, b);
  return s.replace(/_/g, ' ').replace(/\bO2\b/g, 'O₂').replace(/\bN2\b/g, 'N₂').replace(/\s+/g, ' ').trim();
};
