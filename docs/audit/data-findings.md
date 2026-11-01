# Domain & Data-Layer Audit — Practacu Press (Go API)

**Auditor:** data-audit
**Date:** 2026-10-31
**Method:** static source review only. The shell in this environment is broken (`pwsh` exits `0xC0000142`, PTY sessions fail), so **no build, test, linter or runtime probe was executed**. Every claim below is anchored to a quoted source line; anything that only matters under concurrency or a specific dialect is labelled as such instead of asserted.

**Scope reviewed (files read in full unless noted):**

- `apps/api/internal/{content,community,media,moderation,analytics,taxonomy,messaging,notifications,outbox}/**`
- `apps/api/internal/infrastructure/{contentstore,communitystore,mediastore,moderationstore,analyticsstore,taxonomystore,messagingstore,notificationstore,outboxstore}/**`
- `apps/api/ent/schema/*.go` (the migration source of truth — `migrations/` only holds a README)
- `apps/api/internal/transport/http/gin/{router,dependencies}.go`, `middleware/{auth,site,context,rate_limit}.go`, `transport/ws/{handler,hub}.go`, `apps/api/cmd/server/main.go`, `platform/page/cursor.go`
- Cross-checked contract and claims: `packages/contracts/openapi/openapi.yaml`, `docs/superpowers/reports/2026-10-20-delivery-status.md`
- Out-of-scope cross-checks: `services/security/src/content.rs` (only to confirm the sanitizer/scan behaviour that the content and media modules depend on)

**Method note on authorization.** For each dangerous route I traced `route → handler guard → principal construction → service check → store predicate` and asked "which layer carries the `site_id` / `owner_id` / membership predicate, and does the layer above assume one?" The dominant finding of that exercise is negative and is recorded under *Verified safe*: **every request-serving read in these modules carries the tenant predicate the service assumes**, including the two-phase media flow and the outbox replay. The only unscoped write predicates are `MarkUploadUploaded`/`MarkUploadCompleted` and `Notification.MarkRead`, each reached solely after a scoped read plus an ownership check; that reliance is called out in DATA-12. The real defects below are (a) two controls that no layer performs at all (anonymous visibility in taxonomy, a request-body ceiling), (b) three features implemented in the domain but never wired to a production path, and (c) data-layer correctness bugs.

---

## Summary

| Severity | Count | IDs |
|---|---|---|
| Critical | 0 | — |
| High | 0 | — |
| Medium | 7 | DATA-1 … DATA-7 |
| Low | 5 | DATA-8 … DATA-12 |

No unauthenticated cross-tenant read/write and no remote code execution path was found in this layer. The two most consequential defects are both *missing checks rather than broken checks*: anonymous readers can read a members-only site's taxonomy (`DATA-1`), and every image in a published article is unreachable for logged-out readers because the download route demands a session the contract says it does not need (`DATA-4`). `DATA-5` and `DATA-6` are features that pass their unit tests but have no production entry point at all (notifications and the moderation queue), which matters because the delivery report lists both as delivered.

Cross-reference: `AUTH-1` in `docs/audit/auth-findings.md` reports that `middleware.RequireSiteMatch` is never mounted. That is the same *root* gap I observed while tracing tenant scope (`apps/api/internal/transport/http/gin/middleware/auth.go:64-91` vs `router.go:77-123`). I do not re-report it; instead the findings below state exactly which other layer would have to enforce each predicate if the site-match guard stays absent.

---

## DATA-1 — Medium — Anonymous readers can read a members-only site's taxonomy (no layer checks `visibility_mode`)

**Evidence**

The read route is deliberately anonymous — `apps/api/internal/taxonomy/handler.go:53-54`:

```go
	group := r.Group("/sites/:siteID/taxonomy")
	group.GET("", optionalAuth, h.List)
```

The handler proves the *path* site is the *host* site, and that an authenticated caller's token site agrees, but never looks at the resolved site's visibility — `apps/api/internal/taxonomy/handler.go:97-111`:

```go
	resolved, ok := h.site(c)
	if !ok { ... }
	if resolved.ID != siteID {
		_ = c.Error(apperr.PermissionDenied().WithDetail("reason", "cross_site"))
		return
	}
	if actor, authenticated := h.principal(c); authenticated && actor.SiteID != siteID { ... }

	terms, err := h.service.List(c.Request.Context(), siteID)
```

The service does not check either — `apps/api/internal/taxonomy/service.go:43-55` validates only that `siteID` is non-empty, and the comment even delegates the whole decision upward: *"The handler is still responsible for proving that the requested site is the one the request host resolved to, so this method cannot be used to read another tenant's taxonomy by guessing an id."*

The two sibling modules that serve anonymous reads **do** check, which is what makes the omission a gap rather than a policy:

- `apps/api/internal/content/handler.go:60-63` — `if !ok || resolved.IsMembersOnly() { return Actor{}, false }`
- `apps/api/internal/community/handler.go:70-73` — identical check
- `apps/api/internal/site/handler.go:195-198` — `PublicUser` refuses anonymous on a members-only site

