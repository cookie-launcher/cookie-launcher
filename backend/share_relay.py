#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Cookie Launcher — relay'i bu bilgisayarda çalıştırıp ücretsiz bore.pub tüneliyle aç.

VPS/hesap/ödeme yok. Host launcher'ı açıkken relay çalışır; arkadaşlar
bore.pub üzerinden bağlanır. bore.pub protokolü saf Python ile uygulanır;
harici `bore.exe` indirilmez/çalıştırılmaz.

Kullanım:
    python3 backend/share_relay.py
    python3 backend/share_relay.py --bore /path/to/bore

Çıktıdaki "Arkadaşların için" adresini arkadaşlarına ver.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import platform
import re
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import urllib.request
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
try:
    from social_relay import Store, Relay
except Exception:  # script dogrudan calisirken backend dizini sys.path'te olur
    sys.path.insert(0, os.path.join(ROOT, "backend"))
    from social_relay import Store, Relay
DEFAULT_DATA = os.path.join(os.path.expanduser("~"), ".cookie_launcher", "social_relay_host.json")
LINE_RE = re.compile(r"listening at\s+([^\s:]+):(\d+)")


def bore_bin_dir() -> str:
    """bore binary'sinin platforma uygun kurulum klasörü."""
    if os.name == "nt":
        base = os.environ.get("LOCALAPPDATA") or os.path.join(os.path.expanduser("~"), "AppData", "Local")
        return os.path.join(base, "CookieLauncher", "bin")
    if sys.platform == "darwin":
        return os.path.join(os.path.expanduser("~"), "Library", "Application Support", "CookieLauncher", "bin")
    return os.path.join(os.path.expanduser("~"), ".cookie_launcher", "bin")


def free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


BORE_VERSION = "0.6.0"
BORE_RELEASE = f"https://github.com/ekzhang/bore/releases/download/v{BORE_VERSION}"
BORE_SHA256 = {
    "bore-v0.6.0-x86_64-unknown-linux-musl.tar.gz": "e484d1e3acba77169b773f31a5bfb34192d4b660f44a094a658a2522cd2270f7",
}


def _bore_asset():
    system = platform.system().lower()
    machine = platform.machine().lower()
    if system == "linux":
        if machine in ("x86_64", "amd64"):
            return "bore-v0.6.0-x86_64-unknown-linux-musl.tar.gz"
        if machine in ("aarch64", "arm64"):
            return "bore-v0.6.0-aarch64-unknown-linux-musl.tar.gz"
        if machine.startswith("armv7"):
            return "bore-v0.6.0-armv7-unknown-linux-musleabihf.tar.gz"
    elif system == "darwin":
        if machine in ("x86_64", "amd64"):
            return "bore-v0.6.0-x86_64-apple-darwin.tar.gz"
        if machine in ("aarch64", "arm64"):
            return "bore-v0.6.0-aarch64-apple-darwin.tar.gz"
    elif system == "windows":
        if machine in ("x86_64", "amd64"):
            return "bore-v0.6.0-x86_64-pc-windows-msvc.zip"
        if machine in ("x86", "i686"):
            return "bore-v0.6.0-i686-pc-windows-msvc.zip"
    return ""


