import copy
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import urllib.error

from seed_agent_repositories import API, CATALOG, NoRedirect, content_digest, load_catalog, publish_catalog, select_repositories, verify_repository


class FakeAPI:
    base_url = "https://koinote.example"

    def __init__(self, item):
        self.item = item
        self.calls = []
        self.published = None
        self.is_admin = True
        self.bonus_bytes = 0
        self.view = {
            "workspaceId": 42, "revision": 0, "name": item["name"], "description": item["description"],
            "githubSource": {key: item[key] for key in ("repositoryUrl", "author", "authorUrl", "commitSha", "license")},
            "files": copy.deepcopy(item["licenseFiles"]),
        }

    def request(self, method, path, data=None, **kwargs):
        self.calls.append((method, path, data))
        if path.endswith("/session"):
            return {"user": {"email": "owner@example.com", "membershipTier": "lifetime", "isAdmin": self.is_admin}}
        if path.endswith("/settings"):
            return {"enabled": True}
        if path == "/api/agent/repositories":
            return {"repositories": []}
        if path == "/api/admin/agent-repositories/storage":
            self.bonus_bytes = max(self.bonus_bytes, data["minimumBonusBytes"])
            return {"storage": {"bonusBytes": self.bonus_bytes, "allocatedBytes": 0}}
        if path.endswith("/import/github"):
            return {"workspace": self.view}
        if path.endswith("/sharing"):
            if method == "PUT":
                self.published = dict(self.view, license=data["license"])
                return {"success": True}
            return {"publication": self.published, "currentRevision": self.view["revision"]}
        if path == "/api/agent/repositories/42":
            assert kwargs.get("authenticated") is False
            return {"repository": self.published}
        raise AssertionError((method, path))


