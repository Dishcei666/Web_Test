#!/usr/bin/env python3
"""NetScope 系统诊断与节点测量。仅使用 Python 标准库。"""

import http.client
import json
import platform
import random
import re
import socket
import ssl
import struct
import subprocess
import threading
import time
import urllib.request

IS_WIN = platform.system() == "Windows"
CANCEL_EVENT = threading.Event()
DNS_RESOLVERS = [("223.5.5.5", "阿里 DNS"), ("119.29.29.29", "腾讯 DNS"), ("8.8.8.8", "Google DNS")]
DOH_URL = "https://dns.alidns.com/resolve?name={name}&type=A"
NODES = {
    "tencent": {"name": "腾讯 CDN", "url": "https://dldir1.qq.com/weixin/Windows/WeChatSetup.exe"},
    "aliyun": {"name": "阿里 npmmirror", "url": "https://registry.npmmirror.com/-/binary/node/v20.11.1/node-v20.11.1-win-x64.zip"},
    "tuna": {"name": "清华 TUNA", "url": "https://mirrors.tuna.tsinghua.edu.cn/anaconda/archive/Anaconda3-2024.02-1-Windows-x86_64.exe"},
}


class OperationCancelled(Exception):
    pass


class TruncatedDNS(Exception):
    pass


def cancel_operations():
    CANCEL_EVENT.set()


def clear_cancel():
    CANCEL_EVENT.clear()


def check_cancel():
    if CANCEL_EVENT.is_set():
        raise OperationCancelled("操作已取消")


def smart_decode(data):
    for enc in ("utf-8", "gb18030", "latin-1"):
        try:
            return data.decode(enc)
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", errors="replace")


def run_cmd(cmd, timeout):
    """运行系统命令，支持超时和主动取消，返回 (退出码, 输出)。"""
    try:
        p = subprocess.Popen(
            cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            creationflags=subprocess.CREATE_NO_WINDOW if IS_WIN else 0,
        )
    except FileNotFoundError:
        return -1, "未找到命令：%s（当前系统可能不可用）" % cmd[0]
    except OSError as e:
        return -1, "无法启动命令：%s" % e

    deadline = time.monotonic() + timeout
    result = None
    while p.poll() is None:
        if CANCEL_EVENT.is_set():
            result = (-3, "操作已取消")
            p.terminate()
            break
        if time.monotonic() >= deadline:
            result = (-2, "命令超时（%ss）：%s" % (timeout, " ".join(cmd)))
            p.kill()
            break
        time.sleep(0.1)
    out = p.communicate()[0] or b""
    if result:
        return result[0], (smart_decode(out).strip() + "\n" + result[1]).strip()
    return p.returncode, smart_decode(out).strip()


# ---------------- 基础诊断 ----------------

def api_ping(host, count=10):
    cmd = ["ping", "-n", str(count), "-w", "1500", host] if IS_WIN else ["ping", "-c", str(count), "-W", "2", host]
    code, out = run_cmd(cmd, timeout=count * 2 + 8)
    if code == -1:
        return {"ok": False, "error": out}, 502
    rtts = []
    for line in out.splitlines():
        low = line.lower()
        if "ttl" in low or "time=" in low:
            m = re.search(r"[=<]\s*(\d+(?:\.\d+)?)\s*ms", low)
            if m:
                rtts.append(float(m.group(1)))
    m = re.search(r"(\d+)%", out)
    loss = float(m.group(1)) if m else None
    stats = None
    if rtts:
        stats = {
            "发送": count, "接收": len(rtts),
            "丢包率%": loss if loss is not None else round((count - len(rtts)) / count * 100, 1),
            "最小ms": min(rtts), "平均ms": round(sum(rtts) / len(rtts), 1), "最大ms": max(rtts),
        }
    return {"ok": code == 0 and bool(rtts), "cancelled": code == -3, "stats": stats, "raw": out}, 200


