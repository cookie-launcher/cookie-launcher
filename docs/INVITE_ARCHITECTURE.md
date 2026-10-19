# CL1 Davet Mimarisi — tasarım notu

> **Durum:** 1 + 2 + 3 + 4 uygulandı: `invite_code.py`, uzun/kısa CL1 kodu,
> web fallback, panodan yakalama (arboard), `cl://` deep link/single-instance,
> CLT1 binary HMAC handshake, Worker heartbeat/kısa kod, Noise_XX uçtan uca
> şifreleme ve guest kimliğinin Noise son mesajına bağlanması. Worker
> deploy'u Cloudflare hesabı gerektirir; deploy edilmezse uzun kod fallback
> otomatik devrede kalır.

Bu not; davet paylaşımını platform bağımsız hale getirmek, dinamik bore portunu
sabit bir oda koduna bağlamak ve açık TCP tünelini botlara karşı token'lı
handshake ile kapatmak için önerilen yapıyı anlatır.

> Kısa özet: **Kısa oda kodu + küçük rendezvous Worker + token'lı TCP handshake.**
> Worker hesaplama açısından stateless'tir; yalnızca `room_id -> {control,tunnel}`
> eşlemesini kısa TTL ile KV'de tutar. Worker yoksa uzun (endpoint gömülü) kod
> fallback olarak çalışır.

---

## 1. Davet formatları

### 1.1 Kısa kod (önerilen, Worker ile)

```text
CL1-<room_id 13 base32>-<session_id 7 base32>-<expires 8 hex>
CL1-7QK2M9X4B1C3D-9F3A2C7-66B2A1F0
```

| Alan | Uzunluk | Anlam |
| --- | --- | --- |
| `room_id` | 13 base32 | Host'un kalıcı odası; Worker anahtarı. 8 rastgele bayt. |
| `session_id` | 7 base32 | Bu dünya oturumu; relay'de açık oturum. 4 rastgele bayt. |
| `expires` | 8 hex | Unix epoch; davet son kullanma. |

Kısa kod **port içermez**. Port değişince kod değişmez; Worker güncel endpoint'i
döndürür. Kod yine de davet başına oturum/expiry taşır.

### 1.2 Uzun kod (Worker'sız / fallback)

```text
CL1-<base64url(JSON)>
```

```json
{
  "v": 1,
  "rid": "7QK2M9X4B1C3D",
  "sid": "9F3A2C7",
  "exp": 1792430440,
  "relay": { "h": "bore.pub", "c": 25641, "t": 7476 },
  "host_name": "emre",
  "host_code": "H8N9-6JAT",
  "world": "Arkadaşlarla Hayatta Kalma"
}
```

Uzun kod portu içerdiği için port değişince yeniden üretilir; Worker/rendezvous
yoksa tek seçenek budur. JSON + base64url okunabilirlik/statik web fallback için
yeterlidir; ileride CBOR'a geçilebilir.

### 1.3 Taşıyıcılar

| Taşıyıcı | Örnek | Not |
| --- | --- | --- |
| Düz kod | `CL1-...` | Panoya/Discord'a en uygun. |
| Deep link | `cl://join/CL1-...` | Windows/macOS/Linux'ta kayıtlıysa launcher açar. |
| Web fallback | `https://cookie-launcher.github.io/join/#CL1-...` | WhatsApp/Telegram in-app tarayıcısında tıklanabilir. |
| Query fallback | `https://.../join/?c=CL1-...` | Bazı uygulamalar `#` fragment'ı bozarsa. |

Statik sayfa: [`docs/join/index.html`](join/index.html). Kod yoksa örnek/uyarı
gösterir; varsa **Launcher'da aç** ve **Kodu kopyala** sunar.

---

## 2. Akış şemaları

### 2.1 Host: relay + oda yayını

```text
[Host Launcher]
  ├─ room_id + host_key (social.json'da kalıcı)
  ├─ relay + bore başlat
  │    control_port_local, tunnel_port_local
  │    bore → control_public, tunnel_public
  ├─ PUT  https://rdv.example/v1/rooms/<room_id>
  │       Authorization: Bearer <host_key>
  │       {c:control_public, t:tunnel_public, exp:now+600}
  ├─ davet kodu üret: CL1-<room>-<session>-<exp>
  └─ panoya/Discord'a: cl://join/... + web fallback
       (her 240 sn'de heartbeat; TTL 600 sn)
```

### 2.2 Friend: kodu yakala → endpoint çöz → katıl

