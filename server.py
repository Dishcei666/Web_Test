#!/usr/bin/env python3
"""网络环境测试台 · 本地诊断服务器（仅 Python 标准库，无需安装依赖）

用法：
    python server.py              # 启动后自动打开浏览器
    python server.py --no-open    # 不自动打开浏览器
    python server.py --port 9000  # 指定端口

功能：
    1. 托管 index.html / app.js / style.css
    2. 系统级诊断（浏览器做不到的部分）：
       /api/ping?host=          —— 系统 ICMP ping（丢包率、延迟统计）
       /api/traceroute?host=    —— 路由追踪
       /api/dns?host=           —— DNS 解析耗时
       /api/pathping?host=      —— 每跳丢包统计（Windows pathping，约 1 分钟）
       /api/wifi                —— WiFi 信号质量（信号强度 / 协商速率 / 频段）
       /api/port?host=&port=    —— TCP 端口连通性与握手耗时
       /api/dnscompare?host=    —— 多解析器 DNS 对比（污染/劫持检测）
       /api/netinfo             —— 本机网络摘要（网卡 IP / 网关 / DNS）
    3. 多节点中转测速：
       /api/nodespeed?id=       —— 经本机直连国内 CDN 测下载（绕开浏览器 CORS）
       /api/dualstack           —— IPv4 / IPv6 双栈下载对比
    4. 仅监听 127.0.0.1，不对外网开放
"""

import argparse
import json
import os
import platform
import random
import re
import socket
import ssl
import struct
import subprocess
import sys
import threading
import time
import urllib.request
import webbrowser
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

ROOT = os.path.dirname(os.path.abspath(__file__))
IS_WIN = platform.system() == "Windows"
HOST_RE = re.compile(r"^[A-Za-z0-9._\-]+$")

# 国内中转测速节点（均验证支持 Range 断点下载）
NODES = {
    "tencent": {"name": "腾讯 CDN", "url": "https://dldir1.qq.com/weixin/Windows/WeChatSetup.exe"},
    "aliyun": {"name": "阿里 npmmirror", "url": "https://registry.npmmirror.com/-/binary/node/v20.11.1/node-v20.11.1-win-x64.zip"},
    "tuna": {"name": "清华 TUNA（教育网）", "url": "https://mirrors.tuna.tsinghua.edu.cn/anaconda/archive/Anaconda3-2024.02-1-Windows-x86_64.exe"},
}

DNS_RESOLVERS = [("223.5.5.5", "阿里 DNS"), ("119.29.29.29", "腾讯 DNS"), ("8.8.8.8", "Google DNS")]
DOH_URL = "https://dns.alidns.com/resolve?name={name}&type=A"


def smart_decode(data: bytes) -> str:
    """系统命令输出编码因平台/区域而异：UTF-8 系统优先，中文 Windows 控制台为 GBK 系。"""
    for enc in ("utf-8", "gb18030", "latin-1"):
        try:
            return data.decode(enc)
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", errors="replace")


def run_cmd(cmd, timeout):
    """运行系统命令，返回 (退出码, 输出文本)。"""
    try:
        p = subprocess.run(
            cmd, capture_output=True, timeout=timeout,
            creationflags=subprocess.CREATE_NO_WINDOW if IS_WIN else 0,
        )
        out = (p.stdout or b"") + (p.stderr or b"")
        return p.returncode, smart_decode(out).strip()
    except FileNotFoundError:
        return -1, "未找到命令：%s（当前系统可能不可用）" % cmd[0]
    except subprocess.TimeoutExpired:
        return -2, "命令超时（%ss）：%s" % (timeout, " ".join(cmd))


# ---------------- 基础诊断 ----------------

def api_ping(host, count=10):
    if IS_WIN:
        cmd = ["ping", "-n", str(count), "-w", "1500", host]
    else:
        cmd = ["ping", "-c", str(count), "-W", "2", host]
    code, out = run_cmd(cmd, timeout=count * 2 + 8)
    if code == -1:
        return {"ok": False, "error": out}, 502

    # 每一行的往返延迟：Windows 中文「时间=23ms」/ 英文「time=23ms」，Linux 「time=23.4 ms」
    rtts = []
    for line in out.splitlines():
        low = line.lower()
        if ("ttl" in low) or ("time=" in low):
            m = re.search(r"[=<]\s*(\d+(?:\.\d+)?)\s*ms", low)
            if m:
                rtts.append(float(m.group(1)))
    m = re.search(r"(\d+)%", out)  # 丢包率：中英文格式都是 xx%
    loss = float(m.group(1)) if m else None
    stats = None
    if rtts:
        stats = {
            "发送": count, "接收": len(rtts),
            "丢包率%": loss if loss is not None else round((count - len(rtts)) / count * 100, 1),
            "最小ms": min(rtts), "平均ms": round(sum(rtts) / len(rtts), 1), "最大ms": max(rtts),
        }
    return {"ok": code == 0 and bool(rtts), "stats": stats, "raw": out}, 200


