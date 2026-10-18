# Practacu Press Backend Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Gin-based Go modular monolith that provides multi-site identity, content, community, messaging, persistence, and WebSocket APIs for Practacu Press.

**Architecture:** Keep HTTP adapters thin and place business rules in application services and domain packages. Use Ent with Atlas migrations behind repository interfaces so SQLite, MySQL, and PostgreSQL share the same behavior. Keep security-sensitive operations behind the Rust gRPC client and publish reliable asynchronous work through an outbox table.

**Tech Stack:** Go, Gin, Ent, Atlas, SQLite, MySQL, PostgreSQL, WebSocket, OpenAPI 3.1, protobuf/gRPC client, structured logging.

## Global Constraints

- 首版不实现 React 前端；所有客户端能力必须通过 REST/OpenAPI 3.1 和 WebSocket 暴露。
- 必须支持 SQLite、MySQL、PostgreSQL；不得依赖单一数据库方言。
- Gin 只负责 HTTP 适配；业务规则不得写入 Handler。
- 所有资源查询和写入必须带 `site_id` 范围并执行服务端权限校验。
- 文章、帖子、评论和媒体发布必须经过状态规则与 Rust 安全检查。
- Access Token 使用 Ed25519 签名 JWT，有效期 15 分钟；Refresh Token 为轮换的 opaque token，仅保存哈希并使用 HttpOnly、Secure、SameSite Cookie。
- Refresh 接口必须验证 CSRF 双提交令牌；事件 ID 使用 UUIDv7，断线补偿端点为 `GET /api/v1/events?after_id=<event_id>&limit=100`。
- 普通用户、编辑/审核员、站点管理员、平台管理员的权限必须可测试。
- Windows 单站点模式和 Linux Docker 多站点模式使用同一套核心 API。

---

### Task 1: 初始化 Go 模块和 Gin 运行骨架

**Files:**
- Create: `go.mod`
- Create: `apps/api/cmd/server/main.go`
- Create: `apps/api/internal/platform/config/config.go`
- Create: `apps/api/internal/platform/logging/logger.go`
- Create: `apps/api/internal/transport/http/gin/router.go`
- Create: `apps/api/internal/transport/http/gin/router_test.go`
- Create: `Makefile`

**Interfaces:**
- Produces `config.Load() (config.Config, error)` and `ginrouter.New(deps ginrouter.Dependencies) *gin.Engine`.
- `main.go` owns process startup and graceful shutdown; handlers do not own global state.

- [ ] **Step 1: Write the failing router test**