**Failure scenario**

A site is configured `visibility_mode = members_only` (a paid or internal publication). Its domain resolves, so `ResolveSite` succeeds for anonymous requests. An unauthenticated visitor with no account runs:

```
GET /api/v1/sites/<siteID>/taxonomy
```

and receives every category and tag with `name`, `slug` and `description` (`taxonomy/handler.go:117-130`). Because `site_id` is returned by no endpoint, the attacker obtains it from the site's public pages or by trying the value the frontend embeds in URLs; `GET /articles` on that host returns 401, so this is the *only* anonymous read left open. Nothing in middleware, handler or service refuses it: the layer is missing at the handler, exactly where `content` and `community` put it.

**Minimal fix**

In `taxonomy.Handler.List`, mirror the content module: after loading `resolved`, add

```go
if resolved.IsMembersOnly() {
    if _, authenticated := h.principal(c); !authenticated {
        _ = c.Error(apperr.Unauthenticated().WithDetail("reason", "members_only_site"))
        return
    }
}
```

Better: move the decision into one exported helper (`handler.allowsAnonymous(site)`) and use it in `content`, `community`, `taxonomy` and `site`, so the next module cannot forget it.

---

## DATA-2 — Medium — Analytics accepts unauthenticated writes, and the report loads the whole window into memory

**Evidence**

The write route is anonymous and unauthenticated — `apps/api/internal/analytics/handler.go:54`:

```go
	r.POST("/analytics/visits", optionalAuth, h.RecordVisit)
```

`RecordVisit` only requires a resolved host; the body is fully caller-controlled (`apps/api/internal/analytics/handler.go:110-135`), and `ValidateVisit` accepts any path that starts with `/`, any session string up to 64 chars, and any referrer up to 2048 (`apps/api/internal/analytics/domain.go:113-141`). There is no deduplication, no per-session or per-site budget, and no `visibility_mode` check.

The read side materialises **every row of the window** as a Go slice before bucketing — `apps/api/internal/infrastructure/analyticsstore/store.go:119-132`:

```go
func viewTimestamps(ctx context.Context, query *entgen.PageViewQuery) ([]time.Time, error) {
	var rows []struct {
		CreatedAt time.Time `json:"created_at"`
	}
	if err := query.Select(pageview.FieldCreatedAt).Scan(ctx, &rows); err != nil {
```

and `Aggregate` calls it for the full window (`analyticsstore/store.go:62`) plus three more aggregates (`:67`, `:72`, `:77`, `:82`).

**Failure scenario**

1. Untrusted party posts to `POST /api/v1/analytics/visits` on the victim tenant's hostname at the global rate limit (240 req/min/IP by default, `platform/config/config.go:190`). Each request inserts one `page_view` row.
2. Those rows are counted as real traffic: `views`, `sessions`, `online`, `top_pages` and the `recent` activity list all inflate (`analytics/store.go:49-95`). The dashboard the tenant trusts is now attacker-controlled text in `path`/`title`/`referrer` and attacker-chosen numbers.
3. When the tenant's site administrator opens the dashboard (`GET /sites/{siteID}/analytics`, `analytics/handler.go:56-57`), the server loads every timestamp of the window into memory — for `range=30d` that is the whole 30 days of injected rows. A single attacker with a handful of IPs can make each dashboard load O(millions) of rows and an equally large heap allocation.

Impact is limited to dashboard integrity and availability (the endpoint is site-admin only, and the default global rate limiter blunts the write rate), which is why this is Medium rather than High.

**Minimal fix**

- Count in SQL per bucket (`GROUP BY` on a truncated hour/day column, dialect-specific) instead of loading rows; or at minimum add a hard `Limit` to `viewTimestamps` and clamp the report window.
- Take the site from the host (already correct) **and** refuse writes when `resolved.IsMembersOnly()` unless authenticated, so a private site cannot be polluted by strangers.
- Add a cheap uniqueness/dedupe guard (e.g. `(site_id, session, path, minute)` unique index with `ON CONFLICT DO NOTHING`) so one session cannot mint unlimited views.

---

## DATA-3 — Medium — No request-body size cap: an upload is spooled to disk in full before the declared size is checked

**Evidence**

The multipart route hands the raw request to Gin's multipart parser — `apps/api/internal/media/handler.go:139-146`:

```go
	file, header, err := c.Request.FormFile("file")
	...
	upload, err := h.service.StoreContent(c.Request.Context(), actor, c.Param("uploadID"), file, header.Size)
```

The *declared* size is only compared **after** the part has been parsed — `apps/api/internal/media/service.go:163-165`:

```go
	if size != upload.Size {
		return Upload{}, ErrInvalidInput
	}
```