def api_traceroute(host):
    cmd = ["tracert", "-d", "-h", "20", "-w", "1000", host] if IS_WIN else ["traceroute", "-n", "-m", "20", "-w", "1", host]
    code, out = run_cmd(cmd, timeout=60)
    return {"ok": code in (0, -2), "cancelled": code == -3, "raw": out}, 200


def api_pathping(host):
    if not IS_WIN:
        return {"ok": False, "error": "pathping 仅 Windows 可用；Linux/macOS 可使用 mtr", "raw": ""}, 200
    code, out = run_cmd(["pathping", "-q", "8", "-p", "200", "-w", "600", "-h", "15", host], timeout=120)
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
            cur = {"跃点": int(m.group(1)), "地址": re.sub(r"[\[\]]", "", m.group(2)).strip()}
    return {"ok": code == 0 and bool(rows), "cancelled": code == -3, "stats": rows or None, "raw": out}, 200


def api_wifi():
    if not IS_WIN:
        code, out = run_cmd(["iwconfig"], timeout=10)
        stats = {}
        sig = rate = None
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
    stats = {}
    sig = rx = tx = band = radio = ssid = None
    for line in out.splitlines():
        low = line.lower()
        patterns = [
            (r"(?:信号|signal)\s*[:：]\s*(\d+)%", "sig"),
            (r"(?:接收速率|receive rate)\s*\(?\s*mbps\s*\)?\s*[:：]\s*([\d.]+)", "rx"),
            (r"(?:传输速率|transmit rate)\s*\(?\s*mbps\s*\)?\s*[:：]\s*([\d.]+)", "tx"),
            (r"(?:波段|频段|频带|band)\s*[:：]\s*(\S.*?)\s*$", "band"),
            (r"无线电类型\s*[:：]\s*(\S.*)$", "radio"),
            (r"^\s*ssid\s*[:：]\s*(\S.*)$", "ssid"),
        ]
        for pattern, key in patterns:
            m = re.search(pattern, low if key not in ("band", "radio") else line)
            if m:
                value = m.group(1).strip()
                if key in ("sig", "rx", "tx"):
                    value = float(value) if key != "sig" else int(value)
                if key == "sig": sig = value
                elif key == "rx": rx = value
                elif key == "tx": tx = value
                elif key == "band": band = value
                elif key == "radio": radio = value
                elif key == "ssid": ssid = value
    if sig is None:
        return {"ok": False, "stats": None, "raw": out + "\n（未检测到已连接的 WiFi，可能正在使用有线网络）"}, 200
    stats["信号强度%"] = sig
    if rx: stats["接收速率Mbps"] = rx
    if tx: stats["传输速率Mbps"] = tx
    if band: stats["频段"] = band
    if radio: stats["无线电类型"] = radio
    if ssid: stats["SSID"] = ssid
    hint = "信号良好" if sig >= 75 else ("信号一般，高速率下可能成为瓶颈" if sig >= 60 else "信号偏弱，建议靠近路由器或改用有线")
    if band and "2.4" in band and rx and rx < 200:
        hint += "；当前为 2.4GHz，高速宽带建议改用 5GHz/6GHz 或网线"
    stats["提示"] = hint
    return {"ok": True, "stats": stats, "raw": out}, 200


def api_port(host, port):
    try:
        check_cancel()
        t0 = time.perf_counter()
        s = socket.create_connection((host, port), timeout=6)
        ms = (time.perf_counter() - t0) * 1000
        s.close()
    except OperationCancelled as e:
        return {"ok": False, "cancelled": True, "error": str(e)}, 200
    except OSError as e:
        return {"ok": False, "stats": {"目标": "%s:%s" % (host, port), "结果": "连接失败"}, "raw": "连接失败：%s" % e}, 200
    grade = "极快" if ms < 30 else ("正常" if ms < 150 else ("偏慢" if ms < 400 else "很慢"))
    return {"ok": True, "stats": {"目标": "%s:%s" % (host, port), "TCP握手ms": round(ms, 1), "参考评价": grade}, "raw": "TCP 连接成功，握手 %.1f ms" % ms}, 200


