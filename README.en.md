<div align="center">

<!-- logo.png is near-black ink (mean brightness 3/255) and vanishes on GitHub's
     dark theme. <picture> switches by theme; GitHub honours prefers-color-scheme. -->
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="public/logo-dark.png">
  <img src="public/logo.png" alt="Koinote" width="96" height="96">
</picture>

# Koinote

**A WYSIWYG Markdown editor for the web**

Renders as you type, uploads images straight to your own bucket,
exports and shares in one click.

**[koinote.app](https://koinote.app)** — try it without deploying anything

[中文](README.md) · [Web changelog](https://koinote.app/changelog) · [CHANGELOG.md](CHANGELOG.md) · [Roadmap](docs/ROADMAP.en.md) · [Design notes](docs/DESIGN.en.md) · [MIT License](LICENSE)

[![CI](https://github.com/moutsea/koinote/actions/workflows/ci.yml/badge.svg)](https://github.com/moutsea/koinote/actions/workflows/ci.yml)

</div>

---

## What it is

A Typora-style Markdown editor in the browser: no split pane, no preview toggle —
what you type turns into typeset text as you go.

Four things set it apart from a local editor: **paste an image and it uploads**
(to your own R2 bucket, so the document holds a clean URL rather than a wall of
base64), **export to publishing platforms** (rich text for WeChat and Zhihu, Markdown
for Juejin), and **documents live in the cloud** (multi-device, shareable), plus
**safe MCP access for Codex, Claude Code, OpenCode, OpenClaw, and other agents**.

The repository also contains an alpha macOS / Windows client built with Tauri 2. It writes to
local SQLite first and syncs when the network returns. Sign-in stays in the system browser and
returns a short-lived desktop session through `koinote://auth` with PKCE.

Download the desktop client through the [Koinote download link](https://koinote.app/download),
which redirects to the latest GitHub Release. Releases include macOS Apple Silicon, macOS Intel,
and Windows x64 installers plus SHA-256 checksums. Alpha installers are currently unsigned, so the
operating system will show a security warning on first launch.

> The current open-source scope covers editing, image hosting, export, sharing,
> and the account flow. AI features are still planned; a one-time lifetime membership
> is available through Stripe Checkout.

## Features

**Editing**

- WYSIWYG, no split preview. Headings, lists, quotes, tables, task lists, code blocks
- Syntax highlighting for 37 languages (highlight.js `common` set)
- LaTeX via KaTeX — inline `$…$` and block `$$…$$`, click a formula to edit its source
- Tabs for several open documents, outline navigation, folder tree, drag to move
- A mobile document drawer, while desktop keeps the resizable document tree
- Global title and Markdown-body search with `⌘K` / `Ctrl+K` and highlighted matches
- Debounced autosave that reports failures instead of silently dropping content
- Revision-based optimistic locking detects concurrent browser and agent edits; conflicts
  keep the local draft and open an explicit merge UI
- Lifetime members can inspect and restore history, enable or disable regular snapshots,
  keep 1–100 versions per document, and choose whether MCP writes keep full history.
  Agent writes still retain the latest safety snapshot when full history is off
  (100 versions per account in total)

**MCP and membership**

- The home page and public `/docs/mcp` guide explain client setup, authorization,
  conflict protection, and recovery for Codex, Claude Code, OpenCode, and OpenClaw
- A public `/pricing` page compares Free and Lifetime benefits and reads the current
  multi-currency Stripe price allowlist from the backend
- Free includes 500 MB by default; one-time Lifetime access adds 10 GB, MCP, version
  history, and eligibility for future AI capabilities

**Account security**

- Password accounts can recover access by email code and change their password while signed in
- Changing or resetting a password immediately invalidates old sessions on other devices;
  users can also explicitly sign out other devices
- Recovery requests return the same result for unknown and OAuth-only accounts, while codes
  are stored only as HMAC values

**Desktop client (alpha)**

- macOS and Windows share the React / TipTap UI; Tauri supplies the native window, SQLite, deep links, and OS keychain
- Documents, folders, and tabs are local-first, including offline create, edit, search, and organization
- Desktop navigation exposes the MCP/version-history guides and Pricing; online users can manage MCP tokens and start Checkout, while admins can read site statistics; account-security and permanent-deletion actions continue in the system browser
- The web and desktop editors check for remote changes while foregrounded and immediately on focus; clean documents update automatically, while local drafts require conflict resolution
- Revision conflicts retain both local and cloud copies for an explicit choice instead of silently applying last-write-wins
- OAuth and password sign-in stay in the system browser; PKCE codes are single-use, access tokens last 15 minutes, and rotating refresh tokens last 30 days
- Access tokens, refresh tokens, and pending PKCE verifiers stay in macOS Keychain or Windows Credential Manager, never SQLite

**Image hosting**

- Paste or drop to upload to Cloudflare R2
- Remote images pasted from the web are re-hosted automatically, so they don't
  break when the original site deletes them
- Real file type sniffed from magic bytes; SVG is rejected outright (it can embed scripts)
- Per-user quota (500 MB for free accounts by default, 10 GB for lifetime members,
  plus up to 5 GB of invitation bonuses; all quotas cover document text and images)
- First-party images use the same-origin `/images/...` path in the web UI while
  exports keep CDN URLs, avoiding false CORS / Local Network Access blocks
- Images no longer referenced by documents are reclaimed asynchronously; references
  are rechecked before deletion and CDN caches are purged

**Export**

| Format                   | Notes                                                                             |
| ------------------------ | --------------------------------------------------------------------------------- |
| Markdown                 | As-is                                                                             |
| HTML                     | One HTML file with embedded document styles; KaTeX CSS and images remain external |
| DOCX                     | Built from the document tree; formulas keep their LaTeX source                    |
| PDF                      | One-click download (rasterized)                                                   |
| Print / Save as PDF      | Vector text — selectable and searchable                                           |
| **Publishing platforms** | Rich text for WeChat / Zhihu; native Markdown for Juejin                          |

My Documents also provides bulk portability: import individual `.md` files, folders with
images, or ZIP archives, and export every document, folder, and referenced image as a ZIP that
Koinote can import again.

The rich-text path needed real work: highlighting is regenerated at export time
(in-editor highlighting is a view decoration and never enters the document),
indentation is carried by non-breaking spaces plus `<br>` (WeChat strips
`white-space`), code blocks get macOS-style window dots, and formulas are
rasterized and uploaded as images.

**Sharing**

- Two levels: anyone with the link, or password required
- Loosening permissions forces a new token, so old links stop working immediately
- Passwords stored as bcrypt hashes, with two layers of rate limiting
- Dynamic page titles and OpenGraph cards, aggregate read counts, and “Copy to my Koinote”
- Password-protected metadata hides the title, summary, and cover until unlock; view counts do not identify readers

**Also**

- A public `/changelog` page renders the repository's `CHANGELOG.md` as a timeline of additions,
  improvements, security changes, and fixes
- UI in Chinese, English, Japanese, and French
- Light and dark themes, ink-wash visual style
- Verified email registration and password login, plus Google and GitHub OAuth
- Personal invitation links that grant both users 500 MB of permanent cloud storage
  when a new account is created, capped at 5 GB of invitation bonuses per account
- Multi-currency lifetime membership via one-time Stripe payment in USD / CNY / EUR / JPY,
  with card, Alipay, and WeChat Pay support
- Optional Feishu bot notifications after the first successful payment record, deduplicated
  across success-page confirmation and Stripe webhook delivery
- Administrator dashboard for user/member totals, per-currency revenue, orders,
  site storage, 30-day growth, product funnels, D1/D7/D30 retention, and recent activity
- Optional Cloudflare Analytics metrics for today's edge UV, PV, requests, and bandwidth
- Streamable HTTP MCP access for lifetime members to let Codex, Claude Code, and other
  agents work with their own documents

## Stack

```
Browser ──▶ Cloudflare Worker ──┬─ serves the SPA assets
                                ├─ /api/images/* and /images/* ──▶ R2
                                ├─ /api/internal/email/* ──▶ Email Sending
                                └─ other /api/* and /mcp ──▶ Go backend ──▶ PostgreSQL
Go backend ── internal callbacks ──▶ Worker (verification email / R2 cleanup)
PostgreSQL ── pg_dump / AES-256-GCM ──▶ private backup R2 (every 6 hours)
Browser ── Stripe Checkout ────────▶ Stripe ── signed webhook ──▶ Go backend ──▶ Feishu bot
Desktop ── local SQLite ───────────▶ offline writes ── sync / Bearer token ──▶ Worker / Go backend
```

- **Frontend** Vite · React 19 · TypeScript · TanStack Router · Tailwind v4
- **Editor** TipTap v3 (ProseMirror) · tiptap-markdown · KaTeX · lowlight
- **Backend** Go (stdlib `net/http`) · pgx · Stripe Go SDK · PostgreSQL 16
- **Edge** Cloudflare Worker · R2 · Email Sending
- **Desktop** Tauri 2 · Rust · SQLite · macOS Keychain / Windows Credential Manager

Browser sessions use stateless HMAC-SHA256 signed cookies. Desktop sessions use opaque access and
refresh tokens whose SHA-256 hashes are stored in PostgreSQL so rotation, revocation, and password-change
invalidation remain authoritative.

## Agent document access (MCP)

Lifetime members can create a personal access token (PAT) in the Dashboard's
“Agent document access (MCP)” card and connect any Streamable HTTP MCP client to
`https://koinote.app/mcp`. The public [MCP guide](https://koinote.app/docs/mcp)
covers Codex, Claude Code, OpenCode, OpenClaw, WorkBuddy, generic clients, and version
control. Koinote itself only handles authorization, document I/O,
versioning, and audit metadata. It **does not call an LLM and needs no OpenAI,
Anthropic, or other model API key**; Codex or Claude Code supplies the model capability.

PATs have read or write scope, a 1–365 day or permanent lifetime, editable expiry,
and individual revocation.
PostgreSQL authenticates with a SHA-256 hash and keeps a separate AES-GCM-encrypted
recovery copy. The account owner can reveal it on demand, while list responses never
include complete tokens. Every MCP request rechecks membership, expiry, and revocation.
Prefer a read-only token unless the client actually needs to modify documents.

Configure Codex without committing the token:

```bash
export KOINOTE_MCP_TOKEN='knt_mcp_...'
```

```toml
# ~/.codex/config.toml
[mcp_servers.koinote]
url = "https://koinote.app/mcp"
bearer_token_env_var = "KOINOTE_MCP_TOKEN"
```

Claude Code:

```bash
claude mcp add --transport http koinote https://koinote.app/mcp \
  --header "Authorization: Bearer knt_mcp_..."
```

OpenCode (put this in a global or project-level `opencode.json`; see the
[official MCP documentation](https://opencode.ai/docs/mcp-servers/)):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "koinote": {
      "type": "remote",
      "url": "https://koinote.app/mcp",
      "oauth": false,
      "headers": {
        "Authorization": "Bearer {env:KOINOTE_MCP_TOKEN}"
      }
    }
  }
}
```

OpenClaw:

```bash
openclaw mcp add koinote \
  --url https://koinote.app/mcp \
  --transport streamable-http \
  --header "Authorization=Bearer ${KOINOTE_MCP_TOKEN}"

openclaw mcp doctor koinote --probe
```

Other clients need no Koinote-specific integration. They can connect with the same endpoint and
token when they support remote Streamable HTTP MCP plus an
`Authorization: Bearer <PAT>` request header.

Read tools page through documents, search titles and Markdown bodies, read Unicode-safe content chunks, inspect
retained versions, and list the trash. Write tokens additionally expose create, append,
full replace, version restore, move to trash, and restore from trash. Agents cannot
permanently delete documents: that action remains in the browser trash page behind a typed-title
confirmation, while normal deletion retains documents for 30 days. Replace, append, trash,
and restore require the latest
revision; the browser editor uses the same optimistic lock and offers a local/remote merge
UI on conflict. See the [design notes](docs/DESIGN.en.md#mcp-document-access) for the
trade-offs.

## Quick start

You'll need Node 20.19+ (or 22.12+), Go 1.23+, and Docker Compose.

```bash
git clone https://github.com/moutsea/koinote.git && cd koinote
cp .env.example .env
```

**Two values in `.env` are required:**

```bash
# 1. Session signing key (the backend refuses to start without it)
openssl rand -base64 48

# 2. Worker → backend internal token
openssl rand -base64 36 | tr '+/' '-_' | tr -d '='
```

Put those into `SESSION_SECRET` and `BACKEND_INTERNAL_TOKEN`, and set `NODE_ENV`
to `development` — local dev runs over http, and `production` marks the cookie
`Secure`, which means it won't stick. Set `ENABLE_MOCK_EMAIL=true` for local
email-registration testing; the form fills the development code without sending mail.

Then:

```bash
npm ci
docker compose up -d postgres         # database
npm run backend:dev                   # backend (runs migrations automatically)
npm run dev                           # frontend → http://localhost:5273
```

Image upload needs wrangler as well — the R2 binding only exists on the Worker
side, and wrangler ships a local emulation:

First create an ignored `.dev.vars` file at the repository root:

```dotenv
BACKEND_INTERNAL_TOKEN=<the same value used in .env>
```

Then start the Worker:

```bash
npx wrangler dev --port 8788
```

The local Worker proxies to `http://localhost:8080` by default. If the backend uses
another port, override it with `--var BACKEND_URL:http://localhost:<port>`; changing
`.env` alone does not pass the value to Wrangler.

To test membership locally, put a Stripe test-mode `STRIPE_SECRET_KEY` and
`STRIPE_LIFETIME_PRODUCT_ID` in `.env`. The backend creates an inline allowlisted
price for that Product: USD 3.99, CNY 29, EUR 3.99, or JPY 600. The success return
confirms and grants the entitlement directly. To test webhooks too, install Stripe CLI:

```bash
stripe listen --forward-to localhost:8080/api/billing/webhook
```

Copy its `whsec_...` value into `STRIPE_WEBHOOK_SECRET`, restart the backend, and use
Stripe's test card `4242 4242 4242 4242` with any future expiry and CVC.

For the full walkthrough, port conflicts, and all-in-Docker startup, see the
[design notes](docs/DESIGN.en.md#local-development).

### Desktop development

Install stable Rust as well. macOS needs Xcode Command Line Tools; Windows needs the Microsoft C++
Build Tools and WebView2. Start PostgreSQL, the Go backend, and Vite as described above, then run:

```bash
npm run desktop:dev       # Tauri window; the browser returns through koinote://auth
npm run desktop:check     # Rust / Tauri compile check
npm run desktop:build     # installer for the current platform
```

Production builds sync with `https://koinote.app`; development defaults to
`http://localhost:5273`. SQLite never stores tokens, and signing out clears that account's
offline document cache from the machine.

## Before you self-host

These directly affect security. Worth reading before you deploy.

**`SESSION_SECRET` is required, with no fallback.** The backend refuses to start
without it, deliberately. It used to fall back to a hardcoded constant — which in
an open-source repository means publishing your signing key.

**Generate your own `BACKEND_INTERNAL_TOKEN`; never use an example value.** This
header lets the bearer impersonate any user: the backend trusts `X-Auth-User-Id`
on sight and skips session validation, so it is effectively a site-wide admin
credential. `.env.example` deliberately leaves it blank.

**Production requires a separate `EMAIL_VERIFICATION_SECRET`.** The backend refuses
to reuse `SESSION_SECRET` in production, so rotating verification keys does not log
everyone out and an email-path secret leak cannot become session forgery.

**Production Stripe configuration must be complete.** If any of `STRIPE_SECRET_KEY`,
`STRIPE_WEBHOOK_SECRET`, or `STRIPE_LIFETIME_PRODUCT_ID` is set, all three are required.
The database membership tier is the entitlement source of truth; no frontend response
can grant the 10 GB quota directly.

**`NODE_ENV` controls the cookie's `Secure` flag.** It must be `production` in production.

**Images are readable by anyone who has the URL.** Keys are random and
unguessable, but there is no authorization check — if a link to an image in a
private document leaks, anyone can view it. This is normal for image hosting, but
users generally assume images in a private document are private too. If that
doesn't work for your case, switch to signed URLs.

**Rate limiting is per-process.** Across multiple instances each process counts
separately, so effective thresholds multiply by N. Move it to shared rate-limit
storage before scaling out.

**Rebuild the image after changing backend code.** `docker compose up -d` does not
rebuild; use `docker compose up -d --build backend`. Otherwise the code changes
and the behaviour doesn't, with no error to tell you.

## Deploy

```bash
npm run build     # → spa/dist
npm run deploy    # build and deploy the production Worker + SPA, not the backend
```

For the first backend deployment, configure `.env` and `deploy/Caddyfile` on the VPS,
then run this from the repository root:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

The production `.env` should set `POSTGRES_PORT=127.0.0.1:5432` and
`BACKEND_PORT=127.0.0.1:8080`, plus `NODE_ENV=production`, `APP_URL`, `WORKER_URL`,
and the session/OAuth credentials. The checked-in `koinote.app`, `api.koinote.app`, `img.koinote.app`, and
`verify@koinote.app` values belong to the hosted deployment; self-hosters must update
`wrangler.jsonc`, `deploy/Caddyfile`, and their OAuth callback configuration together.

Secrets required by the production Worker:

```bash
npx wrangler secret put BACKEND_URL --env production
npx wrangler secret put BACKEND_INTERNAL_TOKEN --env production   # same as the backend
npx wrangler secret put CLOUDFLARE_ZONE_ID --env production
npx wrangler secret put CLOUDFLARE_CACHE_PURGE_TOKEN --env production
```

`BACKEND_URL` must point to the HTTPS backend origin, such as
`https://api.koinote.app`; `BACKEND_INTERNAL_TOKEN` must exactly match the VPS `.env`.

The last two secrets purge the image CDN after deletion; switching to Worker-proxied
images also requires changing `IMAGE_PUBLIC_BASE` and the deployment workflow. Email
registration uses Cloudflare Email Sending. Onboard the domain before the first deployment:

```bash
KOINOTE_DOMAIN=koinote.app
npx wrangler email sending enable "$KOINOTE_DOMAIN"
```

The Worker sends from `verify@koinote.app` through the `EMAIL` binding, so no email API
token is needed. Set `WORKER_URL=https://koinote.app` in the VPS `.env`, with the same
`BACKEND_INTERNAL_TOKEN` as the Worker, plus an independent
`EMAIL_VERIFICATION_SECRET`. Verification codes are stored only as HMACs in Postgres
and expire after 10 minutes.

### Off-site PostgreSQL backup and recovery

`database-backup` is an opt-in Compose profile. Every six hours it creates a compressed
PostgreSQL 16 custom-format dump, encrypts it with CMS AES-256-GCM and a recovery certificate,
then uploads it through an internal-only endpoint to a separate private R2 bucket. Failures retry
after 15 minutes and, when Feishu is configured, alert at most once every six hours. Retention keeps
all recent 28 copies, one per day through day 35, one per week through day 180, and one per month
through day 400. A healthy installation therefore has an RPO of roughly six hours.

This backs up PostgreSQL data only (accounts, documents, billing, and the image ledger); it does
**not copy image objects from `koinote-images`**. Do not expose the backup bucket through public
access or a custom domain. One encrypted dump is limited to 95 MiB to remain within normal
Cloudflare request-body limits; move to multipart or direct R2 S3 uploads before reaching it.

Before enabling the profile, create the private bucket and a recovery key that only operators hold.
The checked-in certificate belongs to the hosted deployment, so self-hosters must replace it with
their own public certificate. Keep at least one offline copy of the private key and never put it on
the VPS, in the image, or in Git:

```bash
mkdir -p ~/.koinote-backup
chmod 700 ~/.koinote-backup
openssl req -x509 -newkey rsa:4096 -nodes -sha256 -days 3650 \
  -subj '/CN=Koinote Database Backup' \
  -keyout ~/.koinote-backup/database-backup-private-key.pem \
  -out deploy/database-backup/database-backup-certificate.pem
chmod 600 ~/.koinote-backup/database-backup-private-key.pem
npx wrangler r2 bucket create koinote-backups
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build database-backup
```

For recovery, download the object, compare its SHA-256 with the
`X-Koinote-Backup-Sha256` response header, decrypt it, and validate its catalog. Restore into a new,
empty database first; check user/document counts and migration state before a controlled cutover
instead of overwriting the live database:

```bash
read -rsp 'Internal token: ' KOINOTE_INTERNAL_TOKEN; echo
BACKUP_NAME=koinote-2026-08-16T1200Z.dump.cms
curl -fsS -D backup.headers \
  -H "X-Koinote-Internal-Token: $KOINOTE_INTERNAL_TOKEN" \
  "https://koinote.app/api/internal/backups/database/$BACKUP_NAME" \
  -o "$BACKUP_NAME"
unset KOINOTE_INTERNAL_TOKEN
grep -i '^x-koinote-backup-sha256:' backup.headers
sha256sum "$BACKUP_NAME"
openssl cms -decrypt -binary -inform DER \
  -in "$BACKUP_NAME" \
  -recip deploy/database-backup/database-backup-certificate.pem \
  -inkey ~/.koinote-backup/database-backup-private-key.pem \
  -out koinote.dump
pg_restore --list koinote.dump >/dev/null
createdb koinote_restore
pg_restore --exit-on-error --no-owner --no-privileges \
  --dbname koinote_restore koinote.dump
```

`GET /api/internal/backups` with the same internal token reports the object count and latest upload,
size, and checksum.

The Admin link is shown only to users whose database row has `is_admin=true`. Grant the
first administrator by email after deployment:

```bash
docker compose exec postgres psql -U koinote -d koinote \
  -c "UPDATE users SET is_admin = true WHERE lower(email) = lower('you@example.com');"
```

User, membership, revenue, order, and storage metrics on `/admin` come from PostgreSQL.
Today's UV and PV are optional Cloudflare edge HTTP Analytics. Create a dedicated token
with `Zone / Analytics / Read`, restricting Zone Resources to the Koinote
zone, and store it as `CLOUDFLARE_ANALYTICS_TOKEN`. Do not reuse the cache-purge-only
`CLOUDFLARE_CACHE_PURGE_TOKEN`. If the token is absent or Cloudflare is temporarily
unavailable, only the traffic cards degrade; the business metrics remain available.

Create this endpoint in Stripe Dashboard and subscribe it to
`checkout.session.completed` and `checkout.session.async_payment_succeeded`:

```text
https://koinote.app/api/billing/webhook
```

Store the endpoint signing secret as `STRIPE_WEBHOOK_SECRET`. To offer Alipay and WeChat
Pay, enable them in Stripe Dashboard — payment methods are not hardcoded, so Stripe picks
from the enabled set by account country, customer location, and currency, falling back to
card only when its rules exclude a method. Amount validation, idempotency, and sharing one
Stripe account across services are covered in the
[design notes](docs/DESIGN.en.md#membership-and-billing).

To get a Feishu message on each payment, set `BOT_WEBHOOK` and `BOT_WEBHOOK_SECRET`
together (configuring only one makes production refuse to start). Messages carry just the
internal user ID, amount, currency, and order identifiers; failures retry with backoff and
never affect an already granted entitlement.

Verify onboarding with `npx wrangler email sending list` and
`npx wrangler email sending dns get "$KOINOTE_DOMAIN"`. Email Sending intentionally
places its bounce MX and SPF records on `cf-bounce.<domain>` and DKIM on
`cf-bounce._domainkey.<domain>`; no root-domain MX only means the root domain does not
receive mail and does not indicate that sending is disabled.

Serving images over a CDN (optional, saves Worker requests) is covered in the
[design notes](docs/DESIGN.en.md#serving-images-over-a-cdn).

### Continuous deployment

`.github/workflows/deploy.yml` deploys and health-checks the backend first on every
push to `main` once CI passes, then deploys the Worker and SPA, verifies the first off-site database
backup, and checks the site (`/api/images/config`).

Required repository secrets:

| Secret                         | Purpose                                                                                                                     |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`         | Deployment needs Workers Scripts, R2, and Routes edit; add Email Sending edit if the token also onboards the sending domain |
| `CLOUDFLARE_ACCOUNT_ID`        | Shown by `wrangler whoami`                                                                                                  |
| `CLOUDFLARE_ZONE_ID`           | Zone hosting the image CDN, used for cache purge after deletion                                                             |
| `CLOUDFLARE_CACHE_PURGE_TOKEN` | Token limited to Zone / Cache Purge                                                                                         |
| `CLOUDFLARE_ANALYTICS_TOKEN`   | Optional; Analytics Read limited to the target zone, used for Admin UV/PV                                                   |
| `EMAIL_VERIFICATION_SECRET`    | Independent verification-code HMAC key, written safely to the VPS `.env`                                                    |
| `MCP_TOKEN_ENCRYPTION_KEY`     | Encryption key for recoverable MCP access tokens; keep it stable or old tokens cannot be revealed                           |
| `STRIPE_SECRET_KEY`            | Stripe server key; start with `sk_test_...`, switch to live mode before real charges                                        |
| `STRIPE_WEBHOOK_SECRET`        | Signing secret for `/api/billing/webhook` (`whsec_...`)                                                                     |
| `STRIPE_LIFETIME_PRODUCT_ID`   | Lifetime Product ID (`prod_...`); amounts come from the backend allowlist                                                   |
| `BOT_WEBHOOK`                  | Optional Feishu group-bot webhook; uses the same variable name as Kimiseek                                                  |
| `BOT_WEBHOOK_SECRET`           | Optional Feishu bot signing secret; must be configured together with `BOT_WEBHOOK`                                          |
| `VPS_HOST`                     | Backend server address                                                                                                      |
| `VPS_SSH_KEY`                  | Deploy-only private key (generate a dedicated one, don't reuse your personal key)                                           |
| `VPS_HOST_KEY`                 | The server's known_hosts entry, used to pin the host key                                                                    |

To create or rotate the verification-code secret, run this from the repository:

```bash
openssl rand -base64 48 | tr -d '\n' | gh secret set EMAIL_VERIFICATION_SECRET
gh secret list --app actions | grep '^EMAIL_VERIFICATION_SECRET'
openssl rand -base64 48 | tr -d '\n' | gh secret set MCP_TOKEN_ENCRYPTION_KEY
```

Set the Stripe values interactively with `gh secret set STRIPE_SECRET_KEY`,
`gh secret set STRIPE_WEBHOOK_SECRET`, and `gh secret set STRIPE_LIFETIME_PRODUCT_ID`
so credentials do not enter shell history.
Set Feishu notifications with `gh secret set BOT_WEBHOOK` and
`gh secret set BOT_WEBHOOK_SECRET`. If both are absent, deployment preserves any existing
Feishu settings in the VPS `.env`.

The second command shows only the secret name and update time; it cannot read the
secret value. Before deploying, the workflow checks that every required secret exists.
It then updates `/opt/koinote/.env` atomically over stdin before restarting the backend,
so verification, MCP token-encryption, and Stripe secrets do not need to be copied into the production `.env`
manually. The repository secrets must still be set before the first deployment.
The optional Analytics token is written through the same path when configured.

## Tests

```bash
npm test          # typecheck (both sides) + all frontend/Worker assertion suites
npm run go:test   # go vet + go test; DB integration tests skip without TEST_DATABASE_URL
```

On every push and pull request, GitHub Actions also builds both sides and runs
`go test -race` plus SQL PREPARE checks against a real PostgreSQL service. A separate
job checks secret hygiene.

Export and sharing also have Playwright end-to-end scripts — see the
[design notes](docs/DESIGN.en.md#verification).

## Documentation

- [Changelog](CHANGELOG.md) — notable additions, changes, fixes, and security updates
- [Product roadmap](docs/ROADMAP.en.md) — near-term priorities, later directions, and principles
- [Design notes](docs/DESIGN.en.md) — why things are built this way, which traps
  we hit, and which degradations are deliberate
- [产品路线图（中文）](docs/ROADMAP.zh.md)
- [设计文档（中文）](docs/DESIGN.zh.md)

## License

[MIT](LICENSE)
