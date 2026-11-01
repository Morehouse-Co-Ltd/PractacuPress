# Thin wrappers so Linux CI and Windows developers share one vocabulary.
# Windows has no make; use scripts/test.ps1 there.

GO ?= go
PKG := ./apps/api/...

.PHONY: build test vet generate migrate tidy smoke web-install web-build web-dev web-start web-package package

build:
	$(GO) build $(PKG)

test:
	$(GO) test $(PKG)

vet:
	$(GO) vet $(PKG)

generate:
	$(GO) generate ./apps/api/ent/...

migrate:
	$(GO) run ./apps/api/cmd/migrate

tidy:
	$(GO) mod tidy

web-install:
	cd apps/web && npm install

web-build:
	cd apps/web && npm run build

web-dev:
	cd apps/web && npm run dev

web-start:
	cd apps/web && npm start

web-package:
	node scripts/package-windows.mjs

# Same pipeline as scripts/package.ps1: builds web + Rust + Go, runs the packaged
# smoke test, then writes release/PractacuPress and the zip.
package: web-package

smoke: build vet test
	@echo "smoke: build, vet and tests passed"
