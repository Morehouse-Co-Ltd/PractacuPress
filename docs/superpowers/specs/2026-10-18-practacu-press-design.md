# Practacu Press 产品与技术设计

**版本：** v0.1

**日期：** 2026-10-18

**状态：** 设计稿，等待用户评审

## 1. 产品定位

Practacu Press 是一个支持本地部署和 SaaS 多站点的社区型 CMS。它允许用户注册、发布文章和帖子，并通过评论、点赞、收藏、关注、私信和站内通知形成完整的内容社区。

首版不实现 React 前端。后端团队交付可独立运行的 Go API、Rust 安全服务、OpenAPI 3.1 契约、WebSocket 协议、部署包和前端对接文档，由其他团队开发 React 管理端和用户端。

系统支持两个运行模式：

- **单站点模式：** Windows 本地安装或单机部署后默认只显示一个网站，用户不需要理解“租户”或“站点空间”。
- **SaaS 多站点模式：** 平台管理员可以创建多个独立站点。每个站点有独立内容、成员关系、站点配置、主题、审核规则和权限边界。

本文将“租户”统一称为“站点空间”。它表示一个相互隔离的网站及其成员、内容和配置；普通用户只会看到当前网站。

## 2. 目标与非目标

### 2.1 首版目标

1. 支持邮箱、手机号、Google、GitHub、微信注册和登录。
2. 支持四级固定角色：平台管理员、站点管理员、编辑/审核员、普通用户。
3. 支持文章、帖子、评论、回复、点赞、收藏、关注、私信、通知和举报。
4. 支持站点级发布模式：开放发布、审核发布、按角色发布。
5. 支持站点级访客模式：公开浏览或登录后浏览。
6. 支持富文本和 Markdown 双编辑模式，并保留内容版本。
7. 支持本地文件存储，以及可选的 S3 兼容对象存储。
8. 支持 REST + OpenAPI 3.1 和 WebSocket，便于外部 React 团队独立开发。
9. 支持 SQLite、MySQL、PostgreSQL 三种数据库。
10. 支持 Windows 本地安装和 Linux Docker 部署，并提供初始化、迁移、备份和升级流程。

### 2.2 首版明确不做

- 不在本项目中实现 React 用户端或管理端。
- 不在首版实现插件市场、实时多人协作编辑、复杂计费、推荐算法和跨站点内容同步。
- 不把所有功能拆成独立微服务；首版采用可拆分的模块化单体。
- 不允许前端直接访问数据库或 Rust 服务。

## 3. 用户角色和权限

| 角色 | 权限范围 |
| --- | --- |
| 平台管理员 | 管理平台账户、站点、全局安全策略、系统配置和跨站点运维；可查看全局审计信息 |
| 站点管理员 | 管理单个站点的成员、内容规则、主题、登录方式、存储配置和站点审计 |
| 编辑/审核员 | 审核文章、帖子、评论和举报；可按站点策略直接发布或驳回内容 |
| 普通用户 | 注册、编辑资料、发布文章/帖子、评论、点赞、收藏、关注、私信和举报 |

权限在服务端强制校验。前端隐藏按钮只能改善体验，不能作为安全控制。普通用户的每次查询和写入都必须经过当前站点、身份、资源所有权和角色权限检查。

## 4. 总体架构

### 4.1 推荐方案

采用 **Gin 模块化 Go 单体 + Rust 安全服务 + 外部 React 前端**：

```text
浏览器 / React 前端
        │ REST + OpenAPI 3.1 / WebSocket
        ▼
Gin HTTP API（Go）
        │
        ├── Identity/Auth：账号、登录、会话、第三方身份
        ├── Site：站点、成员、站点配置和站点解析
        ├── Content：文章、帖子、版本、标签、分类
        ├── Community：评论、点赞、收藏、关注、举报
        ├── Messaging：会话、私信、通知、在线状态
        ├── Media：媒体上传、元数据、存储适配
        ├── Moderation：审核、驳回、封禁、恢复
        ├── Search：站内基础搜索和查询排序
        ├── Audit：审计记录和安全事件
        └── Outbox/Worker：异步通知、索引、扫描和重试
        │
        ├── 数据访问层：SQLite / MySQL / PostgreSQL
        └── 内部 gRPC：Rust Security Service
                    ├── Argon2id 密码操作
                    ├── 文件和 MIME 检查
                    ├── Markdown/HTML 安全策略
                    └── 风险策略校验
```

