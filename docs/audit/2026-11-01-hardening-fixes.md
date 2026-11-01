# 第二批修复：L-1 / L-2 / DATA-3 / DATA-4

**日期：** 2026-11-01
**来源：** `docs/audit/2026-10-31-audit-report.md` 里的两条 Lead 发现（L-1、L-2）与两条 Medium（DATA-3、DATA-4）
**状态：** 4 条全部修复并验证；Go 30 包、Web 301 项、Rust 41 项、以及一次**带安全服务的全栈端到端**全部通过。

---

## L-1 请求没有 deadline，注释却声称有

### 问题
`cmd/server/main.go` 故意不设 `WriteTimeout`（WebSocket 与下载需要长连接），但注释写着「Per request deadlines are applied by middleware instead」——而全仓库 grep 不到任何这样的中间件。后果：慢客户端可以把 handler 连同它占用的数据库连接一起无限期挂住；SQLite 连接池上限是 1，等于全站串行。

### 修复
| 文件 | 内容 |
|---|---|
| `middleware/timeout.go`（新） | `RequestTimeout(d, exempt)`：给请求上下文加 deadline（**这才释放数据库连接**），同时用 `http.NewResponseController` 设写 deadline（**这才挡住不读响应的客户端**），并在返回时清掉写 deadline —— 它是绝对时间且挂在连接上，留着会让同一 keep-alive 连接上的下一个请求继承一个可能已过期的期限 |
| `middleware/timeout.go` | `LongLivedRequests`：`Upgrade` 头、`/api/v1/ws`、`/api/v1/media/` 豁免。下载与上传本来就慢，卡 deadline 会把正常传输切断——这也正是服务端不设全局 `WriteTimeout` 的原因 |
| `platform/config/config.go` | `HTTP_REQUEST_TIMEOUT_SECONDS`，默认 30s，0 表示关闭 |
| `router.go` | 在 RequestID / Recovery / ErrorHandler 之后挂载 |
| `middleware/timeout_test.go`（新） | 5 个用例：上下文真的被取消、慢 handler 被释放、WS 与下载不被切断、Upgrade 头豁免 |

**注释也改了**：原文「由 middleware 应用」现在是事实而不是愿望。

---

## L-2 SQLite 真实启动路径只补 `foreign_keys`，不补 WAL 与 busy_timeout

### 问题
`EnsureSQLitePragmas` 只追加 `foreign_keys(1)`；带 WAL 与 `busy_timeout` 的 `SQLiteDSN()` **只在测试里用**。于是真实的 `DATABASE_DSN` 路径跑在 rollback journal 模式、`busy_timeout=0` 下：读写互斥，竞争者立刻 `SQLITE_BUSY`。`.env.example` 里「the server adds the required pragmas (foreign keys, WAL, busy timeout) itself」这句话当时是假的。

### 修复
`internal/infrastructure/db/client.go`：`EnsureSQLitePragmas` 现在追加 `foreign_keys(1)` + `journal_mode(WAL)` + `busy_timeout(5000)`。
**保留逃生口**：DSN 里只要已经出现 `_pragma`，整串原样返回——那是运维显式写下的选择，替它追加默认值既意外又无法覆盖。

### 测试
| 文件 | 用例 |
|---|---|
| `db/pragma_test.go`（新） | ① 纯函数：`file:x.db` 与 `file:x.db?cache=shared` 都含三条 pragma；显式 `_pragma` 不被改动 ② **端到端**：用真实启动路径的 DSN `Open` 后写一行数据，断言 `-wal` 文件真的出现（rollback journal 模式下永远不会出现） |

---

## DATA-3 请求体没有上限

### 问题
multipart 上传在校验「声明大小」之前就已整份落盘/进内存，一个已登录客户端可以填满磁盘。