and `media/handler.go` never wraps the body. Repository-wide there is no `http.MaxBytesReader`, no `Engine.MaxMultipartMemory` assignment and no `io.LimitReader` on a request body (the only `LimitReader` match is in `media/service_test.go:432`). Gin's default threshold only decides *memory* vs *temporary file* at 32 MiB; a larger part still gets written to `os.TempDir()` in full. The JSON write routes are equally open (`content/handler.go:142`, `:254`; `community/handler.go:171`, `:199`; `messaging/handler.go:110`, `:203`) — `ShouldBindJSON` decodes whatever length arrives, and the `MaxSourceLength = 200_000` rune bound (`content/domain.go:112`) is applied after decoding.

**Failure scenario**

Any authenticated member (no elevated role needed — `POST /media/uploads` is behind `requireAuth` only, `media/handler.go:40-43`) opens a 1 KiB upload session, then posts a multi-gigabyte multipart part to `/media/uploads/{id}/content`. The server writes the entire body to the temp directory before `StoreContent` rejects it on the size mismatch. Repeated at the global 240 req/min budget this exhausts the disk of the API host and takes down every tenant on it. The same class of request against an anonymous JSON route (`/analytics/visits`) grows heap instead: the decoder buffers the string field before validation.

**Minimal fix**

In `ginrouter.New`, add a body cap before the handlers:

```go
v1.Use(func(c *gin.Context) {
    c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxRequestBody) // e.g. 26 MiB
    c.Next()
})
```

and set `r.MaxMultipartMemory = 8 << 20` on the engine. For the upload route, reject early with `Content-Length > MaxAttachmentBytes` before calling `FormFile`.

---

## DATA-4 — Medium — `GET /media/{assetID}` demands a session although the contract declares it public; every image in a published article is broken for logged-out readers

**Evidence**

The route is mounted with `optionalAuth`, and the comment above it states the requirement exactly — `apps/api/internal/media/handler.go:37-38`:

```go
	// Images embedded in a published article must load for a reader without a session.
	r.GET("/media/:assetID", optionalAuth, h.DownloadAsset)
```

The handler then refuses the anonymous case — `apps/api/internal/media/handler.go:110-114`:

```go
	actor, ok := h.principal(c)
	if !ok {
		_ = c.Error(apperr.Unauthenticated().WithDetail("reason", "missing_principal"))
		return
	}
```

and the principal injected by the composition root can never succeed anonymously — `apps/api/cmd/server/main.go:260-266`:

```go
		Media: media.NewHandler(mediaService, media.HandlerConfig{
			Principal: func(c *gin.Context) (media.Actor, bool) {
				principal, ok := middleware.PrincipalFrom(c)
				if !ok {
					return media.Actor{}, false
				}
```

The published contract disagrees: `packages/contracts/openapi/openapi.yaml:1144-1148`:

```yaml
  /media/{assetID}:
    get:
      tags: [media]
      summary: Download a clean asset
      security: []
```

and `docs/superpowers/reports/2026-10-20-delivery-status.md:385` lists 媒体下载 in the anonymous-read scope. (The same report contradicts itself at line 370, where 匿名图片访问 is listed as not implemented — that contradiction is what let the mismatch ship.)

**Failure scenario**

A reader without a session opens a published article on a `visibility_mode = public` site. `ContentDetail.tsx:514` renders the server HTML with `dangerouslySetInnerHTML`, so the browser issues a session-less `GET /api/v1/media/<id>` for every `<img src>` and gets **401** for each. No image ever renders; the 401 body is `application/problem+json`, so `<img>` shows a broken-image placeholder. This is the default state of the product for logged-out readers, i.e. the main audience of a public publication.

**Minimal fix (do not simply delete the principal check)**

Allow the anonymous case only when it is provably safe, because `OpenAsset` has no owner or publication predicate (`media/service.go:254-279` — it only checks `asset.Referenceable()`):

1. Resolve the site from the host and refuse anonymous when `resolved.IsMembersOnly()`, as `content` does.
2. For anonymous callers, require `asset.Purpose ∈ {content, site, avatar}` — never `attachment` — and ideally that the asset is referenced by a published revision. The cheapest correct version is a `media_asset` column `published_ref bool`, set when a published revision references the id, or a join from the asset id to `content_item.rendered_html` (expensive); until then, restricting to image purposes plus a site-visibility check removes the draft-attachment exposure introduced by making the route truly public.
3. Keep the current `Referenceable()` gate so rejected objects stay 404.

---

## DATA-5 — Medium — Notifications are never produced: `Notify` has no production caller, the inbox is permanently empty

**Evidence**

`notifications.Service.Notify` is the only writer of the `notification` table — `apps/api/internal/notifications/service.go:51-66` — and the store is constructed in exactly one place, `apps/api/cmd/server/main.go:170`:

```go
	notificationService, err := notifications.NewService(notificationstore.New(handle.Client))
```

That service is then only handed to the HTTP handler — `apps/api/cmd/server/main.go:241-248`. A repository-wide search for `notificationService` and `.Notify(` returns **only** `main.go:170`, `main.go:241` and `service_test.go:91,105,116,133,146`. No producer calls it.

