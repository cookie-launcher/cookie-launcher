#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Cookie Launcher — Arkadaşlar istemcisi
======================================

Launcher backend'i içinde çalışır. Relay'e TCP ile bağlanır, sosyal
durumu tutar ve dünya davetleri için TCP tüneli açar.

Tasarım notları:
- Relay'e giden ilk kayıt dışında hiçbir zaman secret gönderilmez;
  challenge-response (HMAC-SHA256) kullanılır.
- Oyun trafiği relay üzerinden akar; Minecraft sunucusu host'un
  bilgisayarında kalır.
- Tüm soket işleri ayrı thread'lerde; HTTP API bloke olmaz.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import os
import re
import secrets
import socket
import ssl
import threading
import time
import uuid
from typing import Any, Callable, Dict, List, Optional

from relay_handshake import ROLE_GUEST, ROLE_HOST, client_handshake
from noise_layer import CHUNK, NoiseSession, generate_keypair, prologue_for, public_from_private
try:
    from config import DEFAULT_RENDEZVOUS_URL
except Exception:
    DEFAULT_RENDEZVOUS_URL = ""

MAX_LINE = 64 * 1024
LAN_PORT = 4445
LAN_TTL = 8.0


class SocialError(RuntimeError):
    pass


def _sha256(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _clean_name(value: Any) -> str:
    name = re.sub(r"[\x00-\x1f\x7f]", "", str(value or "")).strip()
    return name[:32] or "Oyuncu"


def _recv_line(sock: socket.socket, limit: int = 8192) -> bytes:
    """Tek bayt okuyarak satır okur; fazladan veri buffer'da kalmaz."""
    data = bytearray()
    while len(data) < limit:
        chunk = sock.recv(1)
        if not chunk:
            break
        data += chunk
        if chunk == b"\n":
            break
    return bytes(data)


def _pipe_noise(tunnel: socket.socket, local: socket.socket, noise: NoiseSession) -> None:
    """Noise frame'leri ile yerel Minecraft arasında iki yönlü pompa."""
    import threading

    def tunnel_to_local() -> None:
        try:
            while True:
                data = noise.recv(tunnel)
                if not data:
                    break
                local.sendall(data)
        except Exception:
            pass
        finally:
            for s in (local, tunnel):
                try:
                    s.shutdown(socket.SHUT_RDWR)
                except Exception:
                    pass
                try:
                    s.close()
                except Exception:
                    pass

    def local_to_tunnel() -> None:
        try:
            while True:
                data = local.recv(CHUNK)
                if not data:
                    break
                noise.send(tunnel, data)
        except Exception:
            pass
        finally:
            for s in (local, tunnel):
                try:
                    s.shutdown(socket.SHUT_RDWR)
                except Exception:
                    pass
                try:
                    s.close()
                except Exception:
                    pass

    t1 = threading.Thread(target=tunnel_to_local, daemon=True)
    t2 = threading.Thread(target=local_to_tunnel, daemon=True)
    t1.start()
    t2.start()
    t1.join()
    t2.join()


def _pipe_sockets(a: socket.socket, b: socket.socket) -> None:
    def pump(src: socket.socket, dst: socket.socket) -> None:
        try:
            while True:
                data = src.recv(65536)
                if not data:
                    break
                dst.sendall(data)
        except Exception:
            pass
        finally:
            for s in (src, dst):
                try:
                    s.shutdown(socket.SHUT_RDWR)
                except Exception:
                    pass

    threads = [
        threading.Thread(target=pump, args=(a, b), daemon=True),
        threading.Thread(target=pump, args=(b, a), daemon=True),
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join()


class SocialClient:
    def __init__(
        self,
        data_dir: str,
        relay_host: Optional[str] = None,
        relay_port: Optional[int] = None,
        relay_tls: Optional[bool] = None,
        on_event: Optional[Callable[[Dict[str, Any]], None]] = None,
        enable_lan: bool = True,
    ):
        self.data_dir = data_dir
        os.makedirs(self.data_dir, exist_ok=True)
        self.profile_path = os.path.join(self.data_dir, "social.json")
        self.lock = threading.RLock()
        self.on_event = on_event
        self.profile = self._load_profile()
        chosen_host = relay_host if relay_host is not None else self.profile.get("relay_host")
        chosen_port = relay_port if relay_port is not None else self.profile.get("relay_port")
        chosen_tls = relay_tls if relay_tls is not None else self.profile.get("relay_tls", False)
        self.relay_host = str(chosen_host or "127.0.0.1")
        self.relay_port = int(chosen_port or 19021)
        self.relay_tls = bool(chosen_tls)
        self.rendezvous_url = str(self.profile.get("rendezvous_url") or "").strip()
        self.noise_private = str(self.profile.get("noise_private") or "")
        self.noise_public = str(self.profile.get("noise_public") or "")
        self.noise_peer_pub = str(self.profile.get("noise_peer_pub") or "")
        if (self.profile.get("relay_host") != self.relay_host
                or int(self.profile.get("relay_port") or 0) != self.relay_port
                or bool(self.profile.get("relay_tls", False)) != self.relay_tls):
            self.profile["relay_host"] = self.relay_host
            self.profile["relay_port"] = self.relay_port
            self.profile["relay_tls"] = self.relay_tls
            try:
                self._save_profile_raw(self.profile)
            except Exception:
                pass
        self.tunnel_port = 19022
        self.connected = False
        self.error = ""
        self.you: Dict[str, Any] = {}
        self.friends: List[Dict[str, Any]] = []
        self.requests: Dict[str, list] = {"in": [], "out": []}
        self.invites: List[Dict[str, Any]] = []
        self.share: Optional[Dict[str, Any]] = None
        self.share_port = 0
        self.joined: Optional[Dict[str, Any]] = None
        self.lan_worlds: List[Dict[str, Any]] = []
        self.events: List[Dict[str, Any]] = []
        self.event_seq = 0
        self.last_error = ""

        self._loop = asyncio.new_event_loop()
        self._thread: Optional[threading.Thread] = None
        self._ready = threading.Event()
        self._stop = threading.Event()
        self._writer: Optional[asyncio.StreamWriter] = None
        self._reader: Optional[asyncio.StreamReader] = None
        self._pending: Dict[str, asyncio.Future] = {}
        self._req_id = 0
        self._active_tunnels: List[tuple] = []
        self._join_listener: Optional[socket.socket] = None
        self._join_tunnel: Optional[socket.socket] = None
        self._lan_stop = threading.Event()
        self._lan_thread: Optional[threading.Thread] = None
        self._enable_lan = bool(enable_lan)

    # ---------------------------------------------------------------- profile
    def _load_profile(self) -> Dict[str, Any]:
        data: Dict[str, Any] = {}
        try:
            with open(self.profile_path, "r", encoding="utf-8") as f:
                raw = json.load(f)
            if isinstance(raw, dict):
                data = raw
        except Exception:
            data = {}
        if not data.get("player_id"):
            data["player_id"] = uuid.uuid4().hex
        if not data.get("secret"):
            data["secret"] = secrets.token_hex(32)
        if not data.get("name"):
            data["name"] = os.environ.get("USER") or "Oyuncu"
        if not data.get("noise_private"):
            try:
                priv, pub = generate_keypair()
                data["noise_private"] = priv
                data["noise_public"] = pub
            except Exception:
                pass
        elif not data.get("noise_public"):
            try:
                data["noise_public"] = public_from_private(data["noise_private"])
            except Exception:
                pass
        data.setdefault("relay_host", "127.0.0.1")
        data.setdefault("relay_port", 19021)
        data.setdefault(
            "rendezvous_url",
            os.environ.get("COOKIE_LAUNCHER_RENDEZVOUS_URL", DEFAULT_RENDEZVOUS_URL),
        )
        try:
            self._save_profile_raw(data)
        except Exception:
            pass
        return data

    def _save_profile_raw(self, data: Dict[str, Any]) -> None:
        tmp = self.profile_path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        os.replace(tmp, self.profile_path)
        try:
            os.chmod(self.profile_path, 0o600)
        except Exception:
            pass

    def _save_profile(self) -> None:
        with self.lock:
            self._save_profile_raw(self.profile)

    @property
    def secret_hash(self) -> str:
        return _sha256(str(self.profile.get("secret") or ""))

    def update_profile(self, name: Optional[str] = None, relay_host: Optional[str] = None,
                       relay_port: Optional[int] = None, relay_tls: Optional[bool] = None,
                       rendezvous_url: Optional[str] = None,
                       noise_peer_pub: Optional[str] = None) -> Dict[str, Any]:
        reconnect = False
        with self.lock:
            if name is not None:
                self.profile["name"] = _clean_name(name)
            if relay_host is not None:
                host = str(relay_host).strip()[:200]
                tls_hint = None
                if host.startswith("https://"):
                    tls_hint = True
                elif host.startswith("http://"):
                    tls_hint = False
                host = re.sub(r"^[a-z]+://", "", host, flags=re.I).split("/")[0].strip()
                if host.count(":") == 1:
                    maybe_host, maybe_port = host.rsplit(":", 1)
                    if maybe_port.isdigit() and 1 <= int(maybe_port) <= 65535:
                        host = maybe_host
                        if relay_port is None:
                            relay_port = int(maybe_port)
                if tls_hint is not None and relay_tls is None:
                    relay_tls = tls_hint
                if host and host != self.relay_host:
                    self.relay_host = host
                    self.profile["relay_host"] = host
                    reconnect = True
            if relay_port is not None:
                try:
                    port = int(relay_port)
                except Exception:
                    port = 19021
                if 1 <= port <= 65535 and port != self.relay_port:
                    self.relay_port = port
                    self.profile["relay_port"] = port
                    reconnect = True
            if relay_tls is not None and bool(relay_tls) != self.relay_tls:
                self.relay_tls = bool(relay_tls)
                self.profile["relay_tls"] = self.relay_tls
                reconnect = True
            if rendezvous_url is not None:
                value = str(rendezvous_url or "").strip().rstrip("/")
                if value != self.rendezvous_url:
                    self.rendezvous_url = value
                    self.profile["rendezvous_url"] = value
            if noise_peer_pub is not None:
                value = str(noise_peer_pub or "").strip()
                if value != self.noise_peer_pub:
                    self.noise_peer_pub = value
                    self.profile["noise_peer_pub"] = value
            self._save_profile()
        if self.connected:
            try:
                self.call({"type": "set_name", "name": self.profile["name"]}, timeout=4)
            except Exception:
                pass
        if reconnect:
            self.reconnect()
        return self.profile_public()

    def profile_public(self) -> Dict[str, Any]:
        with self.lock:
            return {
                "player_id": self.profile.get("player_id"),
                "name": self.profile.get("name"),
                "code": (self.you or {}).get("code") or self.profile.get("code", ""),
                "relay_host": self.relay_host,
                "relay_port": self.relay_port,
                "relay_tls": self.relay_tls,
                "rendezvous_url": self.rendezvous_url,
                "noise_public": self.noise_public,
                "tunnel_port": self.tunnel_port,
            }

    # ---------------------------------------------------------------- lifecycle
    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(target=self._run_loop, name="social-client", daemon=True)
        self._thread.start()
        self._ready.wait(2.0)
        if self._enable_lan:
            self._start_lan_scanner()

    def stop(self) -> None:
        self._stop.set()
        self._lan_stop.set()
        try:
            if self._loop.is_running():
                self._loop.call_soon_threadsafe(self._close_writer)
        except Exception:
            pass
        self._close_tunnels()
        try:
            if self._join_listener:
                self._join_listener.close()
        except Exception:
            pass
        if self._thread:
            self._thread.join(timeout=3)

    def reconnect(self) -> None:
        try:
            if self._loop.is_running():
                self._loop.call_soon_threadsafe(self._close_writer)
        except Exception:
            pass

    def _run_loop(self) -> None:
        asyncio.set_event_loop(self._loop)
        self._ready.set()
        try:
            self._loop.run_until_complete(self._connect_loop())
        except Exception as exc:
            self.error = f"{type(exc).__name__}: {exc}"
        finally:
            try:
                self._loop.close()
            except Exception:
                pass

    async def _connect_loop(self) -> None:
        backoff = 1.0
        while not self._stop.is_set():
            try:
                await self._connect_once()
                backoff = 1.0
            except asyncio.CancelledError:
                # transport.abort() / reconnect sirasinda gelebilir; durdurma
                # istenmediyse dongu yeniden baglanmali.
                if self._stop.is_set():
                    break
                self._set_connected(False)
                await asyncio.sleep(0.25)
                continue
            except Exception as exc:
                self.error = self._friendly_error(exc)
                self._set_connected(False)
            if self._stop.is_set():
                break
            await asyncio.sleep(backoff)
            backoff = min(backoff * 1.7, 12.0)

    def _friendly_error(self, exc: Exception) -> str:
        if isinstance(exc, ssl.SSLError):
            return f"TLS bağlantı hatası: {exc}"
        if isinstance(exc, asyncio.TimeoutError) or isinstance(exc, TimeoutError):
            return "Relay yanıt vermedi (zaman aşımı)."
        if isinstance(exc, ConnectionRefusedError):
            return "Relay'e ulaşılamadı. Adresi ve servisin açık olduğunu kontrol edin."
        if isinstance(exc, OSError):
            return "Relay'e ulaşılamadı. Adresi ve servisin açık olduğunu kontrol edin."
        return f"{type(exc).__name__}: {exc}"

    async def _connect_once(self) -> None:
        ssl_ctx = ssl.create_default_context() if self.relay_tls else None
        reader, writer = await asyncio.wait_for(
            asyncio.open_connection(
                self.relay_host,
                self.relay_port,
                ssl=ssl_ctx,
                server_hostname=self.relay_host if ssl_ctx else None,
            ),
            timeout=8,
        )
        self._reader, self._writer = reader, writer
        try:
            await self._handshake(reader, writer)
            self._set_connected(True)
            self._emit("connected", "Relay'e bağlandı.")
            heart = asyncio.create_task(self._heartbeat())
            try:
                await self._recv_loop(reader)
            finally:
                heart.cancel()
                try:
                    await heart
                except Exception:
                    pass
        finally:
            self._set_connected(False)
            self._fail_pending(SocialError("Relay bağlantısı koptu."))
            try:
                writer.close()
                await writer.wait_closed()
            except Exception:
                pass
            self._writer = None
            self._reader = None

    async def _handshake(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        pid = str(self.profile.get("player_id") or "")
        name = _clean_name(self.profile.get("name"))
        await self._send_raw(writer, {
            "type": "hello",
            "player_id": pid,
            "name": name,
            "noise_public": self.noise_public,
        })
        msg = await self._read_raw(reader, 12)
        if not msg:
            raise SocialError("Relay el sıkışması başarısız.")
        if msg.get("type") == "register_required":
            await self._send_raw(writer, {"type": "register", "secret_hash": self.secret_hash})
            msg = await self._read_raw(reader, 12)
        elif msg.get("type") == "challenge":
            nonce = str(msg.get("nonce") or "")
            proof = hmac.new(self.secret_hash.encode("utf-8"), nonce.encode("utf-8"), hashlib.sha256).hexdigest()
            await self._send_raw(writer, {"type": "auth", "proof": proof})
            msg = await self._read_raw(reader, 12)
        if not msg or msg.get("type") != "hello_ok":
            error = (msg or {}).get("error") or "auth_failed"
            raise SocialError(f"Relay kimlik doğrulaması başarısız: {error}")
        self._apply_snapshot(msg)
        self.last_error = ""

    async def _recv_loop(self, reader: asyncio.StreamReader) -> None:
        while not self._stop.is_set():
            msg = await self._read_raw(reader, 45)
            if msg is None:
                raise SocialError("Relay bağlantısı kapandı.")
            mtype = msg.get("type")
            if mtype == "response":
                req_id = str(msg.get("req_id") or "")
                fut = self._pending.pop(req_id, None)
                if fut and not fut.done():
                    fut.set_result(msg)
            elif mtype == "event":
                self._handle_event(msg)
            elif mtype == "hello_ok":
                self._apply_snapshot(msg)
            elif mtype == "error":
                self.last_error = str(msg.get("error") or "relay_error")

    async def _heartbeat(self) -> None:
        while True:
            await asyncio.sleep(20)
            try:
                await self._request({"type": "ping"}, timeout=8)
            except Exception:
                return

    async def _send_raw(self, writer: asyncio.StreamWriter, payload: Dict[str, Any]) -> None:
        data = (json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
        writer.write(data)
        await writer.drain()

    async def _read_raw(self, reader: asyncio.StreamReader, timeout: float) -> Optional[Dict[str, Any]]:
        try:
            line = await asyncio.wait_for(reader.readline(), timeout=timeout)
        except asyncio.TimeoutError:
            return None
        if not line:
            return None
        if len(line) > MAX_LINE:
            return None
        try:
            value = json.loads(line.decode("utf-8"))
            return value if isinstance(value, dict) else None
        except Exception:
            return None

    async def _request(self, payload: Dict[str, Any], timeout: float = 8.0) -> Dict[str, Any]:
        if not self.connected or not self._writer:
            raise SocialError("Relay bağlantısı yok.")
        self._req_id += 1
        req_id = str(self._req_id)
        payload = dict(payload)
        payload["req_id"] = req_id
        fut = self._loop.create_future()
        self._pending[req_id] = fut
        try:
            await self._send_raw(self._writer, payload)
            return await asyncio.wait_for(fut, timeout=timeout)
        finally:
            self._pending.pop(req_id, None)

    def call(self, payload: Dict[str, Any], timeout: float = 8.0) -> Dict[str, Any]:
        if not self._loop.is_running():
            raise SocialError("Sosyal istemci hazır değil.")
        fut = asyncio.run_coroutine_threadsafe(self._request(payload, timeout), self._loop)
        try:
            result = fut.result(timeout=timeout + 2)
        except Exception as exc:
            raise SocialError(str(exc))
        if not result.get("ok"):
            raise SocialError(str(result.get("error") or "relay_error"))
        return result

    def _fail_pending(self, exc: Exception) -> None:
        for fut in list(self._pending.values()):
            if not fut.done():
                fut.set_exception(exc)
        self._pending.clear()

    def _close_writer(self) -> None:
        try:
            if self._writer:
                transport = getattr(self._writer, "transport", None)
                if transport is not None:
                    transport.abort()
                self._writer.close()
        except Exception:
            pass

    def _set_connected(self, value: bool) -> None:
        with self.lock:
            self.connected = bool(value)
            if value:
                self.error = ""
            if not value:
                self.you = {}
                # Relay koptugunda acik oturumlar guvenilir degil; temizle.
                self.share = None
                self.share_port = 0
                self.joined = None
        if not value:
            self._close_join_local()
            self._close_tunnels()

    # ---------------------------------------------------------------- state
    def _apply_snapshot(self, msg: Dict[str, Any]) -> None:
        with self.lock:
            self.you = dict(msg.get("you") or {})
            if self.you.get("code"):
                self.profile["code"] = self.you["code"]
                try:
                    self._save_profile_raw(self.profile)
                except Exception:
                    pass
            self.friends = list(msg.get("friends") or [])
            req = msg.get("requests") or {}
            self.requests = {"in": list(req.get("in") or []), "out": list(req.get("out") or [])}
            self.invites = list(msg.get("invites") or [])
            remote_joined = msg.get("joined")
            if remote_joined:
                base = dict(self.joined or {})
                base.update({
                    "session_id": remote_joined.get("session_id"),
                    "world": remote_joined.get("world", "Dünya"),
                    "host_name": remote_joined.get("host_name", "Arkadaş"),
                    "host_id": remote_joined.get("host_id"),
                })
                self.joined = base
            elif self.joined is not None and not self.joined.get("local_port"):
                self.joined = None
            hosted = msg.get("hosted")
            if hosted:
                self.share = dict(hosted)
                try:
                    self.share_port = int(hosted.get("port") or 0)
                except Exception:
                    self.share_port = 0
            elif self.share is not None:
                self.share = None
                self.share_port = 0
            relay = msg.get("relay") or {}
            try:
                self.tunnel_port = int(relay.get("tunnel_port") or self.tunnel_port)
            except Exception:
                pass
            self.connected = True
            self.error = ""

    def _emit(self, kind: str, message: str, data: Optional[Dict[str, Any]] = None) -> None:
        with self.lock:
            self.event_seq += 1
            event = {"seq": self.event_seq, "kind": kind, "message": message, "at": time.time()}
            if data:
                event.update(data)
            self.events.append(event)
            self.events = self.events[-50:]
        if self.on_event:
            try:
                self.on_event(event)
            except Exception:
                pass

    def _handle_event(self, msg: Dict[str, Any]) -> None:
        event = str(msg.get("event") or "")
        with self.lock:
            if event == "friend_request":
                frm = msg.get("from") or {}
                if frm and frm.get("player_id") not in [p.get("player_id") for p in self.requests["in"]]:
                    self.requests["in"].append(frm)
                self._emit_unlocked("friend_request", f"{frm.get('name','Bir oyuncu')} arkadaşlık isteği gönderdi.", frm)
            elif event == "friend_accepted":
                frm = msg.get("friend") or {}
                if frm:
                    self._upsert_friend(frm)
                    self.requests["in"] = [p for p in self.requests["in"] if p.get("player_id") != frm.get("player_id")]
                    self.requests["out"] = [p for p in self.requests["out"] if p.get("player_id") != frm.get("player_id")]
                    self._emit_unlocked("friend_accepted", f"{frm.get('name','Oyuncu')} ile arkadaş oldunuz.", frm)
            elif event == "friend_declined":
                frm = msg.get("friend") or {}
                self.requests["out"] = [p for p in self.requests["out"] if p.get("player_id") != frm.get("player_id")]
                self._emit_unlocked("friend_declined", f"{frm.get('name','Oyuncu')} isteği reddetti.", frm)
            elif event == "friend_removed":
                frm = msg.get("friend") or {}
                fid = frm.get("player_id")
                self.friends = [p for p in self.friends if p.get("player_id") != fid]
                removed_invites = [iv for iv in self.invites if iv.get("host_id") == fid]
                self.invites = [iv for iv in self.invites if iv.get("host_id") != fid]
                if self.joined and any(iv.get("session_id") == self.joined.get("session_id") for iv in removed_invites):
                    self.joined = None
                    self._close_join_local()
                self._emit_unlocked("friend_removed", f"{frm.get('name','Oyuncu')} arkadaş listesinden çıkarıldı.", frm)
            elif event == "presence":
                frm = msg.get("friend") or {}
                if frm:
                    self._upsert_friend(frm)
            elif event == "world_updated":
                session = msg.get("session") or {}
                if self.share and session.get("session_id") == self.share.get("session_id"):
                    self.share = dict(session)
                    try:
                        self.share_port = int(session.get("port") or self.share_port)
                    except Exception:
                        pass
            elif event == "world_invite":
                session = msg.get("session") or {}
                if session and not any(s.get("session_id") == session.get("session_id") for s in self.invites):
                    self.invites.append(session)
                    self._emit_unlocked("world_invite", f"{session.get('host_name','Bir arkadaşın')} seni dünyasına davet etti.", session)
            elif event == "world_ended":
                sid = msg.get("session_id")
                self.invites = [s for s in self.invites if s.get("session_id") != sid]
                if self.joined and self.joined.get("session_id") == sid:
                    self.joined = None
                    self._close_join_local()
                if self.share and self.share.get("session_id") == sid:
                    self.share = None
                    self.share_port = 0
                    self._close_tunnels()
            elif event == "tunnel_request":
                token = msg.get("token")
                ticket_id = msg.get("ticket_id")
                if token and ticket_id:
                    threading.Thread(
                        target=self._host_tunnel,
                        args=(
                            str(ticket_id),
                            str(token),
                            int(self.share_port or 0),
                            msg.get("session_id") or "",
                            msg.get("guest_id") or "",
                            msg.get("guest_noise_public") or "",
                            msg.get("guest_name") or "",
                        ),
                        daemon=True,
                    ).start()
            elif event == "connected":
                self._emit_unlocked("connected", "Relay'e bağlandı.")
    def _emit_unlocked(self, kind: str, message: str, data: Optional[Dict[str, Any]] = None) -> None:
        # _handle_event zaten kilitli; _emit tekrar kilitlemesin.
        self.event_seq += 1
        ev = {"seq": self.event_seq, "kind": kind, "message": message, "at": time.time()}
        if data:
            ev.update(data)
        self.events.append(ev)
        self.events = self.events[-50:]
        if self.on_event:
            try:
                self.on_event(ev)
            except Exception:
                pass

    def _upsert_friend(self, friend: Dict[str, Any]) -> None:
        fid = friend.get("player_id")
        if not fid:
            return
        for i, existing in enumerate(self.friends):
            if existing.get("player_id") == fid:
                self.friends[i] = {**existing, **friend}
                return
        self.friends.append(friend)

    def snapshot(self) -> Dict[str, Any]:
        with self.lock:
            friends = sorted(
                [dict(f) for f in self.friends],
                key=lambda f: (not f.get("online"), str(f.get("name", "")).lower()),
            )
            return {
                "success": True,
                "connected": self.connected,
                "error": self.error or "",
                "profile": {
                    **self.profile_public(),
                    "code": (self.you or {}).get("code") or self.profile.get("code", ""),
                },
                "you": dict(self.you),
                "friends": friends,
                "requests": {"in": [dict(x) for x in self.requests["in"]], "out": [dict(x) for x in self.requests["out"]]},
                "invites": [dict(x) for x in self.invites],
                "share": dict(self.share) if self.share else None,
                "joined": dict(self.joined) if self.joined else None,
                "lan_worlds": [dict(w) for w in self.lan_worlds],
                "events": [dict(e) for e in self.events[-20:]],
                "relay": {"host": self.relay_host, "port": self.relay_port, "tls": self.relay_tls, "tunnel_port": self.tunnel_port},
                "server_time": time.time(),
            }

    # ---------------------------------------------------------------- friends
    def add_friend(self, code: str) -> Dict[str, Any]:
        code = str(code or "").strip()
        if not code:
            raise SocialError("Arkadaş kodu boş olamaz.")
        result = self.call({"type": "friend_request", "code": code}, timeout=8)
        self._emit("friend_request_sent", "Arkadaşlık isteği gönderildi.")
        return result

    def respond_friend(self, player_id: str, accept: bool) -> Dict[str, Any]:
        result = self.call({"type": "friend_respond", "player_id": player_id, "accept": bool(accept)}, timeout=8)
        with self.lock:
            self.requests["in"] = [p for p in self.requests["in"] if p.get("player_id") != player_id]
        return result

    def remove_friend(self, player_id: str) -> Dict[str, Any]:
        result = self.call({"type": "friend_remove", "player_id": player_id}, timeout=8)
        with self.lock:
            self.friends = [p for p in self.friends if p.get("player_id") != player_id]
        return result

    # ---------------------------------------------------------------- worlds
    def share_world(self, world: str, port: int) -> Dict[str, Any]:
        port = int(port)
        if not (1 <= port <= 65535):
            raise SocialError("Geçersiz port.")
        if not self._port_open(port):
            raise SocialError(
                "Bu portta açık bir dünya bulunamadı. Minecraft'ta dünyayı 'LAN'a aç' ile paylaşın."
            )
        result = self.call({
            "type": "world_share",
            "world": str(world or "Dünya")[:64],
            "port": port,
            "noise_public": self.noise_public,
        }, timeout=8)
        with self.lock:
            self.share = dict(result.get("session") or {})
            self.share_port = port
            chosen_tunnel = result.get("local_tunnel_port") if self._relay_is_local() else result.get("tunnel_port")
            self.tunnel_port = int(chosen_tunnel or result.get("tunnel_port") or self.tunnel_port)
        self._emit("world_shared", f"{world} dünyası arkadaşlarına açıldı.")
        return result

    def unshare_world(self) -> Dict[str, Any]:
        with self.lock:
            sid = (self.share or {}).get("session_id")
        if not sid:
            return {"ok": True}
        result = self.call({"type": "world_unshare", "session_id": sid}, timeout=8)
        with self.lock:
            self.share = None
            self.share_port = 0
        self._close_tunnels()
        self._emit("world_unshared", "Dünya paylaşımı kapatıldı.")
        return result

    def join_world(self, session_id: str) -> Dict[str, Any]:
        session_id = str(session_id or "")
        if not session_id:
            raise SocialError("Davet bulunamadı.")
        # Önceki katılım varsa relay'e de bildir
        self.leave_world(notify=True)
        result = self.call({"type": "world_join", "session_id": session_id}, timeout=12)
        token = str(result.get("token") or "")
        ticket_id = str(result.get("ticket_id") or "")
        if not token or not ticket_id:
            raise SocialError("Relay tünel anahtarı vermedi.")
        chosen_tunnel = result.get("local_tunnel_port") if self._relay_is_local() else result.get("tunnel_port")
        tunnel_port = int(chosen_tunnel or result.get("tunnel_port") or self.tunnel_port)
        joined_session = result.get("session") or {}
        noise_peer = str(joined_session.get("noise_public") or self.noise_peer_pub or "")
        if not noise_peer:
            raise SocialError("Host Noise anahtarı yok; daveti yeniden uygulayın.")
        if not self.noise_private:
            raise SocialError("Noise anahtarınız oluşturulamamış.")
        listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        listener.bind(("127.0.0.1", 0))
        listener.listen(4)
        local_port = listener.getsockname()[1]
        paired = threading.Event()
        state: Dict[str, Any] = {}

        def run() -> None:
            tunnel = None
            try:
                tunnel = self._open_tunnel_socket(tunnel_port)
                client_handshake(tunnel, ticket_id, token, ROLE_GUEST)
                tunnel.settimeout(20)
                noise = NoiseSession(
                    self.noise_private,
                    noise_peer,
                    prologue_for(session_id),
                )
                identity_payload = json.dumps({
                    "pid": str(self.profile.get("player_id") or ""),
                    "tid": ticket_id,
                    "sid": session_id,
                    "npub": self.noise_public,
                }, separators=(",", ":")).encode("utf-8")
                noise.handshake_initiator(tunnel, identity_payload)
                tunnel.settimeout(None)
                with self.lock:
                    self._join_tunnel = tunnel
                paired.set()
                client, _ = listener.accept()
                try:
                    _pipe_noise(tunnel, client, noise)
                finally:
                    for s in (client, tunnel):
                        try:
                            s.close()
                        except Exception:
                            pass
                    with self.lock:
                        if self.joined and self.joined.get("local_port") == local_port:
                            self.joined = None
                    self._emit("world_disconnected", "Dünya bağlantısı kapandı.")
            except Exception as exc:
                state["error"] = str(exc)
                paired.set()
                try:
                    if tunnel:
                        tunnel.close()
                except Exception:
                    pass

        with self.lock:
            self._join_listener = listener
        threading.Thread(target=run, daemon=True, name="social-join").start()
        if not paired.wait(16):
            try:
                listener.close()
            except Exception:
                pass
            if self.connected:
                try:
                    self.call({"type": "world_leave", "session_id": session_id}, timeout=4)
                except Exception:
                    pass
            raise SocialError("Dünyaya bağlanılamadı (zaman aşımı).")
        if state.get("error"):
            try:
                listener.close()
            except Exception:
                pass
            if self.connected:
                try:
                    self.call({"type": "world_leave", "session_id": session_id}, timeout=4)
                except Exception:
                    pass
            raise SocialError(state["error"])
        with self.lock:
            self.joined = {
                "session_id": session_id,
                "world": (result.get("session") or {}).get("world", "Dünya"),
                "host_name": (result.get("session") or {}).get("host_name", "Arkadaş"),
                "host_id": (result.get("session") or {}).get("host_id"),
                "local_port": local_port,
            }
        self._emit("world_joined", f"{(result.get('session') or {}).get('host_name','Arkadaş')} dünyasına bağlanıldı.")
        return {"ok": True, "local_port": local_port, "session": result.get("session") or {}}

    def leave_world(self, notify: bool = True) -> None:
        with self.lock:
            joined = dict(self.joined) if self.joined else None
            self.joined = None
            listener = self._join_listener
            self._join_listener = None
            tunnel = self._join_tunnel
            self._join_tunnel = None
        try:
            if listener:
                listener.close()
        except Exception:
            pass
        try:
            if tunnel:
                tunnel.close()
        except Exception:
            pass
        if notify and joined and self.connected:
            try:
                self.call({"type": "world_leave", "session_id": joined.get("session_id")}, timeout=4)
            except Exception:
                pass

    def _host_tunnel(self, ticket_id: str, token: str, port: int, session_id: str,
                     guest_id: str, guest_noise_public: str, guest_name: str) -> None:
        if not port:
            self._emit("guest_join_failed", "Dünya paylaşımı kapalı olduğu için davet tamamlanamadı.")
            return
        tunnel = None
        try:
            tunnel = self._open_tunnel_socket(self.tunnel_port)
            client_handshake(tunnel, ticket_id, token, ROLE_HOST)
            tunnel.settimeout(20)
            noise = NoiseSession(
                self.noise_private,
                prologue=prologue_for(session_id),
            )
            identity_raw = noise.handshake_responder(tunnel)
            try:
                identity = json.loads(identity_raw.decode("utf-8")) if identity_raw else {}
            except Exception:
                identity = {}
            if str(identity.get("pid") or "") != str(guest_id or ""):
                raise SocialError("Noise guest kimliği uyuşmuyor.")
            if str(identity.get("tid") or "") != str(ticket_id or ""):
                raise SocialError("Noise ticket kimliği uyuşmuyor.")
            if str(identity.get("sid") or "") != str(session_id or ""):
                raise SocialError("Noise oturum kimliği uyuşmuyor.")
            if guest_noise_public and str(identity.get("npub") or "") != str(guest_noise_public):
                raise SocialError("Noise guest anahtarı relay kaydıyla uyuşmuyor.")
            tunnel.settimeout(None)
            mc = socket.create_connection(("127.0.0.1", port), timeout=8)
            with self.lock:
                self._active_tunnels.append((tunnel, mc))
            self._emit("guest_joined", f"{guest_name or 'Bir arkadaş'} dünyana katıldı.")
            _pipe_noise(tunnel, mc, noise)
        except Exception as exc:
            self._emit("guest_join_failed", f"Arkadaş dünyaya bağlanamadı: {exc}")
        finally:
            with self.lock:
                self._active_tunnels = [(a, b) for (a, b) in self._active_tunnels if a is not tunnel]
            for s in (tunnel, locals().get("mc")):
                try:
                    if s:
                        s.close()
                except Exception:
                    pass

    def _close_join_local(self) -> None:
        with self.lock:
            listener = self._join_listener
            self._join_listener = None
            tunnel = self._join_tunnel
            self._join_tunnel = None
        for s in (listener, tunnel):
            try:
                if s:
                    s.close()
            except Exception:
                pass

    def _close_tunnels(self) -> None:
        with self.lock:
            tunnels = list(self._active_tunnels)
            self._active_tunnels = []
        for a, b in tunnels:
            for s in (a, b):
                try:
                    s.close()
                except Exception:
                    pass

    def _relay_is_local(self) -> bool:
        return str(self.relay_host).strip().lower() in ("127.0.0.1", "localhost", "::1")

    def _open_tunnel_socket(self, tunnel_port: int) -> socket.socket:
        raw = socket.create_connection((self.relay_host, tunnel_port), timeout=10)
        if self.relay_tls:
            ctx = ssl.create_default_context()
            return ctx.wrap_socket(raw, server_hostname=self.relay_host)
        return raw

    def _port_open(self, port: int) -> bool:
        try:
            with socket.create_connection(("127.0.0.1", int(port)), timeout=1.2):
                return True
        except Exception:
            return False

    def scan_lan(self) -> Dict[str, Any]:
        return {"success": True, "worlds": self.snapshot().get("lan_worlds", [])}

    # ---------------------------------------------------------------- LAN
    def _start_lan_scanner(self) -> None:
        if self._lan_thread and self._lan_thread.is_alive():
            return
        self._lan_stop.clear()
        self._lan_thread = threading.Thread(target=self._lan_loop, name="social-lan", daemon=True)
        self._lan_thread.start()

    def _lan_loop(self) -> None:
        sock = None
        try:
            sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            sock.bind(("", LAN_PORT))
            sock.settimeout(1.0)
        except Exception:
            try:
                if sock:
                    sock.close()
            except Exception:
                pass
            return
        worlds: Dict[int, Dict[str, Any]] = {}
        try:
            while not self._lan_stop.is_set():
                try:
                    data, addr = sock.recvfrom(4096)
                except socket.timeout:
                    self._prune_lan(worlds)
                    continue
                except Exception:
                    break
                text = data.decode("utf-8", "replace")
                motd = ""
                port = 0
                m = re.search(r"\[MOTD\](.*?)\[/MOTD\]", text, re.S)
                if m:
                    motd = m.group(1).strip()
                m = re.search(r"\[AD\](\d+)\[/AD\]", text)
                if m:
                    try:
                        port = int(m.group(1))
                    except Exception:
                        port = 0
                if not port:
                    continue
                worlds[port] = {
                    "motd": motd or "Minecraft dünyası",
                    "port": port,
                    "address": addr[0],
                    "last_seen": time.time(),
                }
                self._prune_lan(worlds, update=True)
        finally:
            try:
                sock.close()
            except Exception:
                pass

    def _prune_lan(self, worlds: Dict[int, Dict[str, Any]], update: bool = False) -> None:
        t = time.time()
        alive = [w for w in worlds.values() if t - w.get("last_seen", 0) <= LAN_TTL]
        for w in list(worlds.values()):
            if t - w.get("last_seen", 0) > LAN_TTL:
                worlds.pop(w["port"], None)
        with self.lock:
            self.lan_worlds = sorted(alive, key=lambda w: w["port"])


# ---------------------------------------------------------------- test helper
def _test_roundtrip() -> None:
    import tempfile

    with tempfile.TemporaryDirectory() as tmp:
        client = SocialClient(tmp, relay_host="127.0.0.1", relay_port=1)
        client.start()
        time.sleep(0.2)
        print(json.dumps(client.snapshot(), ensure_ascii=False)[:300])
        client.stop()


if __name__ == "__main__":
    _test_roundtrip()
