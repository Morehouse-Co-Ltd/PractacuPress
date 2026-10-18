# Practacu Press 交付状态报告

**日期：** 2026-10-20
**范围：** Go 后端（`apps/api`）、Rust 安全服务（`services/security`）、契约（`packages/contracts`）
**口径：** 本文件严格区分「已实现并验证」「已实现未验证」「未实现」三档，不含推测。

---

## 1. 一句话结论

Go 后端的**身份、站点、内容、社区、媒体、审核**六个模块已完成领域层、持久化、HTTP 三层，并在本机以 SQLite 端到端验证；**消息与通知**只有领域层。**内容发布与媒体完成上传**因缺少 Rust 安全服务而按设计返回 503（fail-closed），这是当前最主要的功能缺口，不是缺陷。

---

## 2. 已实现并验证

验证方式一律是本机实跑，命令附后。

### 2.1 工程与基础设施

| 项目 | 证据 |
| --- | --- |
| 三方言数据层（sqlite/mysql/postgres），SQLite 用纯 Go 驱动 | `go test ./apps/api/internal/infrastructure/db` |
| SQLite pragma 自动补全（外键、WAL、busy_timeout） | 同上，`TestOpenSQLiteAppliesRequiredPragmas` |
| 迁移命令幂等、禁 drop column/index | `go run ./apps/api/cmd/migrate` 连跑两次成功 |
| 配置校验（缺项/非法驱动/非法 CORS 组合均启动失败） | `go test ./apps/api/internal/platform/config` |
| problem+json 错误模型，15 个稳定错误码 | `go test ./apps/api/internal/platform/errors` |
| panic → problem+json 500（不再空响应体） | `go test .../middleware -run TestRecovery` |

### 2.2 认证

| 能力 | 证据 |
| --- | --- |
| Ed25519 JWT，15 分钟，`kid`，拒绝 `alg:none` | `go test ./apps/api/internal/auth -run TestVerifyAccess` |
| Refresh 轮换 + **重放即吊销整族** | `go test .../authstore -run TestRefreshReuseRevokesWholeFamily` |
| 并发刷新竞态安全（条件更新） | `.../authstore` `RotateSession` |
| 会话绑定站点，跨站刷新作废 | `.../authstore -run TestRefreshRejectsSessionFromAnotherSite` |
| 账号枚举防护（未知邮箱与错密码同错） | `.../authstore -run TestLoginRejectsWrongPassword` |
| HttpOnly refresh cookie + CSRF 双提交 | `go test ./apps/api/internal/auth -run TestRefreshRotatesAndRequiresCSRF` |
| 响应体不含 refresh token | `.../auth -run TestRegisterReturnsSessionAndCookies` |

### 2.3 站点与权限

| 能力 | 证据 |
| --- | --- |
| Host 解析严格，未知 Host 不回退 | `go test ./apps/api/internal/site -run TestResolve` |
| 单站点部署例外（唯一站点且无域名） | `.../site -run TestResolveSingleSiteWithoutDomain` |
| 4 角色 × 4 动作权限矩阵 | `.../site -run TestCanMatrix` |
| 提权防护（仅平台管理员可授予该角色） | `.../site -run TestCanAssignRole` |
| 跨站操作拒绝 | `.../site -run TestChangeMemberRoleRejectsCrossSiteActor` |
| 站点管理四端点 + 审计同事务 | `go test ./apps/api/internal/site -run TestChangeMemberRoleSucceedsForAdmin` |

### 2.4 内容

| 能力 | 证据 |
| --- | --- |
| 状态机为数据表，5 状态 5 动作 | `go test ./apps/api/internal/content -run Test` |
| 审核模式下作者不能直发 | `.../content -run TestMemberCannotPublishDirectlyInReviewMode` |
| 作者不能审批自己的内容 | `.../content -run TestApprovingPendingReviewRequiresEditor` |
| 已发布不可编辑 | `.../content -run TestUpdateDraftRejectsPublishedContent` |
| 未清洗内容禁止发布 | `.../content -run TestPublishRequiresSanitizedRevision` |
| 清洗失败 → `pending_security_check` 落库 | `.../content -run TestCreateDraftFailsClosed` |
| 条件状态迁移（并发审核只有一个成功） | `.../contentstore -run TestStaleTransitionIsRejected` |
| 游标分页（复合边界、短页不发游标） | `.../content -run TestListAfter` |

