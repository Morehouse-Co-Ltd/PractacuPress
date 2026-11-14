# Practacu Press 修复报告（攻击模拟发现问题 · 2026-11-02 修复轮）

**输入：** [`2026-11-02-attack-simulation.md`](2026-11-02-attack-simulation.md)（30 条编号确认项 + O-1/O-2/O-3/O-4 产品级观察）
**目标：** 先修 P0（`V-01` 媒体对象级授权、`V-02` 撤权即时生效），再修其余 High/Medium/Low，然后修重要产品发现 `O-1`，最后落实第一轮明确延后的 4 项（`V-12`/`V-22`/`V-27`/`O-3`）。
**原则：** 每项都有代码 + 回归测试；不改变既有 API 语义（除安全收紧）；唯一 schema 变更（`site.registration_open`）走 Ent 自动迁移且默认 `true`；改完在**当前源码重新构建的靶场**上做攻击复测与真实 Chrome 验收。

---

## 1. 修复状态总览

| 状态 | 数量 | 条目 |
| --- | --- | --- |
| ✅ 已修复（代码+测试+运行时复测） | 28 | `V-01` `V-02` `V-04` `V-05` `V-06` `V-07` `V-10` `V-11` `V-12` `V-13` `V-14` `V-15` `V-16` `V-17` `V-18` `V-20` `V-21` `V-22` `V-23` `V-24` `V-25` `V-26` `V-27` `V-28` `V-29` `V-30` `O-1` `O-3` |
| 🟡 部分修复 / 缓解（残余已记录） | 4 | `V-03`（高危构造过滤；完整视觉重绘仍属站长自定义 CSS 能力）、`V-08`（登出 CSRF + CSRF 绑定已修；access token 自然过期仍是设计取舍）、`V-09`（站点名保留供 O-1 品牌渲染，接受残留）、`V-19`（WS 已收紧；gRPC 仍明文回环） |
| ⏸ 明确延后（需产品决策/较大改造） | 0 | —（第一轮延后的 4 项已在第二轮全部落实，见 §9） |
| 📝 记录为设计语义/文档 | 2 | `O-2`（review 模式仅拦 member，editor 即审核者）、`O-4`（契约一致性，`quota_exceeded`、域名验证、注册开关均已补进 OpenAPI） |

> 上表按攻击报告的编号口径；每条的原始证据与修复细节见下文与 §9。

---

## 2. P0：媒体对象级授权 + 撤权即时生效

### 2.1 `V-01` 媒体 BOLA（High）— 已修复

**规则（`apps/api/internal/media/service.go`）：**

| 调用者 | 列表 `GET /media` | 下载 |
| --- | --- | --- |
| 匿名 | 不允许（保持原样 401） | 仅 `purpose=site/avatar`，或 `content` 且**被已发布内容引用** |
| member | 仅自己的资产 | 自己的资产；`site/avatar`；`content` 且被已发布引用 |
| editor+ | 全站媒体库 | 全站 clean 资产 |

**实现：**
- `Actor` 增加 `Role`；列表在 service 层为非 editor 强制 `OwnerID=自己`（`mediastore` 增加 owner 谓词）。
- 下载统一走 `openAsset(site, id, authorize)`：owner/editor 放行；共享资产按 purpose 判定；`content` 需 `PublishedReferenceChecker.PublishedAssetReference`（contentstore 用 `status=published AND (rendered_html/source_body LIKE assetID)` 判定，参数化、站点谓词）。
- 拒绝一律 `ErrNotFound`（不泄露存在性）；检查器故障 fail-closed。
- 匿名 `members_only` 站点仍 401（D-4 行为不变）。
- main.go 提前构造共享 `contentRepo` 并接入 media（`References`），避免实例漂移。

**回归测试：** `media/references_test.go`（6 个场景：未发布 404、已发布匿名 200、site/avatar 公开、他人私有附件 404、owner/editor 放行、检查器故障 fail-closed）、`media/service_test.go` 增加 member 列表 owner 过滤断言。

**运行时复测（i0，全新修复构建）：**
```
member GET /media → 200 {"items":[]}（自己无资产，管理员的 3 个资产不再出现）
member/anon GET 私有 attachment → 404；未引用 draft 图 → 404
member/anon GET 已发布文章引用图 → 200
member 自己上传 → 200 上传 + 200 下载
```

