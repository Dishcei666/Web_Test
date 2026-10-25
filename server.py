#!/usr/bin/env python3
"""NetScope 本地服务器：安全静态托管、同源 API、诊断任务取消。"""

import argparse
import hmac
import json
import mimetypes
import os
import re
import secrets
import sys
import threading
import time
import urllib.parse
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import diagnostics

ROOT = os.path.dirname(os.path.abspath(__file__))
HOST_RE = re.compile(r"^[A-Za-z0-9._\-]+$")
TOKEN = secrets.token_urlsafe(32)
STATIC_FILES = {
    "/index.html": "index.html",
    "/app.js": "app.js",
    "/metrics.js": "metrics.js",
    "/style.css": "style.css",
    "/favicon.svg": "favicon.svg",
    "/docs/screenshot.png": "docs/screenshot.png",
}
HEAVY_ROUTES = {"ping", "traceroute", "pathping", "dns", "dnscompare", "nodespeed", "dualstack", "port", "wifi", "netinfo"}
RATE_LOCK = threading.Lock()
LAST_REQUEST = {}


class Handler(BaseHTTPRequestHandler):
    server_version = "NetScope/2.0"

    def log_message(self, fmt, *args):
        sys.stderr.write("[%s] %s\n" % (time.strftime("%H:%M:%S"), fmt % args))

    def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_json({"ok": False, "error": "不允许跨域访问"}, 403)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path.startswith("/api/"):
            return self.handle_api(parsed, "GET")
        if parsed.path == "/":
            parsed = parsed._replace(path="/index.html")
        return self.serve_static(parsed.path)

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if not parsed.path.startswith("/api/"):
            return self.send_json({"ok": False, "error": "接口不存在"}, 404)
        try:
            length = int(self.headers.get("Content-Length", "0") or 0)
        except ValueError:
            return self.send_json({"ok": False, "error": "Content-Length 不合法"}, 400)
        if not 0 <= length <= 4096:
            return self.send_json({"ok": False, "error": "请求体过大"}, 413)
        if length:
            self.rfile.read(length)
        return self.handle_api(parsed, "POST")

    def valid_host(self):
        host = self.headers.get("Host", "")
        try:
            hostname = urllib.parse.urlsplit("http://" + host).hostname
        except ValueError:
            return False
        allowed = {"127.0.0.1", "localhost", "::1"}
        configured = getattr(self.server, "configured_host", "127.0.0.1")
        if configured not in ("0.0.0.0", "::"):
            allowed.add(configured)
        return hostname in allowed

    def valid_origin(self):
        origin = self.headers.get("Origin")
        if not origin:
            return True
        host = self.headers.get("Host", "")
        return origin in ("http://" + host, "https://" + host)

    def authorized(self):
        token = self.headers.get("X-NetScope-Token", "")
        return hmac.compare_digest(token, TOKEN)

    def rate_limited(self, route):
        if route not in HEAVY_ROUTES:
            return False
        key = (self.client_address[0], route)
        now = time.monotonic()
        with RATE_LOCK:
            previous = LAST_REQUEST.get(key, 0)
            if now - previous < 1.0:
                return True
            LAST_REQUEST[key] = now
        return False

    def handle_api(self, parsed, method):
        route = parsed.path[len("/api/"):]
        if not self.valid_host() or not self.valid_origin():
            return self.send_json({"ok": False, "error": "请求来源不受信任"}, 403)
        if not self.authorized():
            return self.send_json({"ok": False, "error": "诊断令牌无效"}, 403)
        if route == "cancel":
            if method != "POST":
                return self.send_json({"ok": False, "error": "请使用 POST"}, 405)
            diagnostics.cancel_operations()
            return self.send_json({"ok": True}, 200)
        if route != "whoami":
            diagnostics.clear_cancel()
        if self.rate_limited(route):
            return self.send_json({"ok": False, "error": "请求过于频繁，请稍后重试"}, 429)
        if route == "whoami":
            return self.send_json({"server": True, "version": "2.0", "platform": diagnostics.platform.platform()}, 200)

        qs = urllib.parse.parse_qs(parsed.query)
        host = (qs.get("host") or [""])[0].strip()
        if route == "nodespeed":
            node_id = (qs.get("id") or [""])[0].strip()
            seconds = self.int_param(qs, "seconds", 5)
            conns = self.int_param(qs, "conns", 3)
            warmup = self.int_param(qs, "warmup", 1)
            data, status = diagnostics.api_nodespeed(node_id, seconds, conns, warmup)
            return self.send_json(data, status)
        if route == "dualstack":
            data, status = diagnostics.api_dualstack(
                self.int_param(qs, "seconds", 5), self.int_param(qs, "conns", 3), self.int_param(qs, "warmup", 1))
            return self.send_json(data, status)
        if route == "wifi":
            return self.send_json(*diagnostics.api_wifi())
        if route == "netinfo":
            return self.send_json(*diagnostics.api_netinfo())
        if not host or not HOST_RE.fullmatch(host) or len(host) > 253:
            return self.send_json({"ok": False, "error": "参数 host 缺失或不合法"}, 400)

        try:
            if route == "ping":
                data, status = diagnostics.api_ping(host, min(20, max(1, self.int_param(qs, "count", 10))))
            elif route == "traceroute":
                data, status = diagnostics.api_traceroute(host)
            elif route == "pathping":
                data, status = diagnostics.api_pathping(host)
            elif route == "dns":
                data, status = diagnostics.api_dns(host)
            elif route == "dnscompare":
                data, status = diagnostics.api_dnscompare(host)
            elif route == "port":
                port = self.int_param(qs, "port", 0)
                if not 1 <= port <= 65535:
                    return self.send_json({"ok": False, "error": "参数 port 不合法（1-65535）"}, 400)
                data, status = diagnostics.api_port(host, port)
            else:
                data, status = {"ok": False, "error": "未知接口：" + route}, 404
        except diagnostics.OperationCancelled:
            data, status = {"ok": False, "cancelled": True, "error": "操作已取消"}, 200
        except Exception as e:
            data, status = {"ok": False, "error": "诊断执行失败：%s" % e}, 500
        return self.send_json(data, status)

    @staticmethod
    def int_param(qs, key, default):
        try:
            return int((qs.get(key) or [default])[0])
        except (TypeError, ValueError):
            return default

    def serve_static(self, path):
        if path not in STATIC_FILES:
            return self.send_json({"ok": False, "error": "资源不存在"}, 404)
        filename = STATIC_FILES[path]
        full = os.path.join(ROOT, filename)
        try:
            with open(full, "rb") as f:
                body = f.read()
        except OSError:
            return self.send_json({"ok": False, "error": "资源读取失败"}, 404)
        if filename == "index.html":
            body = body.replace(b"__NETSCOPE_TOKEN__", TOKEN.encode("ascii"))
        ctype = mimetypes.guess_type(filename)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript", "application/json", "image/svg+xml"):
            ctype += "; charset=utf-8"
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' https://speed.cloudflare.com https://www.cloudflare.com https://ipwho.is; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=True).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass


def main():
    parser = argparse.ArgumentParser(description="NetScope 一次性网络环境测试台")
    parser.add_argument("--host", default="127.0.0.1", help="监听地址，默认仅本机 127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--no-open", action="store_true", help="不自动打开浏览器")
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("端口必须在 1-65535 之间")
    try:
        server = ThreadingHTTPServer((args.host, args.port), Handler)
    except OSError as e:
        print("服务启动失败：%s" % e)
        sys.exit(1)
    server.configured_host = args.host
    display_host = "127.0.0.1" if args.host in ("0.0.0.0", "::") else args.host
    url = "http://%s:%d" % (display_host, args.port)
    print("=" * 56)
    print("  NetScope · 网络环境测试台")
    print("  地址：%s" % url)
    print("  模式：一次性检测；API 已启用同源与令牌保护")
    print("  按 Ctrl+C 停止")
    print("=" * 56)
    if not args.no_open:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止。")
    finally:
        diagnostics.cancel_operations()
        server.server_close()


if __name__ == "__main__":
    main()
