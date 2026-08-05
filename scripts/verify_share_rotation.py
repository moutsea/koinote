#!/usr/bin/env python3
"""验证放宽分享权限时老链接确实失效。

单元测试只能证明判定函数对，证明不了「那个 URL 真的打不开了」。
这里走真实 HTTP：设口令 → 改为无口令 → 拿老 token 再请求一次。
"""
import json
import os
import sys
import urllib.error
import urllib.request

from playwright.sync_api import sync_playwright

BASE = os.environ.get("PROBE_BASE", "http://localhost:5273")
USER, PASSWORD = "pdfprobe", "Probe!2345"
SHARE_PW = "secret123"

passed, failed = 0, 0


def check(name, cond, detail=""):
    global passed, failed
    if cond:
        passed += 1
        print(f"  PASS  {name}")
    else:
        failed += 1
        print(f"  FAIL  {name}  {detail}")


def request(path, method="GET", body=None, cookie=""):
    """返回 (status, json_or_text)。不抛异常，方便断言 4xx。"""
    req = urllib.request.Request(
        f"{BASE}{path}", method=method,
        data=json.dumps(body).encode() if body is not None else None,
    )
    if body is not None:
        req.add_header("Content-Type", "application/json")
    if cookie:
        req.add_header("Cookie", cookie)
    try:
        with urllib.request.urlopen(req) as r:
            raw = r.read().decode()
            try:
                return r.status, json.loads(raw)
            except json.JSONDecodeError:
                return r.status, raw
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            return e.code, json.loads(raw)
        except json.JSONDecodeError:
            return e.code, raw


def main():
    with sync_playwright() as p:
        b = p.chromium.launch()
        page = b.new_context(viewport={"width": 1400, "height": 900}).new_page()
        page.goto(f"{BASE}/login", wait_until="networkidle")
        page.fill('input[autocomplete="username"]', USER)
        page.fill('input[autocomplete="current-password"]', PASSWORD)
        page.click('button[type="submit"]')
        page.wait_for_timeout(3000)
        page.goto(f"{BASE}/editor", wait_until="networkidle")
        page.wait_for_selector(".ProseMirror", timeout=15000)
        page.wait_for_timeout(2000)

        print("\n[1] 分享对话框只剩两档")
        body = page.locator(".ProseMirror")
        body.click()
        page.keyboard.press("Control+A")
        page.keyboard.press("Delete")
        page.keyboard.type("# 机密内容\n这行字不该在无口令时被读到。\n")
        page.wait_for_timeout(2500)

        page.click('button[aria-label="Share"], button[aria-label="分享"]')
        page.wait_for_timeout(800)
        opts = page.locator('[role="dialog"] button, .fixed button')
        dialog_text = page.locator("body").inner_text()
        check("界面无「公开」档", "公开" not in dialog_text and "Public" not in dialog_text,
              "public 档应已删除")

        doc_id = page.url.rstrip("/").split("/")[-1]
        cookies = page.context.cookies()
        cookie = "; ".join(f"{c['name']}={c['value']}" for c in cookies)
        print(f"    docId={doc_id}")
        page.keyboard.press("Escape")

        print("\n[2] 设为口令档")
        st, res = request(f"/api/documents/{doc_id}/share", "POST",
                          {"access": "password", "password": SHARE_PW}, cookie)
        check("设置成功", st == 200, f"{st} {res}")
        share = res.get("share", {}) if isinstance(res, dict) else {}
        old_token = share.get("token")
        check("返回 token", bool(old_token), str(share))
        check("首次设置不算轮换", share.get("tokenRotated") is False,
              f"tokenRotated={share.get('tokenRotated')}")

        st, res = request(f"/api/share/{old_token}")
        check("匿名访问只拿到 requiresPassword 标志",
              st == 200 and res == {"requiresPassword": True}, f"{st} {res}")

        print("\n[3] 改口令（仍是口令档）→ token 不应变")
        st, res = request(f"/api/documents/{doc_id}/share", "POST",
                          {"access": "password", "password": "another123"}, cookie)
        same = res.get("share", {}).get("token")
        check("同档改口令复用 token", same == old_token, f"{same} vs {old_token}")
        check("未标记轮换", res.get("share", {}).get("tokenRotated") is False)

        print("\n[4] 放宽为链接档 → 必须换 token（本次修复的核心）")
        st, res = request(f"/api/documents/{doc_id}/share", "POST",
                          {"access": "link"}, cookie)
        new_share = res.get("share", {})
        new_token = new_share.get("token")
        check("请求成功", st == 200, f"{st} {res}")
        check("token 已更换", new_token and new_token != old_token,
              f"new={new_token} old={old_token}")
        check("标记了 tokenRotated", new_share.get("tokenRotated") is True,
              f"tokenRotated={new_share.get('tokenRotated')}")

        print("\n[5] 老链接必须失效 —— 这条是漏洞是否真被修掉的判据")
        st, res = request(f"/api/share/{old_token}")
        check("老 token 返回 404", st == 404, f"实际 {st} {res}")
        check("老 token 拿不到正文",
              not (isinstance(res, dict) and "content" in res), str(res)[:120])

        print("\n[6] 新链接可正常读取")
        st, res = request(f"/api/share/{new_token}")
        check("新 token 返回 200", st == 200, f"{st}")
        check("正文完整", isinstance(res, dict) and "机密内容" in json.dumps(
            res, ensure_ascii=False), str(res)[:120])

        print("\n[7] 收紧权限（链接→口令）应复用 token")
        st, res = request(f"/api/documents/{doc_id}/share", "POST",
                          {"access": "password", "password": SHARE_PW}, cookie)
        tightened = res.get("share", {})
        check("收紧时复用 token", tightened.get("token") == new_token,
              f"{tightened.get('token')} vs {new_token}")
        check("收紧不标记轮换", tightened.get("tokenRotated") is False)
        st, res = request(f"/api/share/{new_token}")
        check("同一链接现在要口令", res == {"requiresPassword": True}, str(res)[:80])

        print("\n[8] 存量 public 仍被接受并归一为 link")
        st, res = request(f"/api/documents/{doc_id}/share", "POST",
                          {"access": "public"}, cookie)
        check("public 不报错（老页面兼容）", st == 200, f"{st} {res}")
        check("回报为 link", res.get("share", {}).get("access") == "link",
              f"access={res.get('share', {}).get('access')}")

        print("\n[9] 非法档位仍应拒绝")
        st, res = request(f"/api/documents/{doc_id}/share", "POST",
                          {"access": "linkk"}, cookie)
        check("拼错的档位返回 400", st == 400, f"实际 {st}")

        b.close()

    print(f"\n{'=' * 46}\n{passed} passed, {failed} failed\n{'=' * 46}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
