# P3 Task 4 — Contact form (implementation report)

**Status:** DONE
**Branch:** `feat/page-builder-v2-p0`
**Commit:** `08d56b4` — `feat: add the contact form block and its endpoint`
**Scope decision:** contact form only. A subscriber list is explicitly **out of scope**
(a subscribers table, unsubscribe flow, export and a compliance statement are a separate
feature); the message closes the loop through the existing notification pipeline and
stores nothing except the inbox row.

---

## 1. What shipped

### 1.1 Backend — `POST /sites/{siteID}/contact` (anonymous)

`apps/api/internal/site/contact.go` (new) holds a `ContactService` plus the HTTP handler.

Flow, in the order the server applies it:

1. **Site resolution first.** The site comes from host resolution, never from the path
   alone: `resolved.ID != siteID` → `403 permission_denied` (`reason: cross_site`). An
   unresolved host → `404 site_not_found`.
2. **Honeypot.** `website` non-empty → `202 {"status":"accepted"}` and nothing is
   delivered. Checked before validation on purpose so a bot learns nothing from the
   response.
3. **Validation** (`400 validation_failed` with a short reason):
   - `message` required (trimmed), **≤ 2000 characters** (runes);
   - `name` optional, **≤ 80 bytes**;
   - `email` optional, **≤ 200 bytes**, must contain `@` with a non-empty local part and
     domain, and no whitespace. Nothing more: proving deliverability is impossible here.
4. **60 second per-visitor cooldown** → `429 rate_limited` (`reason: contact_cooldown`).
   Validation runs *before* the cooldown so a reader who typed too much can fix it
   immediately instead of being locked out for a minute. A rejected submission does not
   consume the slot.
5. **Delivery.** Active members with role ≥ `site_admin` are resolved through the *same*
   repository the rest of the module uses (`Repository.ListMembers`, capped at 50) and
   each gets one notification via the existing `notifications.Service.Notify`. Suspended
   or invited accounts are skipped. A site with no administrator answers `202` and
   delivers nothing (no information leak).

Nothing is rendered as HTML. The message is stored as plain text in the notification
payload; the frontend renders it as a React text node.

Anti-abuse placement: the engine's global rate limiter already runs on every route; this
endpoint adds the honeypot and the cooldown. **The cooldown map is in-process — it is not
distributed.** With N API instances a visitor can send one message per instance per
minute; a fleet-wide bound is the gateway/engine limiter's job. This is documented in the
code (`contactThrottle`) and repeated in the OpenAPI description.

### 1.2 Notifications — one new type, no new table, no migration

- `notifications.TypeContact = "contact.created"`, added to `Type.Valid()`.
- `notifications/contact.go` (new) builds the inbox row: `ContactSubject(name)` →
  `站点来信` / `站点来信：<name>`, payload `{subject, message, name?, email?}`.
- `Validate` gained one narrowly scoped exception: for `TypeContact` the `message` value
  may be up to `4 × 2000` bytes. Rationale: the payload is byte-bounded, the endpoint
  counts characters, and one Chinese character is three bytes — without the exception a
  legal 2000-character message would come back as a 500. Every other value and every
  other type keeps `MaxPayloadValueLength` (200 bytes).
- The notification has **no `actor_id`**: the sender is an anonymous visitor with no
  account, so the self-notification guard cannot trip.
- No schema change, no migration: `notifications.type` is a plain string column and the
  type vocabulary is enforced in the domain layer only.

### 1.3 Route wiring

`site.Handler.Routes` mounts it in the same anonymous group as the customization GET:

```go
r.POST("/sites/:siteID/contact", optionalAuth, h.ContactMessage)
```

The contact service is injected through `HandlerConfig.Contact`. When it is nil the route
still exists (the contract documents it) but answers `500`, so a deployment that forgot
to wire a notifier cannot silently swallow messages. `cmd/server/main.go` wires it with
`notifications.Service` as the notifier and `sitestore` as the repository.

### 1.4 Contract gate

`packages/contracts/openapi/openapi.yaml`:

