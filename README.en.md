# Practacu Press

[简体中文](README.md)　·　**English**

| Site frontend (default theme: Original · paper light) | Admin dashboard |
| :---: | :---: |
| ![Site frontend](docs/assets/readme/frontend.png) | ![Admin dashboard](docs/assets/readme/admin.png) |

> **A self-hosted community CMS: small footprint, fast, quick to run, easy to make your own.**
> A Go API, a Rust security service, and a React frontend plus admin — all aligned by one
> OpenAPI 3.1 contract. Windows and Linux are both first-class, and source, launcher and
> container installs share the same configuration.

## Why Practacu Press

| | |
| --- | --- |
| **Small footprint** | The Windows launcher is 8.3 MB and **embeds the entire frontend**; the Rust security service is 3.3 MB; the frontend build is 1.3 MB. SQLite runs on a pure-Go driver, so the database is a single file — nothing extra to install, tune or back up. The container deployment is three images: API, security service, static site. |
| **Fast** | Requests pass through exactly one layer (Gin); Ent-generated code talks straight to `database/sql`; the pool and SQLite's WAL / busy_timeout are configured by the server itself. The frontend is a static single-page app with **no Node at runtime** and no server-render round trip; the gateway handles gzip and long-lived caching for fingerprinted assets, while first-screen request coalescing and media lazy-loading are configurable in the admin. |
| **Quick to run** | A seven-step setup wizard with live health checks: `docker compose up -d` or `启动.bat` starts the whole stack (API + security service + frontend) in one command. Backup means copying the `data/` directory. |
| **Easy to make your own** | 2 built-in themes + 7 colour presets with JSON import/export; page composition with **independent desktop / tablet / phone layouts**; navigation, footer, SEO, access limits, domains and TLS, storage policies — all configurable item by item; everything sits behind an OpenAPI 3.1 contract (51 paths / 64 operations), so you can build your own frontend against it. |

**What it does**

- **Writing**: toolbar editor plus Markdown, live preview, word count on the rendered text
- **Community**: comments, likes, bookmarks, follows, DMs, notifications and reports, with a 5-state review flow
- **Operations**: themes, page composition, SEO, access limits, domains and SSL, storage policies, analytics
- **Security**: Argon2id, HTML allow-list sanitization and upload inspection live in the Rust service; if it is unreachable the API fails closed with 503
- **Multi-site**: single-site out of the box; isolate content, members, themes, review rules and permissions per site when you need to

**Platform and license**: Windows / Linux, via source, the Windows launcher or Docker Compose; SQLite, MySQL and PostgreSQL are supported.
**AGPL-3.0** — commercial use is fine, but modified versions and network services must stay open source with the attribution preserved.

