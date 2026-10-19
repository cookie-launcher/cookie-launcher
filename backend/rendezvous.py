#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""CL1 kısa kodları için hafif rendezvous istemcisi.

Worker compute açısından stateless'tir; yalnızca room_id -> {control,tunnel}
eşlemesi KV'de TTL'li tutulur. Host bu modülle periyodik heartbeat atar,
kapanırken DELETE gönderir.
"""

from __future__ import annotations

import json
import threading
import time
import urllib.request
from typing import Any, Dict, Optional


def _url(base: str, room_id: str) -> str:
    return f"{str(base).rstrip('/')}/v1/rooms/{room_id}"


def _request(method: str, url: str, body: Optional[Dict[str, Any]] = None,
             bearer: str = "", timeout: float = 5.0) -> Dict[str, Any]:
    data = None
    headers = {
        "accept": "application/json",
        "user-agent": "CookieLauncher/3.1 (+https://cookie-launcher.github.io)",
    }
    if body is not None:
        data = json.dumps(body, separators=(",", ":")).encode("utf-8")
        headers["content-type"] = "application/json"
    if bearer:
        headers["authorization"] = f"Bearer {bearer}"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as response:
        raw = response.read(65536)
    try:
        return json.loads(raw.decode("utf-8")) if raw else {}
    except Exception:
        return {}


def resolve(base: str, room_id: str, timeout: float = 5.0) -> Optional[Dict[str, Any]]:
    if not base or not room_id:
        return None
    try:
        data = _request("GET", _url(base, room_id), timeout=timeout)
        control = int(data.get("c") or 0)
        tunnel = int(data.get("t") or 0)
        if 1 <= control <= 65535 and 1 <= tunnel <= 65535:
            return {
                "h": str(data.get("h") or ""),
                "c": control,
                "t": tunnel,
                "npub": str(data.get("npub") or data.get("n") or ""),
            }
    except Exception:
        return None
    return None


class RendezvousPublisher:
    def __init__(self, base_url: str, room_id: str, host_key: str,
                 control_port: int, tunnel_port: int,
                 relay_host: str = "bore.pub", noise_public: str = "",
                 interval: float = 240.0, ttl: int = 600):
        self.base_url = str(base_url or "").rstrip("/")
        self.relay_host = str(relay_host or "bore.pub")
        self.noise_public = str(noise_public or "")
        self.room_id = str(room_id or "")
        self.host_key = str(host_key or "")
        self.control_port = int(control_port)
        self.tunnel_port = int(tunnel_port)
        self.interval = max(60.0, float(interval))
        self.ttl = int(ttl)
        self.published = False
        self.last_error = ""
        self._stop = threading.Event()
        self._ready = threading.Event()
        self._thread: Optional[threading.Thread] = None

    def start(self, wait: float = 4.0) -> bool:
        if not (self.base_url and self.room_id and self.host_key):
            return False
        self._thread = threading.Thread(target=self._loop, name="cl1-rendezvous", daemon=True)
        self._thread.start()
        self._ready.wait(wait)
        return self.published

    def _loop(self) -> None:
        try:
            self._publish_once()
            self._ready.set()
            while not self._stop.wait(self.interval):
                self._publish_once()
        finally:
            self._ready.set()
            if self.published:
                self._delete()

    def _publish_once(self) -> bool:
        try:
            _request(
                "PUT",
                _url(self.base_url, self.room_id),
                body={
                    "v": 1,
                    "h": self.relay_host,
                    "c": self.control_port,
                    "t": self.tunnel_port,
                    "npub": self.noise_public,
                    "exp": int(time.time()) + self.ttl,
                },
                bearer=self.host_key,
                timeout=6,
            )
            self.published = True
            self.last_error = ""
            return True
        except Exception as exc:
            self.published = False
            self.last_error = f"{type(exc).__name__}: {exc}"
            return False

    def _delete(self) -> None:
        try:
            _request("DELETE", _url(self.base_url, self.room_id), bearer=self.host_key, timeout=4)
        except Exception:
            pass

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=6)
        self._thread = None
        self.published = False