- new path `/sites/{siteID}/contact` (`security: []`, 202/400/403/404/429 documented,
  honeypot + cooldown described);
- new schemas `ContactMessageInput` (with the honeypot documented) and
  `ContactMessageAccepted`;
- new component response `RateLimited`.

All five reconciliation tests in `apps/api/internal/transport/http/gin` pass, including
the route↔document comparison in both directions and the Problem-code enum.

### 1.5 Frontend — `contact-form` block

- `apps/web/src/lib/contactForm.ts` (new): the pure rules — `validateContact`,
  `looksLikeEmail`, `honeypotTripped`, `contactPayload`, `cooldownRemainingMs`,
  `utf8Length`, `CONTACT_LIMITS`, `CONTACT_COOLDOWN_MS`. No copy lives here: it returns
  codes (`message_required`, `email_invalid`, …) so the renderer can translate them.
- `apps/web/src/components/blocks/FormBlocks.tsx` (new): `FORM_RENDERERS` with the single
  `contact-form` entry, spread into `RENDERERS` in `blocks/index.tsx` following the P2
  module pattern.
- `apps/web/src/lib/blocks.ts`: block definition — `heading`, `intro` (richtext),
  `submit_label`, `success_text`, `show_name`, `show_email`; group `content`, variants
  `classic` + `bento`.
- Three states: `idle` / `sending` / `sent`. A failure returns to `idle`, shows
  `发送失败，请稍后再试。`, and **never clears what the reader typed**.
- Honeypot: a `website` input moved out of the viewport (`position: absolute;
  left: -9999px`, not `display: none`, which most bots skip), `aria-hidden`,
  `tabIndex={-1}`. Filled → **no request at all**, the UI moves to the success state.
- Front-layer cooldown: after a successful send the block remembers the timestamp and
  answers `刚发过一条，请稍后再试。` for 60 seconds without calling the API.
- Demo mode: no request, straight to the success state, with
  `演示模式下不会真的发送。` under the button.
- The author's `intro` goes through `renderMarkdown` + `sanitizeHtml` (same chain as the
  `text` block); **the reader's input is never HTML**.
- `styles.css` gained a `P3 · 联系表单` section (form layout, danger/accent notices,
  off-screen honeypot).
- i18n: all new strings are `t('…')` literals with English entries in
  `dict/fragments/components_blocks_FormBlocks.ts`.
- The inbox renders the new type: `pages/site/Notifications.tsx` gained a
  `contact.created` case (subject + message as text) with its English entry.

---

## 2. Tests

### Go (`apps/api/internal/site/contact_test.go`, new — 12 cases)

All through the real router, the real site store and the real notification store:

| Case | Asserts |
| --- | --- |
| valid submission | `202`, exactly one `contact.created` row for the administrator, payload has `subject`/`message`/`name`/`email`, no `<` in the body |
| message without name/email | `202`, subject is the bare `站点来信`, no `email` key |
| only administrators | plain member gets nothing |
| `message` too long (2001 chars) | `400`, nothing delivered |
| 2000-character Chinese message | `202` and stored **whole** (regression guard for the payload bound exception) |
| email without `@` | `400`, nothing delivered |
| empty/whitespace message | `400`, nothing delivered |
| honeypot filled | `202`, nothing delivered |
| second submission within a minute | `429`, `rate_limited` / `contact_cooldown`, still exactly one row |
| validation before cooldown | a rejected attempt does not start the clock |
| another tenant in the path | `403`, nothing delivered |
| malformed body | `400` |

### Web (`apps/web/src/lib/contactForm.test.ts`, new — 29 tests)

Pure rules (byte vs character bounds, `@` rule, honeypot, payload trimming, cooldown
math), registry definition (group, variants, defaults ⊆ schema, idempotent normalisation),
renderer registration (`BLOCK_RENDERERS['contact-form']`, `FORM_RENDERERS` has exactly one
entry), rendering (heading/intro only when set, hidden fields, `aria-hidden` honeypot),
and behaviour: empty message and invalid email do not call the API, honeypot does not call
the API, one call on success with the exact payload, failure keeps the input, the local
cooldown blocks the second submit, and demo mode makes no call while showing the hint.
Two CSS assertions pin the honeypot technique and the notice colours.

