# Practacu Press 计划评审与可行性评估

**评审日期：** 2026-10-18
**评审对象：** `docs/superpowers/specs/2026-10-18-practacu-press-design.md` 及三份实施计划
**评审方法：** 逐条比对设计稿与计划的覆盖关系；对本机工具链做真实编译验证（spike）；对每项约束检查其在 SQLite/MySQL/PostgreSQL 三方言下的可落地性。

---

## 1. 结论速览

| 计划 | 结论 | 说明 |
| --- | --- | --- |
| 设计稿 v0.1 | 🟢 通过 | 模块边界、状态机、三方言约束、安全管线方向都正确；缺 6 张关键表（见 §4） |
| 后端核心计划（Go） | 🟡 修订后通过 | 技术栈本机已实测可编译可运行；有 9 项 P0 必须修订后才能开工 |
| 安全服务计划（Rust） | 🟡 有条件通过 | 本机缺少可用的链接器（无 mingw gcc、未装 msvc toolchain）与 `protoc`，需先补环境 |
| 契约与部署计划 | 🟡 部分不可本地验证 | 本机无 Docker、无 MySQL/PostgreSQL、无 WiX、无 `make`，只能交付文件不能验收 |

**总体判断：** 架构选型（Gin 模块化单体 + Rust 安全服务 + OpenAPI 3.1 契约 + Ent/Atlas + 三方言）是合理的，没有需要推翻的设计。**真正的风险不在架构，而在计划与设计稿之间的缺口**——按现计划直接开工，会在 Task 4（会话）和 Task 7（事件补偿）撞上硬性返工。

**开工建议顺序：** 先补 P0 修订（本文件 §8），再按 §9 的顺序执行 Phase 0 → Phase 1。

---

## 2. 环境基线（实测，非推测）

以下为在本机实际执行得到的证据，是"可行度"判断的依据。

### 2.1 已验证可用 ✅

| 项目 | 实测结果 |
| --- | --- |
| Go | `go1.26.0 windows/amd64`（`C:\Program Files\Go`） |
| 依赖拉取 | `gin v1.12.0`、`ent v0.14.6`、`modernc.org/sqlite v1.60.1`、`golang-jwt/v5 v5.3.1`、`coder/websocket v1.8.15`、`gin-contrib/cors v1.7.9`、`testify v1.12.1` 全部 `go get` 成功 |
| 编译 | `go build` 通过（amd64）；`go vet` 通过 |
| SQLite 运行时 | `modernc.org/sqlite` 打开内存库、`PingContext` 成功，Gin 路由可用 |
| 网络 | `proxy.golang.org`、`index.crates.io` 可达（经 `127.0.0.1:7890` 代理） |
| Rust | `cargo 1.99.0` / `rustc 1.99.0` |
| MSVC | Visual Studio 2022 已安装 |

### 2.2 环境缺陷 ⚠️（影响可行性，必须先处理）

