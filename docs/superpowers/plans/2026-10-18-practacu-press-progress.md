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

- `/auth/*` 与 `/me` 路由及 HTTP 集成测试
- Cookie/CSRF 下发（service 已产出 CSRF token，尚未落到响应头）
- 幂等中间件（依赖已认证 principal 才能接线）

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
