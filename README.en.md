# Practacu Press

[简体中文](README.md)　·　**English**

| Site frontend (default theme: Original · paper light) | Admin dashboard |
| :---: | :---: |
| ![Site frontend](docs/assets/readme/frontend.png) | ![Admin dashboard](docs/assets/readme/admin.png) |

> **A self-hosted community CMS: small footprint, fast, quick to run, easy to make your own.**
> A Go API with in-process security checks, and a React frontend plus admin — all aligned by one
> OpenAPI 3.1 contract. Windows and Linux are both first-class, and source, launcher and
> container installs share the same configuration.

## Why Practacu Press

| | |
| --- | --- |
| **Small footprint** | The Windows launcher is 8.3 MB and **embeds the entire frontend**; the frontend build is 1.3 MB. SQLite runs on a pure-Go driver, so the database is a single file — nothing extra to install, tune or back up. The default container deployment is one image: the API with the frontend and security checks embedded. |
| **Fast** | Requests pass through exactly one layer (Gin); Ent-generated code talks straight to `database/sql`; the pool and SQLite's WAL / busy_timeout are configured by the server itself. The frontend is a static single-page app with **no Node at runtime** and no server-render round trip; the gateway handles gzip and long-lived caching for fingerprinted assets, while first-screen request coalescing and media lazy-loading are configurable in the admin. |
| **Quick to run** | A seven-step setup wizard with live health checks: `docker compose up -d` or `启动.bat` starts the whole stack (API with embedded frontend and in-process security) in one command. Backup means copying the `data/` directory. |
| **Easy to make your own** | 3 built-in themes + 8 colour presets with JSON import/export; page composition with **independent desktop / tablet / phone layouts**, and every block can set its own corner radius, shadow, crop, background, padding and border, including a built-in button block; while writing you can insert mind maps, logic charts, statistical charts and fishbone diagrams that ship with the post and are redrawn with the theme; navigation, footer, SEO, access limits, domains and TLS, storage policies — all configurable item by item; everything sits behind an OpenAPI 3.1 contract (currently 124 paths / 148 operations, including health checks and install status; site-root sitemap / robots and the built-in `/api/v1/docs` page are outside the contract), so you can build your own frontend against it. |

**What it does**

- **Writing**: toolbar editor plus Markdown, live preview, word count on the rendered text; insert mind maps, logic charts, statistical charts (bar / line / donut / pie) and fishbone diagrams, stored in the body as `pp-diagram` fenced blocks
- **Community**: comments, likes, bookmarks, follows, DMs, notifications and reports, with a 5-state review flow
- **Operations**: themes, page composition, SEO, access limits, domains and SSL, storage policies, analytics
- **Security**: Argon2id, HTML allow-list sanitization and upload inspection run in the API process; failures fail closed by design. The local authorized security audit report is in [`docs/security/2026-11-14-security-audit.md`](docs/security/2026-11-14-security-audit.md)
- **Multi-site**: single-site out of the box; isolate content, members, themes, review rules and permissions per site when you need to

**Platform and license**: Windows / Linux, via source, the Windows launcher or Docker Compose; SQLite, MySQL and PostgreSQL are supported.
**AGPL-3.0** — commercial use is fine, but modified versions and network services must stay open source with the attribution preserved.

