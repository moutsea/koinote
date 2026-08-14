# Changelog

All notable changes to Koinote are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- A public MCP guide now covers Codex, Claude Code, OpenCode, OpenClaw, WorkBuddy,
  generic Streamable HTTP clients, version control, and the document safety boundaries.
- The MCP token card now generates a ready-to-run OpenClaw CLI configuration and probe command.
- MCP tokens can now be permanent, and an active token's expiry can be changed after creation.
- Publishing export now supports Zhihu and Juejin alongside WeChat: WeChat and Zhihu receive
  inlined rich text, while Juejin receives the original Markdown body.
- The home page now explains how scoped MCP tokens, revision checks, and safety snapshots
  let Codex, Claude Code, OpenCode, and other compatible agents work with Koinote documents.
- A public, localized Pricing page compares Free and Lifetime benefits. It reads storage
  quotas and the allowlisted multi-currency prices from the backend, lets signed-in users
  start Stripe Checkout directly, and returns signed-out users to Pricing after login.

### Changed

- Public documentation is now split into separate MCP integration and version-control guides,
  both available from a new Docs menu in the top navigation.
- The editor's WeChat-only export entry is now “Export to publishing platforms,” with an
  explicit destination picker for WeChat, Zhihu, and Juejin.
- Public pricing responses now carry a short shared-cache policy, and version-history settings
  explicitly distinguish the per-document limit from the 100-version account-wide shared cap.
- Image object-key rules now have a shared boundary corpus across the Worker and browser helpers,
  plus a real PostgreSQL integration test that compares every regex capture with Go. This pins
  the three capture groups used by image garbage collection against future regex drift.
- The MCP access card and documentation now include a ready-to-copy OpenCode remote-server
  configuration plus generic Streamable HTTP connection details for other compatible agents.
- Version history is now consistently restricted to lifetime members across snapshot creation,
  history browsing, restoration, dashboard settings, and the editor entry point. Members can
  configure it from the dashboard or MCP: enable or disable regular snapshots, retain 1–100
  versions per document, and choose whether MCP writes retain full history. When full MCP history
  is off, each changed document still keeps its latest Agent safety snapshot so whole-document
  replacement remains recoverable. Safety snapshots share the configured per-document limit and
  the account-wide cap of 100 versions.
- The dashboard account summary no longer shows the low-value username card.
- Document deletion now uses a 30-day trash. The browser can restore documents or permanently
  delete them after a second warning and typed-title confirmation; an hourly backend cleanup
  purges expired entries and only then schedules orphaned images for deletion.
- MCP write tokens now expose revision-checked `trash_document` and
  `restore_trashed_document`, while all tokens can list trashed summaries. Permanent deletion
  remains unavailable to agents.
- Newly created MCP personal access tokens are stored as an authentication hash plus an
  AES-GCM-encrypted recovery copy, so their owner can reveal and copy them again. Existing
  one-time-display tokens remain valid but cannot be recovered retroactively.

## [0.4.0] - 2026-08-13

### Added

- Lifetime members can connect Codex, Claude Code, and other Streamable HTTP MCP
  clients to their own Koinote documents. Personal access tokens support read or
  write scope, expiration, individual revocation, hashed authentication, per-token rate
  limits, and metadata-only audit logs.
- MCP tools can page through document lists, search titles, read Unicode-safe content
  chunks, inspect retained versions, create and append documents, replace documents
  with compare-and-swap protection, and restore an earlier version. No document-delete
  tool is exposed.
- Paid accounts now retain recovery snapshots for document writes. MCP mutations keep
  every previous state; browser autosave snapshots are throttled to one per five minutes,
  with limits of 20 versions per document and 100 per account.
- The web editor now detects concurrent edits, keeps conflicting drafts in local storage,
  provides an explicit merge dialog, and offers version-history viewing and restoration.
- Optional signed Feishu bot notifications now report successful lifetime-membership
  payments with internal user ID, amount, currency, Checkout Session, and PaymentIntent
  details, without sending email addresses or document content. Notification state is
  persisted and transient failures retry with backoff without making entitlement depend
  on Feishu.
- My Documents and Invite Friends now have dedicated account pages instead of sharing the
  dashboard, with direct entries in the account menu.

### Fixed

- Juejin export now prepends the document title as a level-one Markdown heading instead of
  copying only the editor body.
- Document and image quota mutations now share a user-level transaction lock, preventing
  concurrent MCP/web writes and image uploads from each approving against stale usage.
- Retained document versions protect referenced images from garbage collection; pruning
  a version or deleting a document re-evaluates those images for asynchronous cleanup.
- WeChat export now renders the Markdown image alt text beneath standalone images and
  skips inline, multi-image, list, and formula cases that cannot safely form a caption.
- Admin traffic statistics now use Cloudflare's Free-plan-compatible hourly Analytics
  dataset instead of the unavailable minute dataset and unsupported hostname filter.

## [0.3.0] - 2026-08-12

### Added

- A one-time Stripe Checkout flow for lifetime membership, with 10 GB of cloud
  storage and access to future AI capabilities.