def api_dns(host):
    results = []
    for _ in range(3):
        check_cancel()
        t = time.perf_counter()
        try:
            infos = socket.getaddrinfo(host, None)
        except socket.gaierror as e:
            return {"ok": False, "error": "解析失败：%s" % e}, 200
        addrs = sorted({i[4][0] for i in infos})
        results.append({"耗时ms": round((time.perf_counter() - t) * 1000, 1), "地址": addrs[:3]})
    return {"ok": True, "stats": results, "raw": "\n".join("第 %d 次：%s ms -> %s" % (i + 1, r["耗时ms"], ", ".join(r["地址"])) for i, r in enumerate(results)) + "\n注：系统解析可能命中缓存，耗时不代表上游 DNS 响应速度。"}, 200


# ---------------- DNS 差异对比 ----------------

def _dns_build_query(name):
    tid = random.randint(0, 65535)
    header = struct.pack(">HHHHHH", tid, 0x0100, 1, 0, 0, 0)
    try:
        q = b"".join(bytes([len(p)]) + p.encode("ascii") for p in name.split(".")) + b"\x00"
    except (UnicodeError, ValueError) as e:
        raise ValueError("主机名无法编码") from e
    return tid, header + q + struct.pack(">HH", 1, 1)


def _dns_skip_name(data, i):
    while i < len(data):
        length = data[i]
        if length == 0:
            return i + 1
        if length & 0xC0 == 0xC0:
            if i + 2 > len(data):
                raise ValueError("不完整 DNS 压缩指针")
            return i + 2
        if length & 0xC0 or i + 1 + length > len(data):
            raise ValueError("无效 DNS 名称")
        i += 1 + length
    raise ValueError("不完整 DNS 名称")


def _dns_parse_message(data, expected_tid):
    if len(data) < 12:
        raise ValueError("DNS 响应过短")
    tid, flags, qdcount, ancount, _, _ = struct.unpack(">HHHHHH", data[:12])
    if tid != expected_tid:
        raise ValueError("DNS 响应 ID 不匹配")
    if flags & 0x0200:
        raise TruncatedDNS()
    if flags & 0x000F:
        raise ValueError("DNS 返回错误码 %d" % (flags & 0x000F))
    i = 12
    for _ in range(qdcount):
        i = _dns_skip_name(data, i) + 4
    ips = []
    for _ in range(ancount):
        i = _dns_skip_name(data, i)
        if i + 10 > len(data):
            raise ValueError("不完整 DNS 应答记录")
        rtype, _rclass, _ttl, rdlen = struct.unpack(">HHIH", data[i:i + 10])
        i += 10
        if i + rdlen > len(data):
            raise ValueError("不完整 DNS 记录数据")
        if rtype == 1 and rdlen == 4:
            ips.append(".".join(str(b) for b in data[i:i + 4]))
        i += rdlen
    return ips


def _dns_query_tcp(resolver, name, timeout=3.0):
    tid, query = _dns_build_query(name)
    t0 = time.perf_counter()
    with socket.create_connection((resolver, 53), timeout=timeout) as s:
        s.sendall(struct.pack(">H", len(query)) + query)
        header = s.recv(2)
        if len(header) != 2:
            raise ValueError("DNS TCP 响应不完整")
        size = struct.unpack(">H", header)[0]
        chunks, remaining = [], size
        while remaining:
            chunk = s.recv(remaining)
            if not chunk:
                raise ValueError("DNS TCP 连接提前结束")
            chunks.append(chunk)
            remaining -= len(chunk)
    return round((time.perf_counter() - t0) * 1000, 1), _dns_parse_message(b"".join(chunks), tid)


def _dns_query_udp(resolver, name, timeout=3.0):
    tid, query = _dns_build_query(name)
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
        s.settimeout(timeout)
        s.connect((resolver, 53))
        t0 = time.perf_counter()
        s.send(query)
        data = s.recv(65535)
    try:
        ips = _dns_parse_message(data, tid)
    except TruncatedDNS:
        return _dns_query_tcp(resolver, name, timeout)
    return round((time.perf_counter() - t0) * 1000, 1), ips