def _download_bore(target_dir: str) -> str:
    asset = _bore_asset()
    if not asset:
        raise SystemExit(
            "Bu platform için otomatik bore indirmesi yok.\n"
            "https://github.com/ekzhang/bore/releases adresinden indirip --bore ile ver."
        )
    os.makedirs(target_dir, exist_ok=True)
    print(f"bore indiriliyor ({asset})...", file=sys.stderr, flush=True)
    url = f"{BORE_RELEASE}/{asset}"
    with tempfile.TemporaryDirectory(prefix="cookie-bore-") as tmp:
        archive = os.path.join(tmp, asset)
        with urllib.request.urlopen(url, timeout=90) as response, open(archive, "wb") as out:
            shutil.copyfileobj(response, out)
        expected = BORE_SHA256.get(asset)
        if expected:
            digest = hashlib.sha256()
            with open(archive, "rb") as f:
                for chunk in iter(lambda: f.read(1024 * 1024), b""):
                    digest.update(chunk)
            if digest.hexdigest() != expected:
                raise SystemExit("bore indirilen dosyanın SHA256'sı eşleşmedi.")
        if asset.endswith(".zip"):
            with zipfile.ZipFile(archive) as zf:
                zf.extractall(tmp)
        else:
            with tarfile.open(archive, "r:gz") as tf:
                try:
                    tf.extractall(tmp, filter="data")
                except TypeError:
                    tf.extractall(tmp)
        binary_name = "bore.exe" if os.name == "nt" else "bore"
        found = ""
        for root, _dirs, files in os.walk(tmp):
            if binary_name in files:
                found = os.path.join(root, binary_name)
                break
        if not found:
            raise SystemExit("bore arşivi içinde çalıştırılabilir dosya bulunamadı.")
        dest = os.path.join(target_dir, binary_name)
        shutil.copy2(found, dest)
        try:
            os.chmod(dest, 0o755)
        except Exception:
            pass
    print(f"bore hazır: {dest}", file=sys.stderr, flush=True)
    return dest


def find_bore(explicit: str) -> str:
    if explicit:
        if os.path.isfile(explicit) and os.access(explicit, os.X_OK):
            return explicit
        raise SystemExit(f"bore bulunamadı: {explicit}")
    env_bin = os.environ.get("SOCIAL_BORE_BIN", "").strip()
    if env_bin:
        if os.path.isfile(env_bin) and os.access(env_bin, os.X_OK):
            return env_bin
        raise SystemExit(f"SOCIAL_BORE_BIN geçersiz: {env_bin}")
    found = shutil.which("bore")
    if found:
        return found
    bin_dir = bore_bin_dir()
    local = os.path.join(bin_dir, "bore.exe" if os.name == "nt" else "bore")
    if os.path.isfile(local) and os.access(local, os.X_OK):
        return local
    return _download_bore(bin_dir)


class Bore:
    def __init__(self, binary: str, local_port: int, server: str):
        self.binary = binary
        self.local_port = local_port
        self.server = server
        self.proc = subprocess.Popen(
            [binary, "local", str(local_port), "--to", server],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )
        self.public_host = ""
        self.public_port = 0
        self._read_ready()

    def _read_ready(self) -> None:
        assert self.proc.stdout is not None
        deadline = time.time() + 25
        while time.time() < deadline:
            line = self.proc.stdout.readline()
            if not line:
                break
            print(f"[bore] {line.rstrip()}", file=sys.stderr, flush=True)
            m = LINE_RE.search(line)
            if m:
                self.public_host = m.group(1)
                self.public_port = int(m.group(2))
                return
        self.stop()
        raise SystemExit("bore tüneli kurulamadı (bore.pub erişilemiyor olabilir).")

    def stop(self) -> None:
        try:
            self.proc.terminate()
            self.proc.wait(timeout=3)
        except Exception:
            try:
                self.proc.kill()
            except Exception:
                pass



