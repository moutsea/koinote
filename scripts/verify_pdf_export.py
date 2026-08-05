#!/usr/bin/env python3
"""在真实浏览器里验证一键 PDF 导出。

curl 只能验协议层，验不了「点了导出按钮之后浏览器到底下载了什么」。
这个脚本走完整链路：登录 → 建文档 → 输入含公式/代码/表格的内容 →
点导出 → 抓下载文件 → 解析 PDF 结构。
"""
import re
import subprocess
import sys
import tempfile
from pathlib import Path

from playwright.sync_api import sync_playwright

import os
BASE = os.environ.get("PROBE_BASE", "http://localhost:5273")
USER = "pdfprobe"
PASSWORD = "Probe!2345"

passed, failed = 0, 0
console_errors: list[str] = []


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
        browser = p.chromium.launch()
        context = browser.new_context(accept_downloads=True, viewport={"width": 1400, "height": 900})
        page = context.new_page()
        page.on("console", lambda m: console_errors.append(m.text) if m.type == "error" else None)
        page.on("pageerror", lambda e: console_errors.append(f"pageerror: {e}"))
        fetched_js: list[str] = []
        page.on("response",
                lambda r: fetched_js.append(r.url.split("/")[-1])
                if r.url.endswith(".js") else None)

        print("\n[1] 注册/登录")
        # 表单用 autoComplete 而非 name 属性标识字段
        page.goto(f"{BASE}/register", wait_until="networkidle")
        try:
            page.fill('input[autocomplete="username"]', USER, timeout=8000)
            page.fill('input[autocomplete="email"]', f"{USER}@example.com", timeout=8000)
            page.fill('input[autocomplete="new-password"]', PASSWORD, timeout=8000)
            confirm = page.locator('input[autocomplete="new-password"]')
            if confirm.count() > 1:
                confirm.nth(1).fill(PASSWORD)
            page.click('button[type="submit"]')
            page.wait_for_timeout(3000)
        except Exception as exc:
            print(f"    注册跳过（可能已存在）: {str(exc)[:80]}")

        if "/editor" not in page.url:
            page.goto(f"{BASE}/login", wait_until="networkidle")
            page.fill('input[autocomplete="username"]', USER, timeout=8000)
            page.fill('input[autocomplete="current-password"]', PASSWORD, timeout=8000)
            page.click('button[type="submit"]')
            page.wait_for_timeout(3000)

        check("登录成功", "/dashboard" in page.url or "/editor" in page.url, f"url={page.url}")

        # 登录后落在 dashboard，需要新建文档才进编辑器
        if "/editor" not in page.url:
            page.goto(f"{BASE}/editor", wait_until="networkidle")
            page.wait_for_timeout(2000)

        check("进入编辑器", "/editor" in page.url, f"url={page.url}")
        if "/editor" not in page.url:
            page.screenshot(path="/tmp/pdf_probe_login_fail.png")
            print("    截图: /tmp/pdf_probe_login_fail.png")
            browser.close()
            return

        print("\n[2] 输入含公式 / 代码 / 表格的内容")
        page.wait_for_selector(".ProseMirror", timeout=15000)
        body = page.locator(".ProseMirror")
        body.click()
        page.keyboard.press("Control+A")
        page.keyboard.press("Delete")

        # 标题栏
        title_input = page.locator('input[type="text"]').first
        try:
            title_input.fill("导出验证：数学与代码")
        except Exception:
            pass

        body.click()
        page.keyboard.type("# 一级标题 中文测试\n")
        page.keyboard.type("普通段落，含 **粗体** 与 *斜体*，还有行内公式 ")
        page.keyboard.type("$E=mc^2$")
        page.keyboard.type(" 收尾。\n")
        page.keyboard.type("价格是 $100 和 $200，不该被当成公式。\n")
        page.keyboard.type("$$\\int_0^\\infty e^{-x^2}dx = \\frac{\\sqrt{\\pi}}{2}$$\n")
        page.keyboard.type("- 列表项一\n- 列表项二\n")
        page.keyboard.press("Enter")
        page.keyboard.type("```python\ndef hello():\n    return '你好'\n")
        page.wait_for_timeout(1500)

        # 内容够长才能触发多页
        body.click()
        page.keyboard.press("Control+End")
        page.keyboard.press("Enter")
        for i in range(40):
            page.keyboard.type(f"第 {i + 1} 段填充文字，用来把文档撑到多页，验证分页逻辑。\n")
        page.wait_for_timeout(2500)

        html = body.inner_html()
        check("行内公式已渲染 KaTeX", "katex" in html, "编辑器内应有 katex 类")
        check("代码块已高亮", "hljs" in html or "<pre" in html)

        print("\n[3] 点击导出 → PDF")
        # 打开导出菜单
        # 用 aria-label 定位，不依赖界面语言
        page.click('button[aria-label="Export"], button[aria-label="导出"]')
        page.wait_for_timeout(600)
        page.screenshot(path="/tmp/pdf_probe_menu.png")

        items = page.locator('[role="menu"] button')
        labels = [items.nth(i).inner_text().strip() for i in range(items.count())]
        print(f"    菜单项: {labels}")
        check("菜单含 5 项（4 格式 + 打印）", items.count() == 5, f"got {items.count()}")

        # PDF 项是唯一含 "PDF" 且不含 Print/打印 的项
        pdf_index = next(
            (i for i, label in enumerate(labels)
             if "PDF" in label.upper()
             and "PRINT" not in label.upper()
             and "打印" not in label),
            None,
        )
        check("找到一键 PDF 项", pdf_index is not None, f"labels={labels}")
        if pdf_index is None:
            browser.close()
            return 1

        with page.expect_download(timeout=120000) as dl:
            items.nth(pdf_index).click()
        download = dl.value

        out = Path(tempfile.gettempdir()) / "koinote_export.pdf"
        download.save_as(out)
        print(f"    建议文件名: {download.suggested_filename}")
        print(f"    落盘: {out}  ({out.stat().st_size} bytes)")

        check("文件名用文档标题", download.suggested_filename.endswith(".pdf")
              and "koinote" not in download.suggested_filename.lower(),
              download.suggested_filename)
        check("PDF 非空", out.stat().st_size > 10_000, f"{out.stat().st_size} bytes")

        print("\n[4] 解析 PDF")
        raw = out.read_bytes()
        check("PDF 魔数正确", raw[:5] == b"%PDF-", repr(raw[:8]))

        import pypdf
        reader = pypdf.PdfReader(str(out))
        n = len(reader.pages)
        print(f"    页数: {n}")
        check("多页文档确实分了多页", n >= 2, f"got {n}")

        page0 = reader.pages[0]
        w = float(page0.mediabox.width)
        h = float(page0.mediabox.height)
        print(f"    首页尺寸: {w:.1f} x {h:.1f} pt")
        check("A4 宽度 (595pt±2)", abs(w - 595.28) < 2, f"{w}")
        check("A4 高度 (842pt±2)", abs(h - 841.89) < 2, f"{h}")

        # 栅格方案下每页应有一张图
        images = page0.images
        print(f"    首页嵌入图片数: {len(images)}")
        check("每页含栅格图", len(images) >= 1)
        if images:
            img = images[0]
            check("图片分辨率符合 2 倍栅格", img.image.width > 1200,
                  f"width={img.image.width}")
            img.image.save("/tmp/pdf_probe_page1.png")
            print("    首页位图导出: /tmp/pdf_probe_page1.png")

        # 页码是矢量文字，应该能抽出来
        text = page0.extract_text() or ""
        check("页码文字存在", re.search(r"1\s*/\s*\d+", text) is not None,
              f"extracted={text[:60]!r}")

        print("\n[4b] 分页填充率")
        import re as _re
        heights = []
        for pg in reader.pages:
            stream = pg.get_contents().get_data().decode("latin-1")
            names = _re.findall(r"/(I\d+)\s+Do", stream)
            xo = reader.pages[0]["/Resources"]["/XObject"].get_object()
            for nm in names:
                heights.append(int(xo[f"/{nm}"].get_object().get("/Height")))
        full = 1123 * 2
        fill = [h / full for h in heights]
        print(f"    各页填充率: {[f'{f:.0%}' for f in fill]}")
        # 末页可以不满；其余页低于 60% 说明提前断页浪费了空间
        wasteful = [f"p{i+1}={f:.0%}" for i, f in enumerate(fill[:-1]) if f < 0.6]
        check("非末页无大面积空白", not wasteful, f"偏低: {wasteful}")
        check("每页各引用一张位图", len(heights) == len(reader.pages),
              f"{len(heights)} vs {len(reader.pages)}")

        kb_per_page = out.stat().st_size / 1024 / len(reader.pages)
        print(f"    体积: {out.stat().st_size/1024/1024:.2f} MB "
              f"({kb_per_page:.0f} KB/页)")
        # 阈值取自实测：2 倍栅格下正文约 650 KB/页、高亮代码约 710 KB/页。
        # 定在 900 是为了抓真实回退（比如倍率被误调高），不是许愿。
        check("单页体积在实测区间内 (<900KB)", kb_per_page < 900,
              f"{kb_per_page:.0f} KB/页")

        print("\n[5] 按需加载的 chunk")
        export_chunks = [n for n in fetched_js
                         if any(k in n.lower() for k in
                                ("jspdf", "html2canvas", "purify", "exportpdf"))]
        print(f"    导出相关 chunk: {sorted(set(export_chunks))}")
        check("jsPDF 已按需加载",
              any("jspdf" in n.lower() for n in export_chunks))
        check("html2canvas-pro 已按需加载",
              any("html2canvas-pro" in n.lower() for n in export_chunks))
        check("未调用的 jsPDF html() 依赖没有被下载",
              not any(("purify" in n.lower()) or
                      ("html2canvas.esm" in n.lower()) for n in export_chunks),
              f"多下载了 {[n for n in export_chunks if 'purify' in n.lower() or 'html2canvas.esm' in n.lower()]}")

        print("\n[6] 控制台错误")
        # 401 = 登录前的 session 探测；409 = 账号已存在（重复跑脚本）。
        # 两者都是本脚本流程的正常产物，不是被测代码的缺陷。
        ignorable = ("favicon", "401", "409")
        real = [e for e in console_errors
                if not any(k in e.lower() for k in ignorable)]
        check("无 JS 报错", not real, "; ".join(real[:3]))

        browser.close()

    print(f"\n{'=' * 46}\n{passed} passed, {failed} failed\n{'=' * 46}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