def _dns_query_doh(name, timeout=5.0):
    req = urllib.request.Request(DOH_URL.format(name=name), headers={"Accept": "application/dns-json"})
    t0 = time.perf_counter()
    with urllib.request.urlopen(req, timeout=timeout) as r:
        payload = json.loads(smart_decode(r.read()))
    if payload.get("Status", 0) != 0:
        raise ValueError("DoH 返回错误码 %s" % payload.get("Status"))
    ips = [a.get("data") for a in payload.get("Answer", []) if a.get("type") == 1]
    return round((time.perf_counter() - t0) * 1000, 1), ips


def dns_verdict(sets):
    valid = [s for s in sets if s]
    if len(valid) < 2:
        return "可用解析器不足，无法比较。"
    if all(s == valid[0] for s in valid):
        return "本次可用解析器结果一致；单一时间样本不能单独排除劫持或污染。"
    return "解析结果存在差异；CDN 调度、GeoDNS、缓存或网络策略均可能造成差异，不能仅凭此判定污染。"


def api_dnscompare(host):
    rows, sets = [], []
    t0 = time.perf_counter()
    try:
        infos = socket.getaddrinfo(host, None)
        ips = sorted({i[4][0] for i in infos if i[0] == socket.AF_INET})
        rows.append({"解析器": "系统默认", "耗时ms": round((time.perf_counter() - t0) * 1000, 1), "结果": ", ".join(ips[:4]) or "(无 A 记录)"})
        sets.append(set(ips))
    except OSError as e:
        rows.append({"解析器": "系统默认", "耗时ms": "-", "结果": "失败：%s" % e})
        sets.append(None)
    for addr, label in DNS_RESOLVERS:
        check_cancel()
        try:
            ms, ips = _dns_query_udp(addr, host)
            rows.append({"解析器": "%s（%s）" % (label, addr), "耗时ms": ms, "结果": ", ".join(ips[:4]) or "(无 A 记录)"})
            sets.append(set(ips))
        except (OSError, ValueError) as e:
            rows.append({"解析器": "%s（%s）" % (label, addr), "耗时ms": "-", "结果": "失败：%s" % e})
            sets.append(None)
    try:
        ms, ips = _dns_query_doh(host)
        rows.append({"解析器": "阿里 DoH（加密）", "耗时ms": ms, "结果": ", ".join(ips[:4]) or "(无 A 记录)"})
        sets.append(set(ips))
    except Exception as e:
        rows.append({"解析器": "阿里 DoH（加密）", "耗时ms": "-", "结果": "失败：%s" % type(e).__name__})
        sets.append(None)
    verdict = dns_verdict(sets)
    return {"ok": True, "stats": rows, "verdict": verdict, "raw": "\n".join("%s：%s ms -> %s" % (r["解析器"], r["耗时ms"], r["结果"]) for r in rows) + "\n说明：" + verdict}, 200


# ---------------- 本机网络摘要 ----------------

def api_netinfo():
    stats = {"主机名": socket.gethostname()}
    try:
        stats["本机IP"] = ", ".join(sorted(set(socket.gethostbyname_ex(socket.gethostname())[2]))[:6])
    except OSError:
        pass
    if IS_WIN:
        code, out = run_cmd(["ipconfig", "/all"], timeout=12)
    else:
        code, out = run_cmd(["ip", "addr"], timeout=12)
        if code == -1:
            code, out = run_cmd(["ifconfig", "-a"], timeout=12)
    ipv4s, gateways, dnss = [], [], []
    for line in out.splitlines():
        low = line.lower()
        ips = re.findall(r"\b(\d{1,3}(?:\.\d{1,3}){3})\b", line)
        if not ips:
            continue
        if ("ipv4" in low and "地址" in line) or "ipv4 address" in low:
            ipv4s.extend(ips)
        if "默认网关" in line or "default gateway" in low:
            gateways.extend(ips)
        if "dns" in low and ("服务器" in line or "servers" in low):
            dnss.extend(ips)
    if ipv4s: stats["IPv4"] = ", ".join(sorted(set(ipv4s))[:8])
    if gateways: stats["默认网关"] = ", ".join(sorted(set(gateways))[:4])
    if dnss: stats["DNS服务器"] = ", ".join(sorted(set(dnss))[:6])
    return {"ok": True, "stats": stats, "raw": out}, 200


