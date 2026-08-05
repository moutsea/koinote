#!/usr/bin/env python3
"""验证微信公众号导出：主题内联、公式转图上传、剪贴板富文本。

关键断言是「产物满足微信的约束」——无 <style>、无 class、样式全在 style 属性上。
这些只能在真实浏览器里拿到剪贴板内容后才能检查。
"""
import os
import re
import sys

from playwright.sync_api import sync_playwright

BASE = os.environ.get("PROBE_BASE", "http://localhost:5274")
USER, PASSWORD = "pdfprobe", "Probe!2345"

passed, failed = 0, 0


def check(name, cond, detail=""):
    global passed, failed
    if cond:
        passed += 1
        print(f"  PASS  {name}")
    else:
        failed += 1
        print(f"  FAIL  {name}  {detail}")


def main():
    with sync_playwright() as p:
        b = p.chromium.launch()
        ctx = b.new_context(
            viewport={"width": 1400, "height": 950},
            permissions=["clipboard-read", "clipboard-write"],
        )
        page = ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        uploads = []
        page.on("response",
                lambda r: uploads.append(r.status)
                if "/api/images" in r.url and r.request.method == "POST" else None)

        page.goto(f"{BASE}/login", wait_until="networkidle")
        page.fill('input[autocomplete="username"]', USER)
        page.fill('input[autocomplete="current-password"]', PASSWORD)
        page.click('button[type="submit"]')
        page.wait_for_timeout(3000)
        page.goto(f"{BASE}/editor", wait_until="networkidle")
        page.wait_for_selector(".ProseMirror", timeout=15000)
        page.wait_for_timeout(2000)

        print("\n[1] 写入含公式 / 代码 / 表格 / 引用的内容")
        # 文档是异步加载的：过早输入会被随后到达的持久化内容盖掉。
        # 之前就踩过 —— 断言实际验的是上一次测试留下的旧文档。
        body = page.locator(".ProseMirror")
        page.wait_for_timeout(3000)

        MARKER = "公众号排版测试"

        def write_content():
            body.click()
            page.keyboard.press("Control+A")
            page.keyboard.press("Delete")
            page.keyboard.type(f"# {MARKER}\n")
            page.keyboard.type("正文段落，含 **加粗** 与 *斜体*，行内公式 ")
            page.keyboard.type("$E=mc^2$")
            page.keyboard.type(" 收尾。\n")
            page.keyboard.type("> 这是一段引用\n")
            page.keyboard.press("ArrowDown")
            page.keyboard.type("$$\\frac{a}{b}=c$$\n")
            page.keyboard.type("- 列表一\n- 列表二\n")
            page.keyboard.press("Enter")
            page.keyboard.type("```python\ndef hello():\n    return 1\n")
            page.wait_for_timeout(3000)

        write_content()
        if MARKER not in body.inner_text():
            print("    首次输入被文档加载盖掉，重试一次")
            write_content()

        inner = body.inner_html()
        check("测试内容确实写进了编辑器", MARKER in body.inner_text(),
              body.inner_text()[:80])

        # 上传次数要跟「唯一公式数」比，不能写死。文档里可能残留上一轮的公式，
        # 而且同一段 LaTeX 出现多次只该上传一次（见 wechatMath 的 uploadCache）。
        unique_math = page.evaluate("""() => {
          const pm = document.querySelector('.ProseMirror');
          const keys = new Set();
          for (const n of pm.querySelectorAll(
                 '[data-type="inline-math"],[data-type="block-math"]')) {
            const latex = (n.getAttribute('data-latex') || '').trim();
            if (latex) keys.add(n.getAttribute('data-type') + '::' + latex);
          }
          return keys.size;
        }""")
        print(f"    文档内唯一公式数: {unique_math}")
        # 引用块是否产出取决于编辑器的输入规则，与微信导出无关。
        # 这里如实记录，避免把编辑器的行为误算成导出的缺陷。
        has_bq = "<blockquote" in inner
        print(f"    编辑器产出 blockquote: {has_bq}")

        print("\n[2] 打开导出菜单，确认多了微信项")
        page.click('button[aria-label="Export"], button[aria-label="导出"]')
        page.wait_for_timeout(700)
        items = page.locator('[role="menu"] button')
        labels = [items.nth(i).inner_text() for i in range(items.count())]
        print(f"    菜单项数: {items.count()}")
        check("菜单含 6 项", items.count() == 6, f"got {items.count()}: {labels}")
        idx = next((i for i, l in enumerate(labels)
                    if "wechat" in l.lower() or "微信" in l), None)
        check("找到微信导出项", idx is not None, str(labels))
        if idx is None:
            b.close()
            return 1
        items.nth(idx).click()
        page.wait_for_timeout(900)

        print("\n[3] 主题对话框")
        dialog = page.locator('[role="dialog"]')
        check("对话框已打开", dialog.count() == 1)
        radios = dialog.locator('[role="radio"]')
        print(f"    主题数: {radios.count()}")
        check("有 5 个主题", radios.count() == 5, f"got {radios.count()}")
        check("默认选中第一个",
              radios.nth(0).get_attribute("aria-checked") == "true")

        print("\n[4] 点击复制（公式会上传到 R2）")
        copy_btn = dialog.locator("button").filter(
            has_text=re.compile("Copy|复制", re.I)).first
        copy_btn.click()
        # 公式栅格化 + 上传要时间
        page.wait_for_timeout(12000)

        status = dialog.locator('[role="status"]')
        alert = dialog.locator('[role="alert"]')
        if alert.count():
            print(f"    错误提示: {alert.first.inner_text()[:100]}")
        if status.count():
            print(f"    状态提示: {status.first.inner_text()[:100]}")
        check("没有报错提示", alert.count() == 0,
              alert.first.inner_text()[:80] if alert.count() else "")
        print(f"    /api/images POST 响应: {uploads}")
        # 上界同样要卡。曾经只写 >=2，结果两次导出实际上传了 14 次都没被发现 ——
        # 每次导出重新上传同样的公式，在 R2 里堆同名内容的副本，而且没有
        # images 表可以清理。文档里有 2 个公式，一次导出就该是 2 次。
        check("上传次数等于唯一公式数（不重复上传）",
              len(uploads) == unique_math,
              f"上传 {len(uploads)} 次，唯一公式 {unique_math} 个: {uploads}")
        check("上传全部成功", all(s in (200, 201) for s in uploads), str(uploads))

        print("\n[5] 读剪贴板，检查产物是否满足微信约束")
        html = page.evaluate("""async () => {
          const items = await navigator.clipboard.read();
          for (const item of items) {
            if (item.types.includes('text/html')) {
              const blob = await item.getType('text/html');
              return await blob.text();
            }
          }
          return '';
        }""")
        print(f"    剪贴板 HTML 长度: {len(html)}")
        check("剪贴板有 text/html", len(html) > 200, f"{len(html)} chars")

        # 微信的硬约束
        check("无 <style> 标签", "<style" not in html.lower())
        check("无 <script> 标签", "<script" not in html.lower())
        check("无 class 属性", 'class=' not in html,
              html[html.find('class='):html.find('class=')+60] if 'class=' in html else "")
        check("无 id 属性", ' id=' not in html)
        check("最外层是 section", "<section style=" in html[:200], html[:80])

        # 样式确实内联了
        check("h1 带内联样式",
              re.search(r"<h1 style=\"[^\"]*font-size", html) is not None)
        check("p 带内联样式",
              re.search(r"<p style=\"[^\"]*line-height", html) is not None)
        if has_bq:
            check("blockquote 带内联样式",
                  re.search(r"<blockquote style=\"[^\"]*border-left", html) is not None,
                  "编辑器有 blockquote 但导出没样式")
        else:
            print("  SKIP  blockquote 带内联样式（编辑器未产出 blockquote）")
        check("pre 带内联样式",
              re.search(r"<pre style=\"[^\"]*background", html) is not None)

        # 公式变成了图片，且指向 R2 而非 data URL
        imgs = re.findall(r'<img[^>]*src="([^"]+)"', html)
        print(f"    图片数: {len(imgs)}")
        for u in imgs[:3]:
            print(f"      {u[:70]}")
        check("有公式图片", len(imgs) >= 2, f"got {len(imgs)}")
        check("图片走 URL 而非 data URL",
              all(not u.startswith("data:") for u in imgs), str(imgs[:2])[:120])
        check("图片带显式宽高（否则按 3 倍铺开）",
              all(re.search(r"width:\d+px", m) for m in
                  re.findall(r"<img[^>]*>", html)),
              re.findall(r"<img[^>]*>", html)[:1])

        # 公式占位元素不该残留
        check("无 data-latex 残留", "data-latex" not in html)
        check("无 katex 残留", "katex" not in html.lower())

        print("\n[6] 纯文本格式也要有")
        plain = page.evaluate("() => navigator.clipboard.readText()")
        check("剪贴板有 text/plain", len(plain) > 50, f"{len(plain)} chars")
        check("纯文本是 Markdown", "#" in plain and "```" in plain, plain[:80])

        print("\n[7] 切换主题产出不同样式")
        radios.nth(2).click()
        page.wait_for_timeout(400)
        copy_btn.click()
        page.wait_for_timeout(12000)
        html2 = page.evaluate("""async () => {
          const items = await navigator.clipboard.read();
          for (const item of items) {
            if (item.types.includes('text/html')) {
              return await (await item.getType('text/html')).text();
            }
          }
          return '';
        }""")
        check("换主题后 HTML 不同", html2 != html and len(html2) > 200)
        # 切主题只影响样式，公式图不该重新上传
        check("切主题未触发重复上传", len(uploads) == unique_math,
              f"切主题后累计 {len(uploads)} 次，唯一公式 {unique_math} 个")
        check("第三个主题是科技蓝", "#0b62d0" in html2, html2[:200])

        print("\n[8] JS 报错")
        real = [e for e in errors if "clipboard" not in e.lower()]
        check("无未捕获异常", not real, "; ".join(real[:2]))

        b.close()

    print(f"\n{'=' * 46}\n{passed} passed, {failed} failed\n{'=' * 46}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
