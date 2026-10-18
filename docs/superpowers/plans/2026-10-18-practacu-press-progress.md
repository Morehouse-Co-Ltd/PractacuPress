# Practacu Press 实施进度

**最后更新：** 2026-10-18
**对应计划：** `2026-10-18-practacu-press-backend-detailed-plan.md`

## 里程碑状态

| 里程碑 | 状态 | 门禁证据 |
| --- | --- | --- |
| M0 骨架与数据层 | ✅ 完成 | `go build`/`vet`/`test` 全绿；SQLite 空库建表 + CRUD 往返；`/healthz`、`/readyz`、404 problem+json 实跑通过 |
| M1 身份与会话 | 🚧 进行中 | — |
| M2 内容与社区 | ⬜ 未开始 | — |
| M3 消息与实时 | ⬜ 未开始 | — |
| M4 契约与部署 | ⬜ 未开始 | — |

## 已完成任务

### Task 1 工程骨架、配置、日志、健康检查 ✅

- `config.Load()` 校验 `APP_ENV`/`DATABASE_DRIVER`/`DATABASE_DSN`/`SECURITY_GRPC_ADDR`，并解析 CORS、可信代理、限流配置
- `logging.New` 输出 slog JSON，注入 `app_env`
- `/healthz` 恒 200；`/readyz` 真连数据库 Ping
- `main.go` 带 10 秒优雅关闭

### Task 2 统一错误模型 ✅

- `apperr.Problem` 序列化 `application/problem+json`
- 15 个稳定错误码，状态码集中在 `specs` 表
- `FromError` 把未知错误折叠成 `internal`，原始信息仅进日志

### Task 3 三方言数据层 ✅（M0 范围内）

- `db.Open` 支持 sqlite/mysql/postgres；SQLite 用纯 Go `modernc.org/sqlite`（本机 CGO 关闭）
- SQLite 连接池限制为 1，避免 `database is locked`
- 9 个 Ent 实体：user、user_identity、session、verification_token、site、site_member、audit_log、outbox_event、idempotency_key
- `cmd/migrate` 幂等、禁 drop column/index

### Task 4 中间件 ✅（幂等中间件除外）

- `RequestID`：复用合法入站 ID，否则生成 UUIDv7；响应必带 `X-Request-ID`
- `ErrorHandler`：`c.Error` → problem+json，未知错误不泄露；已写响应不重写
- `ResolveSite`：可信代理才读 `X-Forwarded-Host`；未知/未验证/停用站点全部拒绝
- `CORS`：仅白名单 Origin；预检未授权直接 403
- `RateLimit`：进程内固定窗口，超限返回 429 + `Retry-After`
- 运行时实测：预检 204 回显 Origin、限流第 4 次 429

## 待办与偏差

### Task 5 身份与会话（进行中）

已完成（可独立测试，不依赖数据库）：

- `auth` 域：`Principal`、`UserView`、`Session`、9 个哨兵错误
- `auth.TokenIssuer`：Ed25519 签名 JWT，15 分钟有效期，header 带 `kid`；验证时**固定算法为 EdDSA** 并校验 `kid` 与 `iss`，拒绝 `alg: none` 与未知签名
- 生产环境缺 `AUTH_JWT_ED25519_PRIVATE_KEY` 直接失败；开发环境退回临时密钥并通过返回值报告（调用方须告警）
- `GenerateSigningKey`/`EncodeSigningKey` 供运维生成密钥，避免手写 DER
- Refresh 原语：32 字节随机、只存 SHA-256、`TokensEqual` 常量时间比较
- `securityclient.Client` 接口 + `Unavailable` 实现：**所有方法 fail-closed**，不会返回 clean 或可渲染 HTML
- `middleware.RequireAuth`/`RequireSiteMatch`/`RequireRole`：Bearer 解析、401 原因细化、跨站令牌拒绝、角色门槛

尚未完成：

- 站点管理的 HTTP 端点（`/sites`、成员列表、角色变更）——领域服务与存储已就绪，只差路由
- 幂等中间件（依赖已认证 principal 才能接线）
- OAuth / 手机验证码适配器、邮箱验证发送

