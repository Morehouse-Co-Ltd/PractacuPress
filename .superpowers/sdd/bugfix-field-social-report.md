# Bugfix report: name the failing field for community and messaging validation

- **Branch:** `feat/page-builder-v2-p0`
- **Commit:** `b385a85` — `feat(api): name the failing field for community and messaging validation`
- **Date:** 2026-11-03
- **Scope:** `apps/api/internal/community`, `apps/api/internal/messaging`. `content`, `taxonomy` and `packages/contracts/openapi/openapi.yaml` were deliberately left untouched (parallel agent).

## Problem

Commit `93a29b1` introduced `apperr.FieldError` and the dual-wrap pattern that keeps
`errors.Is(err, ErrInvalidInput)` working while `errors.As` recovers `Field`/`Rule`.
Auth adopted it; social input did not:

- `community.ValidateComment` and `community.NextDepth` returned plain
  `fmt.Errorf("%w: ...", ErrInvalidInput)` / `ErrDepthExceeded`, so the handler could
  only emit free text.
- `community.mapError` collapsed every `ErrInvalidInput` into
  `apperr.Validation("invalid interaction")` and lost even that free text; the
  depth and self-target checks emitted unnamed `Validation` problems.
- `messaging.ValidateMessage` did not carry a field, and `messaging.mapError`
  collapsed `ErrInvalidInput` into `apperr.Validation("invalid conversation")`.

Clients therefore saw `details.reason` only (or a generic reason) and could not
translate which input failed.

## Changes

### `apps/api/internal/community/domain.go`

- Added the local `invalidField(field, rule, reason string) error` helper, copied from
  `auth/validation.go` including the comment explaining why dual `%w` is required
  (`FieldError` lives in the error-model package and cannot import the sentinel).
- `ValidateComment` now names each failure, preserving the exact acceptance rules and
  English `Reason` text:
  - unknown target type → `field=target, rule=unknown`
  - empty target id → `field=target, rule=required`
  - empty/blank body → `field=body, rule=required`
  - over-long body → `field=body, rule=too_long`
  - missing reply parent → `field=target, rule=required`
- `NextDepth` (the reply/depth validator) now wraps three errors:
  `ErrDepthExceeded` (existing callers and tests keep matching it), `ErrInvalidInput`
  (uniform transport handling), and `&apperr.FieldError{Field: "depth",
  Rule: "out_of_range", Reason: "reply depth exceeded"}`.

### `apps/api/internal/community/handler.go`

- Added an `errors.As(err, &fieldErr)` branch **before** the generic
  `ErrInvalidInput` branch, emitting
  `apperr.ValidationField(fieldErr.Reason, fieldErr.Field, fieldErr.Rule)`.
- Converted the two field-naming handler checks:
  - `ErrDepthExceeded` → `ValidationField("reply depth exceeded", "depth", "out_of_range")`
  - `ErrSelfTarget` → `ValidationField("cannot target yourself", "target", "unsupported")`
- Every other branch (status, code, reason text) is unchanged.

### `apps/api/internal/messaging/domain.go`

- Added the same `invalidField` helper.
- `ValidateMessage` body failures now carry `field=body` with rule `required` /
  `too_long`. The `conversation is required` failure is unchanged (no vocabulary term
  exists for it, and the handler supplies the conversation from the path).

### `apps/api/internal/messaging/handler.go`

- Added the same `errors.As` branch before `ErrInvalidInput`, so the body error's
  field/rule reach the wire. The generic `"invalid conversation"` behaviour is kept for
  every error without a `FieldError`.

No message strings, status codes, accepted inputs, error codes or dependencies were
changed.

## Tests (red first)

Written before the implementation and observed failing:

- `TestCommentValidationErrorsCarryFieldAndRule` (new table test):
  empty body (`body`/`required`), over-long body (`body`/`too_long`), empty reply
  target (`target`/`required`), unknown target type (`target`/`unknown`), reply too
  deep (`depth`/`out_of_range`). Each case asserts
  `require.ErrorIs(t, err, ErrInvalidInput)` **and** `require.ErrorAs` into
  `*apperr.FieldError`, then the exact field/rule and a non-empty reason.
  The depth case exercises `NextDepth(&Comment{Depth: MaxReplyDepth})`.
- `TestMessageValidationErrorsCarryFieldAndRule` (new table test): empty body and
  over-long body, same dual assertions (`body`/`required`, `body`/`too_long`).
- `TestCommentValidationNamesTheField` (new handler-level test):
  `POST /comments` with `{"target_type":"article","target_id":"a1","body":""}`
  returns 400, `details.field == "body"`, `details.rule == "required"`,
  non-empty `details.reason`, and `message` equal to the unchanged
  `apperr.New(apperr.CodeValidationFailed).Message` (`请求参数不符合要求`), proving the
  human message was not altered.

Red evidence (pre-implementation run):

```
--- FAIL: TestCommentValidationErrorsCarryFieldAndRule/empty_body
    Should be in error chain: expected *apperr.FieldError
--- FAIL: TestCommentValidationErrorsCarryFieldAndRule/reply_too_deep
    expected: "community: invalid input" in chain: "community: reply depth exceeded"
--- FAIL: TestCommentValidationNamesTheField
    expected: "body", actual: <nil>
--- FAIL: TestMessageValidationErrorsCarryFieldAndRule/empty_body
    expected *apperr.FieldError in chain: "messaging: invalid input: body is required"
--- FAIL: TestMessageValidationErrorsCarryFieldAndRule/over-long_body
    expected *apperr.FieldError in chain: "messaging: invalid input: body is too long"
```

Existing tests (`TestValidateComment`, `TestNextDepthBoundsNesting`,
`TestValidateMessage`, `TestReplyBeyondDepthLimitIsRefused`,
`TestToggleFollowSelfIsRejected`, etc.) were kept green: they still match their
original sentinels and status codes.

## Verification

From the repo root, on the final tree:

```
go build ./apps/api/...        # exit 0
go test  ./apps/api/...        # exit 0, no FAIL lines
```

Full API package list green (`community`, `messaging`, `content`, `taxonomy`, `auth`,
transport, stores, etc.). No other agent's in-flight edits blocked the build at the
time of verification.

## Constraints observed

- Staged only the seven exact paths (`git add -- <paths>`); no `git add -A`,
  `git stash` or `git checkout -- .`.
- `content`/`taxonomy` and the shared OpenAPI vocabulary line untouched.
- No new dependencies; only the existing `apperr` package imported.
- Files edited with read/edit/write only.

## Files touched

- `apps/api/internal/community/domain.go`
- `apps/api/internal/community/domain_test.go`
- `apps/api/internal/community/handler.go`
- `apps/api/internal/community/handler_test.go`
- `apps/api/internal/messaging/domain.go`
- `apps/api/internal/messaging/domain_test.go`
- `apps/api/internal/messaging/handler.go`
