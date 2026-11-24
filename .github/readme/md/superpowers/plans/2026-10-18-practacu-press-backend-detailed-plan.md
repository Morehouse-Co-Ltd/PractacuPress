# Practacu Press Backend Detailed Implementation Plan (v2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **本文件是 `2026-10-18-practacu-press-backend-core-plan.md` 的执行版本。** 它保留原计划的 8 个任务目标，但按 `docs/superpowers/reviews/2026-10-18-practacu-press-plan-review.md` 的 P0/P1 修订重新编号为 14 个任务、4 个里程碑。原文件保留作为需求来源，不再直接执行。

**Goal:** 交付一个可在 Windows 本地以 SQLite 完整运行、可切换到 MySQL/PostgreSQL 的 Go 后端，暴露 `/api/v1` REST 与 WebSocket 接口，供外部 React 团队独立对接。

**Architecture:** Gin 只做 HTTP 适配；业务规则位于 application service 与 domain 包；持久化经 Repository 接口隔离，底层由 Ent 驱动三种方言；安全检查经 `SecurityClient` 接口调用 Rust 服务，服务不可用时按 fail-closed 暂停而非放行；可靠异步事件走 outbox 表。

**Tech Stack:** Go 1.26 / Gin v1.12 / Ent v0.14.6 / `modernc.org/sqlite` / `go-sql-driver/mysql` / `pgx v5` / `golang-jwt/v5` / `coder/websocket` / `log/slog` / testify。

## Global Constraints

以下"必须"来自设计稿，实施时不得削弱：

- REST 端点位于 `/api/v1`；破坏性变更走 `/api/v2`。
- 错误响应为 `application/problem+json`，含稳定 `code` 与 `request_id`。
- 所有资源查询与写入必须带 `site_id` 范围，并在服务端校验站点成员身份。
- Access Token：Ed25519 签名 JWT，15 分钟；Refresh Token：opaque、仅存哈希、每次轮换、重放即吊销整族，置于 HttpOnly/Secure/SameSite Cookie。
- Refresh 接口必须校验 CSRF 双提交令牌。
- 事件 ID 用 UUIDv7；断线补偿 `GET /api/v1/events?after_id=<uuidv7>&limit=100`，**按站点 + 收件人隔离**。
- 文章/帖子/评论/媒体发布必须经状态规则与安全检查；安全检查不可用时进入 `pending_security_check`，不得发布。
- 三方言约束：字符串 ID、UTC 时间、可空文本、显式状态字符串；禁用数据库枚举、数组、部分索引、`RETURNING`。
- 业务规则不得写入 Gin Handler。

## 本机执行前置（与计划原文的差异）

原计划假设 Linux + `make` + Docker + 本机三库。本机实际条件要求做以下替换，**每次执行命令都必须带上**：

```powershell
# 1) 固定 64 位 Go（PATH 上默认是 32 位）
$env:PATH = 'C:\Program Files\Go\bin;' + $env:PATH

# 2) Go/Cargo 不读 WinINET 代理，必须显式给出
$env:HTTP_PROXY  = 'http://127.0.0.1:7890'
$env:HTTPS_PROXY = 'http://127.0.0.1:7890'
$env:NO_PROXY    = 'localhost,127.0.0.1'

# 3) 本机没有 make：以 scripts/*.ps1 为入口
# 4) 本机没有 Docker / MySQL / PostgreSQL：三方言只在 CI 验收
```

因此原计划里的 `Run: go test ...` 一律读作"在 `scripts/env.ps1` 设置好上述变量后执行"。`Makefile` 仍会创建，但只服务于 Linux CI。

## 模块与包约定

- Go module 路径：`github.com/practacu/practacu-press`
- 生成代码只在 `apps/api/ent/` 下，不手工编辑（`ent/generate.go` 里放 `//go:generate`）。
- 包名 `apperr` 位于目录 `apps/api/internal/platform/errors`，避免与标准库 `errors` 混淆。
- 所有可导出类型与接口必须有 GoDoc。

---

# 里程碑 M0：骨架与数据层（本机可完整验收）

> **门禁：** `go build ./...`、`go vet ./...`、`go test ./...` 全绿；SQLite 空库可建表；`/healthz` 与 `/readyz` 行为符合设计。

### Task 1: 工程骨架、配置、日志、健康检查

**Files:**
- Create: `go.mod`
- Create: `.gitignore`
- Create: `apps/api/cmd/server/main.go`
- Create: `apps/api/internal/platform/config/config.go`
- Create: `apps/api/internal/platform/config/config_test.go`
- Create: `apps/api/internal/platform/logging/logger.go`
- Create: `apps/api/internal/transport/http/gin/router.go`
- Create: `apps/api/internal/transport/http/gin/router_test.go`
- Create: `apps/api/internal/transport/http/gin/dependencies.go`
- Create: `scripts/env.ps1`
- Create: `scripts/test.ps1`
- Create: `Makefile`