def api_traceroute(host):
    if IS_WIN:
        cmd = ["tracert", "-d", "-h", "20", "-w", "1000", host]
    else:
        cmd = ["traceroute", "-n", "-m", "20", "-w", "1", host]
    code, out = run_cmd(cmd, timeout=60)
    return {"ok": code in (0, -2), "raw": out}, 200


def api_pathping(host):
    if not IS_WIN:
        return {"ok": False, "error": "pathping 仅 Windows 可用，Linux 可安装 mtr 代替", "raw": ""}, 200
    cmd = ["pathping", "-q", "8", "-p", "200", "-w", "600", "-h", "15", host]
    code, out = run_cmd(cmd, timeout=120)
    if code == -1:
        return {"ok": False, "error": out}, 502

    # 解析每跳丢包：「跃点地址行」后跟「X/ 8 =  Y%」行
    rows, cur = [], None
    hop_re = re.compile(r"^\s{2,}(\d+)\s+(\S.*)$")
    loss_re = re.compile(r"(\d+)\s*/\s*(\d+)\s*=\s*(\d+)\s*%")
    for line in out.splitlines():
        m = loss_re.search(line)
        if m and cur is not None:
            cur["丢包%"] = int(m.group(3))
            rows.append(cur)
            cur = None
            continue
        m = hop_re.match(line)
        if m:
            addr = re.sub(r"[\[\]]", "", m.group(2)).strip()
            cur = {"跃点": int(m.group(1)), "地址": addr}
    stats = rows if rows else None
    return {"ok": code == 0 and bool(rows), "stats": stats, "raw": out}, 200


def api_wifi():
    if not IS_WIN:
        code, out = run_cmd(["iwconfig"], timeout=10)
        stats, sig, rate = {}, None, None
        for line in out.splitlines():
            if "Signal level" in line:
                m = re.search(r"Signal level[=:]\s*(-?\d+)", line)
                if m:
                    sig = int(m.group(1))
            m = re.search(r"Bit Rate[=:]\s*([\d.]+)\s*Mb/s", line)
            if m:
                rate = float(m.group(1))
        if sig is not None:
            stats["信号dBm"] = sig
            stats["信号估计%"] = max(0, min(100, (sig + 100) * 2))
        if rate:
            stats["协商速率Mbps"] = rate
        return {"ok": bool(stats), "stats": stats or None, "raw": out}, 200

    code, out = run_cmd(["netsh", "wlan", "show", "interfaces"], timeout=10)
    if code == -1:
        return {"ok": False, "error": out}, 502
    stats, sig, rx, tx, band, radio, ssid = {}, None, None, None, None, None, None
    for line in out.splitlines():
        low = line.lower()
        m = re.search(r"(?:信号|signal)\s*[:：]\s*(\d+)%", low)
        if m:
            sig = int(m.group(1))
        m = re.search(r"(?:接收速率|receive rate)\s*\(?\s*mbps\s*\)?\s*[:：]\s*([\d.]+)", low)
        if m:
            rx = float(m.group(1))
        m = re.search(r"(?:传输速率|transmit rate)\s*\(?\s*mbps\s*\)?\s*[:：]\s*([\d.]+)", low)
        if m:
            tx = float(m.group(1))
        m = re.search(r"(?:波段|频段|频带|band)\s*[:：]\s*(\S.*?)\s*$", line)
        if m:
            band = m.group(1).strip()
        m = re.search(r"无线电类型\s*[:：]\s*(\S.*)$", line)
        if m:
            radio = m.group(1).strip()
        m = re.search(r"^\s*ssid\s*[:：]\s*(\S.*)$", low)
        if m:
            ssid = m.group(1).strip()
    if sig is not None:
        stats["信号强度%"] = sig
        if rx: stats["接收速率Mbps"] = rx
        if tx: stats["传输速率Mbps"] = tx
        if band: stats["频段"] = band
        if radio: stats["无线电类型"] = radio
        if ssid: stats["SSID"] = ssid
        hint = None
        if sig < 60:
            hint = "信号偏弱，建议靠近路由器或改用 5GHz / 有线"
        elif sig < 75:
            hint = "信号一般，高速率下可能成为瓶颈"
        else:
            hint = "信号良好"
        if band and "2.4" in band and rx and rx < 200:
            hint += "；当前使用 2.4GHz（协商 %s Mbps），百兆以上宽带建议改用 5GHz 或网线" % rx
        stats["提示"] = hint
    else:
        return {"ok": False, "stats": None,
                "raw": out + "\n（未检测到已连接的 WiFi，可能正在使用有线网络）"}, 200
    return {"ok": True, "stats": stats, "raw": out}, 200