### 2.5 社区 / 媒体 / 审核

| 能力 | 证据 |
| --- | --- |
| 评论深度上限、隐藏后不可编辑 | `go test ./apps/api/internal/community -run Test` |
| 点赞/收藏/关注幂等（两层：服务 `Changed` + 唯一索引） | `.../community`、`.../communitystore` |
| 上传仅接受闭集 MIME，拒绝 svg/html/exe | `go test ./apps/api/internal/media -run TestValidateRequest` |
| 存储键不含用户文件名（路径穿越不可能） | `.../media -run TestStorageKeyIgnoresUserPath` |
| 扫描不可用 → 不创建 asset | `.../media -run TestCompleteUploadFailsClosed` |
| 举报去重、只有被指派人可结案 | `go test ./apps/api/internal/moderation -run Test` |

### 2.6 运行时冒烟（真实进程）

| 检查 | 结果 |
| --- | --- |
| `GET /healthz` | 200 `{"status":"ok"}` |
| `GET /readyz`（真连数据库） | 200 `{"status":"ready"}` |
| `POST /api/v1/auth/register/email` | 201，access token + CSRF |
| `GET /api/v1/me`（Bearer） | 200，含 role 与 site_id |
| `POST /api/v1/media/uploads` | 201，storage_key 形如 `01/01a14d...png` |
| `POST /api/v1/media/uploads/{id}/complete` | **503**（无扫描服务，fail-closed） |
| `POST /api/v1/comments`（未认证） | 401 |
| 未知路由 | 404 + problem+json |

### 2.7 Rust 安全库

| 能力 | 证据 |
| --- | --- |
| Argon2id 哈希/校验、长度边界、明文 zeroize、PHC 输出 | `cargo test`（在 `services/security`） |
| 白名单清洗：script/iframe/object/embed/事件属性/`javascript:` 全移除 | 同上 |
| 输出确定 + 携带 `policy_version` + 违规项 | 同上 |

**结果：14 passed, 0 failed。** 注意必须用 MSVC 工具链：
`rustup run stable-x86_64-pc-windows-msvc cargo test`。

---

## 3. 已实现但未验证

| 内容 | 为什么未验证 |
| --- | --- |
| MySQL / PostgreSQL 支持 | 本机无这两个数据库，也无 Docker；代码层无方言依赖，但**没有实跑过** |
| `cmd/migrate` 对 MySQL/PG | 同上 |
| 通知领域层 | 有单元测试，但未接存储与路由（无集成测试） |
| 消息领域层 | 同上 |

---

## 4. 未实现

| 模块 | 状态 |
| --- | --- |
| Rust gRPC 服务端 | **阻塞**：cargo 无法经代理访问 `index.crates.io`（PowerShell 直连同地址为 200）。协议已定稿于 `packages/contracts/security/v1/security.proto` |
| 内容发布 / 媒体完成上传的真实路径 | 依赖上一条 |
| 搜索模块 | 未开始 |
| 通知 / 消息的存储与路由 | 未开始 |
| Outbox worker、WebSocket、事件补偿 | 未开始 |
| OpenAPI 3.1 契约文件 | 未开始（只有占位的 `/api/v1/openapi.json`） |
| Docker 三 profile、Windows 安装包、备份恢复 | 未开始；本机无 Docker / WiX，即使写了也无法验收 |

---

## 5. 如何运行