**Interfaces:**
- `config.Load() (config.Config, error)`
- `config.Config` 字段：`AppEnv string`、`HTTPAddr string`、`DatabaseDriver string`、`DatabaseDSN string`、`SecurityGRPCAddr string`
- `logging.New(cfg config.Config) *slog.Logger`
- `ginrouter.New(deps ginrouter.Dependencies) *gin.Engine`
- `ginrouter.Dependencies` 字段：`Config config.Config`、`Logger *slog.Logger`、`Readiness func(context.Context) error`

- [ ] **Step 1: 初始化仓库与模块**

```powershell
git init
& 'C:\Program Files\Go\bin\go.exe' mod init github.com/practacu/practacu-press
```

`.gitignore` 内容：

```gitignore
*.exe
*.db
*.db-shm
*.db-wal
/data/
/backups/
node_modules/
.DS_Store
```

- [ ] **Step 2: 写配置的失败测试**

```go
func TestLoadRequiresEnv(t *testing.T) {
	t.Setenv("APP_ENV", "")
	_, err := Load()
	require.Error(t, err)
	require.Contains(t, err.Error(), "APP_ENV")
}

func TestLoadRejectsUnknownDriver(t *testing.T) {
	setValidEnv(t)
	t.Setenv("DATABASE_DRIVER", "oracle")
	_, err := Load()
	require.Error(t, err)
	var cfgErr *Error
	require.ErrorAs(t, err, &cfgErr)
	require.Equal(t, "invalid_database_driver", cfgErr.Code)
}

func TestLoadDefaults(t *testing.T) {
	setValidEnv(t)
	cfg, err := Load()
	require.NoError(t, err)
	require.Equal(t, "127.0.0.1:8080", cfg.HTTPAddr)
	require.Equal(t, "development", cfg.AppEnv)
}
```

- [ ] **Step 3: 运行测试确认失败**

Run: `go test ./apps/api/internal/platform/config -run TestLoad -v`
Expected: FAIL —— `Load`/`Error` 未定义。

- [ ] **Step 4: 实现配置加载**

`Error` 为带 `Code` 的可判定错误：

```go
// Error is a typed configuration error. Code is stable and safe to expose.
type Error struct {
	Code   string
	Detail string
}

func (e *Error) Error() string { return e.Code + ": " + e.Detail }
```

`Load` 读取并校验，规则：`APP_ENV` 必填且属于 `development|test|production`；`HTTP_ADDR` 缺省 `127.0.0.1:8080`；`DATABASE_DRIVER` 必填且归一化后属于 `sqlite|mysql|postgres`（别名 `postgresql`→`postgres`）；`DATABASE_DSN` 必填；`SECURITY_GRPC_ADDR` 必填。

- [ ] **Step 5: 实现日志与路由骨架**

日志用 `slog.NewJSONHandler`，`production` 级别 `Info`，其他 `Debug`，并默认注入 `app_env`。

路由：

```go
func New(deps Dependencies) *gin.Engine {
	if deps.Config.AppEnv == "production" {
		gin.SetMode(gin.ReleaseMode)
	}
	r := gin.New()
	r.Use(gin.Recovery())
	r.GET("/healthz", healthz)
	r.GET("/readyz", readyz(deps.Readiness))
	v1 := r.Group("/api/v1")
	{
		v1.GET("/openapi.json", openAPIPlaceholder)
	}
	return r
}
```

`/healthz` 恒返回 `200 {"status":"ok"}`（只反映进程存活）；`/readyz` 调用 `deps.Readiness`，为 nil 或返回 nil 时 `200 {"status":"ready"}`，否则 `503 {"status":"unready"}`。

- [ ] **Step 6: 写路由测试**

```go
func TestRouterHealthz(t *testing.T) {
	r := New(Dependencies{Config: config.Config{AppEnv: "test"}})
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	require.Equal(t, http.StatusOK, w.Code)
	require.JSONEq(t, `{"status":"ok"}`, w.Body.String())
}

func TestRouterReadyzUnready(t *testing.T) {
	r := New(Dependencies{
		Config:    config.Config{AppEnv: "test"},
		Readiness: func(context.Context) error { return errors.New("db down") },
	})
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	require.Equal(t, http.StatusServiceUnavailable, w.Code)
}
```

- [ ] **Step 7: 实现 main 的启动与优雅关闭**

`main.go`：加载配置 → 建 logger → 打开 DB（Task 3 提供，本步先留 `readiness` 闭包返回 nil）→ 建 router → `http.Server` 带 `ReadHeaderTimeout` → 监听 `SIGINT/SIGTERM` → `Shutdown(ctx)` 带 10 秒超时。**Handler 不得持有全局状态。**

- [ ] **Step 8: 运行测试并提交**

Run: `go test ./apps/api/internal/platform/config ./apps/api/internal/transport/http/gin -v`
Expected: PASS。

```powershell
git add go.mod .gitignore apps/api scripts Makefile
git commit -m "test: add router health and config loading tests"
git commit --allow-empty -m "chore: scaffold gin api skeleton"
```

---

### Task 2: 统一错误模型（problem+json）

