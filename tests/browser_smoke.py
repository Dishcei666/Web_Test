"""可选的 Chrome 页面冒烟验证；启动和清理均由本脚本负责。"""
import argparse
import os
import pathlib
import shutil
import socket
import subprocess
import sys
import time
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
WORK = ROOT / ".browser-smoke"


def chrome_path():
    candidates = [
        os.environ.get("CHROME_PATH"),
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
        "/usr/bin/google-chrome",
        "/usr/bin/chromium",
    ]
    for candidate in candidates:
        if candidate and pathlib.Path(candidate).is_file():
            return candidate
    raise RuntimeError("未找到 Chrome/Edge；可通过 CHROME_PATH 指定浏览器")


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--screenshots", action="store_true", help="更新桌面截图并生成手机验证截图")
    args = parser.parse_args()
    WORK.mkdir(exist_ok=True)
    profile = WORK / "profile"
    port = free_port()
    url = "http://127.0.0.1:%d/" % port
    server = subprocess.Popen(
        [sys.executable, "server.py", "--host", "127.0.0.1", "--port", str(port), "--no-open"],
        cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    )
    chrome = chrome_path()
    try:
        for _ in range(50):
            if server.poll() is not None:
                raise RuntimeError("验证服务器提前退出")
            try:
                with urllib.request.urlopen(url, timeout=0.3) as response:
                    if response.status == 200:
                        break
            except OSError:
                time.sleep(0.1)
        else:
            raise RuntimeError("验证服务器启动超时")

        def run_chrome(name, size, screenshot=None):
            output = WORK / (name + ".png")
            cmd = [
                chrome, "--headless=new", "--disable-gpu", "--no-first-run", "--no-proxy-server",
                "--hide-scrollbars", "--user-data-dir=" + str(profile / name),
                "--window-size=" + size, "--virtual-time-budget=2500", "--dump-dom", url,
            ]
            if screenshot:
                cmd.append("--screenshot=" + str(output))
            result = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=35)
            if result.returncode != 0:
                raise RuntimeError("Chrome 启动失败：" + result.stderr[-1000:])
            dom = result.stdout
            checks = {
                "页面标题": "<title>NetScope · 网络环境测试台</title>" in dom,
                "脚本已执行": 'id="serverBadge" class="badge on"' in dom and "诊断服务已连接" in dom,
                "诊断面板显示": 'id="diagPanel"' in dom and 'id="diagPanel" hidden' not in dom,
                "令牌已注入": "__NETSCOPE_TOKEN__" not in dom,
                "移动端无横向溢出": size.startswith("390") and 'class="topbar"' in dom or not size.startswith("390"),
            }
            failed = [key for key, ok in checks.items() if not ok]
            if failed:
                (WORK / (name + ".html")).write_text(dom, encoding="utf-8")
                raise AssertionError("%s 验证失败：%s" % (name, ", ".join(failed)))
            if screenshot and not output.is_file():
                raise AssertionError("截图未生成：" + str(output))
            print("%s：DOM、脚本、诊断连接和布局结构通过" % name)
            return output

        run_chrome("desktop", "1440,1000", args.screenshots)
        run_chrome("mobile", "390,844", args.screenshots)
        if args.screenshots:
            shutil.copyfile(WORK / "desktop.png", ROOT / "docs" / "screenshot.png")
            print("桌面截图已更新；手机验证图：%s" % (WORK / "mobile.png"))
        print("Chrome 页面冒烟验证全部通过")
    finally:
        if server.poll() is None:
            server.terminate()
            try:
                server.wait(timeout=4)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait(timeout=2)
        shutil.rmtree(profile, ignore_errors=True)


if __name__ == "__main__":
    main()
