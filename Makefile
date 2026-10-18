# Thin wrappers so Linux CI and Windows developers share one vocabulary.
# Windows has no make; use scripts/test.ps1 there.

GO ?= go
PKG := ./apps/api/...

.PHONY: build test vet generate migrate tidy smoke

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

smoke: build vet test
	@echo "smoke: build, vet and tests passed"
