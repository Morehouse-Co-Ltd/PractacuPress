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

- **幂等中间件推迟到 M1**：幂等键必须以已认证 principal 为作用域，且存储要 Ent 落地。在 Task 5 之前它只能是无法接线的死代码。计划文档中的 4 项偏差记录已更新。
- **M1 尚未开始**：下一步实现 `auth` 域的令牌原语（Ed25519 JWT + opaque refresh + 重放检测），再补 service 与 handler。

## 环境约束提醒

- 一律使用 `C:\Program Files\Go\bin\go.exe`（PATH 上是 32 位）
- `go`/`cargo` 需 `HTTP_PROXY`/`HTTPS_PROXY`；用 `scripts\test.ps1` 一步搞定
- 三库矩阵、Docker、Windows 安装包在当前机器**无法验收**，只能交付文件
