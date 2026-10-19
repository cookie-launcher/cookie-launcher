import os
import socket
import sys
import threading
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "backend"))
import stun_client


class StunTest(unittest.TestCase):
    def test_parse_xor_and_plain(self):
        txid = b"0123456789ab"
        xor = stun_client.build_response(txid, "203.0.113.7", 54321, xor=True)
        self.assertEqual(stun_client.parse_response(xor, txid), ("203.0.113.7", 54321))
        plain = stun_client.build_response(txid, "198.51.100.9", 1234, xor=False)
        self.assertEqual(stun_client.parse_response(plain, txid), ("198.51.100.9", 1234))

    def test_discover_with_mock_server(self):
        server = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        server.bind(("127.0.0.1", 0))
        server.settimeout(3)
        addr = server.getsockname()

        def serve():
            try:
                data, peer = server.recvfrom(2048)
                txid = data[8:20]
                server.sendto(stun_client.build_response(txid, peer[0], peer[1]), peer)
            finally:
                server.close()

        t = threading.Thread(target=serve, daemon=True)
        t.start()
        client = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        client.bind(("127.0.0.1", 0))
        try:
            public = stun_client.discover(client, [(addr[0], addr[1])], timeout=1.5)
            self.assertEqual(public, client.getsockname()[:2])
        finally:
            client.close()
            t.join(2)


if __name__ == "__main__":
    unittest.main()
