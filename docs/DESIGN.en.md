# Koinote design notes

This document records **why things are built the way they are** — which trade-offs
were deliberate, which traps we hit, and which degradations were accepted with the
cost understood. For features and setup, see the [README](../README.en.md).

Why write it down: almost every decision here has a wrong version that also _works_.
It just fails months later in ways that are hard to trace — an export that silently
drops content, a rate limiter that locks out the victim, a CDN that is misconfigured
but looks fine. Unrecorded, the next person (including me in three months) walks
into the same hole.

> Chinese is the original of this document: [DESIGN.zh.md](DESIGN.zh.md)

## Contents

- [Architecture](#architecture)
- [Local development](#local-development)
- [Auth and security](#auth)
- [Desktop client](#desktop-client)
- [Invitation rewards](#invitation-rewards)
- [Membership and billing](#membership-and-billing)
- [MCP document access](#mcp-document-access)
- [Search, portability, and product analytics](#search-portability-and-product-analytics)
- [Admin dashboard](#admin-dashboard)
- [Sharing](#sharing)
- [Export](#export)
- [Syntax highlighting and LaTeX](#syntax-highlighting-and-latex)
- [Image hosting](#image-hosting-cloudflare-r2)
- [Verification](#verification)

## Architecture

```
Browser ──▶ Cloudflare Worker (worker/index.ts)
              ├─ serves the Vite-built SPA (spa/dist)
              └─ /api/*, /health, /mcp ──▶ reverse proxy to the Go backend
                                          │
                                    ┌─────▼────────────────────┐
                                    │ docker-compose:          │
                                    │  Go backend + Postgres   │
                                    └──────────────────────────┘
Desktop client ── local SQLite / OS keychain ──▶ Worker / Go backend (Bearer sync)
```

- **Frontend** Vite + React 19 + TypeScript + TanStack Router + react-query + Tailwind v4
- **Editor core** TipTap v3 (ProseMirror family) + tiptap-markdown (lossless Markdown round-trip)
- **Backend** Go (stdlib `net/http`) + pgx; HMAC-SHA256 browser cookies and revocable opaque desktop tokens
- **Database** PostgreSQL 16
- **Deployment** Cloudflare Worker (frontend) + VPS/docker-compose (backend)

## Directory layout

```
spa/          frontend SPA (Vite root)
  src/
    pages/          home / login / dashboard / admin / editor
    components/     AppShell, editor (TipTap)
    api.ts          backend API wrapper (credentials: include)
    auth.ts         session state hook (react-query)
    desktop/        Tauri runtime, PKCE, keychain requests, and SQLite offline sync
src-tauri/    macOS / Windows shell, capabilities, SQLite migration, and app icons
worker/       Cloudflare Worker (API proxy + SPA hosting)
backend/      Go backend
  cmd/server/       entry point
  internal/         config / db / migrations / server(auth,session) / model
  migrations/       SQL migrations
docker-compose.yml  postgres + backend
```

## Local development

You need Node 20.19+ (or 22.12+), Go 1.23+, and Docker Compose.

### 1. Database

```bash
cp .env.example .env
docker compose up -d postgres
```

> ⚠️ **Port conflicts**: if a native PostgreSQL already holds 5432, the container
> can't bind. Set `POSTGRES_PORT=5433` (or any free port) in `.env` and change the
> port in `DATABASE_URL` to match before starting.

### 2. Backend (migrations run automatically)

```bash
npm run backend:dev
# or: cd backend && go run ./cmd/server
```

The backend loads `.env` on startup, searching `./.env`, `../.env`, `../../.env` in
order — so running from the repo root or from `backend/` both work. It listens on
`:8080` and applies `migrations/*.sql`.

Real environment variables take precedence over the `.env` file, so values injected
by docker-compose are never shadowed by stale file contents. The container image has
no `.env` at all; compose injects everything, and a missing file doesn't block startup.

### 3. Frontend

```bash
npm run dev
```

The Vite port comes from `DEV_PORT` in `.env`. `/api/*` and `/health` proxy to the
backend; `/api/images` and `/images` go to wrangler instead, because only the Worker
has the R2 binding.

`strictPort` is on: if the port is taken, we'd rather fail to start than silently
increment — otherwise the OAuth provider redirects to the registered port, lands on
nothing, and the resulting error is very hard to trace.

### Running the production build locally

```bash
npm run build
npx vite preview        # :5274 by default, same proxy config as dev
```

The `preview` proxy block is not optional: without it every `/api` request under
`preview` falls through to the SPA's `index.html`, login fails outright, and the
production build can then only be verified by deploying it.

### Everything in Docker

```bash
npm run docker:up   # postgres + backend all containerized
```

> **Rebuild after changing backend code.** `docker compose up -d` restarts the
> container but does not rebuild the image, so your code changes won't be running.
> Use `docker compose up -d --build backend`. This produces the worst kind of
> confusion — the code is right, the behaviour is old, and nothing reports an error.

## Auth

- Email registration: call `POST /api/auth/verification-code`, then submit the code to
  `POST /api/auth/register`; legacy unverified accounts use `POST /api/auth/verify-email`
- Login / logout / session: `POST /api/auth/{login,logout}`, `GET /api/auth/session`
- Password security: `POST /api/auth/password-reset-code`, `POST /api/auth/password-reset`,
  `POST /api/auth/password`, and `POST /api/auth/sessions/invalidate`
- OAuth: `GET /api/auth/oauth/{google,github}/{start,callback}`
- Session credentials are HMAC-SHA256 signed `koinote_session` cookies
  (HttpOnly / SameSite=Lax / Secure in production). The backend stores only an account-level
  `session_version`, not individual sessions
- Passwords hashed with bcrypt (cost 10); login accepts username or email, case-insensitive
- Verification codes are stored only as HMACs and expire after 10 minutes; consuming
  the code, creating the user, and deleting the code happen in one transaction
- Password recovery uses separate tables and an independent HMAC purpose, so registration
  codes cannot reset a password. Unknown and OAuth-only addresses receive the same response.
  Resetting or changing a password increments `session_version`; password changes reissue the
  current device's cookie, while recovery requires a fresh login
- OAuth accounts are trusted as provider-verified; invitation rewards apply only when a
  genuinely new account is created

### Session key SESSION_SECRET

The HMAC signing key for `koinote_session`. **Required, with no fallback** — the
backend refuses to start if it's empty, in every environment including local.

```bash
openssl rand -base64 48
```

There used to be two levels of fallback: `BACKEND_INTERNAL_TOKEN`, then a hardcoded
constant. Both are gone:

- The hardcoded fallback in an open-source repository means **publishing the signing
  key** — anyone holding that string can mint a session for any user, no password
  needed. A "must be set in production" check existed, but it hung on
  `NODE_ENV=production`, while `.env.example` at the time shipped `development`. Following the
  README verbatim bypassed it. Three individually reasonable decisions combined into
  a deployment that was insecure by default.
- The `BACKEND_INTERNAL_TOKEN` fallback is gone too: that's a lateral Worker →
  backend credential, a different purpose on a different rotation schedule. Sharing
  them means rotating the internal token logs everyone out, and any component that
  can read the internal token also gains the ability to forge any session.

**Changing the key invalidates every issued session** — users must log in again.

The cookie payload includes the account's current `session_version`. Cookies issued before
migration 0021 omit it and are treated as initial version 1, so deployment itself does not log
everyone out. Changing or recovering a password, or choosing “sign out other devices,” increments
the version and immediately rejects all older cookies without maintaining a session table.

### Internal token BACKEND_INTERNAL_TOKEN

Lateral auth from Worker to backend. **Required, generate your own, never use an
example value.**

```bash
openssl rand -base64 36 | tr '+/' '-_' | tr -d '='
```

This header lets the bearer **impersonate any user** — the backend trusts whatever
`X-Auth-User-Id` claims and skips session validation (see `authUserIDFromRequest`).
It is effectively a site-wide admin credential, so don't share a value with
`SESSION_SECRET`.

`.env.example` deliberately leaves it blank. The old example value was
`koinote-internal-dev-token`, which after open-sourcing is a public master key —
and the README's first step is `cp .env.example .env`, so anyone following the docs
would deploy holding it. Verified empirically: that value plus any known
`authUserId`, sent directly to the backend, returns that user's documents (HTTP 200).
An empty token does not create that impersonation path, but Worker ↔ backend calls for
image accounting, image cleanup, and verification-email delivery all stop working.

Three places must match. A mismatch breaks image accounting/cleanup and makes
verification-email delivery return 503:

| Location                                                      | Purpose                                        |
| ------------------------------------------------------------- | ---------------------------------------------- |
| `.env`                                                        | read by the backend, also feeds docker-compose |
| `.dev.vars`                                                   | local `wrangler dev`                           |
| `wrangler secret put BACKEND_INTERNAL_TOKEN --env production` | production Worker                              |

### Rate limiting

| Endpoint                | Dimension    | Threshold                             |
| ----------------------- | ------------ | ------------------------------------- |
| Login                   | IP           | 10 / 15 min                           |
| Login                   | Account      | 100 / 15 min                          |
| Register                | IP           | 5 / hour                              |
| Verification-code send  | Email        | 5 / hour, at least 1 min apart        |
| Verification-code send  | IP           | 20 / hour                             |
| Verification-code check | Email / code | 5 failed attempts                     |
| Password-recovery send  | Email / IP   | 5 / 20 per hour, at least 1 min apart |
| Password-recovery check | Email / code | 5 failed attempts                     |
| Share password check    | IP           | 20 / 15 min                           |
| Share password check    | Link         | 10 / 15 min                           |

Two deliberate choices, both easy to get backwards:

**The account threshold is an order of magnitude above the IP one** (100 vs 10).
Anyone can send failing requests against someone else's account, so if the account
dimension were as tight as the IP one, an attacker could lock any user out for 15
minutes with 10 requests — a denial of service we built ourselves, easier to exploit
than the credential stuffing it prevents. It exists only as a backstop against
distributed stuffing, where many IPs each try a few times and never reach the IP limit.

This was found by a test, not by review: with both thresholds at 10, the assertion
"different IPs don't affect each other" failed. IP B was clean but got blocked
because IP A had exhausted the shared account bucket. The failure exposed a design
flaw, not a bad test.

**Rate limiting sits after input validation**, counting only requests that are
well-formed and actually attempting a credential. Placed first, a user fumbling the
signup form five times (password too short, missing `@`) gets locked out for an hour
without having registered anything. Anti-abuse is unaffected: bulk registration must
send valid requests, and all valid requests are counted.

Login, registration, and sharing use a **per-process** limiter (`ratelimit.go`), while
verification-send counters are also persisted in the database across restarts. Across
multiple instances the in-process buckets still multiply by N, so move them to shared
rate-limit storage before scaling out.

### Security response headers

Added by the Worker at its single exit point (`worker/securityHeaders.ts`): CSP,
HSTS, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`,
`Cross-Origin-Opener-Policy`, `X-Content-Type-Options`.

Wrapped at the entry rather than added per branch: the Worker has many return paths,
and adding them one by one will eventually miss one — with no error to show it,
just an endpoint that quietly lost its protection.

Two places that must not be casually "tightened":

- `style-src` must keep `'unsafe-inline'`. Theme CSS is injected at runtime as a
  `<style>` tag (themes vary per document, so hashes can't be precomputed), and
  KaTeX writes a `style` attribute on every span it renders. Tightening it means
  formulas don't render and themes stop working — and that kind of "broken" usually
  ends with the whole CSP being deleted, which is worse than not having one.
  `script-src` _is_ `'self'` with no `unsafe-inline`.
- HSTS is only sent over https. Sending it over http pins `localhost` to https,
  which makes the dev machine completely unreachable in the browser and can't be
  cleared for the duration of `max-age`.

### OAuth setup

Google and GitHub flows are fully implemented; you only supply credentials (the
start endpoint returns 501 when unconfigured):

```bash
GOOGLE_CLIENT_ID= / GOOGLE_CLIENT_SECRET=
GITHUB_CLIENT_ID= / GITHUB_CLIENT_SECRET=
```

Callback URLs are derived from `APP_URL` and must be registered with each provider:

- Google → `{APP_URL}/api/auth/oauth/google/callback`
- GitHub → `{APP_URL}/api/auth/oauth/github/callback`

`state` is double-checked via a signed cookie plus a nonce, and the return path is
filtered through `sanitizeRedirectPath`, which only permits in-site relative paths.
An existing account with the same email (for example a password signup) is merged
on OAuth login rather than duplicated.

## Desktop client

The desktop app uses Tauri 2 rather than Electron. The React / TipTap UI remains shared with the
web app; Rust only owns capabilities that a browser cannot or should not provide: the native
window, `koinote://` deep links, SQLite, the OS keychain, and single-instance coordination. This
keeps the bundle and idle memory smaller without creating a second editor implementation.

### System-browser sign-in and PKCE

The desktop WebView never collects a password or duplicates Google / GitHub OAuth callbacks:

1. The client generates `state` and a PKCE verifier and temporarily stores them in macOS Keychain or Windows Credential Manager.
2. The system browser opens `/desktop/authorize`; the user signs in with the normal web cookie and explicitly approves access.
3. The backend creates a five-minute, single-use authorization code and stores only its SHA-256 hash plus the code challenge.
4. The browser opens `koinote://auth?code=…&state=…`; the client verifies state before exchanging the verifier for tokens.
5. Access tokens last 15 minutes. Refresh tokens last 30 days and rotate on every use. PostgreSQL stores only token hashes; plaintext stays in the OS keychain. Revocation, password changes, and “sign out other devices” all take effect through `session_version`.

The backend applies an explicit allowlist to desktop bearer tokens. They can reach only the editing,
organization, sharing, storage-usage, and read-only membership endpoints needed by the app; Checkout,
MCP-token management, admin, password/session-security operations, and permanent deletion remain forbidden.

Deep links are untrusted input, so both sides validate the code, state, client ID, and PKCE alphabet.
Windows launches another process for a deep link; the single-instance plugin forwards that URL to
the existing window.

### Local-first synchronization

SQLite stores per-account documents, folders, tabs, pending state, and conflict snapshots, but no
tokens. New documents and folders receive UUID v4 IDs locally. The backend lets an authenticated
desktop client submit those IDs and treats a content-identical retry as success, so losing a response
after the server commits does not create a duplicate document.

Document sync keeps three counters: `local_revision` for editor-side local CAS, `base_revision` for
the last confirmed server revision, and `change_seq` to reject delayed network responses. A server
acknowledgement cannot move the local revision backwards. A pull may update SQLite only while base,
state, and change sequence still match the snapshot taken before the request; typing while it is in
flight therefore survives. If both bodies changed, the complete local and cloud copies are retained
for an explicit choice. Folders have no server revision yet, so a conflicting local folder mutation
remains pending and is replayed on the next pass.

While visible, the web app refreshes document revisions every 30 seconds and checks immediately when
the window regains focus; it fetches a full body only after a revision changes. The desktop client runs
the same foreground cadence as a silent sync and flushes the editor debounce window into SQLite before
applying remote content. Clean documents adopt the remote version automatically. Concurrent local drafts
retain both copies and prompt the user, without flashing the visible sync status on every background check.

The alpha's offline boundary is Markdown content, folders, search, and tabs. It does not yet cache
the bytes of remote images that have never been loaded, and history, sharing, billing, and admin
operations still require a connection. Signing out erases that account's local SQLite cache to avoid
leaving document content on a shared machine. Before logout, the editor flushes its debounce window into
SQLite. If unsynced changes or conflicts remain, the user must explicitly confirm their deletion; offline
content is never discarded silently.

CI compiles the Rust / Tauri app on both macOS and Windows. Update artifacts use an independent Tauri
signature. Public distribution still needs Apple Developer ID signing and notarization plus a Windows
code-signing certificate; those are platform reputation infrastructure rather than blockers for the local alpha.

## Invitation rewards

Every user has a unique 16-character invitation code. The dashboard turns it into a
`/register?invite=CODE` link. Email registration submits the code in its request body;
OAuth carries it inside the existing HMAC-signed state cookie, so the provider sees only
the random nonce and cannot read or alter the code.

Rewards apply only to a genuinely new account. The inviter and invited user each receive
500 MiB of permanent storage, while each account's cumulative `bonus_storage_bytes` is
capped at 5 GiB:

- `users.invitation_code` is unique and cannot be changed by the user
- `users.invited_by` records the direct relationship
- `users.bonus_storage_bytes` stores cumulative permanent bonuses, with the 5 GiB cap
  enforced both by a database constraint and when application code reads the quota
- unique `invitations.invited_user_id` is the database boundary against duplicate rewards

Creating the user, inserting the invitation ledger entry, and incrementing both bonuses
happen in one PostgreSQL transaction. An invalid code rolls the registration back without
consuming the email verification code, and a partial one-sided reward cannot commit.
Concurrent invitations lock the inviter row; the final grant can use only the remaining
allowance, and later relationships are recorded with a zero actual inviter reward.
Existing accounts ignore invite parameters on later OAuth logins and cannot claim a reward
after registration. `GET /api/invitations` returns only the current user's code, invite count,
and reward totals.

OAuth state represents malformed invitation input with a dedicated signed
`invitationCodeInvalid` boolean instead of a sentinel string in the legal code namespace.

## Membership and billing

The first paid entitlement is a multi-currency one-time lifetime membership, not a
subscription:

- Free users use the `IMAGE_QUOTA_MB` base storage quota (500 MB by default)
- Lifetime members receive a 10 GiB base quota and entitlement to future AI features
- Both tiers add up to 5 GiB of `bonus_storage_bytes` earned through invitations on top of the base quota
- `users.membership_tier` is the entitlement source of truth and currently accepts
  only `free | lifetime`
- `stripe_payments.checkout_session_id` is the idempotency key, so success-page
  confirmation and the Stripe webhook can arrive together without double fulfillment

Payment flow:

```
POST /api/billing/checkout
  └─ browser submits only a currency; backend chooses an allowlisted amount and fixed Price
       ├─ browser redirects to Stripe
       ├─ success return calls POST /api/billing/checkout/confirm
       └─ Stripe calls POST /api/billing/webhook (checkout.session.completed)
              └─ both confirmation paths retrieve the Session from Stripe again
                   └─ one DB transaction records payment + sets lifetime membership
```

The allowlist is USD 3.99, CNY 29, EUR 3.99, and JPY 600. Stripe uses one
`STRIPE_LIFETIME_PRODUCT_ID`; each Checkout creates an inline price for that Product
with server-owned `price_data`. This lets the user choose the settlement currency
without giving the browser control over the amount.

Amounts, Product IDs, and tiers returned by the browser are never trusted. Fulfillment
requires payment mode, paid status, an allowlisted metadata currency, exact matching
Session and line-item amount/currency, exactly one configured Product with quantity one,
and matching `client_reference_id` / ownership metadata. The webhook
first verifies `Stripe-Signature` with the endpoint secret, then still retrieves the
Session instead of treating an event snapshot as the entitlement source.

The Stripe account is shared by multiple services, so both Checkout Sessions and
PaymentIntents carry `metadata.service=koinote`. The webhook routes only that service's
events and acknowledges other signed events with HTTP 200; both success-page confirmation
and webhook fulfillment require the same service marker during final Session validation.

Checkout omits `payment_method_types`, allowing Stripe to select among Dashboard-enabled
methods according to account country, customer location, and currency. The current test
account enables card, Alipay, and WeChat Pay. The webhook handles both
`checkout.session.completed` and `checkout.session.async_payment_succeeded`, so delayed
methods still fulfill after the customer closes the success page. Production requires
`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, and
`STRIPE_LIFETIME_PRODUCT_ID` together. Development may omit the webhook secret and use
the success return while testing Checkout.

Every purchase click generates a random attempt ID. The idempotency key fingerprints it
with the request-parameter version, return URL, user, Product, amount, currency, and
Customer parameters. Network retries for one Stripe API call remain idempotent, while a
cancelled, expired, or explicitly retried purchase receives a fresh Session. Changing the
request shape, such as payment-method configuration, must still bump the version. Session
creation is also limited to five attempts per user per ten minutes, without coupling one
user's limit to another user's traffic.

### Payment notifications

With `BOT_WEBHOOK` and `BOT_WEBHOOK_SECRET` set (reusing Kimiseek's bot variable names),
the first successful settlement posts a message to a Feishu group. Two constraints shape
the implementation:

**Notification must never affect entitlement.** Membership is granted even when Feishu is
down, so notification state lives in columns on `stripe_payments` rather than inside the
grant transaction. The pending marker is written within that transaction —
`notification_next_try_at` shares the same idempotency lock as `ON CONFLICT DO NOTHING` —
so "granted but never enqueued" cannot happen, and conversely a failed send only leaves
retry state behind.

**Exactly one notification.** Success-page confirmation, the webhook, and Stripe's webhook
retries are three racing paths. The discriminator is `RowsAffected() == 1`: only the call
that actually inserted the payment row sends, deduplicated by the `checkout_session_id`
primary key without extra locking.

Retries run from a one-minute poll, with `notification_locked_until` giving a 30-second
lease so multiple instances do not double-deliver. Backoff is `1 << (attempts-1)` minutes,
settling at 24 hours after eight attempts — unlike image GC's `gcMaxAttempts`, this never
gives up entirely, because missing a payment costs more than keeping a pending row around.

Message bodies carry only the internal user ID, amount, currency, and order identifiers.
The `paymentNotification` struct has no email field at all rather than filtering one out at
send time, so it cannot be casually reintroduced. Amounts are interpreted in Stripe's minor
units; the sixteen zero-decimal currencies live in `zeroDecimalCurrencies`, next to the
price allowlist.

Quota is not a frontend display value: image accounting, document create, document
update, and storage usage all call `storageQuotaFor(user)`. A newly fulfilled member
therefore receives 10 GiB plus bounded invitation bonuses on the next write, and future AI authorization can read the
same database tier without querying Stripe.

## MCP document access

MCP lets Codex, Claude Code, and other agent clients operate on Koinote documents. Model
inference stays in the client: Koinote exposes tools and data but never calls an LLM, so
the server needs no OpenAI, Anthropic, or other model API key. The endpoint is Streamable
HTTP `POST /mcp`, using the official Go MCP SDK in stateless JSON-response mode. The Worker
only proxies the exact `/mcp` path and preserves the request body stream without parsing or
re-encoding protocol messages.

### Why the protocol lives in Go, not a Worker or Durable Object

MCP identity, membership, document authorization, versions, and audit truth already live
in PostgreSQL and the Go backend. A Worker protocol layer would still call the backend to
authenticate and again for every tool, adding a hop without making a decision. Document
CRUD is stateless and needs none of Durable Objects' session state, migrations, or billing.
The Worker therefore remains a thin edge proxy while all authorization stays in Go.

### Why the first release uses PATs instead of OAuth

The initial audience is lifetime members, using personal access tokens created on the
account page. Tokens have `read` or `write` scope, a 1–365 day or permanent lifetime,
an editable expiry, individual
revocation, and a maximum of 20 active tokens. Plaintext starts with `knt_mcp_`; PostgreSQL
authenticates with SHA-256 and stores a separate AES-GCM-encrypted recovery copy under a
dedicated key. The owner can explicitly reveal it through a rate-limited endpoint, while
list responses return only the hint. The token has 256 bits of random entropy, so its hash
does not need password-style resistance to low-entropy guessing.

Every request reloads the token and user, checking revocation, expiry, and
`membership_tier=lifetime`; an already connected stateless client cannot outlive a later
revocation or membership downgrade. Database failures during authentication return 500
rather than masquerading as 401. Limits are 120 requests per token per minute and a 2 MiB
request body; PAT management responses carry `Cache-Control: no-store`. Like the rest of
the site's rate limiting, the counter is currently per-process and must move to shared
storage before horizontal scaling.

PATs are first-class credentials for CLI clients and avoid prematurely implementing OAuth
2.1 authorization-server metadata, protected-resource metadata, dynamic client
registration, and consent UI. OAuth can be revisited when substantial third-party demand
exists; the first release keeps the trust boundary smaller, revocable, and auditable.

### Tools and authorization boundary

Read tokens expose:

- `list_documents`: recent-first paginated summaries without content
- `search_documents`: title and Markdown-body search with a nearby matching snippet
- `get_document`: Unicode character offset/limit chunks with total length and `hasMore`
- `list_document_versions` / `get_document_version`: retained recovery points
- `list_trashed_documents`: summaries waiting in the 30-day trash

Write tokens additionally expose `create_document`, `append_to_document`,
`update_document`, and `restore_document_version`, plus revision-checked `trash_document`
and `restore_trashed_document`. MCP never exposes permanent deletion; only the browser trash
page can call it after a second warning and typed-title confirmation. Normal deletion only
sets `trashed_at`: versions, quota usage, and image references remain for 30 days. An hourly
backend cleanup permanently removes expired rows and then hands truly orphaned images to R2
GC. Every query constrains both `user_id` and `doc_id`,
and public shares are excluded, so prompt injection cannot broaden data access across
accounts. Scope isolation—not an “untrusted content” sentence—is the effective write
boundary.

Audit rows contain only user, token, tool name, document ID, success/error, and duration;
they never contain document text or plaintext tokens. The backend removes rows older than
180 days once per day so operational metadata cannot grow without bound. Business errors give the agent an
actionable response such as re-reading the latest revision, while internal database errors
collapse to `internal server error`.

### Version history before agent writes

A full-document replacement can be as destructive as deletion, so version history and a
shared browser/MCP revision compare-and-swap landed before `update_document`. Every real
mutation increments revision, while an identical no-op does not. If a successful response
is lost, retrying identical content with the old revision idempotently returns the current
document; an old revision with different content conflicts. Append and restore also require
`expectedRevision` rather than assuming append is inherently race-free.

Browser autosave sends the same revision. If an agent changes a document while a browser
tab is open, the next browser save receives 409 instead of silently overwriting the agent.
The local draft is persisted to localStorage so refresh still reaches the merge UI. The user
can accept remote or edit the local title/body and save against the latest revision; a
second remote change conflicts again. Explicit overwrite forces a snapshot of the state
being replaced. Restore itself also uses CAS and snapshots the current state first.

Only lifetime members retain versions. History defaults to enabled, 20 versions per
document, and full snapshots for MCP writes. Members can change the per-document limit from
1–100 and independently disable regular snapshots or full MCP history through the dashboard
or a write-scoped MCP token. Disabling full MCP history never makes an Agent's whole-document
replacement irreversible: each document still maintains its latest MCP safety snapshot. A
later Agent write replaces the prior safety snapshot, while a later full snapshot removes the
now-redundant safety copy. Safety and regular snapshots share both the per-document limit and
the account-wide limit of 100, so this does not create hidden retention capacity. Disabling a
setting does not erase retained history; lowering the limit prunes immediately. High-frequency
browser autosave creates at most one snapshot every five minutes.

A write-scoped token can change this account-level retention policy, not just document content.
That authority is intentional but does not bypass the recovery boundary: settings changes cannot
disable revision CAS, membership checks, the per-document/account caps, or the mandatory latest
MCP safety snapshot. Even if an Agent disables regular and full MCP history immediately before a
whole-document replacement, the replaced state remains recoverable in that safety snapshot. If
the mandatory snapshot rule is ever removed, this settings tool must first move to a separate
scope or stop being exposed to write-scoped tokens.

Version text does not count toward the user's cloud-storage byte quota, but images referenced
by retained versions continue to block R2 garbage collection. Pruning a version or deleting a
document rechecks references before asynchronously reclaiming true orphans. In the worst case,
the current reference check scans all retained version bodies for that user; if history volume
grows materially, this should move to a dedicated version-image reference table or equivalent
index. Document and image quota changes share a per-user advisory transaction lock so concurrent
requests cannot both approve against stale usage.

## Search, portability, and product analytics

Global search and MCP `search_documents` share one backend query. It is constrained to the
authenticated user, excludes trash, matches both title and Markdown body, and returns a short
snippet around the body hit. Queries are limited to 1–200 Unicode characters and the web route
returns at most 50 rows; `⌘K` / `Ctrl+K` opens the browser UI and highlighting happens locally.
Search terms are never written to logs or product analytics. The current implementation is a
case-insensitive substring scan; PostgreSQL full-text or trigram indexing can be evaluated when
the corpus justifies it.

Bulk migration keeps Markdown as the source format. Import accepts `.md` files, browser-selected
folders, or ZIP archives. ZIP processing is capped at 1,000 files and 250 MiB uncompressed data,
normalizes paths, and rejects traversal outside the archive root. Only PNG, JPEG, GIF, or WebP
files actually referenced by Markdown are uploaded; Markdown and HTML `<img>` references are then
rewritten to the recipient account's URLs. Full export preserves folders, reads first-party images
through same-origin `/images/<key>`, stores them under `assets/`, and writes a manifest. An image
failure is listed in that manifest instead of silently aborting unrelated documents.

Product analytics is first-party and deliberately minimal. `product_milestones` stores one first
timestamp per user/event for registration, first document, first upload, first export, first
successful MCP call, checkout start, and checkout completion. `user_daily_activity` stores at most
one date per user per day for D1/D7/D30 retention. Document bodies, titles, search terms, filenames,
and share-reader identities never enter analytics. Only first export must be reported by the browser;
all other milestones are recorded after backend business success. Retention starts at migration
deployment and the dashboard exposes that start date rather than fabricating historical activity.

## Admin dashboard

`GET /api/admin/stats` resolves the user from the server-side session and then checks
the database `is_admin` flag. Hiding the menu item on the client is only a UX detail,
not authorization. Unauthenticated requests receive 401 and non-admin users receive 403. Responses omit password hashes, Stripe Customer IDs, Checkout Session IDs, and
internal authentication identifiers.

PostgreSQL is the source of truth for user, verified-user, lifetime-member, document,
image-ledger, site-storage, order, per-currency revenue, 30-day growth, first-step funnel,
D1/D7/D30 retention, and recent
activity metrics. Revenue in different currencies is never added together without an
exchange-rate source; the frontend formats each currency independently. The overview's
full-table document and image aggregates use a one-minute cache that also coalesces
concurrent loads.

Today's UV and PV come from Cloudflare GraphQL Analytics API
`httpRequests1hGroups`. The query deliberately has no time dimension and requests one aggregate, so
`uniq.uniques` is deduplicated over the whole requested interval rather than incorrectly
adding minute-bucket uniques. It uses a dedicated least-privilege
`CLOUDFLARE_ANALYTICS_TOKEN`, filters by hostname, and caches results for one minute.
Missing configuration, permission errors, or Cloudflare timeouts set
`traffic.available=false` while PostgreSQL business metrics still return successfully.
These are edge HTTP metrics and may include legitimate crawlers and allowed automation;
they are not equivalent to client-instrumented user sessions.

## Sharing

Two levels:

| Level      | Meaning                                                                |
| ---------- | ---------------------------------------------------------------------- |
| `link`     | Anyone with the link; the token is 32 random hex chars, not enumerable |
| `password` | Visitor must enter a password (bcrypt hash, at least 6 characters)     |

There used to be a third level, `public`, now removed. It behaved **identically** to
`link`: no backend branch ever read it, and the "allows indexing" it claimed didn't
exist either — `setShareResponseHeaders` adds `noindex` to every shared page
unconditionally. The UI hint literally read "same as above". An option that changes
no behaviour only makes users believe they made a security decision.

Existing rows are normalized to `link` on read by `normalizeShareAccess`; the write
path still accepts `public` (an old page may not have refreshed) and treats it as
`link`, while any other invalid value is a 400. Read and write deliberately do not
share the normalizer: defaulting to `link` on read is safe (real access control lives
in `share_password_hash`), whereas defaulting on write would silently swallow a typo.

Endpoints:

```
POST   /api/documents/{docId}/share   enable or change access (owner only)
DELETE /api/documents/{docId}/share   revoke
GET    /api/share/{token}             public read; the token is the credential
POST   /api/share/{token}/verify      validate password, then return content
GET    /api/share/{token}/meta        minimum OpenGraph metadata for the Worker
```

The frontend page lives at `/share/$token`, requires no login, and reuses the
editor's extension set for its read-only view — so highlighting, formulas, and
images render exactly as they do while editing. Before returning the SPA HTML, the Worker injects
a dynamic title, description, canonical URL, and OpenGraph/Twitter tags. Password-protected metadata
returns only `protected=true`, never the title, summary, or cover. Shared pages remain `noindex`; the
metadata is for link previews, not search-engine indexing.

The password protects titles and content returned by the sharing API; it does not make image
objects private. Referenced `/images/<key>` paths and R2 custom-domain URLs remain readable by
anyone who has the full URL. Keys are random and non-enumerable, but the image request itself does
not require the share password. This is consistent with the site-wide image-hosting model and the
rehosting used by “Copy to my Koinote.” Protecting images too would require short-lived signed URLs
or an authenticated image proxy, not only a change to the share endpoint.

`share_view_count` increments atomically only after content is actually returned. Failed password
attempts and metadata requests do not count, and no reader identity, IP, or User-Agent is stored.
Signed-in readers can copy a share into their own account; referenced Koinote images are re-uploaded
for the new owner so source-owner deletion or image GC cannot break the copy.

Deliberate semantics:

- **Calling POST again reuses the same token by default** — links already sent out
  don't break because you changed a setting
- **But loosening access forces a new token** (see below)
- **Re-enabling after a revoke issues a new token** — old links die permanently,
  which is the entire point of revoking
- **Revoked and never-existed return the same response** — we don't reveal that a
  link was once valid
- **Under password access, GET returns only a `requiresPassword` flag** — not one
  byte of content passes through an unverified response
- **The public view exposes only title / content / updatedAt / ownerName / viewCount** —
  internal ids, `user_id`, `doc_id`, and `share_token` never leak

### Loosening access must rotate the token

The rule is asymmetric because the risk is asymmetric (see `shouldRotateShareToken`):

| Change                                    | Token      | Why                                                      |
| ----------------------------------------- | ---------- | -------------------------------------------------------- |
| Tighten (`link` → `password`)             | reuse      | Old links only get stricter; security strictly increases |
| Change password (`password` → `password`) | reuse      | Access level unchanged                                   |
| **Loosen (`password` → `link`)**          | **rotate** | See below                                                |

Reusing the token while loosening turns the same URL from "needs a password" into
"anyone who has it reads everything". **Everyone previously blocked by the password
instantly gains access**, while the user thinks they merely changed a setting. No
confirmation dialog guards this step (revoking has one), so it would be a silent
privilege escalation.

Rotating kills old links immediately, forcing the user to reshare — and that act is
itself informed consent. The response carries `tokenRotated` so the UI can say so,
because the user may already have sent the old link out.

Rotation was chosen over a confirmation dialog because dialogs get clicked through,
while rotation is structural: people holding the old link don't suddenly gain access
because you flipped a setting.

Brute-force protection: two layers of rate limiting (20 per IP, 10 per link, in a
15-minute window), with limiter keys derived from the token's sha256 rather than the
plaintext. Responses carry `Cache-Control: private, no-store` — if password-gated
content were cached by a CDN, holding the cache would bypass the password. Plus
`X-Robots-Tag: noindex`.

> ⚠ **The limiter is in-process**. Across multiple instances each process counts
> separately and thresholds multiply by N. Move it to shared rate-limit storage before
> scaling out.

## Export

The My Documents full ZIP migration is separate from single-document format export: the former
optimizes for reversible Markdown/folder/image portability, while the latter targets readers,
office formats, and publishing platforms. See “Search, portability, and product analytics” above.

Six paths, all client-side so they cost no backend resources:

| Format              | Implementation                                                                                         |
| ------------------- | ------------------------------------------------------------------------------------------------------ |
| `.md`               | `storage.markdown.getMarkdown()` — the content already _is_ Markdown                                   |
| `.html`             | Self-contained single file, styles inlined, KaTeX CSS from a CDN, formulas rendered at generation time |
| `.docx`             | The `docx` library, built from the ProseMirror document tree                                           |
| `.pdf`              | html2canvas-pro rasterization + jsPDF pagination, one-click download                                   |
| WeChat              | Theme styles inlined + formulas as images, written to the clipboard                                    |
| Print / Save as PDF | The browser's native print pipeline + `@media print`                                                   |

**Why PDF has two paths**: the only engine in a browser that produces vector-text
PDFs hangs off the print pipeline, and the print dialog can't be bypassed. So
"one-click download" and "selectable, searchable text" cannot both hold in a purely
client-side implementation. Each path keeps one of them:

|                     | One-click               | Selectable text      | Size         |
| ------------------- | ----------------------- | -------------------- | ------------ |
| `.pdf` (raster)     | yes                     | no, text is a bitmap | ~650 KB/page |
| Print / Save as PDF | no, requires the dialog | yes, vector          | much smaller |

That dialog has nothing to do with printers: choosing "Save as PDF" in Chrome goes
through Skia's PDF backend and touches no printer driver, so it works with no
printer installed. In the CSS specs this area is called _paged media_; PDF is just
one of its output targets.

Trade-offs in the raster path:

- **Rasterize the real DOM rather than hand-drawing text onto a canvas.** Formulas,
  syntax highlighting, and table borders are all laid out by the browser, so we
  don't write layout code — a hand-drawn approach that supported LaTeX would mean
  rewriting a TeX engine.
- **Page breaks align to block boundaries** so a line of text isn't sliced in half.
  But when the element right after the break is itself taller than a page (a long
  code block), it has to be cut regardless — in that case we don't break early,
  which would waste half a page of white space.
- **Images are converted to data URLs before rasterizing.** A cross-origin image
  taints the canvas, after which `toDataURL` throws `SecurityError` — so the symptom
  would be the entire export failing rather than one missing image.
- **Code blocks use a light background in PDF**, matching the print path. Dark
  backgrounds are a solid ink field on paper and compress far worse as bitmaps.
- **2× scale (≈192 DPI), lossless PNG.** Compression level and alpha-channel removal
  were both measured and made no difference to size; only lossy JPEG helped (14–40%),
  but small CJK glyphs ring at the edges under JPEG, so image quality won.
- `html2canvas-pro` rather than `html2canvas`: Tailwind v4 emits `oklch()` colors by
  default, which the original renders as transparent or black.

**DOCX degradations**: formulas are kept as LaTeX source text (converting to Word's
OMML is an order of magnitude more work, and the source is at least lossless and
readable); code blocks get a monospace font and a light gray background but no
syntax coloring; images are fetched and embedded individually with the type sniffed
from the file header (labeling a JPEG as png produces a document that won't open);
webp isn't supported by docx so it degrades to a placeholder line; a single failed
image leaves a placeholder rather than failing the whole export.

The `docx` library is about 1 MB, loaded via dynamic `import` into its own chunk so
it doesn't weigh down the editor's first paint.

### WeChat Official Accounts

Modeled on `dbskill_wechat_styles.go` from `../keepask`, which had two paths: one
where an LLM generates HTML from a style guide, and one that is pure string-based
style inlining. **This is the latter** — Koinote has no AI integration, and those
248 lines of inlining never needed a model anyway: regex out the CSS, flatten it to
tag → declarations, walk the HTML tree writing `style` attributes.

The output isn't written to disk but **to the clipboard** (`text/html` plus
`text/plain`), because the user's actual next action is pasting into the WeChat
editor. Downloading an `.html`, opening it, and selecting all is three redundant steps.

The WeChat editor's behaviour dictates every part of the implementation:

| WeChat does this                              | So we must                                     |
| --------------------------------------------- | ---------------------------------------------- |
| Strips `<style>` and external CSS             | Put styles in each element's `style` attribute |
| Strips `class` / `id`                         | Use tag names as the only selectors            |
| Strips `<script>` and friends                 | Delete those subtrees outright                 |
| Fetches and re-hosts external images on paste | Point formula images at real R2 URLs           |
| Strips `white-space` (verified)               | Carry indentation structurally, not via CSS    |
| Keeps `background` (verified)                 | Dark themes survive as-is                      |

**Themes are stored as tag → declaration strings** (`wechatThemes.ts`), not as CSS
text. Since the final lookup can only be by tag name, we skip keepask's step of
regexing CSS out of Markdown. The cost is losing CSS expressiveness — but that
expressiveness was unusable under inlining anyway. keepask's themes contain things
like `h2:before{content:""}` decorative bars, which **are silently dropped when
inlined and simply never appear in WeChat**. So none of the themes here rely on
pseudo-elements. The only descendant selector kept is `pre code`, since a code block's
`code` looks different from inline `code`.

**Highlighting must be regenerated at export time.** `CodeBlockLowlight` highlights
via ProseMirror _decorations_, which are a view-layer concern and never enter the
document — so `editor.getHTML()` contains no `hljs-*` spans at all. This was the root
cause of a reported bug where code came out as a plain gray box: every downstream
stage was correct, but the class names the inliner read were always empty strings.
`highlightCode.ts` re-runs lowlight over the export stage to fill them in.

**Indentation has to be structural.** WeChat strips `white-space`, so `pre-wrap`
can't be relied on: leading spaces collapse and Python becomes non-code. The fix is
to make the whitespace itself not need CSS — U+00A0 (which doesn't participate in
whitespace collapsing) plus `<br>` (an element, immune to `white-space`). Tabs expand
to 4 spaces. See `wechatWhitespace.ts`.

**Formulas must become images.** KaTeX's output is hundreds of classed `<span>`s
positioned to form the layout; with classes stripped, what remains is a pile of
scattered glyphs — worse than not rendering. The flow is KaTeX → html2canvas (3×,
since formula type is small and anything less looks blurry on phones) → upload to R2
→ `<img>`. R2 rather than base64 data URLs because WeChat fetching external images
is behaviour already proven by ordinary images in your document, while data URL
acceptance is unverified.

Two deliberate orderings that break if reversed:

1. **Convert formulas before inlining styles.** Otherwise the newly inserted `<img>`
   never receives the theme's `img` rules.
2. **Formula width/height must come after theme rules.** The theme's `img` rule
   includes `height:auto`; reversed, formulas get squashed. This is carried via
   `data-wechat-keep-style`, with assertions guarding it.

**Formula images are temporary, content-addressed objects.** A single export reuses
rendered results by LaTeX source, while the Worker derives a stable key from the PNG's
SHA-256 bytes. Re-exporting across reloads or sessions therefore does not accumulate R2
copies. Each export extends retention to seven days, after which image GC handles it;
if the URL is stored in one of the user's documents, GC's reference check keeps it until
the document actually removes the reference. The ledger marks these objects by `purpose`:
they do not consume the normal document-storage quota and instead share a separate
100 MiB temporary quota per user. Export therefore cannot block ordinary uploads, while
forging the client-supplied purpose cannot create an unlimited storage bypass.

**Known degradation**: syntax highlighting colors survive (they're inlined), but
nothing can preserve `class`-based styling. Formula conversion failures degrade to
LaTeX source with a count shown in the dialog — degrading silently would leave users
thinking the formula always looked like that.

## Syntax highlighting and LaTeX

**Highlighting**: lowlight (highlight.js) `common` set, about 37 mainstream
languages. Use a fenced block with a language name. Colors are a trimmed GitHub Dark
palette in `globals.css`.

**LaTeX**: rendered by KaTeX with the delimiters CommonMark tooling expects.

- Inline: `$E = mc^2$`
- Block: `$$…$$` (same line or across lines)
- Click a formula to return to its source
- Syntax errors fall back to marked red monospace text rather than failing silently

Three implementation details worth knowing:

0. **Export must call KaTeX itself.** The extension's `renderHTML` emits only an
   empty element carrying `data-latex` (see `extension-mathematics/dist/index.js`);
   a formula's visible form comes entirely from the in-editor nodeview. Export goes
   through `editor.getHTML()`, which has no nodeview — so without a re-render the
   formula's place in the output is **zero-height blank space**, i.e. silently lost
   content. `spa/src/components/editor/renderMath.ts` fills this in, shared by the
   HTML and PDF paths.
1. **The delimiters are overridden.** `@tiptap/extension-mathematics` uses
   non-standard input rules (inline `$$…$$`, block `$$$…$$$`), yet serializes to
   standard `$…$` / `$$…$$` — typing and saving disagree. The input rules are
   overridden here to standardize on the common form.
2. **Markdown round-trip uses a hand-written markdown-it plugin**
   (`spa/src/components/editor/markdownMath.ts`). `tiptap-markdown` doesn't know math
   syntax, and the extension's bundled tokenizer targets TipTap's official markdown
   package, which isn't used here. The plugin adds guards against false positives:
   `$` may not be adjacent to whitespace, and a closing `$` followed by a digit is
   treated as currency — otherwise "costs $100 and $200" gets swallowed as one formula.

KaTeX fonts are copied from `node_modules` into `assets/fonts/` at build time by the
`copyKatexFonts` plugin in `vite.config.ts`. Without it the relative paths in KaTeX's
CSS all 404 and formulas fall back to substitute fonts — "renders but wrong", which
is very easy to miss.

## Image hosting (Cloudflare R2)

Uploads go **from the Worker straight into R2**, never through the Go backend —
bytes stay at the edge and don't consume VPS bandwidth. Auth still calls back:
the Worker forwards the original cookie to `/api/auth/session` to resolve identity.

- `POST /api/images` — upload; the body is **raw bytes** (not multipart) and
  `Content-Type` must match the real file header
- `GET /images/<key>` — fallback read path when no custom domain is configured
- Pasting or dropping an image in the editor uploads it and inserts the returned URL

Security constraints, all enforced Worker-side:

- **Real type sniffed from magic bytes**; the client's declared `Content-Type` isn't
  trusted, and a mismatch is rejected
- **SVG is always rejected.** SVG can embed scripts, which with a public bucket is
  stored XSS. Sanitizing SVG is a permanent race against bypasses; not accepting it
  is simpler
- 10 MiB cap, checked against both `Content-Length` and the actual byte count
- Keys look like `u/<authUserId>/<32 random>.png`, random and never reused
- Read responses carry `X-Content-Type-Options: nosniff`

**Images are readable by anyone with the URL.** Keys are unguessable but there's no
authorization check, so a leaked link to an image inside a private document is
viewable by anyone. This is normal for image hosting, but users generally assume
otherwise — switch to signed URLs if your case can't accept it.

### Backfilling pre-existing objects

`scripts/backfill_image_objects.py` records objects that are already in R2 but
missing from the `image_objects` ledger.

It's needed because of a bug: the accounting statement had a type-inference error
(`bytes` is `bigint`, `SUM(bytes)` is `numeric`, so `$3` was deduced as both), which
means **image accounting never worked** — the ledger stayed empty and usage showed
only document text. The fix records new uploads, but doesn't apply retroactively.

```bash
python3 scripts/backfill_image_objects.py            # dry run
python3 scripts/backfill_image_objects.py --apply    # write
```

It scans image keys out of all document bodies (using the same regex and ownership
rule as `image_keys.go`), HEADs each one for `content-length`, and inserts. Idempotent:
keys already in the ledger are skipped, so re-running never double-counts.

Three deliberate choices:

- **It bypasses the quota check.** These objects already occupy R2 space; the ledger
  is only recording an existing fact. Using the `WHERE`-guarded statement would refuse
  to write when over quota, leaving usage still invisible — the opposite of the point.
- **Keys missing from R2 are skipped and reported.** Those are bodies referencing
  deleted objects; inserting a nonexistent object would inflate usage permanently
  with nobody to correct it.
- **Orphans aren't found.** R2 may hold images no document references anymore
  (deleted ones, uploads never saved); scanning bodies can't see them. Covering those
  would need a listing endpoint on the Worker — and orphans should be deleted by the
  GC task rather than billed indefinitely.

On startup the script reads `image_keys.go` and compares regexes, exiting if they
differ. Both sides carry a copy, and drift would mean silently missing one file
extension — and missing part is harder to notice than not running at all.

### Local uploads require Wrangler

Vite proxies `/api/images` and `/images` to `http://localhost:8788`. Uploads fail to
connect when the Worker is not running; the Go backend has no R2 endpoint.

First create an ignored `.dev.vars` file at the repository root:

```dotenv
BACKEND_INTERNAL_TOKEN=<the same value used in .env>
```

Then run Wrangler (its local R2 emulation never touches production data):

```bash
npx wrangler dev --port 8788
```

The Worker sends backend requests to `http://localhost:8080` by default. Override a
custom backend port with `--var BACKEND_URL:http://localhost:<port>`.

Local objects live in `.wrangler/state/v3/r2` (gitignored).

### Production configuration

```bash
npx wrangler secret put BACKEND_URL --env production          # HTTPS backend origin
npx wrangler secret put BACKEND_INTERNAL_TOKEN --env production   # same as the backend
npx wrangler secret put CLOUDFLARE_ZONE_ID --env production
npx wrangler secret put CLOUDFLARE_CACHE_PURGE_TOKEN --env production
# the R2 binding is in wrangler.jsonc; no secret needed
```

### Split image URLs: same-origin web, CDN exports

Controlled by `IMAGE_PUBLIC_BASE`.

With an R2 custom domain configured, `publicURL` returns an absolute CDN URL and
stores it in the document as the canonical image address. For web rendering,
`ImageNodeView` changes only the actual `<img src>`, mapping owned CDN URLs to the
same-origin `/images/<key>` route. This avoids browser CORS / Local Network Access
failures while leaving the TipTap node untouched, so Markdown, HTML, and WeChat
exports still use the CDN and existing documents need no migration.

The stability trade-off is explicit: the first web load of an image costs one
Worker request. The response carries a one-year immutable browser cache, while
exported content and direct CDN access still bypass the Worker.

The simulated R2 used in local development does not contain production objects.
`IMAGE_READ_FALLBACK_BASE` is empty by default so an open-source clone never reaches
the maintainer's production domain on a local R2 miss. To inspect your own production
images locally, opt in through `.dev.vars` with your CDN base. The key must still match
the owned-image shape, so this is not an arbitrary URL proxy; production does not enable
this fallback.

Leaving it empty does **not** break WeChat export: `auditWechatImages`
(`spa/src/components/editor/wechatImages.ts`) resolves `/images/<key>` against the
current origin, so once deployed WeChat can fetch it even through the Worker proxy —
it just costs an extra request per load.

The case that genuinely fails is **local development**: the resolved URL is
`http://localhost:5273/...`, which WeChat's servers cannot reach. The export dialog
reports "N images unreachable" with the hostname, because it has to be said at copy
time — WeChat raises no error on paste, and you'd only see broken images at article
preview, long after leaving our page.

Setup (manual, in the Cloudflare dashboard):

1. R2 → `koinote-images` → Settings → Public access → Connect Custom Domain
2. Enter a subdomain already hosted on Cloudflare, e.g. `img.yourdomain`
3. Wait for DNS and the certificate
4. Put it in `IMAGE_PUBLIC_BASE` in `wrangler.jsonc`, as `https://img.yourdomain`
5. Create an API token with only `Zone / Cache Purge` permission, then set
   `CLOUDFLARE_ZONE_ID` and `CLOUDFLARE_CACHE_PURGE_TOKEN` as Worker secrets.
6. Add a Cache Rule for the image hostname with Edge TTL `0` for `404` responses.
   Cloudflare otherwise negative-caches missing R2 keys; the editor also adds a
   display-only query parameter on retries so a cached 404 cannot make a successful
   upload look permanently broken.

**Confirm with the self-check endpoint afterwards — don't just check that images load:**

```bash
curl https://yourdomain/api/images/config
# {"mode":"cdn","base":"https://img.yourdomain","valid":true,
#  "purgeRequired":true,"purgeConfigured":true,"warning":null}
```

That endpoint exists because a misconfiguration **falls back to the Worker proxy and
images still display** — so "images work" proves nothing about the CDN. Without it
you'd find out from next month's request count. A healthy CDN setup returns HTTP 200
with `mode: "cdn"` and `purgeConfigured: true`; `warning` explains any failure.

Deleting an R2 object does not invalidate an object already stored in Cloudflare's
CDN. The image deletion endpoint therefore deletes R2 first and then calls the
single-file purge API for the exact public URLs. If purge credentials are missing,
it refuses before touching R2; if the purge request fails after deletion, it returns
an error so the backend keeps the GC queue row and quota ledger for an idempotent
retry. The three deterministic retry-query variants are purged alongside the
canonical URL, in chunks of at most 100 URLs (Cloudflare's per-request limit). This
intentionally uses the REST API because R2 bindings have no global CDN
purge operation (`caches.default.delete()` only affects the current data center).

`normalizeImageBase` (`worker/images.ts`) validates: scheme required, http(s) only,
query strings and fragments rejected, trailing slash removed, sub-paths preserved
(R2 custom domains allow them). A bad value falls back instead of throwing —
throwing would fail uploads outright, which is worse.

> A hypothesis about workerd was tested and disproved; recorded so nobody repeats
> the detour. We suspected workerd's `URL` silently prefixed scheme-less input with
> `https://` (which would make try/catch-only validation fail in production). The
> actual probe showed workerd matches Node: all three scheme-less forms throw
> `TypeError`. The scheme regex in the code is therefore redundant, kept only to make
> the constraint readable.

## Verification

One command covers the frontend and Worker (typecheck on both sides plus every
assertion suite):

```bash
npm test          # typecheck ×2 + every suite, stops at the first failure
npm run go:test   # go vet + go test
```

Both run in GitHub Actions on every push and pull request
(`.github/workflows/ci.yml`), alongside a job checking secret hygiene: `.env*` and
`.dev.vars` aren't committed, `.env.example` leaves credentials blank, and no
hardcoded keys exist in the source.

> Each suite script ends with `; ec=$?; rm -f ...; exit $ec` rather than
> `; rm -f ...`. The latter makes npm report `rm`'s exit code — always 0 — so a
> failing test reports success and wiring up CI accomplishes nothing. Measured:
> break one source file, the suite prints "1 failed", and `npm run` still exits 0.

Backend: `cd backend && go test ./...` (CI adds `-race`).

MCP: `npm run test:mcp` checks Worker/Vite/backend routing, the membership UI, and that
recoverable trash tools are exposed without permanent deletion. Go tests use the official SDK for a Streamable HTTP handshake and
exercise PAT hashing and immediate revocation, read/write tool sets, document mutations,
revision conflict and idempotent retry, retention, concurrent CAS, audit rows, and versioned
image GC protection against real PostgreSQL.

Worker: `npm run test:worker` — 21 pure-function assertions on `normalizeImageBase`.
`npm run test:security-headers` — 35 assertions on the security headers.
At the platform layer, `python3 scripts/verify_image_base.py` confirms in real
workerd that the `/api/images/config` route is mounted, `env` is readable, and the
response shape is right — none of which the Node layer can verify. It temporarily
rewrites `wrangler.jsonc` and restores it from `git show HEAD`.

Export has no unit-test framework and uses **real-browser end-to-end verification**
instead — curl at the protocol layer can't verify what the browser actually
downloaded when you clicked export. The scripts walk the whole path: log in, write
content with formulas/code/tables, click the menu, capture the downloaded file,
parse the result.

```bash
pip install playwright pypdf pillow && playwright install chromium

# Best run against the production build (npm run build && npx vite preview)
PROBE_BASE=http://localhost:5274 python3 scripts/verify_pdf_export.py
PROBE_BASE=http://localhost:5274 python3 scripts/verify_export_formats.py
PROBE_BASE=http://localhost:5274 python3 scripts/verify_share_rotation.py
PROBE_BASE=http://localhost:5274 python3 scripts/verify_wechat_export.py
```

`verify_wechat_export.py` checks the output really satisfies WeChat's constraints:
no `<style>`, no `class`, all styling in `style` attributes, formulas as R2-backed
`<img>` with explicit dimensions, and both `text/html` and `text/plain` on the
clipboard. It needs wrangler on 8788, since formulas upload to R2.

> These scripts all confirm the test content actually landed in the editor before
> continuing. Documents load asynchronously, and typing too early gets overwritten
> by the persisted content arriving afterwards — that caused flaky failures, and
> when they failed the assertions were checking the previous run's stale document,
> which is harder to diagnose than a plain error.

`verify_share_rotation.py` verifies that loosening access really does invalidate the
old link. This has to go over real HTTP: a unit test can prove the decision function
is correct but not that the URL stopped working.

`verify_pdf_export.py` parses PDF internals: page count, A4 dimensions, **which
XObjects each page's content stream actually references** (to judge pagination —
jsPDF puts every bitmap in one shared resource dictionary, so `page.images` alone
isn't enough), whether per-page bitmap fingerprints differ, fill ratio, per-page
size, and which chunks were lazily loaded during export.

`verify_export_formats.py` covers four downloadable formats, focusing on whether formulas
actually survive in each.

Both need the backend and database running, and leave a `pdfprobe` test account
behind.

## Build and deploy

```bash
npm run build     # vite build → spa/dist
npm run deploy    # build and deploy the production Worker + SPA (not the backend)
```

For the first backend deployment, configure `.env` and `deploy/Caddyfile` on the VPS,
then run from the repository root:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

The hosted deployment subsequently uses `.github/workflows/deploy.yml` to sync,
rebuild, and health-check the backend before publishing the Worker and SPA. The
`BACKEND_URL` secret points at the HTTPS backend origin.
