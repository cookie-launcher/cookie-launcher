#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Cookie Launcher — Arkadaşlar relay'i
====================================

Bu servis yalnızca arkadaşlık, çevrimiçi durum, dünya daveti ve oyun
trafiği için TCP tüneli sağlar. Minecraft sunucusu değildir; dünya
host'un bilgisayarında çalışır.

Çalıştırma:
    python3 backend/social_relay.py --host 0.0.0.0 --control-port 19021 --tunnel-port 19022

İstemciler control portuna bağlanır; tünel portu control yanıtında bildirilir.
Üretimde TLS/SSL terminasyonu (Caddy, nginx stream, stunnel) arkasında
çalıştırılması önerilir.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import hmac
import json
import os
import re
import secrets
import socket
import ssl
import sys

from relay_handshake import (
    ROLE_GUEST,
    ROLE_HOST,
    new_ticket_id as hs_new_ticket_id,
    send_ready,
    send_result,
    server_handshake,
)
import time
from typing import Any, Dict, Optional

MAX_LINE = 64 * 1024
CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
CODE_LEN = 8
# Dünya oturumu ve davet süresi. Ortam değişkeniyle değiştirilebilir.
SESSION_TTL = int(os.environ.get("CL_SESSION_TTL", str(24 * 60 * 60)))
INVITE_TTL = int(os.environ.get("CL_INVITE_TTL", str(24 * 60 * 60)))
PAIR_TTL = 90
DEFAULT_DATA = os.path.join(os.path.expanduser("~"), ".cookie_launcher", "social_relay.json")


def now() -> float:
    return time.time()


def log(msg: str) -> None:
    print(f"[social-relay] {msg}", file=sys.stderr, flush=True)


