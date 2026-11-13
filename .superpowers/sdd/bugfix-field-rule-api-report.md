# Bugfix report — machine readable field/rule on `validation_failed` (API)

- **Status:** complete, full API suite green.
- **Branch:** `feat/page-builder-v2-p0`
- **Commit:** `93a29b1b0ba5e95ba8b8487d87c2c4d95159214b` — `feat(api): tell clients which field and rule failed validation`
- **Verification (repo root):** `go build ./apps/api/... && go test ./apps/api/...` — build clean, every package `ok` / `[no test files]`; no failures, no new dependencies.

## The problem

Every `validation_failed` response carried only the generic message
`请求参数不符合要求` plus a free English `details.reason` such as
`auth: invalid input: password must combine at least 2 of ...`. A client could not
say anything useful, because the project rule is "clients branch on `code`, never on
`message`", and the reason text is not a stable vocabulary.

## The contract implemented

On `validation_failed`, `details` now optionally carries:

```json
{ "field": "password", "rule": "too_weak", "reason": "<existing english detail>" }
```

- `field` ⊆ `email | password | display_name | name | message | title | slug | role | domain | document`
- `rule` ⊆ `required | malformed | too_short | too_long | too_weak | blank | out_of_range | unknown | too_large | unsupported`
- `reason` is unchanged free English text for operators and is never removed.
- When the failing input cannot be identified (e.g. `malformed json body`), **both**
  `field` and `rule` are omitted and the payload is exactly what it was before.
- `message`, status codes and the set of error codes are untouched.

## Changes

### `apps/api/internal/platform/errors/problem.go`

- Added `FieldError{Field, Rule, Reason}` with `Error() string { return e.Reason }`.
- Added `ValidationField(detail, field, rule string) *Problem`, built on the existing
  `Validation` + `WithDetail`. An empty `field`/`rule` is skipped, so partial data can
  never leak an empty string into the contract.
- No new error code, no status change, no message change.

### `apps/api/internal/auth/validation.go`

`NormalizeEmail`, `ValidatePassword`, `ValidateDisplayName` now return
`*apperr.FieldError` values wrapped in `ErrInvalidInput`:

| input | rule |
| --- | --- |
| email empty | `required` |
| email parse failure / `Name <addr>` form | `malformed` |
| email > 254 octets | `too_long` |
| password < 8 runes | `too_short` |
| password > 128 runes | `too_long` |
| password all whitespace | `blank` |
| password < 2 character classes | `too_weak` |
| display name empty | `required` |
| display name > 120 runes | `too_long` |

Acceptance rules, ordering and English reason text are byte-for-byte the same as
before. `errors.Is(err, ErrInvalidInput)` **stays true**.

**Wrapping choice (explicit):** `fmt.Errorf("%w: %w", ErrInvalidInput, &apperr.FieldError{...})`
(multiple `%w`, Go 1.26 module). The alternative — `FieldError.Unwrap() → ErrInvalidInput` —
is impossible without an import cycle: `apperr` is the platform error model and must not
import `auth` (or `site`) to reach their sentinels. Wrapping both at the construction site
keeps both `errors.Is` and `errors.As` working.

### `apps/api/internal/auth/handler.go`

`mapError` gained a branch **before** the generic `ErrInvalidInput` branch:

```go
case errors.As(err, &fieldErr):
    return apperr.ValidationField(fieldErr.Reason, fieldErr.Field, fieldErr.Rule)
```

All other `ErrInvalidInput` failures still return today's generic payload.

### `apps/api/internal/site/contact.go`

- Added `formatInvalidField`, the same dual-`%w` construction.
- `validateContact` failures now name field/rule:
  - message empty → `message` / `required`
  - message too long → `message` / `too_long`
  - name too long → `name` / `too_long`
  - email too long → `email` / `too_long`
  - email without `@` / whitespace / leading or trailing `@` → `email` / `malformed`
- `mapContactError` detects `*apperr.FieldError` inside the `ErrInvalidInput` branch and
  returns `ValidationField`; everything else still goes through `cleanValidation`.

### `packages/contracts/openapi/openapi.yaml`

`Problem.details` description now documents the optional `field` / `rule` keys and lists
both vocabularies; `properties` are declared for `field`, `rule` and `reason`.
`required`, `type: object`, `additionalProperties: true` and the `Problem.code` enum are
unchanged.

## Tests (red-first, then green)

1. **Red observed before implementation:**
   - `go test ./apps/api/internal/auth/` → build failed:
     `validation_test.go:129:25: undefined: apperr.FieldError`.
   - `go test ./apps/api/internal/site/` →
     `TestContactFormRejectsAnEmptyMessage` failed: expected `"message"`, actual `""`.
2. **`apps/api/internal/auth/validation_test.go`** — `TestValidationErrorsCarryFieldAndRule`
   table covering: empty email, `not-an-email`, 300-char email, 7-char password,
   129-char password, eight-space password, `password` (too weak), missing and over-long
   display name. Every case asserts `errors.Is(err, ErrInvalidInput)`, `errors.As` to
   `*apperr.FieldError`, the exact Field/Rule and non-empty Reason. A valid password
   (`correct horse battery`) asserts `nil`.
3. **`apps/api/internal/auth/handler_test.go`** —
   `TestRegisterWeakPasswordNamesFieldAndRule`: real router + store, `POST
   /api/v1/auth/register/email` with password `"password"` → 400, `code ==
   validation_failed`, `message == "请求参数不符合要求"` (pinned unchanged),
   `details.field == "password"`, `details.rule == "too_weak"`, non-empty
   `details.reason`.
4. **`apps/api/internal/site/contact_test.go`** —
   `TestContactFormRejectsAnEmptyMessage` now decodes the problem and asserts
   `details.field == "message"`, `rule == "required"`, non-empty reason, unchanged
   message, and that nothing was delivered.

## Notes / deliberately out of scope

- `details.reason` for auth failures is now the bare English detail (e.g.
  `email is malformed`) instead of the old prefixed `auth: invalid input: email is
  malformed`. The sentinel prefix was internal noise; the site module has always
  stripped its prefix via `cleanValidation`, so the two modules now agree. The meaningful
  English text is preserved; `message` is unchanged. `errors.As` is used exactly as the
  agreed contract specifies (`fieldErr.Reason`).
- Other `ErrInvalidInput` sites that are not field validation (auth `site is required`,
  `unknown role`, password-reset `site is required`) still return the generic payload.
  They have no meaningful field/rule in the agreed vocabulary, and extending the
  vocabulary was out of scope.
- `contact` errors that are not field validation (`ErrContactTooFast`,
  `ErrContactUnavailable`, malformed JSON) keep their current payloads.
- Report file itself is not part of the commit (`.superpowers/` is untracked working
  material).

## Files touched (commit)

- `apps/api/internal/platform/errors/problem.go`
- `apps/api/internal/auth/validation.go`
- `apps/api/internal/auth/validation_test.go`
- `apps/api/internal/auth/handler.go`
- `apps/api/internal/auth/handler_test.go`
- `apps/api/internal/site/contact.go`
- `apps/api/internal/site/contact_test.go`
- `packages/contracts/openapi/openapi.yaml`