The modules that *should* produce notifications instead write outbox events and stop there:

- comments: `apps/api/internal/infrastructure/communitystore/store.go:164-183` writes `EventType("comment.created")` with `SetAudienceUserID(notifyUserID)`
- reactions: `communitystore/store.go:309-329` writes `reaction.created`
- messages: `apps/api/internal/infrastructure/messagingstore/store.go:165-186` writes `message.created` per member

The outbox consumer only pushes to the WebSocket hub and reports success unconditionally — `apps/api/cmd/server/main.go:541-558`:

```go
	h.hub.Publish(ctx, ws.Event{ ... })
	return nil
```

**Failure scenario**

User A comments on user B's article while B is offline. The transaction commits an outbox event addressed to B. The worker marks it published. B later opens the app: `GET /api/v1/notifications` reads `notification` rows that were never inserted and returns `{"items":[],"unread":0}` for every user, forever. Only a live WebSocket connection would ever have surfaced the event, and that only if the socket was already open at delivery time. `docs/superpowers/reports/2026-10-20-delivery-status.md:398-400` claims the notification inbox works ("已读幂等…别人的通知连'存在'都不透露"), which is true of the API but describes an inbox that can never contain anything.

**Minimal fix**

In the outbox handler, fan an event out into the notification table for the messaging/community event types (they already carry `AudienceUserID`, `AggregateID` and a bounded payload), e.g. `notifications.Service.Notify(ctx, notifications.NewInput{SiteID: event.SiteID, UserID: event.AudienceUserID, Type: ..., SubjectID: event.AggregateID, Payload: …})`. Keep it idempotent: add a unique index on `notification (subject_id, user_id, type)` so a retried delivery cannot duplicate a row.

---

## DATA-6 — Medium — The moderation module has no HTTP surface and is not wired at all

**Evidence**

`apps/api/internal/moderation/` contains only `domain.go`, `domain_test.go`, `service.go`, `service_test.go` — there is no `handler.go` (verified by directory listing). The composition root never builds a moderation service or store: `apps/api/cmd/server/main.go:175-198` builds content, analytics and taxonomy; a search for `moderation` under `apps/api/cmd` returns **no match**. `ginrouter.Dependencies` has no moderation field (`transport/http/gin/dependencies.go:28-70`) and the router mounts no moderation routes (`router.go:90-123`). `packages/contracts/openapi/openapi.yaml` contains no report/moderation path either.

**Failure scenario**

A member wants to report abuse. There is no endpoint: `POST /api/v1/comments` exists, a report endpoint does not. A moderator cannot list the queue (`moderation.Service.Queue`, `moderation/service.go:89-97`), assign (`Assign`, `:58-69`) or resolve (`Resolve`, `:72-83`). The entire `moderation_reports` table, its unique duplicate guard (`ent/schema/moderation_report.go`) and the assignee-only rule are unreachable from production, while `docs/superpowers/reports/2026-10-20-delivery-status.md:75` lists "举报去重、只有被指派人可结案" as verified and line 11 states the 审核 module has its HTTP layer done. `community.Handler` mounts no report route, so the gap cannot be worked around by the client.

**Minimal fix**

Add `moderation/handler.go` with `POST /reports`, `GET /reports` (queue), `POST /reports/{id}/assign`, `POST /reports/{id}/resolve`, wire it in `main.go` (`moderation.NewService(moderationstore.New(handle.Client))`) and register it in `Dependencies`/`router.go` behind `requireAuth`, taking the actor from the token exactly as `community` does. `File` also needs an `AuthorLookup`-style port to obtain `targetAuthorID` (today that parameter is supplied by a caller that does not exist).

---

## DATA-7 — Medium — The message list returns the **oldest** N messages, so a busy conversation can never show its recent messages

**Evidence**

`apps/api/internal/infrastructure/messagingstore/store.go:202-207`:

```go
func (s *Store) ListMessages(ctx context.Context, siteID, conversationID string, limit int) ([]Message, error) {
	rows, err := s.client.Message.Query().
		Where(message.SiteIDEQ(siteID), message.ConversationIDEQ(conversationID)).
		Order(entgen.Asc(message.FieldCreatedAt)).
		Limit(limit).
```

The repository contract says "returns messages of a conversation in creation order" (`messaging/service.go:19-20`) and the service clamps the limit to at most 100 with no cursor (`messaging/service.go:110-113`), contradicting `messaging/domain.go:1-6` ("how messages are ordered") and the handler, which exposes only `limit` (`messaging/handler.go:41`, `:143`). `docs/superpowers/reports/2026-10-20-delivery-status.md:430` admits there is no cursor but not that the tail is unreachable.

**Failure scenario**