| 编号 | 事实 | 影响 | 处理 |
| --- | --- | --- | --- |
| E1 | PATH 上的 `go` 是 **32 位**（`C:\Program Files (x86)\Go`，`windows/386`） | 地址空间受限；与 CI 不一致 | 一律用 `C:\Program Files\Go\bin\go.exe`（可通过 `GOROOT`/PATH 前置固定） |
| E2 | Go 不读 WinINET 代理，`go get` 直连超时；但 `Invoke-WebRequest` 走系统代理正常 | 所有 `go`/`cargo` 命令会失败 | 每条命令前置 `$env:HTTP_PROXY='http://127.0.0.1:7890'; $env:HTTPS_PROXY='http://127.0.0.1:7890'; $env:NO_PROXY='localhost,127.0.0.1'` |
| E3 | `CGO_ENABLED=0` 且无 `gcc` | Ent 默认的 `mattn/go-sqlite3` **无法编译** | 强制使用 `modernc.org/sqlite` + `entsql.OpenDB(dialect.SQLite, db)` |
| E4 | 工作目录**不是 git 仓库** | 计划里所有 `git commit` 步骤会失败 | 先 `git init` + 首次提交 |
| E5 | 无 `make` | 计划 Task 1 的 `Makefile` 在本机不可用 | 以 `scripts/*.ps1` 为主入口，`Makefile` 仅供 Linux CI |
| E6 | 无 Docker、无 MySQL/PostgreSQL 服务、3306/5432 未监听 | 三方言矩阵**无法本地验收**，只能靠 CI | 本阶段仅保证 SQLite 全绿 + 方言无关代码审查；MySQL/PG 作为 CI 门禁 |
| E7 | 外壳是 Windows PowerShell 5.1（无 `pwsh`） | 计划中的 `pwsh -File ...` 命令会失败 | 脚本用 `& script.ps1`；或在脚本内自检版本 |
| E8 | 无 `protoc`；Rust 仅有 `x86_64-pc-windows-gnu` 且缺 mingw gcc | 安全服务计划的 `cargo build` 会链接失败 | 需 `rustup toolchain install stable-x86_64-pc-windows-msvc` + 安装 `protoc`（或用 `prost-build` 的 vendored protoc） |
| E9 | 无 WiX Toolset | 部署计划 Task 4 的 `.wxs` 无法编译验证 | 只交付文件，标注"未在本机验收" |
| E10 | 无 `bash`/`sh` | 部署计划 Task 5 的 `restore_smoke.sh` 不可运行 | 备份/恢复脚本以 PowerShell 为主，`*.sh` 只进 CI |
| E11 | `ent generate` 需要 `ariga.io/atlas` 在 `go.sum` 中 | 首次 `go generate` 会因缺 `go.sum` 条目报错 | 生成前先 `go mod tidy`（或 `go get entgo.io/ent/dialect/sql/schema`）；好消息是 **Atlas 库随 Ent 一起进入依赖图**，因此"用 Atlas 生成受控 SQL"不需要额外安装 CLI |

> **结论：** 后端核心计划（Go）完全可在本机跑通并验收；Rust 与部署两份计划在当前环境只能"交付代码、不能验收"，需要在报告中如实标注。

---

## 3. 设计稿评审

### 3.1 优点（建议保留，不要重写）

1. **模块化单体的选择正确。** 内容审核、站点权限、评论、通知、审计之间存在强事务关系（§4.3），首版拆微服务会让每次发帖跨 4 个服务事务。保留 Outbox + 版本化 gRPC 作为未来拆分路径，是恰当的折中。
2. **三方言约束写得非常具体**（§6.2）：应用层 UUID、UTC 时间、禁用枚举/数组/部分索引/`RETURNING`、可查询字段拆列。这份清单直接决定了后续所有 Ent schema 的写法，是本设计最有价值的部分。
3. **认证方案严谨**（§7.3）：Ed25519 JWT 短期 + opaque refresh 轮换 + 重放检测 + CSRF 双提交 + HttpOnly Cookie，这套组合优于常见的"refresh token 存 localStorage"。
4. **内容安全管线方向正确**（§5.3）：源内容与渲染 HTML 分离，展示只信服务端 `rendered_html`。
5. **"不安全就暂停"的失败语义**（§8.1）：安全检查不可用时进入待处理而非放行，这是安全设计里最容易做错的一点。

### 3.2 设计缺陷（详见 §4）

设计稿 §5.1 的实体表与 §7 的接口约定**不自洽**：接口需要的表，实体表里没有。这是所有 P0 问题的根源。

---

## 4. P0：阻断级问题（开工前必须修订）

### P0-1 缺少会话/刷新令牌实体，与 §7.3 的轮换要求直接冲突

- **现象：** §5.1 实体表（第 112–132 行）没有任何 session / refresh token 表；后端核心计划 Task 2 的 schema 文件清单（第 84–100 行）同样没有 `session.go`。
- **但** §7.3 要求"服务端只保存哈希值，并进行轮换和重放检测"，后端计划 Task 4 Step 3（第 213 行）要求"创建…hashed opaque refresh-token record…detect reuse and revoke the token family"。
- **影响：** 没有表就无法存哈希、无法做 token family 吊销。**这是功能无法实现，不是风格问题。**
- **修订：** 新增 `sessions` 实体：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string (UUIDv7) | 会话 ID |
| `user_id` | string | 所属用户 |
| `token_hash` | string, unique | refresh token 的 SHA-256（不存明文） |
| `family_id` | string, index | token family，重放时整族吊销 |
| `parent_id` | string, nullable | 上一次轮换来源，用于重放链 |
| `user_agent` / `ip` | string, nullable | 会话指纹（仅审计用） |
| `expires_at` | time | 绝对过期 |
| `rotated_at` / `revoked_at` / `revoked_reason` | time/string, nullable | 状态 |
| `created_at` / `updated_at` | time | |