**Files:**
- Create: `apps/api/internal/platform/errors/problem.go`
- Create: `apps/api/internal/platform/errors/codes.go`
- Create: `apps/api/internal/platform/errors/problem_test.go`

**Interfaces:**
- `apperr.Problem` 实现 `error`；`JSON` 序列化为设计稿 §7.2 的结构。
- `apperr.New(code Code, opts ...Option) *Problem`
- 预置构造器：`apperr.Validation(detail string)`、`apperr.Unauthenticated()`、`apperr.PermissionDenied()`、`apperr.NotFound(resource string)`、`apperr.Conflict(code Code)`、`apperr.RateLimited()`、`apperr.Internal(err error)`。
- `apperr.FromError(err error) *Problem` 把任意 error 归一为 Problem（未知错误→`internal`，不泄露原始信息）。

- [ ] **Step 1: 写失败测试**

```go
func TestProblemJSONShape(t *testing.T) {
	p := PermissionDenied()
	p.RequestID = "req_01"
	b, err := json.Marshal(p)
	require.NoError(t, err)
	require.JSONEq(t, `{
		"type":"https://docs.practacu.press/errors/permission_denied",
		"title":"Permission denied",
		"status":403,
		"code":"permission_denied",
		"message":"当前用户没有执行此操作的权限",
		"details":{},
		"request_id":"req_01"
	}`, string(b))
}

func TestFromErrorHidesInternalDetail(t *testing.T) {
	p := FromError(errors.New("pq: relation \"x\" does not exist"))
	require.Equal(t, 500, p.Status)
	require.Equal(t, "internal", string(p.Code))
	require.NotContains(t, p.Message, "relation")
}
```

- [ ] **Step 2: 运行确认失败** — Run: `go test ./apps/api/internal/platform/errors -v`；Expected: FAIL。

- [ ] **Step 3: 实现 Problem 与错误码表**

错误码为字符串常量，覆盖：`validation_failed`、`unauthenticated`、`permission_denied`、`not_found`、`conflict`、`rate_limited`、`internal`、`invalid_cursor`、`idempotency_key_reuse`、`site_not_found`、`site_domain_unverified`、`content_state_invalid`、`security_unavailable`、`provider_not_configured`、`invalid_database_driver`。

每个 code 映射到固定 `status`、`title`、默认 `message`（中文，面向前端用户）。`Internal` 只记录日志，响应体不含原始错误。

- [ ] **Step 4: 运行测试** — Expected: PASS。

- [ ] **Step 5: 提交** — `git add apps/api/internal/platform/errors; git commit -m "feat: add problem+json error model"`

---

### Task 3: 三方言数据层与 Ent schema

**Files:**
- Create: `apps/api/internal/infrastructure/db/driver.go`
- Create: `apps/api/internal/infrastructure/db/client.go`
- Create: `apps/api/internal/infrastructure/db/driver_test.go`
- Create: `apps/api/internal/infrastructure/db/client_test.go`
- Create: `apps/api/ent/generate.go`
- Create: `apps/api/ent/schema/mixin.go`
- Create: `apps/api/ent/schema/*.go`（见 Step 4 清单）
- Create: `apps/api/cmd/migrate/main.go`
- Create: `migrations/{sqlite,mysql,postgres}/README.md`

**Interfaces:**
- `db.NormalizeDriver(name string) (string, bool)`
- `db.IsSupportedDriver(name string) bool`
- `db.Open(ctx context.Context, driverName, dsn string) (*db.DB, error)`
- `db.DialectOf(driverName string) (string, bool)`
- `db.SQLiteDSN(path string) string`
- `(*db.DB).Client`、`.Ping(ctx)`、`.Close()`、`.Driver()`、`.Dialect()`

- [ ] **Step 1: 写驱动注册表测试**

```go
func TestSupportedDrivers(t *testing.T) {
	for _, name := range []string{"sqlite", "mysql", "postgres", "postgresql", "PostgreSQL", " sqlite "} {
		require.True(t, IsSupportedDriver(name), name)
	}
	for _, name := range []string{"oracle", "sqlserver", ""} {
		require.False(t, IsSupportedDriver(name), name)
	}
}

func TestNormalizeDriver(t *testing.T) {
	got, ok := NormalizeDriver(" PostgreSQL ")
	require.True(t, ok)
	require.Equal(t, "postgres", got)
}
```

- [ ] **Step 2: 运行确认失败** — Expected: FAIL（未定义）。

- [ ] **Step 3: 实现驱动选择与连接**

