#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Host relay süreç yöneticisi.

Relay + ücretsiz bore tüneli `share_relay.HostRelayRuntime` içinde çalışır.
Böylece PyInstaller ile paketlenmiş Windows sürümünde ayrı bir Python
yorumlayıcısına ihtiyaç kalmaz; yalnızca bore binary'si alt süreç olur.
"""

from __future__ import annotations

import os
import threading
from typing import Any, Dict, Optional

try:
    from share_relay import HostRelayRuntime
except Exception:  # pragma: no cover
    HostRelayRuntime = None


class HostRelay:
    def __init__(self, data_path: str, bore_bin: Optional[str] = None, rendezvous_url: Optional[str] = None,
                 noise_public: Optional[str] = None):
        self.data_path = data_path
        self.bore_bin = (bore_bin or "").strip()
        self.rendezvous_url = (rendezvous_url or "").strip()
        self.noise_public = (noise_public or "").strip()
        self.runtime = None
        self.error = ""
        self._starting = False
        self.lock = threading.RLock()

    def status(self) -> Dict[str, Any]:
        with self.lock:
            running = bool(self.runtime and self.runtime.running)
            share = None
            error = self.error
            if self._starting:
                return {"running": True, "share": None, "error": "", "log": ""}
            if self.runtime:
                if running and self.runtime.share:
                    share = dict(self.runtime.share)
                    if self.runtime.publisher is not None:
                        share["rendezvous_published"] = bool(self.runtime.publisher.published)
                        share["rendezvous_error"] = self.runtime.publisher.last_error
                elif not running and self.runtime.share:
                    # Relay kendiliğinden kapandıysa eski adresi gösterme.
                    error = self.runtime.error or "Relay beklenmedik şekilde kapandı."
                    self.error = error
                    self.runtime.share = None
            return {"running": running, "share": share, "error": error, "log": ""}

    def start(self, timeout: float = 100.0) -> Dict[str, Any]:
        with self.lock:
            if self.runtime and self.runtime.running and self.runtime.share:
                return dict(self.runtime.share)
            if HostRelayRuntime is None:
                raise RuntimeError("Host relay modülü yüklenemedi.")
            if self.runtime:
                try:
                    self.runtime.stop()
                except Exception:
                    pass
            self.error = ""
            self._starting = True
            runtime = HostRelayRuntime(
                self.data_path,
                self.bore_bin,
                rendezvous_url=self.rendezvous_url,
                noise_public=self.noise_public,
            )
            self.runtime = runtime
        try:
            share = runtime.start(timeout=timeout)
        except Exception as exc:
            with self.lock:
                self._starting = False
                self.error = str(exc)
            try:
                runtime.stop()
            except Exception:
                pass
            raise RuntimeError(str(exc))
        with self.lock:
            self._starting = False
            self.error = ""
        return dict(share)

    def stop(self) -> None:
        with self.lock:
            runtime = self.runtime
            self.runtime = None
            self._starting = False
            self.error = ""
        if runtime:
            try:
                runtime.stop()
            except Exception:
                pass