> 判定重放：refresh 时若 `token_hash` 命中但 `rotated_at != nil`，说明旧 token 被重放 → 吊销该 `family_id` 全部会话。

### P0-2 `outbox_events` 无收件人维度，`GET /events?after_id=` 会跨用户泄露

- **现象：** §5.1 第 132 行 `outbox_events` 只有 `site_id`；而后端计划 Task 7 Step 5（第 343 行）要求补偿端点"scoped to the current site **and principal**"。
- **影响：** 只有 `site_id` 时，同一站点的 A 用户能 replay 到发给 B 用户的 `message.created` 事件——**跨用户数据泄露**，且直接违反设计稿 §12.2 验收条件"任意站点用户不能读取另一个站点的内容、成员、私信或媒体"。
- **修订：** `outbox_events` 增加 `audience_user_id`（可空）。语义：
  - `audience_user_id = NULL` → 站点级广播（如 `moderation.updated`）
  - `audience_user_id = <id>` → 只投递给该用户（如 `message.created`、`notification.created`）
  - replay 查询条件：`site_id = ? AND (audience_user_id IS NULL OR audience_user_id = ?) AND event_id > ?`
- **注意：** 这类"一个事件多收件人"的场景（群发通知）应写多行，而不是在 JSON 里放数组——因为要按用户查询。

### P0-3 SQLite 驱动必须显式指定纯 Go 实现，计划未写

- **现象：** 后端计划 Task 2 Step 3 只说"Use Ent dialect constants"，未指定驱动实现。
- **证据：** 本机 `CGO_ENABLED=0` 且无 `gcc`（E3）；Ent 文档的 SQLite 默认路径依赖 `mattn/go-sqlite3`（需 CGO），会编译失败。
- **修订：** 固定 `modernc.org/sqlite`，通过 `entsql.OpenDB(dialect.SQLite, sqlDB)` 注入；DSN 显式带 `_pragma=foreign_keys(1)&_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)`。SQLite 必须设置 `db.SetMaxOpenConns(1)`（或 WAL + busy_timeout），否则并发写会 `database is locked`。
- **已实测：** 该组合在 windows/amd64 上编译并运行成功。

### P0-4 缺少幂等键存储，但契约与验收条件都要求

- **现象：** §7.2 第 216 行约定 `Idempotency-Key` 请求头；§12.1 测试层级第 1 条要求测"幂等键"；但没有任何表或任务实现它。
- **影响：** 前端按文档重试写请求会产生重复评论/重复帖子。
- **修订：** 新增 `idempotency_keys` 实体（`key`+`user_id`+`route` 唯一，`request_hash`、`status_code`、`response_body`、`expires_at`），并加中间件：命中且请求哈希一致 → 回放原响应；哈希不一致 → 返回 `409 idempotency_key_reuse`。

### P0-5 缺少上传会话实体，两阶段上传无法实现

- **现象：** §7.6 第 296–303 行定义了两步上传（先 `POST /media/uploads` 拿上传会话，再 `complete`）；§5.1 只有 `media_assets`（第 129 行），没有 upload session 表。
- **修订：** 新增 `media_uploads` 实体：`id`、`site_id`、`owner_id`、`declared_name`、`declared_mime`、`declared_size`、`storage_key`、`status`（`pending`/`uploaded`/`completed`/`expired`）、`expires_at`、`created_at`。

### P0-6 计划顺序存在循环依赖：Task 5 依赖尚未实现的 Rust 服务

- **现象：** 后端核心 Task 5 Step 4（第 261 行）要求"Add Rust security calls"；而 Rust 服务在另一份计划里，且本机尚不能编译（E8）。
- **影响：** 若严格按后端计划执行，Task 5 会卡住，整个后端停摆。
- **修订：** 在 `apps/api` 内先定义 **`SecurityClient` 接口**（`SanitizeContent`/`InspectUpload`/`HashPassword`/`VerifyPassword`/`Ping`），并提供两个实现：
  - `securityclient.Stub`：始终返回 `ErrSecurityUnavailable` → 触发 fail-closed 语义（内容停留 `pending_security_check`，上传停留 `scan_status=pending`）。这样 Task 5 可完整实现并测试"不可用即暂停"这条主路径。
  - `securityclient.GRPC`：在 Rust 服务就绪后补齐（安全计划 Task 5）。
