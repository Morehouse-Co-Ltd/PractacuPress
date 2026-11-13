# API Task 3 — gzip middleware and media cache policy

**Status:** complete (all required verification green; commit created)

**Commit:** `2edee60` — `perf(api): gzip JSON responses and cache public media at the edge`
(parent `b8a3a4f`)

**Branch:** `feat/page-builder-v2-p0`

---

## 1. Files

Created (all committed):

| File | Purpose |
| --- | --- |
| `apps/api/internal/transport/http/gin/middleware/gzip.go` | `middleware.Gzip()` + `gzipWriter` |
| `apps/api/internal/transport/http/gin/middleware/gzip_test.go` | 9 table/behavior tests for the middleware |
| `apps/api/internal/transport/http/gin/gzip_router_test.go` | registration-level tests on the real engine (**beyond the brief**) |
| `apps/api/internal/media/cache_control_test.go` | `cacheControlFor` + download-header tests (**beyond the brief**) |

Modified:

| File | Change |
| --- | --- |
| `apps/api/internal/transport/http/gin/router.go` | `middleware.Gzip()` registered after `middleware.SecurityHeaders()` |
| `apps/api/internal/media/handler.go` | `Cache-Control` now comes from `cacheControlFor(asset.Purpose)`; helper appended at the bottom |

## 2. Middleware behavior

`Gzip()` is a no-op unless the request's `Accept-Encoding` contains `gzip`. It then
wraps `c.Writer` in a `gzipWriter` that encodes the response body with
`compress/gzip` (standard library, no new dependency).

### 2.1 Skip list (`streamingPrefixes`)

```go
var streamingPrefixes = []string{"/api/v1/events", "/api/v1/ws", "/api/v1/media/"}
```

* `/api/v1/events` — REST catch-up plus the long-lived feed; buffering through the
  compressor would hold every event until the connection closed.
* `/api/v1/ws` — websocket upgrade, no gzip body to produce.
* `/api/v1/media/` — **addition requested in the task** beyond the brief's two
  prefixes: downloads stream already-compressed image bytes (and large attachments),
  so re-encoding spends CPU to make the body bigger and delays the first byte.
  The path also covers `/api/v1/media/uploads…`; those JSON replies therefore stay
  uncompressed, which is accepted (they are small).
* An inbound `Upgrade` header also skips compression, because a connection about to be
  hijacked must not have its handshake sitting in the deflate buffer.

`Vary: Accept-Encoding` is set on every non-skipped response (unconditionally, not only
when the body ends up compressed) so a shared cache keys on the encoding.

### 2.2 Body-less responses (live interaction with Task 2's 304)

`Content-Encoding: gzip` is advertised on the **first body byte**, never up front:

* `WriteHeader(code)` marks 1xx / 204 / 304 as `skip`, so any later write is passed
  through untouched and no stream is ever started.
* The first `Write` sets `Content-Encoding`, drops `Content-Length`, and calls
  `WriteHeaderNow()` before handing bytes to the compressor. A handler that only sets a
  status (204, 304, or an empty 200) therefore never advertises an encoding at all —
  there is no header to delete later and no ordering race with the underlying flush.
  This is why the design document's 304 can answer with `ETag` and no
  `Content-Encoding`, and the test suite pins it.
* `Close()` emits nothing when no byte was accepted, so an empty response stays valid.

This achieves the brief's requirement ("header removed before the underlying writer
flushes") more strongly than deleting it in `WriteHeader`, by never writing it.

### 2.3 Correctness details the brief's snippet missed

1. **`WriteString` was not overridden.** gin serves `c.String` / text bodies through
   `ResponseWriter.WriteString`; with only `Write` overridden the promoted method writes
   the raw bytes while the response still claims `gzip` — a corrupt response. The
   wrapper now routes `WriteString` through `Write`
   (`TestGzipCompressesStringBody`).
2. **`Written()` would have lied while bytes sat in the deflate buffer.** The error
   translator and the panic recovery call `c.Writer.Written()` to decide whether a
   response may still be replaced. Buffered compressed bytes look unwritten, so a
   handler that wrote a body and then reported an error would have had a second response
   appended and its status overridden. The wrapper flushes the status line on the first
   byte (`TestGzipKeepsWrittenTrue`).
3. **The compressor must be closed on the panic path.** `Close` is deferred, so it runs
   while the panic unwinds — before `Recovery` writes its 500 — instead of leaving a
   truncated gzip stream for the recovery body to append to.
4. **`Flush` and `Unwrap`.** `Flush` flushes the compressor before the connection.
   `Unwrap` returns the underlying writer so `http.ResponseController` reaches the real
   connection: `RequestTimeout` sets a per-request write deadline through it, and a
   wrapper that hid the connection would have silently disabled that deadline for every
   compressed response.
5. **Late writer after the compressor is closed.** In the assembled engine order the
   compressor is registered *inside* `ErrorHandler`, so a `c.Error(...)` response is
   written after `Close`. The wrapper then writes it as plain bytes (no encoding header
   was ever set) instead of emitting gzip bytes nobody would decode, or returning an
   error. If the encoded body was already on its way, a second write returns
   `errGzipWriterClosed` rather than corrupting the stream. Covered by
   `TestGzipLateWriteAfterCloseIsPlain` (mirrors the real order) and
   `TestRouterErrorStaysReadableWhenCompressed` (real engine).
6. **`Content-Length`** is removed at the first body byte, since the compressed length is
   not known up front (`TestGzipCompressesJSON`).

### 2.4 Registration

