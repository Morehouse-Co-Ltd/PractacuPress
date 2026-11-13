# Bugfix report — name the failing field for content and taxonomy validation (API)

- **Status:** complete, full API suite green.
- **Branch:** `feat/page-builder-v2-p0`
- **Commit:** `f97965757c003c9a5b59b121216c79010add9db7` — `feat(api): name the failing field for content and taxonomy validation`
- **Verification (repo root):** `go build ./apps/api/... && go test ./apps/api/...` — build clean, every package `ok` / `[no test files]`, exit code 0. No new dependencies.

## The problem

Commit `93a29b1` gave `auth` and `site` validation errors a machine readable
`details.field` / `details.rule` pair, but the content and taxonomy handlers still
collapsed every `ErrInvalidInput` into `apperr.Validation("invalid content")` /
`apperr.Validation("invalid taxonomy term")`. The drafted article's title, summary,
slug, tags and body failures, and the term's name, slug and colour failures, were
therefore described only by a generic English reason the client may not display.

## The contract implemented

On `validation_failed`, `details` now optionally carries `field`, `rule` and the
existing free English `reason`. `message` (including `请求参数不符合要求`), status codes,
the set of error codes and the accepted inputs are unchanged.

### Content (`apps/api/internal/content/domain.go`)

| failure | field | rule |
| --- | --- | --- |
| title blank after trim | `title` | `required` |
| title > 200 runes | `title` | `too_long` |
| summary > 500 runes | `summary` | `too_long` |
| slug > 120 chars | `slug` | `too_long` |
| slug fails `^[a-z0-9]+(?:-[a-z0-9]+)*$` (after lowercasing) | `slug` | `malformed` |
| one tag > 24 runes | `tags` | `too_long` |
| more than 12 distinct tags | `tags` | `out_of_range` |
| body empty | `body` | `required` |
| body > 200 000 runes | `body` | `too_long` |
| source format not markdown/html/plain | `body` | `unknown` |

`NormalizeTags` now returns the same `*apperr.FieldError` shape. All acceptance rules,
check order and English `Reason` text are byte-for-byte the old strings
(`"title is required"`, `"tag is too long"`, `"too many tags"`, ...). Only the
`ErrInvalidInput` wrapping changed:
`fmt.Errorf("%w: %w", ErrInvalidInput, &apperr.FieldError{...})`, copied verbatim from
`auth.invalidField`, including the comment about the dual `%w` and the import cycle.

**Source format choice (explicit):** the closed field vocabulary has no
`source_format` name, and the task did not authorise adding one. The format belongs to
the body's declaration, so the failure is attributed to `body` with rule `unknown`,
matching the existing reason text `unknown source format`.

**Left generic on purpose:** `category id is malformed` stays a sentinel-only
`ErrInvalidInput`, because `category_id` is not in the agreed vocabulary and adding it
would exceed the brief. It still maps to the same generic 400 payload as before.

### Taxonomy (`apps/api/internal/taxonomy/domain.go`)

Same local `invalidField` helper (own copy — the sentinel must stay package-local).

| failure | field | rule |
| --- | --- | --- |
| name blank after trim | `name` | `required` |
| name > 80 runes | `name` | `too_long` |
| slug > 80 chars | `slug` | `too_long` |
| slug fails the pattern | `slug` | `malformed` |
| no derivable slug (`Validate` and `PatchInput.Apply`) | `slug` | `required` |
| colour > 16 chars | `color` | `too_long` |
| colour fails `^#[0-9a-f]{6}$` | `color` | `malformed` |

The `unknown kind` and `description is too long` failures stay sentinel-only for the
same vocabulary reason (`kind` and `description` are not agreed names); they keep
today's generic 400 payload. The task named only name/slug/colour, and those are fully
covered.

### Handlers (`apps/api/internal/content/handler.go`, `apps/api/internal/taxonomy/handler.go`)

Both `mapError`s gained the same `errors.As(err, &fieldErr)` branch **before** the
generic `ErrInvalidInput` branch, copied from `auth/handler.go`:

```go
var fieldErr *apperr.FieldError
...
case errors.As(err, &fieldErr):
    return apperr.ValidationField(fieldErr.Reason, fieldErr.Field, fieldErr.Rule)
```

Every non-field `ErrInvalidInput` (malformed JSON body, list-filter errors, unknown term
kind, ...) still returns `apperr.Validation("invalid content")` /
`apperr.Validation("invalid taxonomy term")`, exactly as before.

### `packages/contracts/openapi/openapi.yaml`

`Problem.details.field` enum is now:

```
[email, password, display_name, name, message, title, summary, slug, body, tags,
 role, domain, document, target, depth, color, file, limit, range]
```

That is the agreed 16-name vocabulary plus the four forward-looking names the task
asked to add (`file`, `limit`, `range`, and keeping `target`/`depth` available). The
`rule` enum already carried every value used here (`required`, `malformed`, `too_long`,
`out_of_range`, `unknown`). No required/property/status changes.

## Tests (red-first, then green)

1. **Red observed before implementation** (`go test` on the two packages with the new
   test filters): all new field cases failed with
   `expected: *apperr.FieldError / in chain: "content: invalid input: ..." (*fmt.wrapError)`
   and the two handler tests decoded `details.field` as nil. Confirmed the failure was
   the missing field information, not a compile issue.
2. **`apps/api/internal/content/validation_field_test.go`** —
   `TestValidateDraftNamesTheFailingField`, table over: empty title, 300-rune title,
   600-rune summary, uppercase `"Bad Slug"`, 121-char slug, over-long tag, 13 tags,
   missing body, 200 001-rune body, unknown `excel` format. Every case asserts
   `errors.Is(err, ErrInvalidInput)` is still true, `errors.As` yields
   `*apperr.FieldError`, the exact Field/Rule, and a non-empty Reason.
3. **`apps/api/internal/content/validation_field_test.go`** —
   `TestCreateArticleHandlerNamesTheFailingField`: real handler/router (the quota
   engine in `quota_test.go`), `POST /api/v1/articles` with `"title":"   "` → 400,
   `code == validation_failed`, `message == "请求参数不符合要求"` (pinned),
   `details.field == "title"`, `details.rule == "required"`, non-empty
   `details.reason`.
4. **`apps/api/internal/taxonomy/validation_field_test.go`** —
   `TestValidateNamesTheFailingField`, table over: missing name, over-long name,
   malformed slug, over-long slug, unsluggable Chinese name (slug/required), malformed
   colour, over-long colour; same three assertions per case.
   `TestHandlerCreateNamesTheFailingField`: authenticated `POST
   /api/v1/sites/site_1/taxonomy` with a blank name → 400 with
   `details.field == "name"`, `details.rule == "required"`, unchanged message.

## Files touched

- `apps/api/internal/content/domain.go` (modified)
- `apps/api/internal/content/handler.go` (modified)
- `apps/api/internal/content/validation_field_test.go` (new)
- `apps/api/internal/taxonomy/domain.go` (modified)
- `apps/api/internal/taxonomy/handler.go` (modified)
- `apps/api/internal/taxonomy/validation_field_test.go` (new)
- `packages/contracts/openapi/openapi.yaml` (modified)

## Notes for the next handler

- The web client (`apps/web/src/lib/problemDetail.ts`, commit `e7fe684`) already
  translates `title`, `summary`, `body` and `tags`; it has no `tags:out_of_range`
  case, so a 13th tag currently falls back to the generic message. Adding that pair is
  a client-only follow-up; the server contract above is what the brief specified.
- `category_id`, `source_format`, `description` and the taxonomy `kind` remain
  un-named failures until the vocabulary is extended deliberately.