def api_port(host, port):
    try:
        t0 = time.perf_counter()
        s = socket.create_connection((host, port), timeout=6)
        ms = (time.perf_counter() - t0) * 1000
        s.close()
    except OSError as e:
        return {"ok": False, "stats": {"目标": "%s:%s" % (host, port), "结果": "连接失败"},
                "raw": "连接失败：%s\n（可能被防火墙/运营商拦截，或目标未开放该端口）" % e}, 200
    grade = "极快" if ms < 30 else ("正常" if ms < 150 else ("偏慢" if ms < 400 else "很慢"))
    return {"ok": True, "stats": {"目标": "%s:%s" % (host, port),
                                  "TCP握手ms": round(ms, 1), "评价": grade},
            "raw": "TCP 连接 %s:%s 成功，握手耗时 %.1f ms（%s）" % (host, port, ms, grade)}, 200


def api_dns(host):
    results = []
    for _ in range(3):
        t = time.perf_counter()
        try:
            infos = socket.getaddrinfo(host, None)
        except socket.gaierror as e:
            return {"ok": False, "error": "解析失败：%s" % e}, 200
        ms = (time.perf_counter() - t) * 1000
        addrs = sorted({i[4][0] for i in infos})
        results.append({"耗时ms": round(ms, 1), "地址": addrs[:3]})
    return {"ok": True, "stats": results, "raw": "\n".join(
        "第 %d 次：%s ms -> %s" % (i + 1, r["耗时ms"], ", ".join(r["地址"])) for i, r in enumerate(results))}, 200


# ---------------- DNS 污染对比 ----------------

def _dns_build_query(name):
    tid = random.randint(0, 65535)
    header = struct.pack(">HHHHHH", tid, 0x0100, 1, 0, 0, 0)
    q = b"".join(bytes([len(p)]) + p.encode() for p in name.split(".")) + b"\x00"
    return tid, header + q + struct.pack(">HH", 1, 1)


def _dns_skip_name(data, i):
    while i < len(data):
        l = data[i]
        if l == 0:
            return i + 1
        if l & 0xC0 == 0xC0:
            return i + 2
        i += 1 + l
    return i


def _dns_query_udp(resolver, name, timeout=3.0):
    _, q = _dns_build_query(name)
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.settimeout(timeout)
    try:
        t0 = time.perf_counter()
        s.sendto(q, (resolver, 53))
        data, _ = s.recvfrom(4096)
        ms = (time.perf_counter() - t0) * 1000
    finally:
        s.close()
    ancount = struct.unpack(">H", data[6:8])[0]
    i = _dns_skip_name(data, 12) + 4
    ips = []
    for _ in range(ancount):
        i = _dns_skip_name(data, i)
        if i + 10 > len(data):
            break
        rtype, _rclass, _ttl, rdlen = struct.unpack(">HHIH", data[i:i + 10])
        i += 10
        if rtype == 1 and rdlen == 4:
            ips.append(".".join(str(b) for b in data[i:i + 4]))
        i += rdlen
    return round(ms, 1), ips


def _dns_query_doh(name, timeout=5.0):
    url = DOH_URL.format(name=name)
    req = urllib.request.Request(url, headers={"Accept": "application/dns-json"})
    t0 = time.perf_counter()
    with urllib.request.urlopen(req, timeout=timeout) as r:
        j = json.loads(smart_decode(r.read()))
    ms = (time.perf_counter() - t0) * 1000
    ips = [a.get("data") for a in j.get("Answer", []) if a.get("type") == 1]
    return round(ms, 1), ips


