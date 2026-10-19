#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""CLT1 — relay tunnel'ı için binary HMAC challenge-response.

Tünel token'ı kablo üzerinden gönderilmez. İstemci önce ticket_id ile
tanıtır, sunucu tek kullanımlık nonce verir, istemci HMAC ile yanıtlar.
Auth tamamlanana kadar Minecraft soketine dokunulmaz.
"""

from __future__ import annotations

import hashlib
import hmac
import os
import socket
import struct
import time
from typing import Any, Dict, Optional

MAGIC = b"CLT1"
VERSION = 1

CLIENT_HELLO = 1
SERVER_HELLO = 2
CLIENT_AUTH = 3
RESULT = 4
READY = 5

ROLE_HOST = 0
ROLE_GUEST = 1

HELLO_STRUCT = struct.Struct("!4sBB8s")
SERVER_HELLO_STRUCT = struct.Struct("!4sBB8sI16s")
AUTH_STRUCT = struct.Struct("!4sBB8sB16s32s")
RESULT_STRUCT = struct.Struct("!4sBBB")
READY_STRUCT = struct.Struct("!4sBB")

HANDSHAKE_TIMEOUT = 3.0
READY_TIMEOUT = 20.0


def new_ticket_id() -> str:
    return os.urandom(8).hex()


def new_token() -> str:
    return os.urandom(32).hex()


def _mac(token: bytes, ticket_id: bytes, role: int, server_nonce: bytes, client_nonce: bytes) -> bytes:
    msg = (
        MAGIC
        + bytes([VERSION, CLIENT_AUTH])
        + ticket_id
        + bytes([role])
        + server_nonce
        + client_nonce
    )
    return hmac.new(token, msg, hashlib.sha256).digest()


def _recv_exact(sock: socket.socket, n: int) -> bytes:
    data = bytearray()
    while len(data) < n:
        chunk = sock.recv(n - len(data))
        if not chunk:
            raise ConnectionError("handshake: bağlantı kapandı")
        data += chunk
    return bytes(data)


def _recv_exact_async(reader, n: int) -> bytes:
    return reader.readexactly(n)


def client_handshake(sock: socket.socket, ticket_id: str, token: str, role: int,
                     timeout: float = HANDSHAKE_TIMEOUT) -> None:
    """Tünel soketinde HMAC handshake yapar; başarısızsa SocialError fırlatır."""
    tid = bytes.fromhex(ticket_id)
    if len(tid) != 8:
        raise ValueError("ticket_id 8 bayt olmalı")
    old_timeout = sock.gettimeout()
    sock.settimeout(timeout)
    try:
        sock.sendall(HELLO_STRUCT.pack(MAGIC, VERSION, CLIENT_HELLO, tid))
        raw = _recv_exact(sock, SERVER_HELLO_STRUCT.size)
        magic, ver, typ, sid, expires, server_nonce = SERVER_HELLO_STRUCT.unpack(raw)
        if magic != MAGIC or ver != VERSION or typ != SERVER_HELLO or sid != tid:
            raise ConnectionError("handshake: sunucu yanıtı geçersiz")
        if expires and expires < int(time.time()):
            raise ConnectionError("handshake: ticket süresi doldu")
        client_nonce = os.urandom(16)
        mac = _mac(bytes.fromhex(token), tid, int(role), server_nonce, client_nonce)
        sock.sendall(AUTH_STRUCT.pack(MAGIC, VERSION, CLIENT_AUTH, tid, int(role), client_nonce, mac))
        raw = _recv_exact(sock, RESULT_STRUCT.size)
        r_magic, r_ver, r_typ, status = RESULT_STRUCT.unpack(raw)
        if r_magic != MAGIC or r_ver != VERSION or r_typ != RESULT or status != 0:
            raise ConnectionError("handshake: kimlik doğrulama reddedildi")
        # İki taraf da auth olmadan READY gelmez.
        sock.settimeout(max(timeout, READY_TIMEOUT))
        raw = _recv_exact(sock, READY_STRUCT.size)
        p_magic, p_ver, p_typ = READY_STRUCT.unpack(raw)
        if p_magic != MAGIC or p_ver != VERSION or p_typ != READY:
            raise ConnectionError("handshake: eşleşme onayı gelmedi")
    finally:
        try:
            sock.settimeout(old_timeout)
        except Exception:
            pass


async def server_handshake(reader, writer, tickets: Dict[str, Dict[str, Any]],
                           peer: str = "") -> Optional[tuple]:
    """Tünel sunucusunda handshake. Başarıda (pair, role) döner."""
    try:
        hello = await asyncio_wait(reader.readexactly(HELLO_STRUCT.size), HANDSHAKE_TIMEOUT)
    except Exception:
        return None
    magic, ver, typ, tid = HELLO_STRUCT.unpack(hello)
    if magic != MAGIC or ver != VERSION or typ != CLIENT_HELLO:
        return None
    token_hex = tid.hex()
    pair = tickets.get(token_hex)
    if not pair:
        return None
    if pair.get("created", 0) + 90 < time.time():
        return None
    nonce = os.urandom(16)
    expires = int(pair.get("created", time.time()) + 90)
    try:
        writer.write(SERVER_HELLO_STRUCT.pack(MAGIC, VERSION, SERVER_HELLO, tid, expires, nonce))
        await writer.drain()
    except Exception:
        return None
    try:
        auth = await asyncio_wait(reader.readexactly(AUTH_STRUCT.size), HANDSHAKE_TIMEOUT)
    except Exception:
        return None
    a_magic, a_ver, a_typ, a_tid, role, cnonce, mac = AUTH_STRUCT.unpack(auth)
    if a_magic != MAGIC or a_ver != VERSION or a_typ != CLIENT_AUTH or a_tid != tid:
        return None
    if role not in (ROLE_HOST, ROLE_GUEST):
        return None
    used = pair.setdefault("used", {})
    if used.get(role):
        return None
    expected = _mac(bytes.fromhex(str(pair.get("token") or "")), tid, int(role), nonce, cnonce)
    if not hmac.compare_digest(mac, expected):
        return None
    used[role] = True
    return pair, int(role)


async def asyncio_wait(awaitable, timeout: float):
    import asyncio
    return await asyncio.wait_for(awaitable, timeout=timeout)


def send_result(writer, ok: bool, code: int = 0) -> None:
    writer.write(RESULT_STRUCT.pack(MAGIC, VERSION, RESULT, 0 if ok else code))


def send_ready(writer) -> None:
    writer.write(READY_STRUCT.pack(MAGIC, VERSION, READY))
