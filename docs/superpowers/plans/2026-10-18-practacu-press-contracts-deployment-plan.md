# Practacu Press Contracts and Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish the stable frontend contract and provide repeatable Windows local, Linux Docker, database, backup, upgrade, and acceptance workflows.

**Architecture:** OpenAPI 3.1 and the security protobuf are the cross-team sources of truth. Deployment files select SQLite, MySQL, or PostgreSQL without changing API behavior. The React team receives a generated TypeScript client plus a human-readable integration guide.

**Tech Stack:** OpenAPI 3.1, OpenAPI Generator, TypeScript client generation, Docker Compose, PostgreSQL, MySQL, SQLite, PowerShell, shell scripts, reverse proxy, health checks.

## Global Constraints

- REST endpoints live below `/api/v1`; breaking changes require `/api/v2`.
- WebSocket connections use a short-lived one-time ticket from `POST /auth/ws-ticket`.
- Error responses use `application/problem+json` with stable `code` and `request_id`.
- The frontend never connects directly to a database or Rust service.
- Windows installs default to one site; SaaS deployments can create multiple sites.
- Docker provides SQLite, MySQL, and PostgreSQL profiles; PostgreSQL is the production recommendation.
- Deployment scripts must be repeatable and must not create duplicate administrators or sites.
- Access Token is an Ed25519-signed JWT held in memory; Refresh Token is a rotated opaque cookie protected by a CSRF double-submit token.

---

### Task 1: Create the OpenAPI 3.1 source contract

**Files:**
- Create: `packages/contracts/openapi/openapi.yaml`
- Create: `packages/contracts/openapi/examples/auth.json`
- Create: `packages/contracts/openapi/examples/content.json`
- Create: `packages/contracts/openapi/examples/errors.json`
- Create: `packages/contracts/openapi/Makefile`
- Create: `tests/contract/openapi_lint_test.go`

**Interfaces:**
- Contract covers `/auth`, `/me`, `/sites`, `/articles`, `/posts`, `/comments`, `/reactions`, `/conversations`, `/notifications`, `/media`, `/moderation`, `/admin`, `/search`, and `/events`.
- Every write operation declares authentication, permissions, idempotency, status codes, error codes, and audit behavior.

- [ ] **Step 1: Write the contract skeleton and lint test**

Define `info`, `servers`, security schemes, reusable pagination, problem, user, site, content, notification, and media schemas. The lint test must fail while required paths are missing.

- [ ] **Step 2: Add authentication and site endpoints**

Document email/password, phone code, OAuth callback, refresh, logout, current user, site resolution, members, and role changes.

- [ ] **Step 3: Add content, social, messaging, media, moderation, and admin endpoints**

Include request/response examples for draft, pending review, published, rejected, archived, upload pending, and scan rejected states.

- [ ] **Step 4: Add WebSocket ticket and event schemas**

Document the ticket response, event envelope, event types, `GET /api/v1/events?after_id=<event_id>&limit=100` replay endpoint, reconnection behavior, and REST fallback.

- [ ] **Step 5: Lint and validate against a running API**

Run: `npx @redocly/cli lint packages/contracts/openapi/openapi.yaml`
Run: `go test ./tests/contract -v`
Expected: PASS with no unresolved `$ref` and no undocumented response status.

### Task 2: Produce the independent frontend integration guide and TypeScript client

**Files:**
- Create: `docs/frontend-integration.md`
- Create: `packages/sdk/typescript/README.md`
- Create: `packages/sdk/typescript/generate.ps1`
- Create: `packages/sdk/typescript/generate.sh`
- Create: `tests/contract/typescript_generation_test.ps1`

**Interfaces:**
- The guide must be usable without access to Go or Rust source code.
- Generated client exposes typed methods, request cancellation, cursor pagination, access-token injection, refresh handling, and WebSocket event types.

- [ ] **Step 1: Write the guide outline**

Include environment setup, base URL, CORS, registration, login, token refresh, site discovery, CRUD flows, moderation states, upload flow, WebSocket ticket flow, retries, errors, pagination, optimistic interactions, and logout.

- [ ] **Step 2: Add concrete request and response examples**

Show `fetch` and generated-client examples for registration, creating a draft, submitting review, publishing, commenting, liking, sending a message, marking a notification read, and uploading an image.

- [ ] **Step 3: Define frontend state rules**

Document memory-only access tokens, refresh-on-401 once, idempotency keys for retried writes, server-authoritative content status, event deduplication by event ID, and REST replay after WebSocket reconnect.

- [ ] **Step 4: Add SDK generation commands**

Use `openapi-generator-cli` with a pinned version. Generated output must be reproducible from `openapi.yaml` and must not be manually edited.

- [ ] **Step 5: Run generation and examples**

Run: `pwsh -File packages/sdk/typescript/generate.ps1`
Run: `pwsh -File tests/contract/typescript_generation_test.ps1`
Expected: generated client compiles and examples reference only documented operations.

### Task 3: Add Docker Compose profiles for all databases

**Files:**
- Create: `deploy/docker/compose.sqlite.yml`
- Create: `deploy/docker/compose.mysql.yml`
- Create: `deploy/docker/compose.postgres.yml`
- Create: `deploy/docker/.env.example`
- Create: `deploy/docker/nginx/default.conf`
- Create: `deploy/docker/README.md`
- Create: `tests/deployment/docker_smoke.ps1`

**Interfaces:**
- Each profile starts the Go API, Rust security service, worker, and reverse proxy; database service differs by profile.
- `GET /healthz` and `GET /readyz` must be usable from the reverse proxy.

