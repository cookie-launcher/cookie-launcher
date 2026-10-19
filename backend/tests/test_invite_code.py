import sys
import os
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "backend"))
import invite_code


class InviteCodeTest(unittest.TestCase):
    def test_short_roundtrip_and_links(self):
        room = invite_code.new_room_id()
        session = invite_code.new_session_id()
        exp = 4102444800
        code = invite_code.make_short(room, session, exp, "H8N96JAT")
        self.assertEqual(invite_code.parse(code).room_id, room)
        self.assertEqual(invite_code.parse(code).host_code, "H8N96JAT")
        self.assertEqual(invite_code.parse(invite_code.deep_link(code)).session_id, session)
        self.assertEqual(invite_code.parse(invite_code.web_link(code)).expires, exp)

    def test_long_embedded_endpoint(self):
        code = invite_code.make_long(
            invite_code.new_room_id(), invite_code.new_session_id(), 4102444800,
            endpoint={"h": "bore.pub", "c": 25641, "t": 7476},
            host_name="emre", host_code="H8N9-6JAT", world="Dünya",
        )
        inv = invite_code.parse(code)
        self.assertFalse(inv.short)
        self.assertEqual(inv.endpoint["c"], 25641)
        self.assertEqual(inv.world, "Dünya")

    def test_expired(self):
        code = invite_code.make_short(invite_code.new_room_id(), invite_code.new_session_id(), 1000)
        with self.assertRaises(ValueError):
            invite_code.parse(code, now=2000)

    def test_invalid(self):
        with self.assertRaises(ValueError):
            invite_code.parse("CL1-NOPE")


if __name__ == "__main__":
    unittest.main()
