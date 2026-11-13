# P3 · Task 1 — 服务端列表筛选参数 · Report

**Status:** DONE
**Commit:** `14d9a51` — `feat(api): filter the content list by category, tag, since and sort`
**Branch:** `feat/page-builder-v2-p0`
**Scope:** `GET /articles` and `GET /posts` accept `category_id`, `tag`, `since`, `sort`.

## What was built

### `apps/api/internal/content/service.go`

New public surface (all in package `content`):

| Symbol | Meaning |
| --- | --- |
| `SortNewest = "newest"` / `SortOldest = "oldest"` | the two accepted orderings |
| `MaxTagFilterLength = 40` | bound on a tag **filter** value (storage bound `MaxTagLength = 24` is unchanged) |
| `maxCategoryIDLength = 36` (unexported) | mirrors the `content_item.category_id` column bound, shared with the handler |
| `NormalizeTag(raw string) string` | trim; `""` for blank, over-long (`>40` runes) or containing `"` / `\` |
| `ValidateSort(raw string) (string, error)` | `""`/`newest` → `newest`, `oldest` → `oldest`, anything else → `ErrInvalidInput` |
| `(*Service).listFilter(...)` (unexported) | merges caller narrowing with the fields the service owns |

`ListFilter` gained exactly the four planned fields (`CategoryID`, `Tag`, `Since`, `Sort`) with the
planned doc comments. `ListFilter` is now treated as two halves: the service overwrites
`SiteID`/`Kind`/`Statuses`/`After`/`Limit`, the rest is caller narrowing.

`ListAfter` → `ListAfterFilter(ctx, actor, kind, limit, after, ListFilter{})`.
`ListAfterFilter` takes `narrow ListFilter` instead of `authorID string` (its only HTTP caller was
`handler.list`). `List` also takes `narrow ListFilter` so the plan's "`List` 与 `ListAfter` 把它们透传给仓储"
is literally true; `ListOwn` is unchanged. Invalid `tag` / `sort` / `category_id` arriving through the
service is refused, never silently dropped — a dropped filter would *widen* the page.

### `apps/api/internal/content/handler.go`

`parseListFilter(c *gin.Context) (ListFilter, error)` (pure, testable) parses `author_id`,
`category_id` (≤36 runes), `tag` (via `NormalizeTag`), `since` (RFC 3339), `sort` (via `ValidateSort`);
every malformed value returns `ErrInvalidInput`, which `mapError` already projects to a 400
`validation_failed`. `list` calls it, then `page.Decode`, then `ListAfterFilter` with the filter.

### `apps/api/internal/infrastructure/contentstore/store.go`

In `List`:

- `CategoryID != ""` → `contentitem.CategoryIDEQ`
- `Tag != ""` → `contentitem.TagsContains("\"" + tag + "\"")` (verified generated name at
  `apps/api/ent/contentitem/where.go:983`). Comment records *why*: `tags` is JSON array text with no
  tag table, the quotes make it an exact token (`"Go"` never matches `"GoLang"`), `NormalizeTag`
  removes `"`/`\` so the value cannot escape the token, and `Contains` (LIKE) is the only operator
  SQLite/MySQL/PostgreSQL agree on for this column — no JSON path operators, no user wildcards.
- `Since` non-zero → `contentitem.CreatedAtGTE`
- `Sort == "oldest"` → order and page boundary both flip (see "beyond the brief")

### `packages/contracts/openapi/openapi.yaml`

Four new reusable parameters — `CategoryID`, `Tag`, `Since`, `Sort` — in
`components/parameters`, with the brief's `name`/`in`/`required`/`description`/`schema` values
verbatim, referenced from both `GET /articles` and `GET /posts` exactly like the existing
`Limit` / `Cursor` / `AuthorID`. (The brief showed the block inline; the file's established style is
one shared component per parameter, which is what "写法与既有 … 一致" asks for and avoids two drifting
copies. Refs verified: 2 operations × 4 params + 4 definitions.)

## Tests (TDD, red → green)

Red was confirmed first: `undefined: NormalizeTag / ValidateSort / parseListFilter / SortOldest /
MaxTagFilterLength` and `unknown field CategoryID in struct literal of type content.ListFilter`.

New `apps/api/internal/content/listfilter_test.go`:

- `TestNormalizeTag`, `TestListFilterSortValidation` — verbatim from the brief.
- `TestParseListFilterReadsEveryParameter` — all five query params parsed, trimmed, normalised.
- `TestParseListFilterDefaultsToNewest` — absent params are defaults, not errors.
- `TestParseListFilterRejectsMalformedValues` — quote in tag, backslash in tag, over-long tag, bad
  `since`, unknown `sort`, over-long `category_id` → `ErrInvalidInput`.
- `TestListAfterFilterForwardsNarrowing` — the narrowing reaches `repo.lastFilter` untouched **and** a
  caller-supplied `Statuses: [draft]` is replaced by `[published]` for a reader (visibility cannot be
  widened). Uses a new `lastFilter` recorder on `fakeRepo` in `service_test.go`.
- `TestListAfterRejectsUnknownSort` — bad ordering names never reach the query builder.

New `apps/api/internal/infrastructure/contentstore/store_list_test.go` (SQLite, real Ent schema):

- `TestListFiltersByCategory` — exact category, unknown category = empty page not an error.
- `TestListMatchesTagAsExactToken` — `"Go"` matches the element `Go` only, not `GoLang`; `We` does not
  find `Web`.
- `TestListFiltersBySince` — inclusive, newest first.
- `TestListSortOrdersBothWays` — default desc, `oldest` asc.
- `TestListOldestAdvancesCursorForwards` — page 2 under `oldest` is the *next* item, not a jump back.

Existing `content` tests were updated only for the new signatures (`List` ×3, `ListAfterFilter` ×3).

Verification (repo root):

```
go build ./apps/api/...     → ok
go test  ./apps/api/...     → ok (every package; content 1.9s, contentstore 1.5s, gin contract tests ok)
gofmt -l <touched files>    → clean
```

## Beyond the brief (disclosed)

1. **Cursor direction follows `sort`.** The brief only says `Sort == "oldest"` → `Asc`. With the old
   `CreatedAtLT/IDLT` boundary, page 2 of an ascending listing would jump back to items already shown,
   so the boundary became `CreatedAtGT/IDGT` for `oldest`. Covered by
   `TestListOldestAdvancesCursorForwards`. Everything else is unchanged.
2. **`List` signature** gained `narrow ListFilter` (plan said `List` must pass the new fields through);
   its three test callers were updated.
3. **`NormalizeTag` rejects over-long names (returns `""` → 400) instead of truncating** them to 40,
   so a typo can never be silently turned into a different tag. The brief's test (≤40 bytes) passes.
4. **`service_test.go`** gained a `lastFilter` field on `fakeRepo` (test-only recorder).
5. **OpenAPI parameters live in `components/parameters`** rather than inline (see above).

## Environment warnings for the orchestrator

- **Pristine `HEAD` (`ce2e497`) does not build.** `go build ./apps/api/...` on a clean `git archive HEAD`
  fails in `apps/api/internal/media`: `actor.Role undefined`, `filter.OwnerID undefined` — a previous
  session committed `media/service.go` without the matching `media/domain.go`, or staged partially. My
  commit does not touch or fix that; the combined working tree builds and tests green.
- Because the shared tree is dirty, my four pre-modified files (`content/service.go`,
  `content/handler.go`, `contentstore/store.go`, `openapi.yaml`) carry other sessions' hunks (draft
  quota, domain verification, registration). They were **not** staged: I rebuilt index-only patches
  containing just my hunks (`git apply --cached`) and verified the commit body contains none of
  `DraftQuota`, `quota_exceeded`, `registration_open`, `SiteDomainStatus`, `PublishedAssetReference`.
  Those foreign hunks remain in the working tree, unstaged.
- Committed files: 7 (4 modified + 2 new tests + `service_test.go`), 616 insertions / 36 deletions.

## Files touched

Modified:
- `apps/api/internal/content/service.go`
- `apps/api/internal/content/handler.go`
- `apps/api/internal/content/service_test.go`
- `apps/api/internal/infrastructure/contentstore/store.go`
- `packages/contracts/openapi/openapi.yaml`

New:
- `apps/api/internal/content/listfilter_test.go`
- `apps/api/internal/infrastructure/contentstore/store_list_test.go`