```text
[Friend Launcher]
  ├─ cl:// açıldı  VEYA  pencere focus'ta clipboard tarandı
  ├─ CL1 parse (kısa/uzun)
  ├─ kısa ise GET /v1/rooms/<room_id> → {c,t}
  │    (60 sn cache; 404 ise "host çevrimdışı")
  ├─ control bağlantısı: bore.pub:<c>
  │    hello/auth → friend code / oda doğrulama
  ├─ relay'den tunnel ticket al
  ├─ tunnel bağlantısı: bore.pub:<t>
  │    token'lı handshake (aşağıda)
  ├─ local TCP listener → Minecraft
  └─ Minecraft quickPlayMultiplayer 127.0.0.1:<local_port>
```

### 2.3 Clipboard yakalama

```text
Discord/WhatsApp'ta kodu kopyala
        │
        ▼
Launcher penceresine dön (focus)
        │
        ▼
navigator.clipboard.readText() / Tauri arboard
        │
        ├─ son clipboard hash'i aynıysa yoksay
        ├─ CL1 regex + parse
        └─ “Davet bulundu: emre · Dünya” → [Katıl] [Yoksay]
             (otomatik katılma yok — clipboard injection'a karşı)
```

---

## 3. Rendezvous Worker (dinamik port çözümü — uygulandı)

Kod tarafı: `backend/rendezvous.py` (heartbeat/DELETE/resolve),
`infra/rendezvous-worker.js` (Cloudflare Worker), `infra/wrangler.toml.example`.
Host relay açılınca `PUT`, 240 sn'de bir heartbeat, kapanırken `DELETE` atar.
Worker URL'i **Bağlantı → Rendezvous adresi** veya
`COOKIE_LAUNCHER_RENDEZVOUS_URL` ile verilir.

### 3.1 Neden Worker + KV?

Tamamen stateless bir kod, portu içermek zorundadır; port değişince kod da
değişir. Kısa ve sabit kodu mümkün kılan şey, `room_id -> güncel endpoint`
eşlemesidir. Worker **compute olarak stateless**, KV ise küçük ve TTL'li bir
eşleme deposudur. Cloudflare Workers/KV ücretsiz katmanı bu iş için yeterlidir.

- `room_id`: 64 bit rastgele (13 base32), davetle paylaşılır.
- `host_key`: 32 bayt rastgele, yalnızca host'ta; Worker'a yalnızca SHA-256'sı
  kaydedilir. İlk PUT'ta kaydedilir, sonraki PUT/DELETE'lerde doğrulanır.
- TTL 600 sn; heartbeat 240 sn → günde ~360 yazma (ücretsiz limite rahat sığar).
- Host çökerse eşleme en geç 10 dk içinde düşer; friend “host çevrimdışı” görür.

### 3.2 API

```http
PUT /v1/rooms/{room_id}
Authorization: Bearer <host_key>
{"v":1,"c":25641,"t":7476,"exp":1792430440}

GET /v1/rooms/{room_id}
→ {"v":1,"c":25641,"t":7476,"updated":1792429840000,"expires":1792430440}

DELETE /v1/rooms/{room_id}
Authorization: Bearer <host_key>
```

Worker örneği: [`infra/rendezvous-worker.js`](../infra/rendezvous-worker.js).
`wrangler.toml` içinde `ROOMS` KV binding'i tanımlanır.

### 3.3 Host heartbeat (Python)

```python
import requests, time

def publish(room_id, host_key, control_port, tunnel_port, base):
    requests.put(
        f"{base}/v1/rooms/{room_id}",
        json={"v": 1, "c": control_port, "t": tunnel_port,
              "exp": int(time.time()) + 600},
        headers={"Authorization": f"Bearer {host_key}"},
        timeout=5,
    ).raise_for_status()
```

Relay açıldıktan sonra hemen bir kez, sonra 240 sn'de bir çağır. Relay
kapanırken `DELETE` gönder. Friend tarafı `GET` yanıtını 60 sn cache'ler.

### 3.4 Worker yoksa

Uzun kod (`CL1-<base64(JSON)>`) kullanılır; kod içinde `relay.c/t` vardır.
Port değişince yeni kod gerekir. Kod tabanı aynı `parse()` fonksiyonuyla iki
formatı da okur.

---

## 4. Token'lı TCP handshake (bot koruması)

Mevcut relay'de tunnel tarafı JSON satırı ile token bekliyor; bu, botların
bağlantı açıp Minecraft'a kadar ilerlemesini engelliyor ama token ağ üzerinden
gidiyor ve tekrar oynatılabiliyor. Aşağıdaki binary handshake bunu düzeltir.

### 4.1 Wire format

