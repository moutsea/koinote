import unittest

from prune_actions_caches import desktop_tag, select_caches


def cache(cache_id, ref, key="v0-rust-desktop", version="v1", created="2026-11-01T00:00:00Z"):
    return {"id": cache_id, "ref": ref, "key": key, "version": version, "created_at": created}


def release(tag, published="2026-11-01T00:00:00Z", draft=False):
    return {"tag_name": tag, "published_at": published, "draft": draft}


class CacheRetentionTests(unittest.TestCase):
    def setUp(self):
        self.releases = [
            release("desktop-v3", "2026-11-03T00:00:00Z"),
            release("desktop-v1"),
            release("desktop-v2", "2026-11-02T00:00:00Z"),
        ]

    def selected_ids(self, caches, runs=(), releases=None, **kwargs):
        selected = select_caches(caches, self.releases if releases is None else releases, runs, "main", **kwargs)
        return {c["id"] for c in selected}

    def test_release_scopes_and_other_refs(self):
        caches = [
            cache(1, "refs/tags/desktop-v1"),
            cache(2, "refs/heads/refs/tags/desktop-v1"),
            cache(3, "refs/tags/desktop-v2"),
            cache(4, "refs/tags/desktop-v3"),
            cache(5, "refs/heads/main"),
            cache(6, "refs/pull/1/merge"),
            cache(7, "refs/heads/desktop-v1"),
            cache(8, "refs/tags/other-v1"),
        ]
        self.assertEqual(self.selected_ids(caches), {1, 2})

    def test_active_old_release_is_retained(self):
        self.assertEqual(self.selected_ids(
            [cache(1, "refs/tags/desktop-v1")], [{"head_branch": "desktop-v1"}],
        ), set())

    def test_unpublished_and_draft_tags_are_retained(self):
        self.assertEqual(self.selected_ids(
            [cache(1, "refs/tags/desktop-v0"), cache(2, "refs/tags/desktop-v1")],
            releases=[release("desktop-v1", draft=True)],
        ), set())

    def test_one_time_cleanup_can_keep_only_latest_release(self):
        caches = [cache(i, f"refs/tags/desktop-v{i}") for i in (1, 2, 3)]
        self.assertEqual(self.selected_ids(caches, keep_releases=1), {1, 2})

    def test_npm_keeps_newest_for_each_platform_arch_and_archive_version(self):
        caches = [
            cache(1, "refs/heads/main", "node-cache-Linux-x64-npm-aaa"),
            cache(2, "refs/heads/main", "node-cache-Linux-x64-npm-bbb", created="2026-11-02T00:00:00Z"),
            cache(3, "refs/heads/main", "node-cache-Windows-x64-npm-aaa"),
            cache(4, "refs/heads/main", "node-cache-Linux-arm64-npm-aaa"),
            cache(5, "refs/heads/main", "node-cache-Linux-x64-npm-aaa", version="other"),
            cache(6, "refs/heads/feature", "node-cache-Linux-x64-npm-aaa"),
            cache(7, "refs/heads/main", "setup-go-Linux-aaa"),
        ]
        self.assertEqual(self.selected_ids(caches), {1})

    def test_main_build_in_progress_preserves_npm_caches(self):
        caches = [cache(i, "refs/heads/main", f"node-cache-macOS-arm64-npm-{i}") for i in (1, 2)]
        self.assertEqual(self.selected_ids(caches, [{"head_branch": "main"}]), set())

    def test_empty_release_list_does_not_delete_tag_caches(self):
        self.assertEqual(self.selected_ids([cache(1, "refs/tags/desktop-v1")], releases=[]), set())

    def test_rejects_zero_retained_releases(self):
        with self.assertRaises(ValueError):
            self.selected_ids([], keep_releases=0)


if __name__ == "__main__":
    unittest.main()
