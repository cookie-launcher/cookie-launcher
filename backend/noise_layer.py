#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""CL1 Noise_XX uçtan uca şifreleme katmanı.

Host ile guest arasındaki Minecraft trafiği relay'den geçerken Noise_XX ile
şifrelenir. Relay yalnızca length-prefixed binary frame'ler görür.

Noise mesajları: [uint16 big-endian length][payload]
Handshake: Noise_XX_25519_ChaChaPoly_SHA256
"""

from __future__ import annotations

import base64
import os
import socket
import struct
import sys
from typing import Optional

# Geliştirme ortamında vendored paket; PyInstaller build'inde pip paketi.
try:
    from noise.connection import Keypair, NoiseConnection
except Exception:
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "vendor"))
    from noise.connection import Keypair, NoiseConnection

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey

PROTOCOL = "Noise_XX_25519_ChaChaPoly_SHA256"
MAX_FRAME = 65535
CHUNK = 32768


def generate_keypair() -> tuple[str, str]:
    """(private_hex, public_b64) üretir."""
    private = X25519PrivateKey.generate()
    priv = private.private_bytes(
        serialization.Encoding.Raw,
        serialization.PrivateFormat.Raw,
        serialization.NoEncryption(),
    )
    pub = private.public_key().public_bytes(
        serialization.Encoding.Raw,
        serialization.PublicFormat.Raw,
    )
    return priv.hex(), base64.b64encode(pub).decode("ascii")


def public_from_private(private_hex: str) -> str:
    private = X25519PrivateKey.from_private_bytes(bytes.fromhex(private_hex))
    pub = private.public_key().public_bytes(
        serialization.Encoding.Raw,
        serialization.PublicFormat.Raw,
    )
    return base64.b64encode(pub).decode("ascii")


def send_frame(sock: socket.socket, payload: bytes) -> None:
    if len(payload) > MAX_FRAME:
        raise ValueError("Noise frame çok büyük")
    sock.sendall(struct.pack("!H", len(payload)) + payload)


def recv_exact(sock: socket.socket, n: int) -> bytes:
    data = bytearray()
    while len(data) < n:
        chunk = sock.recv(n - len(data))
        if not chunk:
            raise ConnectionError("Noise frame bağlantısı kapandı")
        data += chunk
    return bytes(data)


def recv_frame(sock: socket.socket) -> bytes:
    header = recv_exact(sock, 2)
    (length,) = struct.unpack("!H", header)
    if length == 0:
        return b""
    return recv_exact(sock, length)


class NoiseSession:
    def __init__(self, private_hex: str, peer_public_b64: str = "", prologue: bytes = b""):
        if not private_hex:
            raise ValueError("Noise static private key yok")
        self.conn = NoiseConnection.from_name(PROTOCOL.encode("ascii"))
        self.conn.set_prologue(prologue)
        self.conn.set_keypair_from_private_bytes(Keypair.STATIC, bytes.fromhex(private_hex))
        self.peer_public = peer_public_b64.strip()

    def _check_peer(self, remote=None) -> None:
        if not self.peer_public:
            return
        if remote is None:
            try:
                remote = self.conn.noise_protocol.handshake_state.rs
            except Exception:
                remote = None
        if remote is None:
            raise ConnectionError("Noise remote static key yok")
        raw = remote.public_bytes
        got = base64.b64encode(raw).decode("ascii")
        if got != self.peer_public:
            raise ConnectionError("Noise host kimliği davetle eşleşmiyor")

    def handshake_initiator(self, sock: socket.socket, final_payload: bytes = b"") -> None:
        self.conn.set_as_initiator()
        self.conn.start_handshake()
        send_frame(sock, bytes(self.conn.write_message()))
        msg = recv_frame(sock)
        self.conn.read_message(msg)
        # Initiator, son mesajı göndermeden önce responder static anahtarını görür.
        remote = self.conn.noise_protocol.handshake_state.rs
        self._check_peer(remote)
        send_frame(sock, bytes(self.conn.write_message(final_payload)))

    def handshake_responder(self, sock: socket.socket) -> bytes:
        self.conn.set_as_responder()
        self.conn.start_handshake()
        msg = recv_frame(sock)
        self.conn.read_message(msg)
        send_frame(sock, bytes(self.conn.write_message()))
        msg = recv_frame(sock)
        payload = bytes(self.conn.read_message(msg))
        return payload

    def send(self, sock: socket.socket, data: bytes) -> None:
        send_frame(sock, self.conn.encrypt(data))

    def recv(self, sock: socket.socket) -> bytes:
        return self.conn.decrypt(recv_frame(sock))


def prologue_for(session_id: str) -> bytes:
    return b"CL1|" + str(session_id or "").encode("ascii", "ignore")
