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

[中文](README.md) · [Design notes](docs/DESIGN.en.md) · [MIT License](LICENSE)

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

> This is the first open-source release. Editing, image hosting, export, and
> sharing all work; AI assistance and subscription billing are not implemented yet.

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
- Per-user quota (500 MB by default, covering document text and images)

**Export**

| Format | Notes |
|---|---|
| Markdown | As-is |
| HTML | Self-contained single file, styles inlined |
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
- Email/password plus Google and GitHub sign-in

## Stack

```
Browser ──▶ Cloudflare Worker ──┬─ serves the SPA assets
                                └─ /api/* reverse proxy ──▶ Go backend + Postgres
                                   images go straight to R2
```

- **Frontend** Vite · React 19 · TypeScript · TanStack Router · Tailwind v4
- **Editor** TipTap v3 (ProseMirror) · tiptap-markdown · KaTeX · lowlight
- **Backend** Go (stdlib `net/http`) · pgx · PostgreSQL 16
- **Edge** Cloudflare Worker · R2

Sessions are stateless HMAC-SHA256 signed cookies — nothing stored in the database.

## Quick start

You'll need Node 20+, Go 1.23+, and Docker.

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
`Secure`, which means it won't stick.

Then:

```bash
npm install
docker compose up -d postgres redis   # database
npm run backend:dev                   # backend (runs migrations automatically)
npm run dev                           # frontend → http://localhost:5273
```

Image upload needs wrangler as well — the R2 binding only exists on the Worker
side, and wrangler ships a local emulation:

```bash
npx wrangler dev --port 8788 --var BACKEND_URL:http://localhost:8090
```

> `BACKEND_INTERNAL_TOKEN` in `.dev.vars` must match the one in `.env`.

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

**`NODE_ENV` controls the cookie's `Secure` flag.** It must be `production` in production.

**Images are readable by anyone who has the URL.** Keys are random and
unguessable, but there is no authorization check — if a link to an image in a
private document leaks, anyone can view it. This is normal for image hosting, but
users generally assume images in a private document are private too. If that
doesn't work for your case, switch to signed URLs.

**Rate limiting is per-process.** Across multiple instances each process counts
separately, so effective thresholds multiply by N. Move it to Redis before scaling out.

**Rebuild the image after changing backend code.** `docker compose up -d` does not
rebuild; use `docker compose up -d --build backend`. Otherwise the code changes
and the behaviour doesn't, with no error to tell you.

## Deploy

```bash
npm run build     # → spa/dist
npm run deploy    # wrangler deploy (configure secrets first)
```

For the backend, `cd backend && docker build -t koinote-backend .`, deploy to a
VPS, and point the Worker's `BACKEND_URL` secret at its public address.

Secrets to set in production:

```bash
wrangler secret put BACKEND_URL
wrangler secret put BACKEND_INTERNAL_TOKEN   # same value as the backend
```

Serving images over a CDN (optional, saves Worker requests) is covered in the
[design notes](docs/DESIGN.en.md#serving-images-over-a-cdn).

### Continuous deployment

`.github/workflows/deploy.yml` deploys the Worker and the backend on every push
to `main` once CI passes, then health-checks the backend (`/health`) and the site
(`/api/images/config`).

Required repository secrets:

| Secret | Purpose |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Needs Workers Scripts edit, Workers R2 edit, Workers Routes edit |
| `CLOUDFLARE_ACCOUNT_ID` | Shown by `wrangler whoami` |
| `VPS_HOST` | Backend server address |
| `VPS_SSH_KEY` | Deploy-only private key (generate a dedicated one, don't reuse your personal key) |
| `VPS_HOST_KEY` | The server's known_hosts entry, used to pin the host key |

## Tests

```bash
npm test          # typecheck (both sides) + 25 assertion suites
npm run go:test   # go vet + go test
```

GitHub Actions runs both on every push and pull request, plus a job that checks
secret hygiene.

Export and sharing also have Playwright end-to-end scripts — see the
[design notes](docs/DESIGN.en.md#verification).

## Documentation

- [Design notes](docs/DESIGN.en.md) — why things are built this way, which traps
  we hit, and which degradations are deliberate
- [设计文档（中文）](docs/DESIGN.zh.md)

## License

[MIT](LICENSE)
