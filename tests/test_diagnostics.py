import struct
import subprocess
import sys
import threading
import unittest

import diagnostics


class DNSTests(unittest.TestCase):
    def response(self, tid, flags=0x8180, rcode=0):
        header = struct.pack(">HHHHHH", tid, flags | rcode, 1, 1, 0, 0)
        question = b"\x07example\x03com\x00" + struct.pack(">HH", 1, 1)
        answer = b"\xc0\x0c" + struct.pack(">HHIH", 1, 1, 60, 4) + b"\x01\x02\x03\x04"
        return header + question + answer

    def test_build_query(self):
        tid, query = diagnostics._dns_build_query("example.com")
        self.assertGreaterEqual(tid, 0)
        self.assertIn(b"example", query)
        self.assertEqual(query[-4:], b"\x00\x01\x00\x01")

    def test_parse_a_record(self):
        self.assertEqual(diagnostics._dns_parse_message(self.response(42), 42), ["1.2.3.4"])

    def test_reject_wrong_transaction(self):
        with self.assertRaisesRegex(ValueError, "ID"):
            diagnostics._dns_parse_message(self.response(42), 43)

    def test_reject_rcode(self):
        with self.assertRaisesRegex(ValueError, "错误码"):
            diagnostics._dns_parse_message(self.response(42, rcode=3), 42)

    def test_detect_truncated_response(self):
        with self.assertRaises(diagnostics.TruncatedDNS):
            diagnostics._dns_parse_message(self.response(42, flags=0x8380), 42)

    def test_verdict_is_not_pollution_proof(self):
        self.assertIn("不能单独排除", diagnostics.dns_verdict([{1}, {1}]))
        self.assertIn("不能仅凭此判定污染", diagnostics.dns_verdict([{1}, {2}]))


class MeasurementTests(unittest.TestCase):
    def test_stable_marks_skip_warmup(self):
        marks = [(0.0, 0), (1.0, 125000), (5.0, 625000)]
        self.assertEqual(diagnostics._stable_marks(marks, 1), (500000, 4.0))

    def test_cancel_system_command(self):
        diagnostics.clear_cancel()
        timer = threading.Timer(0.15, diagnostics.cancel_operations)
        timer.start()
        code, output = diagnostics.run_cmd([sys.executable, "-c", "import time; time.sleep(5)"], timeout=8)
        timer.cancel()
        diagnostics.clear_cancel()
        self.assertEqual(code, -3)
        self.assertIn("取消", output)


if __name__ == "__main__":
    unittest.main()