A support thread reaches 51 messages. Every `GET /api/v1/conversations/{id}/messages?limit=50` returns messages 1–50 in ascending order; message 51 — the one the user just sent — is never returned by any request, at any limit. Participants of a long conversation cannot read what was just said. Nothing recovers it: the client has no cursor parameter and the read cursor does not filter the query.

**Minimal fix**

Page from the newest end: `Order(Desc(created_at), Desc(id))` with the same composite cursor the content and comment lists already use (`platform/page/cursor.go`, `contentstore/store.go:164-176`), then reverse the slice before returning so the response stays chronological. If a stable minimal change is preferred, order `Desc` and reverse in the store, keeping the existing `limit`-only API.

---

## DATA-8 — Low — `SaveDraft` is not status-conditional, so a stale edit can un-publish an article or cancel a pending review

**Evidence**

`apps/api/internal/infrastructure/contentstore/store.go:92-107` — the update predicate is id plus site only:

```go
	update := tx.ContentItem.Update().
		Where(contentitem.IDEQ(item.ID), contentitem.SiteIDEQ(item.SiteID)).
		SetTitle(item.Title).
		...
		SetStatus(string(item.Status)).
```

Compare `Transition` in the same file, which is genuinely conditional and explains why that matters — `contentstore/store.go:252-259`:

```go
	update := tx.ContentItem.Update().
		Where(
			contentitem.IDEQ(item.ID),
			contentitem.SiteIDEQ(item.SiteID),
			contentitem.StatusEQ(string(from)),
		).
```

The service check that is supposed to guard this is a read-then-write — `apps/api/internal/content/service.go:146-152`:

```go
	item, err := s.load(ctx, actor, contentID)
	...
	if !editable(item.Status) {
		return Content{}, ErrInvalidTransition
	}
```

**Failure scenario (concurrency, not a remote-privilege issue)**

Author opens the editor on a draft. An editor publishes it (`Transition` publishes, status `published`). The author's `PATCH /articles/{id}` had already loaded `status = draft`, so `editable` passed; `SaveDraft` then writes title/body **and `status = draft`**, while `published_at` is left untouched because `SaveDraft` never clears it. The article disappears from `GET /articles` (`filter.Statuses = [published]`, `content/service.go:332-334`) with an audit log that records only `content.updated`, not the implicit transition. The mirror case cancels a `pending_review` submission, losing the reviewer's queue entry. Recovery requires a moderator; the audit trail shows nothing unusual.

**Minimal fix**

Add the editable states to the update predicate and treat zero affected rows as `ErrInvalidTransition`:

```go
Where(contentitem.IDEQ(item.ID), contentitem.SiteIDEQ(item.SiteID),
      contentitem.StatusIn("draft", "rejected", "pending_security_check"))
```

---

## DATA-9 — Low — A draft's category can never be cleared; the update silently keeps the old value

**Evidence**

`apps/api/internal/infrastructure/contentstore/store.go:104-106`:

```go
	if item.CategoryID != "" {
		update.SetCategoryID(item.CategoryID)
	}
```

The same pattern is used on insert (`:54-56`) where it is correct, but on update it means "empty string = do nothing". Nothing else clears the column; `content.ValidateDraft` explicitly allows an empty `CategoryID` (`content/domain.go:339-341`), and `taxonomystore.Delete` clears it only when the whole category is deleted (`taxonomystore/store.go:125-132`).

**Failure scenario**

An author moves an article from "Announcements" to no category: `PATCH /articles/{id}` with `"category_id": ""`. The API answers 200 and echoes `category_id: ""` (it re-reads the row and `toContent` maps `NULL` to `""`, `contentstore/store.go:344-346`), but the stored row still holds the old id, so category pages and `DELETE /taxonomy` behaviour keep the article in "Announcements". The response is a lie the client cannot detect.

**Minimal fix**

On update use `SetNillableCategoryID(...)`/`ClearCategoryID()` when the incoming value is empty:

```go
if item.CategoryID != "" { update.SetCategoryID(item.CategoryID) } else { update.ClearCategoryID() }
```

---

## DATA-10 — Low — The conversation read cursor is not forward-only, is not validated against the conversation, and the helper that prevents this is dead code

**Evidence**

`apps/api/internal/infrastructure/messagingstore/store.go:226-241` sets the cursor unconditionally:

```go
func (s *Store) AdvanceReadCursor(ctx context.Context, siteID, conversationID, userID, messageID string) (bool, error) {
	affected, err := s.client.ConversationMember.Update().
		Where(
			conversationmember.SiteIDEQ(siteID),
			conversationmember.ConversationIDEQ(conversationID),
			conversationmember.UserIDEQ(userID),
		).
		SetLastReadMessageID(messageID).
```

The domain method that *would* enforce forward-only semantics is never called from production code — `apps/api/internal/messaging/domain.go:163-183`, and a search for `AdvanceReadCursor` outside `messagingstore` finds only `messaging/domain_test.go:80,85` and the interface/port declarations in `messaging/service.go:21-22,145,162`. The service also accepts any string as the message id — `messaging/service.go:153-163` passes `messageID` straight to the store after checking membership only.