### 修复
| 文件 | 内容 |
|---|---|
| `middleware/body_limit.go`（新） | `BodyLimit(default, rules...)`，按前缀给单条路由更大的额度；`http.MaxBytesReader` 在读取时截断，断掉的连接也不会被复用 |
| `platform/config/config.go` | `MAX_REQUEST_BODY_BYTES`，默认 4 MiB（最大的合法 JSON 是 20 万字符的文章正文，UTF-8 下不到 1 MiB，四倍留足余量），上限 64 MiB，0 关闭 |
| `router.go` | 全局 4 MiB + 上传路由 `media.MaxAttachmentBytes + 1 MiB`（25 MiB + multipart 框架开销） |
| `media/handler.go` | 上传读到 `*http.MaxBytesError` 时明确回「上传文件超出允许的大小」，而不是误导性的「缺少 file 字段」 |
| `middleware/timeout_test.go` | 3 个用例：超限被拒且错误可识别、未超限正常、上传路由的大额度只对上传生效 |

---

## DATA-4 媒体下载对匿名返回 401，文章里的图片对未登录读者全裂

### 问题
`GET /media/{assetID}` 挂的是 `optionalAuth`，但 handler 直接要求 principal → 匿名 401。契约里这条是 `security: []`，实现与契约相反，而这也是最直接的可见缺陷：已发布文章里的图片，未登录读者一张都看不到。

### 修复
| 文件 | 内容 |
|---|---|
| `media/service.go` | 新增 `OpenAssetInSite(ctx, siteID, assetID)`；`OpenAsset(actor, …)` 委托给它。站点范围与「只有 clean 可下载」两条规则不变 |
| `media/handler.go` | `downloadForCaller`：有会话按**令牌站点**取（所以 A 站成员打 B 站域名也拿不到），无会话按**解析出的站点**取；members_only 站点匿名仍然 401 |
| `cmd/server/main.go` | 注入 `Site` |
| `media/handler_anonymous_test.go`（新） | 3 个用例：members_only 匿名 401、无解析站点 404、服务层跨站与 rejected 资源都返回 NotFound |

**没动的**：上传端点仍然必须登录；`Referenceable()`（只有 clean）在匿名路径上同样生效。

---

## 验证（全部实跑）

```
go build ./...   exit 0      go vet ./...  exit 0
go test ./...    30 包全 ok
vitest           26 files / 301 tests   (未改动前端，回归确认)
cargo test       41 passed
```

**带安全服务的全栈端到端**（`AUTH_CREDENTIAL_RATE_LIMIT_PER_MINUTE=1000`，`MAX_REQUEST_BODY_BYTES=1048576`）：

```
SECURITY running=True
READY=ready
ROLE=platform_admin
UPLOAD=<id> status=pending
CONTENT_STATUS=200 status=uploaded
COMPLETE scan=clean reason=ok          ← 真 Rust 服务做的魔数校验
ANON_DOWNLOAD=200 type=image/png bytes=8   ← DATA-4：未登录读者拿到图片
OVERSIZE=400                                ← DATA-3：2 MB 请求体被拒
```

---

## 本轮改动文件

**新增**：`middleware/timeout.go`、`middleware/body_limit.go`、`middleware/timeout_test.go`、`db/pragma_test.go`、`media/handler_anonymous_test.go`
**修改**：`router.go`、`internal/infrastructure/db/client.go`、`internal/media/{service,handler}.go`、`internal/platform/config/config.go`、`cmd/server/main.go`、`.env.example`

---

## 仍未处理（按建议顺序）

| 编号 | 问题 |
|---|---|
| AUTH-2 | refresh 族没有绝对寿命（滑窗 30 天可无限续命） |
| AUTH-3/4 | 登录无按账号节流；未知邮箱提前返回 + 禁用账号专属码造成枚举 |
| AUTH-5 | 限流内存表 50k 上限没被强制，且清理是全局锁下的 O(n) |
| AUTH-6 | 任意 site_admin 可声明任意未占用域名（`domain_verification_token` 从不写入） |
| DATA-1 | taxonomy 的匿名读绕开 members_only（与 content/media 的判定不一致） |
| DATA-2 | 分析埋点允许未认证写入；报表把整个窗口读进内存 |
| DATA-5/6 | 通知从不产生；审核模块没有 HTTP 面（功能未接线，不是安全缺陷） |
| SEC-2…S-12 | violations 丢弃、policy_version 不校验、ErrUnavailable 不覆盖 Unknown/Internal 等 |

建议下一批：**AUTH-5 + AUTH-2**（限流与会话的正确性，都只需小改动），然后 **DATA-1 + DATA-2**（一致性），最后 **AUTH-6**（需要产品定夺域名所有权验证流程）。