A longer introduction (architecture, stack, engineering trade-offs, current status and limitations) is in **[docs/introduction.md](docs/introduction.md#english)**.

---

**Layers**: every backend capability is exposed over REST (OpenAPI 3.1) and WebSocket; `web` is the frontend, admin console and first-run wizard implemented against that same contract.

- **Go API** (`cmd/server` + `internal/`): identity, sites, content, community, media, notifications, direct messages, event catch-up
- **Built-in security** (`internal/security`): Argon2id password hashing, content sanitization, upload inspection
- **Contract** (`packages/contracts`): OpenAPI 3.1 and protobuf
- **React frontend** (`web`): site frontend, admin console, seven-step setup wizard (including high-risk action protection), email-or-username sign-in (centered form over a themed background), theme library and page composition (independently per desktop / tablet / phone, with per-block corner radius, shadow and crop plus a button block), article writing (mind maps / logic charts / statistical charts / fishbone diagrams), custom pages, extension system (built-in extensions plus zip import: browser-only extensions and Go/WASM backend extensions; the performance panel is itself a built-in extension), site updates (display name / current version compared with the repository version.json / manual or automatic checks / GitHub or mirror update-source dropdown / manual build switching with no downtime), access limits, domains and SSL certificates plus the served port, performance settings and loading animations, and a performance panel with ring gauges for this app's and other processes' CPU / memory / disk use
- **High-risk action re-authentication**: deleting or editing accounts, resetting two-factor authentication, overwriting a site import, and deleting sensitive words / IP rules ask for the password again once protection is on. Verification follows the **browser session**: the first high-risk action after opening the browser asks for the password, repeated actions in the same session verify once (page refreshes do not ask again; closing the browser clears it). The fifth setup step enables it and lets you use the account password or a dedicated security password (changeable later in Site settings → High-risk action protection).

### Writing and reading

- **Writing**: the editor has a toolbar for headings, columns, images (with media-library upload), video cards, embedded-link cards, links, tables, galleries, callouts, quotes, dividers and icons; the preview sits on the right, and the word count is measured on the rendered plain text. Global shortcuts are `Shift+K` for the command palette, `Shift+S` for search, `Shift+D` to toggle light/dark and `Shift+H` to go home.
- **Markdown**: the server first converts Markdown to HTML with goldmark (GFM: tables, strikethrough, task lists, images, autolinks), then sanitizes it in-process against the allow-list — so `headings`, `tables` and `images` are real tags in a real deployment, not literals. Blocks inserted from the writing toolbar are HTML the allow-list preserves (columns are carried by `table.pp-columns`, and video is a cover card rather than an iframe).
- **Search**: the site header has a permanent search box that queries as you type (220 ms debounce, top 6 results), `/` focuses it, Enter opens the full result page; narrow screens keep only the magnifier.
- **SEO**: title templates, description, keywords, canonical, Open Graph / Twitter, JSON-LD (WebSite, SearchAction, Article, BreadcrumbList, Person), site-verification meta, a site-wide noindex switch, and a downloadable `sitemap.xml` / `robots.txt`. For the limits, see the notes in [Admin → SEO](web/src/pages/admin/Seo.tsx): tags are written into `<head>` by the frontend, so social crawlers that do not execute JS only ever see the defaults from `index.html`.
- **Themes**: Admin → Theme settings switches colours, typography and single-column / cards / two-column layout together as a single "big theme". Built in: the original (paper-white, single column), Daylight (white daily front page, single-row pill tabs, full-bleed article cover, single-column article) and Night Flight (warm dark, two columns). The theme picker can import a JSON theme, export the current one, save it as a custom theme, and delete custom themes. Page composition, appearance (brand / footer) and loading animation share one navigation group; switching themes only replaces the default components while the home page still uses the default composition. Every part of the footer (brand title / subtitle / blurb, status chips, columns and their items, copyright and bottom note) can be customised item by item under Theme settings → Navigation and footer. The top navigation is fully configurable too: each tab can take a built-in icon and a left/right position, tabs reorder freely, and up to 8 second-level entries can hang off a tab — rendered either as a capsule bar under the header or folded into a dropdown. The top-left of the header (Night Flight) and the area above the footer bar can carry a row of configurable software / social shortcut links (GitHub, X, Mastodon, RSS, email, any website). Theme fine-tuning adds softening and transitions: background glow, component blending, transition duration and header blur, all of which degrade automatically when the system requests reduced motion. Night Flight's home article cards can further switch between "Cover on top" (the default) and "Blurred background" (the cover fills the whole card with a gaussian blur while the title and summary sit on a frosted panel inside); this only changes presentation, never the content or its order.
- **Access and performance**: Admin → Access limits constrains page switches, page requests and concurrent pages per browser, and generates Nginx `limit_req` / `limit_conn` plus API `.env` snippets. Access and domains sets the primary domain, the alias allow-list, SSL certificates (Let's Encrypt / manual), CORS, cookie scope and trusted proxies; with no primary domain configured, production only allows direct access by public IP. Performance tuning reduces first-screen reads, coalesces duplicate requests and lazy-loads media, and generates gateway compression/caching plus API timeout and database pool parameters. Storage policies start from a global local directory or S3-compatible object storage (AWS, MinIO, Alibaba OSS, Tencent COS) and can then be overridden per purpose: article media, site images, user avatars and user data/attachments may each pick a local directory or a bucket/prefix, emitting `STORAGE_<SCOPE>_*` server snippets. Loading animation builds the frontend loading screen. All of these settings live in the local installation config; server parameters take effect once the snippet is deployed and the service restarted.
- **One-click reset**: page composition can restore the default components for the current home page or a custom page (title, path and publish state unchanged); Appearance can reset brand copy, home/page composition, loading animation, performance, access limits and access/domains by scope; Theme settings can restore the current theme definition or fall back to the original theme.

---

## Installation

Three ways in: **Docker** (recommended for Linux and servers), the **Windows launcher** (least work on a desktop), and **from source** (any platform; Go 1.26+ and Node.js 22+ for the frontend, security checks are compiled into the API).

### Docker (Linux / servers)

#### Install Docker first (skip if you already have it)

You need Docker Engine and Compose v2: the command is `docker compose` (a subcommand), not the older
`docker-compose`. If `docker compose version` prints a version after these steps, you are set.

Ubuntu / Debian (Docker's official apt repository; `${ID}` resolves to `ubuntu` or `debian`):

```bash
sudo apt-get update && sudo apt-get install -y ca-certificates curl gnupg
sudo install -m 0755 -d /etc/apt/keyrings
. /etc/os-release
curl -fsSL "https://download.docker.com/linux/${ID}/gpg" | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/${ID} ${VERSION_CODENAME} stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"   # log out and back in (or run newgrp docker) to drop sudo
docker compose version
```

> On derivatives such as Linux Mint, set `${ID}` to `ubuntu` and make sure `${VERSION_CODENAME}`
> exists in the official repository.

RHEL / CentOS / Rocky (dnf family):

```bash
sudo dnf -y install dnf-plugins-core
# RHEL 9 / 10:
sudo dnf config-manager --add-repo https://download.docker.com/linux/rhel/docker-ce.repo
# Rocky / AlmaLinux / CentOS Stream: use the centos repository instead:
# sudo dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
sudo dnf -y install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"
docker compose version
```

> On dnf5 systems (e.g. RHEL 10) where `config-manager --add-repo` is missing, use
> `sudo dnf config-manager addrepo --from-repofile=<the .repo URL above>`.

#### Build and start

The repository ships `docker-compose.yml`. By default it starts only the API (with the SPA embedded through `go:embed`) and the API:

```bash
docker compose up -d --build
```

The first build pulls base images and compiles the API and security-service images; allow a few minutes on a slow network.
Then check health:

```bash
docker compose ps                      # api / security running; api and security healthy
curl -fsS http://127.0.0.1:8080/api/healthz
```

Open **http://localhost:8080** and complete the seven-step wizard; **the first account it creates is the platform administrator**.

- **What runs**: `api` (one Go binary with the embedded SPA and security checks, serving `/api`, static assets and the SPA fallback). Only `api` is published to the host; there is no separate web/Nginx or security container.
- **Loopback by default**: the mapping is `127.0.0.1:8080:8080`, so an unfinished install cannot be claimed by the public internet. After setup, prefer the production overlay plus a host TLS proxy; do not expose an unfinished instance on `0.0.0.0:8080`.
- **Data**: the named volume `practacu-data` holds `practacu.db` and `media/`. `docker compose down` keeps it; `down -v` deletes it. To use a host directory instead, swap the volume for `./data:/data` and run `mkdir -p data && sudo chown 10001:10001 data` first.
- **Single-site shape**: compose sets `PP_DESKTOP=true`, the same zero-configuration bootstrap as the Windows launcher (create tables, create the default site, promote the first account). Docker port publishing hides the client address, so the default profile also sets `PP_FIRST_ADMIN_TRUST_PROXY=1` to relax the first-admin check; that is only safe on a loopback-bound port and can be set to `0` after installation. Set `PP_DESKTOP=false` for multi-site / SaaS and prepare the database and an administrator yourself.
- **Operations**: `docker compose logs -f`, `docker compose exec api migrate`, `docker compose exec api seed`; the image also ships `backup`, `media-gc` and `searchindex`.
- **Production deployment**: `docker-compose.prod.yml` + `deploy/production/nginx.conf` provide production semantics, a persistent JWT signing key, Secure cookies, TLS termination, security response headers and `location /__pp/ { return 404; }`. **Finish the first install on loopback before switching to production**; steps, key generation, backup and upgrade live in [docs/deployment/production-profile.md](docs/deployment/production-profile.md).
- **Build one image**: `docker build -f deploy/docker/api.Dockerfile .`.

> The default API image (embedded frontend and in-process security checks) and the compose stack have been built and started for real: the API reports healthy, and `/api/healthz`, `/api/readyz`, RSS/Atom/sitemap/robots, first-admin registration and login, media upload and a whole-instance backup were exercised. `docker compose config` passes. The host TLS proxy still needs a staging run to validate certificates and HSTS.

### Linux native package (tar.gz / deb / rpm)

If you would rather not use Docker and do not want Go / Node on the server, use the
prebuilt native package for your architecture (x86_64 or aarch64): API, seed, migrate, backup,
media-gc and searchindex binaries, the in-process security checks, the embedded frontend, and an
**interactive install wizard** (`install.sh`). The target machine only needs systemd and Nginx;
no development toolchain.

```bash
tar -xzf PractacuPress-Linux-<x64|arm64>.tar.gz
cd PractacuPress-Linux-<x64|arm64>
sudo ./install.sh
```

Debian/Ubuntu and RHEL/Fedora/openSUSE can also install the `.deb` / `.rpm` (both are published
for `amd64` and `arm64`). The package runs the same non-interactive install and depends on
`nginx`, `curl`, `openssl` and `ca-certificates`.

```bash
sudo apt install ./practacu-press_<version>_<arch>.deb
sudo dnf install ./practacu-press-<version>.<arch>.rpm
```

The wizard asks for the program directory, data directory, ports and whether to configure Nginx,
then creates the system user and directories, generates the Ed25519 signing key, installs the
systemd units, creates the database, and exposes the setup wizard on `127.0.0.1:8080` only —
**the first administrator can only be registered from loopback**, so remote servers need an SSH
tunnel (`ssh -L 8080:127.0.0.1:8080 user@server`) or a local browser. Once the seven-step wizard
is done, switch to the access mode you need:

```bash
sudo /opt/practacu-press/install.sh --finalize --mode lan                    # intranet / single-host HTTP
sudo /opt/practacu-press/install.sh --finalize --mode public --domain a.com  # public HTTPS (issues the certificate)
```

`--status` shows the state, re-running `sudo ./install.sh` is an upgrade (keeps data, keys and
access mode), and `uninstall.sh` removes the installation (data kept by default). The full steps —
SSH tunnel, domain verification, backup/upgrade/uninstall and troubleshooting — are in
[deploy/linux/INSTALL.md](deploy/linux/INSTALL.md).

Build the package yourself with `node scripts/package-linux.mjs --arch amd64|arm64` (works on
Windows and Linux build hosts: web build, cross-compiled Go, ELF/script/template
self-checks, tar.gz + sha256 in `release/`).

### Releases (GitHub Release / Docker images)

Pushing a commit whose message contains a version (`v1.0.0` stable, `v1.0.1-beta1` beta;
upper- or lower-case `v`) triggers [.github/workflows/release.yml](.github/workflows/release.yml):
it creates a GitHub Release with Windows x64/arm64 portable zips, Linux x86_64/aarch64 tar.gz,
deb and rpm, macOS x86_64/arm64 tar.gz and `SHA256SUMS`, and pushes the api / security
images for `linux/amd64,linux/arm64` to GHCR and Docker Hub. A beta only updates the version
tag and `beta`; it never overwrites `latest`.

- Repository secrets: `DOCKERHUB_USERNAME`, `DOCKERHUB_TOKEN` (GHCR uses the built-in
  `GITHUB_TOKEN`; Docker Hub is skipped when the username is empty).
- Image names: `ghcr.io/<owner>/practacu-press-{api,security}:<tag>` and
  `<dockerhub-user>/practacu-press-{api,security}:<tag>`.
- Run published images with
  `PP_IMAGE_PREFIX=ghcr.io/<owner> PP_VERSION=v1.0.0 docker compose -f docker-compose.yml -f docker-compose.release.yml up -d`.
- You can also dispatch the workflow manually with a version, or push a `v*` / `V*` tag. Full
  details: [docs/deployment/releases.md](docs/deployment/releases.md).

### Linux from source (bash)

If you would rather not use containers, run the sources directly (development, debugging or
self-hosting). Prerequisites: **Go 1.26+**, **Node.js 22+**, Git; security checks are compiled
into the API, so no extra service is required.

```bash
# Ubuntu / Debian base tools and Node.js 22 (Go below)
sudo apt-get update && sudo apt-get install -y git build-essential
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# Go 1.26+: download a linux-amd64 tarball from https://go.dev/dl/, unpack to /usr/local, add it to PATH.
# Example with go1.26.0 (any patch release >= the 1.26 in go.mod works):
#   curl -fsSLO https://go.dev/dl/go1.26.0.linux-amd64.tar.gz
#   sudo rm -rf /usr/local/go && sudo tar -C /usr/local -xzf go1.26.0.linux-amd64.tar.gz
#   export PATH=/usr/local/go/bin:$PATH

```

> On RHEL family systems replace the first line with `sudo dnf install -y git gcc-c++ make`, and install
> Node.js 22 from NodeSource's RPM repo: `curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash -`
> then `sudo dnf install -y nodejs`. For Go use the official releases too (distribution package
> versions are usually older than required).

```bash
cd practacu-press                      # repository root (git clone or unzip first)

# 1) Frontend: build once; the output is plain static files in web/dist
cd web && npm ci && npm run build && cd ../..

# 3) Environment: keep it in ~/.practacu-env.sh and source it in every shell
#    (a new terminal does not inherit exported variables)
cat > ~/.practacu-env.sh <<'EOF'
export APP_ENV=development
export HTTP_ADDR=127.0.0.1:8080
export DATABASE_DRIVER=sqlite
export DATABASE_DSN='file:./data/practacu.db'
export STORAGE_DRIVER=local
export STORAGE_DIR=./data/media
# Single-site self-hosting: the first registered account becomes platform admin.
# Leave this off for multi-site / SaaS deployments.
export PP_DESKTOP=true
EOF
source ~/.practacu-env.sh
mkdir -p data/media
```

> **GoLand / direct local run**: copy `.env.example` to `.env` in the repository root, keep the Run
> Configuration working directory at that root, and run `cmd/server` directly. The server loads the
> nearest `.env` from the working directory up to `go.mod`; variables already present in the
> environment win. In development the API serves a built `web/dist` from disk; run
> `make embed-web` to verify the embedded single-binary form.

Create the database and the default site (once). A new terminal does not inherit the environment, so
source the file again in each one:

```bash
# once: create tables + default site
source ~/.practacu-env.sh
go run ./cmd/seed -driver sqlite -dsn "$DATABASE_DSN"

# terminal B: Go API (listens on 127.0.0.1:8080)
source ~/.practacu-env.sh
go run ./cmd/server
```

Confirm the API is ready (both return 200; `readyz` checks the database):

```bash
curl -fsS http://127.0.0.1:8080/api/healthz
curl -fsS http://127.0.0.1:8080/api/readyz
```

> Release packages and Docker images copy `web/dist` into
> `internal/web/dist` before compiling, so one API process serves both the
> frontend and `/api`. A plain source `go run` is API-only by default; to test the
> single-binary shape locally, run `make embed-web` (or
> `node scripts/sync-web-embed.mjs`) first.

Run the frontend with the dev server, which proxies `/api`, `/api/healthz`, `/api/readyz` and `/plugins` to the
local 8080 API:

```bash
cd web
npm run dev -- --port 5173
```

Open **http://127.0.0.1:5173/?mode=live** and complete the seven-step wizard; **the first account it
creates is the platform administrator**. (Vite wants port 80 by default, which a non-root user on Linux
cannot bind, so 5173 is passed explicitly.)

> For single-domain self-hosting without the dev server: run `make embed-web` to embed the SPA in the
> API, then let Nginx (or similar) reverse-proxy `/` and `/api` to the API port (see
> `deploy/production/nginx.conf` and the [production deployment profile](docs/deployment/production-profile.md)).
> `npm start` only serves static files and does not proxy the API, and its default port (8080) collides with
> the API — do not run it in that setup.

### Windows launcher

Run **`启动.bat`** in the repository root (or double-click it):

- on first run it executes `npm install` automatically when `web/node_modules` is missing;
- it starts the Go API and SQLite in a dedicated window;
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

### PowerShell start (backend only)

```powershell
powershell -ExecutionPolicy Bypass -File scripts\dev.ps1
```

It creates the database and the default site → builds and starts the Go API → waits for `/api/healthz` → prints the addresses. `Ctrl+C` stops it.

The first run compiles the Go API (a few seconds), then starts it directly.

```
API        http://127.0.0.1:8080
OpenAPI    http://127.0.0.1:8080/api/v1/openapi.json
healthz    http://127.0.0.1:8080/api/healthz
```

### Manual start

```powershell
$env:PATH = 'C:\Program Files\Go\bin;' + $env:PATH
$env:APP_ENV='development'; $env:HTTP_ADDR='127.0.0.1:8080'
$env:DATABASE_DRIVER='sqlite'; $env:DATABASE_DSN='file:./data/practacu.db'
$env:STORAGE_DIR='./data/media'
# Local single-site installation: the first registered account becomes platform admin.
# Do not enable this for server deployments.
$env:PP_DESKTOP='true'

go run ./cmd/seed  -driver sqlite -dsn $env:DATABASE_DSN
go run ./cmd/migrate                      # tables only, no site
go run ./cmd/server
```

### Frontend

```powershell
cd web
npm install
npm run build
npm start
```

`http://localhost:8080` (port 8080 by default). Admin → Site settings → Access & domains → Port changes the port; the server starts listening on the new port immediately and remembers the choice. **`npm start` only serves static files and does not proxy the API**, and its default port is 8080 too, so to run it alongside the local API use dev mode instead: `npm run dev` (the dev server uses 80 and leaves 8080 to the API) proxies `/api`, `/api/healthz`, `/api/readyz` and `/plugins` to `127.0.0.1:8080`; on Linux a non-root user cannot bind port 80, so add `-- --port 5173`. Alternatively let Nginx serve the static build (see Linux from source above).

The first visit opens the setup wizard; with no backend you can choose demo data to explore the complete frontend and admin console. Details in the [frontend guide](web/README.md).

### Windows one-click package

```powershell
# Double-click 打包.bat in the repository root, or:
powershell -ExecutionPolicy Bypass -File scripts\package.ps1
```

The packaging script checks the toolchain and then runs the whole pipeline:

1. build the frontend (`web`, running `npm ci` automatically when `node_modules` is missing);
2. compile the security checks and frontend into the Go API;
3. sync the frontend output into the launcher's `go:embed` directory;
4. compile the Go launcher and the Go API (Windows target architecture: x64 or arm64, pure Go);
5. assemble a clean distribution directory and **actually boot the artifact on a temporary port to self-test it**:
   static site and SPA fallback, `/__pp/runtime`, `/api/healthz`, `/api/readyz`, registration, article creation
   (verifying that the built-in sanitizer strips `<script>`) and publishing;
6. compress to zip and sync `release/PractacuPress` (preserving any existing `data/` and
   `practacu-web.json`).

Any failing step stops immediately and prints the reason; a failing self-test never produces a new package.

Artifacts:

- `release/PractacuPress/PractacuPress.exe`: the native launcher, double-click to run, **no Node installation required**;
- `release/PractacuPress/PractacuPressAPI.exe`: the Go API, started by the launcher in real-environment mode;

- `release/PractacuPress-Windows-<x64|arm64>.zip` (plus a matching `.sha256`): the whole folder zipped —
  unzip and double-click the exe. The archive contains only the binaries, `VERSION` and `README.txt`,
  never the development machine's `data/`.

Common `scripts/package.ps1` parameters:

| Parameter | Meaning |
| --- | --- |
| `-Arch amd64\|arm64` | Target architecture (defaults to the current machine; arm64 is built natively on a Windows arm64 runner) |

| `-SkipSmoke` | Skip the post-packaging self-test (not recommended; the self-test is what keeps existing behaviour intact) |
| `-NoZip` | Only produce the `release/PractacuPress` directory |
| `-ReleaseDir <dir>` | Use a different output directory |
| `-Port <port>` | Pin the self-test port (a free port is chosen automatically by default) |

CI can call the underlying script directly (same pipeline):
`node scripts\package-windows.mjs --arch amd64|arm64 [--skip-smoke] [--no-zip] [--release-dir <dir>]`.
The launcher serves the site on port 8080 by default and opens the browser; if 8080 is taken it tries 8081 and 8082, then falls back to the standard HTTP port 80, and shows the actual address in its window. Changing Admin → Site settings → Access & domains → Port writes to `practacu-web.json` next to the exe, and the next start reuses it. The site only listens on the loopback address, closing the window stops it, and the API it started exits with it.

Both setup-wizard modes work out of the box:

- **Demo data**: writes only to the browser's `localStorage`, no service required;
- **Real environment**: the launcher already runs the API behind the same origin and the wizard connects automatically, with no address to type. The database is `data/practacu.db` next to the exe (pure-Go SQLite); the first start creates the tables and the default site, and the first account created in the wizard is the platform administrator. `/api`, `/api/healthz` and `/api/readyz` are reverse-proxied to the local API by the launcher, so there is no cross-origin configuration and cookies and WebSocket are treated as same-origin.

> The launcher serves over **http**. Absolute links such as notification mail and third
> party login callbacks assume https when `PUBLIC_BASE_URL` is unset, so set it in the
> launcher environment before starting: `PUBLIC_BASE_URL=http://127.0.0.1:<port>` (use
> the actual address shown in the window). The last setup-wizard step shows the exact
> line. Password reset links fall back to the current request origin.

Real-environment data all lives in `data/`: `practacu.db`, `media/`, `api.log`, `api.err.log` — close the window and copy the folder to back it up. When the exe directory is not writable it falls back to `%LOCALAPPDATA%\PractacuPress\data`. To force a frontend-only session, run `PractacuPress.exe --mode demo`.

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

# Create an article (content goes through the built-in sanitizer; <script> is stripped)
Invoke-RestMethod http://127.0.0.1:8080/api/v1/articles -Method Post `
  -Headers @{ Authorization = "Bearer $token" } -ContentType 'application/json' `
  -Body '{"title":"Hello","source_body":"<h1>Hi</h1><script>alert(1)</script>"}'
```

Public sites are readable without authentication: `Invoke-RestMethod http://127.0.0.1:8080/api/v1/articles`

---

## Repository layout

```
cmd/{server,migrate,seed,backup,media-gc,searchindex}  process entry points and ops commands
ent/schema/                      persistence models (Ent)
internal/
  auth/ site/ content/           feature modules (domain + service + handler)
  community/ messaging/ notifications/ moderation/ media/
  outbox/                        reliable events and retries
  platform/{config,logging,errors,page}
  infrastructure/                Ent repositories, storage adapters, securityclient
  transport/{http/gin,ws}        HTTP middleware and WebSocket
  web/                           go:embed SPA and static handler
web/                          React frontend, admin console and setup wizard
launcher/                     Windows launcher (separate Go module, go:embed)
internal/security/                  password hashing, content sanitization, upload inspection
packages/contracts/                OpenAPI and protobuf (generated code lives here too)
docs/superpowers/                  design specs, implementation plans, reviews, delivery status
scripts/                           dev / test / gen scripts
```

---

## Tests

```powershell
powershell -ExecutionPolicy Bypass -File scripts\test.ps1     # go build + vet + test
```

The S3 adapter is skipped by default and needs a real endpoint (MinIO / moto / AWS):

```powershell
python -m moto.server -p 9100
$env:S3_TEST_ENDPOINT='http://127.0.0.1:9100'
$env:AWS_ACCESS_KEY_ID='test'; $env:AWS_SECRET_ACCESS_KEY='testsecret'
go test ./internal/media/ -run TestS3 -v
```

---

## Configuration

See [.env.example](.env.example). A few things that bite:

| Variable | Meaning |
| --- | --- |
| `DATABASE_DRIVER` | `sqlite` / `mysql` / `postgres`. The server adds SQLite pragmas itself |
| `SECURITY_ARGON2_CONCURRENCY` / `SECURITY_ARGON2_TIMEOUT_MS` | In-process Argon2 concurrency and timeout bounds |
| `AUTH_JWT_ED25519_PRIVATE_KEY` | Required in production; in development a temporary key is generated with a warning |
| `TRUSTED_PROXIES` | Empty means no proxy is trusted and every `X-Forwarded-*` header is ignored |
| `RATE_LIMIT_PER_MINUTE` | API requests per IP per minute; `0` disables it. Browser-side limits are not a substitute |
| `MEDIA_DEFAULT_USER_QUOTA_BYTES` / `MEDIA_DEFAULT_SITE_QUOTA_BYTES` | Default cumulative media limits (512 MiB / 10 GiB); admins can override per member and site, and `0` means unlimited |
| `HTTP_READ_TIMEOUT_SECONDS` / `HTTP_IDLE_TIMEOUT_SECONDS` | HTTP read timeout and idle keep-alive timeout, 30 / 120 seconds by default |
| `DB_MAX_OPEN_CONNS` / `DB_MAX_IDLE_CONNS` | Database pool; `0` keeps the driver defaults (SQLite 1, MySQL/Postgres 25) |
| `DB_CONN_MAX_LIFETIME_SECONDS` | Connection lifetime; 1800 seconds by default, `0` means never recycle |
| `STORAGE_DRIVER` | `local` or `s3`. S3 requires `STORAGE_S3_BUCKET` |
| `SMTP_HOST` | Empty disables password reset; only once configured do `/auth/password-reset/*` endpoints work |
| `SMTP_ENCRYPTION` | `starttls` (587) / `ssl` (465) / `none` (25, local relay only) |
| `SMTP_USERNAME` / `SMTP_PASSWORD` | Must be set together; only TLS beyond a local relay |
| `SMTP_FROM` | Sender address, defaults to `SMTP_USERNAME` |
| `PUBLIC_BASE_URL` | Prefix for absolute links. Empty makes the server assume https (third party login callbacks and mail links depend on it); a desktop or localhost install served over http must set it explicitly |

The full password-reset path: login page → "Forgot password" → `POST /auth/password-reset/request`
(returns 202 whether or not the email exists) → the `?token=` link in the email opens `/reset-password` →
`POST /auth/password-reset/confirm` sets a new password and revokes every session for that account.
Tokens expire after 30 minutes and work once; a single account can send one email per 60 seconds.
Admin → Login settings → Email notifications generates this `.env` block directly.

> **When `PUBLIC_BASE_URL` is unset the server assumes https wherever no request
> context exists.** Third party login callbacks are built from the site domain as
> `https://`, and notification mail depends on it for its in-site link. A desktop
> launcher, a local `http://localhost` site or any other http deployment must set it
> explicitly, for example `PUBLIC_BASE_URL=http://127.0.0.1:80` (use the site's real
> port); otherwise those links point at an https address that does not exist. The API
> logs a warning at startup, and the last setup-wizard step shows the exact line to
> paste.

---

## Known limitations

| Item | Notes |
| --- | --- |
| MySQL / PostgreSQL | No dialect dependency in the code, but **neither database is available on this machine, so it is unverified in practice** — needs a CI matrix |
| Docker | Ships a single-image `docker-compose.yml` (API with embedded frontend and security checks); the image and compose stack have been built and run for real (health, auth, upload, backup), while the host TLS proxy remains untested |
| Linux package | Ships `PractacuPress-Linux-{x64,arm64}.tar.gz` plus `.deb`/`.rpm` for both architectures (prebuilt binaries + `install.sh` wizard + systemd/Nginx templates); cross-compilation and package contents are checked, but **the installer has not been run on a real Linux host** (bash syntax, rendered templates and `nginx -t` pass) |
| Windows installer (MSI) | Not implemented; Windows ships as a launcher plus a zip |
| Multi-replica WebSocket | Tickets and the hub live in process memory; multiple replicas need shared storage |
| Rate limiting | In-process fixed window, counted per replica; real DDoS/CC protection needs a reverse proxy or edge WAF |
| Browser-side access limits | Only constrain visitors using this site's scripts; IP-level request/concurrency limits are enforced by Nginx/Cloudflare, the admin only generates snippets |
| Domain aliases | The server resolves a single site from the Host header; alias domains need a reverse proxy to rewrite Host to the primary domain (the generated snippet includes this) |
| S3 upload memory | SigV4 requires buffering first, capped at the per-file limit (25 MiB) |
| Email | Password reset and email verification are wired up; comment-reply and review-result notification templates are not |
| SEO | Tags are written into `<head>` by the frontend; crawlers that do not execute JS only see the defaults from `index.html` |
| sitemap / robots | The Go API serves `/sitemap.xml` and `/robots.txt` at the site root per Host, and the admin can download static copies; static-only hosting must still place them in the site root manually |
| Not implemented | Frontend SDK generation, OAuth adapters, SMS codes, search pagination cursors |

For the detailed picture see [Current implementation vs. documentation](docs/superpowers/reports/2026-11-07-documentation-reality-check.md). The [2026-10-20 delivery status report](docs/superpowers/reports/2026-10-20-delivery-status.md) is a historical snapshot; its "not implemented" list no longer describes the current code.

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