**Failure scenario**

A second device (or a stale tab) calls `POST /conversations/{id}/read` with an older `message_id`, moving the cursor backwards and marking already-read messages unread again — the exact case `domain.go:164-166` says must not happen ("an out of order update from a second device cannot mark already read messages unread"). Passing a message id from a *different* conversation, or an arbitrary string, is also accepted and stored (the column is a free-form `varchar(36)` with no foreign key, `ent/schema/conversation_member.go:19`), corrupting the unread computation for that member. No cross-user impact: only the caller's own cursor row is written.

**Minimal fix**

Resolve the target message first (`FindMessage` scoped by `site_id` + `conversation_id`), then apply the cursor only when the new message's `created_at` is greater than the current cursor message's, i.e. either use `Conversation.AdvanceReadCursor` from the service or make the store's update predicate include the ordering condition.

---

## DATA-11 — Low — Content listing does one site lookup per returned row on a discarded context, over an unindexed sort

**Evidence**

Every response item calls `Actions`, which re-reads the site's publish mode — `apps/api/internal/content/handler.go:303-309`:

```go
func (h *Handler) view(item Content, actor Actor) contentResponse {
	actions := make([]string, 0, 5)
	if available, err := h.service.Actions(context.Background(), actor, item); err == nil {
```

→ `content/service.go:274-280` calls `s.publishMode(ctx, item.SiteID)`, which is `siteService.PublishMode` → `repo.FindByID` — one query per item (`site/service.go:158-164`, no cache by design). `list` builds up to 100 of those (`content/handler.go:221-224`). Note also that the request context is replaced with `context.Background()`, so a cancelled request keeps issuing queries and no deadline applies.

The cursor page itself sorts on a column pair that no index covers — `contentstore/store.go:169-178`:

```go
		query = query.Where(contentitem.Or(
			contentitem.CreatedAtLT(boundary),
			contentitem.And(contentitem.CreatedAtEQ(boundary), contentitem.IDLT(filter.After.ID)),
		))
	}
	rows, err := query.
		Order(entgen.Desc(contentitem.FieldCreatedAt), entgen.Desc(contentitem.FieldID)).
```

while the schema only indexes `(site_id, status, published_at)`, `(author_id, status)` and `(site_id, slug)` — `apps/api/ent/schema/content_item.go:75-83`.

**Failure scenario**

A public site with a few thousand published articles: `GET /articles?limit=50` performs 51 site lookups (each a primary-key read, so not fatal, but 50× the queries needed) and answers from a filesort over every row of the site. The N+1 also multiplies under the global rate limiter and makes the endpoint's latency scale with page size × database round-trip time. This is a performance/scalability defect, not a correctness or disclosure defect.

**Minimal fix**

- Resolve `publishMode` once per request (pass it into `view`, or fetch it in `list`/`get` and hand it to `Actions`), and pass `c.Request.Context()` instead of `context.Background()`.
- Add `index.Fields("site_id", "created_at")` (and `id` as the tie-breaker where the dialect allows) to `ContentItem.Indexes()`; regenerate through `scripts/gen.ps1` as `migrations/README.md:3-5` requires.

---

## DATA-12 — Low — Completing an upload inserts the asset and closes the session in two unsynchronised writes

**Evidence**

`apps/api/internal/media/service.go:235-247`:

```go
	stored, err := s.repo.InsertAsset(ctx, asset)
	if err != nil {
		return Asset{}, err
	}

	if err := s.repo.MarkUploadCompleted(ctx, uploadID, now); err != nil {
		return Asset{}, err
	}
```

`MarkUploadCompleted` is intentionally idempotent (a no-op when already completed) — `mediastore/store.go:82-103` — and the completion decision itself is a plain read-then-write (`media/service.go:183-197`: `FindUpload`, then `if upload.Status == UploadCompleted`). The unique index on `media_asset.storage_key` (`ent/schema/media_asset.go:45`) is the only thing preventing two asset rows.

**Failure scenario**

Two concurrent `POST /media/uploads/{id}/complete` calls (double-click, or a client retrying while the scan is slow) both read `status = uploaded`, both call the scanner, and both insert an asset: the second insert violates the unique `storage_key` index and surfaces as a driver error mapped to 500 by `mapError` (`media/handler.go:211-215`). Alternatively the insert succeeds but `MarkUploadCompleted` fails, leaving a usable asset while the session still reports `uploaded`; a retry then 500s instead of returning the existing asset. No security impact — the asset is still gated on the scan verdict — but the client sees a spurious failure and the session can be left inconsistent.

**Minimal fix**

Make the transition first: `UPDATE media_upload SET status='completed' WHERE id=? AND status='uploaded'` (conditional, like `contentstore.Transition`), return `ErrAlreadyCompleted` when zero rows are affected, and only then insert the asset — ideally in one transaction opened by the store, since both tables are in the same database.