Gin 只负责 HTTP 适配、路由、中间件、参数绑定和响应。业务代码不得把核心规则写在 Gin Handler 中，避免未来改成 gRPC、命令行任务或拆分服务时产生大规模重构。

### 4.2 模块边界

每个 Go 模块保持以下依赖方向：

```text
Handler → Application Service → Domain → Repository Interface
                                      ↑
                             Infrastructure Adapter
```

- `Handler` 只解析输入、调用应用服务和转换输出。
- `Application Service` 编排事务、权限检查、领域操作和事件发布。
- `Domain` 定义实体、值对象、状态转移和业务不变量。
- `Repository Interface` 由领域或应用层定义，数据库实现放在 Infrastructure。
- `Infrastructure` 负责 Ent、Atlas、对象存储、邮件、短信、OAuth 和 gRPC 客户端。

### 4.3 为什么不首版拆成微服务

文章审核、站点权限、评论、通知和审计存在大量事务关系。首版采用模块化单体可以保留清晰边界，同时降低本地安装、数据库事务、日志关联和部署成本。Outbox 事件、内部接口和独立 Rust 服务为后续拆分消息、搜索或媒体服务保留迁移路径。

## 5. 数据模型

### 5.1 核心实体

| 实体 | 关键字段 | 说明 |
| --- | --- | --- |
| `users` | `id`, `status`, `display_name`, `created_at` | 全局用户账户 |
| `user_identities` | `user_id`, `provider`, `provider_subject`, `verified_at` | 邮箱、手机号和 OAuth 身份绑定 |
| `sites` | `id`, `slug`, `domain`, `visibility_mode`, `publish_mode` | 网站和站点级规则 |
| `site_members` | `site_id`, `user_id`, `role`, `status` | 用户与站点的关系 |
| `articles` | `site_id`, `author_id`, `status`, `title`, `slug` | 长篇文章 |
| `posts` | `site_id`, `author_id`, `status`, `body` | 短内容或讨论帖 |
| `content_revisions` | `content_type`, `content_id`, `editor_id`, `source_format`, `source_body`, `rendered_html` | 富文本/Markdown 版本 |
| `comments` | `site_id`, `author_id`, `target_type`, `target_id`, `parent_id`, `status` | 评论和回复 |
| `reactions` | `site_id`, `user_id`, `target_type`, `target_id`, `kind` | 点赞等可扩展反应 |
| `bookmarks` | `site_id`, `user_id`, `target_type`, `target_id` | 收藏 |
| `follows` | `site_id`, `follower_id`, `followee_id` | 用户关注关系 |
| `conversations` | `site_id`, `kind` | 私信会话 |
| `conversation_members` | `conversation_id`, `user_id`, `last_read_message_id` | 会话成员和已读游标 |
| `messages` | `conversation_id`, `sender_id`, `body`, `created_at` | 私信内容 |
| `notifications` | `site_id`, `user_id`, `type`, `read_at`, `payload` | 站内通知 |
| `media_assets` | `site_id`, `owner_id`, `storage_key`, `mime_type`, `scan_status` | 图片、头像和附件 |
| `moderation_reports` | `site_id`, `reporter_id`, `target_type`, `target_id`, `reason`, `status` | 举报和处理结果 |
| `audit_logs` | `site_id`, `actor_id`, `action`, `target_type`, `target_id`, `request_id` | 管理和安全审计 |
| `outbox_events` | `site_id`, `event_type`, `aggregate_id`, `payload`, `published_at` | 可靠异步事件 |

### 5.2 内容状态机

```text
draft → pending_review → published
                    └── rejected → draft
published → archived
```

- 开放发布：普通用户的合规内容可从 `draft` 直接进入 `published`。
- 审核发布：普通用户提交后进入 `pending_review`。
- 按角色发布：普通用户需要审核；编辑/审核员和站点管理员可直接发布。
- 任何状态转换都记录操作者、原因、时间和请求 ID。