class PythonBoreTunnel:
    """bore.pub istemcisini saf Python ile uygular.

    Windows'ta ayrı bir `bore.exe` indirmeye/çalıştırmaya gerek kalmaz;
    Defender'ın imzasız binary'yi engellemesi de ortadan kalkar.

    Protokol (bore v0.6):
      kontrol: {"Hello":0}\0  ->  {"Hello":public_port}\0
      istek:   {"Connection":"uuid"}\0
      veri:    {"Accept":"uuid"}\0 + ham TCP
    """

    CONTROL_PORT = 7835

    def __init__(self, server: str, local_port: int, timeout: float = 15.0):
        self.server = str(server or "bore.pub")
        self.local_port = int(local_port)
        self.public_host = self.server
        self.public_port = 0
        self.error = ""
        self._stop = threading.Event()
        self._sock = None
        self._data_sockets = set()
        self._lock = threading.Lock()
        self._reader = None
        self._connect(timeout)

    def _connect(self, timeout):
        self._sock = socket.create_connection((self.server, self.CONTROL_PORT), timeout=timeout)
        self._sock.settimeout(timeout)
        self._send({"Hello": 0})
        msg = self._recv()
        if not msg or "Hello" not in msg:
            raise RuntimeError("bore.pub hello yanıtı gelmedi")
        self.public_port = int(msg["Hello"])
        if not self.public_port:
            raise RuntimeError("bore.pub public port vermedi")
        self._sock.settimeout(None)
        self._reader = threading.Thread(target=self._read_loop, daemon=True, name="python-bore")
        self._reader.start()

    def _send(self, obj):
        data = (json.dumps(obj, separators=(",", ":")) + "\0").encode("utf-8")
        self._sock.sendall(data)

    def _recv(self, sock=None, timeout=None):
        sock = sock or self._sock
        if timeout is not None:
            sock.settimeout(timeout)
        buf = b""
        while b"\0" not in buf:
            chunk = sock.recv(1)
            if not chunk:
                return None
            buf += chunk
        try:
            return json.loads(buf.split(b"\0", 1)[0].decode("utf-8"))
        except Exception:
            return None

    def _read_loop(self):
        try:
            while not self._stop.is_set():
                msg = self._recv(self._sock)
                if not msg:
                    break
                if "Heartbeat" in msg:
                    continue
                if "Connection" in msg:
                    conn_id = str(msg["Connection"])
                    threading.Thread(target=self._handle, args=(conn_id,), daemon=True).start()
                elif "Error" in msg:
                    self.error = str(msg["Error"])
                    break
        except Exception as exc:
            self.error = f"{type(exc).__name__}: {exc}"
        finally:
            self._stop.set()

    def _handle(self, conn_id):
        data_sock = None
        local = None
        try:
            data_sock = socket.create_connection((self.server, self.CONTROL_PORT), timeout=12)
            data_sock.settimeout(12)
            payload = (json.dumps({"Accept": conn_id}, separators=(",", ":")) + "\0").encode("utf-8")
            data_sock.sendall(payload)
            local = socket.create_connection(("127.0.0.1", self.local_port), timeout=8)
            with self._lock:
                self._data_sockets.add(data_sock)
            self._pipe(data_sock, local)
        except Exception:
            pass
        finally:
            for sock_obj in (data_sock, local):
                try:
                    if sock_obj:
                        sock_obj.close()
                except Exception:
                    pass
            with self._lock:
                self._data_sockets.discard(data_sock)

    @staticmethod
    def _pipe(a, b):
        import select
        try:
            while True:
                readable, _, _ = select.select([a, b], [], [], 1.0)
                if not readable:
                    continue
                for src in readable:
                    dst = b if src is a else a
                    data = src.recv(65536)
                    if not data:
                        return
                    dst.sendall(data)
        except Exception:
            return

    def stop(self):
        self._stop.set()
        try:
            if self._sock:
                self._sock.close()
        except Exception:
            pass
        with self._lock:
            socks = list(self._data_sockets)
        for sock_obj in socks:
            try:
                sock_obj.close()
            except Exception:
                pass