```go
middleware.SecurityHeaders(),
// Compression runs after the security headers so a 304 or an error still
// carries them; it sits before handlers so every JSON body benefits. The
// desktop build talks to this process directly, so this is the only thing
// shrinking the design document on its way to a visitor.
middleware.Gzip(),
```

Placement follows the brief. Errors produced by the middlewares registered *after*
`Gzip` (auth guard, rate limit, CORS) and by `NoRoute` handlers run inside the compressor
and are compressed. Errors produced by handlers via `c.Error(...)` are handled by the
outer `ErrorHandler` and are sent uncompressed — still valid, and error bodies are tiny.
Moving `Gzip` outside `ErrorHandler` would compress those too; that is a one-line change
in `router.go` if desired later, and the middleware already tolerates either order.

## 3. Media cache policy

```go
func cacheControlFor(purpose Purpose) string {
	switch purpose {
	case PurposeSite, PurposeAvatar:
		return "public, max-age=31536000, immutable"
	default:
		return "private, max-age=300"
	}
}
```

`DownloadAsset` now sends `cacheControlFor(asset.Purpose)` instead of the blanket
`private, max-age=300`. Public site images and avatars are cacheable at the edge;
content and attachment assets stay private because a published article can be withdrawn.
An empty or unknown purpose falls into the private branch (safe default).

## 4. Tests (red → green)

Written first and confirmed failing (`undefined: Gzip`, `undefined: cacheControlFor`),
then implemented:

| Test | Asserts |
| --- | --- |
| `TestGzipCompressesJSON` | gzip encoding, `Vary`, no `Content-Length`, body decodes and parses |
| `TestGzipCompressesStringBody` | `c.String` path is compressed, not raw |
| `TestGzipSkipsWhenNotAccepted` | no encoding without `Accept-Encoding: gzip` |
| `TestGzipSkipsLongLivedAndBinaryRoutes` | events / events sub-path / ws / media / `Upgrade` all untouched |
| `TestGzipSkipsBodylessResponses` | 204, 304 and empty 200 carry no `Content-Encoding`, keep `ETag`, no body |
| `TestGzipCompressesProblemResponses` | problem JSON is a valid single gzip stream when inside the compressor |
| `TestGzipLateWriteAfterCloseIsPlain` | real order: `c.Error` body readable after close |
| `TestGzipPanicResponseIsReadable` | recovery 500 readable after the deferred close |
| `TestGzipKeepsWrittenTrue` | a written body is not replaced by the error translator |
| `TestRouterCompressesJSON` | real engine compresses `/healthz` |
| `TestRouterErrorStaysReadableWhenCompressed` | real engine 404 problem JSON parses |
| `TestCacheControlForPurpose` | policy per purpose, including empty/unknown |
| `TestDownloadAssetSendsThePurposeCachePolicy` | header on the wire per purpose for a real download |

## 5. Verification (repo root, shared working tree)

```
$ go build ./apps/api/...
(exit 0)

$ go test ./apps/api/internal/transport/http/gin/... ./apps/api/internal/media/ ./apps/api/internal/site/
ok  .../internal/transport/http/gin            0.105s
ok  .../internal/transport/http/gin/middleware
ok  .../internal/media
ok  .../internal/site

$ go vet ./apps/api/internal/transport/http/gin/...
(exit 0)

$ go test ./apps/api/... -count=1
(no FAIL lines)

$ go test ./apps/api/internal/transport/http/gin/ -run '<the five contract tests>' -v
--- PASS: TestEveryRegisteredRouteIsDocumented
--- PASS: TestEveryDocumentedRouteExists
--- PASS: TestEveryOperationDocumentsResponses
--- PASS: TestProblemCodeEnumMatchesImplementation
--- PASS: TestErrorResponsesUseProblemJSON
```

No route was added, so the OpenAPI contract tests are unaffected.

## 6. Shared working tree / staging

* Only my files were staged. New files were added by exact path. `router.go` and
  `media/handler.go` carry (or carried) other sessions' unstaged hunks, so both were
  staged hunk-by-hunk: a `HEAD`-based blob for `router.go` (HEAD + the five
  `Gzip()` lines) and the current diff for `media/handler.go`, using a private
  throw-away index for the commit so concurrent staged work in the shared index
  (e.g. `apps/web/src/pages/admin/ThemeBuilder.tsx`) was never swept in.
* `git add -A` / `git add .` / `git stash` / `git checkout -- .` were not used anywhere.
* `router.go` still carries other sessions' unstaged hunks (import order,
  `SecurityHeaders`, membership resolver, `registration_open`); `media/handler.go` is
  clean after the commit.

**Note for the parent:** the *committed* tree is not independently buildable right now,
but neither is its parent — `apps/api/internal/media/service.go` already references
`Actor.Role` / `AssetFilter.OwnerID` whose definitions exist only in other sessions'
unstaged edits (`actor.Role undefined` at `b8a3a4f` too). The shared working tree builds
and the full API suite passes. Nothing in this task's diff causes it.

## 7. Residual risks / follow-ups

* gzip-vs-br negotiation is not implemented (`gzip` only). Acceptable: it is what the
  brief specified, and gzip is universally supported.
* Error bodies produced through `c.Error` after the compressor closed are uncompressed
  (see §2.4). Reordering `Gzip` before `ErrorHandler` in `router.go` would compress
  them; not done to keep the brief's stated position.
* `HEAD` responses advertise `Content-Encoding: gzip` with no body (normal HTTP
  semantics: the encoding describes the GET representation). No handler serves HEAD
  specially today.
* `/api/v1/media/uploads…` JSON replies are no longer compressed because the media
  prefix is skipped. Small bodies; not worth a per-route exception.