### Verification (all run after the change, worktree)

```
go build ./apps/api/...                     ok
go test  ./apps/api/...                     all packages ok
npx vitest run                              70 files / 921 tests passed   (baseline 69 / 892 → +1 file, +29 tests)
npm run typecheck                           clean
npm run build                               ok   (index 1,318.70 kB / gzip 423.99 kB; css 230.42 kB / gzip 39.24 kB)
npm run i18n:audit                          96.4 % covered; 0 pending strings in every file this task touched
```

Because the working tree is shared with other sessions, the **staged snapshot** (HEAD +
only this task's hunks) was also exported with `git checkout-index` and verified on its
own: `go build ./apps/api/...` ok, and `site`, `notifications`, `transport/http/gin`
(+ middleware) tests green. Committing only the staged hunks left the other sessions'
work untouched in the tree.

---

## 3. Files touched

Within the brief's list:

- `apps/api/internal/notifications/contact.go` (new)
- `apps/api/internal/notifications/domain.go`
- `apps/api/internal/site/contact.go` (new)
- `apps/api/internal/site/contact_test.go` (new)
- `apps/api/internal/site/handler.go`
- `apps/api/cmd/server/main.go` ²
- `apps/api/internal/site/handler_test.go` ²
- `packages/contracts/openapi/openapi.yaml`
- `apps/web/src/lib/blocks.ts`
- `apps/web/src/components/blocks/FormBlocks.tsx` (new)
- `apps/web/src/components/blocks/index.tsx`
- `apps/web/src/lib/contactForm.ts` (new) ²
- `apps/web/src/lib/contactForm.test.ts` (new)
- `apps/web/src/styles.css`
- `apps/web/src/lib/i18n/dict/fragments/components_blocks_FormBlocks.ts` (new)

Beyond the brief:

- ² `main.go` — the service is wired there; without it the route answers 500.
- ² `handler_test.go` — the harness now builds the real notification store + contact
  service (three added lines and two imports).
- ² `lib/contactForm.ts` — the rules module the brief's test file implies; keeping the
  copy out of it is what keeps the i18n gate honest.
- `apps/web/src/lib/backend.tsx`, `lib/api.ts`, `lib/demo.ts` — one new `Backend` method,
  `contactSite(siteId, input)`: `POST /sites/{siteId}/contact`, implemented by
  `HttpBackend` and (as a no-op) by `DemoBackend`.
- `apps/web/src/pages/site/Notifications.tsx` +
  `lib/i18n/dict/fragments/pages_site_Notifications.ts` — the inbox renders the new
  `contact.created` type instead of falling through to the raw type string.

`git add` was used with **exact paths only**; the shared files
(`main.go`, `site/handler.go`, `site/handler_test.go`, `openapi.yaml`, `styles.css`,
`lib/api.ts`, `lib/backend.tsx`, `lib/demo.ts`) were staged hunk by hunk so none of the
other sessions' changes were picked up. `git add -A`, `git stash` and
`git checkout -- .` were not used.

---

## 4. Known limits (unchanged by this task)

- **Cooldown is per process.** Multi-instance deployments need the gateway limiter for a
  fleet-wide bound. Stated in code, in the contract and here.
- **In-app only.** The message lands in the inbox; nothing is emailed. A deployment
  without SMTP still receives it.
- **One copy of the message.** It exists only in the notification row (the payload) —
  deleting the notification deletes the message. That is the point of the scope
  decision: no second store, no retention question, no export.
- **Bounds are asymmetric on purpose:** `name`/`email` in bytes (they are stored in the
  byte-bounded payload), `message` in characters (a byte bound would cut a Chinese
  message to a third). Both are mirrored in `lib/contactForm.ts`.
- **Subscriptions (subscriber list, unsubscribe, export) are not implemented.** Out of
  scope by decision, not by omission.