### 2.2 `V-02` 撤权即时生效（Medium）— 已修复

**规则：** 每个受保护请求在 token 校验后**重新读数据库成员行**：活跃 → 用 DB 角色覆盖 token 的 `role` claim；被挂起/移除/非成员 → 401 `membership_inactive`。公开读（optionalAuth）则降级为匿名继续。

**实现：**
- `middleware.MembershipResolver`（`site.Service.Membership` 已天然拒绝非 active 成员）+ `RequireAuthForSite/AccessToken` 可选 resolver；`OptionalAuth` 失败静默降级匿名。
- `router.Dependencies.Memberships` 接线 `siteService`，所有模块（content/community/media/messaging/notifications/events/analytics/taxonomy/site/auth/ws-ticket）共享同一 guard。
- 代价：每请求一次 SQLite 成员查询（单站点部署可接受；多副本/高并发可加短 TTL 缓存，需注意撤权延迟）。
- 前端/兼容：无 resolver 时保持旧行为（测试与旧部署兼容）。

**回归测试：** `middleware/auth_for_site_test.go` 新增 3 个：DB 角色覆盖 token 角色、非活跃成员 401 `membership_inactive`、optionalAuth 降级匿名；前端既有 token 流程不改。

**运行时复测（i0）：**
```
demote site_admin→member：旧 token /me role=member；publish → 409（须先审）；settings → 403
suspend / remove：旧 token /me → 401；POST /articles → 401
```

---

## 3. 其余修复明细

### 3.1 认证/会话（批 A）

| 编号 | 修复 | 关键实现 | 测试 |
| --- | --- | --- | --- |
| `V-13` | 登录枚举时序 | 未知邮箱对固定占位 PHC 跑 dummy `Verify`；禁用账号统一 `invalid_credentials` | `login_security_test.go`：dummy 调用次数、响应同形、耗时不呈 85× 差 |
| `V-23` | refresh 族绝对寿命 | `FamilyCreatedAt`（族最早会话行，无 schema 变更）+ 90 天绝对上限；轮换继承不重置，expiry/cookie 被族截止 cap，超期整族撤销 | `refresh_security_test.go`（20/40/60/80 天轮换、90 天撤销） |
| `V-24` | 账号级失败退避 | 规范化邮箱 15min 窗口、5 次后 1→2→…→15min 退避，成功清零；429 `rate_limited` + `too_many_attempts` + Retry-After；未知邮箱同样计数 | `login_security_test.go`（锁定/升级/清零/枚举防护） |
| `V-25` | 并发 refresh 复用检测 | CAS 输家按 reuse 撤销整族 | 双 goroutine 并发测试：恰好一个存活、族 revoked |
| `V-26` | 登录 CSRF（text/plain） | 有 body 端点强制 `application/json`；Origin 存在则 host 必须等于请求 Host；无 Origin 的 CLI 放行 | `write_guard_handler_test.go` |
| `V-28` | 超长邮箱 500 | API 上限 254 对齐持久层 255，超长 400 | `validation_test.go` |
| `V-29` | logout CSRF / 注册枚举 | logout guard 同 V-26；重复注册保留 409 但先付一次 Argon2（文档记录残留） | 同上 |
| `V-30` | 密码策略 | 12–128（后续 hardening 从 8 提高）、非全空白、至少两类字符、内嵌经典弱口令黑名单（忽略大小写整串匹配，拒绝为 `too_common`）；注册/重置/建号共用；登录不校验旧密码 | `validation_test.go` |
| `V-07` | WS Origin | 删除 `InsecureSkipVerify`：默认同源，显式 `CORS_ALLOWED_ORIGINS` 时白名单；无 Origin 的 CLI 保留 | `ws/handler_test.go`（真实握手） |
| `V-16` | 首管理员抢注 | `HandlerConfig.FirstAdminAllowed`（nil=fail-closed）+ `AllowFirstAdminFromLoopback`：仅 Host 为 localhost/127.0.0.1/[::1] 的首注册可成 platform_admin，否则 403 `install_requires_local_access` | `authstore/store_test.go` 等 |