def api_dnscompare(host):
    rows, sets = [], []

    t0 = time.perf_counter()
    try:
        infos = socket.getaddrinfo(host, None)
        sys_ips = sorted({i[4][0] for i in infos if i[0] == socket.AF_INET})
        rows.append({"解析器": "系统默认", "耗时ms": round((time.perf_counter() - t0) * 1000, 1),
                     "结果": ", ".join(sys_ips[:4]) or "(无 A 记录)"})
        sets.append(set(sys_ips))
    except OSError as e:
        rows.append({"解析器": "系统默认", "耗时ms": "-", "结果": "失败：%s" % e})
        sets.append(None)

    for addr, label in DNS_RESOLVERS:
        try:
            ms, ips = _dns_query_udp(addr, host)
            rows.append({"解析器": "%s（%s）" % (label, addr), "耗时ms": ms,
                         "结果": ", ".join(ips[:4]) or "(无 A 记录)"})
            sets.append(set(ips))
        except OSError as e:
            rows.append({"解析器": "%s（%s）" % (label, addr), "耗时ms": "-",
                         "结果": "失败：%s" % type(e).__name__})
            sets.append(None)

    try:
        ms, ips = _dns_query_doh(host)
        rows.append({"解析器": "阿里 DoH（加密）", "耗时ms": ms,
                     "结果": ", ".join(ips[:4]) or "(无 A 记录)"})
        sets.append(set(ips))
    except Exception as e:
        rows.append({"解析器": "阿里 DoH（加密）", "耗时ms": "-", "结果": "失败：%s" % type(e).__name__})
        sets.append(None)

    valid = [s for s in sets if s is not None and s]
    if len(valid) >= 2:
        consistent = all(s == valid[0] for s in valid)
        verdict = "各解析器结果一致，未发现污染迹象" if consistent else \
            "各解析器结果不一致：可能存在 DNS 污染 / 劫持，或部分解析器被拦截"
    else:
        verdict = "可用解析器不足，无法判断"
    return {"ok": True, "stats": rows, "verdict": verdict,
            "raw": "\n".join("%s：%s ms -> %s" % (r["解析器"], r["耗时ms"], r["结果"]) for r in rows)
                   + "\n结论：" + verdict}, 200


# ---------------- 本机网络摘要 ----------------

def api_netinfo():
    stats = {"主机名": socket.gethostname()}
    try:
        stats["本机IP"] = ", ".join(sorted(set(socket.gethostbyname_ex(socket.gethostname())[2]))[:6])
    except OSError:
        pass

    code, out = run_cmd(["ipconfig", "/all"] if IS_WIN else ["ifconfig", "-a"], timeout=12)
    ipv4s, gateways, dnss = [], [], []
    for line in out.splitlines():
        low = line.lower()
        ips = re.findall(r"\b(\d{1,3}(?:\.\d{1,3}){3})\b", line)
        if not ips:
            continue
        if "ipv4" in low and "地址" in line or "ipv4 address" in low:
            ipv4s.extend(ips)
        if "默认网关" in line or "default gateway" in low:
            gateways.extend(ips)
        if "dns" in low and ("服务器" in line or "servers" in low):
            dnss.extend(ips)
    if ipv4s: stats["IPv4"] = ", ".join(sorted(set(ipv4s))[:8])
    if gateways: stats["默认网关"] = ", ".join(sorted(set(gateways))[:4])
    if dnss: stats["DNS服务器"] = ", ".join(sorted(set(dnss))[:6])
    if IS_WIN:
        code2, out2 = run_cmd(["netsh", "wlan", "show", "interfaces"], timeout=10)
        m = re.search(r"(?:接收速率|receive rate)\(mbps\)\s*[:：]\s*([\d.]+)", out2.lower())
        if m:
            stats["WiFi协商速率Mbps"] = float(m.group(1))
    return {"ok": True, "stats": stats, "raw": out}, 200


# ---------------- 中转测速 ----------------

