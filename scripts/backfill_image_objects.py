#!/usr/bin/env python3
"""把存量 R2 对象补进 image_objects 账本。

为什么需要它：图片记账的 SQL 一直有类型推导错误（见 image_quota.go 的注释），
所以 image_objects 长期是空表 —— 图片体积完全不计入配额。修好之后新上传会记账，
但**存量对象不会追溯**，用量仍然只显示文档正文那一部分。

做法：扫所有文档正文里的图片 key（用与后端 image_keys.go 相同的正则与归属规则）
→ 对每个 key 向 Worker 发 HEAD 拿 content-length → 插进 image_objects。

只补、不删、不改已有行：
  · 已在账本里的 key 跳过（ON CONFLICT DO NOTHING 的语义，这里显式跳过好报数）
  · R2 里不存在的 key 跳过并报出来 —— 那是正文引用了已被删除的对象，
    往账本里塞一个不存在的对象会让用量虚高，而且永远没人来纠正
  · 不碰 documents 表

有意不做的事：**扫不到孤儿对象**。R2 里可能存在已经不被任何文档引用的图
（删过的图片、上传后没保存的），扫正文永远看不到它们，那部分不会入账。
要覆盖它们得列举 R2 的全部对象，那需要 Worker 侧再加一个列举端点 ——
而孤儿对象本来就该由回收任务删掉，不该长期计费。

默认 dry-run，加 --apply 才真写。
"""

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request

# 与后端 image_keys.go 的 imageKeyPattern 保持一致。
#
# 刻意抄一份而不是想办法共享：这是个一次性脚本，跨语言共享正则要么引一层
# 代码生成，要么把正则挪到配置文件里 —— 两者都为了一次性脚本改动生产代码。
# 代价是两处可能漂移，所以下面有一条自检：直接读 Go 源码比对。
KEY_PATTERN = re.compile(r"u/([A-Za-z0-9_-]{1,128})/([0-9a-f]{8,64})\.(png|jpg|gif|webp)")

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def check_pattern_matches_backend() -> None:
    """确认这里的正则与 Go 那边没漂移。

    不做这一步的话，Go 侧加了新扩展名（比如 jpeg）而这里没加，回填会静默漏掉
    那一类对象 —— 而"漏了一部分"比"整个没跑"更难发现。
    """
    go_src = os.path.join(REPO_ROOT, "backend/internal/server/image_keys.go")
    with open(go_src, encoding="utf-8") as f:
        src = f.read()
    m = re.search(r"imageKeyPattern = regexp\.MustCompile\(`([^`]+)`\)", src)
    if not m:
        sys.exit("✗ 在 image_keys.go 里找不到 imageKeyPattern，脚本需要跟着更新")
    if m.group(1) != KEY_PATTERN.pattern:
        sys.exit(
            "✗ 正则与后端不一致，回填可能漏掉或多算对象\n"
            f"  后端: {m.group(1)}\n"
            f"  本脚本: {KEY_PATTERN.pattern}"
        )


def psql(dsn_args: list[str], sql: str) -> str:
    """跑一条 SQL 并返回 stdout。走 docker compose exec，不引 psycopg。"""
    import subprocess

    cmd = [
        "docker", "compose", "exec", "-T", "postgres",
        "psql", "-U", dsn_args[0], "-d", dsn_args[1], "-tAc", sql,
    ]
    r = subprocess.run(cmd, capture_output=True, text=True, cwd=REPO_ROOT)
    if r.returncode != 0:
        sys.exit(f"✗ psql 失败: {r.stderr.strip()}")
    return r.stdout