### 5.3 内容安全管线

```text
前端提交源内容
  → Go 校验大小和格式
  → Rust 规范化与清洗
  → 保存原始源内容和清洗后的 HTML
  → 应用站点发布规则
  → 写入审核/发布状态
  → Outbox 触发通知、索引和审计
```

数据库不直接保存未经清洗的可渲染 HTML 作为展示来源。前端展示只使用服务端产生的 `rendered_html`，并根据 Content Security Policy 限制脚本执行。

## 6. 三数据库兼容策略

### 6.1 支持矩阵

| 环境 | 默认值 | 支持选项 |
| --- | --- | --- |
| Windows 本地安装 | SQLite | MySQL、PostgreSQL |
| Linux Docker 单机 | PostgreSQL | MySQL、SQLite |
| SaaS 多站点生产 | PostgreSQL | MySQL |

SQLite 可以用于单机和小规模部署；高并发 SaaS 推荐 PostgreSQL，也支持 MySQL。

### 6.2 实现约束

- 使用应用层 UUID（推荐 UUIDv7）作为实体 ID，不依赖数据库自增行为。
- 所有时间以 UTC 存储，API 以 ISO 8601 返回。
- 使用 Go Ent 建模，Atlas 管理迁移，并为三种方言生成或维护迁移结果。
- 避免依赖数据库专属的枚举、数组、部分索引和 `RETURNING`。
- JSON 数据使用兼容映射；需要查询的字段拆成普通列。
- 事务边界由应用服务定义，Repository 不自行开启跨模块事务。
- 所有数据库驱动都必须通过相同的 Repository 接口测试。
- 迁移必须支持升级、失败回滚和从空库初始化。

### 6.3 数据库测试矩阵

CI 至少运行：

```text
SQLite：单元测试、迁移测试、Repository 集成测试
MySQL：迁移测试、Repository 集成测试、事务和并发测试
PostgreSQL：迁移测试、Repository 集成测试、事务和并发测试
```

## 7. 前端对接规范

### 7.1 基础地址和文档

```text
API 基础路径：/api/v1
OpenAPI JSON：/api/v1/openapi.json
Swagger UI：/api/v1/docs
健康检查：/healthz
就绪检查：/readyz
WebSocket：/api/v1/ws
```

外部 React 团队使用 OpenAPI Generator 生成 TypeScript 客户端。生成代码不应被手工修改；自定义请求拦截器、Token 刷新和错误提示写在独立适配层。

### 7.2 请求约定

```http
Authorization: Bearer <access_token>
Content-Type: application/json
Accept: application/json
X-Request-ID: <client-generated-or-server-generated-id>
Idempotency-Key: <unique-key-for-retryable-write>
```

时间使用 UTC ISO 8601；枚举值使用小写蛇形字符串；ID 使用字符串。所有列表响应统一为：

```json
{
  "items": [],
  "next_cursor": "opaque-cursor-or-empty",
  "has_more": false
}
```

错误统一使用 `application/problem+json`：

```json
{
  "type": "https://docs.practacu.press/errors/permission_denied",
  "title": "Permission denied",
  "status": 403,
  "code": "permission_denied",
  "message": "当前用户没有执行此操作的权限",
  "details": {},
  "request_id": "req_01"
}
```

### 7.3 认证流程

核心接口：

```text
POST /auth/register/email
POST /auth/register/phone/request-code
POST /auth/register/phone/verify
POST /auth/login/password
GET  /auth/oauth/{provider}/start
GET  /auth/oauth/{provider}/callback
POST /auth/token/refresh
POST /auth/logout
POST /auth/ws-ticket
GET  /me
```

会话规则：

1. Access Token 使用 Ed25519 签名 JWT，有效期约 15 分钟，前端只放在内存中。
2. Refresh Token 使用高熵 opaque token，服务端只保存哈希值，并进行轮换和重放检测；浏览器端存于 HttpOnly、Secure、SameSite Cookie。
3. 刷新接口同时使用 CSRF 双提交令牌；刷新失败时清除本地会话并跳转到登录页。
4. 邮箱、手机号、Google、GitHub、微信身份可以绑定到同一个 `user_id`。
5. OAuth 密钥只能存于服务端密钥配置，不进入导出的站点数据或日志。