A longer introduction (architecture, stack, engineering trade-offs, current status and limitations) is in **[docs/introduction.md](docs/introduction.md#english)**.

---

**Layers**: every backend capability is exposed over REST (OpenAPI 3.1) and WebSocket; `apps/web` is the frontend, admin console and first-run wizard implemented against that same contract.

- **Go API** (`apps/api`): identity, sites, content, community, media, notifications, direct messages, event catch-up
- **Rust security service** (`services/security`): Argon2id password hashing, content sanitization, upload inspection
- **Contract** (`packages/contracts`): OpenAPI 3.1 and protobuf
- **React frontend** (`apps/web`): site frontend, admin console, seven-step setup wizard, theme library and page composition (independently per desktop / tablet / phone), custom pages, built-in extensions, access limits, domains and SSL certificates, performance settings and loading animations

### Writing and reading

- **Writing**: the editor has a toolbar for headings, columns, images (with media-library upload), video cards, embedded-link cards, links, tables, galleries, callouts, quotes, dividers and icons; the preview sits on the right, and the word count is measured on the rendered plain text. Global shortcuts are `Shift+K` for the command palette, `Shift+S` for search, `Shift+D` to toggle light/dark and `Shift+H` to go home.
- **Markdown**: the server first converts Markdown to HTML with goldmark (GFM: tables, strikethrough, task lists, images, autolinks), then hands it to the security service for allow-list sanitization — so `headings`, `tables` and `images` are real tags in a real deployment, not literals. Blocks inserted from the writing toolbar are HTML the allow-list preserves (columns are carried by `table.pp-columns`, and video is a cover card rather than an iframe).
- **Search**: the site header has a permanent search box that queries as you type (220 ms debounce, top 6 results), `/` focuses it, Enter opens the full result page; narrow screens keep only the magnifier.
- **SEO**: title templates, description, keywords, canonical, Open Graph / Twitter, JSON-LD (WebSite, SearchAction, Article, BreadcrumbList, Person), site-verification meta, a site-wide noindex switch, and a downloadable `sitemap.xml` / `robots.txt`. For the limits, see the notes in [Admin → SEO](apps/web/src/pages/admin/Seo.tsx): tags are written into `<head>` by the frontend, so social crawlers that do not execute JS only ever see the defaults from `index.html`.
- **Themes**: Admin → Theme settings switches colours, typography and one-/two-column layout together as a single "big theme". Built in: the original (paper-white, single column) and Night Flight (warm dark, two columns). The theme picker can import a JSON theme, export the current one, save it as a custom theme, and delete custom themes. Page composition, appearance (brand / footer) and loading animation share one navigation group; switching themes only replaces the default components while the home page still uses the default composition. Every part of the footer (brand title / subtitle / blurb, status chips, columns and their items, copyright and bottom note) can be customised item by item under Theme settings → Navigation and footer. The top navigation is fully configurable too: each tab can take a built-in icon and a left/right position, tabs reorder freely, and up to 8 second-level entries can hang off a tab — rendered either as a capsule bar under the header or folded into a dropdown. The top-left of the header (Night Flight) and the area above the footer bar can carry a row of configurable software / social shortcut links (GitHub, X, Mastodon, RSS, email, any website). Theme fine-tuning adds softening and transitions: background glow, component blending, transition duration and header blur, all of which degrade automatically when the system requests reduced motion.
- **Access and performance**: Admin → Access limits constrains page switches, page requests and concurrent pages per browser, and generates Nginx `limit_req` / `limit_conn` plus API `.env` snippets. Access and domains sets the primary domain, the alias allow-list, SSL certificates (Let's Encrypt / manual), CORS, cookie scope and trusted proxies; with no primary domain configured, production only allows direct access by public IP. Performance tuning reduces first-screen reads, coalesces duplicate requests and lazy-loads media, and generates gateway compression/caching plus API timeout and database pool parameters. Storage policies start from a global local directory or S3-compatible object storage (AWS, MinIO, Alibaba OSS, Tencent COS) and can then be overridden per purpose: article media, site images, user avatars and user data/attachments may each pick a local directory or a bucket/prefix, emitting `STORAGE_<SCOPE>_*` server snippets. Loading animation builds the frontend loading screen. All of these settings live in the local installation config; server parameters take effect once the snippet is deployed and the service restarted.
- **One-click reset**: page composition can restore the default components for the current home page or a custom page (title, path and publish state unchanged); Appearance can reset brand copy, home/page composition, loading animation, performance, access limits and access/domains by scope; Theme settings can restore the current theme definition or fall back to the original theme.

---

## Installation

Three ways in: **Docker** (recommended for Linux and servers), the **Windows launcher** (least work on a desktop), and **from source** (any platform; Go 1.26+ and Node.js 22+ for the frontend, Rust optional — without the security service the API starts in a degraded mode).

### Docker (Linux / servers)

The repository ships a `docker-compose.yml` and three image definitions; one command starts the stack:

```bash
docker compose up -d --build
```

Open **http://localhost:8080** and complete the seven-step wizard; **the first account it creates is the platform administrator**.

- **What runs**: `web` (Nginx static site + same-origin reverse proxy), `api` (Go, a static binary), `security` (Rust gRPC). Only `web` is published to the host.
- **Loopback by default**: the mapping is `127.0.0.1:8080:80`, so an unfinished install cannot be claimed by the public internet. After setup, change it to `8080:80` and put TLS in front.
- **Data**: the named volume `practacu-data` holds `practacu.db` and `media/`. `docker compose down` keeps it; `down -v` deletes it. To use a host directory instead, swap the volume for `./data:/data` and run `mkdir -p data && sudo chown 10001:10001 data` first.
- **Single-site shape**: compose sets `PP_DESKTOP=true`, the same zero-configuration bootstrap as the Windows launcher (create tables, create the default site, promote the first account). Set it to `false` for multi-site / SaaS and prepare the database and an administrator yourself.
- **Operations**: `docker compose logs -f`, `docker compose exec api migrate`, `docker compose exec api seed`.
- **Build one image**: `docker build -f deploy/docker/api.Dockerfile .` (likewise `security.Dockerfile` and `web.Dockerfile`).

> There is no Docker on the development machine, so **this compose file and these images have never been run for real** — only the YAML, the file references and the health-check chain were statically validated. Open an issue if your first build fails.

### Windows launcher

Run **`启动.bat`** in the repository root (or double-click it):

- on first run it executes `npm install` automatically when `apps/web/node_modules` is missing;
- it starts the Go API and SQLite in a dedicated window, plus the Rust security service when available;
- it starts the Vite frontend in a dedicated window (`http://127.0.0.1:5173`, proxying `/api` to 8080);
- the browser opens `http://127.0.0.1:5173/?mode=live`: an existing real installation goes straight into the site, otherwise you enter the **real environment** setup wizard with 8080 auto-detected — it will not silently fall back to demo data;
- one-click start runs the API in desktop mode: the first account created in the wizard is the platform administrator. If an old database has members but no administrator, startup promotes the earliest active member so the installation can be completed;
- the browser opens automatically once everything is ready;
- if the API or the frontend is already running, they are reused rather than started twice on the same port.

To check the environment without starting anything:

```bat
启动.bat --check
```

To stop, press `Ctrl+C` in the "Practacu Press - API" window and close the "Practacu Press - Web" window.

If the machine has no usable Rust security service, the script starts the API with `-SkipSecurity`: browsing, writing and analytics work, but publishing articles and completing uploads return 503 by design.

### PowerShell start (backend only)

```powershell
powershell -ExecutionPolicy Bypass -File scripts\dev.ps1
```

It creates the database and the default site → starts the Rust security service → starts the Go API → waits for `/healthz` → prints the addresses. `Ctrl+C` stops all of them together.

The first run compiles Rust (about 4 minutes). Afterwards you can add `-SkipSecurity` to skip the security service (publishing content and completing uploads then return 503 — that is the designed behaviour, not a failure).

```
API        http://127.0.0.1:8080
OpenAPI    http://127.0.0.1:8080/api/v1/openapi.json
healthz    http://127.0.0.1:8080/healthz
```

### Manual start

```powershell
$env:PATH = 'C:\Program Files\Go\bin;' + $env:PATH
$env:APP_ENV='development'; $env:HTTP_ADDR='127.0.0.1:8080'
$env:DATABASE_DRIVER='sqlite'; $env:DATABASE_DSN='file:./data/practacu.db'
$env:SECURITY_GRPC_ADDR='127.0.0.1:9001'; $env:STORAGE_DIR='./data/media'
# Local single-site installation: the first registered account becomes platform admin.
# Do not enable this for server deployments.
$env:PP_DESKTOP='true'

go run ./apps/api/cmd/seed  -driver sqlite -dsn $env:DATABASE_DSN
go run ./apps/api/cmd/migrate                      # tables only, no site
go run ./apps/api/cmd/server
```

The Rust side:

```powershell
cd services/security
rustup run stable-x86_64-pc-windows-msvc cargo run --release
```

### Frontend

```powershell
cd apps/web
npm install
npm run build
npm start
```

`http://localhost` (port 80 by default, so the address bar needs no port). Admin → Site settings → Access port changes the port; the server starts listening on the new port immediately and remembers the choice. For development use `npm run dev`, also on port 80 by default, which proxies `/api`, `/healthz` and `/readyz` to `127.0.0.1:8080`.

The first visit opens the setup wizard; with no backend you can choose demo data to explore the complete frontend and admin console. Details in the [frontend guide](apps/web/README.md).

### Windows one-click package

```powershell
# Double-click 打包.bat in the repository root, or:
powershell -ExecutionPolicy Bypass -File scripts\package.ps1
```

The packaging script checks the toolchain and then runs the whole pipeline:

1. build the frontend (`apps/web`, running `npm ci` automatically when `node_modules` is missing);
2. compile the Rust security service (`services/security`, release);
3. sync the frontend output into the launcher's `go:embed` directory;
4. compile the Go launcher and the Go API (Windows amd64, pure Go);
5. assemble a clean distribution directory and **actually boot the artifact on a temporary port to self-test it**:
   static site and SPA fallback, `/__pp/runtime`, `/healthz`, `/readyz`, registration, article creation
   (verifying that Rust strips `<script>`) and publishing;
6. compress to zip and sync `release/PractacuPress` (preserving any existing `data/` and
   `practacu-web.json`).

Any failing step stops immediately and prints the reason; a failing self-test never produces a new package.

Artifacts:

- `release/PractacuPress/PractacuPress.exe`: the native launcher, double-click to run, **no Node installation required**;
- `release/PractacuPress/PractacuPressAPI.exe`: the Go API, started by the launcher in real-environment mode;
- `release/PractacuPress/practacu-security.exe`: the Rust security service, compiled and bundled by default;
- `release/PractacuPress-Windows-x64.zip` (plus a matching `.sha256`): the whole folder zipped —
  unzip and double-click the exe. The archive contains only the binaries and `README.txt`, never the
  development machine's `data/`.

Common `scripts/package.ps1` parameters:

| Parameter | Meaning |
| --- | --- |
| `-SkipSecurity` | Do not compile or bundle the Rust security service (publishing and uploads then fail closed with 503) |
| `-SkipSmoke` | Skip the post-packaging self-test (not recommended; the self-test is what keeps existing behaviour intact) |
| `-NoZip` | Only produce the `release/PractacuPress` directory |
| `-ReleaseDir <dir>` | Use a different output directory |
| `-Port <port>` | Pin the self-test port (a free port is chosen automatically by default) |

CI can call the underlying script directly (same pipeline):
`node scripts\package-windows.mjs [--skip-security] [--skip-smoke] [--no-zip] [--release-dir <dir>]`.
On a machine without a Rust toolchain, a package built with `-SkipSecurity` still browses, writes and demos — only publishing articles and completing uploads return 503.

The launcher serves the site on port 80 by default and opens the browser; if 80 is taken it uses 8080 and shows the actual address in its window. Changing Admin → Site settings → Access port writes to `practacu-web.json` next to the exe, and the next start reuses it. The site only listens on the loopback address, closing the window stops it, and the API and security service it started exit with it.

Both setup-wizard modes work out of the box:

- **Demo data**: writes only to the browser's `localStorage`, no service required;
- **Real environment**: the launcher already runs the API behind the same origin and the wizard connects automatically, with no address to type. The database is `data/practacu.db` next to the exe (pure-Go SQLite); the first start creates the tables and the default site, and the first account created in the wizard is the platform administrator. `/api`, `/healthz` and `/readyz` are reverse-proxied to the local API by the launcher, so there is no cross-origin configuration and cookies and WebSocket are treated as same-origin.

Real-environment data all lives in `data/`: `practacu.db`, `media/`, `api.log`, `api.err.log` — close the window and copy the folder to back it up. When the exe directory is not writable it falls back to `%LOCALAPPDATA%\PractacuPress\data`. To force a frontend-only session, run `PractacuPress.exe --mode demo`.

> Without the security service the site still runs, but publishing articles and completing uploads fail closed with 503.
> The default package compiles `practacu-security.exe` itself; only packages built with `-SkipSecurity` lack it.

---

## Try it

```powershell
# Register (returns an access token)
$r = Invoke-RestMethod http://127.0.0.1:8080/api/v1/auth/register/email -Method Post `
  -ContentType 'application/json' `
  -Body '{"email":"a@example.com","password":"correct horse battery","display_name":"A"}'
$token = $r.access_token

# Current user
Invoke-RestMethod http://127.0.0.1:8080/api/v1/me -Headers @{ Authorization = "Bearer $token" }

# Create an article (content goes through Rust sanitization; <script> is stripped)
Invoke-RestMethod http://127.0.0.1:8080/api/v1/articles -Method Post `
  -Headers @{ Authorization = "Bearer $token" } -ContentType 'application/json' `
  -Body '{"title":"Hello","source_body":"<h1>Hi</h1><script>alert(1)</script>"}'
```

Public sites are readable without authentication: `Invoke-RestMethod http://127.0.0.1:8080/api/v1/articles`

---

## Repository layout

```
apps/api/
  cmd/{server,migrate,seed}        process entry points and ops commands
  ent/schema/                      persistence models (Ent)
  internal/
    auth/ site/ content/           feature modules (domain + service + handler)
    community/ messaging/ notifications/ moderation/ media/
    outbox/                        reliable events and retries
    platform/{config,logging,errors,page}
    infrastructure/                Ent repositories, storage adapters, Rust gRPC client
    transport/{http/gin,ws}        HTTP middleware and WebSocket
apps/web/                          React frontend, admin console and setup wizard
services/security/                 Rust security service (tonic)
packages/contracts/                OpenAPI and protobuf (generated code lives here too)
docs/superpowers/                  design specs, implementation plans, reviews, delivery status
scripts/                           dev / test / gen scripts
```

---

## Tests

```powershell
powershell -ExecutionPolicy Bypass -File scripts\test.ps1     # go build + vet + test
```

Rust:

```powershell
cd services/security
rustup run stable-x86_64-pc-windows-msvc cargo test
```

The S3 adapter is skipped by default and needs a real endpoint (MinIO / moto / AWS):

```powershell
python -m moto.server -p 9100
$env:S3_TEST_ENDPOINT='http://127.0.0.1:9100'
$env:AWS_ACCESS_KEY_ID='test'; $env:AWS_SECRET_ACCESS_KEY='testsecret'
go test ./apps/api/internal/media/ -run TestS3 -v
```

---

## Configuration

See [.env.example](.env.example). A few things that bite:

| Variable | Meaning |
| --- | --- |
| `DATABASE_DRIVER` | `sqlite` / `mysql` / `postgres`. The server adds SQLite pragmas itself |
| `SECURITY_GRPC_ADDR` | Address of the Rust service. **When unreachable, publishing and uploads return 503** — that is fail-closed by design |
| `AUTH_JWT_ED25519_PRIVATE_KEY` | Required in production; in development a temporary key is generated with a warning |
| `TRUSTED_PROXIES` | Empty means no proxy is trusted and every `X-Forwarded-*` header is ignored |
| `RATE_LIMIT_PER_MINUTE` | API requests per IP per minute; `0` disables it. Browser-side limits are not a substitute |
| `HTTP_READ_TIMEOUT_SECONDS` / `HTTP_IDLE_TIMEOUT_SECONDS` | HTTP read timeout and idle keep-alive timeout, 30 / 120 seconds by default |
| `DB_MAX_OPEN_CONNS` / `DB_MAX_IDLE_CONNS` | Database pool; `0` keeps the driver defaults (SQLite 1, MySQL/Postgres 25) |
| `DB_CONN_MAX_LIFETIME_SECONDS` | Connection lifetime; 1800 seconds by default, `0` means never recycle |
| `STORAGE_DRIVER` | `local` or `s3`. S3 requires `STORAGE_S3_BUCKET` |
| `SMTP_HOST` | Empty disables password reset; only once configured do `/auth/password-reset/*` endpoints work |
| `SMTP_ENCRYPTION` | `starttls` (587) / `ssl` (465) / `none` (25, local relay only) |
| `SMTP_USERNAME` / `SMTP_PASSWORD` | Must be set together; only TLS beyond a local relay |
| `SMTP_FROM` | Sender address, defaults to `SMTP_USERNAME` |
| `PUBLIC_BASE_URL` | Prefix for reset links; empty uses the request's own origin |

The full password-reset path: login page → "Forgot password" → `POST /auth/password-reset/request`
(returns 202 whether or not the email exists) → the `?token=` link in the email opens `/reset-password` →
`POST /auth/password-reset/confirm` sets a new password and revokes every session for that account.
Tokens expire after 30 minutes and work once; a single account can send one email per 60 seconds.
Admin → Login settings → Email notifications generates this `.env` block directly.

---

## Known limitations

| Item | Notes |
| --- | --- |
| MySQL / PostgreSQL | No dialect dependency in the code, but **neither database is available on this machine, so it is unverified in practice** — needs a CI matrix |
| Docker | Ships a `docker-compose.yml` and three image definitions (API / security service / static site); **no Docker on the development machine, so the images have never been built or run** |
| Windows installer (MSI) | Not implemented; Windows ships as a launcher plus a zip |
| Multi-replica WebSocket | Tickets and the hub live in process memory; multiple replicas need shared storage |
| Rate limiting | In-process fixed window, counted per replica; real DDoS/CC protection needs a reverse proxy or edge WAF |
| Browser-side access limits | Only constrain visitors using this site's scripts; IP-level request/concurrency limits are enforced by Nginx/Cloudflare, the admin only generates snippets |
| Domain aliases | The server resolves a single site from the Host header; alias domains need a reverse proxy to rewrite Host to the primary domain (the generated snippet includes this) |
| S3 upload memory | SigV4 requires buffering first, capped at the per-file limit (25 MiB) |
| Email | Only password reset is implemented; verification and reply-notification templates are not wired up |
| SEO | Tags are written into `<head>` by the frontend; crawlers that do not execute JS only see the defaults from `index.html` |
| sitemap / robots | Generated and downloadable from the admin; with static hosting you must place them in the site root manually |
| Not implemented | Frontend SDK generation, OAuth adapters, SMS codes, search pagination cursors |

For the detailed picture see the [delivery status report](docs/superpowers/reports/2026-10-20-delivery-status.md).

---

## Design documents

- [Product and technical design](docs/superpowers/specs/2026-10-18-practacu-press-design.md) (Chinese)
- [Plan review and feasibility](docs/superpowers/reviews/2026-10-18-practacu-press-plan-review.md) (Chinese)
- [Detailed implementation plan](docs/superpowers/plans/2026-10-18-practacu-press-backend-detailed-plan.md) (Chinese)
- [Implementation progress](docs/superpowers/plans/2026-10-18-practacu-press-progress.md) (Chinese)

---

## License

This project is released under the **GNU Affero General Public License v3.0** (`AGPL-3.0`); the full text is in [LICENSE](LICENSE).

Three sentences cover what it asks of you:

- **Commercial use is allowed**: you may deploy it, modify it and sell a service on top of it, with no fee or permission required.
- **Modifications must stay open**: if you distribute a modified version, or run it as a network service for others (exactly the case AGPL §13 covers), you must publish the complete modified source under the same license.
- **Attribution is required**: derivative works must keep this project's copyright notice, project name and repository URL, and must mark the files they changed — that is AGPL §5 and §7(b), and the formal way of saying "do not strip the author out and pass it off as your own".

Scenarios that cannot accept AGPL (embedding it in a closed-source product, for example) have **no** commercial dual-licensing today.

```text
Practacu Press — a multi-site community CMS
Copyright (C) 2026 Practacu Press contributors

SPDX-License-Identifier: AGPL-3.0-only
```
