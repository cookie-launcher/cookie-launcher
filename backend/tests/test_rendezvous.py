import json
import os
import sys
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "backend"))
import rendezvous


class MockWorker:
    def __init__(self):
        self.rooms = {}
        self.deleted = []
        worker = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def _body(self):
                n = int(self.headers.get("content-length") or 0)
                return json.loads(self.rfile.read(n).decode()) if n else {}

            def _json(self, code, body):
                raw = json.dumps(body).encode()
                self.send_response(code)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def do_PUT(self):
                room = self.path.rsplit("/", 1)[-1]
                body = self._body()
                auth = self.headers.get("authorization", "")
                if not auth.startswith("Bearer "):
                    return self._json(401, {"error": "unauthorized"})
                worker.rooms[room] = {
                    "h": body.get("h", "bore.pub"), "c": body["c"], "t": body["t"],
                    "exp": body.get("exp", 0), "key": auth,
                }
                self._json(200, {"ok": True})

            def do_GET(self):
                room = self.path.rsplit("/", 1)[-1]
                value = worker.rooms.get(room)
                if not value:
                    return self._json(404, {"error": "not_found"})
                self._json(200, {"v": 1, "h": value["h"], "c": value["c"], "t": value["t"]})

            def do_DELETE(self):
                room = self.path.rsplit("/", 1)[-1]
                worker.rooms.pop(room, None)
                worker.deleted.append(room)
                self._json(200, {"ok": True})

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}"

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()


class RendezvousTest(unittest.TestCase):
    def test_publish_resolve_delete(self):
        worker = MockWorker()
        try:
            pub = rendezvous.RendezvousPublisher(
                worker.url, "ROOM123456789", "host-secret",
                25641, 7476, relay_host="bore.pub", interval=600,
            )
            self.assertTrue(pub.start(wait=5))
            self.assertIn("ROOM123456789", worker.rooms)
            got = rendezvous.resolve(worker.url, "ROOM123456789")
            self.assertEqual(got["c"], 25641)
            self.assertEqual(got["t"], 7476)
            self.assertEqual(got["h"], "bore.pub")
            pub.stop()
            self.assertIn("ROOM123456789", worker.deleted)
        finally:
            worker.close()

    def test_unreachable_falls_back(self):
        pub = rendezvous.RendezvousPublisher(
            "http://127.0.0.1:1", "ROOM123456789", "host-secret", 1, 2, interval=600)
        self.assertFalse(pub.start(wait=1))
        self.assertFalse(pub.published)


if __name__ == "__main__":
    unittest.main()