### 7.4 站点识别

- 公开访问优先根据请求域名映射 `sites.domain`。
- 管理端可以传递 `site_id`，但后端仍校验当前用户是否属于该站点。
- 站点不存在、被禁用或域名未验证时，统一返回明确错误码。
- 本地单站点模式自动创建一个站点，前端无需展示站点选择器。

### 7.5 资源接口

```text
/auth                 注册、登录、刷新、登出、第三方登录
/me                   当前用户、资料、账号安全
/sites                站点配置、成员和站点发现
/articles             文章、草稿、版本、发布和审核
/posts                帖子、草稿、发布和审核
/comments             评论、回复、删除和举报
/reactions            点赞、取消点赞、收藏、取消收藏、关注
/conversations        私信会话、消息、已读游标
/notifications        通知列表、单条已读、全部已读
/media                上传会话、上传完成、媒体元数据
/moderation           审核队列、举报处理、封禁和恢复
/admin                站点及平台管理
/search               基础内容和用户搜索
/events               WebSocket 断线后的事件补偿
```

### 7.6 媒体上传

前端使用两步上传：

1. `POST /media/uploads` 提交文件名、大小、MIME 和用途，后端返回上传会话。
2. 本地存储使用受控的 multipart 上传；S3 模式返回短期预签名地址。
3. `POST /media/uploads/{id}/complete` 触发 Rust 扫描和媒体确认。
4. 只有 `scan_status=clean` 的文件可以被文章、帖子或头像引用。

前端不得自行信任文件扩展名或 MIME；展示 URL 必须来自后端返回的媒体资源。

### 7.7 WebSocket

浏览器先调用 `POST /auth/ws-ticket` 获取一次性短期票据，再连接：

```text
wss://example.com/api/v1/ws?ticket=<one-time-ticket>
```

事件格式：

```json
{
  "id": "event_01",
  "type": "notification.created",
  "occurred_at": "2026-10-18T08:00:00Z",
  "site_id": "site_01",
  "payload": {}
}
```

首版事件：`message.created`、`notification.created`、`notification.read`、`presence.changed`、`moderation.updated`。事件 ID 使用 UUIDv7 并按创建时间排序。前端保存最后事件 ID，断线重连时调用 `GET /api/v1/events?after_id=<event_id>&limit=100` 补齐当前站点遗漏事件。WebSocket 不可用时，前端退回通知和消息轮询。

## 8. Rust 安全服务

Rust 服务作为独立进程运行，Go 通过版本化 gRPC 调用。它不直接访问业务数据库，不负责用户、文章或站点权限。

### 8.1 gRPC 能力

```text
HashPassword / VerifyPassword
SanitizeContent
InspectUpload
ValidateSecurityPolicy
```

协议定义放在 `packages/contracts/security/v1/security.proto`，每次不兼容修改都递增协议版本。Go 端对 Rust 服务设置超时、熔断和有限重试；安全检查不可用时，上传和发布进入待处理状态，不绕过扫描直接公开。

### 8.2 安全规则

- Argon2id 参数集中配置并记录策略版本。
- 密码、Refresh Token、OAuth 密钥和短信密钥不写入普通日志。
- 富文本只允许明确的标签、属性和协议白名单。
- 上传检查文件大小、真实 MIME、扩展名、文件名、路径和压缩层级。
- 限制登录、注册、短信、评论、发帖、私信和上传频率。
- 设置 CSP、HSTS、X-Content-Type-Options、Referrer-Policy 等响应头。
- 所有管理操作、权限失败和安全事件写入审计日志。

## 9. 推荐项目结构

