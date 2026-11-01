# 5 条 High 修复报告

**日期：** 2026-11-01
**范围：** `docs/audit/2026-10-31-audit-report.md` 中 H-1 … H-5
**状态：** 全部 5 条已修复并验证。三套测试与一次真实进程端到端全部通过（见 §7）。

---

## 0. 一个必须先说清楚的前提

本仓库的工作树在我介入**之前**就是脏的：

```
最后一次提交：abc8cf7  2026-10-24 15:45  docs: add page builder implementation plan
git status：77 个已跟踪文件被改 + 大量未跟踪文件（cmd/server/bootstrap.go、
            ent/schema/page_view.go、ent/schema/taxonomy_term.go …）
```

也就是说 11-01 看到的 `README.md`、`Makefile`、`content/`、`community/` 等改动**都不是本轮造成的**，而是 10-24 之后那几轮开发留下的未提交工作。`docs/superpowers/reports/2026-10-20-delivery-status.md` 里「工作树干净」这句话已经过期。

因此 `git status` 不能用来区分本轮改动。本轮的改动集在每一节里逐个列文件；`apps/api/ent/**` 一次性重写了 179 个文件，是 `scripts/gen.ps1` 从**当前 schema** 重新生成的产物（该脚本不拷贝 `schema/` 与 `generate.go`），所以不会覆盖任何手写文件。

---

## 1. H-1 站点设计改为服务端持久化（架构改动）

### 1.1 先纠正审计结论

审计报告把 H-1 定性为缺陷并注明「若这是有意的设计请忽略」。核对后确认它**确实是有意的**：

```
docs/superpowers/specs/2026-10-24-page-builder-redesign-design.md:178
- 真实后端不存储页面编排，编排仍保存在本地安装配置中，行为与现状一致。
```

它属于「本轮不做」的功能缺口，不是 bug。你选择走 B（实现持久化），所以这变成一次功能开发。

### 1.2 服务端

| 文件 | 内容 |
|---|---|
| `apps/api/ent/schema/site_customization.go`（新） | 独立表：`site_id`(唯一) / `document`(Text) / `revision`(Int) / 时间戳。文档不放在 `site` 列上，避免每次读站点都拖着几百 KB |
| `apps/api/ent/**`（重新生成） | `scripts/gen.ps1`，179 个文件 |
| `apps/api/internal/site/repository.go` | `Customization` / `CustomizationInput` 类型、3 个 sentinel error、接口两个方法 |
| `apps/api/internal/site/customization.go`（新） | `Customization()` / `SaveCustomization()`；校验「必须是 JSON 对象、≤1 MiB」；审计条目只记字节数与版本，不记文档本身 |
| `apps/api/internal/infrastructure/sitestore/customization.go`（新） | 条件 UPDATE（`WHERE site_id=? AND revision=?` + `AddRevision(1)`）实现乐观并发；审计与文档同事务 |
| `apps/api/internal/site/handler.go` | `GET /sites/{siteID}/customization`（匿名可读）+ `PUT`（需 ManageSite）；`json.RawMessage` 保留原始字节；`http.MaxBytesReader` 先限流再解码 |
| `packages/contracts/openapi/openapi.yaml` | 两个 operation + 三个 schema，契约测试已同步 |

**关键设计决定**

1. **文档是字节透传**：不做 JSON 重新编码。浏览器导出/导入自己的格式，重编码会打乱 key 顺序并丢掉重复 key。
2. **乐观并发**：条件 UPDATE 而不是「先读后写」。两个标签页同时保存不会静默丢一边的修改 —— 后来者拿 409。
3. **GET 的可见性不靠 401**：`members_only` 站点的设计文档会暴露私有页面名，所以非成员拿到的是**和「从未保存过」一样的 404**。这同时避免了一个真实副作用：每个访客开屏都会调这个接口，若返回 401，浏览器会把它当成会话过期并触发登出流程。
4. **`MaxBytesReader` 前置**：服务层的大小校验发生在 body 已读进内存之后，所以入口先设硬上限。

### 1.3 前端

