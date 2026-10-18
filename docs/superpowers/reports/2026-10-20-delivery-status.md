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
