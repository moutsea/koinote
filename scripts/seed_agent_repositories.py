#!/usr/bin/env python3
"""Publish the reviewed GitHub catalog through Koinote's normal authenticated API."""

import argparse
import hashlib
import json
from pathlib import Path
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

CATALOG = Path(__file__).resolve().parents[1] / "data/agent-repositories/catalog.json"


def content_digest(files):
    ordered = sorted(files, key=lambda item: item["path"].encode("utf-8"))
    return hashlib.sha256("".join(
        item["path"] + "\0" + item["sha256"] + "\n" for item in ordered
    ).encode("utf-8")).hexdigest()


def load_catalog(path):
    catalog = json.loads(Path(path).read_text(encoding="utf-8"))
    if catalog.get("schemaVersion") != 1 or not catalog.get("repositories"):
        raise ValueError("Unsupported or empty catalog")
    seen_urls, seen_ids = set(), set()
    for item in catalog["repositories"]:
        url = item["repositoryUrl"]
        if not re.fullmatch(r"https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", url):
            raise ValueError("Catalog must use canonical GitHub repository URLs")
        if url in seen_urls or item["requestId"] in seen_ids:
            raise ValueError("Duplicate repository or import request ID")
        seen_urls.add(url)
        seen_ids.add(item["requestId"])
        if uuid.UUID(item["requestId"]).version != 4:
            raise ValueError("Import request IDs must be UUID v4")
        if not re.fullmatch(r"[0-9a-f]{40}", item["commitSha"]):
            raise ValueError("Catalog must pin a full commit SHA")
        if not re.fullmatch(r"[0-9a-f]{64}", item["contentSha256"]):
            raise ValueError("Missing reviewed content digest")
        if item["authorUrl"] != "https://github.com/" + item["author"] or not url.startswith(item["authorUrl"] + "/"):
            raise ValueError("Inconsistent GitHub attribution")
        if item["license"] not in ("MIT", "Apache-2.0") or not item["licenseFiles"]:
            raise ValueError("Review the license before extending the initial catalog")
    return catalog


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None  # Never forward a session credential to another origin.


class API:
    def __init__(self, base_url, credential):
        parsed = urllib.parse.urlsplit(base_url)
        local_http = parsed.scheme == "http" and parsed.hostname in ("127.0.0.1", "localhost", "::1")
        if (parsed.scheme != "https" and not local_http) or not parsed.netloc or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ("", "/"):
            raise ValueError("Use an HTTPS site origin (HTTP is allowed only on localhost)")
        self.base_url = base_url.rstrip("/")
        self.credential = credential
        self.opener = urllib.request.build_opener(NoRedirect())

    def request(self, method, path, data=None, *, authenticated=True):
        headers = {"Accept": "application/json", "Content-Type": "application/json"}
        if authenticated:
            headers.update(self.credential)
        body = None if data is None else json.dumps(data).encode("utf-8")
        for attempt in range(4):
            request = urllib.request.Request(self.base_url + path, data=body, headers=headers, method=method)
            try:
                with self.opener.open(request, timeout=120) as response:
                    raw = response.read(16 * 1024 * 1024 + 1)
                if len(raw) > 16 * 1024 * 1024:
                    raise RuntimeError("API response exceeds the expected size")
                return json.loads(raw)
            except urllib.error.HTTPError as error:
                if error.code == 429 and attempt < 3:
                    retry = error.headers.get("Retry-After", "60")
                    delay = int(retry) if retry.isdigit() else 60
                    if not 1 <= delay <= 60:
                        raise RuntimeError("Rate limited; retry this command later") from None
                    print(f"Rate limited; waiting {delay}s", flush=True)
                    error.close()
                    time.sleep(delay)
                    continue
                # Do not echo response bodies: errors can contain credential-like content.
                status = error.code
                error.close()
                raise RuntimeError(f"{method} {path}: HTTP {status}; inspect the account or server logs") from None
        raise RuntimeError("Request retry limit reached")


def verify_repository(item, view):
    source = view.get("githubSource") or {}
    expected = {key: item[key] for key in ("repositoryUrl", "author", "authorUrl", "commitSha", "license")}
    if any(source.get(key) != value for key, value in expected.items()) or source.get("private"):
        raise ValueError("Imported GitHub provenance or license differs from the reviewed catalog")
    files = view["files"]
    if len(files) != item["fileCount"] or sum(file["sizeBytes"] for file in files) != item["sizeBytes"] or content_digest(files) != item["contentSha256"]:
        raise ValueError("Repository files differ from the reviewed snapshot; refusing to publish")
    by_path = {file["path"]: file for file in files}
    for license_file in item["licenseFiles"]:
        actual = by_path.get(license_file["path"], {})
        if actual.get("sha256") != license_file["sha256"]:
            raise ValueError("Original license/notice file is missing or changed")
    if view["name"] != item["name"] or view["description"] != item["description"]:
        raise ValueError("Repository metadata was edited; refusing to republish it")


