# Cookie Launcher 🍪 (Tauri v2 · v3.1.0)

Açık kaynak, hafif ve modern bir **Minecraft: Java Edition** başlatıcısı — Tauri (Rust) kabuk + Python çekirdek.

---

## ✨ Özellikler

- **🎨 Özgün Tasarım Sistemi:** Kalıcı sol rail navigasyonu, cam (glassmorphism) yüzeyler, amber/karanlık tema, akıcı mikro animasyonlar ve AA kontrast.
- **⚡ Hafif Mimarî (ölçüm iddiası yok):** Electron/Chromium paketi yoktur; arayüz işletim sisteminin kendi webview'inde (Tauri/Rust) çalışır, indirme ve başlatma işleri hafif bir Python çekirdeğine aittir. Reklam ve telemetri içermez.
- **🌐 Dahili Modrinth Mağazası:**
  - Canlı arama, kategori filtreleri (Modlar, Shaderlar, Doku Paketleri, Modpackler).
  - Yüksek çözünürlüklü mod logoları, indirme & beğeni sayaçları.
  - Tek tıkla otomatik bağımlılık çözümlü indirme.
  - Sürüm inceleme modalı.
- **🚀 Akıllı Oyun Motoru:**
  - Tüm resmi sürümler (900+) ve 5 yükleyici: Vanilla, NeoForge, Forge, Fabric, Quilt.
  - Otomatik önerilen yükleyici sürümü + gelişmiş sürüm seçimi.
  - Eksik veya bozuk dosyaları (JAR, kütüphane, doku) otomatik algılayıp indirme.
  - Java kurulu olmayan sistemler (Windows / Linux) için Mojang'ın resmi Java ortamını otomatik kurma.
  - Otomatik FullBright (gece görüşü / daimi aydınlık) ayarı.
  - RAM slider'ı (2 GB - 16 GB).
- **📦 Yüklü İçerik Yöneticisi:**
  - Modları, dokuları ve shaderları tek tıkla devre dışı bırakma (.disabled) veya silme.
  - Klasörleri doğrudan işletim sistemi dosya yöneticisinde açma.
- **📜 Canlı Terminal / Konsol:**
  - Oyunun tüm Java çıktılarını ve çökme raporlarını gerçek zamanlı izleme.

---

## 🚀 Çalıştırma

### Hızlı Başlatma (Hemen Kullan):
```bash
cd cookie-launcher-tauri
./start.sh
# veya
python3 launch.py
```

### Tauri Olarak Yerel Derleme & Geliştirme:
```bash
cd cookie-launcher-tauri
npm install
npm run tauri:dev
```

### Standart Kurulum Paketi Oluşturma (.exe / .deb / .rpm / .AppImage / .dmg):
```bash
npm run tauri:build
```
Windows üzerinde `cookie-launcher.exe` veya Linux üzerinde bağımsız paket üretir.

> Windows setup dosyası, Python gerektirmeden çalışan gömülü çekirdeği (PyInstaller ile derlenen `cookielauncher-core.exe`) içerir. Otomatik derleme `.github/workflows/release.yml` üzerinden yapılır.

---

## 📁 Proje Yapısı

```
cookie-launcher-tauri/
├── backend/server.py        # Python çekirdek (HTTP API, indirme, başlatma)
├── src/                     # Vanilla JS / HTML / CSS arayüz
├── src-tauri/               # Tauri (Rust) kabuğu, capabilities ve derleme ayarları
└── .github/workflows/       # Windows / Linux / macOS otomatik derleme
```

---

---

## 🆕 v3.1 Öne Çıkanlar

- **"Cocoa Workshop" arayüzü:** cam efektleri ve emoji ağırlıklı görünüm yerine
  koyu çikolata zemin, krem tipografi, amber vurgu ve ince çizgili bir masaüstü dili.
- **Tam yeniden düzenlenen Oyna ekranı:** aktif profil, son dünyalar, hızlı klasör
  eylemleri ve sistem durumu tek bakışta.
- **Profil arama / sıralama:** ada, mod sayısına veya son oynanma zamanına göre filtrele.
- **Gerçek galeri:** ekran görüntüleri küçük resim olarak yüklenir; tıklayınca büyütülür.
- **Konsol araçları:** panoya kopyala, `.log` olarak dışa aktar, otomatik kaydırmayı kapat.
- **Klavye kısayolları:** `Ctrl+1–5` sekmeler, `Ctrl+K` arama, `Enter` başlat, `?` yardım.
- **Güvenlik ve dayanıklılık:** loopback API için origin/Host doğrulaması, gövde boyutu
  sınırı, güvenli dosya adı/symlink kontrolleri, atomik profil yazımı ve yarım kalan
  kurulumların açılışta kurtarılması.

## 🆕 v3.0 Öne Çıkanlar

- **12 sekmeli profil detayı:** Günlük, Sürüm, Modrinth, Modlar, Kaynak Paketleri,
  Shader Paketleri, Notlar, Dünyalar, Sunucular, Ekran Görüntüleri, Ayarlar, Diğer kayıtlar.
- **Mod detay çekmecesi:** Modrinth açıklaması, kategoriler, sürüm geçmişi ve bağımlılıklar.
- **Shader mağazası:** Görsel kartlarla Modrinth'ten tek tıkla shader kurulumu.
- **Sürüm değiştir:** Kurulu bir modun istenen sürümüne geçme; profile uyumsuz sürümler gizlenir.
- **Bağımlılık çözücü:** Zorunlu bağımlılıklar (ör. Fabric API) otomatik kurulur; kurulu modlar
  SHA1 hash ile Modrinth'e sorularak tanınır, yanlış "eksik bağımlılık" uyarısı üretilmez.
- **İzole profiller, modpack → ikonlu otomatik profil, canlı indirme ilerlemesi (yüzde + MB).**

## 🌍 Platformlar ve Uyarılar

- **Windows:** Kurulum (.exe) — gömülü çekirdek sayesinde Python gerekmez.
- **Linux:** AppImage / .deb / .rpm.
- **macOS:** .dmg (Apple Silicon + Intel) — **deneysel ve imzasız**. Apple Developer üyeliği
  (99 $/yıl) karşılanamadığı için notarize edilmemiştir. **Sağ tık → Aç macOS 15+ üzerinde artık
  çalışmaz**; ya `xattr -dr com.apple.quarantine /Applications/CookieLauncher.app` komutunu
  çalıştırın ya da Sistem Ayarları → Gizlilik ve Güvenlik → "Yine de Aç" deyin. Kaynak koddan
  kendiniz de derleyebilirsiniz (GPL-3.0).
- Reklam ve telemetri yoktur; site ve uygulama hiçbir kişisel veri toplamaz.
- Minecraft, Mojang Synergies AB'nin ticari markasıdır. Bu proje Mojang/Microsoft veya
  Fabric/Forge/NeoForge/Quilt/Modrinth ile bağlantılı, sponsorlu ya da onaylı değildir;
  hiçbir oyun dosyası dağıtmaz.

## 📄 Lisans

Bu proje **GNU GPL-3.0** lisansı ile açık kaynak olarak dağıtılmaktadır. Detaylar için [LICENSE](LICENSE) dosyasına bakın.