```go
// Open builds an Ent client for the named driver. The returned closer releases
// the underlying *sql.DB and must be called on shutdown.
func Open(ctx context.Context, driverName, dsn string) (*ent.Client, func() error, error) {
	name, ok := NormalizeDriver(driverName)
	if !ok {
		return nil, nil, &configDriverError{driver: driverName}
	}
	// database/sql 驱动名 → Ent 方言
	sqlDriver, dialectName := "sqlite", dialect.SQLite
	switch name {
	case "mysql":
		sqlDriver, dialectName = "mysql", dialect.MySQL
	case "postgres":
		sqlDriver, dialectName = "pgx", dialect.Postgres
	}
	sqlDB, err := sql.Open(sqlDriver, dsn)
	if err != nil {
		return nil, nil, err
	}
	// SQLite 单写者：限制连接数避免 database is locked
	if name == "sqlite" {
		sqlDB.SetMaxOpenConns(1)
	}
	if err := sqlDB.PingContext(ctx); err != nil {
		sqlDB.Close()
		return nil, nil, err
	}
	drv := entsql.OpenDB(dialectName, sqlDB)
	client := ent.NewClient(ent.Driver(drv))
	return client, sqlDB.Close, nil
}
```

**关键约束（评审 P0-3）：** 不能使用 `ent.Open(dialect.SQLite, ...)`，因为 Ent 的默认 SQLite 通路依赖 `mattn/go-sqlite3`（需 CGO，本机 `CGO_ENABLED=0`）。必须显式 `database/sql` + `entsql.OpenDB`，并 side-effect 导入：

```go
_ "github.com/go-sql-driver/mysql"
_ "github.com/jackc/pgx/v5/stdlib"
_ "modernc.org/sqlite"
```

- [ ] **Step 4: 定义 Ent schema（含全部 P0 修订）**

共享 mixin（`apps/api/ent/schema/mixin.go`）：

```go
// Base gives every entity a UUIDv7 primary key and UTC audit timestamps.
type Base struct{}

func (Base) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").Match(uuidV7Regex).Immutable().Unique().DefaultFunc(newUUIDv7),
		field.Time("created_at").Immutable().Default(time.Now).Annotations(...),
		field.Time("updated_at").Default(time.Now).UpdateDefault(time.Now),
	}
}

// SiteScoped adds the mandatory site_id scope and its index.
type SiteScoped struct{}

func (SiteScoped) Fields() []ent.Field {
	return []ent.Field{field.String("site_id").NotEmpty().Immutable()}
}

func (SiteScoped) Indexes() []ent.Index { return []ent.Index{index.Fields("site_id")} }
```

实体清单（相对原计划的增补用 **粗体** 标注）：

| 文件 | 实体 | 关键点 |
| --- | --- | --- |
| `user.go` | User | `status`、`display_name`、可空 `bio`/`avatar_media_id` |
| `user_identity.go` | UserIdentity | `provider`+`provider_subject` 唯一；`verified_at` 可空 |
| `session.go` | **Session** | `token_hash` 唯一、`family_id` 索引、`rotated_at`/`revoked_at`/`revoked_reason`、`expires_at`；**P0-1** |
| `verification_token.go` | **VerificationToken** | `kind`、`token_hash` 唯一、`expires_at`、`consumed_at`；**P1-2** |
| `site.go` | Site | `slug` 唯一、`domain` 唯一可空、`visibility_mode`、`publish_mode`、**`domain_verified_at`**、**`domain_verification_token`** |
| `site_member.go` | SiteMember | `(site_id,user_id)` 唯一；`role`、`status` |
| `category.go` | **Category** | `(site_id,slug)` 唯一 |
| `tag.go` | **Tag** | `(site_id,slug)` 唯一 |
| `article.go` | Article | `(site_id,slug)` 唯一、`status`、`summary`、`category_id` 可空 |
| `post.go` | Post | `(site_id,slug)` 唯一可空、`status`、`body` |
| `content_revision.go` | ContentRevision | 多态 `content_type`+`content_id`、`source_format`、`source_body`、`rendered_html`、`policy_version`、`violations` JSON |
| `content_tag.go` | **ContentTag** | `(content_type,content_id,tag_id)` 唯一；**P1-1** |
| `comment.go` | Comment | 多态目标、`parent_id` 可空、`depth`、`status` |
| `reaction.go` | Reaction | `(user_id,target_type,target_id,kind)` 唯一 |
| `bookmark.go` | Bookmark | `(user_id,target_type,target_id)` 唯一 |
| `follow.go` | Follow | `(site_id,follower_id,followee_id)` 唯一 |
| `conversation.go` | Conversation | `site_id`、`kind` |
| `conversation_member.go` | ConversationMember | `(conversation_id,user_id)` 唯一、`last_read_message_id` 可空 |
| `message.go` | Message | `conversation_id`、`sender_id`、`body`、`created_at` 索引 |
| `notification.go` | Notification | `(site_id,user_id)` 索引、`type`、`read_at` 可空、`payload` JSON |
| `media_asset.go` | MediaAsset | `storage_key` 唯一、`mime_type`、`size`、`scan_status` |
| `media_upload.go` | **MediaUpload** | 两阶段上传会话；`status`、`expires_at`；**P0-5** |
| `moderation_report.go` | ModerationReport | 多态目标、`reason`、`status`、`assignee_id` 可空 |
| `audit_log.go` | AuditLog | `actor_id`、`action`、多态目标、`request_id`、`detail` JSON |
| `outbox_event.go` | OutboxEvent | `event_id`(UUIDv7) 唯一、`event_type`、`aggregate_id`、**`audience_user_id`**、`payload`、`published_at`、`attempts`、**`next_attempt_at`**、`claimed_at`；**P0-2** |
| `idempotency_key.go` | **IdempotencyKey** | `(user_id,route,key)` 唯一、`request_hash`、`status_code`、`response_body`、`expires_at`；**P0-4** |
| `ws_ticket.go` | **WSTicket** | `ticket_hash` 唯一、`expires_at`、`consumed_at`；**P1-3** |

