# Changelog

Notable user-facing changes to Koinote are recorded here. The project follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Added a Tauri 2 macOS / Windows alpha with PKCE system-browser sign-in, OS-keychain tokens,
  local-first SQLite documents, background synchronization, and explicit conflict recovery.
- Added a website download entry backed by GitHub Releases for macOS Apple Silicon, macOS Intel,
  and Windows x64 installers.
- Added signed desktop auto-updates with startup checks, a manual account-menu action, download
  progress, and restart-to-install support.

### Changed

- The desktop client now opens to a focused local-first workspace with continue-writing, recent
  documents, quick actions, sync status, and offline availability instead of the website landing page.
- Desktop app icons now use platform-safe transparent spacing so their rounded edge renders cleanly
  without a visible fringe on macOS and Windows.

### Fixed

- macOS Apple Silicon and Intel release bundles now receive a complete ad-hoc signature and are
  verified from inside the generated DMG, preventing Gatekeeper from reporting a broken partial
  signature as a damaged application.
- Desktop release builds now validate and embed the complete updater public key before signing
  platform update artifacts.

## [0.5.0] - 2026-08-15

### Added

- Global title and body search with `⌘K` / `Ctrl+K`, result highlighting, and MCP search snippets.
- Markdown, folder, and ZIP import plus a re-importable full export containing documents and images.
- Richer sharing with OpenGraph previews, read counts, and “Copy to my Koinote.”
- Password recovery, password changes, session revocation, and a mobile document drawer.
- Public MCP, version-history, Pricing, and Changelog pages.

### Changed

- MCP tokens can be permanent or edited after creation; documentation now covers Codex, Claude Code,
  OpenCode, OpenClaw, WorkBuddy, and other Streamable HTTP clients.
- Publishing export now supports WeChat, Zhihu, and Juejin, while document history, trash, and Agent
  safety snapshots offer clearer recovery controls for lifetime members.
- Admin analytics now includes privacy-preserving funnels and D1/D7/D30 retention.

### Fixed

- OpenGraph metadata safely preserves `$` sequences in shared-document titles and summaries.

## [0.4.0] - 2026-08-13

### Added

- Lifetime members can let scoped MCP clients read and edit documents with revision conflict checks.
- Document history, recovery snapshots, trash, and restore flows protect browser and Agent edits.
- Stripe membership payments can trigger durable, privacy-conscious Feishu notifications.
- My Documents and Invite Friends now have dedicated account pages.

### Fixed

- Juejin exports include the document title, and WeChat exports preserve image captions and code-block decorations.
- Document versions protect referenced images, while quota updates remain safe during concurrent uploads and edits.
- Cloudflare Analytics uses a dataset compatible with the Free plan.

## [0.3.0] - 2026-08-12

### Added

- Multi-currency Stripe Checkout for a lifetime membership with 10 GB storage.
- Invitation links reward both users with 500 MB, capped at 5 GB per account.
- Storage usage, membership upgrades, and an administrator statistics dashboard.
- Optional Cloudflare Analytics for edge UV, PV, requests, and bandwidth.

### Changed

- Storage quotas now account for membership and invitation bonuses.
- Temporary WeChat formula images use a separate bounded quota and content-addressed reuse.

### Security

- Checkout fulfillment validates price, currency, product, owner, and `metadata.service=koinote`.
- OAuth redirects, invitation rewards, internal tokens, and Checkout creation received additional safeguards.

## [0.2.0] - 2026-08-11

### Added

- Verified email registration with one-time codes and Cloudflare Email Sending.
- Automated deployment with backend and Worker health checks.
- Per-user image storage accounting and quotas.

### Fixed

- Image cleanup rechecks live references, quota accounting reclaims deleted data, and transient image loads recover.
- Registration no longer consumes a verification code when account creation fails.

### Security

- Verification codes use HMAC storage, transactional consumption, rate limits, and request-size limits.

## [0.1.0] - 2026-08-10

### Added

- Initial open-source release of the React, TipTap, Go, PostgreSQL, and Cloudflare Worker application.
- WYSIWYG Markdown editing, folders, tabs, autosave, code highlighting, tables, tasks, and KaTeX.
- R2 image hosting, protected sharing, and Markdown, HTML, DOCX, PDF, print, and WeChat exports.
- Chinese, English, Japanese, and French interfaces with password, Google, and GitHub login.