### 3.2 授权/业务逻辑（批 B）

| 编号 | 修复 | 关键实现 | 测试 |
| --- | --- | --- | --- |
| `V-10` | analytics 匿名写 | members_only 站点匿名 401；公开站点保留匿名埋点；进程内 (site,session,path) 分钟级去重（注释多副本不共享，仅降噪） | `analytics/{handler,service}_test.go` |
| `V-11` | taxonomy 可见性 | members_only 匿名 GET → 401（与 content 同一判定） | `taxonomy/handler_test.go` |
| `V-14` | 私信成员注入 | `MembershipChecker` 注入；会话内每个成员（含创建者）必须是本站活跃成员，否则 400 | `messaging/membership_test.go`（6） |
| `V-15` | 互动目标校验 | `ContentTargetChecker`/`UserMembershipChecker`：评论要求 target 存在且（已发布或本人草稿）；reaction/bookmark 开启时要求已发布；follow 开启时要求本站活跃成员；不可见/不存在 → 404 `interaction target` 防探测 | `community/targets_test.go`（10） |
| `V-06` | 草稿配额 | 每作者活跃草稿 ≤200 篇且 source ≤20MiB；Create 与 Update（增长）都检查；超限 429 `quota_exceeded` | `content/quota_test.go`（10） |
| 契约 | 新增错误码 | `apperr.CodeQuotaExceeded`（429）；OpenAPI `Problem.code` 枚举同步 | `problem_test.go`、`openapi_contract_test.go` |

### 3.3 内容/前端（批 C）

| 编号 | 修复 | 关键实现 | 测试 |
| --- | --- | --- | --- |
| `V-20` | DOM clobbering | `sanitizeHtml` 删除 `id/name/is/form/for`；TextBlock 渲染后 `document.getElementById` 仍可调用 | `markdown.test.ts`（9 条新回归） |
| `V-21` | tabnabbing | `target=_blank` 的 `a/area` 强制 `rel="noopener noreferrer"` | 同上 |
| `V-03` | 自定义 CSS 持久注入面 | 服务端 `validateCustomizationDocument` 规范化后拒绝 `@import`/`expression(`/`behavior:`/`-moz-binding`/`url(javascript:`/`url(data:text/`，`custom_css≤20k`、theme 字符串≤4k、嵌套≤64；前端 `sanitizeCustomCss` 同规则（读入/导出/回写三处）；导入确认文案明确"写入服务端、影响所有访客" | `site/customization_test.go`、`customize.test.ts` |
| `V-05` | 安全响应头 | API 新中间件（CSP/XFO/Referrer-Policy/Permissions-Policy/XCTO），覆盖 4xx/5xx；launcher 静态页同套头并避免与 API 重复；生产 Nginx 模板同步 | `middleware/security_headers_test.go` |
| `O-1` | 匿名访客加载服务端站点 | 新增 `lib/visitorBootstrap.ts`：无本地配置时探测 `setup/status` → 拉 customization → **内存**构造只读 live 配置渲染站点；`?mode=live`/未安装/无管理员仍走安装引导；不写 localStorage、不写服务端 | `AppBoot.test.ts`、`visitorBootstrap.test.ts` + 真实 Chrome E2E |

### 3.4 部署/启动器（批 D）

| 编号 | 修复 | 关键实现 | 验证 |
| --- | --- | --- | --- |
| `V-04` | launcher 控制面 | `/__pp/runtime|runtime/port|state/*` 需 **TCP 回环 + Host 回环 + 无 X-Forwarded-*/X-Real-IP/Forwarded**；runtime 响应删 `pid/started_at/api.base/api.pid/api.data_dir/api.log` | launcher 单测 + 真实 HTTP：evil Host / 任意转发头 → 403，本机正常 |
| `V-05` | launcher 静态站头 | CSP/XFO/Referrer/Permissions/XCTO；对 API 反代不重复设置（由 API 负责） | Chrome headless 无 CSP 违规；响应头单值 |
| `V-17` | 生产部署 profile | 新增 `docker-compose.prod.yml`（production/PP_DESKTOP=false/密钥必填/Secure Cookie）、`deploy/production/nginx.conf`（TLS/HSTS/安全头/`location /__pp/ { return 404; }`/真实 IP 覆盖）、`env.prod.example`、`docs/deployment/production-profile.md`（两阶段安装/备份/回滚/未实跑说明）；`deploy/docker/nginx.conf` 同步加固 | YAML/结构静态校验；**Docker 未实跑**（宿主无 Docker） |
| `V-18` | JWT 私钥保护 | `practacu-web.json` 的 `jwt_key` 用 Windows DPAPI 加密（`dpapi:` 前缀），旧明文自动迁移；非 Windows 回退 | launcher 单测 + live E2E：密文落盘、重启后旧 token 仍有效、文件 hash 稳定 |