所有 JSON 字段用 `field.JSON(...)`（三方言均可映射到 text/JSON 列，且**不做查询**）；需要查询的字段一律拆普通列。所有可空列用 `field.String(...).Optional().Nillable()` 或 `field.Time(...).Optional().Nillable()`。

- [ ] **Step 5: 生成 Ent 代码**

```powershell
go mod tidy
go generate ./apps/api/ent/...
```

Expected: `apps/api/ent/` 下出现 `client.go`、`ent.go`、`migrate/`、各实体包与 `schema/` 保持原样，无报错。
**若报 `missing go.sum entry for ariga.io/atlas`：** 先执行 `go get entgo.io/ent/dialect/sql/schema` 再重试（评审 E11）。

- [ ] **Step 6: 实现迁移命令**

`apps/api/cmd/migrate/main.go`：读取 `DATABASE_DRIVER`/`DATABASE_DSN`（允许 `-driver`/`-dsn` 覆盖），执行：

```go
if err := client.Schema.Create(ctx,
	migrate.WithDropColumn(false),
	migrate.WithDropIndex(false),
); err != nil {
	log.Fatalf("migrate: %v", err)
}
```

设计选择（评审 P1-11）：**开发与首版用 Ent 的 additive schema 同步**；`WithDropColumn(false)`/`WithDropIndex(false)` 保证不会静默删数据。`migrations/*/README.md` 说明生产环境改为"发布前由 CI 用 Atlas 生成 SQL、人工审阅后执行"，并留出目录。

- [ ] **Step 7: 写 SQLite 端到端建表测试**

```go
func TestOpenSQLiteAndCreateSchema(t *testing.T) {
	dsn := "file:" + filepath.Join(t.TempDir(), "test.db") +
		"?_pragma=foreign_keys(1)&_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)"
	client, closeFn, err := Open(context.Background(), "sqlite", dsn)
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, closeFn()) })

	require.NoError(t, client.Schema.Create(context.Background(),
		migrate.WithDropColumn(false), migrate.WithDropIndex(false)))

	// 建表后必须能写入并读回
	u, err := client.User.Create().SetDisplayName("alice").Save(context.Background())
	require.NoError(t, err)
	require.NotEmpty(t, u.ID)
}
```

- [ ] **Step 8: 运行数据层测试并提交**

Run: `go test ./apps/api/internal/infrastructure/db -v`
Expected: PASS（含建表与 CRUD 往返）。

```powershell
git add apps/api/ent apps/api/internal/infrastructure/db apps/api/cmd/migrate migrations go.mod go.sum
git commit -m "test: assert sqlite schema creation round trip"
git commit --allow-empty -m "feat: add dialect-neutral persistence model"
```

---

### Task 4: 中间件（请求 ID、错误、站点解析、CORS、限流、幂等）

**Files:**
- Create: `apps/api/internal/transport/http/gin/middleware/request_id.go`
- Create: `apps/api/internal/transport/http/gin/middleware/error.go`
- Create: `apps/api/internal/transport/http/gin/middleware/site.go`
- Create: `apps/api/internal/transport/http/gin/middleware/cors.go`
- Create: `apps/api/internal/transport/http/gin/middleware/rate_limit.go`
- Create: `apps/api/internal/transport/http/gin/middleware/idempotency.go`
- Create: `apps/api/internal/transport/http/gin/middleware/middleware_test.go`

**Interfaces:**
- `middleware.RequestID() gin.HandlerFunc` —— 复用入站 `X-Request-ID`（校验格式），否则生成 UUIDv7；写回响应头与 `apperr.Problem.RequestID`。
- `middleware.ErrorHandler(logger *slog.Logger) gin.HandlerFunc` —— `c.Next()` 后取 `c.Errors`，`apperr.FromError` 落 `problem+json`。
- `middleware.SiteResolver(resolver SiteResolver) gin.HandlerFunc` —— Host（或可信 `X-Forwarded-Host`）→ `site.Site`，存 context。
- `middleware.CORS(cfg CORSConfig) gin.HandlerFunc`
- `middleware.RateLimit(store RateLimitStore, policy Policy) gin.HandlerFunc`
- `middleware.Idempotency(store IdempotencyStore) gin.HandlerFunc`

- [ ] **Step 1: 写测试**

覆盖：每个响应都有 `X-Request-ID`；handler `c.Error(apperr.PermissionDenied())` → 403 且 `Content-Type: application/problem+json` 且 body 的 `code=permission_denied`；未知 Host → 404 `site_not_found`；非白名单 Origin 的预检被拒；第 N+1 次请求在窗口内 → 429 且带 `Retry-After`；同 key 重复写 → 第二次返回首次响应且 handler 只执行一次。

