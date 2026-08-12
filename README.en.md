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

[中文](README.md) · [Changelog](CHANGELOG.md) · [Design notes](docs/DESIGN.en.md) · [MIT License](LICENSE)

[![CI](https://github.com/moutsea/koinote/actions/workflows/ci.yml/badge.svg)](https://github.com/moutsea/koinote/actions/workflows/ci.yml)

</div>

---

## What it is

A Typora-style Markdown editor in the browser: no split pane, no preview toggle —
what you type turns into typeset text as you go.

Three things set it apart from a local editor: **paste an image and it uploads**
(to your own R2 bucket, so the document holds a clean URL rather than a wall of
base64), **export for WeChat** (15 typographic themes, styles inlined into the
form the WeChat editor accepts), and **documents live in the cloud** (multi-device,
shareable).

> The current open-source scope covers editing, image hosting, export, sharing,
> and the account flow. AI features are still planned; a one-time lifetime membership
> is available through Stripe Checkout.

## Features

**Editing**

- WYSIWYG, no split preview. Headings, lists, quotes, tables, task lists, code blocks
- Syntax highlighting for 37 languages (highlight.js `common` set)
- LaTeX via KaTeX — inline `$…$` and block `$$…$$`, click a formula to edit its source
- Tabs for several open documents, outline navigation, folder tree, drag to move
- Debounced autosave that reports failures instead of silently dropping content

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

| Format | Notes |
|---|---|
| Markdown | As-is |
| HTML | One HTML file with embedded document styles; KaTeX CSS and images remain external |
| DOCX | Built from the document tree; formulas keep their LaTeX source |
| PDF | One-click download (rasterized) |
| Print / Save as PDF | Vector text — selectable and searchable |
| **WeChat** | 15 themes, styles inlined to the clipboard, paste straight in |

The WeChat path needed real work: highlighting is regenerated at export time
(in-editor highlighting is a view decoration and never enters the document),
indentation is carried by non-breaking spaces plus `<br>` (WeChat strips
`white-space`), code blocks get macOS-style window dots, and formulas are
rasterized and uploaded as images.

**Sharing**

- Two levels: anyone with the link, or password required
- Loosening permissions forces a new token, so old links stop working immediately
- Passwords stored as bcrypt hashes, with two layers of rate limiting

**Also**

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
  site storage, 30-day growth, and recent accounts and payments
- Optional Cloudflare Analytics metrics for today's edge UV, PV, requests, and bandwidth

## Stack

```
Browser ──▶ Cloudflare Worker ──┬─ serves the SPA assets
                                ├─ /api/images/* and /images/* ──▶ R2
                                ├─ /api/internal/email/* ──▶ Email Sending
                                └─ other /api/* ──▶ Go backend ──▶ PostgreSQL
Go backend ── internal callbacks ──▶ Worker (verification email / R2 cleanup)
Browser ── Stripe Checkout ────────▶ Stripe ── signed webhook ──▶ Go backend ──▶ Feishu bot
```

- **Frontend** Vite · React 19 · TypeScript · TanStack Router · Tailwind v4
- **Editor** TipTap v3 (ProseMirror) · tiptap-markdown · KaTeX · lowlight
- **Backend** Go (stdlib `net/http`) · pgx · Stripe Go SDK · PostgreSQL 16
- **Edge** Cloudflare Worker · R2 · Email Sending

Sessions are stateless HMAC-SHA256 signed cookies — nothing stored in the database.

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

Store the endpoint signing secret as `STRIPE_WEBHOOK_SECRET`. Users can choose
USD 3.99, CNY 29, EUR 3.99, or JPY 600. Before granting access, the backend retrieves
the Checkout Session again and validates paid status, the selected currency's exact
amount, the configured Product ID, and Koinote user ownership. Success-page confirmation
and the webhook share one idempotent database transaction.

Payment notifications can reuse Kimiseek's Feishu bot settings: configure the same
`BOT_WEBHOOK` and `BOT_WEBHOOK_SECRET` values in production. Messages contain only the
internal user ID, amount, currency, and order identifiers — never the email address or
document content. The payment row persists notification state across success-page,
webhook, and Stripe retries; temporary Feishu failures are retried with backoff without
rolling back an already committed membership entitlement.

Checkout does not hardcode payment methods. Stripe dynamically selects from the methods
enabled in Dashboard according to account country, customer location, and currency. Enable
Alipay and WeChat Pay in Stripe Dashboard to offer them; Stripe can still show card only
when its eligibility or currency rules exclude a method.

When the Stripe account is shared, Koinote tags both Checkout Sessions and PaymentIntents
with `metadata.service=koinote`. The webhook acknowledges and ignores events for other
services, then validates the service tag again together with Product, amount, currency,
and ownership before granting membership.

Verify onboarding with `npx wrangler email sending list` and
`npx wrangler email sending dns get "$KOINOTE_DOMAIN"`. Email Sending intentionally
places its bounce MX and SPF records on `cf-bounce.<domain>` and DKIM on
`cf-bounce._domainkey.<domain>`; no root-domain MX only means the root domain does not
receive mail and does not indicate that sending is disabled.

Serving images over a CDN (optional, saves Worker requests) is covered in the
[design notes](docs/DESIGN.en.md#serving-images-over-a-cdn).

### Continuous deployment

`.github/workflows/deploy.yml` deploys and health-checks the backend first on every
push to `main` once CI passes, then deploys the Worker and SPA and checks the site
(`/api/images/config`).

Required repository secrets:

| Secret | Purpose |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Deployment needs Workers Scripts, R2, and Routes edit; add Email Sending edit if the token also onboards the sending domain |
| `CLOUDFLARE_ACCOUNT_ID` | Shown by `wrangler whoami` |
| `CLOUDFLARE_ZONE_ID` | Zone hosting the image CDN, used for cache purge after deletion |
| `CLOUDFLARE_CACHE_PURGE_TOKEN` | Token limited to Zone / Cache Purge |
| `CLOUDFLARE_ANALYTICS_TOKEN` | Optional; Analytics Read limited to the target zone, used for Admin UV/PV |
| `EMAIL_VERIFICATION_SECRET` | Independent verification-code HMAC key, written safely to the VPS `.env` |
| `STRIPE_SECRET_KEY` | Stripe server key; start with `sk_test_...`, switch to live mode before real charges |
| `STRIPE_WEBHOOK_SECRET` | Signing secret for `/api/billing/webhook` (`whsec_...`) |
| `STRIPE_LIFETIME_PRODUCT_ID` | Lifetime Product ID (`prod_...`); amounts come from the backend allowlist |
| `BOT_WEBHOOK` | Optional Feishu group-bot webhook; uses the same variable name as Kimiseek |
| `BOT_WEBHOOK_SECRET` | Optional Feishu bot signing secret; must be configured together with `BOT_WEBHOOK` |
| `VPS_HOST` | Backend server address |
| `VPS_SSH_KEY` | Deploy-only private key (generate a dedicated one, don't reuse your personal key) |
| `VPS_HOST_KEY` | The server's known_hosts entry, used to pin the host key |

To create or rotate the verification-code secret, run this from the repository:

```bash
openssl rand -base64 48 | tr -d '\n' | gh secret set EMAIL_VERIFICATION_SECRET
gh secret list --app actions | grep '^EMAIL_VERIFICATION_SECRET'
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
so verification and Stripe secrets do not need to be copied into the production `.env`
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
- [Design notes](docs/DESIGN.en.md) — why things are built this way, which traps
  we hit, and which degradations are deliberate
- [设计文档（中文）](docs/DESIGN.zh.md)

## License

[MIT](LICENSE)
