#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Arkadaşlar relay'i + istemcisi uçtan uca testleri.

Çalıştırma:
    python3 -m unittest discover -s backend/tests -v
"""

import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, "backend"))

from social_client import SocialClient, SocialError  # noqa: E402


def free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def wait_for(predicate, timeout=10.0, interval=0.05):
    end = time.time() + timeout
    while time.time() < end:
        try:
            if predicate():
                return True
        except Exception:
            pass
        time.sleep(interval)
    return False


class EchoServer:
    """Minecraft LAN dünyası yerine geçen basit TCP echo sunucusu."""

    def __init__(self):
        self.sock = socket.socket()
        self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen(16)
        self.port = self.sock.getsockname()[1]
        self.thread = threading.Thread(target=self._accept_loop, daemon=True)
        self.thread.start()

    def _accept_loop(self):
        while True:
            try:
                client, _ = self.sock.accept()
            except Exception:
                return
            threading.Thread(target=self._handle, args=(client,), daemon=True).start()

    def _handle(self, client):
        try:
            while True:
                data = client.recv(65536)
                if not data:
                    break
                client.sendall(b"ECHO:" + data)
        except Exception:
            pass
        finally:
            try:
                client.close()
            except Exception:
                pass

    def close(self):
        try:
            self.sock.close()
        except Exception:
            pass


class RelayProcess:
    def __init__(self, data_path, advertise_tunnel_port=0):
        self.control_port = free_port()
        self.tunnel_port = free_port()
        env = dict(os.environ)
        env["PYTHONUNBUFFERED"] = "1"
        self.proc = subprocess.Popen(
            [
                sys.executable,
                os.path.join(ROOT, "backend", "social_relay.py"),
                "--host", "127.0.0.1",
                "--control-port", str(self.control_port),
                "--tunnel-port", str(self.tunnel_port),
                "--advertise-tunnel-port", str(advertise_tunnel_port),
                "--data", data_path,
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=env,
        )
        line = self.proc.stdout.readline().strip()
        if not line.startswith("RELAY_READY"):
            err = self.proc.stderr.read() if self.proc.stderr else ""
            raise RuntimeError(f"Relay başlamadı: {line} {err}")
        payload = json.loads(line.split(" ", 1)[1])
        self.control_port = int(payload["control_port"])
        self.tunnel_port = int(payload["tunnel_port"])

    def stop(self):
        try:
            self.proc.terminate()
            self.proc.wait(timeout=3)
        except Exception:
            try:
                self.proc.kill()
            except Exception:
                pass
        for stream in (self.proc.stdout, self.proc.stderr):
            try:
                if stream:
                    stream.close()
            except Exception:
                pass


class SocialIntegrationTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.relay = RelayProcess(os.path.join(self.tmp.name, "relay.json"))
        self.clients = []
        self.echo = None

    def tearDown(self):
        for c in self.clients:
            try:
                c.stop()
            except Exception:
                pass
        if self.echo:
            self.echo.close()
        self.relay.stop()
        self.tmp.cleanup()

    def make_client(self, name, sub):
        c = SocialClient(
            os.path.join(self.tmp.name, sub),
            relay_host="127.0.0.1",
            relay_port=self.relay.control_port,
            enable_lan=False,
        )
        c.update_profile(name=name)
        c.start()
        self.clients.append(c)
        return c

    def wait_connected(self, *clients, timeout=8):
        ok = wait_for(lambda: all(c.snapshot()["connected"] for c in clients), timeout)
        self.assertTrue(ok, "İstemciler relay'e bağlanamadı: " + json.dumps([c.snapshot()["error"] for c in clients]))

    def befriend(self, a, b):
        a.add_friend(b.snapshot()["profile"]["code"])
        self.assertTrue(wait_for(lambda: b.snapshot()["requests"]["in"], 5), "Arkadaşlık isteği ulaşmadı")
        req = b.snapshot()["requests"]["in"][0]
        b.respond_friend(req["player_id"], True)
        self.assertTrue(wait_for(lambda: a.snapshot()["friends"] and b.snapshot()["friends"], 5), "Arkadaşlık kurulamadı")

    def test_full_flow(self):
        a = self.make_client("Ayse", "a")
        b = self.make_client("Mehmet", "b")
        c = self.make_client("Zeynep", "c")
        self.wait_connected(a, b, c)

        # Arkadaşlık + presence
        self.befriend(a, b)
        self.befriend(a, c)
        b.call({"type": "presence", "status": "playing", "detail": "Test dünyası"})
        self.assertTrue(wait_for(lambda: any(f["status"] == "playing" for f in a.snapshot()["friends"]), 5))

        # Dünya paylaşımı + iki misafir
        self.echo = EchoServer()
        a.share_world("Test Dünyası", self.echo.port)
        self.assertTrue(wait_for(lambda: a.snapshot()["share"], 3), "Paylaşım oturumu oluşmadı")
        self.assertTrue(wait_for(lambda: b.snapshot()["invites"] and c.snapshot()["invites"], 5), "Davetler ulaşmadı")
        sid = b.snapshot()["invites"][0]["session_id"]
        b.join_world(sid)
        c.join_world(sid)
        self.assertTrue(wait_for(lambda: len(a.snapshot()["share"].get("guests", [])) == 2, 5), "Host iki misafiri görmedi")

        for client in (b, c):
            port = client.snapshot()["joined"]["local_port"]
            client_sock = socket.create_connection(("127.0.0.1", port), timeout=5)
            try:
                client_sock.sendall(b"merhaba")
                received = b""
                end = time.time() + 5
                while time.time() < end and b"ECHO:merhaba" not in received:
                    received += client_sock.recv(100)
                self.assertEqual(received, b"ECHO:merhaba")
            finally:
                client_sock.close()
            self.assertTrue(wait_for(lambda: client.snapshot()["joined"] is None, 5), "Misafir bağlantısı temizlenmedi")

        a.unshare_world()
        self.assertTrue(wait_for(lambda: a.snapshot()["share"] is None, 3))

        # Arkadaşlıktan çıkarma
        b_id = b.snapshot()["profile"]["player_id"]
        a.remove_friend(b_id)
        self.assertTrue(wait_for(lambda: not a.snapshot()["friends"] or all(f["player_id"] != b_id for f in a.snapshot()["friends"]), 5))
        self.assertTrue(wait_for(lambda: all(f["player_id"] != a.snapshot()["profile"]["player_id"] for f in b.snapshot()["friends"]), 5))

    def test_persistence_after_relay_restart(self):
        a = self.make_client("Ayse", "a")
        b = self.make_client("Mehmet", "b")
        self.wait_connected(a, b)
        self.befriend(a, b)
        a_id = a.snapshot()["profile"]["player_id"]
        b_id = b.snapshot()["profile"]["player_id"]
        a.stop()
        b.stop()
        self.relay.stop()
        time.sleep(0.4)
        self.relay = RelayProcess(os.path.join(self.tmp.name, "relay.json"))
        a2 = self.make_client("Ayse", "a")
        b2 = self.make_client("Mehmet", "b")
        self.wait_connected(a2, b2)
        self.assertTrue(wait_for(lambda: a2.snapshot()["friends"] and b2.snapshot()["friends"], 5), "Arkadaşlık relay yeniden başlayınca kayboldu")
        self.assertEqual(a2.snapshot()["profile"]["player_id"], a_id)
        self.assertEqual(b2.snapshot()["profile"]["player_id"], b_id)

    def test_reconnect_after_relay_switch(self):
        a = self.make_client("Ayse", "a")
        self.wait_connected(a)
        second = RelayProcess(os.path.join(self.tmp.name, "relay2.json"))
        old = self.relay
        old_port = old.control_port
        try:
            a.update_profile(relay_host="127.0.0.1", relay_port=second.control_port, relay_tls=False)
            self.assertTrue(
                wait_for(lambda: a.snapshot()["connected"]
                         and a.snapshot()["relay"]["port"] == second.control_port, 8),
                "Profil değişince yeni relay'e yeniden bağlanılmadı",
            )
            self.assertNotEqual(old_port, second.control_port)
        finally:
            old.stop()
            self.relay = second

    def test_local_host_uses_local_tunnel_port(self):
        relay = RelayProcess(os.path.join(self.tmp.name, "relay-adv.json"), advertise_tunnel_port=45678)
        old = self.relay
        self.relay = relay
        try:
            a = self.make_client("Ayse", "adv-a")
            b = self.make_client("Mehmet", "adv-b")
            self.wait_connected(a, b)
            self.befriend(a, b)
            self.echo = EchoServer()
            result = a.share_world("Local Tunnel", self.echo.port)
            self.assertEqual(result["tunnel_port"], 45678)
            self.assertNotEqual(result["local_tunnel_port"], 45678)
            self.assertEqual(a.snapshot()["relay"]["tunnel_port"], result["local_tunnel_port"])
            self.assertTrue(wait_for(lambda: b.snapshot()["invites"], 5))
            sid = b.snapshot()["invites"][0]["session_id"]
            b.join_world(sid)
            port = b.snapshot()["joined"]["local_port"]
            s = socket.create_connection(("127.0.0.1", port), timeout=5)
            try:
                s.sendall(b"local")
                self.assertEqual(s.recv(100), b"ECHO:local")
            finally:
                s.close()
        finally:
            old.stop()
            self.relay = relay

    def test_wrong_secret_rejected(self):
        a = self.make_client("Ayse", "a")
        self.wait_connected(a)
        a.stop()
        profile_path = os.path.join(self.tmp.name, "a", "social.json")
        with open(profile_path, "r", encoding="utf-8") as f:
            profile = json.load(f)
        profile["secret"] = "bozuk-secret"
        with open(profile_path, "w", encoding="utf-8") as f:
            json.dump(profile, f)
        bad = SocialClient(
            os.path.join(self.tmp.name, "a"),
            relay_host="127.0.0.1",
            relay_port=self.relay.control_port,
            enable_lan=False,
        )
        bad.start()
        self.clients.append(bad)
        self.assertTrue(wait_for(lambda: bad.snapshot()["error"], 6), "Hatalı secret için hata bekleniyordu")
        self.assertFalse(bad.snapshot()["connected"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
