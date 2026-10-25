import json
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

import server


class LocalSecurityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        cls.httpd.configured_host = "127.0.0.1"
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = "http://127.0.0.1:%d" % cls.httpd.server_address[1]

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.thread.join(timeout=2)

    def request(self, path, token=True, origin=None):
        headers = {}
        if token:
            headers["X-NetScope-Token"] = server.TOKEN
        if origin:
            headers["Origin"] = origin
        req = urllib.request.Request(self.base + path, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=3) as response:
                return response.status, response.read()
        except urllib.error.HTTPError as e:
            return e.code, e.read()

    def test_index_receives_per_start_token(self):
        status, body = self.request("/", token=False)
        self.assertEqual(status, 200)
        self.assertNotIn(b"__NETSCOPE_TOKEN__", body)
        self.assertIn(server.TOKEN.encode("ascii"), body)

    def test_private_project_files_are_not_served(self):
        for path in ("/.git/config", "/server.py", "/tests/test_server.py"):
            status, _ = self.request(path, token=False)
            self.assertEqual(status, 404)

    def test_api_requires_token(self):
        status, _ = self.request("/api/whoami", token=False)
        self.assertEqual(status, 403)

    def test_api_accepts_token(self):
        status, body = self.request("/api/whoami")
        self.assertEqual(status, 200)
        self.assertTrue(json.loads(body)["server"])

    def test_api_rejects_foreign_origin(self):
        status, _ = self.request("/api/whoami", origin="https://evil.example")
        self.assertEqual(status, 403)


if __name__ == "__main__":
    unittest.main()