class CatalogTests(unittest.TestCase):
    def setUp(self):
        self.item = copy.deepcopy(load_catalog(CATALOG)["repositories"][0])
        self.item["fileCount"] = len(self.item["licenseFiles"])
        self.item["sizeBytes"] = sum(file["sizeBytes"] for file in self.item["licenseFiles"])
        self.item["contentSha256"] = content_digest(self.item["licenseFiles"])
        self.catalog = {"repositories": [self.item]}
        self.api = FakeAPI(self.item)

    def test_catalog_is_pinned_and_attributed(self):
        catalog = load_catalog(CATALOG)
        self.assertEqual(len(catalog["repositories"]), 100)
        self.assertTrue(all(item["skillCount"] > 0 for item in catalog["repositories"]))
        self.assertTrue(all(item["githubStars"] >= 1000 for item in catalog["repositories"]))

    def test_select_batch_keeps_ids_and_order(self):
        catalog = load_catalog(CATALOG)
        selected = select_repositories(catalog, [catalog["repositories"][4]["name"].upper(), catalog["repositories"][1]["name"]])
        self.assertEqual(selected["repositories"], [catalog["repositories"][1], catalog["repositories"][4]])
        self.assertEqual(len(catalog["repositories"]), 100)
        self.assertIs(select_repositories(catalog, []), catalog)

    def test_unknown_selection_stops_before_network(self):
        from seed_agent_repositories import main
        with patch("sys.argv", ["seed_agent_repositories.py", "--apply", "--only", "missing/repository"]), patch.object(API, "request", side_effect=AssertionError("network")):
            with self.assertRaisesRegex(ValueError, "Unknown --only"):
                main()

    def test_preview_makes_no_network_requests(self):
        from seed_agent_repositories import main
        with patch("sys.argv", ["seed_agent_repositories.py"]), patch.object(API, "request", side_effect=AssertionError("network")), patch("sys.stdout", new=io.StringIO()) as output:
            main()
        self.assertIn("Plan only", output.getvalue())

    def test_desktop_token_only_stops_before_network(self):
        from seed_agent_repositories import main
        secret = "synthetic-desktop-review-token"
        args = ["seed_agent_repositories.py", "--apply", "--base-url", self.api.base_url, "--owner-email", "owner@example.com"]
        with patch("sys.argv", args), patch.dict(os.environ, {"KOINOTE_DESKTOP_TOKEN": secret}), patch.object(API, "request", side_effect=AssertionError("network")) as request, patch("sys.stdout", new=io.StringIO()), patch("sys.stderr", new=io.StringIO()) as error:
            with self.assertRaises(SystemExit) as stopped:
                main()
        self.assertEqual(stopped.exception.code, 2)
        request.assert_not_called()
        self.assertIn("--cookie-file", error.getvalue())
        self.assertIn("15 minutes", error.getvalue())
        self.assertNotIn(secret, error.getvalue())

    def test_cookie_file_works_with_unrelated_desktop_token_environment(self):
        from seed_agent_repositories import main
        with tempfile.TemporaryDirectory() as directory:
            cookie_file = Path(directory) / "session"
            cookie_file.write_text("session=browser-test-session\n", encoding="utf-8")
            args = ["seed_agent_repositories.py", "--apply", "--base-url", self.api.base_url, "--owner-email", "owner@example.com", "--cookie-file", str(cookie_file)]
            with patch("sys.argv", args), patch.dict(os.environ, {"KOINOTE_DESKTOP_TOKEN": "synthetic-desktop-review-token"}), patch("seed_agent_repositories.publish_catalog") as publish, patch("sys.stdout", new=io.StringIO()):
                main()
        publish.assert_called_once()
        self.assertEqual(publish.call_args.args[0].credential, {"Cookie": "session=browser-test-session"})
        self.assertEqual(len(publish.call_args.args[1]["repositories"]), 100)

    def test_wrong_owner_stops_before_writes(self):
        with self.assertRaisesRegex(ValueError, "account does not match"):
            publish_catalog(self.api, self.catalog, "other@example.com")
        self.assertTrue(all(method == "GET" for method, _, _ in self.api.calls))

    def test_changed_content_stays_private(self):
        self.api.view["files"][0]["sha256"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "differ from the reviewed"):
            publish_catalog(self.api, self.catalog, "owner@example.com")
        self.assertFalse(any(method == "PUT" and path.endswith("/sharing") for method, path, _ in self.api.calls))

    def test_nonadmin_cannot_provision_or_import_catalog(self):
        self.api.is_admin = False
        with self.assertRaisesRegex(ValueError, "administrator"):
            publish_catalog(self.api, self.catalog, "owner@example.com")
        self.assertTrue(all(method == "GET" for method, _, _ in self.api.calls))

    def test_partial_import_uses_full_catalog_system_budget(self):
        publish_catalog(self.api, self.catalog, "owner@example.com", system_bonus_bytes=200_000_000)
        grant = next(body for _, path, body in self.api.calls if path == "/api/admin/agent-repositories/storage")
        self.assertEqual(grant, {"ownerEmail": "owner@example.com", "minimumBonusBytes": 200_000_000})
        self.assertFalse(any(path == "/api/agent/workspace/storage" for _, path, _ in self.api.calls))

    def test_wrong_attribution_and_private_sources_are_rejected(self):
        for key, value in (("author", "imposter"), ("license", "UNLICENSED"), ("private", True), ("commitSha", "0" * 40)):
            with self.subTest(key=key):
                view = copy.deepcopy(self.api.view)
                view["githubSource"][key] = value
                with self.assertRaises(ValueError):
                    verify_repository(self.item, view)

    def test_repeat_run_reuses_request_and_does_not_republish(self):
        for _ in range(2):
            publish_catalog(self.api, self.catalog, "owner@example.com")
        imports = [body for method, path, body in self.api.calls if path.endswith("/import/github")]
        self.assertEqual(imports[0], imports[1])
        self.assertEqual(imports[0]["ref"], self.item["commitSha"])
        self.assertEqual(sum(method == "PUT" and path.endswith("/sharing") for method, path, _ in self.api.calls), 1)
        grants = [body for _, path, body in self.api.calls if path == "/api/admin/agent-repositories/storage"]
        self.assertEqual(grants[0], grants[1])
        self.assertEqual(self.api.bonus_bytes, self.item["sizeBytes"])

    def test_rate_limit_retry_keeps_same_request(self):
        api = API("https://koinote.example", {"Cookie": "test-session"})
        response = io.BytesIO(b'{"ok":true}')
        with patch.object(api.opener, "open", side_effect=[urllib.error.HTTPError("https://koinote.example/api", 429, "limit", {"Retry-After": "1"}, io.BytesIO()), response]) as mocked, patch("time.sleep"):
            self.assertEqual(api.request("POST", "/api", {"requestId": self.item["requestId"]}), {"ok": True})
            self.assertEqual(mocked.call_args_list[0].args[0].data, mocked.call_args_list[1].args[0].data)

    def test_redirects_and_remote_plaintext_http_are_rejected(self):
        self.assertIsNone(NoRedirect().redirect_request(None, None, 302, "", {}, "https://evil.example"))
        for url in ("http://koinote.example", "https://user:secret@koinote.example", "https://koinote.example/api", "https://koinote.example?token=secret"):
            with self.subTest(url=url), self.assertRaises(ValueError):
                API(url, {})

    def test_duplicate_import_ids_are_rejected(self):
        catalog = load_catalog(CATALOG)
        catalog["repositories"][1]["requestId"] = catalog["repositories"][0]["requestId"]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "catalog.json"
            path.write_text(json.dumps(catalog))
            with self.assertRaisesRegex(ValueError, "Duplicate"):
                load_catalog(path)


if __name__ == "__main__":
    unittest.main()