```text
practacu-press/
├── apps/
│   └── api/
│       ├── cmd/server/main.go
│       ├── internal/
│       │   ├── auth/
│       │   ├── site/
│       │   ├── content/
│       │   ├── community/
│       │   ├── messaging/
│       │   ├── media/
│       │   ├── moderation/
│       │   ├── search/
│       │   ├── audit/
│       │   ├── outbox/
│       │   └── platform/
│       ├── transport/http/gin/
│       ├── transport/ws/
│       ├── infrastructure/db/
│       ├── infrastructure/storage/
│       ├── infrastructure/oauth/
│       ├── infrastructure/notifications/
│       └── infrastructure/securityclient/
├── services/
│   └── security/
│       ├── Cargo.toml
│       ├── src/main.rs
│       ├── src/application/
│       ├── src/domain/
│       ├── src/transport/grpc/
│       └── tests/
├── packages/
│   └── contracts/
│       ├── openapi/openapi.yaml
│       └── security/v1/security.proto
├── migrations/
│   ├── sqlite/
│   ├── mysql/
│   └── postgres/
├── deploy/
│   ├── docker/
│   │   ├── compose.sqlite.yml
│   │   ├── compose.mysql.yml
│   │   ├── compose.postgres.yml
│   │   ├── .env.example
│   │   └── nginx/
│   ├── windows/
│   │   ├── installer/
│   │   └── scripts/
│   └── systemd/
├── scripts/
│   ├── dev.ps1
│   ├── dev.sh
│   ├── migrate.ps1
│   ├── migrate.sh
│   └── backup.sh
├── tests/
│   ├── contract/
│   ├── integration/
│   ├── e2e/
│   └── security/
├── docs/
│   ├── frontend-integration.md
│   ├── deployment.md
│   ├── operations.md
│   └── superpowers/specs/
├── go.mod
├── go.sum
├── Cargo.toml
├── Makefile
└── README.md
```

目录规则：

- `internal` 内部实现不能被外部 Go 模块直接导入。
- 每个业务模块拥有自己的 Handler、Application、Domain、Repository 和测试目录。
- OpenAPI 和 protobuf 是跨团队契约的唯一来源。
- 生成代码放在明确的 `gen` 目录，不手工编辑。
- 环境配置使用环境变量或受控配置文件，禁止提交密钥。

## 10. 开发规范

### Go

- 使用 Go modules 和固定的 Go 版本下限。
- Gin Handler 保持薄；业务逻辑写在应用服务。
- 错误使用可判定的领域错误，并统一映射为 API 错误码。
- 所有外部输入先绑定、校验、规范化，再进入领域层。
- Repository 不暴露数据库方言细节。
- 日志使用结构化字段，所有请求带 `request_id`。
- 公共类型、接口和包必须有 GoDoc；导出的 API 变更需要契约测试。

### Rust

- 使用 Rust 2024 edition 和 `cargo fmt`、`cargo clippy`、`cargo test`。
- 任何来自 Go 的输入都必须在边界重新校验。
- 安全策略变更必须有回归样例和 fuzz 测试。
- 不在 Rust 服务中存储业务数据或绕过 Go 的权限判断。

### API

- 破坏性变更通过 `/api/v2`，不能静默修改 v1 行为。
- 新字段优先保持可选，删除字段前至少经历一个弃用周期。
- 每个写接口定义幂等策略、权限、错误码和审计行为。
- OpenAPI 示例必须覆盖成功、未认证、无权限、校验失败和限流响应。

## 11. 部署设计

### 11.1 Windows 本地安装

安装包包含 Go API、Rust 安全服务、初始化工具和默认 SQLite 驱动。安装向导负责：

1. 选择应用目录、媒体目录和备份目录。
2. 选择 SQLite、MySQL 或 PostgreSQL 连接方式。
3. 创建第一个平台管理员。
4. 创建默认单站点并设置名称、域名和访客策略。
5. 执行数据库迁移和健康检查。
6. 配置邮箱、短信和 OAuth；未配置的登录方式在界面中显示为不可用。
7. 启动服务并显示管理端 API 地址和 OpenAPI 文档地址。

### 11.2 Linux Docker

Docker Compose 至少提供三个 profile：

```text
sqlite：适合演示和单机小规模部署
mysql：适合已有 MySQL 基础设施的团队
postgres：SaaS 生产推荐
```

每个 profile 都包含 Go API、Rust 安全服务、worker 和反向代理；数据库按 profile 选择。对象存储可使用本地卷、MinIO 或外部 S3。初始化脚本必须支持重复执行而不重复创建管理员或站点。