# ---------------- 多连接节点测速 ----------------

def _stable_marks(marks, warmup):
    if not marks:
        return 0, 0
    warm_t = marks[0][0] + warmup
    base_t, base_b = marks[0]
    for t, b in marks:
        if t <= warm_t:
            base_t, base_b = t, b
        else:
            break
    last_t, last_b = marks[-1]
    return last_b - base_b, max(0, last_t - base_t)


def _run_pool(workers, timeout):
    threads = [threading.Thread(target=w, daemon=True) for w in workers]
    for t in threads: t.start()
    for t in threads: t.join(timeout)
    return not any(t.is_alive() for t in threads)


def api_nodespeed(node_id, seconds=5, conns=3, warmup=1):
    node = NODES.get(node_id)
    if not node:
        return {"ok": False, "error": "未知节点：%s" % node_id}, 404
    seconds = max(2, min(10, seconds))
    conns = max(1, min(8, conns))
    warmup = max(0, min(3, warmup))
    results = [None] * conns

    def worker(idx):
        try:
            check_cancel()
            req = urllib.request.Request(node["url"], headers={"Range": "bytes=0-268435455", "User-Agent": "Mozilla/5.0 (NetScope)"})
            t0 = time.perf_counter()
            with urllib.request.urlopen(req, timeout=8) as r:
                ttfb = (time.perf_counter() - t0) * 1000
                first = time.perf_counter()
                deadline = first + seconds
                total, marks = 0, [(first, 0)]
                while time.perf_counter() < deadline:
                    check_cancel()
                    chunk = r.read(65536)
                    if not chunk:
                        break
                    total += len(chunk)
                    marks.append((time.perf_counter(), total))
            stable_b, stable_d = _stable_marks(marks, warmup)
            results[idx] = {"bytes": total, "stable_bytes": stable_b, "stable_dur": stable_d, "ttfb": ttfb}
        except OperationCancelled as e:
            results[idx] = {"cancelled": True, "err": e}
        except Exception as e:
            results[idx] = {"err": e}

    finished = _run_pool([lambda i=i: worker(i) for i in range(conns)], seconds + 15)
    if not finished:
        return {"ok": False, "error": "节点测速线程未正常结束"}, 200
    if any(r and r.get("cancelled") for r in results):
        return {"ok": False, "cancelled": True, "error": "操作已取消"}, 200
    ok = [r for r in results if r and "bytes" in r and r["stable_dur"] > 0]
    if not ok:
        err = next((r["err"] for r in results if r and "err" in r), "未收到数据")
        return {"ok": False, "error": "节点下载失败：%s" % err}, 200
    total = sum(r["bytes"] for r in ok)
    stable_bytes = sum(r["stable_bytes"] for r in ok)
    dur = max(r["stable_dur"] for r in ok)
    mbps = stable_bytes * 8 / dur / 1e6
    stats = {"节点": node["name"], "首字节ms": round(min(r["ttfb"] for r in ok)), "下载Mbps": round(mbps, 2), "实测MB": round(total / 1048576, 2), "连接数": len(ok)}
    return {"ok": True, "stats": stats, "raw": "节点：%s\n首字节 %.0f ms，稳定下载 %.2f Mbps（%d 条连接）" % (node["name"], stats["首字节ms"], mbps, len(ok))}, 200


