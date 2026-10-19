# CL1 Rendezvous Worker

Kısa `CL1-ROOM-SESSION-EXP` kodları için `room_id -> {h,c,t}` eşlemesini
Cloudflare KV'de TTL'li tutar. Worker hesaplama açısından stateless'tir.

## Deploy

```bash
cd infra
npm install -D wrangler
npx wrangler login
npx wrangler kv namespace create ROOMS
cp wrangler.toml.example wrangler.toml
# wrangler.toml içindeki id'yi doldur
npx wrangler deploy
```

Çıkan `https://cookie-launcher-rendezvous.<account>.workers.dev` adresini:

- Host launcher: **Arkadaşlar → Bağlantı → Rendezvous adresi**
- Arkadaş launcher: aynı alan
- veya `COOKIE_LAUNCHER_RENDEZVOUS_URL` ortam değişkeni
- veya `backend/config.py` içindeki `DEFAULT_RENDEZVOUS_URL`

alanına yaz. `config.py` varsayılanı boşsa uzun kod kullanılır. Alan boşsa launcher uzun `CL1-...` koduna düşer; Worker kesintisi
oyun paylaşımını durdurmaz.

## API

```http
PUT    /v1/rooms/{room_id}   Authorization: Bearer <host_key>
GET    /v1/rooms/{room_id}
DELETE /v1/rooms/{room_id}   Authorization: Bearer <host_key>
```

- İlk PUT `host_key` hash'ini kaydeder; sonraki PUT/DELETE'ler aynı anahtarı ister.
- KV TTL 600 sn; host 240 sn'de bir heartbeat atar.
- `GET` yanıtı `cache-control: no-store`; KV okuması minimum 30 sn cacheTtl
  kullanır (Cloudflare minimumu).
- Host kapanırken DELETE gönderilir; ulaşmazsa kayıt en geç 10 dk içinde düşer.