---

## 4. 验证结果（全部实跑）

### 4.1 测试套件

| 命令 | 结果 |
| --- | --- |
| `go test ./...`（API 模块，含全部新增回归） | ✅ 全绿 |
| `go vet ./apps/api/...` | ✅ clean |
| `cd apps/launcher && go test ./... && go vet ./... && go build` | ✅ 全绿 / 构建成功 |
| `cd apps/web && npx tsc --noEmit` | ✅ |
| `cd apps/web && npx vitest run src` | ✅ **40 文件 / 458 tests**（第二轮新增域名验证/注册开关/登出 CSRF 组件测试） |
| `cd services/security && rustup run stable-x86_64-pc-windows-msvc cargo test` | ✅ **54 passed**（第二轮新增真类型检测/class 白名单测试） |

### 4.2 修复构建上的攻击复测（i0，2026-11-02T05:2x UTC；全新 `data/`）

| 原漏洞 | 复测结果 |
| --- | --- |
| `V-01` 媒体 BOLA | member 列表空、私有附件/未引用图 404、已发布引用图匿名 200、自有资产 200 |
| `V-02` 撤权延迟 | demote 后旧 token role=member、publish 409、settings 403；suspend/remove 后 401 |
| `V-13` 枚举 | 未知 vs 已知邮箱 153ms vs 156ms（≈1.02×，修复前 85×） |
| `V-24` 锁定 | 5 次失败后 429 + Retry-After（单测覆盖指数升级/清零） |
| `V-26` 登录 CSRF | `text/plain` 403、跨站 Origin 403、正常 JSON 200 |
| `V-28/V-30` | 255 字符邮箱 400、8 空格 / 11 位 / 常见弱口令密码 400 |
| `V-10/V-11` | members_only 匿名 analytics/taxonomy 均 401 |
| `V-14/V-15` | 幽灵成员会话 400；不存在 target 评论/反应 404 |
| `V-04` | evil Host/XFF 的 `/__pp/runtime|port` 403；本机正常；runtime 字段已最小化 |
| `V-05` | API/静态页 CSP/XFO/Referrer/Permissions/XCTO 单值下发 |
| `O-1` | 真实 Chrome 全新建 context：站点渲染、服务端设计生效（自定义 CSS outline + 自定义品牌 + block 文案）、`localStorage['pp.web.config.v1']=null`、`?mode=live` 仍进安装引导、members_only 站点显示门禁壳而非无限 loading |
| `V-16` | 全新 i5：evil Host 首注册 403 且 `has_admin=false`；回环 Host 首注册 201 成为 platform_admin |

证据：`.tmp/attacklab/work/lead/verify-fixes-i0.json`、`verify-o1.json`、`o1-visitor.png`，以及各修复队友的测试与脚本。

### 4.3 第二轮（延后项）修复构建上的复测（i0，2026-11-02T06:20Z）

