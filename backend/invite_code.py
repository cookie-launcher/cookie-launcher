#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Cookie Launcher davet kodu codec'i (CL1).

Kısa kod (Worker/rendezvous ile):
    CL1-<room_id>-<session_id>-<expires_hex>

Uzun kod (uç nokta gömülü, Worker'sız fallback):
    CL1-<base64url(JSON)>

Kabul edilen taşıyıcılar:
    CL1-...
    cl://join/CL1-...
    https://cookie-launcher.github.io/join/#CL1-...
    https://cookie-launcher.github.io/join/?c=CL1-...
"""

from __future__ import annotations

import base64
import json
import re
import secrets
import time
from dataclasses import dataclass, field
from typing import Any, Dict, Optional
from urllib.parse import quote, unquote, urlparse

MAGIC = "CL1"
SHORT_RE = re.compile(r"^CL1-([A-Z2-7]{13})-([A-Z2-7]{7})-([0-9A-F]{8})(?:-([A-Z0-9]{6,12}))?$")
LONG_RE = re.compile(r"^CL1-([A-Za-z0-9_-]{20,})$")
TRANSPORT_RE = re.compile(
    r"(?:cl://join/|https?://[^\s#?]+/join/?(?:#|\?(?:c|code)=))([A-Za-z0-9_\-]+)",
    re.I,
)


@dataclass
class Invite:
    version: int
    room_id: str
    session_id: str
    expires: int
    endpoint: Optional[Dict[str, Any]] = None
    host_name: str = ""
    host_code: str = ""
    noise_pub: str = ""
    world: str = ""
    raw: str = ""
    short: bool = True
    extra: Dict[str, Any] = field(default_factory=dict)

    @property
    def expired(self) -> bool:
        return bool(self.expires) and self.expires < int(time.time()) - 60

    def to_dict(self) -> Dict[str, Any]:
        return {
            "v": self.version,
            "rid": self.room_id,
            "sid": self.session_id,
            "exp": self.expires,
            "relay": self.endpoint,
            "host_name": self.host_name,
            "host_code": self.host_code,
            "noise_pub": self.noise_pub,
            "world": self.world,
            "short": self.short,
        }


def _b32(data: bytes) -> str:
    return base64.b32encode(data).decode("ascii").rstrip("=")


def _unb32(text: str, length: int) -> bytes:
    padded = text + "=" * ((8 - len(text) % 8) % 8)
    raw = base64.b32decode(padded, casefold=True)
    if len(raw) != length:
        raise ValueError("base32 uzunluğu hatalı")
    return raw


def new_room_id() -> str:
    return _b32(secrets.token_bytes(8))  # 13 chars


def new_session_id() -> str:
    return _b32(secrets.token_bytes(4))  # 7 chars


def short_session(session_id: str) -> str:
    """Relay'in 8 hex session_id'sini 7 karakter base32'ye çevirir."""
    value = str(session_id or "").strip()
    if re.fullmatch(r"[A-Z2-7]{7}", value.upper()):
        return value.upper()
    if re.fullmatch(r"[0-9a-fA-F]{8}", value):
        return _b32(bytes.fromhex(value))
    raise ValueError("session_id kısa kod için 8 hex veya 7 base32 olmalı")


def make_short(room_id: str, session_id: str, expires: int, host_code: str = "") -> str:
    room = str(room_id or "").strip().upper()
    session = str(session_id or "").strip().upper()
    if not re.fullmatch(r"[A-Z2-7]{13}", room):
        raise ValueError("room_id 13 karakter base32 olmalı")
    if not re.fullmatch(r"[A-Z2-7]{7}", session):
        raise ValueError("session_id 7 karakter base32 olmalı")
    code = f"{MAGIC}-{room}-{session}-{int(expires) & 0xFFFFFFFF:08X}"
    host = re.sub(r"[^A-Za-z0-9]", "", str(host_code or "")).upper()
    if host:
        code += f"-{host}"
    return code


def make_long(room_id: str, session_id: str, expires: int, endpoint: Optional[Dict[str, Any]] = None,
              host_name: str = "", host_code: str = "", noise_pub: str = "", world: str = "") -> str:
    payload = {
        "v": 1,
        "rid": room_id,
        "sid": session_id,
        "exp": int(expires),
    }
    if endpoint:
        payload["relay"] = endpoint
    if host_name:
        payload["host_name"] = host_name
    if host_code:
        payload["host_code"] = host_code
    if noise_pub:
        payload["noise_pub"] = noise_pub
    if world:
        payload["world"] = world
    raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return MAGIC + "-" + base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def normalize(text: str) -> str:
    value = str(text or "").strip().strip("<>()[]{}\"'")
    if not value:
        return ""
    m = TRANSPORT_RE.search(value)
    if m:
        value = unquote(m.group(1))
    value = value.strip().strip("<>()[]{}\"'")
    if value.lower().startswith("cl1-"):
        value = MAGIC + value[3:]
    return value


def parse(text: str, now: Optional[int] = None) -> Invite:
    code = normalize(text)
    if not code:
        raise ValueError("Boş davet kodu")
    now = int(now if now is not None else time.time())
    m = SHORT_RE.fullmatch(code)
    if m:
        exp = int(m.group(3), 16)
        invite = Invite(1, m.group(1), m.group(2), exp, host_code=m.group(4) or "", raw=code, short=True)
        if invite.expired:
            raise ValueError("Davet kodunun süresi dolmuş")
        return invite
    m = LONG_RE.fullmatch(code)
    if m:
        body = m.group(1)
        body += "=" * ((4 - len(body) % 4) % 4)
        try:
            payload = json.loads(base64.urlsafe_b64decode(body.encode("ascii")))
        except Exception as exc:
            raise ValueError("Davet payload'ı çözülemedi") from exc
        if not isinstance(payload, dict) or int(payload.get("v") or 0) != 1:
            raise ValueError("Desteklenmeyen davet sürümü")
        exp = int(payload.get("exp") or 0)
        invite = Invite(
            version=1,
            room_id=str(payload.get("rid") or ""),
            session_id=str(payload.get("sid") or ""),
            expires=exp,
            endpoint=payload.get("relay") if isinstance(payload.get("relay"), dict) else None,
            host_name=str(payload.get("host_name") or ""),
            host_code=str(payload.get("host_code") or ""),
            noise_pub=str(payload.get("noise_pub") or ""),
            world=str(payload.get("world") or ""),
            raw=code,
            short=False,
        )
        if invite.expired:
            raise ValueError("Davet kodunun süresi dolmuş")
        return invite
    raise ValueError("Geçersiz CL1 davet kodu")


def web_link(code: str, base: str = "https://cookie-launcher.github.io/join/") -> str:
    # Query, fragment'e göre WhatsApp/Telegram in-app tarayıcılarında daha dayanıklı.
    return f"{base.rstrip('/')}/?c={quote(normalize(code), safe='')}"


def deep_link(code: str) -> str:
    return f"cl://join/{normalize(code)}"


def parse_any(text: str) -> Invite:
    return parse(text)