```text
Server → Client (HELLO, 34 bayt)
  MAGIC(4)="CLT1" | VER(1)=1 | TYPE(1)=1 | SESSION_ID(8) | EXPIRES(4) | SERVER_NONCE(16)

Client → Server (AUTH, 63 bayt)
  MAGIC(4) | VER(1) | TYPE(1)=2 | SESSION_ID(8) | ROLE(1) | CLIENT_NONCE(16) | HMAC(32)

Server → Client (OK, 6 bayt)
  MAGIC(4) | VER(1) | TYPE(1)=3
```

- `HMAC = HMAC-SHA256(token, MAGIC|VER|TYPE|SESSION_ID|ROLE|SERVER_NONCE|CLIENT_NONCE)`.
- `token` 32 rastgele bayt; **control kanalında** üretilir ve yalnızca o
  bağlantıya verilir. Tunnel'da token gönderilmez, sadece HMAC gönderilir.
- Ticket: `(session_id, role) -> {token, expires, used}`; 60 sn TTL, tek kullanım.
- Handshake 3 sn içinde bitmezse bağlantı kapatılır; Minecraft'a **auth
  tamamlanmadan asla** bağlanılmaz.

### 4.2 Sunucu tarafı (Python, asyncio)

```python
import asyncio, hmac, hashlib, os, struct, time

MAGIC = b"CLT1"
VERSION = 1
HELLO, AUTH, OK = 1, 2, 3
HELLO_FMT = "!4sBBQI16s"
AUTH_FMT = "!4sBBQB16s32s"

async def tunnel_handshake(reader, writer, tickets, peer_ip):
    session_id = 0  # bu bağlantının hangi session'a ait olduğu dışarıdan gelir
    # Gerçekte session_id, kabul edilen tunnel isteğinden / URL'den alınır.
    nonce = os.urandom(16)
    expires = int(time.time()) + 60
    writer.write(struct.pack(HELLO_FMT, MAGIC, VERSION, HELLO, session_id, expires, nonce))
    await writer.drain()
    try:
        raw = await asyncio.wait_for(reader.readexactly(struct.calcsize(AUTH_FMT)), timeout=3)
    except (asyncio.TimeoutError, asyncio.IncompleteReadError):
        return None
    magic, ver, typ, sid, role, cnonce, mac = struct.unpack(AUTH_FMT, raw)
    if magic != MAGIC or ver != VERSION or typ != AUTH or sid != session_id:
        return None
    ticket = tickets.get((sid, role))
    if not ticket or ticket["used"] or ticket["expires"] < time.time():
        return None
    expected = hmac.new(
        ticket["token"],
        MAGIC + bytes([VERSION, AUTH]) + struct.pack("!Q", sid) + bytes([role]) + nonce + cnonce,
        hashlib.sha256,
    ).digest()
    if not hmac.compare_digest(mac, expected):
        return None
    ticket["used"] = True
    writer.write(MAGIC + bytes([VERSION, OK]))
    await writer.drain()
    return role  # artık raw pipe başlayabilir
```

### 4.3 İstemci tarafı

```python
import hmac, hashlib, os, socket, struct

def tunnel_auth(sock, token, session_id, role):
    hello = sock.recv(34)
    magic, ver, typ, sid, expires, nonce = struct.unpack("!4sBBQI16s", hello)
    assert magic == b"CLT1" and ver == 1 and typ == 1 and sid == session_id
    cnonce = os.urandom(16)
    mac = hmac.new(token, b"CLT1" + bytes([1, 2]) + struct.pack("!Q", session_id) + bytes([role]) + nonce + cnonce, hashlib.sha256).digest()
    sock.sendall(struct.pack("!4sBBQB16s32s", b"CLT1", 1, 2, session_id, role, cnonce, mac))
    reply = sock.recv(6)
    assert reply[:4] == b"CLT1" and reply[5] == 3
```

### 4.4 Rate limit / sertleştirme

- Global `asyncio.Semaphore(64)`; aynı anda en fazla 64 yarım handshake.
- IP başına 10 deneme/dk; başarısız handshake sayacı; aşınca 60 sn ban.
- Handshake boyunca `readexactly` + `wait_for(3s)`; yavaşloris (slowloris) yok.
- Başarılı auth'tan önce Minecraft soketine **bağlanma**.
- Ticket'lar tek kullanım; başarılı auth'tan sonra sil.
- Log'da token/HMAC yazma; sadece `session_id`, rol, IP hash'i.

### 4.5 TLS / gizlilik

HMAC handshake botları durdurur ama bore.pub üzerinden geçen token/HMAC'i pasif
dinleyen birine karşı gizlilik sağlamaz. Seçenekler:

1. Relay'i TLS ile sunmak (host'a özel self-signed cert + davet içinde
   `cert_fingerprint`; istemci pinler). Bore TCP'yi şeffaf taşıdığı için bu
   çalışır.
2. `Noise`/`WireGuard` benzeri hafif bir UDP tüneli (daha büyük iş).
3. En azından oyun trafiğinin Minecraft LAN gibi şifresiz olduğunu kabul etmek.

---

## 5. Launcher entegrasyonu (clipboard + protokol)

### 5.1 Web fallback + cl://

- `docs/join/index.html` GitHub Pages'te yayınlanır.
- `cl://` için Windows'ta `HKCU\Software\Classes\cl`, Linux'ta
  `x-scheme-handler/cl`, macOS'ta `CFBundleURLTypes` kaydı gerekir.
- WhatsApp/Telegram in-app tarayıcı `cl://`'yi engellerse sayfa kodu kopyalatır;
  kullanıcı launcher'a dönünce clipboard taraması yakalar.

**Windows kayıt örneği:**

```reg
Windows Registry Editor Version 5.00

[HKEY_CURRENT_USER\Software\Classes\cl]
@="URL:Cookie Launcher Protocol"
"URL Protocol"=""

[HKEY_CURRENT_USER\Software\Classes\cl\shell\open\command]
@="\"C:\\Program Files\\CookieLauncher\\CookieLauncher.exe\" \"%1\""
```

**Linux `.desktop`:**

```ini
[Desktop Entry]
Name=Cookie Launcher
Exec=/opt/cookie-launcher/cookie-launcher %u
MimeType=x-scheme-handler/cl;
NoDisplay=true
```

**macOS `Info.plist`:**

```xml
<key>CFBundleURLTypes</key>
<array>
  <dict>
    <key>CFBundleURLName</key><string>com.cookielauncher.join</string>
    <key>CFBundleURLSchemes</key><array><string>cl</string></array>
  </dict>
</array>
```

Tauri'de `src-tauri/tauri.conf.json` / platform paketleyicisi bu kayıtları
üretmeli; geliştirme sırasında `register_uri_scheme_protocol` veya installer
hook'u kullanılabilir.

### 5.2 Clipboard taraması (JS)

```js
const CL1_RE = /CL1-[A-Za-z0-9_-]+/i;
let lastClipboard = "";

async function scanClipboard() {
  try {
    const text = (await navigator.clipboard.readText()).trim();
    if (!text || text === lastClipboard) return;
    lastClipboard = text;
    const m = text.match(CL1_RE);
    if (!m) return;
    const invite = await parseInvite(m[0]); // kısa ise Worker GET
    showInviteBanner(invite); // otomatik katılma yok
  } catch (_) { /* izin yoksa sessizce geç */ }
}

window.addEventListener("focus", scanClipboard);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) scanClipboard();
});
```

Tauri WebView'de `navigator.clipboard.readText()` kısıtlıysa Rust komutu:

```rust
#[tauri::command]
fn read_clipboard() -> Result<String, String> {
    let mut cb = arboard::Clipboard::new().map_err(|e| e.to_string())?;
    cb.get_text().map_err(|e| e.to_string())
}
```

```js
const text = await window.__TAURI__.core.invoke("read_clipboard");
```

Güvenlik: clipboard'dan gelen kodu **otomatik çalıştırma**; kullanıcıya
“Davet bulundu — Katıl/Yoksay” göster. Aynı kodu tekrar gösterme.

---

## 6. Değerlendirme ve sıra

| Adım | Çözdüğü | Efor | Not |
| --- | --- | --- | --- |
| 1. CL1 + kopyala/panoya yakala + statik fallback | Elle port/host girme | Düşük | Hemen yapılabilir. |
| 2. Token'lı binary handshake + rate limit | Bot/port tarama | Orta | Minecraft'a auth'suz bağlantı yok. |
| 3. Worker + KV + heartbeat | Dinamik port | Orta | Kısa kod sabit kalır; Worker bağımlılığı. |
| 4. Noise_XX | Uçtan uca gizlilik | Yüksek | **Uygulandı**: host key pinning + framed ChaCha20-Poly1305. |
| 5. STUN/hole-punching | bore gecikme/bant | Yüksek | Ayrı proje; TCP NAT sorunları. |

**Sonuç:** 1–3 birlikte, “Aternos yerine” iddiasını teknik olarak ayakta tutar:
kullanıcı tek kod yapıştırır, port değişse bile çalışır, botlar Minecraft'a
ulaşamaz. 4 olmadan bore.pub trafiği şifresiz kalır; 5 olmadan bore bağımlılığı
ve host upload'u devam eder. Öncelik sırası: **1 → 2 → 3 → 4**.
