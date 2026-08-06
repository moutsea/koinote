#!/usr/bin/env python3
"""验证图床上传链路：登录 -> POST /api/images -> 取回图片。

对着本地 wrangler dev（8788）与 Go 后端（8090）跑。覆盖「粘贴图片自动上传」所依赖
的那条路径，以及几个安全闸门：文件头必须与声明类型一致、SVG 拒收、超限拒收。

与 _check_image_base.mjs 的分工：那边在 Node 里验 normalizeImageBase 的纯函数边界，
这边验真实运行时里的上传、取回、鉴权和拒收 —— 前者验不了 R2 是否真写进去了。
"""

import json
import secrets
import struct
import sys
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


def png_bytes(width=2, height=2):
    """最小合法 PNG。用真字节而不是伪造的头 —— Worker 会按文件头校验。"""

    def chunk(tag, data):
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    raw = b"".join(b"\x00" + b"\xff\x00\x00" * width for _ in range(height))
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(raw))
        + chunk(b"IEND", b"")
    )


def register():
    tag = secrets.token_hex(6)
    body = json.dumps(
        {
            "username": f"i{tag}",
            "email": f"i{tag}@example.com",
            "password": "password123",
        }
    ).encode()
    req = urllib.request.Request(
        f"{BACKEND}/api/auth/register", data=body, method="POST"
    )
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req) as resp:
            return resp.headers.get("Set-Cookie", "").split(";")[0]
    except urllib.error.HTTPError as e:
        print(f"register failed: {e.code} {e.read()}")
        sys.exit(1)


def upload(data, content_type, cookie):
    req = urllib.request.Request(f"{WORKER}/api/images", data=data, method="POST")
    req.add_header("Content-Type", content_type)
    if cookie:
        req.add_header("Cookie", cookie)
    try:
        with urllib.request.urlopen(req) as resp:
            return resp.status, json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


cookie = register()
png = png_bytes()

# ---------- 正常上传 ----------
status, body = upload(png, "image/png", cookie)
check("PNG 上传成功", status == 200, f"{status} {body}")
image = body.get("image", {})
key = image.get("key", "")
url = image.get("url", "")
check("返回 key 带用户前缀", key.startswith("u/"), f"key={key}")
check("返回 key 以 .png 结尾", key.endswith(".png"), f"key={key}")
check("返回大小与原始字节一致", image.get("size") == len(png), f"{image.get('size')} vs {len(png)}")

# ---------- 取回 ----------
if url:
    path = url if url.startswith("http") else f"{WORKER}{url}"
    try:
        with urllib.request.urlopen(path) as resp:
            fetched = resp.read()
            check("能取回刚上传的图", resp.status == 200)
            check("取回的字节与上传一致", fetched == png, f"{len(fetched)} vs {len(png)}")
            check(
                "Content-Type 是 image/png",
                resp.headers.get("Content-Type", "").startswith("image/png"),
                resp.headers.get("Content-Type"),
            )
    except urllib.error.HTTPError as e:
        check("能取回刚上传的图", False, f"{e.code}")

# ---------- 未登录 ----------
status, body = upload(png, "image/png", None)
check("未登录被拒", status == 401, f"{status} {body}")
check("未登录带 unauthorized 码", body.get("code") == "unauthorized", body.get("code"))

# ---------- 类型混淆：声明 png 实际不是 ----------
status, body = upload(b"<html>not an image</html>", "image/png", cookie)
check("声明 png 但内容不是 -> 拒", status == 415, f"{status} {body}")

# 声明 jpeg 但传的是 PNG 字节
status, body = upload(png, "image/jpeg", cookie)
check("声明与实际不符 -> 拒", status == 415, f"{status} {body}")
check(
    "不符时带 image_type_mismatch 码",
    body.get("code") == "image_type_mismatch",
    body.get("code"),
)

# ---------- SVG 拒收 ----------
status, body = upload(b"<svg xmlns='http://www.w3.org/2000/svg'></svg>", "image/svg+xml", cookie)
check("SVG 被拒", status == 415, f"{status} {body}")
check("SVG 带专门的错误码", body.get("code") == "image_svg_rejected", body.get("code"))

# ---------- 不支持的类型 ----------
status, body = upload(png, "image/bmp", cookie)
check("不支持的类型被拒", status == 415, f"{status} {body}")

# ---------- 空内容 ----------
status, body = upload(b"", "image/png", cookie)
check("空内容被拒", status == 400, f"{status} {body}")

# ---------- 超限 ----------
status, body = upload(b"\x89PNG\r\n\x1a\n" + b"\x00" * (10 * 1024 * 1024), "image/png", cookie)
check("超过 10 MiB 被拒", status == 413, f"{status} {body}")

# ---------- 隔离：两个用户的 key 前缀不同 ----------
other = register()
status, body = upload(png, "image/png", other)
other_key = body.get("image", {}).get("key", "")
check("另一用户上传成功", status == 200, f"{status} {body}")
check(
    "两用户的 key 前缀不同",
    key.split("/")[1] != other_key.split("/")[1] if other_key else False,
    f"{key} vs {other_key}",
)

print(f"\nimage paste: {passed} passed, {failed} failed")
sys.exit(0 if failed == 0 else 1)
