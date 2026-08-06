#!/usr/bin/env python3
"""验证删文档后 R2 里的图片被回收。

分两段看：
  1. 入队是同步的、确定的 —— 删完文档立刻查 pending_image_deletions 就能断言
  2. 真正删 R2 由后台 goroutine 每 30s 轮询一次，所以要等；等不到就说明没删掉

重点覆盖三条容易错的：
  - 还被别的文档引用的图不能删（复制粘贴到两篇里，删一篇不该让另一篇裂图）
  - 别人的图不能删（在自己的文档里写上别人的图片地址，删自己的文档不能删掉他的图）
  - 重复入队不报错（同一张图被两篇引用，两篇先后删掉）
"""

import json
import os
import secrets
import struct
import subprocess
import sys
import time
import urllib.error
import urllib.request
import zlib

WORKER = "http://localhost:8788"
BACKEND = "http://localhost:8090"
# 后台轮询间隔是 30s，留够余量
GC_WAIT_SECONDS = 75

passed = 0
failed = 0


def check(label, cond, detail=""):
    global passed, failed
    if cond:
        passed += 1
    else:
        failed += 1
        print(f"FAIL  {label}" + (f" — {detail}" if detail else ""))


def png_bytes(seed=0):
    """每次造一张字节不同的图，避免 R2 上的 key 撞在一起影响判断。"""

    def chunk(tag, data):
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

    w = h = 2
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)
    color = bytes([(seed * 37) % 256, (seed * 71) % 256, (seed * 113) % 256])
    raw = b"".join(b"\x00" + color * w for _ in range(h))
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(raw))
        + chunk(b"IEND", b"")
    )


def call(method, path, body=None, cookie=None, base=BACKEND):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f"{base}{path}", data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if cookie:
        req.add_header("Cookie", cookie)
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            return resp.status, json.loads(resp.read() or b"{}"), resp.headers.get("Set-Cookie", "")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}"), ""


def register():
    tag = secrets.token_hex(6)
    status, body, set_cookie = call(
        "POST",
        "/api/auth/register",
        {"username": f"g{tag}", "email": f"g{tag}@example.com", "password": "password123"},
    )
    if status != 200:
        print(f"register failed: {status} {body}")
        sys.exit(1)
    return set_cookie.split(";")[0]


def upload(seed, cookie):
    data = png_bytes(seed)
    req = urllib.request.Request(f"{WORKER}/api/images", data=data, method="POST")
    req.add_header("Content-Type", "image/png")
    req.add_header("Cookie", cookie)
    with urllib.request.urlopen(req, timeout=20) as resp:
        return json.loads(resp.read())["image"]


def object_exists(key):
    """直接打 Worker 的读路径看对象还在不在。"""
    req = urllib.request.Request(f"{WORKER}/images/{key}", method="HEAD")
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return resp.status == 200
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return False
        raise


def queue_rows():
    """直接查队列表。psql 走 docker exec，避免额外依赖。"""
    out = subprocess.run(
        [
            "docker", "compose", "exec", "-T", "postgres",
            "psql", "-U", os.environ.get("POSTGRES_USER", "koinote"),
            "-d", os.environ.get("POSTGRES_DB", "koinote"),
            "-t", "-A", "-c", "SELECT object_key FROM pending_image_deletions",
        ],
        capture_output=True,
        text=True,
    )
    if out.returncode != 0:
        print(f"查队列失败: {out.stderr[:300]}")
        return None
    return {line.strip() for line in out.stdout.splitlines() if line.strip()}


alice = register()
bob = register()

# ---------- 基本回收 ----------
img1 = upload(1, alice)
key1 = img1["key"]
check("上传成功", object_exists(key1), key1)

status, body, _ = call(
    "POST", "/api/documents",
    {"title": "带图的文档", "content": f"# 标题\n\n![图]({img1['url']})"},
    alice,
)
check("建文档成功", status == 200, f"{status} {body}")
doc1 = body["document"]["docId"]

status, _, _ = call("DELETE", f"/api/documents/{doc1}", None, alice)
check("删文档成功", status == 200, str(status))

rows = queue_rows()
check("删完立刻入队", rows is not None and key1 in rows, f"queue={rows}")

# ---------- 还被引用的图不能删 ----------
img2 = upload(2, alice)
key2 = img2["key"]
status, body, _ = call(
    "POST", "/api/documents", {"title": "A", "content": f"![x]({img2['url']})"}, alice
)
docA = body["document"]["docId"]
status, body, _ = call(
    "POST", "/api/documents", {"title": "B", "content": f"![x]({img2['url']})"}, alice
)
docB = body["document"]["docId"]

call("DELETE", f"/api/documents/{docA}", None, alice)
rows = queue_rows()
check(
    "还被另一篇引用的图不入队",
    rows is not None and key2 not in rows,
    f"key2={key2} queue={rows}",
)
check("此时对象还在", object_exists(key2))

# 把第二篇也删掉，这时才该入队
call("DELETE", f"/api/documents/{docB}", None, alice)
rows = queue_rows()
check("最后一个引用消失后入队", rows is not None and key2 in rows, f"queue={rows}")

# ---------- 别人的图不能删 ----------
bobs = upload(3, bob)
bobs_key = bobs["key"]
# alice 在自己的文档里写上 bob 的图片地址，然后删掉自己的文档
status, body, _ = call(
    "POST", "/api/documents",
    {"title": "引用他人图片", "content": f"![偷]({bobs['url']})"},
    alice,
)
doc_steal = body["document"]["docId"]
call("DELETE", f"/api/documents/{doc_steal}", None, alice)
rows = queue_rows()
check(
    "别人的图不会被排进回收队列",
    rows is not None and bobs_key not in rows,
    f"bobs_key={bobs_key} queue={rows}",
)
check("别人的图还在", object_exists(bobs_key))

# ---------- 重复入队不报错 ----------
img4 = upload(4, alice)
key4 = img4["key"]
for i in range(2):
    status, body, _ = call(
        "POST", "/api/documents", {"title": f"dup{i}", "content": f"![x]({img4['url']})"}, alice
    )
    d = body["document"]["docId"]
    status, _, _ = call("DELETE", f"/api/documents/{d}", None, alice)
    check(f"第 {i + 1} 次删除成功（重复入队不报错）", status == 200, str(status))

# ---------- 等后台任务真的删掉 ----------
print(f"\n等后台回收（最多 {GC_WAIT_SECONDS}s）…")
deadline = time.time() + GC_WAIT_SECONDS
gone = False
while time.time() < deadline:
    if not object_exists(key1):
        gone = True
        break
    time.sleep(5)

check(f"后台任务删掉了 R2 对象（{key1[-20:]}）", gone)
if gone:
    check("被引用过又释放的图也删掉了", not object_exists(key2))
    check("别人的图始终没被删", object_exists(bobs_key))
    rows = queue_rows()
    check("删成功后队列被清空", rows is not None and len(rows) == 0, f"剩余={rows}")

print(f"\nimage gc: {passed} passed, {failed} failed")
sys.exit(0 if failed == 0 else 1)
