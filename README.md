# 🌾 Tarlam — 2B Hypercasual Çiftlik Oyunu

Tarayıcıda çalışan, yüklenebilir (PWA) bir 2B çiftlik oyunu.

## 🚀 Nasıl Oynanır?

Oyunu doğrudan tarayıcıda açmak için `index.html` dosyasını bir web sunucusunda barındırın veya aşağıdaki yöntemleri kullanın.

### Yerel Sunucu (Geliştirme)
```bash
# Python 3 ile:
python3 -m http.server 8080
# Sonra tarayıcıda: http://localhost:8080

# Node.js ile:
npx serve .
```

### GitHub Pages ile Yayınlama (Ücretsiz)
1. GitHub'da yeni bir repo oluşturun
2. Bu klasördeki tüm dosyaları yükleyin
3. Settings → Pages → Branch: main → Save
4. `https://kullanici-adiniz.github.io/tarlam` adresinden erişin

### Netlify ile Yayınlama (Ücretsiz, Sürükle-Bırak)
1. https://netlify.com'a gidin
2. "tarlam" klasörünü sürükleyip bırakın
3. Anında canlı URL alın!

## 📱 Telefona Yükleme (PWA / InstantApp)

### Android Chrome:
1. Oyunu Chrome'da açın
2. Adres çubuğundaki **"Yükle"** butonuna basın
3. Veya: Menü (⋮) → **"Ana ekrana ekle"**

### iOS Safari:
1. Oyunu Safari'de açın
2. Paylaş butonu (□↑) → **"Ana Ekrana Ekle"**

### Masaüstü Chrome/Edge:
- Adres çubuğundaki yükleme ikonuna tıklayın

## 🎮 Oyun Kontrolleri

| Kontrol | Aksiyon |
|---------|---------|
| Tıkla / Dokun | Seçili araçla işlem yap |
| WASD / Ok Tuşları | Çiftçiyi hareket ettir |
| Boşluk / Enter | Bulunduğun konumda işlem yap |
| ESC | Menüyü kapat |

**Nakliye Mini Oyunu:**
| Kontrol | Aksiyon |
|---------|---------|
| ← → / A D | Kamyon sür |
| ↑ / W / Boşluk | Zıpla |

## 🌾 Oyun Özellikleri

### Tarım
- 4 ürün: Buğday, Mısır, Domates, Havuç
- Sulama sistemi (2× büyüme hızı)
- Dinamik gece/gündüz döngüsü
- 4 mevsim sistemi

### Hava Durumu
- ☀️ Güneşli, ⛅ Bulutlu, 🌧️ Yağmurlu, ⛈️ Fırtınalı, 💨 Rüzgarlı
- Yağmurda bitkiler otomatik sulanır
- Rüzgarda yel değirmeni hızlanır

### Hayvan Sistemi (Ahır)
- 🐄 İnek → Süt üretir
- 🐑 Koyun → Yün üretir  
- 🐔 Tavuk → Yumurta üretir
- Çiftleştirme → Yavru doğumu
- Mezbaha → Et elde etme
- Canlı satış

### Görev Sistemi
- 10+ görev (hasat, hayvan besleme, nakliye vb.)
- Ödüller: Altın + XP
- Yeni görevler kilit açma sistemi

### Komşu Sistemi
- 3 komşu çiftçi rastgele ürün ister
- Her 7 günde bir yeni istekler
- Yardım karşılığı altın kazan

### Nakliye Mini Oyunu
- Sonsuz kaydıran yol
- Ürün toplama ve pazara götürme
- 90 saniye süre limiti
- Zıplama mekaniği

### Diğer
- 😴 Uyuma sistemi (hızlı yeni gün)
- 💾 Otomatik kayıt (localStorage, 30 saniyede bir)
- Seviye ve XP sistemi
- Enerji yönetimi

## 📁 Dosya Yapısı
```
tarlam/
├── index.html      ← Tüm oyun (tek dosya)
├── manifest.json   ← PWA kurulum bilgisi
├── sw.js           ← Service Worker (offline destek)
├── icon-192.png    ← Uygulama ikonu (küçük)
├── icon-512.png    ← Uygulama ikonu (büyük)
└── README.md       ← Bu dosya
```

## 🛠️ Geliştirme Notları

Oyun tamamen vanilla HTML/CSS/JS ile yazılmıştır, bağımlılık yoktur.

### Yeni Ürün Eklemek
`index.html` içindeki `CROPS` nesnesine ekle:
```js
const CROPS = {
  // ... mevcut ürünler
  pumpkin: { seedCost: 18, growTime: 80, price: 30, color: '#FF8C00', xp: 18, icon: '🎃' }
};
```

### Yeni Hayvan Eklemek
`ADEF` nesnesine ekle:
```js
const ADEF = {
  // ... mevcut hayvanlar
  pig: { name: 'Domuz', buy: 70, food: 'corn', produceItem: 'meat', sellPrice: 100, slaughterMeat: 4, gestationDays: 4, emoji: '🐷' }
};
```

### Yeni Görev Eklemek
`QUESTS_DEF` dizisine ekle.

## 📄 Lisans
MIT — özgürce paylaşabilir, değiştirebilirsiniz.
