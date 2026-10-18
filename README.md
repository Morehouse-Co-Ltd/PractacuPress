# Practacu Press

多站点社区型 CMS 的后端。首版不包含前端，所有能力通过 REST（OpenAPI 3.1）与 WebSocket 暴露。

- **Go API**（`apps/api`）：身份、站点、内容、社区、媒体、通知、私信、事件补偿
- **Rust 安全服务**（`services/security`）：Argon2id 密码哈希、内容清洗、上传检查
- **契约**（`packages/contracts`）：OpenAPI 3.1 与 protobuf

---

## 快速开始（Windows）

前提：Go 1.26+、Rust（`rustup`，MSVC 工具链）、Node 未使用可不装。

```powershell
powershell -ExecutionPolicy Bypass -File scripts\dev.ps1
```

它会：建库并创建默认站点 → 起 Rust 安全服务 → 起 Go API → 等 `/healthz` 就绪 → 打印地址。按 `Ctrl+C` 一起停掉。

首次运行会编译 Rust（约 4 分钟）。之后可加 `-SkipSecurity` 跳过安全服务（此时发布内容与完成上传会返回 503，这是设计行为，不是故障）。

```
API        http://127.0.0.1:8080
OpenAPI    http://127.0.0.1:8080/api/v1/openapi.json
healthz    http://127.0.0.1:8080/healthz
```

### 手动启动

```powershell
$env:PATH = 'C:\Program Files\Go\bin;' + $env:PATH
$env:APP_ENV='development'; $env:HTTP_ADDR='127.0.0.1:8080'
$env:DATABASE_DRIVER='sqlite'; $env:DATABASE_DSN='file:./data/practacu.db'
$env:SECURITY_GRPC_ADDR='127.0.0.1:9001'; $env:STORAGE_DIR='./data/media'

go run ./apps/api/cmd/seed  -driver sqlite -dsn $env:DATABASE_DSN
go run ./apps/api/cmd/migrate                      # 只建表，不建站点
go run ./apps/api/cmd/server
```

Rust 侧：

```powershell
cd services/security
rustup run stable-x86_64-pc-windows-msvc cargo run --release
```

---

## 试一下

```powershell
# 注册（拿到 access token）
$r = Invoke-RestMethod http://127.0.0.1:8080/api/v1/auth/register/email -Method Post `
  -ContentType 'application/json' `
  -Body '{"email":"a@example.com","password":"correct horse battery","display_name":"A"}'
$token = $r.access_token

# 当前用户
Invoke-RestMethod http://127.0.0.1:8080/api/v1/me -Headers @{ Authorization = "Bearer $token" }

# 创建文章（内容会经 Rust 清洗，<script> 会被移除）
Invoke-RestMethod http://127.0.0.1:8080/api/v1/articles -Method Post `
  -Headers @{ Authorization = "Bearer $token" } -ContentType 'application/json' `
  -Body '{"title":"Hello","source_body":"<h1>Hi</h1><script>alert(1)</script>"}'
```

未认证也能读公开站点：`Invoke-RestMethod http://127.0.0.1:8080/api/v1/articles`

---

## 目录结构

```
apps/api/
  cmd/{server,migrate,seed}        进程入口与运维命令
  ent/schema/                      持久化模型（Ent）
  internal/
    auth/ site/ content/           业务模块（domain + service + handler）
    community/ messaging/ notifications/ moderation/ media/
    outbox/                        可靠事件与重试
    platform/{config,logging,errors,page}
    infrastructure/                Ent 仓储、存储适配器、Rust gRPC 客户端
    transport/{http/gin,ws}        HTTP 中间件与 WebSocket
services/security/                 Rust 安全服务（tonic）
packages/contracts/                OpenAPI 与 protobuf（生成代码也在这里）
docs/superpowers/                  设计稿、实施计划、评审报告、交付状态
scripts/                           dev / test / gen 脚本
```

---

## 测试

```powershell
powershell -ExecutionPolicy Bypass -File scripts\test.ps1     # go build + vet + test
```

Rust：

```powershell
cd services/security
rustup run stable-x86_64-pc-windows-msvc cargo test
```

S3 适配器默认跳过，需要真实端点（MinIO / moto / AWS）：

```powershell
python -m moto.server -p 9100
$env:S3_TEST_ENDPOINT='http://127.0.0.1:9100'
$env:AWS_ACCESS_KEY_ID='test'; $env:AWS_SECRET_ACCESS_KEY='testsecret'
go test ./apps/api/internal/media/ -run TestS3 -v
```

---

## 配置

见 [.env.example](.env.example)。几个容易踩的点：

| 变量 | 说明 |
| --- | --- |
| `DATABASE_DRIVER` | `sqlite` / `mysql` / `postgres`。SQLite 的 pragma 由服务端自动补 |
| `SECURITY_GRPC_ADDR` | Rust 服务地址。**连不上时发布与上传会返回 503**，这是 fail-closed |
| `AUTH_JWT_ED25519_PRIVATE_KEY` | 生产必填；开发环境未配置会自动生成临时密钥并告警 |
| `TRUSTED_PROXIES` | 留空表示不信任任何代理，`X-Forwarded-*` 全被忽略 |
| `STORAGE_DRIVER` | `local` 或 `s3`。S3 需要 `STORAGE_S3_BUCKET` |

---

## 已知限制

| 项 | 说明 |
| --- | --- |
| MySQL / PostgreSQL | 代码层无方言依赖，但**本机没有这两个数据库，未实跑验证**，需在 CI 上跑矩阵 |
| Docker / Windows 安装包 | 未实现 |
| WebSocket 多副本 | 票据与 hub 在进程内存，多副本部署需要共享存储 |
| 限流 | 进程内固定窗口，多副本下是每副本独立计数 |
| S3 上传内存占用 | 受 SigV4 限制需先缓冲，上限等于单文件上限（25 MiB） |
| 未实现 | 前端 SDK 生成、OAuth 适配器、手机验证码、搜索分页游标 |

更细的现状见 [交付状态报告](docs/superpowers/reports/2026-10-20-delivery-status.md)。

---

## 设计文档

- [产品与技术设计](docs/superpowers/specs/2026-10-18-practacu-press-design.md)
- [计划评审与可行性](docs/superpowers/reviews/2026-10-18-practacu-press-plan-review.md)
- [详细实施计划](docs/superpowers/plans/2026-10-18-practacu-press-backend-detailed-plan.md)
- [实施进度](docs/superpowers/plans/2026-10-18-practacu-press-progress.md)