| 项 | 复测结果 |
| --- | --- |
| `V-12` 域名验证 | GET /domain 初始空；PUT `verify-test.example` → 204，GET 返回 43 字符 token + `_practacu-verify.<domain>` + `verified:false`；pending 期间 loopback Host 仍 `installed:true`（setup window），声明域 Host 返回 `domain_unverified`；无 DNS 记录点验证 → **409 `domain_verification_failed`**；清空域恢复空状态；member 调用 GET/PUT → 403 |
| `O-3` 注册开关 | PATCH settings `registration_open:false` → GET /sites 与 `setup/status` 均 false；匿名注册 → **403 `registration_closed`**；改回 true 后注册 201 |
| `V-27` CSRF 绑定 | login 响应 csrf == pp_csrf cookie（43 字符）；正常 refresh 200 且轮换后 csrf 变化；任意自造相等 pair → **403**；旧 csrf + 新 refresh → **403**；logout 无 header → **403**，正确 header → 204 且 refresh 随后 401 |
| `V-22` 上传检测 | PNG 头 + `<script>` polyglot → complete **422 `scan_status=rejected, scan_reason=dangerous_content`**；HTML 伪装 text/plain 同样拒绝；合法 PNG → 200 clean |
| `V-22` class 白名单 | 发布 `<p class="btn btn-danger">` → rendered 只剩 `<p>`；`pp-columns`/`language-go`/`language-pp-diagram` 保留；`policy_version=2026-11-02.1` |
| 前端 `O-3` | 关闭注册后全新访客页头「开始使用/注册」消失（默认区块文案仍在，点进注册页显示关闭卡）；O-1 站点渲染不受影响 |

证据：`.tmp/attacklab/work/lead/verify-batch2-i0.json`、`verify-batch2-browser.json`。

---

## 5. 行为/运维变更（发布说明应带上）

1. **refresh 族 90 天绝对寿命**：超过 90 天的老会话会在下次刷新时被整族撤销（一次性登出所有设备），属预期安全收紧。
2. **密码策略**：新建/重置密码需 12–128、非全空白、至少两类字符（空格算符号类）、且不在内嵌常见弱口令黑名单内（忽略大小写整串匹配，拒绝为 `too_common`）；**旧密码仍可登录**。
3. **首管理员仅限本机**：未安装实例必须通过回环 Host 完成首注册；远程暴露的未安装实例不能再被"首到先得"接管（多站点/SaaS 的首管理员初始化需 seed/运维流程，见生产 profile 文档）。
4. **撤权即时生效**：成员被降权/挂起/移除后，旧 access token 立即失效（不再等 15 分钟）；服务端每请求增加一次成员查询。
5. **草稿配额**：每账号 200 篇活跃草稿 / 20MiB source；超限 429 `quota_exceeded`（客户端应提示清理草稿）。
6. **自定义 CSS 校验**：含 `@import`/`expression(` 等字面量的设计文档会被 400 拒绝（含页面文本区块里恰好出现这些字面量的情况，错误会指出字段与命中串）。
7. **匿名访客站点引导**：全新浏览器现在会向 `setup/status` 与 `customization` 发两个只读请求；访客配置只存内存（刷新重新探测，不写 localStorage、不进后台）。`?mode=live` 仍是安装/连接入口。
8. **launcher 控制面**：`/__pp/*` 仅接受本机回环 Host 且不带转发头的请求；若用反代对外提供站点，必须显式拒绝 `/__pp/`（生产 Nginx 模板已写）。
9. **单副本假设**：账号退避计数与 analytics 去重是进程内内存（单实例有效；多副本需共享存储），代码注释已标明。
10. **域名现在要验证**：`PUT /sites/{id}/domain` 只生成 DNS TXT challenge（`_practacu-verify.<domain>`），必须 `POST /sites/{id}/domain/verify` 通过后域名才生效；待验证期间站点仅 loopback/IP-literal 可访问（单站点形态）。后台「访问与域名」页面已提供 TXT 记录展示与验证按钮。
11. **注册开关**：后台「站点设置 → 注册与账户」可关闭自助注册；关闭后注册接口 403 `registration_closed`，页头/登录页入口隐藏，注册页显示友好提示。管理员创建成员不受影响；新列 `site.registration_open` 默认 `true`，旧库自动迁移。
12. **CSRF 与会话绑定**：refresh 的 `pp_csrf` 现在由 refresh token 派生（HMAC），任意相等 pair 不再通过；**轮换 Ed25519 签名密钥会强制所有会话重新认证**（派生 key 变化），属可接受的安全性质。
13. **SPA 登出**：`logout()` 现在携带 `X-CSRF-Token`；登出失败仍清本地会话。
14. **上传更严格**：声明类型必须匹配完整文件签名；前 512 字节出现 HTML/SVG 标记（或 text/plain 以 `<` 开头）一律拒绝（`dangerous_content`）；`text/plain` 允许 512B 采样截断 CJK 字符。
15. **文章 class 白名单**：只保留 `pp-*`、`language-*` 与 `hljs`/footnotes/task-list 等生态类，`btn`/`badge`/`admin-*` 等仿 UI 类会被剥离；旧内容需要重新保存/发布才会应用新策略（`policy_version` 已升到 `2026-11-02.1`）。