| 文件 | 内容 |
|---|---|
| `apps/web/src/lib/api.ts` | `siteCustomization()`（404 → `null`）/ `saveSiteCustomization()`（409 通过 `ApiError.problem.status` 暴露） |
| `apps/web/src/lib/customizationSync.ts`（新） | 开屏 hydration + 800ms 尾随防抖保存 + `pagehide`/`visibilitychange` flush |
| `apps/web/src/lib/customizationSync.test.ts`（新） | 10 个用例 |
| `apps/web/src/App.tsx` | 安装校验通过后 hydrate 一次（StrictMode 双调用已挡），再挂上保存调度器 |
| `apps/web/src/lib/backend.tsx`、`demo.ts` | Backend 接口 + 演示后端实现（演示模式零网络请求，行为不变） |

- **localStorage 仍保留**：作为首屏立即绘制的缓存与离线回退，网络断了站点照常渲染。
- **409 处理**：取回服务端当前版本 → 换新版本重试一次 → 仍冲突则保留本地、记日志、不抛错。
- **永久失败**：400/403/422 停止自动保存（400 是我最终采用的状态码，已在实现中补上；原派单写的是 422）。
- 失败路径一律不阻塞 UI，也不打断同步的 `useCustomization()` API。

---

## 2. H-2 令牌与站点绑定

### 2.1 先纠正审计结论（重要）

审计报告（AUTH-1）说「跨站令牌全站无防护」，这句话**过重**。实际是：

- `analytics` / `community` / `content` / `notifications` / `messaging` / `taxonomy` / `site` **七个模块的 handler 本来就有 `cross_site` 判断**（`rg '"cross_site"' apps/api` 可见 7 处）；
- `content` 等模块的查询全部按 `actor.SiteID` 取值，构造上就不可能跨站；
- **唯一的洞**是 `site/handler.go` 的 `PublicUser`：它走 `optionalAuth`，判据是「有没有会话」而不是「是不是本站成员」，然后用**解析出的站点**取值。所以拿 A 站令牌可以读 B 站（members_only）的成员名录与角色。

### 2.2 修复

| 文件 | 变更 |
|---|---|
| `middleware/auth.go` | 新增 `RequireAuthForSite`（`RequireAuth` + 站点比对的组合形态，保持 `Routes(...)` 只收单个 guard 的签名不变）；抽出 `siteMatches` / `rejectForeignSite`；`OptionalAuth` 现在**丢弃外站令牌**（当作匿名），否则每个按 `actor.SiteID` 取值的匿名读接口都会被喂进另一个租户的身份 |
| `router.go` | guard 换成 `RequireAuthForSite` |
| `site/handler.go` | `PublicUser` 改为「必须是**本解析站点**的活跃成员」才放行 members_only；非成员在公开站点按匿名读者处理；真实故障不再被当成 403 |
| `middleware/auth_for_site_test.go`（新） | 6 个用例 |
| `site/handler_public_test.go`（新） | 4 个用例 |

拒绝原因统一用既有的 `cross_site`（原本 `middleware` 里那行死代码用的是 `site_mismatch`），避免同一类失败出现两套词汇；已有测试 `TestMemberAdministrationRejectsTokenFromAnotherSite` 因此无需改动。

**一个刻意的取舍**：站点解析器未配置时（Windows 单站点部署）不做比对。此时根本不存在「按 Host 选租户」的路径，拒绝反而会打断单站点安装；该行为在测试里写成了显式用例并注明原因。

---

## 3. H-3 客户端清洗器 scheme 绕过

| 文件 | 变更 |
|---|---|
| `apps/web/src/lib/markdown.ts` | 黑名单 → **归一化后的白名单**：新增纯函数 `safeUrlAttribute(name, value)`；先把 C0/Unicode 空白全部剥掉、转小写，再只允许 `http/https/mailto/tel`、`#锚点`、无 `..` 的相对路径，`src/poster/srcset` 额外允许 `data:image/(png\|jpe?g\|gif\|webp\|avif);base64,`；`srcset` 逐个候选校验，一个不合格整条属性丢弃；顺带移除 `<template>` 与 SVG SMIL（`animate`/`set`，二者都能在运行时改写 `href`） |
| `apps/web/src/lib/markdown.test.ts` | +50 个回归用例（共 54） |