def publish_catalog(api, catalog, owner_email, *, system_bonus_bytes=None):
    user = api.request("GET", "/api/auth/session")["user"]
    if user["email"].casefold() != owner_email.casefold():
        raise ValueError("Authenticated account does not match --owner-email")
    if user["membershipTier"] != "lifetime":
        raise ValueError("The managing account must have repository write access")
    if not user.get("isAdmin"):
        raise ValueError("The platform catalog requires an administrator managing account")
    if not api.request("GET", "/api/agent/workspace/settings")["enabled"]:
        raise ValueError("Enable Skills/Agent cloud sync in the managing account first")
    # Check that sharing has been deployed before creating any private imports.
    api.request("GET", "/api/agent/repositories", authenticated=False)
    # System-funded capacity never reserves personal storage. Keep the normal
    # included quota as headroom, and grant at least the full catalog's bytes.
    budget = system_bonus_bytes if system_bonus_bytes is not None else sum(item["sizeBytes"] for item in catalog["repositories"])
    storage = api.request("PUT", "/api/admin/agent-repositories/storage", {
        "ownerEmail": owner_email, "minimumBonusBytes": budget,
    })["storage"]
    if storage["bonusBytes"] < budget:
        raise ValueError("System repository storage was not provisioned")
    pending = []
    # Import and verify every entry before making any new entry public. The fixed
    # request IDs recover an interrupted run without creating duplicate workspaces.
    for index, item in enumerate(catalog["repositories"], start=1):
        print(f"Importing [{index}/{len(catalog['repositories'])}] {item['name']} @ {item['commitSha'][:12]}", flush=True)
        view = api.request("POST", "/api/agent/workspaces/import/github", {
            "repositoryUrl": item["repositoryUrl"], "ref": item["commitSha"],
            "name": item["name"], "description": item["description"], "requestId": item["requestId"],
        })["workspace"]
        verify_repository(item, view)
        pending.append((item, view))
    published = []
    # The directory sorts by publication time. Publish the first catalog entry
    # last so a fresh launch displays the curated order without changing sorting.
    for item, view in reversed(pending):
        workspace_id, revision = view["workspaceId"], view["revision"]
        sharing = f"/api/agent/workspaces/{workspace_id}/sharing"
        current = api.request("GET", sharing)
        if current["currentRevision"] != revision:
            raise ValueError("Repository changed during import; refusing to publish")
        publication = current.get("publication")
        if publication is not None:
            verify_repository(item, publication)
            if publication["revision"] != revision or publication["license"] != item["license"]:
                raise ValueError("An existing publication differs; review it before continuing")
        else:
            api.request("PUT", sharing, {"expectedRevision": revision, "license": item["license"]})
        # Verify what an anonymous visitor actually sees, not just the owner view.
        public = api.request("GET", f"/api/agent/repositories/{workspace_id}", authenticated=False)["repository"]
        verify_repository(item, public)
        if public["revision"] != revision or public["license"] != item["license"]:
            raise ValueError("Published revision or license verification failed")
        url = f"{api.base_url}/repositories/{workspace_id}"
        published.append({"repositoryUrl": item["repositoryUrl"], "url": url, "revision": revision})
        print(f"Published {item['name']}: {url}", flush=True)
    return published


def select_repositories(catalog, names):
    if not names:
        return catalog
    requested = {name.casefold() for name in names}
    available = {item["name"].casefold() for item in catalog["repositories"]}
    if requested - available:
        raise ValueError("Unknown --only repository: " + ", ".join(sorted(requested - available)))
    return dict(catalog, repositories=[item for item in catalog["repositories"] if item["name"].casefold() in requested])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--catalog", type=Path, default=CATALOG)
    parser.add_argument("--apply", action="store_true", help="Import and publish the catalog (default: show plan only)")
    parser.add_argument("--base-url", help="Explicit target Koinote origin")
    parser.add_argument("--owner-email", help="Must match the authenticated managing account")
    parser.add_argument("--cookie-file", type=Path, help="Required with --apply: private file containing the browser session Cookie header; never committed")
    parser.add_argument("--only", action="append", metavar="OWNER/REPO", help="Select one repository; repeat to import a batch or resume specific entries")
    args = parser.parse_args()
    full_catalog = load_catalog(args.catalog)
    catalog = select_repositories(full_catalog, args.only)
    for item in catalog["repositories"]:
        print(f"{item['name']}: {item['githubStars']:,} GitHub stars, {item['skillCount']} skills, {item['license']}")
    print(f"Reviewed on {catalog['collectedOn']}; {sum(item['sizeBytes'] for item in catalog['repositories']):,} bytes of repository content.")
    if not args.apply:
        print("Plan only. No server was contacted and no repositories were published.")
        return
    if not args.base_url or not args.owner_email:
        parser.error("--apply requires --base-url and --owner-email")
    if not args.cookie_file:
        parser.error("--apply requires --cookie-file with a browser session; desktop access tokens expire after 15 minutes and cannot finish a full catalog import")
    credential = {"Cookie": args.cookie_file.read_text(encoding="utf-8").strip()}
    if any(not value or "\r" in value or "\n" in value for value in credential.values()):
        raise ValueError("Invalid credential format")
    publish_catalog(API(args.base_url, credential), catalog, args.owner_email.strip(),
                    system_bonus_bytes=sum(item["sizeBytes"] for item in full_catalog["repositories"]))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, OSError, RuntimeError) as error:
        # Network exceptions may include URLs; none contain credentials here.
        print(f"Stopped: {error}", file=sys.stderr)
        sys.exit(1)
