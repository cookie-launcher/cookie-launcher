import asyncio
import os
import socket
import sys
import time
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "backend"))
import relay_handshake as hs


class RelayHandshakeTest(unittest.TestCase):
    def _scenario(self, tickets, token, ticket_id, expect_ok=True):
        async def run():
            server_sock, client_sock = socket.socketpair()
            async def handler():
                reader, writer = await asyncio.open_connection(sock=server_sock)
                result = await hs.server_handshake(reader, writer, tickets)
                if result:
                    hs.send_result(writer, True, 0)
                    hs.send_ready(writer)
                    await writer.drain()
                else:
                    hs.send_result(writer, False, 1)
                    await writer.drain()
                await asyncio.sleep(0.15)
                writer.close()
                try:
                    await writer.wait_closed()
                except Exception:
                    pass
            task = asyncio.create_task(handler())
            try:
                await asyncio.to_thread(hs.client_handshake, client_sock, ticket_id, token, hs.ROLE_HOST)
                ok = True
            except Exception:
                ok = False
            finally:
                client_sock.close()
            await task
            return ok
        return asyncio.run(run())

    def test_valid_then_replay_and_wrong_token(self):
        ticket_id = hs.new_ticket_id()
        token = hs.new_token()
        pair = {"token": token, "created": time.time(), "used": {}}
        tickets = {ticket_id: pair}
        self.assertTrue(self._scenario(tickets, token, ticket_id, True))
        # aynı ticket/rol replay edilemez
        self.assertFalse(self._scenario(tickets, token, ticket_id, False))
        # yeni ticket, yanlış token reddedilir
        tid2 = hs.new_ticket_id()
        tickets[tid2] = {"token": hs.new_token(), "created": time.time(), "used": {}}
        self.assertFalse(self._scenario(tickets, token, tid2, False))


if __name__ == "__main__":
    unittest.main()