def sha256_hex(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def clean_name(value: Any) -> str:
    name = re.sub(r"[\x00-\x1f\x7f]", "", str(value or "")).strip()
    return name[:32] or "Oyuncu"


def clean_id(value: Any) -> str:
    return re.sub(r"[^A-Za-z0-9_-]", "", str(value or ""))[:64]


def clean_world(value: Any) -> str:
    world = re.sub(r"[\x00-\x1f\x7f]", "", str(value or "")).strip()
    return world[:64] or "Dünya"


def clean_udp_candidate(value: Any) -> Dict[str, Any]:
    if not isinstance(value, dict):
        return {}
    ip = str(value.get("ip") or value.get("h") or "").strip()
    try:
        port = int(value.get("port") or value.get("p") or 0)
    except Exception:
        return {}
    if not ip or not (1 <= port <= 65535):
        return {}
    try:
        family = socket.AF_INET6 if ":" in ip else socket.AF_INET
        socket.inet_pton(family, ip)
    except Exception:
        return {}
    return {"ip": ip, "port": port}


def make_code(existing: set[str]) -> str:
    for _ in range(100):
        code = "".join(secrets.choice(CODE_ALPHABET) for _ in range(CODE_LEN))
        if code not in existing:
            return code
    raise RuntimeError("Arkadaş kodu üretilemedi")


def public_player(player: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "player_id": player["id"],
        "name": player["name"],
        "code": player["code"],
    }


class Store:
    """Relay'in kalıcı sosyal grafiği. Oturumlar bellekte tutulur."""

    def __init__(self, path: str):
        self.path = path
        self.data: Dict[str, Any] = {"players": {}, "requests": {}}
        self.load()

    def load(self) -> None:
        try:
            with open(self.path, "r", encoding="utf-8") as f:
                raw = json.load(f)
            if isinstance(raw, dict):
                players = raw.get("players")
                requests = raw.get("requests")
                if isinstance(players, dict):
                    self.data["players"] = players
                if isinstance(requests, dict):
                    self.data["requests"] = requests
        except FileNotFoundError:
            pass
        except Exception as exc:
            log(f"Veri dosyası okunamadı ({self.path}): {exc}")
        for pid, player in list(self.data["players"].items()):
            if not isinstance(player, dict):
                self.data["players"].pop(pid, None)
                continue
            player.setdefault("id", pid)
            player.setdefault("name", "Oyuncu")
            player.setdefault("friends", [])
            player.setdefault("code", make_code({p.get("code") for p in self.data["players"].values()}))
            player.setdefault("created", now())
        for pid in self.data["players"]:
            self.requests(pid)

    def save(self) -> None:
        try:
            os.makedirs(os.path.dirname(os.path.abspath(self.path)), exist_ok=True)
            tmp = self.path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(self.data, f, ensure_ascii=False, separators=(",", ":"))
            os.replace(tmp, self.path)
            try:
                os.chmod(self.path, 0o600)
            except Exception:
                pass
        except Exception as exc:
            log(f"Veri dosyası yazılamadı: {exc}")

    def requests(self, pid: str) -> Dict[str, list]:
        bucket = self.data["requests"].setdefault(pid, {})
        bucket.setdefault("in", [])
        bucket.setdefault("out", [])
        return bucket

    def player(self, pid: str) -> Optional[Dict[str, Any]]:
        return self.data["players"].get(pid)

    def by_code(self, code: str) -> Optional[Dict[str, Any]]:
        wanted = re.sub(r"[^A-Z0-9]", "", str(code or "").upper())
        if not wanted:
            return None
        for player in self.data["players"].values():
            if player.get("code") == wanted:
                return player
        return None

    def register(self, pid: str, name: str, secret_hash: str) -> Dict[str, Any]:
        codes = {p.get("code") for p in self.data["players"].values()}
        player = {
            "id": pid,
            "name": clean_name(name),
            "secret_hash": secret_hash,
            "code": make_code(codes),
            "friends": [],
            "created": now(),
        }
        self.data["players"][pid] = player
        self.requests(pid)
        self.save()
        return player

    def set_name(self, pid: str, name: str) -> None:
        player = self.player(pid)
        if player and player.get("name") != name:
            player["name"] = clean_name(name)
            self.save()

    def add_request(self, from_id: str, to_id: str) -> str:
        """Returns: requested | pending | already_friends | auto_accepted"""
        a = self.player(from_id)
        b = self.player(to_id)
        if not a or not b:
            return "not_found"
        if to_id in a.get("friends", []):
            return "already_friends"
        ra = self.requests(from_id)
        rb = self.requests(to_id)
        if from_id in rb["in"]:
            # Karşılıklı istek: otomatik kabul
            self.accept(to_id, from_id)
            return "auto_accepted"
        if to_id in ra["out"]:
            return "pending"
        if to_id not in ra["out"]:
            ra["out"].append(to_id)
        if from_id not in rb["in"]:
            rb["in"].append(from_id)
        self.save()
        return "requested"

    def accept(self, owner_id: str, requester_id: str) -> bool:
        owner = self.player(owner_id)
        requester = self.player(requester_id)
        if not owner or not requester:
            return False
        req = self.requests(owner_id)
        if requester_id not in req["in"]:
            return False
        req["in"] = [p for p in req["in"] if p != requester_id]
        rreq = self.requests(requester_id)
        rreq["out"] = [p for p in rreq["out"] if p != owner_id]
        if requester_id not in owner.setdefault("friends", []):
            owner["friends"].append(requester_id)
        if owner_id not in requester.setdefault("friends", []):
            requester["friends"].append(owner_id)
        # Bekleyen karşılıklı istekleri temizle
        rreq["in"] = [p for p in rreq["in"] if p != owner_id]
        req["out"] = [p for p in req["out"] if p != requester_id]
        self.save()
        return True

    def decline(self, owner_id: str, requester_id: str) -> bool:
        req = self.requests(owner_id)
        if requester_id not in req["in"]:
            return False
        req["in"] = [p for p in req["in"] if p != requester_id]
        rreq = self.requests(requester_id)
        rreq["out"] = [p for p in rreq["out"] if p != owner_id]
        self.save()
        return True

    def remove_friend(self, a_id: str, b_id: str) -> bool:
        a = self.player(a_id)
        b = self.player(b_id)
        if not a or not b:
            return False
        changed = False
        if b_id in a.get("friends", []):
            a["friends"] = [p for p in a["friends"] if p != b_id]
            changed = True
        if a_id in b.get("friends", []):
            b["friends"] = [p for p in b["friends"] if p != a_id]
            changed = True
        ra = self.requests(a_id)
        rb = self.requests(b_id)
        for bucket in (ra, rb):
            bucket["in"] = [p for p in bucket["in"] if p not in (a_id, b_id)]
            bucket["out"] = [p for p in bucket["out"] if p not in (a_id, b_id)]
        if changed:
            self.save()
        return changed


class Conn:
    def __init__(self, pid: str, writer: asyncio.StreamWriter):
        self.pid = pid
        self.writer = writer
        self.lock = asyncio.Lock()
        self.closed = False

    async def send(self, payload: Dict[str, Any]) -> None:
        if self.closed:
            return
        data = (json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
        async with self.lock:
            try:
                self.writer.write(data)
                await self.writer.drain()
            except Exception:
                self.closed = True


class Relay:
    def __init__(self, store: Store, control_port: int = 19021, tunnel_port: int = 19022,
                 advertise_tunnel_port: int = 0):
        self.store = store
        self.control_port = control_port
        self.tunnel_port = tunnel_port
        self.advertise_tunnel_port = int(advertise_tunnel_port or tunnel_port)
        self.online: Dict[str, Conn] = {}
        self.sessions: Dict[str, Dict[str, Any]] = {}
        self.pairs: Dict[str, Dict[str, Any]] = {}
        self.tickets: Dict[str, Dict[str, Any]] = {}
        self.bad_handshakes: Dict[str, list] = {}
        self.bad_global: list = []
        self.tunnel_sem = asyncio.Semaphore(64)
        self.req_seq = 0

    # ---------------------------------------------------------------- helpers
    def session_public(self, session: Dict[str, Any]) -> Dict[str, Any]:
        host = self.store.player(session["host"])
        return {
            "session_id": session["id"],
            "host_id": session["host"],
            "host_name": host["name"] if host else "Oyuncu",
            "world": session["world"],
            "port": session.get("port", 25565),
            "created": session["created"],
            "expires": session.get("invite_expires", session["expires"]),
            "noise_public": session.get("noise_public", ""),
            "udp_candidate": session.get("udp_candidate", {}),
            "guests": list(session.get("guests", [])),
        }

    def friend_public(self, pid: str) -> Dict[str, Any]:
        player = self.store.player(pid)
        if not player:
            return {}
        conn = self.online.get(pid)
        status = "offline"
        detail = ""
        if conn:
            status = getattr(conn, "status", "menu")
            detail = getattr(conn, "detail", "")
        return {
            "player_id": pid,
            "name": player["name"],
            "code": player.get("code", ""),
            "noise_public": player.get("noise_public", ""),
            "online": bool(conn),
            "status": status,
            "detail": detail,
        }

    def pending_requests(self, pid: str) -> Dict[str, list]:
        req = self.store.requests(pid)
        incoming = []
        outgoing = []
        for other in req["in"]:
            p = self.store.player(other)
            if p:
                incoming.append({"player_id": other, "name": p["name"], "code": p.get("code", "")})
        for other in req["out"]:
            p = self.store.player(other)
            if p:
                outgoing.append({"player_id": other, "name": p["name"], "code": p.get("code", "")})
        return {"in": incoming, "out": outgoing}

    def active_sessions_for(self, pid: str) -> list:
        player = self.store.player(pid)
        if not player:
            return []
        friends = set(player.get("friends", []))
        result = []
        t = now()
        for session in self.sessions.values():
            if not session.get("active"):
                continue
            if session["host"] not in friends:
                continue
            if session.get("invite_expires", session["expires"]) <= t:
                continue
            if pid in session.get("guests", []):
                continue
            result.append(self.session_public(session))
        result.sort(key=lambda s: s["created"], reverse=True)
        return result

    def snapshot(self, pid: str) -> Dict[str, Any]:
        player = self.store.player(pid)
        if not player:
            return {}
        conn = self.online.get(pid)
        hosted = None
        joined = None
        for session in self.sessions.values():
            if not session.get("active"):
                continue
            if session.get("host") == pid and hosted is None:
                hosted = self.session_public(session)
            if pid in session.get("guests", []) and joined is None:
                joined = self.session_public(session)
        return {
            "you": {
                "player_id": pid,
                "name": player["name"],
                "code": player.get("code", ""),
                "online": True,
                "status": getattr(conn, "status", "menu") if conn else "menu",
            },
            "friends": [self.friend_public(fid) for fid in player.get("friends", []) if self.store.player(fid)],
            "requests": self.pending_requests(pid),
            "invites": self.active_sessions_for(pid),
            "hosted": hosted,
            "joined": joined,
            "relay": {"control_port": self.control_port, "tunnel_port": self.advertise_tunnel_port},
            "server_time": now(),
        }

    async def send_event(self, pid: str, event: str, payload: Optional[Dict[str, Any]] = None) -> None:
        conn = self.online.get(pid)
        if not conn:
            return
        msg = {"type": "event", "event": event}
        if payload:
            msg.update(payload)
        await conn.send(msg)

    async def send_active_invites(self, viewer: str, host: str) -> None:
        """Yeni arkadaşlık kurulunca host'un açık dünyasını viewer'a bildir."""
        for session in self.sessions.values():
            if not session.get("active") or session.get("host") != host:
                continue
            if session.get("invite_expires", session["expires"]) <= now():
                continue
            if viewer in session.get("guests", []):
                continue
            await self.send_event(viewer, "world_invite", {"session": self.session_public(session)})

    async def broadcast_friends(self, pid: str, event: str, payload: Optional[Dict[str, Any]] = None) -> None:
        player = self.store.player(pid)
        if not player:
            return
        for fid in player.get("friends", []):
            await self.send_event(fid, event, payload)

    # ---------------------------------------------------------------- control
    async def handle_control(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        conn: Optional[Conn] = None
        pid = ""
        try:
            first = await self.read_msg(reader)
            if not first or first.get("type") != "hello":
                await self.send_raw(writer, {"type": "error", "error": "hello_required"})
                return
            pid = clean_id(first.get("player_id"))
            name = clean_name(first.get("name"))
            noise_public = str(first.get("noise_public") or "")[:120]
            if not pid:
                await self.send_raw(writer, {"type": "error", "error": "invalid_player_id"})
                return

            player = self.store.player(pid)
            if player is None:
                await self.send_raw(writer, {"type": "register_required"})
                reg = await self.read_msg(reader)
                if not reg or reg.get("type") != "register":
                    await self.send_raw(writer, {"type": "error", "error": "register_required"})
                    return
                secret_hash = str(reg.get("secret_hash") or "")
                if not re.fullmatch(r"[0-9a-f]{64}", secret_hash):
                    await self.send_raw(writer, {"type": "error", "error": "invalid_secret"})
                    return
                player = self.store.register(pid, name, secret_hash)
            else:
                nonce = secrets.token_hex(24)
                await self.send_raw(writer, {"type": "challenge", "nonce": nonce})
                auth = await self.read_msg(reader)
                if not auth or auth.get("type") != "auth":
                    await self.send_raw(writer, {"type": "error", "error": "auth_required"})
                    return
                proof = str(auth.get("proof") or "")
                # proof = HMAC-SHA256(secret, nonce); istemci secret'i gondermez.
                if not proof or not player.get("secret_hash"):
                    await self.send_raw(writer, {"type": "error", "error": "auth_failed"})
                    return
                # secret_hash saklandığı için HMAC'i doğrudan doğrulayamayız.
                # İstemci ayrıca nonce'u secret ile HMAC'ler; sunucu da
                # kayıtlı secret_hash'i anahtar olarak kullanıp aynı proof'u
                # üretir. Böylece secret hiçbir zaman iletilmez.
                expected = hmac.new(
                    player["secret_hash"].encode("utf-8"), nonce.encode("utf-8"), hashlib.sha256
                ).hexdigest()
                if not hmac.compare_digest(proof, expected):
                    await self.send_raw(writer, {"type": "error", "error": "auth_failed"})
                    return

            player = self.store.player(pid)
            if player is not None and noise_public and player.get("noise_public") != noise_public:
                player["noise_public"] = noise_public
                self.store.save()
            self.store.set_name(pid, name)
            conn = Conn(pid, writer)
            conn.status = "menu"
            conn.detail = ""
            old = self.online.get(pid)
            if old and old is not conn:
                old.closed = True
                try:
                    old.writer.close()
                except Exception:
                    pass
            self.online[pid] = conn
            await conn.send({"type": "hello_ok", **self.snapshot(pid)})
            await self.broadcast_friends(pid, "presence", {"friend": self.friend_public(pid)})
            log(f"online: {name} ({pid[:8]})")

            while True:
                msg = await self.read_msg(reader)
                if msg is None:
                    break
                await self.dispatch(conn, msg)
        except (asyncio.IncompleteReadError, ConnectionResetError, BrokenPipeError):
            pass
        except Exception as exc:
            log(f"control hata: {type(exc).__name__}: {exc}")
        finally:
            if conn and self.online.get(pid) is conn:
                self.online.pop(pid, None)
                try:
                    await self.broadcast_friends(pid, "presence", {"friend": self.friend_public(pid)})
                except Exception:
                    pass
                await self._cleanup_disconnected(pid)
                log(f"offline: {pid[:8]}")
            try:
                writer.close()
                await writer.wait_closed()
            except Exception:
                pass

    async def dispatch(self, conn: Conn, msg: Dict[str, Any]) -> None:
        req_id = msg.get("req_id")
        mtype = str(msg.get("type") or "")
        try:
            result = await self.handle_request(conn, msg)
        except Exception as exc:
            result = {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
        if req_id is not None:
            result["req_id"] = req_id
            await conn.send({"type": "response", **result})

    async def handle_request(self, conn: Conn, msg: Dict[str, Any]) -> Dict[str, Any]:
        pid = conn.pid
        mtype = str(msg.get("type") or "")

        if mtype == "ping":
            return {"ok": True, "pong": now()}

        if mtype == "set_name":
            self.store.set_name(pid, clean_name(msg.get("name")))
            await self.broadcast_friends(pid, "presence", {"friend": self.friend_public(pid)})
            return {"ok": True, "you": self.friend_public(pid)}

        if mtype == "presence":
            status = str(msg.get("status") or "menu")
            if status not in ("menu", "playing", "idle"):
                status = "menu"
            conn.status = status
            conn.detail = clean_world(msg.get("detail")) if msg.get("detail") else ""
            await self.broadcast_friends(pid, "presence", {"friend": self.friend_public(pid)})
            return {"ok": True, "you": self.friend_public(pid)}

        if mtype == "friend_request":
            target = None
            if msg.get("code"):
                target = self.store.by_code(str(msg["code"]))
            elif msg.get("player_id"):
                target = self.store.player(clean_id(msg["player_id"]))
            if not target:
                return {"ok": False, "error": "friend_not_found"}
            if target["id"] == pid:
                return {"ok": False, "error": "self_request"}
            result = self.store.add_request(pid, target["id"])
            if result == "not_found":
                return {"ok": False, "error": "friend_not_found"}
            if result == "already_friends":
                return {"ok": False, "error": "already_friends"}
            if result == "pending":
                return {"ok": True, "state": "pending"}
            if result == "requested":
                await self.send_event(
                    target["id"],
                    "friend_request",
                    {"from": self.friend_public(pid)},
                )
                return {"ok": True, "state": "requested"}
            if result == "auto_accepted":
                await self.send_event(pid, "friend_accepted", {"friend": self.friend_public(target["id"])})
                await self.send_event(target["id"], "friend_accepted", {"friend": self.friend_public(pid)})
                await self.send_active_invites(pid, target["id"])
                await self.send_active_invites(target["id"], pid)
                return {"ok": True, "state": "accepted"}

        if mtype == "friend_respond":
            requester = clean_id(msg.get("player_id"))
            accept = bool(msg.get("accept"))
            req = self.store.requests(pid)
            if requester not in req["in"]:
                return {"ok": False, "error": "request_not_found"}
            if accept:
                if not self.store.accept(pid, requester):
                    return {"ok": False, "error": "request_not_found"}
                await self.send_event(pid, "friend_accepted", {"friend": self.friend_public(requester)})
                await self.send_event(requester, "friend_accepted", {"friend": self.friend_public(pid)})
                await self.send_active_invites(pid, requester)
                await self.send_active_invites(requester, pid)
                return {"ok": True, "state": "accepted"}
            self.store.decline(pid, requester)
            await self.send_event(requester, "friend_declined", {"friend": self.friend_public(pid)})
            return {"ok": True, "state": "declined"}

        if mtype == "friend_remove":
            other = clean_id(msg.get("player_id"))
            if not other:
                return {"ok": False, "error": "invalid_player"}
            removed = self.store.remove_friend(pid, other)
            if not removed:
                return {"ok": False, "error": "not_friends"}
            await self.end_sessions_between(pid, other)
            await self.send_event(pid, "friend_removed", {"friend": self.friend_public(other)})
            await self.send_event(other, "friend_removed", {"friend": self.friend_public(pid)})
            return {"ok": True}

        if mtype == "world_share":
            world = clean_world(msg.get("world"))
            try:
                port = int(msg.get("port") or 25565)
            except Exception:
                port = 25565
            if not (1 <= port <= 65535):
                return {"ok": False, "error": "invalid_port"}
            # Aynı host'un eski oturumunu kapat
            for sid, session in list(self.sessions.items()):
                if session.get("host") == pid and session.get("active"):
                    await self.end_session(sid, notify=True)
            sid = secrets.token_hex(4)
            session = {
                "id": sid,
                "host": pid,
                "world": world,
                "port": port,
                "noise_public": str(msg.get("noise_public") or "")[:120],
                "udp_candidate": clean_udp_candidate(msg.get("udp_candidate")),
                "created": now(),
                "expires": now() + SESSION_TTL,
                "invite_expires": now() + INVITE_TTL,
                "active": True,
                "guests": [],
            }
            self.sessions[sid] = session
            for fid in self.store.player(pid).get("friends", []):
                await self.send_event(fid, "world_invite", {"session": self.session_public(session)})
            return {
                "ok": True,
                "session": self.session_public(session),
                "tunnel_port": self.advertise_tunnel_port,
                "local_tunnel_port": self.tunnel_port,
            }

        if mtype == "world_unshare":
            sid = str(msg.get("session_id") or "")
            session = self.sessions.get(sid)
            if not session or session.get("host") != pid:
                return {"ok": False, "error": "session_not_found"}
            await self.end_session(sid, notify=True)
            return {"ok": True}

        if mtype == "world_join":
            sid = str(msg.get("session_id") or "")
            session = self.sessions.get(sid)
            if not session or not session.get("active") or session.get("invite_expires", session["expires"]) <= now():
                return {"ok": False, "error": "session_not_found"}
            host = session["host"]
            if host == pid:
                return {"ok": False, "error": "own_session"}
            player = self.store.player(pid)
            if host not in player.get("friends", []):
                return {"ok": False, "error": "not_friends"}
            host_conn = self.online.get(host)
            if not host_conn:
                return {"ok": False, "error": "host_offline"}
            token = secrets.token_hex(32)
            ticket_id = hs_new_ticket_id()
            self.pairs[token] = {
                "token": token,
                "ticket_id": ticket_id,
                "session_id": sid,
                "host": host,
                "guest": pid,
                "created": now(),
                "host_reader": None,
                "guest_reader": None,
                "host_writer": None,
                "guest_writer": None,
                "guest_udp_candidate": clean_udp_candidate(msg.get("udp_candidate")),
                "paired": False,
                "event": asyncio.Event(),
                "used": {},
            }
            self.tickets[ticket_id] = self.pairs[token]
            if pid not in session.setdefault("guests", []):
                session["guests"].append(pid)
            await self.send_event(host, "world_updated", {"session": self.session_public(session)})
            await self.send_event(
                host,
                "tunnel_request",
                {
                    "token": token,
                    "ticket_id": ticket_id,
                    "session_id": sid,
                    "guest_id": pid,
                    "guest_name": self.store.player(pid)["name"],
                    "guest_noise_public": self.store.player(pid).get("noise_public", ""),
                    "guest_udp_candidate": self.pairs[token].get("guest_udp_candidate", {}),
                },
            )
            return {
                "ok": True,
                "session": self.session_public(session),
                "token": token,
                "ticket_id": ticket_id,
                "tunnel_port": self.advertise_tunnel_port,
                "local_tunnel_port": self.tunnel_port,
            }

        if mtype == "world_leave":
            sid = str(msg.get("session_id") or "")
            session = self.sessions.get(sid)
            if session and pid in session.get("guests", []):
                session["guests"] = [p for p in session["guests"] if p != pid]
                await self.send_event(session.get("host"), "world_updated", {"session": self.session_public(session)})
            await self.close_pairs_for_guest(pid, sid)
            return {"ok": True}

        if mtype == "list":
            return {"ok": True, **self.snapshot(pid)}

        return {"ok": False, "error": "unknown_type"}

    async def end_sessions_between(self, a: str, b: str) -> None:
        for sid, session in list(self.sessions.items()):
            if not session.get("active"):
                continue
            guests = session.get("guests", [])
            if (session.get("host") == a and b in guests) or (session.get("host") == b and a in guests):
                await self.end_session(sid, notify=True)

    async def end_session(self, sid: str, notify: bool = True) -> None:
        session = self.sessions.get(sid)
        if not session:
            return
        session["active"] = False
        for token, pair in list(self.pairs.items()):
            if pair.get("session_id") == sid:
                await self._close_pair(token, "session_ended")
        if notify:
            payload = {"session_id": sid, "host_id": session.get("host")}
            for fid in self.store.player(session["host"]).get("friends", []):
                await self.send_event(fid, "world_ended", payload)
            for guest in session.get("guests", []):
                await self.send_event(guest, "world_ended", payload)
        self.sessions.pop(sid, None)

    async def _close_pair(self, token: str, reason: str) -> None:
        pair = self.pairs.pop(token, None)
        if not pair:
            return
        tid = pair.get("ticket_id")
        if tid:
            self.tickets.pop(tid, None)
        try:
            pair.get("event").set()
        except Exception:
            pass
        session = self.sessions.get(pair.get("session_id", ""))
        if session:
            guest = pair.get("guest")
            session["guests"] = [p for p in session.get("guests", []) if p != guest]
            if session.get("active") and session.get("host"):
                try:
                    await self.send_event(session["host"], "world_updated", {"session": self.session_public(session)})
                except Exception:
                    pass
        for role in ("host_writer", "guest_writer"):
            writer = pair.get(role)
            if writer:
                try:
                    writer.close()
                    await writer.wait_closed()
                except Exception:
                    pass

    async def close_pairs_for_guest(self, guest: str, sid: str = "") -> None:
        for token, pair in list(self.pairs.items()):
            if pair.get("guest") == guest and (not sid or pair.get("session_id") == sid):
                await self._close_pair(token, "guest_left")

    # ---------------------------------------------------------------- tunnel
    def _peer_allowed(self, peer: str) -> bool:
        import time as _time
        now = _time.time()
        # bore.pub üzerinden gelen tüm bağlantılar host'ta loopback görünür;
        # per-IP limit bu durumda herkesi banlardı. Global bir üst sınır kullan.
        if peer in ("127.0.0.1", "::1", "localhost"):
            self.bad_global = [t for t in self.bad_global if now - t < 60]
            return len(self.bad_global) < 240
        bucket = [t for t in self.bad_handshakes.get(peer, []) if now - t < 60]
        self.bad_handshakes[peer] = bucket
        return len(bucket) < 10

    def _record_bad(self, peer: str) -> None:
        import time as _time
        now = _time.time()
        self.bad_global = [t for t in self.bad_global if now - t < 60] + [now]
        if peer not in ("127.0.0.1", "::1", "localhost"):
            self.bad_handshakes.setdefault(peer, []).append(now)

    async def handle_tunnel(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        peer = "?"
        try:
            peer = str((writer.get_extra_info("peername") or ("?", 0))[0])
        except Exception:
            pass
        if not self._peer_allowed(peer):
            try:
                writer.close()
            except Exception:
                pass
            return
        try:
            await asyncio.wait_for(self.tunnel_sem.acquire(), timeout=0.2)
        except asyncio.TimeoutError:
            try:
                writer.close()
            except Exception:
                pass
            return
        pair = None
        token = ""
        paired_here = False
        try:
            auth = await server_handshake(reader, writer, self.tickets, peer)
            if not auth:
                self._record_bad(peer)
                send_result(writer, False, 1)
                await writer.drain()
                return
            pair, role = auth
            token = str(pair.get("token") or "")
            send_result(writer, True, 0)
            await writer.drain()
            if role == ROLE_HOST:
                if pair.get("host_writer"):
                    return
                pair["host_writer"] = writer
                pair["host_reader"] = reader
            else:
                if pair.get("guest_writer"):
                    return
                pair["guest_writer"] = writer
                pair["guest_reader"] = reader

            both_ready = bool(pair.get("host_writer") and pair.get("guest_writer"))
            if both_ready and not pair.get("paired"):
                pair["paired"] = True
                pair["event"].set()
                try:
                    send_ready(pair["host_writer"])
                    send_ready(pair["guest_writer"])
                    await pair["host_writer"].drain()
                    await pair["guest_writer"].drain()
                except Exception:
                    await self._close_pair(token, "pair_write_failed")
                    return
                paired_here = True
                log(f"tunnel paired: {token[:8]} session={pair['session_id']}")
            elif not both_ready:
                try:
                    await asyncio.wait_for(pair["event"].wait(), timeout=PAIR_TTL)
                except asyncio.TimeoutError:
                    send_result(writer, False, 2)
                    await writer.drain()
                    await self._close_pair(token, "timeout")
                    return

            if not pair.get("paired"):
                send_result(writer, False, 3)
                await writer.drain()
                return

            other_writer = pair["guest_writer"] if role == ROLE_HOST else pair["host_writer"]
            await self._pipe(reader, other_writer, token)
        except Exception as exc:
            log(f"tunnel hata: {type(exc).__name__}: {exc}")
        finally:
            if pair and not pair.get("paired"):
                await self._close_pair(token, "tunnel_aborted")
            self.tunnel_sem.release()
            try:
                writer.close()
                await writer.wait_closed()
            except Exception:
                pass

    async def _pipe(self, src_reader, dst_writer, token: str) -> None:
        try:
            while True:
                data = await src_reader.read(65536)
                if not data:
                    break
                dst_writer.write(data)
                await dst_writer.drain()
        except Exception:
            pass
        finally:
            await self._close_pair(token, "pipe_closed")

    async def _tunnel_error(self, writer: asyncio.StreamWriter, reason: str) -> None:
        try:
            writer.write(f"ERROR {reason}\n".encode("utf-8"))
            await writer.drain()
        except Exception:
            pass

    # ---------------------------------------------------------------- io
    async def read_msg(self, reader: asyncio.StreamReader) -> Optional[Dict[str, Any]]:
        try:
            line = await asyncio.wait_for(reader.readline(), timeout=120)
        except (asyncio.TimeoutError, asyncio.IncompleteReadError):
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

    async def send_raw(self, writer: asyncio.StreamWriter, payload: Dict[str, Any]) -> None:
        try:
            writer.write((json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8"))
            await writer.drain()
        except Exception:
            pass

    async def _cleanup_disconnected(self, pid: str) -> None:
        """Host gidince oturumunu kapat; guest gidince daveti temizle."""
        for sid, session in list(self.sessions.items()):
            if not session.get("active"):
                continue
            if session.get("host") == pid:
                await self.end_session(sid, notify=True)
            elif pid in session.get("guests", []):
                session["guests"] = [p for p in session.get("guests", []) if p != pid]
        await self.close_pairs_for_guest(pid)

    async def cleanup_loop(self) -> None:
        while True:
            await asyncio.sleep(15)
            t = now()
            for sid, session in list(self.sessions.items()):
                if session.get("active") and session.get("expires", 0) <= t:
                    await self.end_session(sid, notify=True)
            for token, pair in list(self.pairs.items()):
                if pair.get("created", 0) + PAIR_TTL * 2 <= t:
                    await self._close_pair(token, "expired")


async def run(args: argparse.Namespace) -> None:
    store = Store(args.data)
    relay = Relay(store, control_port=args.control_port, tunnel_port=args.tunnel_port,
                  advertise_tunnel_port=args.advertise_tunnel_port)
    ssl_ctx = None
    if args.tls_cert and args.tls_key:
        ssl_ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ssl_ctx.load_cert_chain(args.tls_cert, args.tls_key)
        log("TLS etkin")
    control = await asyncio.start_server(relay.handle_control, args.host, args.control_port, ssl=ssl_ctx)
    tunnel = await asyncio.start_server(relay.handle_tunnel, args.host, args.tunnel_port, ssl=ssl_ctx)
    control_port = control.sockets[0].getsockname()[1]
    tunnel_port = tunnel.sockets[0].getsockname()[1]
    relay.control_port = control_port
    relay.tunnel_port = tunnel_port
    if not relay.advertise_tunnel_port or relay.advertise_tunnel_port == args.tunnel_port:
        relay.advertise_tunnel_port = tunnel_port
    ready = {"control_port": control_port, "tunnel_port": tunnel_port,
             "advertise_tunnel_port": relay.advertise_tunnel_port, "data": args.data, "tls": bool(ssl_ctx)}
    print("RELAY_READY " + json.dumps(ready), flush=True)
    log(f"control :{control_port}  tunnel :{tunnel_port}  data={args.data}")
    async with control, tunnel:
        await asyncio.gather(
            control.serve_forever(),
            tunnel.serve_forever(),
            relay.cleanup_loop(),
        )


def parse_args(argv=None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Cookie Launcher social relay")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--control-port", type=int, default=int(os.environ.get("SOCIAL_CONTROL_PORT", "19021")))
    parser.add_argument("--tunnel-port", type=int, default=int(os.environ.get("SOCIAL_TUNNEL_PORT", "19022")))
    parser.add_argument("--data", default=os.environ.get("SOCIAL_RELAY_DATA", DEFAULT_DATA))
    parser.add_argument("--tls-cert", default=os.environ.get("SOCIAL_TLS_CERT", ""))
    parser.add_argument("--tls-key", default=os.environ.get("SOCIAL_TLS_KEY", ""))
    parser.add_argument("--advertise-tunnel-port", type=int, default=int(os.environ.get("SOCIAL_ADVERTISE_TUNNEL_PORT", "0")))
    return parser.parse_args(argv)


def main(argv=None) -> int:
    try:
        asyncio.run(run(parse_args(argv)))
    except KeyboardInterrupt:
        return 0
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