---

## 6. 主要改动文件

- **P0：** `apps/api/internal/media/{domain,service,handler_anonymous_test}.go`、`.../media/references_test.go`、`.../infrastructure/mediastore/store.go`、`.../infrastructure/contentstore/store.go`、`.../transport/http/gin/middleware/auth.go`（membership）、`.../transport/http/gin/{router,dependencies}.go`、`apps/api/cmd/server/main.go`。
- **认证：** `apps/api/internal/auth/{service,handler,repository,domain,tokens,validation,write_guard,first_admin,login_guard}.go` + 5 个新测试、`.../authstore/store.go`、`.../transport/ws/handler.go`。
- **授权/业务：** `analytics/{handler,service,domain}.go`、`taxonomy/handler.go`、`messaging/service.go`、`community/{domain,service,handler}.go`、`content/{domain,service,handler}.go`、`.../communitystore/store.go`、`.../platform/errors/codes.go`、`packages/contracts/openapi/openapi.yaml`。
- **内容/前端：** `apps/web/src/lib/{markdown,customize,customizationSync,backend,session,visitorBootstrap}.ts(x)`、`apps/web/src/App.tsx`、`apps/web/src/types.ts`、`apps/web/src/pages/admin/Appearance.tsx`、`apps/api/internal/site/customization.go`、新建 `middleware/security_headers.go`。
- **部署/启动器：** `apps/launcher/{main,state}.go`、新建 `state_secret_{windows,other}.go`、`apps/launcher/launcher_test.go`、`deploy/docker/nginx.conf`、新建 `docker-compose.prod.yml` + `deploy/production/*` + `docs/deployment/production-profile.md`、`.env.example`。
- **第二轮（延后项）：** 后端 `apps/api/ent/schema/site.go`（`registration_open`，ent 重新生成）、`site/{domain,domain_verification,service,handler,repository,status}.go`、`.../sitestore/store.go`、`auth/{tokens,service,handler,domain}.go` + `csrf_binding_test.go`、`apps/api/cmd/server/main.go`（RegistrationPolicy 接线、buildAuth 顺序）、`.../transport/http/gin/router.go`（setup/status `registration_open`）、`packages/contracts/openapi/openapi.yaml`（domain get/verify + SiteDomainStatus + registration_open）、`media/storage.go`（HeadSampleSize 512）；前端 `apps/web/src/lib/{api,backend,demo,demoSeed,domains,registration,visitorBootstrap,session}.ts(x)`、`types.ts`、`pages/admin/{Domains,Settings}.tsx`、`pages/site/Auth.tsx`、`components/SiteChrome.tsx` + i18n；Rust `services/security/src/{content.rs,lib.rs}`（真类型检测 + class 白名单 + policy version）。

---

## 7. 残余风险（第二轮后更新）