覆盖的载荷包括：`java&#9;script:`、`javascript&colon;`、`&#1;javascript:`、`%6a%61vascript:`、`java\u200bscript:`、`data:text/html`、`data:image/svg+xml`、`blob:`、`//evil.example`、`\\evil.example`、`onerror=`、`srcdoc=`、`srcset` 混入 `javascript:` 等；正向用例覆盖 https 链接、相对路径、锚点、`mailto:`、`data-pp-math` 往返与幂等性。

**一个实现细节值得记录**：happy-dom 不解码属性值里的数字/命名实体（真实浏览器会）。只依赖 `DOMParser` 解码与只依赖正则都不安全，所以两处都挡：既按归一化后的值做白名单，也拒绝任何残留的 `&#…`/`&colon;`。

---

## 4. H-4 主题 token 的 CSS 注入

| 文件 | 变更 |
|---|---|
| `apps/web/src/lib/theme.ts` | 一个 `safeCssValue()` 同时用于 `normalizeThemeTokens`、`resolveTokens`、`themeCss`（第三处是纵深防御：非法 token 直接跳过而不是拼进 `:root`）；只接受整串匹配的 `#hex(3/4/6/8)`、括号配平的 `color-mix/rgb/rgba/hsl/hsla(...)`（禁止 `; { } < > " ' \ @ url( !important /*`）、裸 `var(--name)`；超长值丢弃而不是截断（截断会把一个坏值变成"能通过"的坏值） |
| `apps/web/src/lib/theme.test.ts`（新） | 40 个用例 |

---

## 5. H-5 Argon2 阻塞 async 运行时

### 5.1 Rust 侧

| 文件 | 变更 |
|---|---|
| `services/security/src/transport/grpc.rs` | 新增 `run_argon2`：**先取许可再 `spawn_blocking`**，把许可移进闭包（只在真正算完才释放，它才是内存上限），join 结果与 `tokio::time::timeout` 竞速；`JoinError → Internal`、超时 → `DeadlineExceeded`、信号量关闭 → `ResourceExhausted`。并发度用 `OnceLock<Semaphore>`，`SecurityServer` 保持 `Default`，proto 不动 |
| `services/security/src/password.rs` | `verify_password` 现在也做长度边界（超界返回 `Ok(false)`，不再把 1 MiB 明文送进 Argon2）；`encoded` 超过 1024 字节或空白 → `InvalidHash` |
| `services/security/src/main.rs` | 启动时打印生效的并发度与超时 |
| `services/security/Cargo.toml` | tokio 补 `time` feature（`sync`/`rt` 已实际使用） |

- 默认并发 **4**（= 逻辑核 8 夹到 4），峰值从约 15 GiB 降到约 256 MiB。
- 默认超时 **10s**。可用 `SECURITY_ARGON2_CONCURRENCY`(1–32)、`SECURITY_ARGON2_TIMEOUT_MS`(100–60000) 覆盖。
- 13 个新测试（总计 41）。

### 5.2 Go 侧

| 文件 | 变更 |
|---|---|
| `auth/handler.go` | `HandlerConfig.CredentialLimiter`：只挂在**消耗密码**的四个端点（注册 / 登录 / 密码重置请求 / 密码重置确认），刷新与登出不受影响 |
| `platform/config/config.go` | `AUTH_CREDENTIAL_RATE_LIMIT_PER_MINUTE`，默认 **10** |
| `cmd/server/main.go` | `buildCredentialLimiter`，独立 store（不与全局 240/min 共享计数） |
| `auth/handler_credential_limit_test.go`（新） | 2 个用例 |

### 5.3 一个环境坑（供后续参考）

`cargo test` 在本机默认 `%TEMP%` 下会在 `build.rs` 阶段挂掉（prost-build 建临时目录被拒），与业务代码无关。可用：

```powershell
$env:TMP="$PWD\.cargo-tmp"; $env:TEMP=$env:TMP
rustup run stable-x86_64-pc-windows-msvc cargo test --offline
```

