# API Task 1 report — anonymous media read covers the site design document

- **Status:** DONE_WITH_CONCERNS (feature complete and verified; commit hygiene caveat below)
- **Branch:** `feat/page-builder-v2-p0`
- **Commit:** `b415c0937ddd6c173ab3ef4a22c2c4885332b023`
  `fix(api): let an anonymous reader fetch an image referenced by the site design`
- **Date:** 2026-11-03
- **Brief:** `.superpowers/sdd/api-task-1-brief.md` (mojibake; cross-checked against
  `docs/superpowers/plans/2026-11-02-page-builder-v2-p0-api.md` § Task 1)

## Problem

A page-builder block embeds an image stored with `purpose=content`. On the anonymous
read path the only rule was "some published article body mentions this asset id"
(`contentstore.Store.PublishedAssetReference`), so an image used *only* by a page
block returned 404 to a logged-out visitor. This change adds a second chance: the
site's saved design document is searched for the asset id.

## Changes

### Created `apps/api/internal/infrastructure/sitestore/design_reference.go`

- `DocumentMentionsAsset(document []byte, assetID string) bool` — pure function; empty
  document or empty asset id is false; otherwise `bytes.Contains`. The document stays
  opaque bytes; no JSON parsing.
- `DesignReferences` / `NewDesignReferences(client *entgen.Client)` — per-site cache of
  the design document with a 30 s TTL (`designCacheTTL`), guarded by a mutex. A site
  with no saved design caches an empty document instead of querying on every request.
- `(*DesignReferences).DesignAssetReference(ctx, siteID, assetID) (bool, error)` —
  implements the new `media.DesignReferenceChecker`. Nil receiver / nil client /
  empty site or asset id returns `(false, nil)`.

**Adaptation to the generated Ent API (required):** `FirstDocument` does not exist in
this checkout. The brief's fallback was used:

```go
row, err := d.client.SiteCustomization.Query().
    Where(sitecustomization.SiteIDEQ(siteID)).
    Only(ctx)
```

The schema declares `field.Text("document")`, so `row.Document` is a Go `string`; it is
converted once to `[]byte` for the pure function. `entgen.IsNotFound` caches an empty
document. No generated file under `apps/api/ent/**` was edited.

The plan snippet's `cachedDesign.revision` field was omitted: it was never written or
read, and keeping dead state in the cache struct would be misleading. The cache stores
exactly the bytes and the expiry it uses.

### Modified `apps/api/internal/media/service.go`

- Added `DesignReferenceChecker` interface after `PublishedReferenceChecker`:

  ```go
  type DesignReferenceChecker interface {
      DesignAssetReference(ctx context.Context, siteID, assetID string) (bool, error)
  }
  ```

- `Service` gained `design DesignReferenceChecker` (after `references`).
- `ServiceConfig` gained `Design DesignReferenceChecker` (after `References`).
- `NewService` copies `cfg.Design` into the service.
- `authorizeSharedAsset`'s `PurposeContent` branch now checks published references
  first (only when the checker is non-nil), then the design checker (only when
  non-nil), and returns `ErrNotFound` if neither claims the asset. Checker errors are
  propagated, so a broken check fails closed and an asset is never served on error.
- **Nil behaviour is unchanged:** with `Design == nil`, the flow is exactly the old
  one. Existing tests that build the service without the field still pass.
- Updated the `authorizeSharedAsset` doc comment to mention the design source.

### Modified `apps/api/cmd/server/main.go`

- One line added inside `media.NewService(media.ServiceConfig{...})`:

  ```go
  Design: sitestore.NewDesignReferences(handle.Client),
  ```

  The `sitestore` import already existed at the top of the file, so no import change was
  needed. Nothing else in this file was edited by me.

## TDD evidence

1. Wrote `apps/api/internal/infrastructure/sitestore/design_reference_test.go` first
   (the four assertions from the brief) → **red**:

   ```
   apps\api\internal\infrastructure\sitestore\design_reference_test.go:8:6: undefined: DocumentMentionsAsset
   ... (4 occurrences)
   FAIL github.com/practacu/practacu-press/apps/api/internal/infrastructure/sitestore [build failed]
   ```