- **收益：** 后端不再被 Rust 阻塞；fail-closed 行为反而在 Rust 缺席时被真实覆盖。

### P0-7 `search` 模块有路由无实现

- **现象：** 设计稿 §4.1 模块图与 §7.5 第 290 行都有 `/search`；后端计划 Task 8 Step 2（第 369 行）要求挂载 search 路由；但**没有任何任务**创建 `apps/api/internal/search/`。
- **修订：** 增加 Search 任务（可并入 Task 6 之后）：`SearchService.Search(ctx, siteID, query, type, cursor)`，用 `LIKE` + 索引实现（三方言通用），显式不做 FTS（SQLite FTS5 与 MySQL FULLTEXT 语义不一致，会破坏"同一行为"约束）。

### P0-8 JWT 签名密钥的来源、生成与轮换未定义

- **现象：** 后端计划 Task 1 Step 4（第 71 行）要求的必需环境变量只有 `APP_ENV`、`HTTP_ADDR`、`DATABASE_DRIVER`、`DATABASE_DSN`、`SECURITY_GRPC_ADDR`，没有密钥项；但约束要求 Ed25519 JWT。
- **影响：** 无法启动；或开发者硬编码密钥 → 安全事故。
- **修订：** 增加 `AUTH_JWT_ED25519_PRIVATE_KEY`（base64 PKCS#8）与 `AUTH_JWT_KID`。`APP_ENV=development` 且未配置时，自动生成临时密钥并打印警告（仅开发）；`APP_ENV=production` 缺失即启动失败。JWT header 带 `kid`，为将来轮换留路。

### P0-9 站点域名验证状态字段缺失

- **现象：** §7.4 第 275–280 行要求"域名未验证时统一返回明确错误码"；§5.1 `sites`（第 116 行）只有 `domain`，没有验证状态。
- **修订：** `sites` 增加 `domain_verified_at`（可空）、`domain_verification_token`（可空）。未验证时按配置回退到默认站点或返回 `site_domain_unverified`。

---

## 5. P1：重要缺口（可以在实现中顺带补齐，但必须在计划里写明）

| 编号 | 缺口 | 修订 |
| --- | --- | --- |
| P1-1 | 标签/分类无表，但 Task 5 Step 2 要求存 tags/categories，且要能按标签搜索 | 增加 `tags`、`content_tags`（多对多），分类用 `categories` + `articles.category_id` |
| P1-2 | 邮箱验证/手机验证码/密码重置无表，但 Task 4 Step 2 要求"verified registration" | 增加 `verification_tokens`（`user_id`、`kind`、`token_hash`、`expires_at`、`consumed_at`） |
| P1-3 | WebSocket 一次性票据无存储；多副本下内存票据失效 | 首版用内存 `TicketStore`（带 TTL + 单次消费），并在 `docs/operations.md` 注明"仅单副本有效"；后续换 Redis |
| P1-4 | 限流为单实例内存，Docker 多副本语义变化 | 同上，明确写进文档，不要假装它是全局限流 |
| P1-5 | 可信代理解析缺失：`X-Forwarded-Host`/`X-Forwarded-For` 若直接信任可被伪造 | 增加 `TRUSTED_PROXIES` 配置，仅当直连 IP 在列表内才采信转发头 |
| P1-6 | 内容清洗时机冲突：Task 5 Step 4 说"发布时等待清洗"，但 §5.3 要求每个 revision 存 `rendered_html` | 定为：**每次写 revision 时清洗并存 HTML**；发布时只校验该 revision 的 `policy_version` 仍被接受。理由：编辑器预览必须有 HTML，且避免发布时才发现内容不可清洗 |
| P1-7 | 游标编码无规范 | 定为 `base64url(JSON{"k":<排序键>,"id":<UUIDv7>})`，服务端校验可解码，非法游标返回 `400 invalid_cursor` |
| P1-8 | `audit` 包在所有任务的 Files 里都没出现 | 增加 `apps/api/internal/audit/service.go`（`Record(ctx, tx, Event)`），由各服务在同一事务内调用 |
| P1-9 | 邮件/短信供应商适配器缺失 | 定义 `notifications.EmailSender` / `SMSSender` 接口 + `noop` 实现；未配置时对应登录方式返回 `provider_not_configured`（呼应 §11.1 第 6 条） |
| P1-10 | `internal/platform/errors` 与标准库 `errors` 同名，易误导入 | 建议改包名 `apperr`（目录可保留 `platform/errors`），对外类型 `apperr.Problem` |
| P1-11 | Atlas 迁移落地方式不明确，且 Atlas CLI 未安装 | 定为：Ent `migrate` 包做开发期 schema 同步（`client.Schema.Create`），**Atlas 只用于生成受控 SQL**，`migrations/{sqlite,mysql,postgres}` 存放生成结果；CI 校验"生成结果无 diff"。生产禁止自动迁移 |
| P1-12 | 计划要求 `GET /api/v1/openapi.json` 与 `/api/v1/docs`，但未说明如何产出 JSON | 由 `packages/contracts/openapi/openapi.yaml` 内嵌（`go:embed`）后提供；docs 用 Redoc/Swagger UI 静态页 |
| P1-13 | `SiteService.ResolveOrCreateDefault` 对任意 Host 自动建站有滥用风险 | 仅当"库中无任何站点"时才自动创建；已有站点时未知 Host 返回 `site_not_found` |