def api_nodespeed(node_id, seconds=6):
    node = NODES.get(node_id)
    if not node:
        return {"ok": False, "error": "未知节点：%s" % node_id}, 404
    seconds = max(2, min(10, seconds))
    req = urllib.request.Request(
        node["url"],
        headers={"Range": "bytes=0-268435455", "User-Agent": "Mozilla/5.0 (NetScope)"},
    )
    try:
        t0 = time.perf_counter()
        with urllib.request.urlopen(req, timeout=8) as r:
            ttfb_ms = (time.perf_counter() - t0) * 1000
            first = time.perf_counter()
            total, deadline = 0, time.perf_counter() + seconds
            while time.perf_counter() < deadline:
                chunk = r.read(65536)
                if not chunk:
                    break
                total += len(chunk)
            dur = max(0.001, time.perf_counter() - first)
    except Exception as e:
        return {"ok": False, "error": "节点下载失败：%s" % e,
                "raw": "节点：%s\n地址：%s" % (node["name"], node["url"])}, 200
    mbps = total * 8 / dur / 1e6
    stats = {"节点": node["name"], "首字节ms": round(ttfb_ms, 0),
             "下载Mbps": round(mbps, 2), "实测MB": round(total / 1048576, 2)}
    return {"ok": True, "stats": stats,
            "raw": "节点：%s\n首字节 %.0f ms，稳定下载 %.2f Mbps（%.1f MB / %.1f s）"
                   % (node["name"], ttfb_ms, mbps, total / 1048576, dur)}, 200


def _stack_download(family, seconds, conns=3):
    """指定协议族多连接并行下载 speed.cloudflare.com，返回聚合吞吐（单连接在长 RTT 链路上无代表性）。"""
    try:
        infos = socket.getaddrinfo("speed.cloudflare.com", 443, family, socket.SOCK_STREAM)
    except OSError as e:
        return {"ok": False, "错误": "DNS 解析失败：%s" % e}
    results = [None] * conns

    def worker(idx):
        try:
            raw = socket.socket(family, socket.SOCK_STREAM)
            raw.settimeout(8)
            t0 = time.perf_counter()
            raw.connect(infos[idx % len(infos)][4])
            local = raw.getsockname()[0]
            ctx = ssl.create_default_context()
            s = ctx.wrap_socket(raw, server_hostname="speed.cloudflare.com")
            conn_ms = (time.perf_counter() - t0) * 1000
            f = s.makefile("rb")
            # bytes 参数 Cloudflare 有上限（过大会被钳制成 1 字节），用 25MB 分段循环拉取
            total, first, deadline = 0, None, None
            while True:
                s.sendall(("GET /__down?bytes=26214400 HTTP/1.1\r\nHost: speed.cloudflare.com\r\n"
                           "User-Agent: NetScope\r\nAccept: */*\r\nConnection: keep-alive\r\n\r\n").encode())
                cl = 0
                while True:
                    line = f.readline()
                    if line in (b"\r\n", b"\n", b""):
                        break
                    k, _, v = line.decode(errors="replace").partition(":")
                    if k.strip().lower() == "content-length":
                        try:
                            cl = int(v.strip() or 0)
                        except ValueError:
                            cl = 0
                if first is None:
                    first = time.perf_counter()
                    deadline = first + seconds
                remaining = cl
                while remaining > 0:
                    chunk = f.read(min(65536, remaining))
                    if not chunk:
                        break
                    total += len(chunk)
                    remaining -= len(chunk)
                    if deadline and time.perf_counter() >= deadline:
                        break
                if not cl or (deadline and time.perf_counter() >= deadline):
                    break
            try:
                s.close()
            except OSError:
                pass
            dur = max(0.001, time.perf_counter() - first) if first else 0.001
            results[idx] = {"bytes": total, "dur": dur, "conn_ms": conn_ms, "local": local}
        except OSError as e:
            results[idx] = {"err": e}

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(conns)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(seconds + 12)

    ok_rows = [r for r in results if r and "bytes" in r]
    if not ok_rows:
        err = next((r["err"] for r in results if r and "err" in r), OSError("未知错误"))
        return {"ok": False, "错误": "%s：%s" % (type(err).__name__, err)}
    total_bytes = sum(r["bytes"] for r in ok_rows)
    dur = max(r["dur"] for r in ok_rows)
    return {"ok": True, "本机地址": ok_rows[0]["local"],
            "连接ms": round(min(r["conn_ms"] for r in ok_rows), 0),
            "下载Mbps": round(total_bytes * 8 / dur / 1e6, 2)}


