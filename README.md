# Cookie Launcher 🍪 (Tauri v2 · v4.0.0)

Açık kaynak, hafif ve modern bir **Minecraft: Java Edition** başlatıcısı — Tauri (Rust) kabuk + Python çekirdek.

---

## ✨ Özellikler

- **🎨 Özgün Tasarım Sistemi:** Kalıcı sol rail, koyu çikolata yüzeyler, krem tipografi, karamel başlatma aksiyonu, voksel cookie maskotu ve piksel wordmark; klavye kısayolları, görünür focus ve opak yüzeylerde AA kontrast.
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
- **👥 Arkadaşlar (relay gerekir):**
  - Arkadaş koduyla ekleme/çıkarma, karşılıklı istekler ve canlı çevrimiçi durum.
  - Minecraft dünyasını LAN'a açıp arkadaşlara tek tıkla davet etme.
  - Arkadaşın dünyasına `quickPlayMultiplayer` ile doğrudan katılma.
  - Oyun trafiği host'ta kalır; sadece küçük bir relay üzerinden taşınır.
  - "Dünyayı paylaş"a basınca relay yoksa **otomatik** başlar; ücretsiz `bore.pub`
    tüneli açılır, arkadaş adresi ekranda kopyalanabilir. Harici `bore.exe`
    gerekmez; tünel saf Python istemcisiyle kurulur.
  - **CL1 davet kodu**, `cl://join/...` deep link, panodan davet yakalama,
    token'lı binary TCP handshake.
  - Opsiyonel **Worker + KV** ile kısa kod: port değişse bile oda kodu sabit kalır;
    Worker yoksa uzun kod fallback.
  - **Noise_XX** uçtan uca şifreleme: host/guest Minecraft trafiği `bore.pub`
    üzerinden şifreli akar; relay sadece frame taşır.
  - **P2P öncelikli hibrit:** STUN ile UDP delme denenir; 3 sn içinde olmazsa
    otomatik olarak şifreli bore.pub relay'ine düşer.
  - Kurulum ve güvenlik: [`docs/SOCIAL.md`](docs/SOCIAL.md). Windows iki makine testi için:
[`docs/WINDOWS_SMOKE.md`](docs/WINDOWS_SMOKE.md).

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

## 👥 Arkadaşlar / Relay

Arkadaş özelliği için küçük bir relay servisi gerekir. VPS istemiyorsan
relay'i kendi bilgisayarında çalıştırıp ücretsiz `bore.pub` tüneliyle
arkadaşlarına açabilirsin: `python3 backend/share_relay.py`.
Ayrıntılar: [`docs/SOCIAL.md`](docs/SOCIAL.md). Windows iki makine testi için:
[`docs/WINDOWS_SMOKE.md`](docs/WINDOWS_SMOKE.md).

Yerel test:

```bash
python3 backend/social_relay.py --host 127.0.0.1 --control-port 19021 --tunnel-port 19022
```

Launcher'da **Arkadaşlar → Bağlantı** ekranından relay adresini girin. İnternet
üzerinden kullanırken TLS'i açın; ayrıntılar ve VPS/systemd örneği:
[`docs/SOCIAL.md`](docs/SOCIAL.md). Windows iki makine testi için:
[`docs/WINDOWS_SMOKE.md`](docs/WINDOWS_SMOKE.md).

---

## 🎨 Arayüz ve Deneyim

- **"Cocoa Craft" arayüzü:** koyu çikolata zemin, krem tipografi, karamel vurgu;
  piksel wordmark, voksel cookie maskotu ve bevel ana aksiyonlar.
  Cam efekti, mor-mavi gradyan ve yeşil başlatma düğmesi yok.
- **Tam genişlik Oyna ekranı:** profil, sürüm ve tek "Oyna" aksiyonu sinematik
  hero içinde; alt satırda son dünyalar, hızlı klasör eylemleri ve oyun ayarları.
- **Profil arama / sıralama:** ada, mod sayısına veya son oynanma zamanına göre filtrele.
- **Gerçek galeri:** ekran görüntüleri küçük resim olarak yüklenir; tıklayınca büyütülür.
- **Konsol araçları:** panoya kopyala, `.log` olarak dışa aktar, otomatik kaydırmayı kapat.
- **Klavye kısayolları:** `Ctrl+1–6` sekmeler, `Ctrl+K` arama, `Enter` başlat, `?` yardım.
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