```powershell
# 1) 工具链（PATH 上的 go 是 32 位，必须用 64 位）
$env:PATH = 'C:\Program Files\Go\bin;' + $env:PATH

# 2) 代理（go/cargo 都不读 WinINET 设置）
$env:HTTP_PROXY='http://127.0.0.1:7890'; $env:HTTPS_PROXY='http://127.0.0.1:7890'

# 3) 建库与站点
$env:DATABASE_DRIVER='sqlite'
$env:DATABASE_DSN='file:./data/practacu.db'
go run ./apps/api/cmd/seed -driver sqlite -dsn $env:DATABASE_DSN

# 4) 启动
$env:APP_ENV='development'; $env:HTTP_ADDR='127.0.0.1:8080'
$env:SECURITY_GRPC_ADDR='127.0.0.1:9001'
go run ./apps/api/cmd/server

# 5) 验证
go test ./...
powershell -ExecutionPolicy Bypass -File scripts\test.ps1

# 6) 改 schema 后重新生成（必须用脚本，见第 6 节）
powershell -ExecutionPolicy Bypass -File scripts\gen.ps1
```

---

## 6. 本机环境注意事项

1. **PATH 上的 `go` 是 32 位**（`C:\Program Files (x86)\Go`），一律用 `C:\Program Files\Go\bin\go.exe`。
2. **Go/cargo 不读 WinINET 代理**，必须显式设 `HTTP_PROXY`/`HTTPS_PROXY`。
3. **不能直接 `go generate ./apps/api/ent/...`**：文件一旦出现在工作区就可能被扫描器映射，Windows 拒绝写打开（`user-mapped section open`）。必须用 `scripts\gen.ps1`（临时模块内生成再拷回）。
4. **Rust 必须用 MSVC 工具链**：GNU 目标在遇到需要导入库的 crate 时报 `dlltool.exe not found`。
5. **PowerShell 5.1 读写 UTF-8 源文件会破坏中文**，含中文的 Go 源请用编辑器工具修改，不要用 `Get-Content`/`Set-Content` 批量替换。

---

## 7. 测试总量

| 包 | 状态 |
| --- | --- |
| Go | 21 个包全绿（含 8 个集成测试包，真实 SQLite） |
| Rust | 14 个单元测试全绿 |

提交数：39。工作树干净。

---

## 8. 下一步建议

1. **解封 Rust**：在有网环境跑一次 `cargo fetch` 预热缓存，或修复 cargo 代理；然后实现 gRPC 服务端，Go 侧把 `securityclient.Unavailable` 换成真实客户端 —— 这一步能让"发布内容"与"上传图片"真正可用。
2. **Outbox + WebSocket**：M3 的核心，事件补偿端点依赖 `outbox_events.audience_user_id`（表已就绪）。
3. **OpenAPI 契约**：前端团队开工的前提，且能让契约测试有输入。
4. **CI 三库矩阵**：本地无法验证，必须在 CI 上跑。

---

## 9. 最终验收（2026-10-20 收尾补记）

### 9.1 命令与结果

```text
go build ./...        exit 0
go vet ./...          exit 0
go test ./... -count=1  23 个包 ok，0 FAIL
cargo test（MSVC）      14 passed, 0 failed
提交数 44，工作树干净，跟踪 267 个文件
```

### 9.2 自第 8 节以来新增并已验证

| 模块 | 内容 | 证据 |
| --- | --- | --- |
| Outbox worker | 指数退避、上限放弃、毒事件不阻塞批次 | `go test ./apps/api/internal/outbox` |
| Outbox 存储 | 条件更新实现独占租约，租约过期可重claim | `.../outboxstore -run TestClaimMarksEventsInvisible` |
| **事件补偿** | `GET /api/v1/events?after_id=&limit=`，按 `audience_user_id` 隔离 | `.../outboxstore -run TestReplayHidesOtherUsersEvents`；实跑 200 / 无令牌 401 |
| 消息领域 | 站点隔离先于成员校验，游标只前进 | `go test ./apps/api/internal/messaging` |
| 通知领域 | 单收件人、已读幂等、payload 受限 | `go test ./apps/api/internal/notifications` |

