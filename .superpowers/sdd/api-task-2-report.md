# Task 2 report — design document conditional request (ETag / 304)

**Status:** DONE
**Branch:** `feat/page-builder-v2-p0`
**Commit:** `cc0409a` — `perf(api): serve the site design document with an ETag and answer 304`
**Files committed:** `apps/api/internal/site/handler.go`, `apps/api/internal/site/customization_etag_test.go` (new)

## What changed

`apps/api/internal/site/handler.go`

1. Imports: added `crypto/sha256`, `encoding/hex`, `fmt`. `strings`, `encoding/json`,
   `errors`, `net/http`, `time` were already imported; nothing else in the import block
   was touched.
2. Added two unexported helpers immediately before `GetCustomization`:
   - `customizationETag(revision int, document []byte) string` — strong, quoted ETag
     `"<revision>-<first 16 bytes of sha256, hex>"`.
   - `ifNoneMatchHit(header, etag string) bool` — trims, accepts `*`, and matches any
     element of a comma-separated list.
   Signatures and the body follow the brief verbatim.
3. `GetCustomization`: after the existing site-resolution, cross-site and members-only
   checks and after the service read, it now sets `Cache-Control: no-cache`, sets
   `ETag`, and answers `304 Not Modified` (no body) when `If-None-Match` matches.
   Otherwise it falls through to the unchanged `c.JSON(http.StatusOK, ...)`.

### Permission semantics

The ETag/304 branch is placed **after** every existing guard (`h.site`, the
`resolved.ID != siteID` cross-site rejection, and the members-only 404) and after
`h.service.Customization`. A members-only site still answers a non-member with the same
404 as a site that never saved a design; a 304 is never reachable for a caller the 404
hides the resource from. The existing
`TestCustomizationOnMembersOnlySiteIsHiddenFromOutsiders`,
`TestCustomizationRejectsForeignSitePath` and `TestCustomizationRoundTrip` all still pass
with the change in place.

### Deliberate behaviour details

- `W/"abc"` does **not** match `"abc"`: the brief pins that case to `false`, so the
  comparison is byte-exact over the trimmed candidates rather than RFC 7232 weak
  comparison. Implemented as specified.
- `Cache-Control: no-cache` means "revalidate every time" (not "do not store"), which
  is what makes the 304 path useful rather than simply shifting cost into a stale cache.

## TDD evidence

1. **Red** — `customization_etag_test.go` written first, exactly as in the brief:
   ```
   apps\api\internal\site\customization_etag_test.go:6:7: undefined: customizationETag
   ...
   apps\api\internal\site\customization_etag_test.go:33:13: undefined: ifNoneMatchHit
   FAIL github.com/practacu/practacu-press/apps/api/internal/site [build failed]
   ```
2. **Green** — after implementation:
   ```
   === RUN   TestCustomizationETag
   --- PASS: TestCustomizationETag (0.00s)
   === RUN   TestIfNoneMatchHit
   --- PASS: TestIfNoneMatchHit (0.00s)
   PASS
   ok  	github.com/practacu/practacu-press/apps/api/internal/site	3.453s
   ```

## Verification (from repo root)

| Command | Result |
| --- | --- |
| `go test ./apps/api/internal/site/ -run 'TestCustomizationETag\|TestIfNoneMatchHit' -v` | PASS (2/2) |
| `go test ./apps/api/internal/site/` (whole package) | `ok ... 4.376s` |
| `go build ./apps/api/...` | exit 0 |
| `go vet ./apps/api/internal/site/` | exit 0 |
| `go test ./apps/api/internal/transport/http/gin/ -run TestOpenAPI -v` | `[no tests to run]` — see note |
| `go test ./apps/api/internal/transport/http/gin/ -run 'TestEveryRegisteredRouteIsDocumented\|TestEveryDocumentedRouteExists\|TestEveryOperationDocumentsResponses\|TestProblemCodeEnumMatchesImplementation\|TestErrorResponsesUseProblemJSON' -v` | PASS (5/5) |
| `go test ./apps/api/internal/transport/http/gin/` (whole package) | `ok ... 0.102s` |

**Note on `-run TestOpenAPI`:** this repository's contract test file
(`openapi_contract_test.go`) contains no test whose name starts with `TestOpenAPI`; the
five tests listed above are the actual route/OpenAPI synchronisation checks. The selector
in the brief matches nothing, so it silently "passes". I ran the real names (all green) and
the whole `gin` package, which is the meaningful version of Step 5. No route and no schema
was added — only response headers on an existing operation — so `TestEveryRegisteredRouteIsDocumented`
and `TestEveryDocumentedRouteExists` still agree.

## Staging / shared-tree handling (important)

`apps/api/internal/site/handler.go` already carried another session's unstaged work
(domain verification: `GetDomain`, `VerifyDomain`, `domainResponse`, `toDomainResponse`,
`RegistrationOpen`/`DomainVerified` fields, extra routes). I did **not** stage it.

Procedure used:
- `git diff -- apps/api/internal/site/handler.go` captured the combined diff.
- Kept only the three hunks whose old-side start was mine (`@@ -1,8 +1,11 @@` imports,
  `@@ -430,6 +498,33 @@` helpers, `@@ -459,6 +554,18 @@` response block); the other nine
  hunks were foreign (old starts 81, 104, 128, 141, 155, 355, 369, 404, 640).
- `git apply --cached <filtered patch>` → `git diff --cached --stat` showed
  `handler.go | 42 ++++++` (insertions only), then
  `git add apps/api/internal/site/customization_etag_test.go` (exact path) and commit.

No `git add -A`, `git add .`, `git stash`, or `git checkout -- .` was used. After the
commit, `git status` still lists `M apps/api/internal/site/handler.go` — that is the other
session's nine hunks, untouched; my helpers are present in the working tree as well
(`customizationETag` at line 505, call site at 559).

## Deviations from the brief, and why

1. **Code comments are English**, not the Chinese comments in the snippet. Every other
   comment in `handler.go` (and the package) is English prose; the comment text conveys
   the same two points (why a 304 is worth it / a 304 carries no body). Function names,
   signatures, header names/values and logic are verbatim.
2. **`-run TestOpenAPI`** — see above; verified with the real test names because the
   brief's selector matches no test.
3. **Test map formatting** — the brief's `TestIfNoneMatchHit` case map is written with
   extra spaces that `gofmt` would rewrite; the committed file is the gofmt-clean
   equivalent (identical keys/values).

`gofmt -l apps/api/internal/site/` reports only `handler_customization_test.go`, which is
pre-existing and not mine; I left it untouched.

## Files touched beyond the brief

None. Only the two files the brief names were committed. No OpenAPI YAML, no router, no
service/repository, no frontend change.

## Follow-ups / notes for the parent

- The web client must send `If-None-Match` for this to help; that is the web-side task, not
  this one. The API now always emits `ETag` + `Cache-Control: no-cache` on a 200, so the
  browser's own revalidation already produces the 304 even if the client code is unchanged
  (same-origin fetch with default cache mode).
- Gin's `c.Status(304)` writes no body, but it also does not strip a `Content-Type` if one
  was set earlier on the same context; nothing sets one before this point, so the response
  is header-only as intended.
- Consider a later integration test that sends `If-None-Match: *` on a members-only site
  and asserts 404 (guarding the ordering requirement). It was not added because it belongs
  in `handler_customization_test.go` (`package site_test`), a file outside this brief; the
  ordering is currently protected only by the code's position and review.