### 11.3 运维要求

- `/healthz` 只检查进程存活；`/readyz` 检查数据库、Rust 服务和必要存储。
- 数据库迁移和应用发布分开执行，并在发布前备份。
- 备份包括数据库、媒体文件和站点配置；恢复演练必须能在新环境验证。
- 日志支持 JSON 输出和按请求 ID 查询。
- 升级失败时保留上一个应用镜像和可恢复的数据库备份。

## 12. 测试和验收

### 12.1 测试层级

1. **Go 单元测试：** 内容状态机、权限判断、分页、幂等键和错误映射。
2. **Go 集成测试：** Gin 路由、数据库迁移、Repository、Outbox 和对象存储适配器。
3. **三数据库契约测试：** SQLite、MySQL、PostgreSQL 使用同一组 Repository 场景。
4. **Rust 测试：** 密码、清洗策略、文件检查、边界输入和 fuzz。
5. **API 契约测试：** OpenAPI 与实际响应、错误码和权限行为一致。
6. **WebSocket 测试：** 连接票据、重连、重复事件、顺序和权限隔离。
7. **安全测试：** 越权访问、跨站点读取、XSS、SSRF、CSRF、SQL 注入、上传绕过和限流。
8. **部署验收：** Windows 安装、三种数据库初始化、Docker 启动、备份恢复和升级回滚。

### 12.2 首版验收条件

- 新用户可通过至少一种配置好的方式注册和登录。
- 站点管理员可以切换访客模式和发布模式，配置即时生效。
- 普通用户发布文章/帖子时，审核规则和状态机正确执行。
- 文章、帖子、评论、点赞、收藏、关注、私信和通知接口均有 OpenAPI 描述。
- 外部前端仅依赖公开 API 契约即可完成登录、发布、互动和消息展示。
- 任意站点用户不能读取另一个站点的内容、成员、私信或媒体。
- SQLite、MySQL、PostgreSQL 均能完成初始化、迁移、基本 CRUD 和回滚测试。
- Rust 安全服务不可用时，危险操作会暂停或进入待处理状态，不会绕过检查。
- Windows 安装包和 Linux Docker 均能完成管理员初始化和健康检查。

## 13. 分阶段计划

### 阶段 0：契约和骨架

- 初始化 Go/Gin、Rust、OpenAPI、protobuf 和目录结构。
- 建立配置、日志、错误码、请求 ID、健康检查和迁移入口。
- 完成三数据库连接与最小迁移测试。

### 阶段 1：身份、站点和权限

- 用户、身份绑定、会话、邮箱/手机验证和 OAuth 适配。
- 单站点初始化和 SaaS 多站点模型。
- 四级角色、站点成员和权限中间件。

### 阶段 2：内容和媒体

- 文章、帖子、版本、富文本/Markdown、审核状态机。
- 本地存储、S3 适配、媒体扫描和安全引用。

### 阶段 3：社区互动

- 评论、回复、点赞、收藏、关注、举报和封禁。
- 站点级可见性和发布策略。

### 阶段 4：消息和实时能力

- 会话、私信、通知、已读游标、WebSocket 事件和断线补偿。
- Outbox、worker、重试和通知幂等。

### 阶段 5：部署和交付

- Windows 安装包、初始化向导和本地备份。
- SQLite/MySQL/PostgreSQL Docker profile。
- OpenAPI SDK 生成验证、前端对接示例和运维文档。

每个阶段都必须经过实现、测试、代码审查、修复和重新验证，阶段之间以可运行的 API 契约作为交付边界。

## 14. 未来扩展

在首版稳定后，可以按以下顺序扩展：

1. 将搜索、消息和媒体处理从模块化单体拆成独立服务。
2. 增加自定义角色和细粒度权限策略。
3. 增加插件系统和站点主题市场。
4. 增加全文搜索、推荐和内容分析。
5. 增加实时协作编辑、计费、配额和组织层级。

扩展必须优先复用现有 OpenAPI、领域事件、站点隔离和审计模型，避免直接耦合某一种数据库或前端框架。