def _stack_download(family, seconds, conns=3, warmup=1):
    try:
        infos = socket.getaddrinfo("speed.cloudflare.com", 443, family, socket.SOCK_STREAM)
    except OSError as e:
        return {"ok": False, "错误": "DNS 解析失败：%s" % e}
    results = [None] * conns

    def worker(idx):
        conn = None
        try:
            check_cancel()
            raw = socket.socket(family, socket.SOCK_STREAM)
            raw.settimeout(8)
            t0 = time.perf_counter()
            raw.connect(infos[idx % len(infos)][4])
            local = raw.getsockname()[0]
            ctx = ssl.create_default_context()
            secure = ctx.wrap_socket(raw, server_hostname="speed.cloudflare.com")
            conn_ms = (time.perf_counter() - t0) * 1000
            conn = http.client.HTTPSConnection("speed.cloudflare.com", timeout=8, context=ctx)
            conn.sock = secure
            total, marks, first = 0, [], None
            deadline = None
            while True:
                check_cancel()
                conn.request("GET", "/__down?bytes=26214400", headers={"User-Agent": "NetScope", "Accept": "*/*"})
                response = conn.getresponse()
                if response.status != 200:
                    raise OSError("HTTP %d" % response.status)
                if first is None:
                    first = time.perf_counter()
                    marks = [(first, 0)]
                    deadline = first + seconds
                while True:
                    check_cancel()
                    chunk = response.read(65536)
                    if not chunk:
                        break
                    total += len(chunk)
                    marks.append((time.perf_counter(), total))
                    if time.perf_counter() >= deadline:
                        break
                if time.perf_counter() >= deadline:
                    break
            stable_b, stable_d = _stable_marks(marks, warmup)
            results[idx] = {"bytes": total, "stable_bytes": stable_b, "stable_dur": stable_d, "conn_ms": conn_ms, "local": local}
        except OperationCancelled as e:
            results[idx] = {"cancelled": True, "err": e}
        except (OSError, http.client.HTTPException) as e:
            results[idx] = {"err": e}
        finally:
            if conn:
                try: conn.close()
                except OSError: pass

    if not _run_pool([lambda i=i: worker(i) for i in range(conns)], seconds + 15):
        return {"ok": False, "错误": "测速线程未正常结束"}
    if any(r and r.get("cancelled") for r in results):
        return {"ok": False, "cancelled": True, "错误": "操作已取消"}
    ok = [r for r in results if r and "bytes" in r and r["stable_dur"] > 0]
    if not ok:
        err = next((r["err"] for r in results if r and "err" in r), OSError("未收到数据"))
        return {"ok": False, "错误": "%s：%s" % (type(err).__name__, err)}
    return {
        "ok": True, "本机地址": ok[0]["local"], "连接ms": round(min(r["conn_ms"] for r in ok)),
        "连接数": len(ok), "下载Mbps": round(sum(r["stable_bytes"] for r in ok) * 8 / max(r["stable_dur"] for r in ok) / 1e6, 2),
    }


def api_dualstack(seconds=5, conns=3, warmup=1):
    seconds = max(2, min(8, seconds))
    conns = max(1, min(8, conns))
    warmup = max(0, min(3, warmup))
    v4 = _stack_download(socket.AF_INET, seconds, conns, warmup)
    v6 = _stack_download(socket.AF_INET6, seconds, conns, warmup)
    if v4["ok"] and v6["ok"]:
        verdict = "双栈均可用，本次 IPv6 吞吐%s" % ("较高" if v6["下载Mbps"] > v4["下载Mbps"] * 1.15 else ("较低" if v6["下载Mbps"] < v4["下载Mbps"] * 0.85 else "与 IPv4 接近"))
    elif v4["ok"]:
        verdict = "本次仅 IPv4 测量成功；IPv6 可能未配置或当前不可达"
    elif v6["ok"]:
        verdict = "本次仅 IPv6 测量成功，建议检查 IPv4 连接"
    else:
        verdict = "IPv4 / IPv6 本次均测量失败"
    raw = ["IPv4：%s" % (("%.2f Mbps" % v4["下载Mbps"]) if v4["ok"] else v4["错误"]), "IPv6：%s" % (("%.2f Mbps" % v6["下载Mbps"]) if v6["ok"] else v6["错误"]), "说明：" + verdict]
    return {"ok": True, "ipv4": v4, "ipv6": v6, "verdict": verdict, "stats": {"IPv4": v4, "IPv6": v6, "说明": verdict}, "raw": "\n".join(raw)}, 200
