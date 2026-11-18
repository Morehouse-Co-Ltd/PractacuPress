# Thin wrappers so Linux CI and Windows developers share one vocabulary.
# Windows has no make; use scripts/test.ps1 or scripts/verify.ps1 there.

GO ?= go
NPM ?= npm
PKG := ./...

.PHONY: build test vet generate migrate tidy smoke \
	web-install web-typecheck web-build web-test web-dev web-start web-package package package-linux \
	embed-web \
	migrations-test config-test verify verify-go verify-launcher verify-web verify-migrations verify-config ci

build:
	$(GO) build $(PKG)

test:
	$(GO) test $(PKG)

vet:
	$(GO) vet $(PKG)

generate:
	$(GO) generate ./ent/...

migrate:
	$(GO) run ./cmd/migrate

tidy:
	$(GO) mod tidy

web-install:
	cd web && $(NPM) ci --no-audit --no-fund

web-typecheck:
	cd web && $(NPM) run typecheck

web-build:
	cd web && $(NPM) run build

# Copy the built SPA into internal/web/dist before a plain `go build`.
# Release/package scripts do this automatically; this target is for local runs.
embed-web: web-build
	node scripts/sync-web-embed.mjs

web-test:
	cd web && $(NPM) test

web-dev:
	cd web && $(NPM) run dev

web-start:
	cd web && $(NPM) start

web-package:
	node scripts/package-windows.mjs

# Same pipeline as scripts/package.ps1: builds web + Rust + Go, runs the packaged
# smoke test, then writes release/PractacuPress and the zip.
package: web-package

# Linux x86_64 install package: prebuilt Go + Rust binaries, install.sh wizard,
# systemd/Nginx templates, tar.gz + sha256 in release/.
package-linux:
	node scripts/package-linux.mjs

migrations-test:
	$(GO) test -v -count=1 ./tests/migrations/...

config-test:
	$(GO) test -v -count=1 ./tests/ci/...

# Full local gate, matching .github/workflows/ci.yml.
verify-go:
	$(GO) build ./...
	$(GO) vet ./...
	$(GO) test -count=1 ./...

# launcher is its own Go module and only builds on Windows. The root
# `./...` above never compiles it, so it needs this separate gate (CI runs it on
# windows-latest; Linux/macOS developers skip it).
verify-launcher:
	cd launcher && $(GO) build ./... && $(GO) vet ./... && $(GO) test -count=1 ./...

verify-web: web-install web-typecheck web-build web-test
	node --test scripts/release-version.test.mjs

verify-migrations: migrations-test
	@mkdir -p .tmp/verify
	$(GO) run ./cmd/migrate -driver sqlite -dsn "file:./.tmp/verify/make.db?_pragma=foreign_keys(1)"
	$(GO) run ./cmd/migrate -driver sqlite -dsn "file:./.tmp/verify/make.db?_pragma=foreign_keys(1)"

verify-config: config-test
	@command -v docker >/dev/null 2>&1 && docker compose -f docker-compose.yml config -q \
		|| echo "docker not available: compose config skipped (static checks above still ran)"

verify: verify-go verify-web verify-migrations verify-config
	@echo "verify: all local gates passed"

ci: verify

smoke: build vet test
	@echo "smoke: build, vet and tests passed"