### 9.3 评审提出的 P0 漏洞闭环情况

| 编号 | 问题 | 状态 |
| --- | --- | --- |
| P0-1 | 缺 sessions 表，无法做轮换与重放检测 | ✅ 已建表并实现，回归测试覆盖 |
| P0-2 | outbox 无收件人维度，事件补偿会跨用户泄露 | ✅ 已加 `audience_user_id`，查询层过滤，回归测试覆盖 |
| P0-5 | 缺 media_uploads 表，两阶段上传无法实现 | ✅ 已建表并实现两阶段流程 |

### 9.4 仍然未完成（明确清单）

| 项 | 原因 |
| --- | --- |
| Rust gRPC 服务端 | cargo 无法经代理访问 `index.crates.io`（PowerShell 直连为 200）；协议已定稿 |
| 内容发布 / 媒体完成上传的真实路径 | 依赖上一条；当前按设计返回 503 |
| WebSocket 实时推送与一次性票据 | 未开始；REST 补偿已可用，可作为其回退 |
| 搜索模块 | 未开始 |
| 通知 / 消息的存储与 HTTP 路由 | 仅领域层 |
| OpenAPI 3.1 契约文件 | 未开始 |
| Docker 三 profile、Windows 安装包、备份恢复 | 未开始；本机无 Docker/WiX，即使实现也无法验收 |
| MySQL / PostgreSQL 实跑 | 本机无数据库，代码无方言依赖但未验证 |

### 9.5 结论

目标中"审查计划 → 评估可行度 → 详细分步策划 → 开始实现 Go 后端并保证编译与测试通过"**已达成**：
评审报告、详细计划、进度记录、交付报告四份文档齐备，Go 侧 23 个包与 Rust 侧 14 个测试全绿。

"完整交付可上线的系统"**未达成**，缺口已在 9.4 逐项列出，主要卡在 Rust gRPC 服务端的网络阻塞与部署工具链缺失两处环境问题上，而非代码方向问题。
---

## 10. 安全服务接通（2026-10-20 第二轮补记）

### 10.1 结论

**Rust gRPC 安全服务已实现、已编译、已被 Go 调用。** 内容发布链路与媒体上传链路不再是 503。

### 10.2 做了什么

| 项 | 内容 |
| --- | --- |
| 工具链 | `protoc 29.3`（`C:\tools\protoc`）+ `protoc-gen-go` / `protoc-gen-go-grpc` |
| Go stub | `packages/contracts/security/v1/gen/`（`security.pb.go`、`security_grpc.pb.go`） |
| 客户端 | `securityclient.GRPC`：超时、错误归一（`ErrUnavailable`）、未指定扫描状态一律视为 `needs_manual_review` |
| 服务端 | `services/security`：`HashPassword` / `VerifyPassword` / `SanitizeContent` / `InspectUpload` / `ValidateSecurityPolicy` |
| 接线 | `main.dialSecurity` 启动时连接并 `Ping`；连不上则退回 fail-closed 桩并告警，API 仍可服务 |

### 10.3 端到端实测（release 构建）

```
security service connected  addr=127.0.0.1:19003
register = 201                      ← 密码经 Rust Argon2id 哈希
create   = 201  status=draft
         policy=2026-10-18.1         ← 来自 Rust 服务
         rendered=<h1>Hi</h1><p>ok</p>   ← <script> 已被移除，安全标签保留
submit   = 200  status=pending_review
complete = 200  scan=needs_manual_review
```

### 10.4 两个必须记录的坑

1. **Argon2 在 Rust debug 构建里超过 3 秒**，导致 `DeadlineExceeded`。改用 `cargo build --release` 后正常——生产本就该用 release。
2. `grpc.NewClient("bufconn")` 会走 DNS 解析，测试里必须写 `passthrough:///bufconn`。

### 10.5 仍然存在的缺口

