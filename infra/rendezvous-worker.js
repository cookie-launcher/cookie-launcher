/**
 * Cookie Launcher — CL1 rendezvous Worker (Cloudflare Workers + KV)
 *
 * Amaç: host'un bore portu değişse bile davet kodundaki room_id sabit kalsın.
 * Worker hesaplama açısından stateless'tir; yalnızca küçük endpoint kaydı KV'de
 * (TTL 10 dk) tutulur.
 *
 * wrangler.toml:
 *   name = "cookie-launcher-rendezvous"
 *   main = "rendezvous-worker.js"
 *   compatibility_date = "2025-01-01"
 *   kv_namespaces = [{ binding = "ROOMS", id = "<KV_ID>" }]
 *
 * API:
 *   PUT    /v1/rooms/:roomId   Authorization: Bearer <hostKey>
 *          { "v":1, "c":25641, "t":7476, "exp":1792430440 }
 *   GET    /v1/rooms/:roomId   -> { v,c,t,updated,expires }
 *   DELETE /v1/rooms/:roomId   Authorization: Bearer <hostKey>
 */

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,PUT,DELETE,OPTIONS",
  "access-control-allow-headers": "content-type,authorization",
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store, max-age=0",
      ...CORS,
    },
  });

const enc = new TextEncoder();

async function sha256(text) {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

function roomId(path) {
  const m = path.match(/^\/v1\/rooms\/([A-Z2-7]{13})$/i);
  return m ? m[1].toUpperCase() : "";
}

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const url = new URL(req.url);
    const id = roomId(url.pathname);
    if (!id) return json({ error: "bad_room" }, 400);

    const key = `room:${id}`;
    const auth = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
    const keyHash = auth ? await sha256(auth) : "";

    if (req.method === "GET") {
      // KV cacheTtl minimum 30 sn; port değişiminin en geç 30 sn içinde
      // görünmesi için açıkça minimumu kullan.
      const value = await env.ROOMS.get(key, { type: "json", cacheTtl: 30 });
      if (!value) return json({ error: "not_found" }, 404);
      if (value.exp && value.exp < Math.floor(Date.now() / 1000)) {
        await env.ROOMS.delete(key);
        return json({ error: "expired" }, 404);
      }
      return json({ v: 1, h: value.h || "bore.pub", c: value.c, t: value.t, npub: value.npub || "", updated: value.updated, expires: value.expires });
    }

    if (!keyHash) return json({ error: "unauthorized" }, 401);

    if (req.method === "PUT") {
      if (Number(req.headers.get("content-length") || 0) > 4096) return json({ error: "too_large" }, 413);
      let body;
      try { body = await req.json(); } catch { return json({ error: "bad_json" }, 400); }
      const c = Number(body.c), t = Number(body.t);
      if (!Number.isInteger(c) || c < 1 || c > 65535 || !Number.isInteger(t) || t < 1 || t > 65535) {
        return json({ error: "bad_ports" }, 400);
      }
      const existing = await env.ROOMS.get(key, { type: "json", cacheTtl: 30 });
      if (existing && existing.keyHash && !safeEqual(existing.keyHash, keyHash)) {
        return json({ error: "forbidden" }, 403);
      }
      const value = {
        v: 1, h: String(body.h || "bore.pub").slice(0, 255), c, t,
        npub: String(body.npub || "").slice(0, 120), keyHash, updated: Date.now(),
        exp: Number(body.exp) || Math.floor(Date.now() / 1000) + 600,
      };
      await env.ROOMS.put(key, JSON.stringify(value), { expirationTtl: 600 });
      return json({ ok: true });
    }

    if (req.method === "DELETE") {
      const existing = await env.ROOMS.get(key, { type: "json", cacheTtl: 30 });
      if (existing && existing.keyHash && !safeEqual(existing.keyHash, keyHash)) {
        return json({ error: "forbidden" }, 403);
      }
      await env.ROOMS.delete(key);
      return json({ ok: true });
    }

    return json({ error: "method" }, 405);
  },
};