- [ ] **Step 2: 运行确认失败** — Expected: FAIL。

- [ ] **Step 3: 实现请求 ID 与错误中间件**

错误中间件写在链的最后注册位置（Gin 中 `Use` 顺序即执行顺序，`c.Next()` 之后处理），确保覆盖所有下游错误。**不得把 panic 堆栈或 DB 错误写进响应体**；`internal` 错误只写日志，响应体固定文案。

- [ ] **Step 4: 实现站点解析**

解析顺序：可信代理解析出的 Host → `X-Site-ID`（仅管理端）→ 失败。可信代理判定：直连 `RemoteAddr` 的 IP 在 `TRUSTED_PROXIES` 内时才读 `X-Forwarded-Host`（评审 P1-5）。单站点模式下库中无站点时经 `resolver.DefaultSite()` 惰性创建；未知 Host 一律 `site_not_found`（评审 P1-13）。

- [ ] **Step 5: 实现 CORS、限流、幂等**

CORS：仅白名单 Origin，`AllowCredentials` 在配置允许时开启，暴露 `X-Request-ID`。
限流：令牌桶或固定窗口，键为 `IP` 或 `user_id`，按路由分组配置；超限写 `rate_limited` 并设 `Retry-After`。
幂等：仅作用于写方法，键取 `Idempotency-Key` 头；缺省时跳过（不强制）；命中且 `request_hash` 相同则回放，不同则 409。

- [ ] **Step 6: 运行测试并提交**

Run: `go test ./apps/api/internal/transport/http/gin/middleware -v`
Expected: PASS。

```powershell
git add apps/api/internal/transport/http/gin/middleware
git commit -m "feat: add request id, problem errors, site resolution, cors, rate limit, idempotency"
```

---

# 里程碑 M1：身份、会话、站点与权限（本机可完整验收）

> **门禁：** 注册→登录→刷新→重放检测→登出 全链路集成测试通过；普通用户改角色返回 403，站内管理员改本角色成功，跨站管理员返回 403。

### Task 5: 身份与会话

**Files:**
- Create: `apps/api/internal/auth/domain.go`、`service.go`、`repository.go`、`handler.go`、`tokens.go`
- Create: `apps/api/internal/auth/service_test.go`、`tokens_test.go`
- Create: `apps/api/internal/infrastructure/auth`（Ent 仓储实现）

**Interfaces:**
- `AuthService.RegisterEmail(ctx, siteID string, in RegisterEmailInput) (auth.UserView, error)`
- `AuthService.LoginPassword(ctx, siteID string, in LoginInput) (auth.Session, error)`
- `AuthService.Refresh(ctx, refreshToken, csrfToken string) (auth.Session, error)`
- `AuthService.Logout(ctx, refreshToken string) error`
- `TokenIssuer.IssueAccess(userID, siteID string) (string, time.Time, error)`（Ed25519，15 分钟，带 `kid`）
- `RefreshTokenIssuer.New() (plain string, hash string)`；`HashRefresh(plain string) string`

- [ ] **Step 1: 写测试** —— 覆盖：重复邮箱返回 `conflict`；未验证邮箱登录返回 `unauthenticated`；refresh 成功后旧 token 失效；**旧 token 二次使用 → 整族吊销且返回 `unauthenticated`**；CSRF 不匹配返回 `permission_denied`；密码错误与用户不存在返回**同一条**错误消息（不可枚举）。
- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现密码哈希与 JWT**

密码哈希经 `SecurityClient.HashPassword`（Task 8 的接口 + Stub 时返回 `security_unavailable`，因此测试里注入 `fakeHasher`）。JWT：

```go
func (i *ed25519Issuer) IssueAccess(userID, siteID string) (string, time.Time, error) {
	now := time.Now().UTC()
	exp := now.Add(15 * time.Minute)
	claims := jwt.MapClaims{
		"sub": userID, "sid": siteID, "iss": i.issuer,
		"iat": now.Unix(), "exp": exp.Unix(), "jti": uuid.Must(uuid.NewV7()).String(),
	}
	tok := jwt.NewWithClaims(jwt.SigningMethodEdDSA, claims)
	tok.Header["kid"] = i.kid
	s, err := tok.SignedString(i.key)
	return s, exp, err
}
```

解析端**必须**校验 `alg == EdDSA`、`kid` 存在且匹配、`exp`/`iat` 合理，禁止接受 `none`。

- [ ] **Step 4: 实现会话轮换与重放检测** —— 见评审 P0-1 的判定逻辑；轮换在**一个事务内**完成：写新会话 → 旧会话置 `rotated_at`。重放（`rotated_at != nil` 且再次使用）→ 吊销 `family_id` 全部。
- [ ] **Step 5: 实现 Cookie 与 CSRF** —— refresh cookie：`HttpOnly`、`Path=/api/v1/auth`、`SameSite=Lax`（开发）/`None`（生产，需 `Secure`）、`Secure` 仅生产。CSRF：双提交，`csrf` cookie（非 HttpOnly）+ `X-CSRF-Token` 头，常量时间比较。
- [ ] **Step 6: 实现路由并写集成测试** —— `POST /auth/register/email`、`POST /auth/login/password`、`POST /auth/token/refresh`、`POST /auth/logout`、`GET /me`。
- [ ] **Step 7: 运行测试并提交** —— `go test ./apps/api/internal/auth -v`。

