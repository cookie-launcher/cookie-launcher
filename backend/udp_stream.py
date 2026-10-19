#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""UDP üzerinde minimal güvenilir, sıralı byte stream.

KCP/QUIC kadar gelişmiş değil; CL1 P2P MVP'si için:
- 32-bit sequence, kümülatif ACK, 64 paket pencere
- 250 ms RTO, yeniden gönderim
- out-of-order buffer
- length/session filtreli frame'ler

NoiseSession bu nesneyi socket gibi kullanır: sendall(), recv(), close().
"""

from __future__ import annotations

import hashlib
import os
import socket
import struct
import threading
import time
from collections import OrderedDict
from typing import Dict, Optional, Tuple

MAGIC = b"CLU1"
HEADER = struct.Struct("!4s8sBII")  # magic, session, type, seq, ack
TYPE_HELLO = 1
TYPE_HELLO_ACK = 2
TYPE_DATA = 3
TYPE_ACK = 4
TYPE_FIN = 5
PACKET = 1100
WINDOW = 64
RTO = 0.30
MAX_RETRIES = 20


def _session_key(session_id: str) -> bytes:
    return hashlib.sha256(str(session_id or "").encode("utf-8")).digest()[:8]


class UDPStream:
    def __init__(self, sock: socket.socket, peer: Tuple[str, int], session_id: str,
                 timeout: float = 3.0):
        self.sock = sock
        self.peer = (str(peer[0]), int(peer[1]))
        self.session = _session_key(session_id)
        self.timeout = timeout
        self._closed = threading.Event()
        self._ready = threading.Event()
        self._cond = threading.Condition()
        self._send_lock = threading.Lock()
        self._recv_buf = bytearray()
        self._ooo: Dict[int, bytes] = {}
        self._unacked: "OrderedDict[int, Tuple[float, bytes, int]]" = OrderedDict()
        self._send_seq = int.from_bytes(os.urandom(4), "big") % 0x7FFFFFFF
        self._start_seq = self._send_seq
        self._peer_next: Optional[int] = None
        self._peer_hello = False
        self._last_ack = 0
        self._rx_expected = 0
        self._closed_remote = False
        self._threads = []
        self._last_rx = time.time()
        self._default_timeout: Optional[float] = None

    def _packet(self, kind: int, seq: int, ack: int, payload: bytes = b"") -> bytes:
        return HEADER.pack(MAGIC, self.session, kind, seq & 0xFFFFFFFF, ack & 0xFFFFFFFF) + payload

    def _send_raw(self, data: bytes) -> None:
        try:
            self.sock.sendto(data, self.peer)
        except Exception:
            pass

    def start(self) -> bool:
        """Her iki taraf HELLO değiş tokuşu yapar."""
        deadline = time.time() + self.timeout
        self.sock.settimeout(0.15)
        hello_seq = self._send_seq
        while time.time() < deadline and not self._ready.is_set():
            self._send_raw(self._packet(TYPE_HELLO, hello_seq, 0))
            try:
                data, _ = self.sock.recvfrom(2048)
            except socket.timeout:
                continue
            except Exception:
                break
            if not self._handle_hello(data):
                continue
            if self._ready.is_set():
                break
        if not self._ready.is_set():
            return False
        # HELLO seq ilk data seq'i olarak kullanıldı; veri bir sonraki seq'ten başlar.
        self._send_seq = (self._send_seq + 1) & 0xFFFFFFFF
        try:
            self.sock.settimeout(None)
        except Exception:
            pass
        t_rx = threading.Thread(target=self._rx_loop, daemon=True)
        t_retx = threading.Thread(target=self._retx_loop, daemon=True)
        t_rx.start()
        t_retx.start()
        self._threads = [t_rx, t_retx]
        return True

    def _handle_hello(self, data: bytes) -> bool:
        if len(data) < HEADER.size:
            return False
        magic, session, kind, seq, ack = HEADER.unpack(data[:HEADER.size])
        if magic != MAGIC or session != self.session:
            return False
        if kind == TYPE_HELLO:
            if not self._peer_hello:
                self._peer_hello = True
                self._peer_next = (seq + 1) & 0xFFFFFFFF
                self._rx_expected = self._peer_next
            self._send_raw(self._packet(TYPE_HELLO_ACK, self._send_seq, seq))
            self._ready.set()
            return True
        if kind == TYPE_HELLO_ACK:
            if seq == self._send_seq:
                self._peer_hello = True
                self._ready.set()
            return True
        return False

    def _rx_loop(self) -> None:
        while not self._closed.is_set():
            try:
                data, _ = self.sock.recvfrom(4096)
            except Exception:
                break
            if len(data) < HEADER.size:
                continue
            magic, session, kind, seq, ack = HEADER.unpack(data[:HEADER.size])
            if magic != MAGIC or session != self.session:
                continue
            self._last_rx = time.time()
            if kind == TYPE_DATA:
                payload = data[HEADER.size:]
                self._on_data(seq & 0xFFFFFFFF, payload)
                self._send_ack()
            elif kind == TYPE_ACK:
                self._on_ack(ack & 0xFFFFFFFF)
            elif kind == TYPE_FIN:
                with self._cond:
                    self._closed_remote = True
                    self._cond.notify_all()
                break
            elif kind in (TYPE_HELLO, TYPE_HELLO_ACK):
                self._handle_hello(data)

    def _on_data(self, seq: int, payload: bytes) -> None:
        with self._cond:
            if self._peer_next is None:
                return
            if seq == self._rx_expected:
                self._recv_buf.extend(payload)
                self._rx_expected = (seq + 1) & 0xFFFFFFFF
                while self._rx_expected in self._ooo:
                    self._recv_buf.extend(self._ooo.pop(self._rx_expected))
                    self._rx_expected = (self._rx_expected + 1) & 0xFFFFFFFF
                self._last_ack = (self._rx_expected - 1) & 0xFFFFFFFF
                self._cond.notify_all()
            elif ((seq - self._rx_expected) & 0xFFFFFFFF) < (WINDOW * 2):
                self._ooo[seq] = payload
            self._last_ack = (self._rx_expected - 1) & 0xFFFFFFFF

    def _send_ack(self) -> None:
        self._send_raw(self._packet(TYPE_ACK, 0, self._last_ack))

    def _on_ack(self, ack: int) -> None:
        with self._cond:
            remove = []
            for seq in list(self._unacked.keys()):
                if seq <= ack or (ack < 0x80000000 and seq > 0x80000000):
                    remove.append(seq)
                else:
                    break
            for seq in remove:
                self._unacked.pop(seq, None)
            self._cond.notify_all()

    def _retx_loop(self) -> None:
        while not self._closed.is_set():
            time.sleep(0.08)
            now = time.time()
            with self._cond:
                for seq, (sent, pkt, tries) in list(self._unacked.items()):
                    if now - sent >= RTO:
                        if tries >= MAX_RETRIES:
                            self._closed.set()
                            self._cond.notify_all()
                            break
                        self._send_raw(pkt)
                        self._unacked[seq] = (now, pkt, tries + 1)

    def sendall(self, data: bytes) -> None:
        view = memoryview(data)
        offset = 0
        while offset < len(view):
            chunk = bytes(view[offset:offset + PACKET])
            offset += len(chunk)
            with self._cond:
                while len(self._unacked) >= WINDOW and not self._closed.is_set():
                    self._cond.wait(0.2)
                if self._closed.is_set():
                    return
                seq = self._send_seq
                self._send_seq = (self._send_seq + 1) & 0xFFFFFFFF
                pkt = self._packet(TYPE_DATA, seq, self._last_ack, chunk)
                self._unacked[seq] = (time.time(), pkt, 0)
                self._send_raw(pkt)

    def recv(self, n: int = 65536, timeout: Optional[float] = None) -> bytes:
        if timeout is None:
            timeout = self._default_timeout
        deadline = None if timeout is None else time.time() + timeout
        with self._cond:
            while not self._recv_buf and not self._closed_remote and not self._closed.is_set():
                if deadline is None:
                    self._cond.wait(0.2)
                    continue
                remaining = deadline - time.time()
                if remaining <= 0:
                    return b""
                self._cond.wait(min(0.2, remaining))
            if not self._recv_buf:
                return b""
            data = bytes(self._recv_buf[:n])
            del self._recv_buf[:n]
            return data

    def settimeout(self, value) -> None:
        self._default_timeout = None if value is None else max(0.05, float(value))

    def shutdown(self, how=None) -> None:
        self.close()

    def close(self) -> None:
        if self._closed.is_set():
            return
        self._closed.set()
        try:
            self._send_raw(self._packet(TYPE_FIN, 0, self._last_ack))
        except Exception:
            pass
        with self._cond:
            self._cond.notify_all()
        try:
            self.sock.close()
        except Exception:
            pass

    def fileno(self):
        return self.sock.fileno()