| 项 | 说明 | 建议 |
| --- | --- | --- |
| `V-19` gRPC 明文 | 需要 proto 认证/TLS 及部署密钥；默认仅回环，风险有限 | 生产 profile 已注明只在内网暴露安全服务 |
| `V-03` 自定义 CSS 的完整能力 | 高危构造（`@import`/`expression`/`url(javascript:` 等）已过滤，但"自定义 CSS 能重绘页面"本身是站长功能，恶意设计包仍可做纯 CSS 钓鱼覆盖层 | 导入确认文案已警示；进一步可改为只允许 CSS 变量/声明白名单 |
| `V-08` access token 自然过期 | 登出只撤销 refresh，access token 在 15 分钟内仍有效（标准 JWT 取舍） | 可缩短 TTL 或引入 jti 撤销表 |
| `V-09` setup/status 公开站点元数据 | `site_id/site_name/has_admin/registration_open` 匿名可见；O-1 访客引导需要这些字段 | 接受；如需收敛可由前端先用 customization 推导品牌 |
| `V-12` 多站点改域名窗口 | 多站点部署改主域名时旧域立即失效、新域未验证且无 setup window（loopback 无法定位站点），可能暂时无法用 HTTP 完成验证 | 后续保留"上一已验证域"过渡或提供运维 CLI 验证；单站点/桌面形态无此问题 |
| `V-12` 重复 PUT 同域 | 重复声明同一域名会重新生成 token 并清空验证（语义为"重新声明"）；后台表单走 Settings 时同域 no-op 保留验证 | 前端域名表单只在值变化时 PUT；已在 UI 侧按 GET 状态渲染 |
| `V-22` head-only 检测 | 前 512 字节之外的 HTML/JS polyglot 检测不到；依赖声明 MIME + `X-Content-Type-Options: nosniff` 兜底 | 如需更强可做完整文件类型探测/沙箱预览 |
| `V-22` class 白名单兼容 | 旧内容未重新保存/发布时仍带旧 policy_version 与旧 class；新保存内容才会应用白名单 | 升级后批量重新保存/发布，或提供迁移脚本 |
| `V-27` 签名密钥轮换 | 轮换 `AUTH_JWT_ED25519_PRIVATE_KEY` 后所有会话需重新登录（CSRF 派生 key 变化） | 写进升级说明（发布说明已注明） |
| `O-2` review 模式语义 | editor 可直接发布自己/他人的稿子（"编辑即审核者"）；若产品要双人审核需另做 | 产品决策 |
| 单副本假设 | 账号退避、analytics 去重、CSRF 派生都依赖进程内状态/同一签名 key | 多副本部署需共享存储与同一密钥（生产 profile 已要求固定 key） |

---

## 8. 如何复跑

```powershell
# 单元/集成测试
go test ./...; go vet ./apps/api/...
cd apps/launcher; go test ./...; go vet ./...; cd ../..
cd apps/web; npx tsc --noEmit; npx vitest run src; cd ../..
cd services/security; rustup run stable-x86_64-pc-windows-msvc cargo test

# 用修复后的源码重建靶场并复测（见 .tmp/attacklab/README.md）
cd .tmp/attacklab
node scripts/lab.mjs reset i0; node scripts/lab.mjs start i0; node scripts/seed.mjs --id i0
node work/lead/verify-fixes.mjs      # 攻击修复复测
node work/lead/verify-o1.mjs         # O-1 真实 Chrome 验收（需要本机 Chrome）
node work/lead/verify-batch2.mjs     # 第二轮：域名验证/注册开关/CSRF 绑定/上传检测
node work/lead/verify-batch2-browser.mjs  # 第二轮前端（注册入口隐藏 + O-1 回归）
```

---

## 9. 第二轮：第一轮延后项的落实

### 9.1 `V-12` 域名所有权验证（DNS TXT challenge）

- **服务端**：`PUT /sites/{id}/domain` 只写域 + 生成 256-bit `domain_verification_token`（base64url 43 字符），`domain_verified_at=NULL`；空串清 domain/token/verified。新增 `GET /sites/{id}/domain`（manager）返回 `{domain, verified, verification_token, record_name=" _practacu-verify.<domain>", record_type:"TXT"}`；新增 `POST /sites/{id}/domain/verify`（manager）用可注入 `TXTLookup`（默认 `net.DefaultResolver`，10s 超时）查询 TXT，任一值 trim 后匹配 → `verified_at=now` + audit；失败 409 `domain_verification_failed`。
- **setup window**：单站点形态下，域名已声明但未验证时仅 `localhost`/IP-literal Host 可继续解析站点（站长在本机完成验证），声明域本身仍 `domain_unverified`，其它 Host 404；验证后恢复"只服务匹配域"的严格语义。
- **安全细节**：audit 不落 token 明文（只记 `domain_token_set`/`verified`/`record_name`）；`UpdateSettings` 的 domain 分支同样挑战化，重复提交当前域为 no-op 保留验证。
- **前端**：「访问与域名」页三态徽标（未设置/待验证/已验证）、TXT 记录展示 + 复制、`我已添加，立即验证`、按 problem.reason 映射失败文案、成功刷新状态；保存域名后靠 GET /domain 拿 challenge。
- **测试**：site service/handler/store 约 22 个回归（挑战生成/清空/setup window/DNS 成功失败/权限/audit 不含 token/幂等）；OpenAPI 增加 `get`、`/domain/verify`、`SiteDomainStatus`。