### Task 6: 站点、成员与角色

**Interfaces:**
- `SiteService.Resolve(ctx, host string) (site.Site, error)`
- `SiteService.DefaultSite(ctx) (site.Site, error)`
- `SiteService.ListMembers(ctx, actor, siteID, cursor) (Page[MemberView], error)`
- `SiteService.ChangeMemberRole(ctx, actor, siteID, userID string, role site.Role) error`
- `SiteService.UpdateSettings(ctx, actor, siteID string, in SettingsInput) error`

- [ ] **Step 1: 写测试** —— 四级角色的权限矩阵表驱动测试；普通用户改角色 403；站点管理员只能改本站且不能改平台管理员；跨站 403。
- [ ] **Step 2–5:** 实现角色常量与 `Can(actor, action, resource)` 判定、成员查询、角色变更（同事务写审计）、站点设置（`visibility_mode`/`publish_mode` 变更即时生效）。
- [ ] **Step 6:** `go test ./apps/api/internal/site -v` 并提交。

---

# 里程碑 M2：内容、媒体、审核、社区、搜索

> **门禁：** 内容状态机全路径测试通过；越权编辑被拒；安全检查不可用时内容停留 `pending_security_check` 且不可发布；站点隔离测试通过。

### Task 7: 内容与状态机

**Interfaces:**
- `ContentService.CreateDraft(ctx, principal, in ContentInput) (ContentView, error)`
- `ContentService.UpdateDraft(ctx, principal, contentID string, in ContentInput) (ContentView, error)`
- `ContentService.Submit(ctx, principal, contentID string) error`
- `ContentService.Publish(ctx, principal, contentID, reason string) error`
- `ContentService.Archive(ctx, principal, contentID, reason string) error`
- `ContentService.Get(ctx, principal, contentID string) (ContentView, error)`
- `ContentService.List(ctx, principal, filter, cursor) (Page[ContentView], error)`

- [ ] **Step 1:** 写状态机测试（`draft→published` 直发、`draft→pending_review→published`、`pending_review→rejected→draft`、`published→archived`、非法转移、越权编辑、跨站读取）。
- [ ] **Step 2:** 实现状态机为显式转移表 `Transitions map[Status][]Status` + `Guard(actor, from, to)`，**禁止在 handler 里判断状态**。
- [ ] **Step 3:** 实现 revision 写入（每次写都调 `SecurityClient.SanitizeContent`，存 `rendered_html` + `policy_version` + `violations`；评审 P1-6）。
- [ ] **Step 4:** 发布时校验 revision 的 `policy_version` 仍被当前策略接受；`SecurityClient` 返回 `security_unavailable` → 转 `pending_security_check` 并返回可重试错误。
- [ ] **Step 5:** 路由 `/articles`、`/posts` + 集成测试。
- [ ] **Step 6:** 提交。

### Task 8: SecurityClient 接口与 Stub（fail-closed）

**Files:** `apps/api/internal/infrastructure/securityclient/client.go`、`stub.go`、`client_test.go`

**Interfaces:**
- `type Client interface { HashPassword(ctx, string) (string, error); VerifyPassword(ctx, string, string) (bool, error); SanitizeContent(ctx, ContentInput) (Sanitized, error); InspectUpload(ctx, UploadInput) (ScanResult, error); Ping(ctx) error }`
- `securityclient.ErrUnavailable`（哨兵错误，`errors.Is` 可判）

- [ ] **Step 1:** 写测试：Stub 的所有方法返回 `ErrUnavailable`；调用方在该错误下**不产生 published/clean 状态**。
- [ ] **Step 2:** 实现 Stub + 真实 gRPC 客户端骨架（连接、超时、熔断留到安全计划 Task 5 补齐）。
- [ ] **Step 3:** 提交。

### Task 9: 媒体与两阶段上传

**Interfaces:** `MediaService.CreateUpload`、`MediaService.CompleteUpload`、`MediaStorage.Put/Get/Delete`；`LocalStorage` 与 `S3Storage`（首版只做 Local，S3 留接口）。

- [ ] 测试：超限大小、声明 MIME 与实际不符、路径穿越文件名、扫描未 clean 不可被引用、上传会话过期。实现：`storage_key` 由 UUIDv7 生成，**永不用用户文件名**。提交。

### Task 10: 审核队列

- [ ] 实现 approve/reject/archive/restore、举报创建与分派、审计写入；测试覆盖状态与权限。提交。

### Task 11: 社区互动

