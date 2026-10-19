import os
import socket
import sys
import threading
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "backend"))
from noise_layer import NoiseSession, generate_keypair, prologue_for, send_frame, recv_frame


class NoiseTest(unittest.TestCase):
    def _pair(self, guest_peer=None, host_prologue=None, guest_prologue=None):
        host_priv, host_pub = generate_keypair()
        guest_priv, guest_pub = generate_keypair()
        a, b = socket.socketpair()
        a.settimeout(5)
        b.settimeout(5)
        pro = prologue_for("sess-test")
        host = NoiseSession(host_priv, prologue=host_prologue if host_prologue is not None else pro)
        guest = NoiseSession(guest_priv, guest_peer if guest_peer is not None else host_pub,
                             prologue=guest_prologue if guest_prologue is not None else pro)
        return a, b, host, guest

    def test_handshake_and_encrypted_data(self):
        a, b, host, guest = self._pair()
        errors = []

        def responder():
            try:
                host.handshake_responder(a)
                data = host.recv(a)
                self.assertEqual(data, b"ping")
                host.send(a, b"pong")
            except Exception as exc:
                errors.append(repr(exc))

        def initiator():
            try:
                guest.handshake_initiator(b)
                guest.send(b, b"ping")
                self.assertEqual(guest.recv(b), b"pong")
            except Exception as exc:
                errors.append(repr(exc))

        t1 = threading.Thread(target=responder)
        t2 = threading.Thread(target=initiator)
        t1.start(); t2.start(); t1.join(8); t2.join(8)
        a.close(); b.close()
        self.assertEqual(errors, [])

    def test_final_payload_roundtrip(self):
        a, b, host, guest = self._pair()
        result = []

        def responder():
            try:
                result.append(host.handshake_responder(a))
            except Exception as exc:
                result.append(repr(exc).encode())

        def initiator():
            try:
                guest.handshake_initiator(b, b'{"pid":"guest"}')
            except Exception:
                pass

        t1 = threading.Thread(target=responder)
        t2 = threading.Thread(target=initiator)
        t1.start(); t2.start(); t1.join(8); t2.join(8)
        a.close(); b.close()
        self.assertEqual(result, [b'{"pid":"guest"}'])

    def test_wrong_host_identity_rejected(self):
        _, other_pub = generate_keypair()
        a, b, host, guest = self._pair(guest_peer=other_pub)
        result = []

        def responder():
            try:
                host.handshake_responder(a)
            except Exception:
                pass

        def initiator():
            try:
                guest.handshake_initiator(b)
                result.append("accepted")
            except Exception as exc:
                result.append(type(exc).__name__)

        t1 = threading.Thread(target=responder)
        t2 = threading.Thread(target=initiator)
        t1.start(); t2.start(); t1.join(8); t2.join(8)
        a.close(); b.close()
        self.assertIn("ConnectionError", result)

    def test_ciphertext_hides_plaintext(self):
        a, b, host, guest = self._pair()
        errors = []

        def responder():
            try:
                host.handshake_responder(a)
                host.send(a, b"secret-minecraft-packet")
            except Exception as exc:
                errors.append(repr(exc))

        def initiator():
            try:
                guest.handshake_initiator(b)
                self.assertEqual(guest.recv(b), b"secret-minecraft-packet")
            except Exception as exc:
                errors.append(repr(exc))

        t1 = threading.Thread(target=responder)
        t2 = threading.Thread(target=initiator)
        t1.start(); t2.start(); t1.join(8); t2.join(8)
        a.close(); b.close()
        self.assertEqual(errors, [])

    def test_framing_limit(self):
        a, b = socket.socketpair()
        try:
            send_frame(a, b"abc")
            self.assertEqual(recv_frame(b), b"abc")
        finally:
            a.close(); b.close()


if __name__ == "__main__":
    unittest.main()