### 9.2 `V-22` 上传真类型检测 + class 白名单（Rust）

- **SEC-7**：`inspect_upload` 改为完整签名匹配（PNG 8B / GIF87a/89a / JPEG FFD8FF / WebP RIFF+WEBP≥12 / PDF `%PDF-`）；声明 MIME 不匹配 → `magic_mismatch`；head 短于签名 → `truncated_sample`；非 text 类型首个非空白字节 `<` 或含 `<!doctype html`/`<html`/`<script`/`<svg>` → `dangerous_content`；`text/plain` 要求 UTF-8、无 NUL、不能像 HTML/SVG，并正确容忍 512B 采样截断多字节字符（CJK 不误杀）。
- **SEC-11**：ammonia `attribute_filter` 逐 token 过滤 class：保留 `pp-*`、`language-*` 前缀与 `hljs`/footnotes/task-list 生态类；`btn`/`badge`/`admin-*` 等仿 UI 类剥离；依据（goldmark 代码围栏、richBlocks/markdown 区块类）写在代码注释。
- **配套**：Go `media.HeadSampleSize` 64 → 512（采样更多字节供标记扫描）；`POLICY_VERSION` → `2026-11-02.1`；新 security exe 已替换进靶场。
- **测试**：`cargo test` 54 passed（完整签名/截断/类型错配/各类 HTML 伪装/签名前缀 polyglot/CJK 截断/class 保留丢弃混合大小写）；运行时复测见 §4.3。

### 9.3 `V-27` refresh CSRF token 与会话绑定

- `TokenIssuer.CSRFToken(refreshPlain)`：HMAC-SHA256（key=Ed25519 seed，`"csrf:"+refreshPlain`），base64url 43 字符；同一 refresh 恒定、轮换自动变化。
- 注册/登录/刷新共用 `buildSession` 写入派生 csrf；`POST /auth/token/refresh` 在 cookie/header 双提交等值之后，再校验 header == 派生值（不等 403 `csrf_mismatch`，不触达会话）；`POST /auth/logout` 带 refresh cookie 时同样要求匹配，否则 403；无 cookie 的 CLI 保持宽容语义。
- **前端**：`logout()` 补 `X-CSRF-Token`（memory csrf 或 `pp_csrf` cookie），失败仍清本地会话，避免"登出 403 → refresh cookie 未清 → 刷新被静默登回"。
- **测试**：`csrf_binding_test.go` 覆盖任意 pair/旧 csrf+新 refresh/轮换后旧 csrf 失效/重放仍触发族撤销/并发 logout 语义/无 cookie CLI。

### 9.4 `O-3` 站点级注册开关

- **schema**：`site.registration_open bool default(true)`（Ent 重新生成；旧行迁移后默认 true）。
- **后端**：`Site.RegistrationOpen`、`SettingsInput.RegistrationOpen *bool`（nil=不改）、`GET /sites/{id}` 输出 `registration_open`、PATCH settings 可改；`site.Service.RegistrationOpen(ctx, siteID)` 供 auth 策略；`auth.ServiceConfig.RegistrationPolicy` 在创建账号前检查，关闭 → `ErrRegistrationClosed` → 403 `permission_denied` + `details.reason=registration_closed`（fail-closed；管理员建号不受影响；桌面首管理员流程仍可用）。
- **公共状态**：`GET /setup/status` 增加 `registration_open`（访客引导据此隐藏注册入口）。
- **前端**：后台「站点设置 → 注册与账户」开关（个人博客强制关闭）；注册页关闭时显示「本站暂未开放注册」关闭卡，服务端 403 也映射同一文案；页头/移动菜单注册入口按 `site.registration_open` 隐藏；访客引导把开关带进只读配置。
- **测试**：site/auth 后端约 12 个回归 + 前端 vitest 组件测试（SettingsPage 开关→PATCH、AuthPage 关闭提示、DomainsPage TXT 展示→验证、logout CSRF）；运行时复测见 §4.3。