- [ ] **Step 1: Write the smoke script first**

The script accepts a compose file, starts it, waits for `/readyz`, creates the initial admin once, checks OpenAPI availability, and tears down the stack.

- [ ] **Step 2: Create the common environment contract**

Define `APP_ENV`, `HTTP_ADDR`, `DATABASE_DRIVER`, `DATABASE_DSN`, `SECURITY_GRPC_ADDR`, storage settings, OAuth settings, and cookie/CORS settings in `.env.example`.

- [ ] **Step 3: Implement SQLite profile**

Persist SQLite and media directories as named volumes and use one API replica.

- [ ] **Step 4: Implement MySQL and PostgreSQL profiles**

Add database health checks, dependency conditions, persistent volumes, migration command, and a non-root database user.

- [ ] **Step 5: Add reverse proxy and security headers**

Proxy `/api` and WebSocket upgrade requests, enable TLS configuration hooks, and set HSTS/CSP/X-Content-Type-Options headers in production mode.

- [ ] **Step 6: Run all three smoke tests**

Run: `pwsh -File tests/deployment/docker_smoke.ps1 -Compose deploy/docker/compose.sqlite.yml`
Run the same command for MySQL and PostgreSQL files.
Expected: all profiles become ready, initialize once, expose docs, and shut down cleanly.

### Task 4: Build the Windows local installer and initialization wizard

**Files:**
- Create: `deploy/windows/installer/PractacuPress.wxs`
- Create: `deploy/windows/scripts/install.ps1`
- Create: `deploy/windows/scripts/uninstall.ps1`
- Create: `deploy/windows/scripts/init.ps1`
- Create: `deploy/windows/README.md`
- Create: `tests/deployment/windows_install.ps1`

**Interfaces:**
- Installer starts one local site using SQLite by default and can accept MySQL/PostgreSQL connection settings.
- Initialization is idempotent and returns the management URL and OpenAPI URL.

- [ ] **Step 1: Write installer acceptance checks**

Verify service registration, default data directory, SQLite initialization, admin creation, port conflict reporting, clean uninstall, and second-run idempotency.

- [ ] **Step 2: Package Go API, Rust service, migrations, and scripts**

Use versioned release artifacts; do not build from an uncommitted working tree during packaging.

- [ ] **Step 3: Implement PowerShell initialization**

Validate database selection, create the default site, hash the initial admin password through the Rust service, run migrations, and write a redacted config file.

- [ ] **Step 4: Add service lifecycle commands**

Support install, start, stop, restart, status, logs, backup, migrate, and uninstall.

- [ ] **Step 5: Run the Windows smoke test**

Run: `pwsh -File tests/deployment/windows_install.ps1`
Expected: install, initialize, health check, API docs check, backup, and uninstall all pass.

### Task 5: Add backup, restore, upgrade, and observability workflows

**Files:**
- Create: `scripts/backup.ps1`
- Create: `scripts/backup.sh`
- Create: `scripts/restore.sh`
- Create: `scripts/upgrade.sh`
- Create: `docs/operations.md`
- Create: `tests/deployment/restore_smoke.sh`

**Interfaces:**
- Backup contains database dump, media directory, site configuration, and a manifest with application/database versions.
- Restore refuses to overwrite a live target without an explicit stop/restore sequence.

- [ ] **Step 1: Write backup manifest and restore assertions**

Assert that a created article, media file, site setting, and member role survive backup and restore into a clean environment.

- [ ] **Step 2: Implement database-specific backup commands**

Use SQLite file copy with consistency check, `mysqldump` for MySQL, and `pg_dump` for PostgreSQL. Store outputs under a timestamped backup directory.

- [ ] **Step 3: Implement media and configuration backup**

Exclude secrets, include a redacted configuration manifest, and preserve object keys and metadata.

- [ ] **Step 4: Implement upgrade preflight**

Check backup availability, migration version, database connectivity, Rust policy compatibility, and disk space before changing files.

- [ ] **Step 5: Document health, logs, metrics, and recovery**

Document `/healthz`, `/readyz`, structured logs, request IDs, audit logs, backup retention, restore verification, and rollback steps.

- [ ] **Step 6: Run restore smoke tests**

Run: `sh tests/deployment/restore_smoke.sh`
Expected: restored content, media, settings, and permissions match the source environment.

### Task 6: Run final contract and deployment review

**Files:**
- Modify: `docs/frontend-integration.md`
- Modify: `docs/deployment.md`
- Create: `docs/release-checklist.md`

**Interfaces:**
- Release checklist links each acceptance item to a command or test suite.

- [ ] **Step 1: Compare OpenAPI with all registered Gin routes**

Fail the review if a route is undocumented, an OpenAPI operation is unimplemented, or an error code differs.

- [ ] **Step 2: Verify frontend flows against a clean Docker stack**

Execute registration, login, refresh, site loading, article draft, moderation, media upload, comment, reaction, message, notification, and WebSocket reconnect flows.

- [ ] **Step 3: Verify Windows local flow**

Repeat the essential flows using SQLite and the Windows installer output.

- [ ] **Step 4: Run release checks**

Run: `go test ./...`
Run: `cargo test --workspace`
Run all three Docker smoke profiles and the Windows install script.
Expected: all checks pass and `docs/release-checklist.md` records the tested versions.

- [ ] **Step 5: Commit documentation and deployment artifacts**

Commit: `git add packages/contracts docs deploy scripts tests/deployment; git commit -m "docs: publish api and deployment contracts"`
