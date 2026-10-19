#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""UDP hole punching + STUN candidate.

Paket: CLP1 | session_hash(8) | type(1) | nonce(8)
- PING sürekli gönderilir, PONG gelince delik açılmış kabul edilir.
- Punch key, CLT1 token'ından türetilir; sahte paketler elenir.
"""

from __future__ import annotations

import hashlib
import hmac
import os
import socket
import struct
import time
from typing import Optional, Tuple

import stun_client
from udp_stream import UDPStream

PUNCH_MAGIC = b"CLP1"
PUNCH_HEADER = struct.Struct("!4s8sB8s")
TYPE_PING = 1
TYPE_PONG = 2


class PunchError(RuntimeError):
    pass


def punch_key(token: str, session_id: str) -> bytes:
    return hmac.new(
        str(token or "").encode("utf-8"),
        str(session_id or "").encode("utf-8"),
        hashlib.sha256,
    ).digest()[:8]


def candidate(value) -> Optional[dict]:
    if not isinstance(value, dict):
        return None
    try:
        host = str(value.get("ip") or value.get("h") or "").strip()
        port = int(value.get("port") or value.get("p") or 0)
    except Exception:
        return None
    if not host or not (1 <= port <= 65535):
        return None
    return {"ip": host, "port": port}


class P2PSession:
    def __init__(self, session_id: str, stun_servers=None, bind: str = "0.0.0.0",
                 timeout: float = 2.0, allow_local: bool = False):
        self.session_id = str(session_id or "")
        self.allow_local = bool(allow_local)
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.sock.bind((bind, 0))
        local = self.sock.getsockname()[:2]
        # allow_local test/LAN modunda 0.0.0.0 yerine erişilebilir loopback yaz.
        self.local = ("127.0.0.1" if local[0] == "0.0.0.0" else local[0], int(local[1]))
        self.public: Optional[Tuple[str, int]] = None
        self.error = ""
        try:
            self.public = stun_client.discover(
                self.sock,
                stun_client.DEFAULT_SERVERS if stun_servers is None else stun_servers,
                timeout=timeout,
            )
        except Exception as exc:
            self.error = str(exc)

    @property
    def candidate(self) -> dict:
        if not self.public and not self.allow_local:
            return {}
        host, port = self.public or self.local
        return {"ip": host, "port": int(port)}

    def punch(self, peer: dict, key: bytes, timeout: float = 3.0) -> bool:
        target = candidate(peer)
        if not target:
            return False
        peer_addr = (target["ip"], target["port"])
        self._peer = peer_addr
        nonce = os.urandom(8)
        packet = PUNCH_HEADER.pack(PUNCH_MAGIC, key, TYPE_PING, nonce)
        pong = PUNCH_HEADER.pack(PUNCH_MAGIC, key, TYPE_PONG, nonce)
        deadline = time.time() + timeout
        self.sock.settimeout(0.15)
        try:
            while time.time() < deadline:
                try:
                    self.sock.sendto(packet, peer_addr)
                except Exception:
                    pass
                try:
                    data, source = self.sock.recvfrom(2048)
                except socket.timeout:
                    continue
                except Exception:
                    break
                if len(data) < PUNCH_HEADER.size:
                    continue
                magic, got_key, kind, got_nonce = PUNCH_HEADER.unpack(data[:PUNCH_HEADER.size])
                if magic != PUNCH_MAGIC or not hmac.compare_digest(got_key, key):
                    continue
                if kind == TYPE_PING:
                    try:
                        self.sock.sendto(
                            PUNCH_HEADER.pack(PUNCH_MAGIC, key, TYPE_PONG, got_nonce),
                            source,
                        )
                    except Exception:
                        pass
                elif kind == TYPE_PONG:
                    return True
        finally:
            try:
                self.sock.settimeout(None)
            except Exception:
                pass
        return False

    def stream(self) -> UDPStream:
        return UDPStream(self.sock, self._peer, self.session_id)

    def set_peer(self, peer: dict) -> None:
        target = candidate(peer)
        if target:
            self._peer = (target["ip"], target["port"])

    def close(self) -> None:
        try:
            self.sock.close()
        except Exception:
            pass
