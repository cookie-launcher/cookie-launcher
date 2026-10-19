#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""RFC 5389/3489 hafif STUN binding istemcisi.

Harici bağımlılık yok. Aynı UDP soketi hem STUN keşfi hem hole-punching için
kullanılır; böylece NAT'in öğrenilen dış portu delme için geçerli olur.
"""

from __future__ import annotations

import os
import socket
import struct
import time
from typing import Iterable, List, Optional, Tuple

MAGIC_COOKIE = 0x2112A442
BINDING_REQUEST = 0x0001
BINDING_RESPONSE = 0x0101
BINDING_ERROR = 0x0111
ATTR_MAPPED_ADDRESS = 0x0001
ATTR_XOR_MAPPED_ADDRESS = 0x0020

DEFAULT_SERVERS: Tuple[Tuple[str, int], ...] = (
    ("stun.l.google.com", 19302),
    ("stun.cloudflare.com", 3478),
    ("stun1.l.google.com", 19302),
)


class STUNError(RuntimeError):
    pass


def _txid() -> bytes:
    return os.urandom(12)


def build_request(txid: bytes) -> bytes:
    if len(txid) != 12:
        raise ValueError("STUN transaction id 12 byte olmalı")
    return struct.pack("!HHI", BINDING_REQUEST, 0, MAGIC_COOKIE) + txid


def _attr(attr_type: int, value: bytes) -> bytes:
    pad = (-len(value)) % 4
    return struct.pack("!HH", attr_type, len(value)) + value + (b"\x00" * pad)


def build_response(txid: bytes, ip: str, port: int, xor: bool = True) -> bytes:
    packed = socket.inet_aton(ip)
    if xor:
        xport = port ^ (MAGIC_COOKIE >> 16)
        xip = bytes(a ^ b for a, b in zip(packed, struct.pack("!I", MAGIC_COOKIE)))
        value = struct.pack("!BBH", 0, 0x01, xport) + xip
        attrs = _attr(ATTR_XOR_MAPPED_ADDRESS, value)
    else:
        value = struct.pack("!BBH", 0, 0x01, port) + packed
        attrs = _attr(ATTR_MAPPED_ADDRESS, value)
    return struct.pack("!HHI", BINDING_RESPONSE, len(attrs), MAGIC_COOKIE) + txid + attrs


def parse_response(data: bytes, txid: bytes) -> Tuple[str, int]:
    if len(data) < 20:
        raise STUNError("STUN yanıtı kısa")
    msg_type, length, cookie = struct.unpack("!HHI", data[:8])
    if cookie != MAGIC_COOKIE:
        raise STUNError("STUN magic cookie hatalı")
    if data[8:20] != txid:
        raise STUNError("STUN transaction id eşleşmiyor")
    if msg_type == BINDING_ERROR:
        raise STUNError("STUN sunucusu hata döndü")
    if msg_type != BINDING_RESPONSE:
        raise STUNError("Beklenmeyen STUN mesaj tipi")
    end = min(len(data), 20 + length)
    offset = 20
    mapped = None
    while offset + 4 <= end:
        attr_type, attr_len = struct.unpack("!HH", data[offset:offset + 4])
        offset += 4
        value = data[offset:offset + attr_len]
        offset += attr_len + ((-attr_len) % 4)
        if attr_type == ATTR_XOR_MAPPED_ADDRESS and len(value) >= 8:
            family = value[1]
            xport = struct.unpack("!H", value[2:4])[0] ^ (MAGIC_COOKIE >> 16)
            if family == 0x01:
                raw = bytes(a ^ b for a, b in zip(value[4:8], struct.pack("!I", MAGIC_COOKIE)))
            elif family == 0x02 and len(value) >= 20:
                mask = struct.pack("!I", MAGIC_COOKIE) + txid
                raw = bytes(a ^ b for a, b in zip(value[4:20], mask))
            else:
                continue
            mapped = (socket.inet_ntop(socket.AF_INET6 if family == 0x02 else socket.AF_INET, raw), xport)
            break
        if attr_type == ATTR_MAPPED_ADDRESS and len(value) >= 8 and mapped is None:
            family = value[1]
            port = struct.unpack("!H", value[2:4])[0]
            if family == 0x01:
                mapped = (socket.inet_ntoa(value[4:8]), port)
            elif family == 0x02 and len(value) >= 20:
                mapped = (socket.inet_ntop(socket.AF_INET6, value[4:20]), port)
    if not mapped:
        raise STUNError("STUN yanıtında mapped address yok")
    return mapped


def _resolve(server: Tuple[str, int]) -> List[Tuple[int, Tuple[str, int]]]:
    host, port = server
    infos = socket.getaddrinfo(host, port, socket.AF_INET, socket.SOCK_DGRAM)
    return [(info[0], info[4]) for info in infos]


def discover(sock: socket.socket, servers: Iterable[Tuple[str, int]] = DEFAULT_SERVERS,
             timeout: float = 2.0) -> Tuple[str, int]:
    """Aynı bağlı/bağsız UDP soketi üzerinden dış IP:port öğrenir."""
    old_timeout = sock.gettimeout()
    try:
        for server in servers:
            try:
                addresses = _resolve(server)
            except Exception:
                continue
            for family, address in addresses:
                txid = _txid()
                request = build_request(txid)
                try:
                    sock.sendto(request, address)
                except Exception:
                    continue
                deadline = time.time() + timeout
                while time.time() < deadline:
                    sock.settimeout(max(0.05, deadline - time.time()))
                    try:
                        data, source = sock.recvfrom(2048)
                    except socket.timeout:
                        break
                    except Exception:
                        break
                    if source[0] != address[0] or source[1] != address[1]:
                        continue
                    try:
                        return parse_response(data, txid)
                    except STUNError:
                        continue
    finally:
        try:
            sock.settimeout(old_timeout)
        except Exception:
            pass
    raise STUNError("STUN sunucularından yanıt alınamadı")


def discover_new(servers: Iterable[Tuple[str, int]] = DEFAULT_SERVERS,
                 timeout: float = 2.0) -> Tuple[socket.socket, Tuple[str, int], Tuple[str, int]]:
    """Yeni bir UDP soketi açar; (sock, yerel, dış) döndürür."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind(("0.0.0.0", 0))
    try:
        public = discover(sock, servers, timeout)
    except Exception:
        sock.close()
        raise
    return sock, sock.getsockname()[:2], public
