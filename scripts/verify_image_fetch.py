#!/usr/bin/env python3
"""验证代抓端点 POST /api/images/fetch。

跑起一个本地 HTTP 源站当「别人的网站」，让 Worker 去抓它，确认字节确实落进了 R2。
再逐条打 SSRF 防护：内网地址、非法 scheme、非标端口、重定向到内网、超大响应。

注意：源站本身监听在 127.0.0.1，而防护要拒掉 127.0.0.1 —— 这不矛盾。放行用例走的是
Worker 容器视角下可达的公网风格地址（见 PUBLIC_HOST 的说明）。
"""

import http.server
import json
import secrets
import socket
import struct
import sys
import threading
import urllib.error
import urllib.request
import zlib

WORKER = "http://localhost:8788"
BACKEND = "http://localhost:8090"

passed = 0
failed = 0


def check(label, cond, detail=""):
    global passed, failed
    if cond:
        passed += 1
    else:
        failed += 1
        print(f"FAIL  {label}" + (f" — {detail}" if detail else ""))


def png_bytes(width=3, height=3):
    def chunk(tag, data):
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    raw = b"".join(b"\x00" + b"\x00\x80\xff" * width for _ in range(height))
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(raw))
        + chunk(b"IEND", b"")
    )


PNG = png_bytes()
BIG = b"\x89PNG\r\n\x1a\n" + b"\x00" * (11 * 1024 * 1024)


class Origin(http.server.BaseHTTPRequestHandler):
    """假装是别人的网站。"""

    def log_message(self, *args):
        pass  # 别把访问日志混进断言输出

    def do_GET(self):
        if self.path == "/ok.png":
            self.send_response(200)
            self.send_header("Content-Type", "image/png")
            self.send_header("Content-Length", str(len(PNG)))
            self.end_headers()
            self.wfile.write(PNG)
        elif self.path == "/no-content-type":
            # 很多 CDN 上的图没有正确的 Content-Type，必须靠嗅探救回来
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(len(PNG)))
            self.end_headers()
            self.wfile.write(PNG)
        elif self.path == "/not-an-image":
            body = b"<html>hello</html>"
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        elif self.path == "/lying-length":
            # 声称很小，实际发很多 —— 只信 Content-Length 就会被打爆
            self.send_response(200)
            self.send_header("Content-Type", "image/png")
            self.send_header("Content-Length", "100")
            self.end_headers()
            try:
                self.wfile.write(BIG)
            except (BrokenPipeError, ConnectionResetError):
                pass
        elif self.path == "/too-big":
            self.send_response(200)
            self.send_header("Content-Type", "image/png")
            self.send_header("Content-Length", str(len(BIG)))
            self.end_headers()
            try:
                self.wfile.write(BIG)
            except (BrokenPipeError, ConnectionResetError):
                pass
        elif self.path == "/redirect-to-metadata":
            self.send_response(302)
            self.send_header("Location", "http://169.254.169.254/latest/meta-data/")
            self.end_headers()
        elif self.path == "/redirect-to-localhost":
            self.send_response(302)
            self.send_header("Location", "http://127.0.0.1:22/")
            self.end_headers()
        elif self.path == "/redirect-loop":
            self.send_response(302)
            self.send_header("Location", "/redirect-loop")
            self.end_headers()
        elif self.path == "/redirect-ok":
            self.send_response(302)
            self.send_header("Location", "/ok.png")
            self.end_headers()
        elif self.path == "/404":
            self.send_response(404)
            self.end_headers()
        else:
            self.send_response(404)
            self.end_headers()


def start_origin():
    server = http.server.ThreadingHTTPServer(("0.0.0.0", 0), Origin)
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, port


def lan_ip():
    """本机在局域网里的地址。

    源站必须挂在一个「不被 SSRF 防护拒掉」的地址上，否则测不了放行路径。
    127.0.0.1 会被拒（这正是我们要的），所以改用局域网地址 —— 它不在 10/8、
    172.16/12、192.168/16 里的话最好，否则放行用例会被正确地拒掉，脚本会说明原因。
    """
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    finally:
        s.close()