- [ ] 实现评论/回复（站点范围、可见性、最大嵌套深度、状态）、点赞/收藏/关注（唯一约束、幂等 toggle、仅状态变化时写 outbox）；测试覆盖重复请求只产生一个最终状态。提交。

### Task 12: 搜索

- [ ] `SearchService.Search(ctx, siteID, query, kind, cursor)`：`LIKE '%q%'` 于 `title`/`summary`/`body`，仅返回当前站点且 `status=published` 的内容；测试覆盖跨站不可见、空查询、超长查询截断。**显式不做 FTS**（三方言语义不一致）。提交。

---

# 里程碑 M3：消息、通知、Outbox、WebSocket

> **门禁：** 跨用户事件不可见；重复投递幂等；断线补偿按 UUIDv7 正确续传；非成员无法读取会话。

### Task 13: 会话、消息、通知

- [ ] `MessagingService.Send/List/MarkRead`：先落库再写 outbox；只允许成员访问；`last_read_message_id` 单调前进；测试覆盖非成员 403、站点隔离、消息顺序、游标分页。提交。

### Task 14: Outbox、WebSocket、事件补偿

- [ ] Outbox worker：claim（`claimed_at` + `next_attempt_at`）→ 处理 → 成功置 `published_at`，失败 `attempts++` 指数退避；handler 幂等。
- [ ] WS：`POST /auth/ws-ticket` 发一次性票据（哈希存储，单次消费，60 秒有效）；`GET /api/v1/ws?ticket=` 升级；按 `principal + site` 订阅；事件信封 `{id,type,occurred_at,site_id,payload}`。
- [ ] `GET /api/v1/events?after_id=&limit=100`：查询条件 `site_id = ? AND (audience_user_id IS NULL OR audience_user_id = ?) AND event_id > ?`（评审 P0-2）。
- [ ] 测试：跨用户事件不可见、重复 outbox 投递幂等、票据复用被拒、重连补偿不丢不重。提交。

---

# 里程碑 M4：契约与部署（部分不可本机验收）

- OpenAPI 3.1 骨架在 **M0 就落地**（Task 8 的契约校验需要输入），随 M1–M3 补全。
- Docker Compose 三 profile、Windows 安装包、备份/恢复：**只交付文件**，在 `docs/release-checklist.md` 中逐项标注"本机未验收 / CI 验收"，不得声称已验证（见评审 §2.2 E6/E9/E10）。

---

## 验收口径（避免"写了代码就当完成"）

| 声明 | 需要的证据 |
| --- | --- |
| 编译通过 | `go build ./...` 退出码 0 |
| 静态检查通过 | `go vet ./...` 退出码 0 |
| 测试通过 | `go test ./...` 全绿，且失败测试先红后绿 |
| SQLite 可用 | 空库建表 + CRUD 往返测试通过 |
| MySQL/PostgreSQL 可用 | **仅 CI**；本机只保证代码无方言依赖 |
| 安全 fail-closed | Stub 注入下内容不可发布、媒体不可引用 |
| 站点隔离 | 两站点两用户交叉访问测试全绿 |

---

## 实施偏差记录（M0 完成后补记）

计划在执行中做了 4 处有意的偏差，均已在代码注释中说明理由：

1. **`db.Open` 返回 `*db.DB` 而不是 `(*ent.Client, func() error, error)`。**
   原签名只给出 `Closer`，无法为 `/readyz` 提供 `Ping`。`DB` 结构体持有 `*ent.Client`、`*sql.DB` 与规范化后的驱动名，同时提供 `Ping`/`Close`/`Driver`/`Dialect`。`/readyz` 因此能真实反映数据库连通性，而不是恒为 ready。

2. **Ent 的 `Mixin` 换成字段辅助函数。**
   `ent.Mixin` 要求实现 7 个方法，为两个仅提供字段的 mixin 写这套样板不划算。改为 `idField()`/`createdField()`/`updatedField()`/`siteIDField()` 四个辅助函数，同样 DRY 且无接口风险。

3. **M0 只落 9 个实体，不是全部 27 个。**
   落地的是身份与站点核心：`user`、`user_identity`、`session`、`verification_token`、`site`、`site_member`、`audit_log`、`outbox_event`、`idempotency_key`。
   内容、社区、消息、媒体的实体随各自里程碑一起建模——在状态机和用例写出来之前先猜 18 张表的字段，属于投机建模，YAGNI。

4. **外键用普通索引列，不用 Ent edge。**
   本模型的多数关系是多态的（评论/反应/收藏目标、内容版本），没有任何单一方言的外键能表达。统一成"列 + 索引 + 应用层事务内校验"，规则一致且三方言行为相同。需要时补 edge 是机械改动。

另外两点环境事实（已写入 `scripts/test.ps1`）：

- `scripts/env.ps1` 是未签名脚本，直接 dot-source 会被执行策略拒绝；验证入口改用 `scripts/test.ps1`（自带工具链与代理设置，无需 dot-source）。
- 32 位 `go` 也能编译通过，但仓库统一以 `C:\Program Files\Go\bin\go.exe`（amd64）为准，避免与部署目标不一致。
