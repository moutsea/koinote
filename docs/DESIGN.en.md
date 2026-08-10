# Koinote design notes

This document records **why things are built the way they are** — which trade-offs
were deliberate, which traps we hit, and which degradations were accepted with the
cost understood. For features and setup, see the [README](../README.en.md).

Why write it down: almost every decision here has a wrong version that also *works*.
It just fails months later in ways that are hard to trace — an export that silently
drops content, a rate limiter that locks out the victim, a CDN that is misconfigured
but looks fine. Unrecorded, the next person (including me in three months) walks
into the same hole.

> Chinese is the original of this document: [DESIGN.zh.md](DESIGN.zh.md)

## Contents

- [Architecture](#architecture)
- [Local development](#local-development)
- [Auth and security](#auth)
- [Sharing](#sharing)
- [Export](#export)
- [Syntax highlighting and LaTeX](#syntax-highlighting-and-latex)
- [Image hosting](#image-hosting-cloudflare-r2)
- [Verification](#verification)

## Architecture

```
Browser ──▶ Cloudflare Worker (worker/index.ts)
              ├─ serves the Vite-built SPA (spa/dist)
              └─ /api/*, /health ──▶ reverse proxy to the Go backend
                                          │
                                    ┌─────▼──────────────────────┐
                                    │ docker-compose:            │
                                    │  Go backend + Postgres + Redis │
                                    └────────────────────────────┘
```

- **Frontend** Vite + React 19 + TypeScript + TanStack Router + react-query + Tailwind v4
- **Editor core** TipTap v3 (ProseMirror family) + tiptap-markdown (lossless Markdown round-trip)
- **Backend** Go (stdlib `net/http`) + pgx, stateless HMAC-SHA256 session cookie
- **Database** PostgreSQL 16; Redis 7 is a placeholder, unused by the auth flow
- **Deployment** Cloudflare Worker (frontend) + VPS/docker-compose (backend)

## Directory layout

```
spa/          frontend SPA (Vite root)
  src/
    pages/          home / login / dashboard / editor
    components/     AppShell, editor (TipTap)
    api.ts          backend API wrapper (credentials: include)
    auth.ts         session state hook (react-query)
worker/       Cloudflare Worker (API proxy + SPA hosting)
backend/      Go backend
  cmd/server/       entry point
  internal/         config / db / migrations / server(auth,session) / model
  migrations/       SQL migrations
docker-compose.yml  postgres + redis + backend
```

## Local development

You need Node 20+, Go 1.23+, and Docker.

### 1. Database

```bash
cp .env.example .env
docker compose up -d postgres redis
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
npm run docker:up   # postgres + redis + backend all containerized
```

> **Rebuild after changing backend code.** `docker compose up -d` restarts the
> container but does not rebuild the image, so your code changes won't be running.
> Use `docker compose up -d --build backend`. This produces the worst kind of
> confusion — the code is right, the behaviour is old, and nothing reports an error.

## Auth

- Register / login / logout / session: `POST /api/auth/{register,login,logout}`, `GET /api/auth/session`
- OAuth: `GET /api/auth/oauth/{google,github}/{start,callback}`
- Sessions are stateless HMAC-SHA256 signed `koinote_session` cookies
  (HttpOnly / SameSite=Lax / Secure in production) — **never stored in the database**
- Passwords hashed with bcrypt (cost 10); login accepts username or email, case-insensitive
- MVP simplification: registration sets `is_verified=true` so users can log in
  immediately. Email verification and billing come later.

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
  `NODE_ENV=production`, while `.env.example` shipped `development`. Following the
  README verbatim bypassed it. Three individually reasonable decisions combined into
  a deployment that was insecure by default.
- The `BACKEND_INTERNAL_TOKEN` fallback is gone too: that's a lateral Worker →
  backend credential, a different purpose on a different rotation schedule. Sharing
  them means rotating the internal token logs everyone out, and any component that
  can read the internal token also gains the ability to forge any session.

**Changing the key invalidates every issued session** — users must log in again.

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
Blank is safe: the backend ignores both headers entirely when the token is empty,
and the only consequence is that image usage isn't recorded.

Three places must match. When they don't, **image accounting fails silently**
(usage isn't tracked and the quota becomes meaningless):

| Location | Purpose |
| --- | --- |
| `.env` | read by the backend, also feeds docker-compose |
| `.dev.vars` | local `wrangler dev` |
| `wrangler secret put BACKEND_INTERNAL_TOKEN` | production Worker |

### Rate limiting

| Endpoint | Dimension | Threshold |
| --- | --- | --- |
| Login | IP | 10 / 15 min |
| Login | Account | 100 / 15 min |
| Register | IP | 5 / hour |
| Share password check | IP | 20 / 15 min |
| Share password check | Link | 10 / 15 min |

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

The limiter is **per-process** (`ratelimit.go`). Across multiple instances each
process counts separately and effective thresholds multiply by N — move it to Redis
before scaling out.

### Security response headers

Added by the Worker at its single exit point (`worker/securityHeaders.ts`): CSP,
HSTS, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`,
`Cross-Origin-Opener-Policy`, `X-Content-Type-Options`.

Wrapped at the entry rather than added per branch: the Worker has 7 return paths,
and adding them one by one will eventually miss one — with no error to show it,
just an endpoint that quietly lost its protection.

Two places that must not be casually "tightened":

- `style-src` must keep `'unsafe-inline'`. Theme CSS is injected at runtime as a
  `<style>` tag (themes vary per document, so hashes can't be precomputed), and
  KaTeX writes a `style` attribute on every span it renders. Tightening it means
  formulas don't render and themes stop working — and that kind of "broken" usually
  ends with the whole CSP being deleted, which is worse than not having one.
  `script-src` *is* `'self'` with no `unsafe-inline`.
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

## Sharing

Two levels:

| Level | Meaning |
|---|---|
| `link` | Anyone with the link; the token is 32 random hex chars, not enumerable |
| `password` | Visitor must enter a password (bcrypt hash, at least 6 characters) |

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
```

The frontend page lives at `/share/$token`, requires no login, and reuses the
editor's extension set for its read-only view — so highlighting, formulas, and
images render exactly as they do while editing.

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
- **The public view exposes only title / content / updatedAt / ownerName** —
  internal ids, `user_id`, `doc_id`, and `share_token` never leak

### Loosening access must rotate the token

The rule is asymmetric because the risk is asymmetric (see `shouldRotateShareToken`):

| Change | Token | Why |
|---|---|---|
| Tighten (`link` → `password`) | reuse | Old links only get stricter; security strictly increases |
| Change password (`password` → `password`) | reuse | Access level unchanged |
| **Loosen (`password` → `link`)** | **rotate** | See below |

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

> ⚠ **The limiter is in-process** (no Redis client in `go.mod` yet). Across multiple
> instances each process counts separately and thresholds multiply by N. Move it to
> Redis before scaling out.

## Export

Six paths, all client-side so they cost no backend resources:

| Format | Implementation |
|---|---|
| `.md` | `storage.markdown.getMarkdown()` — the content already *is* Markdown |
| `.html` | Self-contained single file, styles inlined, KaTeX CSS from a CDN, formulas rendered at generation time |
| `.docx` | The `docx` library, built from the ProseMirror document tree |
| `.pdf` | html2canvas-pro rasterization + jsPDF pagination, one-click download |
| WeChat | Theme styles inlined + formulas as images, written to the clipboard |
| Print / Save as PDF | The browser's native print pipeline + `@media print` |

**Why PDF has two paths**: the only engine in a browser that produces vector-text
PDFs hangs off the print pipeline, and the print dialog can't be bypassed. So
"one-click download" and "selectable, searchable text" cannot both hold in a purely
client-side implementation. Each path keeps one of them:

| | One-click | Selectable text | Size |
|---|---|---|---|
| `.pdf` (raster) | yes | no, text is a bitmap | ~650 KB/page |
| Print / Save as PDF | no, requires the dialog | yes, vector | much smaller |

That dialog has nothing to do with printers: choosing "Save as PDF" in Chrome goes
through Skia's PDF backend and touches no printer driver, so it works with no
printer installed. In the CSS specs this area is called *paged media*; PDF is just
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

| WeChat does this | So we must |
|---|---|
| Strips `<style>` and external CSS | Put styles in each element's `style` attribute |
| Strips `class` / `id` | Use tag names as the only selectors |
| Strips `<script>` and friends | Delete those subtrees outright |
| Fetches and re-hosts external images on paste | Point formula images at real R2 URLs |
| Strips `white-space` (verified) | Carry indentation structurally, not via CSS |
| Keeps `background` (verified) | Dark themes survive as-is |

**Themes are stored as tag → declaration strings** (`wechatThemes.ts`), not as CSS
text. Since the final lookup can only be by tag name, we skip keepask's step of
regexing CSS out of Markdown. The cost is losing CSS expressiveness — but that
expressiveness was unusable under inlining anyway. keepask's themes contain things
like `h2:before{content:""}` decorative bars, which **are silently dropped when
inlined and simply never appear in WeChat**. So none of the themes here rely on
pseudo-elements. The only descendant selector kept is `pre code`, since a code block's
`code` looks different from inline `code`.

**Highlighting must be regenerated at export time.** `CodeBlockLowlight` highlights
via ProseMirror *decorations*, which are a view-layer concern and never enter the
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

**Formula images are cached by LaTeX source.** Without the cache every export
re-rasterizes and re-uploads — measured: switching themes a few times piled up 22
copies of the same image in R2, and with no images table those objects can neither be
listed nor cleaned up. The cache lives only for the current page session;
cross-session dedup needs server-side content hashing once the images table exists.

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

### Upload can't be tested by `npm run dev` alone

`npm run dev` wires Vite straight to the Go backend, so **the Worker isn't in the
path** and `/api/images` 404s — regardless of whether the frontend code is correct.

To test uploads, run wrangler (it ships a local R2 emulation that never touches
production data):

```bash
npx wrangler dev --port 8788 --var BACKEND_URL:http://localhost:8090
```

Local objects live in `.wrangler/state/v3/r2` (gitignored).

### Production configuration

```bash
wrangler secret put BACKEND_URL          # public address of the Go backend
wrangler secret put BACKEND_INTERNAL_TOKEN   # same value as the backend
# the R2 binding is in wrangler.jsonc; no secret needed
```

### Serving images over a CDN

Controlled by `IMAGE_PUBLIC_BASE`.

Left empty, images are read through the Worker proxy, **costing one Worker request
per load**. With an R2 custom domain configured, `publicURL` returns an absolute
address that goes through the CDN and no longer counts against Worker requests.

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

**Confirm with the self-check endpoint afterwards — don't just check that images load:**

```bash
curl https://yourdomain/api/images/config
# {"mode":"cdn","base":"https://img.yourdomain","valid":true,"warning":null}
```

That endpoint exists because a misconfiguration **falls back to the Worker proxy and
images still display** — so "images work" proves nothing about the CDN. Without it
you'd find out from next month's request count. Anything other than `mode: "cdn"`
means it isn't active, and `warning` explains why.

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

One command covers the frontend and Worker (typecheck on both sides plus 25
assertion suites):

```bash
npm test          # typecheck ×2 + 25 suites, stops at the first failure
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

`verify_export_formats.py` covers four formats, focusing on whether formulas
actually survive in each.

Both need the backend and database running, and leave a `pdfprobe` test account
behind.

## Build and deploy

```bash
npm run build     # vite build → spa/dist
npm run deploy    # build and wrangler deploy (configure wrangler and secrets first)
```

Backend: `cd backend && docker build -t koinote-backend .`, deploy to a VPS, and
point the Worker's `BACKEND_URL` secret at its public address.