def register():
    tag = secrets.token_hex(6)
    body = json.dumps(
        {
            "username": f"f{tag}",
            "email": f"f{tag}@example.com",
            "password": "password123",
        }
    ).encode()
    req = urllib.request.Request(f"{BACKEND}/api/auth/register", data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req) as resp:
            return resp.headers.get("Set-Cookie", "").split(";")[0]
    except urllib.error.HTTPError as e:
        print(f"register failed: {e.code} {e.read()}")
        sys.exit(1)


def fetch_image(url, cookie, timeout=30):
    body = json.dumps({"url": url}).encode()
    req = urllib.request.Request(f"{WORKER}/api/images/fetch", data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    if cookie:
        req.add_header("Cookie", cookie)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")
    except Exception as e:  # 超时等
        return 0, {"error": str(e)}


server, port = start_origin()
host = lan_ip()
ORIGIN = f"http://{host}:{port}"
cookie = register()

print(f"源站: {ORIGIN}")

# ---------- 放行路径：真实公网图片 ----------
#
# 本地源站测不了放行路径 —— 它只能挂在本机地址上，而本机地址（127.0.0.1 或私网段）
# 正是防护要拒的。所以放行路径打真实公网 URL。
# 代价是依赖外网；抓不到时区分不了「代码坏了」和「网络不通」，所以下面会说明。
PUBLIC_CASES = [
    ("png", "https://www.google.com/images/branding/googlelogo/1x/googlelogo_color_272x92dp.png"),
    ("jpg", "https://www.gstatic.com/webp/gallery/1.jpg"),
    ("webp", "https://www.gstatic.com/webp/gallery/1.webp"),
]

online = False
for label, url in PUBLIC_CASES:
    status, body = fetch_image(url, cookie)
    if status == 0 or (status == 502 and not online):
        print(f"跳过公网 {label}：抓不到（{body}），可能是外网不通")
        continue
    online = True
    check(f"抓取公网 {label} 成功", status == 200, f"{status} {body}")
    image = body.get("image", {})
    check(f"公网 {label} 落进 R2", image.get("key", "").startswith("u/"), image.get("key"))
    check(f"公网 {label} 有字节", (image.get("size") or 0) > 0, str(image.get("size")))
    # 扩展名跟着真实字节走，而不是跟着 URL 的后缀 —— 有些站按 Accept 做内容协商，
    # .png 的地址会返回 webp
    ctype = image.get("contentType", "")
    ext = image.get("key", "").rsplit(".", 1)[-1]
    expected = {"image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp"}
    check(
        f"公网 {label} 的扩展名与实际类型一致",
        expected.get(ctype) == ext,
        f"type={ctype} ext={ext}",
    )
    # 取回来确认真的存进去了
    u = image.get("url", "")
    if u:
        path = u if u.startswith("http") else f"{WORKER}{u}"
        try:
            with urllib.request.urlopen(path) as resp:
                check(
                    f"公网 {label} 取回大小一致",
                    len(resp.read()) == image.get("size"),
                )
        except urllib.error.HTTPError as e:
            check(f"公网 {label} 取回大小一致", False, f"{e.code}")

if not online:
    print("外网不通，放行路径未验证 —— 拒绝路径的断言仍然有效")

# ---------- 未登录 ----------
status, body = fetch_image(f"{ORIGIN}/ok.png", None)
check("未登录被拒", status == 401, f"{status} {body}")

# ---------- SSRF 防护 ----------
# 这些不依赖源站，纯粹打防护
rejected_cases = [
    ("http://127.0.0.1/a.png", "回环"),
    ("http://localhost/a.png", "localhost"),
    ("http://169.254.169.254/latest/meta-data/", "云元数据"),
    ("http://10.0.0.1/a.png", "私网 10/8"),
    ("http://192.168.1.1/a.png", "私网 192.168/16"),
    ("http://172.16.0.1/a.png", "私网 172.16/12"),
    ("http://2130706433/a.png", "十进制回环"),
    ("http://0x7f000001/a.png", "十六进制回环"),
    ("http://[::1]/a.png", "IPv6 回环"),
    ("http://[::ffff:127.0.0.1]/a.png", "IPv4 映射回环"),
    ("file:///etc/passwd", "file scheme"),
    ("data:image/png;base64,AAAA", "data scheme"),
    ("ftp://example.com/a.png", "ftp scheme"),
    (f"http://{host}:22/", "非标端口"),
    (f"http://user:pw@{host}:{port}/ok.png", "URL 内嵌凭证"),
    ("", "空地址"),
    ("not a url", "畸形地址"),
]
for url, note in rejected_cases:
    status, body = fetch_image(url, cookie)
    check(
        f"拒绝 {note}",
        status == 400 and body.get("code") == "image_fetch_rejected",
        f"{status} {body}",
    )

# ---------- 正常抓取 ----------
status, body = fetch_image(f"{ORIGIN}/ok.png", cookie)
if status == 400 and body.get("code") == "image_fetch_rejected":
    print(
        f"\n跳过放行用例：本机地址 {host} 落在私网段里，被防护正确拒绝。\n"
        "放行路径要在非私网地址上才测得了。"
    )
else:
    check("抓取成功", status == 200, f"{status} {body}")
    image = body.get("image", {})
    key = image.get("key", "")
    check("落进 R2 并返回 key", key.startswith("u/"), f"key={key}")
    check("大小与源站一致", image.get("size") == len(PNG), f"{image.get('size')} vs {len(PNG)}")
    check("类型是 png", image.get("contentType") == "image/png", image.get("contentType"))

    # 取回来比对字节
    url = image.get("url", "")
    if url:
        path = url if url.startswith("http") else f"{WORKER}{url}"
        try:
            with urllib.request.urlopen(path) as resp:
                check("取回的字节与源站一致", resp.read() == PNG)
        except urllib.error.HTTPError as e:
            check("取回的字节与源站一致", False, f"{e.code}")

    # Content-Type 不对时靠嗅探救回来
    status, body = fetch_image(f"{ORIGIN}/no-content-type", cookie)
    check("上游 Content-Type 错也能抓（靠嗅探）", status == 200, f"{status} {body}")

    # 不是图片要拒
    status, body = fetch_image(f"{ORIGIN}/not-an-image", cookie)
    check("上游返回 HTML 被拒", status == 415, f"{status} {body}")

    # 重定向：跟到图片
    status, body = fetch_image(f"{ORIGIN}/redirect-ok", cookie)
    check("跟随重定向抓到图", status == 200, f"{status} {body}")

    # 重定向到内网必须拒 —— 只校验首个地址的话这里会漏
    status, body = fetch_image(f"{ORIGIN}/redirect-to-metadata", cookie)
    check(
        "重定向到云元数据被拒",
        status == 400 and body.get("code") == "image_fetch_rejected",
        f"{status} {body}",
    )
    status, body = fetch_image(f"{ORIGIN}/redirect-to-localhost", cookie)
    check(
        "重定向到回环被拒",
        status == 400 and body.get("code") == "image_fetch_rejected",
        f"{status} {body}",
    )

    # 重定向环要在跳数上限内停下
    status, body = fetch_image(f"{ORIGIN}/redirect-loop", cookie)
    check("重定向环被截断", status == 502, f"{status} {body}")

    # 上游 404
    status, body = fetch_image(f"{ORIGIN}/404", cookie)
    check("上游 404 报 image_fetch_failed", status == 502, f"{status} {body}")

    # 超限：声称的长度就超了
    status, body = fetch_image(f"{ORIGIN}/too-big", cookie)
    check("超大响应被拒", status == 413, f"{status} {body}")

    # 声称小实际大 —— 只信 Content-Length 就会被打爆
    status, body = fetch_image(f"{ORIGIN}/lying-length", cookie)
    check("谎报 Content-Length 也被拦住", status == 413, f"{status} {body}")

server.shutdown()
print(f"\nimage fetch: {passed} passed, {failed} failed")
sys.exit(0 if failed == 0 else 1)
