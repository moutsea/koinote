#!/usr/bin/env python3
"""Keep recent desktop release caches and the newest npm cache per platform.

Read-only unless --apply is supplied. Requires an authenticated GitHub CLI.
"""

import argparse
import json
import os
import re
import subprocess
from collections import defaultdict


ACTIVE_STATUSES = ("in_progress", "queued", "waiting", "requested", "pending")


def desktop_tag(ref):
    # GitHub's cache API also returns this nested prefix for some tag runs.
    for prefix in ("refs/tags/", "refs/heads/refs/tags/"):
        if ref.startswith(prefix):
            tag = ref[len(prefix):]
            if re.fullmatch(r"desktop-v[^/]+", tag):
                return tag
    return None


def select_caches(caches, releases, active_runs, default_branch, keep_releases=2, current_run_id=None):
    if keep_releases < 1:
        raise ValueError("At least one desktop release must be retained")
    # The maintenance workflow also runs on main; it is not a consumer to protect.
    active_runs = [r for r in active_runs if str(r.get("id")) != current_run_id]
    published = sorted(
        (r for r in releases if not r["draft"] and r.get("published_at")
         and r["tag_name"].startswith("desktop-v")),
        key=lambda r: r["published_at"], reverse=True,
    )
    published_tags = {r["tag_name"] for r in published}
    retained_tags = {r["tag_name"] for r in published[:keep_releases]}
    retained_tags.update(r["head_branch"] for r in active_runs)
    main_ref = f"refs/heads/{default_branch}"
    main_active = any(r["head_branch"] == default_branch for r in active_runs)
    selected = []
    npm_groups = defaultdict(list)
    for cache in caches:
        tag = desktop_tag(cache["ref"])
        if tag in published_tags and tag not in retained_tags:
            selected.append(cache)
        elif not main_active and cache["ref"] == main_ref and re.fullmatch(
            r"node-cache-(Linux|Windows|macOS)-[^-]+-npm-[0-9a-f]+", cache["key"]
        ):
            # Cache versions describe archive paths/compression; keep each usable format.
            npm_groups[(cache["key"].rsplit("-", 1)[0], cache["version"])].append(cache)
    for group in npm_groups.values():
        group.sort(key=lambda c: (c["created_at"], c["id"]), reverse=True)
        selected.extend(group[1:])
    return selected


def read_api(path, field=None):
    pages = json.loads(subprocess.check_output(
        ["gh", "api", "--paginate", "--slurp", path], text=True,
    ))
    return [item for page in pages for item in (page[field] if field else page)]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", required=True, help="owner/repository")
    parser.add_argument("--keep-releases", type=int, default=2)
    parser.add_argument("--apply", action="store_true", help="Delete the selected caches")
    args = parser.parse_args()
    if not re.fullmatch(r"[\w.-]+/[\w.-]+", args.repo) or args.keep_releases < 1:
        parser.error("Use owner/repository and --keep-releases >= 1")
    base = f"repos/{args.repo}"
    repo = json.loads(subprocess.check_output(["gh", "api", base], text=True))
    releases = read_api(f"{base}/releases?per_page=100")
    active_runs = []
    for status in ACTIVE_STATUSES:
        active_runs.extend(read_api(
            f"{base}/actions/runs?status={status}&per_page=100", "workflow_runs",
        ))
    caches = read_api(f"{base}/actions/caches?per_page=100", "actions_caches")
    selected = select_caches(
        caches, releases, active_runs, repo["default_branch"], args.keep_releases,
        current_run_id=os.environ.get("GITHUB_RUN_ID"),
    )
    deleted = []
    for cache in selected:
        if args.apply:
            result = subprocess.run(
                ["gh", "api", "--method", "DELETE", "--silent",
                 f"{base}/actions/caches/{cache['id']}"], capture_output=True, text=True,
            )
            if result.returncode:
                # GitHub may have evicted an entry after we read the inventory.
                if "HTTP 404" in result.stderr:
                    continue
                raise RuntimeError(result.stderr.strip())
            deleted.append(cache)
    remaining = read_api(f"{base}/actions/caches?per_page=100", "actions_caches") if args.apply else caches
    print(json.dumps({
        "apply": args.apply,
        "keep_releases": args.keep_releases,
        "active_runs": len(active_runs),
        "before_count": len(caches),
        "before_bytes": sum(c["size_in_bytes"] for c in caches),
        "selected": [{k: c[k] for k in ("id", "ref", "key", "size_in_bytes")} for c in selected],
        "deleted_count": len(deleted),
        "deleted_bytes": sum(c["size_in_bytes"] for c in deleted),
        "remaining_count": len(remaining),
        "remaining_bytes": sum(c["size_in_bytes"] for c in remaining),
    }, indent=2))


if __name__ == "__main__":
    main()
