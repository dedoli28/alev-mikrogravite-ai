# Arayüz teması — "Ölçüm aleti"

Arayüz bir laboratuvar cihazının ön paneli gibi davranır: sakin, opak, tek amaçlı. Alev ekranın
tek parlak öğesidir; arayüz ona eşlik eder, onunla yarışmaz. Süs için gradyan, parlama (glow),
cam bulanıklığı ya da büyüyüp küçülen düğme kullanılmaz.

## Renkler

| Ad | Değer | Kullanım |
|---|---|---|
| Zemin | `#0a0b0d` | Sahne arkası, açılış ekranı |
| Pencere | `#0f1012` | Pencere zemini |
| Çubuk | `#131417` | Üst araç çubuğu |
| Panel | `#141518` | Ayrıntılı ayarlar çekmecesi |
| Yüzey | `#1a1b1f` | Açılır listeler, iletişim kutuları |
| Denetim | `#1f2125` / `#272a2f` | Düğme, seçim kutusu (normal / üzerinde) |
| Metin | `#e7e8eb` | Birincil; ikincil `#a4a8b0`, üçüncül `#737882` |
| Ayırıcı | `rgba(255,255,255,.07)` | Kılcal çizgiler, 1 px kenarlar |
| **Mavi** | `#4f86f7` | Denetim: seçim, odak halkası, kaydırıcı, değiştirilmiş değer noktası |
| **Kor** | `#e98a3a` | Isı: Ateşle, HRR serisi, alev durum noktası |
| Uyarı | `#e0534a` | Söndürme jeti etkin, hata |
| Soğuk alev | `#5cb8d6` | Düşük sıcaklık kimyası |

Kural: mavi "denetim", kor "ısı" demektir; üçüncü bir vurgu rengi eklenmez.
Veri görselleri (termal, sıcaklık vb.) bilimsel renk haritalarını kullanır, tema renklerini değil.

## Yazı

- **Inter** (değişken) — tüm arayüz metni, 13 px / 1,45. Başlıklar 600, etiketler 500 ağırlık.
- **JetBrains Mono** — yalnız sayısal okumalar (ölçüm şeridi, zaman kodu, değer kutuları).

Büyük harf etiket ve açılmış harf aralığı kullanılmaz.

## Yerleşim

- **Sol panel** temel denetimleri taşır: Ateşle, Söndür, CO₂ · Kaynak, Konum, Yerçekimi, Görünüm ·
  Grafik, Ayarlar. Her düğme yuvarlak bir simge ve altında kısa bir etiketten oluşur; etiket o anki
  değeri gösterir (ör. "Uzay", "0 g", "Termal"). Seçenekli düğmeler yanda bir liste açar.
- **Ayrıntılı ayarlar** sağdan kayan bir çekmecededir ve her açılışta kapalı gelir. Çekmece
  sahnenin üzerine açılır; görüntü yeniden boyutlanmaz, kamera araçları ve grafik onunla birlikte kayar.
- **Açılış ekranı** gerçek başlatma adımlarını (grafik bağlamı, çözücü derleme, ızgara, ışın
  yürütücü, ilk kare) ince bir ilerleme çubuğuyla gösterir. Döner simge ya da animasyonlu logo yoktur.

## Biçim

- Köşe yarıçapları: 3 / 5 / 6 / 8 px (etiket / düğme / bölümlü denetim / panel). Sol panel 10 px.
- Paneller opaktır (`rgba(20,21,24,.94)`), 1 px kenar ve yumuşak bir gölge taşır.
- Kaydırıcı: 3 px iz, 13 px tutamaç; üzerine gelince ince mavi halka, sürüklerken hafif büyüme.

## Hareket

- Tek eğri: `cubic-bezier(0.2, 0, 0, 1)`. Üç süre: 120 ms (renk, üzerine gelme), 200 ms
  (bölüm açılışı, liste, sekme kaydırma), 280 ms (çekmece).
- Bölümler yüksekliklerini 0fr → 1fr ızgara geçişiyle açar; içerik sıçramaz.
- Hareket yalnız kullanıcı eylemine yanıttır; `prefers-reduced-motion` uyulur.

## İmza öğe

Araç çubuğunun altındaki **alev durumu şeridi**: 2 px'lik çizginin rengi, alevin o anki en yüksek
sıcaklığının kara cisim rengidir; söndürme jetinde kırmızı, CO₂ tüpünde soğuk beyaz, alev yokken
görünmez. Süs değil, durum göstergesidir.

Kaynak: `src/styles/app.css` içindeki `:root` değişkenleri.