---

## 6. P2：建议优化（不阻断）

1. **计划里的 `Makefile` 与 Windows 现实不符**（E5）。建议 `scripts/dev.ps1`（Windows）与 `Makefile`（CI）双入口，`Makefile` 只做薄封装。
2. **Task 1 Step 1 的测试用了 `require.JSONEq` 但没 `go get testify`**，注意 go.mod 显式声明（spike 已验证 `testify v1.12.1` 可用）。
3. **`Dependencies` 结构体目前是空壳**（`New(Dependencies{})`）。建议从一开始就定义 `Dependencies{Config, Logger, DB, Security, Clock}`，避免后续到处改签名。
4. **提交粒度**：计划里的提交是按 Task 的，但 TDD 步骤是先失败再实现；建议每 Task 内 2 个提交（`test:` + `feat:`），便于回滚。
5. **计划未给估算。** 按当前 Task 粒度，Go 后端核心约 6–8 千行（含生成代码），单人节奏约 2–3 周；建议按 §9 分 4 个里程碑交付。

---

## 7. 逐任务可行性评分

### 7.1 后端核心（可本地完整验收）

| Task | 内容 | 可行性 | 关键前置 |
| --- | --- | --- | --- |
| 1 | Go 模块 + Gin 骨架 + 配置 + 日志 | ✅ 高 | 需 `git init`；`Makefile` 换 `scripts/*.ps1` |
| 2 | 三方言数据层 + Ent schema + 迁移 | ✅ 高（SQLite）/ ⚠️ 中（MySQL/PG 仅 CI） | 必须用 `modernc.org/sqlite`；补 6 张表（P0-1/4/5/9、P1-1/2） |
| 3 | 中间件：请求 ID / 错误 / CORS / 限流 | ✅ 高 | 错误模型要先定（P1-10） |
| 4 | 身份、会话、站点、角色 | ⚠️ 中 | 强依赖 P0-1（sessions）与 P0-8（密钥） |
| 5 | 内容、版本、媒体、审核状态机 | ⚠️ 中 | 强依赖 P0-5（上传会话）、P0-6（SecurityClient 接口） |
| 6 | 社区互动 | ✅ 高 | 唯一约束要跨三方言（注意 SQLite 的唯一索引差异小，风险低） |
| 7 | 会话、通知、Outbox、WebSocket、事件补偿 | ⚠️ 中 | 强依赖 P0-2（audience 字段），否则有泄露缺陷 |
| 8 | 契约、集成、三库验收 | ⚠️ 中 | 三库部分只能 CI |

### 7.2 Rust 安全服务

| Task | 可行性 | 说明 |
| --- | --- | --- |
| 1–4 | ⚠️ 需先补环境 | `rustup toolchain install stable-x86_64-pc-windows-msvc`；`protoc` 缺失（建议 `protoc-bin-vendored` crate，避免要求全局安装） |
| 5 | ✅ | 纯 Go 客户端 + fake gRPC server 可测 |
| 6 | ⚠️ | `cargo fuzz` 需 nightly，本机未装 |

### 7.3 契约与部署

