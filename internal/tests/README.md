# Tests

This directory holds the checks that are not tied to one Go package.

## `internal/tests/ci` — delivery configuration

`go test ./internal/tests/ci/...` parses `.github/workflows/ci.yml` and
`docker-compose.yml` with the YAML parser already
in `go.mod`, and fails when:

- the workflow loses a trigger, job, timeout, cache or failure-log artifact;
- an action is unpinned, unknown, or points at a branch instead of a tag/SHA;
- the Go matrix stops covering Linux or Windows, or the web job drifts from the
  Node version in `../../Dockerfile`;
- the migration job loses its MySQL/PostgreSQL service containers or DSNs;
- a Compose build context references a Dockerfile that does not exist;
- the local `scripts/ci/verify.sh`, `scripts/verify.ps1` or `Makefile` targets
  disappear.

It needs no network and no Docker daemon.

## `internal/tests/migrations` — reviewed SQL change sets

`go test ./internal/tests/migrations/...` checks that every version has a matching
`.down.sql`, that up scripts stay additive, and then applies the change sets to
a real database:

1. create the minimal pre-migration schema from
   `internal/tests/fixtures/migrations/<dialect>/baseline.sql`;
2. apply every `.up.sql` in filename order;
3. assert the new columns, tables and indexes exist;
4. apply every `.down.sql` in reverse order;
5. assert the objects are gone;
6. drop the temporary schema so the next run starts clean.

SQLite always runs against a throwaway file. MySQL and PostgreSQL are skipped
unless their disposable database is exported:

```powershell
# Windows
$env:PP_TEST_MYSQL_DSN = 'root:root@tcp(127.0.0.1:3306)/practacu_test?parseTime=true'
$env:PP_TEST_POSTGRES_DSN = 'postgres://postgres:postgres@127.0.0.1:5432/practacu_test?sslmode=disable'
powershell -ExecutionPolicy Bypass -File scripts\verify.ps1 -Task migrations
```

```bash
# Linux/macOS
export PP_TEST_MYSQL_DSN='root:root@tcp(127.0.0.1:3306)/practacu_test?parseTime=true'
export PP_TEST_POSTGRES_DSN='postgres://postgres:postgres@127.0.0.1:5432/practacu_test?sslmode=disable'
bash scripts/ci/verify.sh migrations
```

A disposable database can be started with the service definitions from
`.github/workflows/ci.yml`:

```bash
docker run --rm -d --name pp-mysql -p 3306:3306 \
  -e MYSQL_ROOT_PASSWORD=root -e MYSQL_DATABASE=practacu_test mysql:8.4
docker run --rm -d --name pp-postgres -p 5432:5432 \
  -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=practacu_test postgres:17
```

The test only touches the tables it creates; still, point the DSNs at throwaway
databases, never at production. As a tripwire it refuses a MySQL/PostgreSQL DSN
whose database name does not contain `test` unless `PP_TEST_ALLOW_DESTRUCTIVE=1`
is set.

## `web/e2e` — real-browser delivery path

`web/e2e` is the Playwright suite that drives the actual UI against a
throwaway full stack. It is the only test set here that needs a browser and a
running API; the checks above stay network-free.

What one run covers, in order:

1. the eight-step install wizard (live mode, first admin, site rules) and a real
   logout → password login round trip;
2. creating a draft, saving it twice, publishing, and saving a post-publish
   revision (version history grows, status stays `published`);
3. reader registration, public article reading, a comment, the report dialog and
   submission, then like + bookmark;
4. a full page reload proves the like/bookmark state comes back from the API,
   and `/me/bookmarks` + `/me/likes` list the article;
5. `sitemap.xml`, `robots.txt`, `openapi.json`, the embedded `/api/v1/docs` page
   and `/admin/docs`;
6. admin settings persistence after reload: two storage strategies with the
   content scope in multi-strategy mode, the performance "current effect" cards
   plus a changed feed limit, and the bot-protection status cards plus an
   enabled switch and Site Key.

### Run it

```powershell
# Windows, from the repository root
powershell -ExecutionPolicy Bypass -File scripts\e2e.ps1

# or through npm
cd web
npm run e2e
```

```bash
# Linux/macOS
bash scripts/e2e.sh
```

Prerequisites: Go 1.26+, Node.js 22+, `npm install` in `web`, and Google Chrome
(the default `PP_E2E_CHANNEL=chrome`; use `PP_E2E_CHANNEL=chromium` after
`npx playwright install chromium` if Chrome is unavailable).

The harness builds the Go API, creates a fresh SQLite database under
`.tmp/e2e/data`, starts the API on a free test port, builds `web/dist`, and serves
it with `web/e2e/server.mjs` — a production-like static server that proxies
`/api`, `/sitemap.xml`, `/robots.txt` and `/feed*` to the API. Nothing outside
`.tmp/e2e` is written, and the processes are stopped on exit.

Useful switches / variables:

| Variable | Meaning |
| --- | --- |
| `PP_E2E_SKIP_WEB_BUILD=1` | reuse the current `web/dist` |
| `PP_E2E_CHANNEL=chrome\|msedge\|chromium` | browser channel (default `chrome`) |
| `PP_E2E_API_PORT` / `PP_E2E_WEB_PORT` | override the default test ports 18080 / 18100 |

Playwright uses one worker and one browser context per actor on purpose: the
install is a one-time state transition, not an isolated unit. Screenshots of
each checkpoint are written to `.tmp/e2e/artifacts/screens/`; a failure also
keeps the Playwright screenshot, trace and video under
`.tmp/e2e/artifacts/test-results/`. The HTML report is
`.tmp/e2e/artifacts/html/index.html` and a plain-text roll-up is
`.tmp/e2e/artifacts/summary.md`.

The harness starts the API with a much higher rate-limit budget
(`RATE_LIMIT_PER_MINUTE=100000`) because a headless browser navigating, reloading
and reconnecting the realtime channel can legitimately issue hundreds of
requests in a minute. Production defaults are untouched.

### CI

`.github/workflows/e2e.yml` is a separate, optional workflow
(`workflow_dispatch` + a weekly schedule). It is deliberately not part of the
required CI: it needs Chrome, while `ci.yml` stays fast. It uploads `.tmp/e2e/artifacts/` and the raw log on every run.

### Troubleshooting

- **`npm ci` fails with `EPERM: unlink ... esbuild.exe` on Windows**: an already
  running `npm run dev` / Vite watcher is holding the binary. Stop it (or run
  `npm install` instead), then retry.
- **`browserType.launch: Chromium distribution 'chrome' is not found`**: install
  Chrome, or run `npx playwright install chromium` in `web` and set
  `PP_E2E_CHANNEL=chromium`.
- **Tests 2–6 were skipped after a failure**: they share the one-time install
  state on purpose; Playwright restarts the worker after a failed test. Re-run
  the suite (the stack is rebuilt from scratch each time) or run `--grep` with
  the full sequence when debugging.

## Local commands

| Command | What it runs |
| --- | --- |
| `bash scripts/ci/verify.sh all` | Go build/vet/test, web typecheck/build/vitest, SQLite migration round trip + `cmd/migrate` idempotency, workflow/Compose validation |
| `powershell -ExecutionPolicy Bypass -File scripts\verify.ps1 -Task all` | the same on Windows |
| `make verify` | the same on Linux/macOS through the Makefile |
| `go test ./internal/tests/...` | only the checks in this directory |

MySQL/PostgreSQL round trips are included automatically when
`PP_TEST_MYSQL_DSN` / `PP_TEST_POSTGRES_DSN` are exported.