| 项 | 说明 |
| --- | --- |
| 媒体 `complete` 只到 `needs_manual_review` | 还没有存储适配器，服务端拿不到文件字节，无法做魔数校验；这是**真实缺口**，不是配置问题 |
| WebSocket | 未实现；REST 补偿端点可用 |
| 搜索、通知/消息路由 | 未实现 |

### 10.6 验证

```
go build ./...        exit 0
go vet ./...          exit 0
go test ./... -count=1   23 个包 ok, 0 FAIL
cargo test               23 passed, 0 failed
双服务端到端             见 10.3
```
---

## 11. 媒体存储接通（2026-10-20 第三轮补记）

### 11.1 结论

媒体两阶段上传**全链路打通**：声明 → 传字节 → 扫描 → `clean`。

### 11.2 做了什么

| 项 | 内容 |
| --- | --- |
| 存储端口 | `media.Storage`：`Put` / `ReadHead` / `Delete` |
| 本地实现 | `LocalStorage`：按声明大小硬限拷贝、密钥解析后做根目录包含校验、`ReadHead` 采样上限 64 字节 |
| 服务 | `StoreContent`（校验所有者/过期/大小）、`CompleteUpload` 现会读样本交给扫描器 |
| 端点 | `POST /api/v1/media/uploads/{uploadID}/content`（multipart `file`） |
| 配置 | `STORAGE_DIR`，默认 `./data/media` |
| 契约 | OpenAPI 已补该端点，契约测试通过 |

### 11.3 端到端实测

```
create   = 201
upload   = status: uploaded                      ← 8 字节真实 PNG 头写入磁盘
complete = scan_status: clean, scan_reason: ok    ← Rust 校验魔数通过
```

### 11.4 安全性质（均有测试）

- 密钥含 `..`、反斜杠、前导斜杠、盘符一律 `ErrStorageKeyUnsafe`
- 流式写入超过声明大小会被 `io.CopyN` 截断并报错，**不会多写一个字节**
- 无存储适配器时 `CompleteUpload` 只拿到空样本 → `needs_manual_review`，绝不假定干净

### 11.5 仍然缺的

| 项 | 说明 |
| --- | --- |
| S3 兼容存储 | 只有 `LocalStorage`，接口已留好 |
| 媒体读取/下载端点 | 尚未提供，前端还无法展示已上传文件 |
| 拒绝时清理对象 | 当前保留以便审计，未做垃圾回收 |
| WebSocket、搜索、通知/消息路由 | 未实现 |
---

## 12. 媒体下载端点（2026-10-20 第四轮补记）

### 12.1 结论

媒体链路完整：**上传 → 扫描 → 下载**。

### 12.2 新增

| 项 | 内容 |
| --- | --- |
| 存储端口 | `Storage` 增加 `Open` |
| 服务 | `OpenAsset`：站点范围内查找，仅 `clean` 可下载 |
| 端点 | `GET /api/v1/media/{assetID}`，流式返回 |
| 响应头 | `X-Content-Type-Options: nosniff`、`Content-Disposition: inline`、`Cache-Control: private, max-age=300` |
| 契约 | OpenAPI 已补，契约测试通过 |

### 12.3 安全性质

- **被拒绝的资源一律 `404`**：连"它存在"都不透露，上传者本人也拿不到
- 响应 MIME 来自数据库里的 asset，不来自请求
- 站点范围校验：跨站 id 返回 `404`
- 未认证 `401`

### 12.4 端到端实测

```
scan           = clean
download       = 200, content-type image/png
bytes          = 8, 与上传内容逐字节相同
without token  = 401
```

### 12.5 仍然缺的

| 项 | 说明 |
| --- | --- |
| S3 兼容存储 | 只有本地实现，接口已留好 |
| 拒绝时清理对象 | 保留以便审计，未做垃圾回收 |
| 匿名图片访问 | 目前所有媒体都需要登录；公开文章内嵌图片要等"站点可见性 + 匿名读"实现 |
| WebSocket、搜索、通知/消息路由 | 未实现 |