| Task | 可行性 | 说明 |
| --- | --- | --- |
| 1 OpenAPI | ✅ | `@redocly/cli` 需 Node（本机有 v24.13.0） |
| 2 SDK 生成 | ✅ | `openapi-generator-cli` 需 Java，未验证 |
| 3 Docker | ❌ 不可验收 | 无 Docker |
| 4 Windows 安装包 | ❌ 不可验收 | 无 WiX |
| 5 备份/恢复 | ⚠️ | 需 `pg_dump`/`mysqldump`，本机无 |
| 6 最终评审 | ⚠️ | 依赖上面几项 |

---

## 8. 开工前必须落地的修订清单（Definition of Ready）

按此清单改完，即可开工。每项都对应到具体文件。

1. **`git init`**，加 `.gitignore`（`*.exe`、`*.db`、`*.db-*`、`node_modules`、`apps/api/ent/migrate/` 视情况）。
2. **`docs/superpowers/plans/2026-10-18-practacu-press-backend-detailed-plan.md`**（本次已产出，与本文件配套）：把 P0/P1 全部写进任务步骤，并替代原后端计划的执行版本。
3. **Ent schema 补齐 8 个实体**：`sessions`、`idempotency_keys`、`media_uploads`、`tags`、`content_tags`、`categories`、`verification_tokens`、`ws_tickets`（若选择持久化票据，否则内存实现并在文档注明）。
4. **`outbox_events` 增加 `audience_user_id`**。
5. **`sites` 增加 `domain_verified_at`、`domain_verification_token`**。
6. **配置项补齐**：`AUTH_JWT_ED25519_PRIVATE_KEY`、`AUTH_JWT_KID`、`TRUSTED_PROXIES`、`STORAGE_*`、`OAUTH_*`、`COOKIE_*`、`CORS_ALLOWED_ORIGINS`、`RATE_LIMIT_*`。
7. **`SecurityClient` 接口 + `Stub` 实现**（fail-closed），解除对 Rust 的依赖。
8. **构建入口**：`scripts/dev.ps1`、`scripts/migrate.ps1`、`scripts/test.ps1`（都带代理设置与 64 位 Go 路径）。

---

## 9. 修订后的执行顺序

原计划的三份文档是"按子系统横切"，执行时必须"按依赖纵切"：

```text
M0 骨架（本机可验收）
  Task 1  模块/配置/日志/路由/健康检查
  Task 2  三方言数据层 + 全部 Ent schema + 迁移入口
  Task 3  中间件（请求ID/错误/CORS/限流/站点解析）
        ↓ 门禁：go build + go vet + go test ./... 全绿，SQLite 建表成功

M1 身份与站点（本机可验收）
  Task 4  身份、会话（含轮换/重放）、站点、角色、审计
        ↓ 门禁：注册→登录→刷新→越权拒绝 的集成测试全绿

M2 内容与社区（本机可验收，安全服务用 Stub）
  Task 5  内容/版本/媒体/审核状态机（fail-closed）
  Task 6  社区互动
  Task 7  Search（补 P0-7）
        ↓ 门禁：状态机全路径 + 站点隔离测试全绿

M3 消息与实时（本机可验收）
  Task 8  会话/消息/通知/Outbox/WS/事件补偿（audience 隔离）
        ↓ 门禁：跨用户事件不可见、重复投递幂等

M4 并行推进（部分不可本机验收）
  Rust 安全服务（先补 toolchain）
  OpenAPI 契约 + SDK 生成
  Docker / Windows 安装包 / 备份恢复（交付文件，标注未验收）
```

**为什么调整：** 原计划把"契约与部署"作为第三份文档，但 OpenAPI 契约必须在 Task 8 之前定稿，否则 Task 8 的"OpenAPI 响应校验"没有输入。建议契约骨架在 M0 就落地，随 M1–M3 迭代补全。

---

## 10. 结论

- **架构无需重做**，可直接进入实现。
- **必须修订 9 项 P0**，其中 **P0-1（会话表）、P0-2（事件 audience）、P0-5（上传会话）** 属于"不改就必然返工或出安全事故"的级别。
- **本机可完整验收 Go 后端**（已实测技术栈全部可用）；Rust 与部署两份计划只能在补齐工具链后验收，报告中应如实标注，不要把"写了文件"当作"验证通过"。
- 按 §9 的四个里程碑推进，每个里程碑以"可运行 + 测试全绿"作为交付边界。
