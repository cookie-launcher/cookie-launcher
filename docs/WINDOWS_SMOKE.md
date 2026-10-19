# Windows Smoke Test — CL1 + Noise

Bu kontrol listesi iki Windows makinesinde (veya bir Windows + bir Linux)
çalıştırılmalıdır. Linux CI'da backend/Tauri derlemesi doğrulanır; Windows
WebView2, deep-link ve `bore.exe` davranışı burada elle test edilir.

## 1. Build / kurulum

- GitHub Actions `Release & Build Setup.exe` (workflow_dispatch veya tag) ile
  Windows setup üret.
- `pip install ... noiseprotocol` adımı release workflow'da mevcut.
- Kurulumdan sonra `%LOCALAPPDATA%\CookieLauncher\bin\bore.exe` oluşmalı.
- İlk açılışta Windows Defender/SmartScreen onayı gerekebilir.

## 2. Host

1. Arkadaşlar sekmesi → **Dünyayı paylaş**.
2. Relay otomatik başlamalı; `bore.pub:PORT` ve **Davet kodu** görünmeli.
3. `CL1-...` kodu kısa formatta olmalı (Worker varsayılanı).
4. Kodu kopyala; Discord/WhatsApp'a gönder.
5. Minecraft'ta dünyayı LAN'a aç; port alanı doğru olmalı.

## 3. Friend

1. Kodu **Daveti uygula** alanına yapıştır veya panoya kopyalayıp pencereye dön.
2. “Panoda davet bulundu” banner'ı çıkmalı; **Uygula**.
3. Arkadaşlık isteği host'a gitmeli; host kabul etmeli.
4. Davet kartında dünya görünmeli → **Dünyaya katıl**.
5. Minecraft `quickPlayMultiplayer` ile yerel portta açılmalı.
6. Host tarafında “guest joined” olayı görülmeli.

## 4. Deep link / single instance

- `cl://join/CL1-...` linkine tıkla.
- Launcher zaten açıksa yeni pencere açılmamalı; mevcut pencere Arkadaşlar
  sekmesinde davet banner'ını göstermeli.
- Launcher kapalıysa açılıp daveti göstermeli.

## 5. Fallback

- Worker'ı geçici olarak devre dışı bırak / URL'yi boşalt.
- Host tekrar paylaşsın: uzun `CL1-ey...` kodu üretilmeli; paylaşım çalışmalı.
- Worker URL'sini geri koy; yeni paylaşımda kısa kod dönmeli.

## 6. Noise doğrulama

Kullanıcıya görünen bir “şifreli” göstergesi yok; şu davranışlar beklenir:

- Bağlantı kurulurken Minecraft birkaç saniye gecikebilir (Noise el sıkışması).
- Yanlış/yabancı bir istemci tünel portuna bağlanırsa Minecraft'a ulaşamaz.
- Host log'unda Noise kimlik doğrulama hatası görülürse bağlantı reddedilir.
- `bore.pub` tarafında yalnızca şifreli byte'lar akar; paket yakalayıcıda
  `ECHO:` veya Minecraft paketi görünmemeli.

## 7. Windows'a özgü teknik kontroller

- **Job Object:** Rust, backend sürecini `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`
  işaretli bir job'a atar. Launcher kapanır/çökerse backend ve onun `bore.exe`
  çocukları da kapanır. Yine de Görev Yöneticisi'nde `bore.exe` kalmadığını
  kontrol et.
- **Registry:** `HKCU\Software\Classes\cl` altında komut
  `"C:\...\CookieLauncher.exe" "%1"` biçiminde yazılır; `%1` tırnaklıdır.
  Derin link testinde yol boşluk içeren bir klasörde olmalı.
- **Firewall:** Launcher'ın kendi soketleri `127.0.0.1` üzerine bind olur;
  `0.0.0.0` dinlemez. Windows güvenlik duvarı pop-up'ı çıkarsa launcher değil,
  Minecraft veya başka bir süreç için olabilir.
- **PyInstaller:** `noise` ve `noiseprotocol` hidden import/collect ile paketlenir;
  `cryptography` cffi `.pyd` dosyaları PyInstaller hook'u tarafından toplanır.
- **CI:** `.github/workflows/windows-smoke.yml` Windows'ta backend testlerini,
  `cargo check`'i ve PyInstaller core'un `/api/health` yanıtını çalıştırır.

## 8. Bilinen sınırlar

- Windows'ta gerçek iki makine testi bu depoda otomatik değildir.
- `%LOCALAPPDATA%` yolu ve portable ZIP farklı olabilir; portable sürümde
  backend yanında `bore.exe` aranır.
- SmartScreen imzasız build uyarısı verir.