---

## Verified safe (checked, and found correct)

These were traced end-to-end and the predicate that the upper layer assumes is present in the layer below. An absence of a finding above for these areas is a positive result, not an omission.

1. **Tenant scope in every store used by a request path.** `contentstore.FindByID` (`contentstore/store.go:132-143`), `List` (`:146-162`), `SaveDraft`/`Transition` (`:92-107`, `:252-270`); `communitystore.FindComment` (`communitystore/store.go:33-44`), `ListComments` (`:47-48`), `UpdateComment` (`:205-210`), `AuthorOf` (`:233-259`); `mediastore.FindUpload`/`FindAsset`/`DeleteAsset` (`mediastore/store.go:45-56`, `:135-160`); `messagingstore.FindConversation` (`messagingstore/store.go:72-75`); `notificationstore.List`/`Find`/`MarkAllRead` (`notificationstore/store.go:47-101`); `outboxstore.Replay` (`outboxstore/store.go:121-134`); `taxonomystore.*` (`taxonomystore/store.go:25-149`); `analyticsstore.Aggregate` (`analyticsstore/store.go:49-60`); `moderationstore.*` (`moderationstore/store.go:49-113`). Every one carries `site_id` (plus `user_id` where the resource is per-user), and the services above them rely on exactly that.
2. **Draft read authorization.** `Service.Get` loads inside the site scope and then re-checks status plus authorship/role, returning `ErrNotFound` (not 403) so unpublished content is not an existence oracle — `content/service.go:434-444`, with defence in depth at `:478-488`. Anonymous readers are refused outright on `members_only` (`content/handler.go:55-67`). `TestAnonymousCannotReadDraftByID` and `TestGetHidesUnpublishedFromStrangers` cover it.
3. **Draft update authorization and published immutability.** `UpdateDraft` requires editable status **and** (`IsAuthor` or `role >= editor`) — `content/service.go:146-155`; `editable()` excludes `published`/`pending_review`/`archived` (`:495-502`). An editor cannot approve their own pending item because publish-from-`pending_review` requires `role >= editor` and submit/publish from draft are separate rows of the workflow table (`content/domain.go:180-191`, `:237-281`).
4. **Publish state machine and sanitisation gate.** `Policy.Next` checks site isolation first, then the transition table, then publish mode, then the actor (`content/domain.go:213-235`); publication additionally requires `RenderedHTML != "" && PolicyVersion != ""` (`content/service.go:205-209`, `:491-493`). A sanitizer outage stores the item as `pending_security_check` with its rendered HTML cleared (`content/service.go:461-468`), so unsanitized HTML never reaches the `dangerouslySetInnerHTML` sink in `apps/web/src/pages/site/ContentDetail.tsx:514`.
5. **Only `clean` assets are downloadable, and rejected ones are indistinguishable from missing.** `OpenAsset` requires `asset.Referenceable()` and maps `ErrStorageObjectMissing` to `ErrNotFound` (`media/service.go:254-279`); the handler sets `X-Content-Type-Options: nosniff`, takes the type from the database, and never from the request (`media/handler.go:123-129`).
6. **Media path-traversal defence.** Keys are generated (`media/domain.go:186-197` — UUIDv7 plus a sanitised display extension), and both adapters re-validate: `LocalStorage.resolve` (`media/storage.go:169-190`) rejects empty/NUL/backslash/leading-slash/absolute/`..` keys and re-checks containment with `filepath.Rel`; `S3Storage.objectKey` (`media/s3.go:214-230`) rejects `.`/`..` segments and backslashes. `Put` bounds the write to the declared size with `io.CopyN` and treats a short stream as an error (`media/storage.go:88-95`).
7. **Upload ownership.** `StoreContent`, `CompleteUpload` and `DeleteAsset` all compare `upload.OwnerID`/`asset.OwnerID` with the caller (`media/service.go:150-152`, `:187-189`, `:292-294`), and `CreateUpload` takes the owner from the principal, never from the body (`:119-130`).
8. **Notification read authorization.** `Find` is scoped by site *and* user (`notificationstore/store.go:64-80`) and `CanMarkRead` re-checks both (`notifications/domain.go:121-129`); marking is idempotent at the store level via `ReadAtIsNil()` (`notificationstore/store.go:83-89`).
9. **Conversation authorization.** Site isolation is checked before membership (`messaging/domain.go:91-99`), a non-member gets `ErrNotFound` rather than 403 (`messaging/service.go:166-179`), and the site predicate is in the query, not a post-filter.
10. **Outbox replay isolation.** The audience predicate is part of the query — `AudienceUserIDIsNil() OR AudienceUserIDEQ(userID)` plus `SiteIDEQ` (`outboxstore/store.go:121-134`) — and the WebSocket hub applies a second, independent site + audience filter (`transport/ws/hub.go:174-195`). Every producer in the tree sets `audience_user_id` (`communitystore/store.go:164-183`, `:309-329`; `messagingstore/store.go:165-186`); nothing currently writes a site-wide event, so the "empty audience" branch is unmounted.
11. **No SQL injection surface.** All queries are Ent builders; a repository-wide search for `fmt.Sprintf`, `Raw(`, `ExecContext` and `QueryContext` in `apps/api/internal` finds no SQL string construction (the only `Sprintf` uses are log/error formatting and the S3 `Range` header, `media/s3.go:161`, where the value is an `int`). `TitleContainsFold`/`BodyContainsFold` are parameterised; the search term is additionally stripped of `%`/`_` (`contentstore/store.go:197`).
12. **Cursor decode hardening.** `page.Decode` bounds the encoded input at 512 bytes, requires an `id`, and returns `ErrInvalidCursor` for anything malformed (`platform/page/cursor.go:52-74`); a forged but well-formed cursor can only select a position inside the caller's own site/status scope. The content and comment comparisons match their `ORDER BY (created_at DESC, id DESC)` exactly (`contentstore/store.go:164-178`, `communitystore/store.go:74-91`).
13. **Comment moderation rules.** Only the author edits, and only while visible (`community/domain.go:138-144`); moderators are required for hide/restore and for the non-visible queue (`community/service.go:182-202`, `:224-254`); depth is bounded in the domain (`community/domain.go:190-199`).
14. **Taxonomy write authorization and uniqueness.** `authorizeWrite` requires authenticated + same site + `role >= site_admin` (`taxonomy/service.go:120-130`) and the handler binds the path site to the token site (`taxonomy/handler.go:106-109`); name and slug uniqueness per `(site, kind)` is enforced by unique indexes (`ent/schema/taxonomy_term.go:43-46`) and surfaced as `ErrConflict`.
15. **Analytics report authorization.** Requires an authenticated principal, `actor.SiteID == siteID` and `role >= site_admin` (`analytics/service.go:76-84`), with the `tz_offset` bound validated twice (`analytics/handler.go:153-160`, `analytics/service.go:92-98`).