def head_size(base: str, key: str, timeout: float) -> int | None:
    """HEAD 一个对象拿 content-length。不存在返回 None。

    用 HEAD 而不是 GET：只需要大小，不必把几百 KB 的图拉下来。
    Worker 的 handleImageGet 专门支持 HEAD（CDN 与浏览器用它做缓存校验）。
    """
    req = urllib.request.Request(f"{base}/images/{key}", method="HEAD")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            length = resp.headers.get("content-length")
            return int(length) if length else None
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise
    except (urllib.error.URLError, TimeoutError) as e:
        sys.exit(f"✗ 连不上 {base} —— wrangler 起了吗？（{e}）")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--base", default="http://127.0.0.1:8788",
                    help="Worker 基址（默认本地 wrangler dev）")
    ap.add_argument("--db-user", default="koinote")
    ap.add_argument("--db-name", default="koinote")
    ap.add_argument("--timeout", type=float, default=15.0)
    ap.add_argument("--apply", action="store_true", help="真的写入（默认只预演）")
    args = ap.parse_args()

    check_pattern_matches_backend()
    db = [args.db_user, args.db_name]

    # 每个用户的 (id, authUserId, 正文合并)。
    #
    # 不能按行拆 psql 的输出：正文是 Markdown，里面全是换行，一条数据库记录会横跨
    # 几十行输出，splitlines() 一拆就全错位 —— 第一版就栽在这里，结果是「扫到 0 个
    # 对象」而不是报错，比崩掉更难发现。
    #
    # 改成让 Postgres 直接吐 JSON：整个结果是一行，换行都在 JSON 字符串里转义好了。
    raw = psql(db, """
        SELECT COALESCE(json_agg(json_build_object(
                 'user_id', t.id,
                 'auth_user_id', t.auth_user_id,
                 'content', t.content
               ))::text, '[]')
        FROM (
          SELECT u.id, u.auth_user_id,
                 COALESCE(string_agg(d.content, E'\\n'), '') AS content
          FROM users u LEFT JOIN documents d ON d.user_id = u.id
          GROUP BY u.id, u.auth_user_id
        ) t
    """)
    rows = json.loads(raw.strip() or "[]")

    existing = set(psql(db, "SELECT object_key FROM image_objects").split())

    planned: list[tuple[str, int, int]] = []   # (key, user_id, bytes)
    already = missing = 0
    no_length = []

    for row in rows:
        user_id = int(row["user_id"])
        auth_user_id = row["auth_user_id"] or ""
        content = row["content"] or ""
        if not auth_user_id:
            continue

        seen = set()
        for owner, hexpart, ext in KEY_PATTERN.findall(content):
            # 归属：前缀必须严格等于该用户，与后端 extractOwnedImageKeys 一致。
            # 少了这条，在自己文档里引用别人的图会把对象记到自己账上
            if owner != auth_user_id:
                continue
            key = f"u/{owner}/{hexpart}.{ext}"
            if key in seen:
                continue
            seen.add(key)

            if key in existing:
                already += 1
                continue
            size = head_size(args.base, key, args.timeout)
            if size is None:
                missing += 1
                continue
            if size <= 0:
                # bytes 列有 CHECK (bytes >= 0)，而 0 字节的对象记进去没有意义
                no_length.append(key)
                continue
            planned.append((key, user_id, size))

    total = sum(b for _, _, b in planned)
    print(f"待回填:   {len(planned)} 个对象，共 {total:,} 字节（约 {total // 1024:,} KB）")
    print(f"已在账本: {already} 个（跳过）")
    print(f"R2 缺失:  {missing} 个（正文引用了已删除的对象，跳过）")
    if no_length:
        print(f"大小异常: {len(no_length)} 个（跳过）: {no_length[:3]}")

    if not planned:
        print("\n没有需要回填的对象。")
        return

    if not args.apply:
        print("\n这是预演。确认无误后加 --apply 真正写入。")
        for key, uid, size in planned[:5]:
            print(f"  user={uid}  {size:>9,}  {key}")
        if len(planned) > 5:
            print(f"  …… 另外 {len(planned) - 5} 个")
        return

    # 逐条 INSERT ... ON CONFLICT DO NOTHING。
    #
    # 故意不走配额判定（recordImageObject 那条带 WHERE 的语句）：这些对象**已经**
    # 占着 R2 的空间了，账本只是把既有事实记下来。用带判定的语句会在超额时拒绝写入，
    # 结果是"用量仍然显示不出来"—— 那与回填的目的正好相反。
    values = ",".join(
        f"('{key}', {uid}, {size})" for key, uid, size in planned
    )
    psql(db, f"""
        INSERT INTO image_objects (object_key, user_id, bytes)
        VALUES {values}
        ON CONFLICT (object_key) DO NOTHING
    """)
    print(f"\n✓ 已写入 {len(planned)} 条")

    # 复核：把每个用户回填后的用量打出来
    out = psql(db, """
        SELECT u.email,
               COALESCE((SELECT SUM(octet_length(d.content) + octet_length(d.title))
                         FROM documents d WHERE d.user_id = u.id), 0),
               COALESCE((SELECT SUM(io.bytes)
                         FROM image_objects io WHERE io.user_id = u.id), 0)
        FROM users u
        WHERE EXISTS (SELECT 1 FROM image_objects io WHERE io.user_id = u.id)
        ORDER BY 3 DESC
    """)
    print("\n回填后的用量：")
    for line in out.strip().splitlines():
        email, doc_b, img_b = line.split("|")
        tot = int(doc_b) + int(img_b)
        print(f"  {email:32} 文档 {int(doc_b):>9,}  图片 {int(img_b):>11,}  "
              f"合计 {tot:>11,} 字节（{tot / 1024 / 1024:.2f} MB）")


if __name__ == "__main__":
    main()