已完成（本轮新增）：站点服务与真实站点解析

- `site.Service`：`Resolve` / `DefaultSite` / `Membership` / `ListMembers` / `ChangeMemberRole` / `UpdateSettings`
- **解析严格性**：未知 Host 一律 `ErrNotFound`，绝不回退到"第一个站点"；唯一例外是单站点部署（库中仅一个站点且未配置域名）
- **权限矩阵**：`Can(member, action)` 单点定义，4 角色 × 4 动作全部表驱动测试
- **提权防护**：只有平台管理员能授予或撤销 `platform_admin`；站点管理员不能降级别人的平台管理员身份
- **跨站防护**：`authorize` 先校验 `actor.SiteID == siteID`，跨站直接 `ErrCrossSite`
- 角色变更与站点设置变更**在同一事务内写审计日志**
- `main` 现在注入真实 `site.Service` 作为站点解析器；`DEFAULT_SITE_ID` 不再是生效路径

实测证据：**不设置 `DEFAULT_SITE_ID`** 启动服务，注册返回 201，`/me` 返回 200 且 `site_id` 与 seed 出来的站点一致——说明解析走的是真实解析链路。

已完成（本轮新增）：认证 HTTP 层

- 路由：`POST /api/v1/auth/register/email`、`POST /auth/login/password`、`POST /auth/token/refresh`、`POST /auth/logout`、`GET /api/v1/me`
- **Cookie 策略**：refresh token 只进 `HttpOnly` cookie，`Path=/api/v1/auth`（不随普通 API 请求发送）；CSRF token 进可读 cookie；生产环境自动 `Secure` + `SameSite=None`，本地开发 `Lax`
- **双提交 CSRF**：刷新接口校验 header 与 cookie 常量时间相等，且在触达数据库之前就拒绝
- 响应体**永不包含** refresh token（有测试断言）
- 注册返回 201、登录 200、登出 204 并清 Cookie
- `cmd/seed`：幂等创建默认站点并输出 ID，供本地/Windows 初始化使用

实测证据：真实启动服务后 `POST /auth/register/email` 返回 201（480 字节 access token、43 字符 CSRF），带 Bearer 调 `GET /me` 返回 200 且 `role=member`。

已完成（本轮新增）：

- `auth.Repository` 端口 + `authstore.Store`（Ent 实现），写账号/身份/成员、轮换会话、吊销族全部在事务内完成
- `AuthService`：注册、登录、刷新、登出；密码哈希在事务外完成，避免长事务
- **重放检测**：已轮换 token 再次出现 → 吊销整个 `family_id` 并返回 `ErrRefreshReuse`
- **轮换竞态安全**：`UPDATE ... WHERE rotated_at IS NULL AND revoked_at IS NULL`，两个并发刷新只有一个成功
- **会话绑定站点**：跨站点刷新直接 `ErrSessionRevoked`
- **角色实时性**：每次签发都读当前成员角色，改角色在下一次刷新生效
- **账号枚举防护**：未知邮箱与错误密码返回完全相同的错误

### 代码生成限制（重要）

本机无法在仓库内直接跑 `ent generate`：文件一旦在工作区出现就会被扫描器映射，Windows 拒绝以写方式打开（`user-mapped section open`）。`scripts\gen.ps1` 改为**在 `%TEMP%` 的临时模块内生成再拷回**，已验证可用。改动 schema 后请用该脚本，不要直接 `go generate`。

### 偏差

- **幂等中间件推迟到 M1 后半**：幂等键必须以已认证 principal 为作用域，且存储要 Ent 落地。在 Task 5 之前它只能是无法接线的死代码。
- 计划文档中的 4 项偏差记录已更新。

## 环境约束提醒

- 一律使用 `C:\Program Files\Go\bin\go.exe`（PATH 上是 32 位）
- `go`/`cargo` 需 `HTTP_PROXY`/`HTTPS_PROXY`；用 `scripts\test.ps1` 一步搞定
- 三库矩阵、Docker、Windows 安装包在当前机器**无法验收**，只能交付文件