---

## 6. 改动文件清单（本轮）

**Go（新增）**：`ent/schema/site_customization.go`、`internal/site/customization.go`、`internal/site/customization_test.go`、`internal/infrastructure/sitestore/customization.go`、`.../customization_test.go`、`internal/site/handler_customization_test.go`、`internal/site/handler_public_test.go`、`internal/transport/http/gin/middleware/auth_for_site_test.go`、`internal/auth/handler_credential_limit_test.go`

**Go（修改）**：`ent/**`(重新生成)、`internal/site/{repository,handler,service_test}.go`、`infrastructure/sitestore/store.go`(仅 interface 传输)、`transport/http/gin/{router.go,middleware/auth.go}`、`internal/auth/handler.go`、`internal/platform/config/config.go`、`cmd/server/main.go`

**契约**：`packages/contracts/openapi/openapi.yaml`

**Web（新增）**：`lib/customizationSync.ts`、`lib/customizationSync.test.ts`、`lib/theme.test.ts`
**Web（修改）**：`lib/markdown.ts`、`lib/markdown.test.ts`、`lib/theme.ts`、`lib/api.ts`、`lib/backend.tsx`、`lib/demo.ts`、`App.tsx`

**Rust**：`src/transport/grpc.rs`、`src/password.rs`、`src/main.rs`、`Cargo.toml`

---

## 7. 验证（全部实跑，2026-11-01）

```
# Go
go build ./...            exit 0
go vet ./...              exit 0
go test ./... -count=1    30 个包全部 ok, exit 0

# Web
npx tsc --noEmit          exit 0
npx vitest run            26 files / 301 tests passed, exit 0

# Rust (MSVC)
cargo test --offline      41 passed; 0 failed, exit 0
```

**真实进程端到端**（`cmd/server` + 全新 SQLite + 桌面 bootstrap，`AUTH_CREDENTIAL_RATE_LIMIT_PER_MINUTE=5`）：

```
READY=ready
ME site=01a192c0-… role=platform_admin
GET-before=404                 ← 从未保存
PUT revision=1
ANON-GET revision=1 preset=paper   ← 匿名访客读到站长保存的设计
STALE=409                      ← 带着旧版本号写入被拒
LOGIN-CODES=401,401,401,401,429,429,429   ← 第 5 次起限流
```

---

## 8. 本轮没动的（审计里仍是打开的）

| 原编号 | 问题 | 为什么这轮不动 |
|---|---|---|
| AUTH-2 | refresh 族没有绝对寿命 | Medium，需要加列 + 迁移，建议与「会话管理」一起做 |
| AUTH-3/4 | 登录无可枚举防护（未知邮箱提前返回、禁用账号返回专属码） | Medium，与 §5.2 的限流互补，但改的是响应语义，需要产品确认文案 |
| AUTH-5 | 限流内存表 50k 上限没被强制 + O(n) 全表扫描 | Medium，改动小，建议下一轮 |
| AUTH-6 | 任意 site_admin 可声明任意未占用域名（`domain_verification_token` 从不写入） | Medium，需要域名所有权验证的产品决定 |
| DATA-1/2/3/4 | taxonomy 匿名读绕开 members_only、分析埋点未认证写、无 body 上限（仅新端点加了上限）、媒体下载匿名 401 | 3 与 4 影响前端可用性，建议接着修 |
| L-1/L-2 | 无写超时 / 每请求 deadline；SQLite 真实路径不补 WAL 与 busy_timeout | Medium，两处都是小改动，但会改变运行时行为，建议单独一轮 + 压力验证 |
| SEC-1 之外的 SEC-2…S-12 | violations 丢弃、policy_version 不校验、ErrUnavailable 不覆盖 Unknown/Internal 等 | 均为 Medium/Low，且都能独立修 |

**建议下一步**：先修 L-1/L-2 与 DATA-3/DATA-4（小、影响真实用户），再处理 AUTH-2/AUTH-5（会话与限流的正确性），AUTH-6 等产品定夺。