def api_dualstack(seconds=5):
    seconds = max(2, min(8, seconds))
    v4 = _stack_download(socket.AF_INET, seconds)
    v6 = _stack_download(socket.AF_INET6, seconds)
    if v4["ok"] and v6["ok"]:
        verdict = "双栈均可用，IPv6 %s" % (
            "更快" if v6["下载Mbps"] > v4["下载Mbps"] * 1.15 else
            ("更慢，可考虑优先 IPv4" if v6["下载Mbps"] < v4["下载Mbps"] * 0.85 else "与 IPv4 相当"))
    elif v4["ok"]:
        verdict = "仅 IPv4 可用（当前网络无 IPv6 或不可达）"
    elif v6["ok"]:
        verdict = "仅 IPv6 可用（IPv4 异常）"
    else:
        verdict = "IPv4 / IPv6 均连接失败"
    raw = ["IPv4：%s" % ("%.2f Mbps（连接 %.0f ms，本机 %s）" % (v4["下载Mbps"], v4["连接ms"], v4["本机地址"])
                        if v4["ok"] else v4["错误"]),
           "IPv6：%s" % ("%.2f Mbps（连接 %.0f ms，本机 %s）" % (v6["下载Mbps"], v6["连接ms"], v6["本机地址"])
                        if v6["ok"] else "不可用（%s）" % v6["错误"]),
           "结论：" + verdict]
    return {"ok": True, "ipv4": v4, "ipv6": v6, "verdict": verdict,
            "stats": {"IPv4": v4, "IPv6": v6, "结论": verdict}, "raw": "\n".join(raw)}, 200


# ---------------- HTTP 服务 ----------------

class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path.startswith("/api/"):
            return self.handle_api(parsed)
        return super().do_GET()

    def handle_api(self, parsed):
        qs = parse_qs(parsed.query)
        host = (qs.get("host") or [""])[0].strip()
        route = parsed.path[len("/api/"):]

        if route == "whoami":
            return self.send_json({"server": True, "platform": platform.platform()}, 200)
        if route == "nodespeed":
            node_id = (qs.get("id") or [""])[0].strip()
            try:
                seconds = int((qs.get("seconds") or ["6"])[0])
            except ValueError:
                seconds = 6
            data, status = api_nodespeed(node_id, seconds)
            return self.send_json(data, status)
        if route == "dualstack":
            try:
                seconds = int((qs.get("seconds") or ["5"])[0])
            except ValueError:
                seconds = 5
            data, status = api_dualstack(seconds)
            return self.send_json(data, status)
        if route == "wifi":
            return self.send_json(*api_wifi())
        if route == "netinfo":
            return self.send_json(*api_netinfo())
        if not host or not HOST_RE.match(host):
            return self.send_json({"ok": False, "error": "参数 host 缺失或不合法"}, 400)

        if route == "ping":
            try:
                count = min(20, max(1, int((qs.get("count") or ["10"])[0])))
            except ValueError:
                count = 10
            data, status = api_ping(host, count)
        elif route == "traceroute":
            data, status = api_traceroute(host)
        elif route == "pathping":
            data, status = api_pathping(host)
        elif route == "dns":
            data, status = api_dns(host)
        elif route == "dnscompare":
            data, status = api_dnscompare(host)
        elif route == "port":
            try:
                port = int((qs.get("port") or [""])[0])
                assert 1 <= port <= 65535
            except Exception:
                return self.send_json({"ok": False, "error": "参数 port 不合法（1-65535）"}, 400)
            data, status = api_port(host, port)
        else:
            data, status = {"ok": False, "error": "未知接口：" + route}, 404
        return self.send_json(data, status)

    def send_json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=True).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        sys.stderr.write("[%s] %s\n" % (time.strftime("%H:%M:%S"), fmt % args))


def main():
    ap = argparse.ArgumentParser(description="网络环境测试台 · 本地诊断服务器")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--no-open", action="store_true", help="不自动打开浏览器")
    args = ap.parse_args()

    handler = partial(Handler, directory=ROOT)
    try:
        srv = ThreadingHTTPServer(("127.0.0.1", args.port), handler)
    except OSError as e:
        print("端口 %d 启动失败：%s" % (args.port, e))
        print("可换一个端口重试，例如：python server.py --port 8001")
        sys.exit(1)

    url = "http://127.0.0.1:%d" % args.port
    print("=" * 52)
    print("  网络环境测试台 · NetScope")
    print("  地址：%s" % url)
    print("  目录：%s" % ROOT)
    print("  按 Ctrl+C 停止")
    print("=" * 52)

    if not args.no_open:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()

    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止。")


if __name__ == "__main__":
    main()