class HostRelayRuntime:
    """Relay + bore'u aynı Python sürecinde çalıştırır.

    PyInstaller ile paketlenmiş Windows sürümünde ayrı bir Python yorumlayıcısı
    olmadığı için relay thread içinde başlatılır; tünel de saf Python
    `PythonBoreTunnel` ile kurulur.
    """

    def __init__(self, data_path: str, bore_bin: str = "", bore_server: str = "bore.pub",
                 control_port: int = 0, tunnel_port: int = 0, rendezvous_url: str = "",
                 noise_public: str = ""):
        self.data_path = data_path
        self.bore_bin = bore_bin
        self.bore_server = bore_server
        self.rendezvous_url = str(rendezvous_url or "").strip()
        self.noise_public = str(noise_public or "").strip()
        self.publisher = None
        self.local_control = int(control_port or 0)
        self.local_tunnel = int(tunnel_port or 0)
        self.bore_ctl = None
        self.bore_tun = None
        self.share = None
        self.error = ""
        self._loop = None
        self._thread = None
        self._ready = threading.Event()
        self._stop = threading.Event()
        self._control = None
        self._tunnel = None
        self.room = self._load_room()

    def _load_room(self):
        path = self.data_path + ".room.json"
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            if data.get("room_id") and data.get("host_key"):
                return data
        except Exception:
            pass
        try:
            from invite_code import new_room_id
            room_id = new_room_id()
        except Exception:
            room_id = secrets.token_hex(8).upper()
        room = {"room_id": room_id, "host_key": secrets.token_hex(32)}
        try:
            os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
            tmp = path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(room, f, ensure_ascii=False)
            os.replace(tmp, path)
            try:
                os.chmod(path, 0o600)
            except Exception:
                pass
        except Exception:
            pass
        return room

    @property
    def running(self) -> bool:
        return bool(self._thread and self._thread.is_alive() and not self._stop.is_set())

    def start(self, timeout: float = 35.0):
        if self.running and self.share:
            return dict(self.share)
        try:
            self.local_control = self.local_control or free_port()
            self.local_tunnel = self.local_tunnel or free_port()
            print("Ücretsiz bore tünelleri açılıyor (Python istemcisi)...", file=sys.stderr, flush=True)
            self.bore_ctl = PythonBoreTunnel(self.bore_server, self.local_control)
            try:
                self.bore_tun = PythonBoreTunnel(self.bore_server, self.local_tunnel)
            except Exception:
                self.bore_ctl.stop()
                self.bore_ctl = None
                raise
            self.share = {
                "host": self.bore_ctl.public_host,
                "control_port": self.bore_ctl.public_port,
                "tunnel_port": self.bore_tun.public_port,
                "local_control_port": self.local_control,
                "local_tunnel_port": self.local_tunnel,
                "room_id": self.room.get("room_id", ""),
                "noise_public": self.noise_public,
            }
            self._thread = threading.Thread(target=self._run_relay, daemon=True, name="host-relay")
            self._thread.start()
            if not self._ready.wait(timeout):
                raise RuntimeError("Relay zaman aşımına uğradı.")
            if self.error:
                raise RuntimeError(self.error)
            if self.rendezvous_url:
                try:
                    from rendezvous import RendezvousPublisher
                    self.publisher = RendezvousPublisher(
                        self.rendezvous_url,
                        self.room.get("room_id", ""),
                        self.room.get("host_key", ""),
                        self.share["control_port"],
                        self.share["tunnel_port"],
                        relay_host=self.share["host"],
                        noise_public=self.noise_public,
                    )
                    self.share["rendezvous_published"] = bool(self.publisher.start(wait=4))
                    self.share["rendezvous_url"] = self.rendezvous_url
                except Exception as exc:
                    print(f"Rendezvous yayını başlatılamadı: {exc}", file=sys.stderr, flush=True)
                    self.share["rendezvous_published"] = False
                    self.share["rendezvous_url"] = self.rendezvous_url
            print(
                f"Relay hazır (control :{self.local_control}, tunnel :{self.local_tunnel}, "
                f"public tunnel :{self.share['tunnel_port']}).",
                file=sys.stderr,
                flush=True,
            )
            return dict(self.share)
        except BaseException as exc:
            self.stop()
            raise RuntimeError(str(exc))

    def _run_relay(self) -> None:
        self._loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self._loop)
        try:
            self._loop.run_until_complete(self._relay_main())
        except Exception as exc:
            self.error = f"{type(exc).__name__}: {exc}"
        finally:
            self._ready.set()

    async def _relay_main(self) -> None:
        relay = Relay(
            Store(self.data_path),
            control_port=self.local_control,
            tunnel_port=self.local_tunnel,
            advertise_tunnel_port=int(self.share["tunnel_port"]),
        )
        self._control = await asyncio.start_server(relay.handle_control, "127.0.0.1", self.local_control)
        self._tunnel = await asyncio.start_server(relay.handle_tunnel, "127.0.0.1", self.local_tunnel)
        self._ready.set()
        await asyncio.gather(
            self._control.serve_forever(),
            self._tunnel.serve_forever(),
            relay.cleanup_loop(),
        )

    def stop(self) -> None:
        self._stop.set()
        if self.publisher:
            try:
                self.publisher.stop()
            except Exception:
                pass
            self.publisher = None
        try:
            if self._loop and self._loop.is_running():
                self._loop.call_soon_threadsafe(self._close_servers)
        except Exception:
            pass
        for bore in (self.bore_ctl, self.bore_tun):
            if bore:
                try:
                    bore.stop()
                except Exception:
                    pass
        if self._thread:
            self._thread.join(timeout=3)
        self._thread = None
        self._ready.clear()
        self.share = None

    def _close_servers(self) -> None:
        try:
            if self._control:
                self._control.close()
            if self._tunnel:
                self._tunnel.close()
        except Exception:
            pass
        try:
            if self._loop:
                self._loop.stop()
        except Exception:
            pass


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Cookie Launcher relay + free bore tunnel")
    parser.add_argument("--bore", default="", help="bore binary path (default: PATH)")
    parser.add_argument("--bore-server", default="bore.pub")
    parser.add_argument("--data", default=DEFAULT_DATA)
    parser.add_argument("--control-port", type=int, default=0, help="local control port (0 = random)")
    parser.add_argument("--tunnel-port", type=int, default=0, help="local tunnel port (0 = random)")
    try:
        from config import DEFAULT_RENDEZVOUS_URL as _default_rendezvous
    except Exception:
        _default_rendezvous = ""
    parser.add_argument("--rendezvous", default=os.environ.get("COOKIE_LAUNCHER_RENDEZVOUS_URL", _default_rendezvous),
                        help="CL1 kısa kod Worker URL'si")
    args = parser.parse_args(argv)

    runtime = HostRelayRuntime(
        data_path=args.data,
        bore_bin=args.bore,
        bore_server=args.bore_server,
        control_port=args.control_port,
        tunnel_port=args.tunnel_port,
        rendezvous_url=args.rendezvous,
    )
    stop = threading.Event()

    def _on_signal(signum, frame):
        stop.set()

    signal.signal(signal.SIGINT, _on_signal)
    signal.signal(signal.SIGTERM, _on_signal)
    try:
        share = runtime.start(timeout=40)
        print("RELAY_SHARE " + json.dumps(share), flush=True)
        print("", flush=True)
        print("=" * 64, flush=True)
        print("ARKADAŞLARIN İÇİN (launcher → Arkadaşlar → Bağlantı):", flush=True)
        print(f"  Relay adresi : {share['host']}", flush=True)
        print(f"  Relay portu  : {share['control_port']}", flush=True)
        print(f"  TLS          : kapalı", flush=True)
        print("", flush=True)
        print("SENİN İÇİN (aynı bilgisayardaki launcher):", flush=True)
        print(f"  Relay adresi : 127.0.0.1", flush=True)
        print(f"  Relay portu  : {share['local_control_port']}", flush=True)
        print("", flush=True)
        print("Not: Host launcher kapalıyken relay de kapanır. Oyun oynarken açık tut.", flush=True)
        print("Güvenlik: bore.pub trafiği şifrelemez; arkadaş kodun challenge-response", flush=True)
        print("ile korunur, oyun trafiği Minecraft LAN gibi şifresizdir.", flush=True)
        print("=" * 64, flush=True)
        while not stop.wait(1):
            if not runtime.running:
                print("Relay kapandı.", file=sys.stderr)
                break
    except KeyboardInterrupt:
        pass
    except Exception as exc:
        print(f"Relay başlatılamadı: {exc}", file=sys.stderr)
        return 1
    finally:
        runtime.stop()
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
