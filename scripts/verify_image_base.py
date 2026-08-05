#!/usr/bin/env python3
"""在真实 workerd 里验证 IMAGE_PUBLIC_BASE 的校验与自查端点。

分两层的理由：纯函数的边界情况（末尾斜杠、子路径、查询串、大写 scheme 等）
由 scripts/_check_image_base.mjs 在 Node 里覆盖，快且不必起 workerd。
这一层只确认「端点在真实运行时里确实按预期回应」—— Node 那层验的是函数，
验不了路由是否挂对、env 是否读到、响应结构是否正确。

注：曾以为 workerd 的 URL 会把无 scheme 的输入静默补成 https://（那样 try/catch
校验就会在线上失效），实测否定了这个猜想 —— workerd 与 Node 一样抛 TypeError。
"""
import json
import re
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

CONFIG = Path("wrangler.jsonc")
PORT = 8799  # 避开 8788，不干扰正在跑的开发用 wrangler
URL = f"http://localhost:{PORT}/api/images/config"

# 只放平台行为有分歧的：缺 scheme 的几种写法。
# workerd 会把它们补成 https://，必须被判为无效。
CASES = [
    ("img.example.com", False, "worker-proxy", None),
    ("img.example.com/", False, "worker-proxy", None),
    ("//img.example.com", False, "worker-proxy", None),
    # 一条合法的做对照，确认端点本身工作正常
    ("https://img.example.com", True, "cdn", "https://img.example.com"),
]

passed = failed = 0


def check(name, cond, detail=""):
    global passed, failed
    if cond:
        passed += 1
    else:
        failed += 1
        print(f"  FAIL  {name}  {detail}")


def set_base(value: str) -> None:
    text = CONFIG.read_text()
    new = re.sub(r'("IMAGE_PUBLIC_BASE":\s*)"[^"]*"',
                 lambda m: m.group(1) + json.dumps(value), text)
    assert new != text or json.dumps(value) in text, "wrangler.jsonc 替换失败"
    CONFIG.write_text(new)


def fetch(timeout_s: int = 40):
    deadline = time.time() + timeout_s
    last = None
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(URL, timeout=3) as r:
                return json.loads(r.read().decode())
        except Exception as exc:  # noqa: BLE001
            last = exc
            time.sleep(1)
    raise RuntimeError(f"worker 未就绪: {last}")


def main() -> int:
    # 备份取自 git HEAD 而非工作区：上次运行若中断，工作区里可能残留测试值，
    # 从工作区备份会把错误值当原值还原回去。踩过一次。
    original = subprocess.run(
        ["git", "show", f"HEAD:{CONFIG.as_posix()}"],
        capture_output=True, text=True, check=True,
    ).stdout

    try:
        for value, want_valid, want_mode, want_base in CASES:
            set_base(value)
            # 每个用例重起一次 wrangler。热重载在某些值上会崩，
            # 而且重启才能保证读到的是当前配置而非上一轮的残留。
            proc = subprocess.Popen(
                ["npx", "wrangler", "dev", "--port", str(PORT), "--local"],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
            try:
                got = fetch()
                label = repr(value)
                check(f"{label} valid", got.get("valid") is want_valid,
                      f"got valid={got.get('valid')} base={got.get('base')!r}")
                check(f"{label} mode", got.get("mode") == want_mode,
                      f"got {got.get('mode')}")
                check(f"{label} base", got.get("base") == want_base,
                      f"got {got.get('base')!r}")
                want_warning = bool(value.strip()) and not want_valid
                check(f"{label} warning", (got.get("warning") is not None) == want_warning,
                      f"got {got.get('warning')!r}")
                flag = "OK " if got.get("valid") is want_valid else "BAD"
                print(f"  {flag} {label:24} → mode={got.get('mode'):13} "
                      f"valid={got.get('valid')} base={got.get('base')!r}")
            finally:
                proc.terminate()
                try:
                    proc.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    proc.kill()
    finally:
        CONFIG.write_text(original)
        restored = re.search(r'"IMAGE_PUBLIC_BASE":\s*"([^"]*)"', original)
        print(f"\nwrangler.jsonc 已还原（IMAGE_PUBLIC_BASE="
              f"{restored.group(1)!r}）" if restored else "\nwrangler.jsonc 已还原")

    print(f"\n{'=' * 46}\n{passed} passed, {failed} failed\n{'=' * 46}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