2. Implemented `design_reference.go` → **green**:

   ```
   === RUN   TestDocumentMentionsAsset
   --- PASS: TestDocumentMentionsAsset (0.00s)
   PASS
   ok  github.com/practacu/practacu-press/apps/api/internal/infrastructure/sitestore
   ```

3. Wired media + main.go, then ran the full verification.

## Verification (from repo root, after the commit)

```
> go build ./apps/api/...
build-exit=0

> go test ./apps/api/internal/infrastructure/sitestore/ ./apps/api/internal/media/ ./apps/api/internal/site/
ok  github.com/practacu/practacu-press/apps/api/internal/infrastructure/sitestore
ok  github.com/practacu/practacu-press/apps/api/internal/media
ok  github.com/practacu/practacu-press/apps/api/internal/site
test-exit=0

> go vet ./apps/api/internal/infrastructure/sitestore/ ./apps/api/internal/media/ ./apps/api/cmd/server/
vet-exit=0
```

`gofmt -l` reports none of the four touched files.

## Test coverage note

The brief scoped the test to the pure function, and that is what was added. There is no
new `media`-package test that drives `OpenAssetInSite` through the design fallback,
because the media test helpers live in files being edited concurrently by another
session; adding a test there risked conflicts. The existing suites cover the nil-Design
path and the published-reference path. Suggested follow-up once the branch settles: a
media test where `PublishedAssetReference` returns false and
`DesignAssetReference` returns true, asserting `OpenAssetInSite` succeeds; plus the
inverse (both false → `ErrNotFound`) and a design-checker error (propagates).

## Commit hygiene concern (why DONE_WITH_CONCERNS)

The working tree was already carrying **uncommitted work from other agent sessions**
inside the two shared paths named by the brief. An index-level, whole-path `git add` of
exactly the four brief paths therefore staged those foreign hunks as well:

- `apps/api/internal/media/service.go`: the `PublishedReferenceChecker` interface and
  `references` plumbing, the `openAsset` refactor and `authorizeSharedAsset`, the
  role-aware `OpenAsset` / narrowed `ListAssets`, and the `site` import — i.e. the
  companion "anonymous media BOLA" work.
- `apps/api/cmd/server/main.go`: auth `RegistrationPolicy` / first-admin loopback
  wiring, community and messaging membership checkers, content `DraftQuota`, gin
  `Memberships`, and the site-service construction reorder — i.e. companion
  security-audit work.

Consequence: the committed tree `b415c09` may not compile on its own, because those
main.go calls target APIs that exist only in the other sessions' still-uncommitted
files under `internal/auth`, `internal/community`, `internal/messaging`,
`internal/content`, `internal/site`, and `internal/transport/http/gin`. In the shared
working tree everything builds and all tests pass. If a self-contained commit is
required, amend/rewrite with hunk-level staging after the other sessions commit, or
squash at branch integration. No file outside the brief's four paths was staged —
verified with `git diff --cached --name-only` immediately before committing:

```
apps/api/cmd/server/main.go
apps/api/internal/infrastructure/sitestore/design_reference.go
apps/api/internal/infrastructure/sitestore/design_reference_test.go
apps/api/internal/media/service.go
```

## Files touched

| File | Change |
| --- | --- |
| `apps/api/internal/infrastructure/sitestore/design_reference.go` | new |
| `apps/api/internal/infrastructure/sitestore/design_reference_test.go` | new |
| `apps/api/internal/media/service.go` | modified (interface, fields, config, NewService, content branch, comment) |
| `apps/api/cmd/server/main.go` | modified (one config line) |

Nothing beyond the brief's list.

## Behaviour summary

An anonymous (or non-owner member) request for a `purpose=content` asset is now allowed
when either:

1. a published content item of the site mentions the asset id in its source or rendered
   HTML (existing rule, unchanged), or
2. the site's `site_customizations.document` contains the asset id as a substring
   (new; 30 s cache staleness, opaque-byte match).

Everything else still returns `ErrNotFound`; attachments remain private; rejected
(non-clean) assets are denied before either check. A checker error is propagated rather
than treated as "not referenced".
