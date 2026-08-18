#!/usr/bin/env python3
"""验证三种下载格式，重点是公式在各格式里是否真的落地。

起因：@tiptap/extension-mathematics 的 renderHTML 只输出带 data-latex 的空元素，
公式的可见形态由编辑器内的 nodeview 提供。导出走 getHTML()，拿不到 nodeview，
所以 HTML 导出里公式位置原本是空白 —— 静默丢内容。
"""
import os
import re
import sys
import tempfile
import zipfile
from pathlib import Path

from playwright.sync_api import sync_playwright

BASE = os.environ.get("PROBE_BASE", "http://localhost:5274")
USER, PASSWORD = "pdfprobe", "Probe!2345"
TMP = Path(tempfile.gettempdir())

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
        ctx = b.new_context(accept_downloads=True, viewport={"width": 1400, "height": 900})
        page = ctx.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))

        page.goto(f"{BASE}/login", wait_until="networkidle")
        page.fill('input[autocomplete="username"]', USER)
        page.fill('input[autocomplete="current-password"]', PASSWORD)
        page.click('button[type="submit"]')
        page.wait_for_timeout(3000)
        page.goto(f"{BASE}/editor", wait_until="networkidle")
        page.wait_for_selector(".ProseMirror", timeout=15000)
        page.wait_for_timeout(1500)

        print("\n[1] 写入含公式的内容")
        # 文档是异步加载的：过早输入会被随后到达的持久化内容盖掉，
        # 断言就变成在验上一次测试留下的旧文档 —— 曾经因此出现过偶发失败。
        body = page.locator(".ProseMirror")
        page.wait_for_timeout(3000)

        MARKER = "公式落地测试"

        def write_content():
            body.click()
            page.keyboard.press("Control+A")
            page.keyboard.press("Delete")
            page.keyboard.type(f"# {MARKER}\n")
            page.keyboard.type("行内公式 ")
            page.keyboard.type("$E=mc^2$")
            page.keyboard.type(" 之后是块级：\n")
            page.keyboard.type("$$\\frac{a}{b}=c$$\n")
            page.keyboard.type("表格与代码也要在：\n")
            page.keyboard.type("```js\nconst x = 1;\n")
            page.wait_for_timeout(3000)

        write_content()
        if MARKER not in body.inner_text():
            print("    首次输入被文档加载盖掉，重试一次")
            write_content()

        check("测试内容确实写进了编辑器", MARKER in body.inner_text(),
              body.inner_text()[:80])

        html_in_editor = body.inner_html()
        check("编辑器内公式已渲染", "katex" in html_in_editor)

        def export_via_menu(match: str) -> Path:
            page.click('button[aria-label="Export"], button[aria-label="导出"]')
            page.wait_for_timeout(500)
            items = page.locator('[role="menu"] button')
            labels = [items.nth(i).inner_text() for i in range(items.count())]
            idx = next(i for i, l in enumerate(labels) if match.lower() in l.lower())
            with page.expect_download(timeout=120000) as dl:
                items.nth(idx).click()
            d = dl.value
            out = TMP / d.suggested_filename
            d.save_as(out)
            return out

        print("\n[2] Markdown")
        md = export_via_menu(".md")
        text = md.read_text(encoding="utf-8")
        check("公式以 $ 语法保存", "$E=mc^2$" in text, repr(text[:120]))
        check("块级公式用 $$", "$$" in text)
        check("代码块围栏保留", "```" in text)

        print("\n[3] HTML")
        html_file = export_via_menu(".html")
        h = html_file.read_text(encoding="utf-8")
        # 这是修掉的那个 bug：过去这里只有 data-latex 空元素
        check("HTML 里公式已渲染成 KaTeX", "katex" in h,
              "只有 data-latex 空元素说明公式丢了")
        check("KaTeX 样式表已引用", "katex.min.css" in h)
        check("公式源码仍在（data-latex 保留）", "data-latex" in h)
        check("代码高亮类保留", "hljs" in h or "<pre" in h)
        check("HTML 自包含（含 doctype 与内联样式）",
              h.startswith("<!doctype html>") and "<style>" in h)

        print("\n[4] DOCX")
        docx = export_via_menu(".docx")
        check("DOCX 是合法 zip", zipfile.is_zipfile(docx))
        with zipfile.ZipFile(docx) as z:
            names = z.namelist()
            doc = z.read("word/document.xml").decode("utf-8")
        check("含 document.xml", "word/document.xml" in names)
        check("中文正确落进 XML", "公式落地测试" in doc)
        # 公式在 DOCX 里保留为 LaTeX 源码（Word 的 OMML 转换不在范围内）
        check("公式以 LaTeX 源码保留", "E=mc^2" in doc, "公式内容丢失")

        print("\n[5] JS 报错")
        check("无未捕获异常", not errors, "; ".join(errors[:2]))

        b.close()

    print(f"\n{'=' * 46}\n{passed} passed, {failed} failed\n{'=' * 46}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
