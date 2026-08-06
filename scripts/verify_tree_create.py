#!/usr/bin/env python3
"""验证右键新建所依赖的两个服务端改动。

1. POST /api/documents 接受 folderId，一次请求就把文档建进文件夹
2. POST /api/folders 有深度上限（这条之前只在 move 上有，create 能绕过去）

顺带确认越权：传别人的 folderId 时不该报外键错误，也不该挂到别人的树上。
"""

import json
import pathlib
import re
import secrets
import sys
import urllib.error
import urllib.request

BASE = "http://localhost:8090"
ROOT = pathlib.Path(__file__).resolve().parent.parent


def read_const(path, pattern):
    m = re.search(pattern, (ROOT / path).read_text())
    return int(m.group(1)) if m else None


# 前后端各有一份深度上限：Go 那份是真正的约束，SPA 那份只用来把菜单项置灰。
# 两边漂开的话，表现是菜单还能点、点了报错 —— 从界面上看像是后端出问题
GO_DEPTH = read_const(
    "backend/internal/server/folders.go", r"maxFolderDepth\s*=\s*(\d+)"
)
SPA_DEPTH = read_const(
    "spa/src/components/editor/tree.ts", r"MAX_FOLDER_DEPTH\s*=\s*(\d+)"
)
MAX_DEPTH = GO_DEPTH

passed = 0
failed = 0


def check(label, cond, detail=""):
    global passed, failed
    if cond:
        passed += 1
    else:
        failed += 1
        print(f"FAIL  {label}" + (f" — {detail}" if detail else ""))


def call(method, path, body=None, cookie=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f"{BASE}{path}", data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if cookie:
        req.add_header("Cookie", cookie)
    try:
        with urllib.request.urlopen(req) as resp:
            set_cookie = resp.headers.get("Set-Cookie", "")
            return resp.status, json.loads(resp.read() or b"{}"), set_cookie
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}"), ""


def register():
    tag = secrets.token_hex(6)
    status, body, set_cookie = call(
        "POST",
        "/api/auth/register",
        {
            "username": f"u{tag}",
            "email": f"u{tag}@example.com",
            "password": "password123",
        },
    )
    if status != 200:
        print(f"register failed: {status} {body}")
        sys.exit(1)
    return set_cookie.split(";")[0]


check("读到 Go 的深度上限", GO_DEPTH is not None)
check("读到 SPA 的深度上限", SPA_DEPTH is not None)
check(
    "前后端深度上限一致",
    GO_DEPTH == SPA_DEPTH,
    f"go={GO_DEPTH} spa={SPA_DEPTH}",
)
if MAX_DEPTH is None:
    print("\n读不到 maxFolderDepth，后面的深度检查没法做")
    sys.exit(1)

alice = register()
bob = register()

# ---------- 文档直接建进文件夹 ----------
status, body, _ = call("POST", "/api/folders", {"name": "inbox", "parentFolderId": None}, alice)
check("建文件夹", status == 200, f"{status} {body}")
inbox = body.get("folder", {}).get("folderId")

status, body, _ = call("POST", "/api/documents", {"folderId": inbox}, alice)
check("带 folderId 建文档", status == 200, f"{status} {body}")
doc_id = body.get("document", {}).get("docId")

status, body, _ = call("GET", "/api/documents", None, alice)
listed = {d["docId"]: d.get("folderId") for d in body.get("documents", [])}
check("文档落在指定文件夹里", listed.get(doc_id) == inbox, f"got {listed.get(doc_id)}")

# 不带 folderId 仍应落在根下
status, body, _ = call("POST", "/api/documents", {}, alice)
root_doc = body.get("document", {}).get("docId")
status, body, _ = call("GET", "/api/documents", None, alice)
listed = {d["docId"]: d.get("folderId") for d in body.get("documents", [])}
check("不带 folderId 落在根下", listed.get(root_doc) is None, f"got {listed.get(root_doc)}")

# ---------- 越权：传别人的 folderId ----------
status, body, _ = call("POST", "/api/documents", {"folderId": inbox}, bob)
check("传他人 folderId 不报错", status == 200, f"{status} {body}")
bobs_doc = body.get("document", {}).get("docId")
status, body, _ = call("GET", "/api/documents", None, bob)
listed = {d["docId"]: d.get("folderId") for d in body.get("documents", [])}
check("传他人 folderId 落到自己根下", listed.get(bobs_doc) is None, f"got {listed.get(bobs_doc)}")

status, body, _ = call("POST", "/api/folders", {"name": "x", "parentFolderId": inbox}, bob)
check("传他人 parentFolderId 不报错", status == 200, f"{status} {body}")
check(
    "传他人 parentFolderId 落到自己根下",
    body.get("folder", {}).get("parentFolderId") is None,
    f"got {body.get('folder', {}).get('parentFolderId')}",
)

# 不存在的 folderId 同样落到根下，而不是 500
status, body, _ = call("POST", "/api/documents", {"folderId": "nope-not-a-real-id"}, alice)
check("不存在的 folderId 不报错", status == 200, f"{status} {body}")

# ---------- 深度上限 ----------
parent = None
depth_ok = True
for level in range(1, MAX_DEPTH + 1):
    status, body, _ = call(
        "POST", "/api/folders", {"name": f"L{level}", "parentFolderId": parent}, alice
    )
    if status != 200:
        check(f"建到第 {level} 层", False, f"{status} {body}")
        depth_ok = False
        break
    parent = body["folder"]["folderId"]
check(f"能建到第 {MAX_DEPTH} 层", depth_ok)

if depth_ok:
    status, body, _ = call(
        "POST", "/api/folders", {"name": "overflow", "parentFolderId": parent}, alice
    )
    check(f"第 {MAX_DEPTH + 1} 层被挡", status == 400, f"{status} {body}")
    check("挡下时带 too_deep 码", body.get("code") == "too_deep", f"got {body.get('code')}")

    # 深度只约束文件夹，最深一层里仍应能放文档
    status, body, _ = call("POST", "/api/documents", {"folderId": parent}, alice)
    check("最深层里仍能建文档", status == 200, f"{status} {body}")

print(f"\ntree create: {passed} passed, {failed} failed")
sys.exit(0 if failed == 0 else 1)
