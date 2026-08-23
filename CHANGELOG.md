# Changelog

Notable user-facing changes to Koinote are recorded here. The project follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Added member-only AI optimization with Git-style title/body diffs, individual or bulk apply/dismiss actions, a 0–100 title score, and model-requested alternatives when the score is below 60. Reviews separate editorial changes from AST-validated Markdown layout changes and score hierarchy, readability, emphasis, rhythm, modules, and mobile presentation.
- Lifetime membership now grants 1,000 credits. Built-in reviews cost 1 credit per 2,000 actual tokens, with Stripe packs of 3,000, 10,000, and 30,000 credits.
- Added encrypted BYOK channels for OpenAI-compatible and Anthropic Messages APIs; BYOK reviews do not consume credits.
- Added smart date-based and activity-based organization for documents outside manually managed folders, with adaptive month/week grouping and confirmation before bulk moves.
- Added an administrator server-status dashboard for host CPU, memory, load, disk, uptime, and network throughput, using read-only host metrics in production.
- Added a localized 15-template gallery when creating documents: five offline-ready templates are free, including todo lists and flexible tables, while Lifetime members unlock ten advanced templates including daily and weekly reports, OKR, KPI, writing, product, research, and technical workflows.
- Added in-document search with `Cmd+F` on macOS and `Ctrl+F` on Windows/Linux, highlighted matches, result counts, and wraparound previous/next navigation.
- Added localized native desktop menus, a shortcut reference dialog, quick document opening, global search, tab navigation, numbered tab selection, document creation/closing, manual save, and panel toggles.
- Added a member-only AI-generated hidden GEO summary for WeChat exports. Summaries are saved per document, remain editable and reusable, warn when the article changes, and clearly disclose the platform-policy risk before use.
- Added an in-app feedback form with bug and experience categories, source/client context, privacy-safe share-link redaction, and a paginated administrator inbox.

### Changed

- AI optimization now closes after submission and continues as a persisted background task. A title and six-dimension diagnosis wave feeds a second wave of whole-document developmental editing and body-chunk review, with at most three concurrent model calls. Each stage persists progress and partial results, validation retries only the failed subtask, and users can run a focused second-pass deep analysis for any structural dimension. The added whole-document context can increase built-in-model input-token usage compared with the previous review pipeline; charges continue to use provider-reported actual tokens.
- WeChat export now tunes page padding, paragraph rhythm, line and letter spacing, and heading/body sizes for mobile reading while preserving the default font and each theme's visual identity.

### Fixed

- Stripe webhooks now acknowledge events belonging to other applications on a shared account, including events created with a different Stripe API release train, while preserving strict Koinote checkout verification.
- Improved Word export with explicit A4 typography, heading hierarchy, nested lists, real hyperlinks, styled quotes and code blocks, bounded images with captions, stable tables, and page numbers instead of relying on Word defaults.
- Kept headings immediately after block images separate across repeated Markdown saves, and repaired legacy escaped headings when documents open.
- PDF export now uses one clear action and saves a paginated, searchable PDF directly to the chosen file on desktop; a dedicated print snapshot prevents long documents from being clipped to the editor viewport and keeps document layout separate from application chrome.
- Desktop Bearer sessions can now load and manage AI settings, BYOK channels, credits, reviews, and credit checkout instead of being rejected by the desktop endpoint scope.
- Credits checkout now uses a live-mode Stripe Product, and deployments reject test/live Product mismatches before they reach users.
- Credits checkout now supports the same USD, CNY, EUR, and JPY choices as membership, allowing Stripe to expose eligible local methods such as WeChat Pay for CNY.
- AI optimization changes now reconcile the desktop revision and remote snapshot after apply, preventing a successful review from leaving the client in a false sync-error state.
- Replacing a pending desktop image with its uploaded URL now preserves the editor scroll position instead of jumping upward.
- Desktop sharing now syncs the current draft first and immediately persists the returned share state locally, so enabling or revoking a share no longer appears to do nothing.
- Desktop shortcuts and native menu accelerators no longer act on documents behind modal dialogs; save conflicts now replace the AI optimization panel with the visible conflict resolver.
- Desktop sync now queues a follow-up pass when edits arrive during an active image-upload sync, avoiding delayed save or sync errors after successful uploads.
- Desktop save failures now distinguish revision conflicts from offline or network errors, retain retryable drafts without silently restoring stale backups, and expose clearer accessible status feedback.
- Sync updates, image uploads, and tab switches now preserve cursor and scroll positions without rebuilding unaffected editor content, including after an editor tab is remounted.
- Native export menu actions now run the selected format directly, and `Cmd/Ctrl+/` toggles the shortcut reference closed instead of only opening it.
- Desktop folder drag-and-drop now works reliably in WKWebView, rejects unknown payloads before moving anything, and clears stale drop highlights after cancelled drags.
- `Cmd/Ctrl+W` and new-document shortcuts now work while the editor body is focused without firing inside form fields or through modal dialogs.