- Multi-currency lifetime checkout in USD, CNY, EUR, and JPY, using Stripe dynamic
  payment methods for eligible card, Alipay, and WeChat Pay payments.
- Signed Stripe webhook fulfillment plus authenticated success-page confirmation,
  sharing one idempotent entitlement transaction.
- Personal invitation links now grant both the inviter and each newly registered user
  500 MB of permanent cloud storage, with support for email and OAuth registration
  and a 5 GB per-account bonus cap.
- The dashboard now shows the invitation code, copyable link, successful invite count,
  earned storage, and total bonus storage.
- The account menu now shows cloud-storage usage and links free users directly to
  the lifetime membership upgrade section.
- An administrator-only dashboard now reports users, lifetime members, per-currency
  revenue, orders, storage, 30-day growth, and recent account/payment activity.
- Optional Cloudflare Analytics integration adds today's edge UV, PV, requests, and
  bandwidth without making business metrics depend on the external API.

### Changed

- Storage quotas are now selected per user: configured/default quota for free users,
  10 GiB for lifetime members, plus bounded invitation bonuses.
- WeChat formula images are content-addressed, retained for seven days, and renewed
  on reuse instead of accumulating permanent per-export copies.
- Local production-image read-through is now opt-in, and the unused Redis service
  has been removed from Docker Compose.
- Automated deployment now validates and writes Stripe server, webhook, Product,
  and optional Cloudflare Analytics configuration to the backend environment.

### Security

- Invitation codes carried through OAuth are protected by the signed state cookie, and
  a unique invitation ledger prevents duplicate rewards for the same new account.
- Multi-currency fulfillment validates the selected currency against a server-side
  allowlist and checks the exact Session and line-item amount, currency, Product ID,
  user ownership, and `metadata.service=koinote` before granting membership.
- OAuth redirects reject WHATWG backslash variants, GitHub account merging requires a
  provider-verified email, and internal-token checks use constant-time comparison.
- Stripe Checkout Session creation is rate-limited per authenticated user.
- Invitation rewards are idempotent per invited account and capped at 5 GB per user.

### Fixed

- Scope Checkout idempotency keys to one purchase attempt and version their parameter
  shape, so retries never reopen expired Sessions or collide with older configurations.
- Image cleanup continues with daily retries after the initial exponential-backoff
  window, and re-enqueueing an object resets stale failure state.
- Concurrent first-time OAuth logins recover from unique-key races instead of failing,
  and WeChat formula images use a separate bounded temporary quota rather than consuming
  normal cloud-storage capacity.
- Admin overview aggregation is cached for one minute, while concurrent Cloudflare
  Analytics cache misses are coalesced into one upstream request.
- Local development now reads production-hosted Koinote images through the local
  Worker when an object is absent from the simulated R2 bucket. The fallback accepts
  only valid first-party image keys and is disabled in production.
- Image-upload quota errors now preserve the distinction between normal cloud storage
  and the temporary WeChat formula-image pool, with a specific export warning.
- WeChat code blocks keep their Mac-style traffic lights after the Official Account
  editor sanitizes empty decoration nodes, while browser previews retain smaller dots.

## [0.2.0] - 2026-08-11

### Added

- Verified email registration with one-time codes, resend support, expiry, and
  recovery for accounts that have not completed verification.
- Transactional email delivery through Cloudflare Email Sending.
- Automated deployment after CI passes, including backend and Worker health checks.
- Image storage accounting, per-user quotas, and tooling to backfill existing R2
  objects into the usage ledger.

### Changed

- Production now requires an independent `EMAIL_VERIFICATION_SECRET` instead of
  silently sharing the session-signing secret.
- Deployment updates the backend and database migration path before publishing the
  new SPA and Worker.
- First-party images render through the same-origin `/images/...` route while export
  formats retain their public CDN URLs.

### Fixed

- Image cleanup rechecks live document references before deleting R2 objects and
  purges CDN cache entries after deletion.
- Newly uploaded images recover from transient load failures instead of remaining in
  a permanent broken-image state.
- Image quota accounting now records the correct byte count and reclaims usage after
  images are no longer referenced.
- Registration no longer consumes a verification code when account creation fails.

### Security

- Verification codes are stored as HMAC values, consumed transactionally, and
  protected against concurrent reuse.
- Login and registration endpoints enforce rate limits and request-body limits.
- Production responses include CSP, HSTS, frame, MIME-sniffing, and referrer-policy
  protections.

## [0.1.0] - 2026-08-10

### Added

- Initial open-source release of the React, TipTap, Go, PostgreSQL, and Cloudflare
  Worker application.
- WYSIWYG Markdown editing with tabs, folders, autosave, code highlighting, tables,
  task lists, and KaTeX formulas.
- Cloudflare R2 image uploads, remote-image rehosting, and asynchronous orphan
  cleanup.
- Link and password-protected document sharing.
- Markdown, HTML, DOCX, PDF, print, and WeChat Official Account exports.
- Chinese, English, Japanese, and French interfaces with light and dark themes.
- Password login plus Google and GitHub OAuth.
- CI, secret-hygiene checks, MIT licensing, and bilingual project documentation.