```go
func TestRouterHealthz(t *testing.T) {
    r := New(Dependencies{})
    w := httptest.NewRecorder()
    req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
    r.ServeHTTP(w, req)
    require.Equal(t, http.StatusOK, w.Code)
    require.JSONEq(t, `{"status":"ok"}`, w.Body.String())
}
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `go test ./apps/api/internal/transport/http/gin -run TestRouterHealthz -v`
Expected: FAIL because the Go module and router package do not exist.

- [ ] **Step 3: Add the minimal Gin implementation**

```go
func New(deps Dependencies) *gin.Engine {
    r := gin.New()
    r.Use(gin.Recovery())
    r.GET("/healthz", func(c *gin.Context) { c.JSON(http.StatusOK, gin.H{"status": "ok"}) })
    return r
}
```

- [ ] **Step 4: Add config validation and graceful shutdown**

Require `APP_ENV`, `HTTP_ADDR`, `DATABASE_DRIVER`, `DATABASE_DSN`, and `SECURITY_GRPC_ADDR`; reject an unknown driver with a typed configuration error.

- [ ] **Step 5: Run the focused test and commit**

Run: `go test ./apps/api/internal/transport/http/gin ./apps/api/internal/platform/config -v`
Expected: PASS.

Commit: `git add go.mod apps/api Makefile; git commit -m "chore: scaffold gin api"`

### Task 2: Add the dialect-neutral data layer and migrations

**Files:**
- Create: `apps/api/internal/infrastructure/db/client.go`
- Create: `apps/api/internal/infrastructure/db/driver.go`
- Create: `apps/api/ent/schema/user.go`
- Create: `apps/api/ent/schema/site.go`
- Create: `apps/api/ent/schema/site_member.go`
- Create: `apps/api/ent/schema/article.go`
- Create: `apps/api/ent/schema/post.go`
- Create: `apps/api/ent/schema/content_revision.go`
- Create: `apps/api/ent/schema/comment.go`
- Create: `apps/api/ent/schema/social.go`
- Create: `apps/api/ent/schema/messaging.go`
- Create: `apps/api/ent/schema/media.go`
- Create: `apps/api/ent/schema/audit.go`
- Create: `apps/api/ent/schema/outbox.go`
- Create: `migrations/sqlite/README.md`
- Create: `migrations/mysql/README.md`
- Create: `migrations/postgres/README.md`
- Create: `apps/api/internal/infrastructure/db/client_test.go`

**Interfaces:**
- Produces `db.Open(ctx, driverName, dsn) (*ent.Client, func() error, error)`.
- Every repository receives an `*ent.Tx` or `*ent.Client` from the application service; repositories never choose a driver.

- [ ] **Step 1: Write a driver matrix test**

```go
func TestSupportedDrivers(t *testing.T) {
    for _, name := range []string{"sqlite", "mysql", "postgres"} {
        require.True(t, IsSupportedDriver(name))
    }
    require.False(t, IsSupportedDriver("oracle"))
}
```

- [ ] **Step 2: Run the test to verify the driver registry is missing**

Run: `go test ./apps/api/internal/infrastructure/db -run TestSupportedDrivers -v`
Expected: FAIL because `IsSupportedDriver` is not defined.

- [ ] **Step 3: Implement driver selection and connection creation**

Use Ent dialect constants and keep the driver switch in one file. Normalize `sqlite`, `mysql`, and `postgres` aliases before selecting a driver.

- [ ] **Step 4: Define schemas with portable fields**

Use string IDs, UTC timestamps, nullable text fields, explicit status strings, and JSON payloads only where the field is not queried. Do not use PostgreSQL arrays, database enums, partial indexes, or `RETURNING`.

- [ ] **Step 5: Generate Ent code and create Atlas migration entry points**

Run: `go generate ./apps/api/ent/...`

Create one migration command that receives `DATABASE_DRIVER` and applies the matching Atlas directory. The command must support an empty database and a clean rollback in test environments.

- [ ] **Step 6: Run the data-layer tests for all configured drivers**

Run: `go test ./apps/api/internal/infrastructure/db ./apps/api/ent/... -v`
Expected: PASS for SQLite locally; CI runs the same suite against MySQL and PostgreSQL containers.

- [ ] **Step 7: Commit**

Commit: `git add apps/api/ent apps/api/internal/infrastructure/db migrations; git commit -m "feat: add portable persistence model"`

### Task 3: Add request context, errors, CORS, rate limits, and site resolution

**Files:**
- Create: `apps/api/internal/transport/http/gin/middleware/request_id.go`
- Create: `apps/api/internal/transport/http/gin/middleware/error.go`
- Create: `apps/api/internal/transport/http/gin/middleware/site.go`
- Create: `apps/api/internal/transport/http/gin/middleware/auth.go`
- Create: `apps/api/internal/transport/http/gin/middleware/rate_limit.go`
- Create: `apps/api/internal/platform/errors/errors.go`
- Create: `apps/api/internal/transport/http/gin/middleware/middleware_test.go`

**Interfaces:**
- `errors.Problem` serializes to `application/problem+json`.
- `site.ContextSite(c) (site.Site, bool)` returns the host-resolved site.
- `auth.CurrentPrincipal(c) (auth.Principal, bool)` returns the verified principal.

- [ ] **Step 1: Write tests for request IDs and problem responses**

Verify every response has `X-Request-ID`, and a handler returning `errors.ErrPermissionDenied` produces status 403 and code `permission_denied`.

- [ ] **Step 2: Implement typed errors and centralized Gin error middleware**

Map validation, authentication, authorization, not-found, conflict, rate-limit, and internal errors to stable codes. Never expose database or Rust stack traces.

- [ ] **Step 3: Implement host-to-site resolution**

Resolve the site from the trusted Host header mapping. Allow `site_id` only for authenticated management requests and verify membership before using it.

- [ ] **Step 4: Implement CORS and rate-limit policies**

Allow only configured origins. Apply per-IP and per-user limits to registration, login, SMS, content writes, comments, messages, and uploads.

- [ ] **Step 5: Run middleware tests**

Run: `go test ./apps/api/internal/transport/http/gin/middleware ./apps/api/internal/platform/errors -v`
Expected: PASS.

### Task 4: Implement identity, sessions, sites, and fixed roles

**Files:**
- Create: `apps/api/internal/auth/domain.go`
- Create: `apps/api/internal/auth/service.go`
- Create: `apps/api/internal/auth/handler.go`
- Create: `apps/api/internal/auth/repository.go`
- Create: `apps/api/internal/site/domain.go`
- Create: `apps/api/internal/site/service.go`
- Create: `apps/api/internal/site/handler.go`
- Create: `apps/api/internal/site/repository.go`
- Create: `apps/api/internal/auth/service_test.go`
- Create: `apps/api/internal/site/service_test.go`

**Interfaces:**
- `AuthService.RegisterEmail(ctx, siteID, input) (UserView, error)`
- `AuthService.LoginPassword(ctx, siteID, input) (Session, error)`
- `AuthService.Refresh(ctx, refreshToken) (Session, error)`
- `SiteService.ResolveOrCreateDefault(ctx, hostname) (SiteView, error)`
- `SiteService.ChangeMemberRole(ctx, actor, siteID, userID, role) error`

- [ ] **Step 1: Write tests for registration, refresh rotation, and role checks**

Cover duplicate identity, unverified email, refresh-token reuse, ordinary-user denial of role changes, and site-admin success within their own site.

- [ ] **Step 2: Implement identity normalization and membership creation**

Normalize email case, canonicalize phone numbers, create a default site membership after verified registration, and store provider subjects separately from display names.

- [ ] **Step 3: Implement session issuance and rotation**

Create a 15-minute Ed25519-signed JWT and a hashed opaque refresh-token record. Set a CSRF cookie and require the matching header on refresh. Rotate and revoke the old refresh token on every successful refresh; detect reuse and revoke the token family.

- [ ] **Step 4: Implement OAuth provider adapters**

Keep provider-specific code behind `OAuthProvider`; support Google, GitHub, and WeChat callback validation without exposing provider tokens to the browser.

- [ ] **Step 5: Implement site and membership endpoints**

Add site configuration, member listing, role changes, site visibility mode, and publishing mode with audit events.

- [ ] **Step 6: Run auth and site tests**

Run: `go test ./apps/api/internal/auth ./apps/api/internal/site -v`
Expected: PASS, including database-backed transaction tests.

### Task 5: Implement content, revisions, media storage, and moderation state

**Files:**
- Create: `apps/api/internal/content/domain.go`
- Create: `apps/api/internal/content/service.go`
- Create: `apps/api/internal/content/handler.go`
- Create: `apps/api/internal/content/repository.go`
- Create: `apps/api/internal/media/storage.go`
- Create: `apps/api/internal/media/service.go`
- Create: `apps/api/internal/media/handler.go`
- Create: `apps/api/internal/moderation/service.go`
- Create: `apps/api/internal/content/service_test.go`
- Create: `apps/api/internal/media/service_test.go`

**Interfaces:**
- `ContentService.CreateDraft(ctx, principal, input) (ContentView, error)`
- `ContentService.Submit(ctx, principal, contentID) error`
- `ContentService.Publish(ctx, principal, contentID, reason) error`
- `MediaStorage.Put(ctx, object, reader) (MediaObject, error)`
- `MediaService.CompleteUpload(ctx, principal, uploadID) (MediaView, error)`

- [ ] **Step 1: Write state-machine tests**

Cover direct publication, review-required submission, rejection to draft, archive, invalid transitions, and unauthorized edits.

- [ ] **Step 2: Implement article/post/revision domain rules**

Store source format, source body, rendered HTML, summary, slug, tags, categories, author, site, status, and revision metadata.

- [ ] **Step 3: Implement media storage adapters**

Provide local filesystem and S3-compatible implementations. Generate storage keys from UUIDs, never from user-provided paths.

- [ ] **Step 4: Add Rust security calls to content and media workflows**

Content publication waits for sanitization; media completion waits for scan status. Failure changes the item to `pending_security_check` and does not publish it.

- [ ] **Step 5: Add moderation queue operations**

Implement approve, reject, archive, restore, report creation, report assignment, and audit records.

- [ ] **Step 6: Run content and media tests**

Run: `go test ./apps/api/internal/content ./apps/api/internal/media ./apps/api/internal/moderation -v`
Expected: PASS.

### Task 6: Implement community interactions

**Files:**
- Create: `apps/api/internal/community/service.go`
- Create: `apps/api/internal/community/handler.go`
- Create: `apps/api/internal/community/repository.go`
- Create: `apps/api/internal/community/service_test.go`

**Interfaces:**
- `CommunityService.AddComment(ctx, principal, input) (CommentView, error)`
- `CommunityService.ToggleReaction(ctx, principal, target, kind) (ReactionView, error)`
- `CommunityService.ToggleBookmark(ctx, principal, target) (BookmarkView, error)`
- `CommunityService.ToggleFollow(ctx, principal, userID) (FollowView, error)`

- [ ] **Step 1: Write tests for idempotent interactions**

Verify repeated like, unlike, bookmark, and follow requests produce one final state and never duplicate rows.

- [ ] **Step 2: Implement comments and replies**

Enforce site scope, target visibility, maximum nesting depth, moderation status, and author ownership.

- [ ] **Step 3: Implement reactions, bookmarks, follows, reports, and blocks**

Use unique constraints for user/target/kind combinations and emit notification outbox events only when state changes.

- [ ] **Step 4: Run interaction tests**

Run: `go test ./apps/api/internal/community -v`
Expected: PASS.

### Task 7: Implement conversations, notifications, outbox processing, and WebSocket

**Files:**
- Create: `apps/api/internal/messaging/service.go`
- Create: `apps/api/internal/messaging/handler.go`
- Create: `apps/api/internal/messaging/repository.go`
- Create: `apps/api/internal/notifications/service.go`
- Create: `apps/api/internal/outbox/worker.go`
- Create: `apps/api/internal/transport/ws/hub.go`
- Create: `apps/api/internal/transport/ws/handler.go`
- Create: `apps/api/internal/messaging/service_test.go`
- Create: `apps/api/internal/transport/ws/handler_test.go`

**Interfaces:**
- `MessagingService.Send(ctx, principal, conversationID, body) (MessageView, error)`
- `MessagingService.List(ctx, principal, conversationID, cursor) (Page[MessageView], error)`
- `NotificationService.MarkRead(ctx, principal, notificationID) error`
- `OutboxWorker.Run(ctx) error`
- `WSTicketService.Issue(ctx, principal) (string, error)`

- [ ] **Step 1: Write tests for conversation membership and notification permissions**

Cover non-member denial, site isolation, message ordering, read cursor updates, and duplicate outbox delivery.

- [ ] **Step 2: Implement conversations and messages**

Persist messages before publishing events. Store last-read cursors per member and never expose another member's private conversation.

- [ ] **Step 3: Implement outbox transaction and worker**

Write domain events and business changes in one transaction. Worker claims pending events, retries with backoff, records attempts, and makes handlers idempotent.

- [ ] **Step 4: Implement WebSocket ticket and event hub**

Use a one-time short-lived ticket, subscribe the connection to the principal and site, send event envelopes with IDs, and remove disconnected clients.

- [ ] **Step 5: Implement reconnect support**

Expose `GET /api/v1/events?after_id=<event_id>&limit=100` keyed by the last UUIDv7 event ID and scoped to the current site and principal. WebSocket delivery is best-effort; REST replay is authoritative.

- [ ] **Step 6: Run messaging and WebSocket tests**

Run: `go test ./apps/api/internal/messaging ./apps/api/internal/notifications ./apps/api/internal/outbox ./apps/api/internal/transport/ws -v`
Expected: PASS.

### Task 8: Add API contract, integration, and three-database acceptance tests

**Files:**
- Create: `apps/api/internal/transport/http/gin/routes.go`
- Create: `tests/integration/api_test.go`
- Create: `tests/integration/site_isolation_test.go`
- Create: `tests/integration/database_matrix_test.go`
- Create: `tests/contract/openapi_response_test.go`

**Interfaces:**
- All routes are mounted below `/api/v1`.
- `GET /healthz`, `GET /readyz`, and `GET /api/v1/docs` are available without an application user session.

- [ ] **Step 1: Write site-isolation integration tests**

Create two sites and two members, then assert that content, media, comments, notifications, conversations, and administration endpoints never cross site boundaries.

- [ ] **Step 2: Mount all module routes**

Register auth, me, sites, articles, posts, comments, reactions, conversations, notifications, media, moderation, admin, search, and WebSocket ticket routes.

- [ ] **Step 3: Add database matrix execution**

Run the same integration suite against SQLite, MySQL, and PostgreSQL DSNs supplied by CI services.

- [ ] **Step 4: Add OpenAPI response checks**

Validate status codes, content types, required fields, error codes, cursors, and WebSocket ticket response against the contract file.

- [ ] **Step 5: Run the full backend suite**

Run: `go test ./...`
Expected: PASS locally with SQLite and in CI for all three database services.

- [ ] **Step 6: Commit**

Commit: `git add .; git commit -m "feat: implement practacu press backend core"`