## [0.6.0] - 2026-08-17

### Added

- Added multilingual in-app announcements: every release automatically highlights user-facing upgrades, while administrators can publish manual notices translated server-side into English, Chinese, Japanese, and French.
- Added a fully local desktop mode with no account, password-derived encryption for documents, folders, and images, and a hard network block. After signing in, users can verify the local password and copy a detached snapshot into normal account documents.
- Added a Tauri 2 macOS / Windows alpha with PKCE system-browser sign-in, OS-keychain tokens, local-first SQLite documents and images, deferred uploads, a bounded image cache, and conflict recovery.
- Added a website download entry backed by GitHub Releases for macOS Apple Silicon, macOS Intel, and Windows x64 installers.
- Added signed desktop auto-updates with startup checks, a manual action, progress, and restart-to-install support.
- Desktop clients now check for updates every six hours, retry transient failures after 30 minutes, and catch up when the app returns to the foreground or reconnects.
- Added foreground remote-change detection for web and desktop: clean documents update automatically, while concurrent local drafts trigger an explicit conflict prompt.
- Added encrypted six-hour PostgreSQL backups to private R2 with retention, health checks, alerts, and a documented recovery drill.
- Added self-service account deletion with detached Stripe records still visible to administrators, privacy-preserving MCP activity logs, and bounded line-by-line version diffs against current or retained versions.

### Changed

- The desktop client now opens to a focused local-first workspace with continue-writing, recent documents, quick actions, sync status, and offline availability instead of the website landing page.
- Markdown import validates large batches, decompresses ZIPs off-thread, compresses images over 10 MB, limits concurrency, and releases orphaned uploads after failures. The Terms now clarify Lifetime, fixed 10 GB storage, future AI eligibility, account deletion, and refund boundaries.
- macOS 26 builds now use a native Icon Composer asset; older macOS and Windows keep their normal fallback icons.

### Fixed

- In-app announcements no longer block service startup when bundled content is invalid, can be dismissed locally if read-state saving fails, and can be withdrawn by administrators without erasing release history. Optional translation configuration no longer blocks unrelated deployments.
- Pressing Enter to confirm a Chinese, Japanese, or Korean IME candidate in the document title no longer moves focus into the body; ordinary Enter keeps the existing title-to-body shortcut.
- Account deletion and Checkout cleanup now verify expired sessions with Stripe, preserving completed payments until their webhook is recorded. Local-mode imports stream through bounded staging batches and commit atomically, and user text containing `$` is no longer altered in account or version-history messages.
- Stripe Checkout now keeps one payable session per user and securely returns desktop payments through `koinote://`.
- Word/PDF exports use the same-origin image proxy; desktop image failures no longer block unrelated sync, errors are visible, cache origins are trusted, and exports include pending local images.
- Fixed desktop Admin and MCP-token requests being rejected by the desktop Bearer allowlist, restored the Docs and Pricing navigation, and routed web-only account-security actions to the system browser instead of letting them fail with 403. Copied invitation and document-share links now use the configured website URL instead of a Tauri-local address.
- Desktop trash now supports permanent deletion with one native confirmation, while the web keeps its typed-title safeguard; deleted local drafts and unreferenced offline images are cleaned up.
- macOS Apple Silicon and Intel release bundles now receive a complete ad-hoc signature and are
  verified from inside the generated DMG, preventing Gatekeeper from reporting a broken partial
  signature as a damaged application.
- Desktop release builds now validate and embed the complete updater public key before signing platform update artifacts.

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