**Not verified (explicitly out of reach for a static review of this layer):** MySQL/PostgreSQL dialect behaviour of the Ent predicates (the report itself lists these as unrun); the Rust sanitizer/scan *implementation* beyond `services/security/src/content.rs` (ammonia allow-list, magic-byte check, `plain` escaping were read and look correct); every runtime/concurrency claim in DATA-8 and DATA-12, which follows from the code shape but was not reproduced.

---

## Minor observations (below Low; recorded so they are not re-discovered as new)

- `contentstore.Search` strips `%` and `_` from the term instead of escaping them (`contentstore/store.go:196-200`), so `100%` searches the substring `100`; `docs/superpowers/reports/2026-10-20-delivery-status.md:392` claims wildcards are "treated literally", which is not what the code does. Ordering is by `published_at` with no id tie-breaker (`:215-218`), so equal timestamps order non-deterministically.
- `moderationstore.InsertReport` maps **every** persistence error to `moderation.ErrInvalidInput` (`moderationstore/store.go:38-44`), so a database outage is reported to the caller as a 400 validation failure; `moderation.Report.Resolve` overwrites the reporter's note with the resolution note (`moderation/domain.go:197-203`), destroying evidence. Both are unreachable today because of DATA-6, but become live the moment the module is wired.
- `community.Service.AddComment` checks the parent's site and depth but never that the parent belongs to the same target, nor that the target exists or is published (`community/service.go:94-106`); a reply to a comment on article A can be filed under article B, and comments can be attached to draft or non-existent targets. The listing then discloses those `target_id`s to any reader of `GET /comments` (`community/handler.go:130-143`).
- Reactions, bookmarks and follows are keyed on the caller plus a caller-supplied target id and never verified against the caller's site (`community/service.go:279-315`, `:331-380`; `communitystore/store.go:262-269`, `:339-345` omit `site_id` from the existence checks), so rows can be created for targets and users that are not in the tenant. Low impact (no read path exposes them), but a data-integrity hole.
- `communitystore.ListComments` resolves author display names with an un-scoped `User.Query()` (`communitystore/store.go:61-66`); only ids are used and the comment query is site-scoped, so nothing leaks, but the query crosses tenants by construction.
- `media.Service.CreateUpload` returns `storage_key` to the client while `CompleteUpload` returns the asset id; neither is an id the client can use to probe another tenant, but the storage key is disclosed before the scan runs (`media/handler.go:95-101`).
- The draft edit flow cannot round-trip: `PATCH /articles/{id}` requires a full body (`content/domain.go:325-330`) while no read endpoint returns `source_body` (`content/handler.go:103-119`; the contract omits it too, `openapi.yaml:1939-1950`). The web app documents that editing is therefore disabled (`apps/web/src/pages/admin/Docs.tsx:264`). Not a security issue, but it means the "已发布不可编辑 / 草稿可编辑" promise in the delivery report is only half reachable — a client that reloads the page cannot recover the source.
