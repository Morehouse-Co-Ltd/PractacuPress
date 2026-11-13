# Practacu Press 攻击模拟报告（本地靶场 · 攻击者视角）

**日期：** 2026-11-02
**范围：** 当前工作区源码重新构建的 Windows 启动器部署（`apps/launcher` + `apps/api` + `services/security` + `apps/web`），以及同源码对应的 Docker Compose / 直连 API 形态（配置面）。
**方法：** 在隔离副本上**实际运行**后做黑盒 + 灰盒攻击模拟（不是纯代码审计）：自建 6 个互不干扰的实例，攻击者从匿名 → 自助注册 → 普通成员 → 站点管理员/平台管理员（利用已获得凭据或合法授予的角色）逐级尝试，所有结论以可复现的请求/响应/浏览器行为为准。
**授权边界：** 只攻击 `127.0.0.1` 上的靶场实例；未触碰真实 `data/`、`release/`、`.git` 或系统配置；未做真实 DoS；测试结束后实例全部停止。

> 上一轮（2026-10-31）是**纯静态代码审计**，本轮是**运行时攻击验证**：既复核了那轮 5 条 High 的修复，也发现了静态审计无法确认的新问题。
>
> **修复状态（2026-11-02 修复轮）：** 已修复/部分修复/延后清单与验证证据见 [2026-11-02-fix-report.md](2026-11-02-fix-report.md)。

---

## 0. 摘要

**一句话：** 没有找到未授权的远程代码执行或直接接管平台的 Critical 漏洞；JWT 签名、SQL 注入、HTML 清洗器、路径穿越、CORS/CSRF 等硬边界经得起实际攻击。**但确认了 1 条 High「媒体对象级授权缺失」**、1 条 Medium「角色/撤权不即时生效」、以及若干部署与内容管线风险。**当前最值得修的是媒体访问控制**；对公网部署而言，**默认管理员抢注窗口**和**开放注册 + 无限草稿**的组合也需要产品决策。

| 严重度 | 本轮确认 | 说明 |
| --- | --- | --- |
| Critical | 0 | 无预认证 RCE / 无平台接管（"先暴露后安装"场景除外，见 V-16） |
| High | 2 | ①媒体库与未发布草稿附件可被任意注册用户/匿名读取（默认开放注册下无条件成立）；②launcher 置于同机反代后，未认证远程可改端口造成持续 DoS（常规对外部署方式下成立） |
| Medium | 13 | 撤权不即时生效；启动器反代端口修改/信息泄露；全新实例首注册抢管理员；compose 开发形态上线；自定义 CSS 持久钓鱼覆盖层；DOM clobbering 全站白屏；无安全响应头；开放注册+无限草稿资源耗尽；匿名 analytics 写入；members_only taxonomy 泄露；域名无验证声明；登录计时枚举；refresh 无绝对寿命；无账号级锁定 |
| Low | 15 | 登出 token 仍有效/强制登出无 CSRF、安装元数据、注册枚举、私信成员注入、互动目标不校验、JWT 私钥明文、WS Origin/明文 gRPC、tabnabbing、SEC-7 魔数/SEC-11 class、refresh 并发复用检测、登录 CSRF 面、refresh CSRF 不绑定、超长邮箱 500、密码策略仅长度 |
| 已修复-复测通过 | 6 | H-1 服务端持久化（含 O-1 验收缺口）、H-2 站点绑定、H-3/H-4 客户端清洗器、H-5 Argon2、D-4 匿名媒体、L-1/L-2/DATA-3 加固 |

> 合计 **30 条编号项**：新发现 17 条（High 2 / Medium 6 / Low 9），已知未修复测仍存在 12 条，已知 hardening 复核 1 条。认证面本轮**没有**发现 Critical/High（JWT 伪造、refresh 跨站重放、WS 跨用户事件全部失败）。
>
> 定级口径：V-01 按"默认开放注册 + 任意人可下载全站资产"计 High（若产品提供并开启"关闭注册"则降 Medium）；V-04 按"站长把 launcher 置于同机 TLS 反代对外提供站点"这一项目自身鼓励的部署方式计 High（纯回环本机使用则仅本机可利用，Medium）。V-03/V-20 当前影响面受 O-1 限制，若补上匿名访客 bootstrap 应升 High。

**攻击者最现实的攻击剧本（按代价/收益排序）：**

1. 注册一个免费账号 → 枚举并下载全站媒体库，包括**别人未发布草稿的附件**（High，`V-01`）。
2. 如果站点由 Windows 启动器 + 同机 Nginx 反向代理对外提供，未认证即可调 `POST /__pp/runtime/port` 把站点搬到别的端口，反代 502、重启不恢复（High，`V-04`）。
3. 如果站长在"注册管理员之前"就把站点暴露到公网，第一个注册者确定性地成为 platform_admin（Medium→High，`V-16`）。
4. 如果该站允许注册用户投稿（默认允许），大量注册账号灌 150KB 草稿 → 撑大 SQLite/刷爆审核队列（Medium，`V-06`）。
5. 诱导站长**导入一份第三方"主题/设计包"** → 该包里的自定义 CSS 可做全站钓鱼覆盖层、text 区块可做 DOM clobbering 白屏；同包里的 `code` 区块 JS 还会随设计分发到每个已安装浏览器（Medium，`V-03`/`V-20`；若补上匿名 bootstrap 升 High）。
6. 被撤职/挂起/移除的账号，其 access token（15 分钟）内仍保留旧角色和写权限：审核绕过、被移除成员继续发文（Medium，`V-02`）。认证面另有三条 Medium 全部来自上轮遗留：登录计时枚举（V-13）、refresh 无限续命（V-23）、无账号级锁定（V-24），组合拳是"枚举管理员邮箱 → 多 IP 爆破"。

---

## 1. 攻击设定

**攻击者位置模型（按现实可能性排序）：**

| 代号 | 位置 | 能力 |
| --- | --- | --- |
| P1 | 公网匿名访客 | 只能访问站点 web 入口（启动器 web 端口 / Nginx 80/443） |
| P2 | 公网注册用户（member） | 自助注册即可获得；可读公开内容、建草稿（默认审核模式）、评论、私信、上传 |
| P3 | 站点管理员（site_admin/editor，例如被雇佣的编辑或被盗账号） | 管理站点内容与站点设计（含自定义 CSS/页面编排） |
| P4 | 本机/同机网络（恶意本地进程、同机反代后的请求） | 可直连回环端口、读安装目录文件（含 JWT 私钥）、访问 `/__pp/*` |

**目标环境（与项目默认部署一致）：**

- Windows 启动器形态：`APP_ENV=development`、`PP_DESKTOP=1`、SQLite、Rust 安全服务在线，`RATE_LIMIT_PER_MINUTE=1200`，web 仅绑 `127.0.0.1:1808x`，API 子进程 `127.0.0.1:879x`，安全服务 `127.0.0.1:900x`；
- Docker Compose 形态按仓库 `docker-compose.yml` 静态审计（`APP_ENV=development`、`PP_ALLOW_REMOTE_API=1`、`TRUSTED_PROXIES=172.28.0.0/16`、`127.0.0.1:8080:80`）；
- 直连 API `APP_ENV=production` 形态用于验证配置差异（Cookie/HSTS/CORS 启动校验等）。

**方法：** 黑盒请求重放 + 灰盒源码定位（`apps/api`、`services/security`、`apps/web`）+ 真实 Chromium 验证前端执行结果；每条漏洞都给出复现命令、原始证据与根因 `文件:行`。

---

## 2. 靶场

当前工作区源码（git HEAD + 未提交改动，含图表/骨架屏等新特性）重新构建：

| 组件 | 构建 | 说明 |
| --- | --- | --- |
| `PractacuPress.exe` | `go build ./apps/launcher`（含当前 `apps/web/dist`） | 静态前端 + 同源反代 + 拉起子进程 |
| `PractacuPressAPI.exe` | `go build ./apps/api/cmd/server` (amd64, pure Go) | 业务 API |
| `practacu-security.exe` | `cargo build --release`（MSVC toolchain） | Argon2id / ammonia 清洗 / 上传检查 |
| DB | 每实例独立 `data/practacu.db` | 不读写仓库真实 `data/` |

**实例与分工（全部本机回环，互不干扰）：**

| 实例 | 端口 | 归属 | 用途 |
| --- | --- | --- | --- |
| i0 | 18080 | Lead | 端到端攻击链、H-1/H-2 复测、媒体 IDOR 复核、撤权实验 |
| i1 | 18081 | Auth 面 | 认证/会话/JWT/CSRF/限流/WS/密码重置 |
| i2 | 18082 | Authz 面 | 权限矩阵/IDOR/权限提升/业务逻辑/媒体边界 |
| i3 | 18083 | Content 面 | 清洗器对抗/定制化 XSS/上传媒体/静态站/真实 Chromium |
| i4 | 18084 | Infra 面 | 部署/启动器/配置/日志/受控 DoS |
| i5 | 18085 | Infra + Lead | 全新实例：首注册抢管理员、同机反代端口修改（验证后 reset） |

**测试量：** 5 个攻击面共约 3,000+ 次 HTTP 请求、真实 Chromium 渲染 30+ 次、受控并发 ≤20；每实例独立限流预算内，未做真实 DoS、未对外网发起请求。

---

## 3. 攻击链叙事（按阶段）

### 阶段 1：外部侦察（P1）

- 站点根、静态资源、`/healthz`、`/readyz` 正常；`/api/v1/openapi.json` 是空壳（`paths: {}`），未泄露接口清单。
- `GET /api/v1/setup/status` 匿名可用，返回 `installed/has_admin/site_id/site_name`（`V-09`，Low）；`has_admin=false` 等于公开广播"可以抢注管理员"。
- 启动器形态下 `GET /__pp/runtime` **没有任何鉴权/回环校验**，匿名返回安装目录绝对路径、日志路径、内部 API 端口、PID、安全服务状态；`/__pp/runtime/port`、`/__pp/state` 只校验回环——而回环在本机反代后天然成立（`V-04`）。
- 响应头只有 `X-Content-Type-Options: nosniff`：**没有 CSP、X-Frame-Options、Referrer-Policy、HSTS、Permissions-Policy**（`V-05`）；真实 Chromium 确认站点可被跨源 `<iframe>` 嵌入（点击劫持素材齐全）。
- 无 CORS 配置时对跨域请求不返回任何 `Access-Control-Allow-*`，预检 404 —— 跨域读被浏览器挡住（防御有效）。
- 静态站不提供目录列表、robots.txt 禁收录后台/接口；`/__pp/*` 之外没有额外管理面泄露。

### 阶段 2：初始访问（P1 → P2）

- 注册接口开放：`POST /api/v1/auth/register/email` 返回 201 与 access token。**任何能访问站点的人都能自助成为 member**（这是产品默认行为，但也是后续所有攻击的入口）。
- **未安装实例的抢注窗口（`V-16`）**：在 `has_admin=false` 的全新实例上，第一个注册的人**确定性地**成为 `platform_admin`（不是竞态——先到先得）。Lead 与 Infra 面均在全新 i5 上复现：匿名注册 → `/me` 返回 `role=platform_admin` → 改站点设置 204 → 站点名被改为攻击者指定值。默认只绑回环、装完前不对公网开放时不可远程利用；一旦"先暴露再安装"（自建反代/容器端口映射/安全组提前放行），攻击者可在站长之前完成"安装"并接管平台。
- JWT 伪造尝试全部失败：`alg=none`、签名截断、双 token、HS256 混淆、真实 payload 篡改（role/exp/sid/sub）、过期 token 均 401；`kid` 必须匹配，`iss` 校验。Ed25519 + `kid` 绑定有效（防御有效）。
- 认证面攻击结果（详见 `V-13`/`V-23`/`V-24` 与 Auth 面报告）：JWT/refresh/WS 票据的硬边界没有被攻破，**没有发现 Critical/High 认证绕过**；但三条上轮遗留 Medium 全部运行态复现：登录计时枚举（1.4ms vs 118.8ms）、refresh 无绝对寿命（每次轮换 +30 天）、无账号级锁定（仅 10/min/IP 凭据限流；伪造 XFF/X-Real-IP 不重置预算——防御有效）。凭据限流第 11 次 429 + Retry-After，全局限流 1200/min 实测第 1170 次起 429；ws-ticket 需 Bearer、单次消费、60s TTL（62s 后 401）。

### 阶段 3：权限边界探测（P2，普通成员）

以全新 member 账号（`admin@i0.test` 之外的攻击者账号）实测：

| 动作 | 结果 |
| --- | --- |
| `GET /me` | 200，`role=member`，token 含 `sid/role` claim |
| `GET /articles`（公开站点） | 200，仅已发布内容；**他人草稿按 ID 直取返回 404**（IDOR 防御有效） |
| `POST /articles` | 201 —— member 可以建草稿（默认 `publish_mode=review`） |
| `POST /articles/{id}/publish`（他人草稿） | 403/409，未越权 |
| `GET /sites/{id}/members` | 403（需要管理角色） |
| `PATCH /sites/{id}/members/{self}/role` | 403（不能自提权） |
| `PUT /sites/{id}/customization` | 403（站点设计仅管理角色可写） |
| `POST /sites/{id}/members` | 403（不能建号/注入 role） |
| `GET /media` | **200：列出全站媒体库（含管理员上传的未发布草稿附件）** `V-01` |
| `GET /media/{admin 的草稿附件}` | **200 下载成功** `V-01` |
| `POST /comments` | 201（评论内容走 React 文本节点，无 XSS） |
| `GET /events?since=0` | 200 但仅本人/本站点事件（受众隔离下不泄露他人） |
| `GET /notifications` | 200（通知生产未实现，D-5 已知） |

**结论：** 除媒体面外，member 的写操作边界基本正确；真正的 High 在媒体对象的**所有权/发布状态**授权缺失。

### 阶段 4：权限提升与撤权对抗（P2/P3 → 更高）

- 自提权、建号 role 注入、站点设置/域名/设计写入全部被服务端角色校验拦住（防御有效）。
- **撤权不即时生效（`V-02`）**：管理角色/成员状态被改动后，JWT 里的 `role`/身份仍在 15 分钟内被内容、社区、媒体、私信、通知、事件模块当作当前权限使用：
  - 被降职的 site_admin 旧 token 仍能直接发布内容（200），重新登录后的 member token 则被要求先提交审核（409）；
  - 被挂起的 member 旧 token 仍能评论、建草稿；
  - 被移出站点的成员旧 token 仍能建草稿；
  - 站点本身的接口（成员/设置）正确读取数据库角色，因此不受影响 —— 这反证了跨模块授权模型的不一致。
- 登出只撤销 refresh，**access token 到过期前仍可用**（`V-08`，Low；标准 JWT 取舍，但与"登出即失效"的 UI 预期不符）；`POST /auth/logout` 本身无 CSRF（外站 Origin 仅凭 cookie 即可 204，`V-29`）。
- 被挂起账号的 refresh 会被拒（403），说明会话层知道成员状态，只是 access token 校验不查。
- 认证面附加：refresh 族无绝对寿命（每次轮换重置 30 天，`V-23`）；并发刷新时 CAS 输家返回 401 但**不撤销族**（2/3 试验赢家会话存活，`V-25`）；refresh 的 CSRF 双提交 token 不绑定会话（任意相等 pair 可过，`V-27`）；登录端点不强制 JSON Content-Type 且不校验 Origin（`text/plain` 登录实测 200 并 Set-Cookie，`V-26`）；256–320 字符邮箱注册 500（`V-28`，Lead 复现）；密码策略仅长度（8 个空格可注册登录，`V-30`）。

### 阶段 5：内容管线与前端（P3 及 P2 投稿）

- 服务端 HTML 清洗（文章路径）：Content 面用 **75 条载荷**（HTML 55 / markdown 20，覆盖 script/on*/javascript: 各种混淆/svg/math/foreignObject/mXSS/iframe/form/meta/base/template/noscript/srcset/ping/xlink/500 层嵌套/幂等性）对真实 API 实测——**0 绕过**；`<script>`、`onerror`、`svg onload`、`math/mtext` mXSS、`noscript` mXSS、`iframe srcdoc` 等均未存活。Rust 清洗服务 fail-closed：断开后发布/上传 503。
- 客户端 H-3 清洗器：真实 Chrome 下 30 条 mXSS/scheme 语料 **0 执行**（`javascript:` 被清洗或被 React 19 拦截）；H-4 主题 token 注入被丢弃（`safeCssValue` 白名单有效）。**服务端 ammonia 与客户端清洗器本轮都没有被绕过。**
- **H-1 修复后新增的最大面**：`PUT /sites/{id}/customization` 把整份站点设计 JSON **原样存服务端**（只校验 JSON 对象/1MB/乐观锁），其中包含页面区块 HTML、`custom_css`、`code` 区块（iframe JS）、主题 token。站点设计第一次成为"服务端存储、所有已安装浏览器渲染"的数据面，而服务端对内容**零校验**、安全责任全在前端：
  - `custom_css` 原样进 `<style>` → 全屏伪造"会话过期"覆盖层（钓鱼，真实 Chrome 匿名访客视角复现，`V-03`）；
  - text 区块 HTML 经客户端 `sanitizeHtml`（保留 `id/name`）→ `<img name="getElementById">` 触发 DOM clobbering → 全站白屏持久 DoS（`V-20`）；
  - `<a target=_blank>` 不补 `rel`（`V-21`）；`code` 区块 JS 随设计包在每个访客浏览器执行（sandbox 不同源）。
- 文章图表（`pp-diagram` 围栏 → 客户端 SVG）经真实浏览器测试为 `escapeXml` 完整、无注入；标题/摘要/标签/评论/私信在前端全部 React 文本节点（0 执行）；URL 参数反射同结论。
- **SSRF：无攻击面**。全仓库 Go 侧没有任何对外 HTTP 调用（grep 只有 gRPC/测试），S3 适配器需真实端点；launcher 只在启动时探测写死的 `127.0.0.1:80/8080-8082`。
- **产品级缺口（O-1）**：全新访客（无 `localStorage` 安装配置的浏览器）打开站点会进入**安装引导**，不会加载服务端已保存的站点设计——这意味着 H-1 声称的"跨设备、跨访客事实来源"实际未达成，也是 V-03/V-20 当前爆炸半径受限的原因（详见 §10）。

### 阶段 6：影响与持久化

- 无文件上传 getshell：上传是"独立资产 + 下载接口"，无服务端可执行落点；上传检查 + 存储路径防护有效。
- 无 SQL 注入：全部 Ent 构造器参数化；错误响应统一 problem+json，未泄露 SQL/栈。
- 持久化只能靠**内容/设计数据**（XSS、恶意 CSS、大量垃圾内容）和**凭据**；没有发现服务端命令执行或任意文件读写。
- DoS：受控测试下 Argon2 并发未打挂安全服务（H-5 修复有效）；但**开放注册 + 无配额草稿**可以低成本增长数据库（`V-06`）；匿名 analytics 写入（`V-10`，已知 DATA-2）同样可污染统计表。

---

## 4. 确认漏洞

### V-01（High，新发现，Lead 复核）媒体对象级授权缺失：任意注册用户可枚举媒体库，任意人可下载未发布草稿的附件

- **攻击者：** P2 免费注册用户（列表+下载）；P1 匿名（按 ID/拿到链接后下载）
- **影响：** 泄露全站媒体资产：管理员/编辑**未发布草稿里的附件、图片**、站点素材、头像；可形成"草稿保密但附件全公开"的不一致；匿名可下载任意 clean 资产（公网站点）。
- **复现（i0，2026-11-02T04:23Z）：**
  1. 管理员上传一个未被任何内容引用的附件（`purpose=attachment`，`%PDF-1.4` 测试文件）→ `complete` 返回 asset id `01a19a7f-5582-...`、`scan_status=clean`；
  2. 新注册 member `mediaatk+…@evil.test`：`GET /api/v1/media?limit=100` → **200**，列表含该附件（也含站点所有其他资产）；
  3. 该 member：`GET /api/v1/media/01a19a7f-5582-...` → **200 `application/pdf`**，正文即附件内容；
  4. 匿名：`GET /api/v1/media/01a19a7f-5582-...` → **200**，`Content-Disposition: inline`；
  5. 对照：同一份附件所属的**草稿文章**被 member 读取时返回 **404**（正文保密，附件不保密）。
- **根因：** `apps/api/internal/media/handler.go`（`ListAssets` 只要求登录、`openForCaller` 匿名分支只按站点范围）；`apps/api/internal/media/service.go`（`OpenAsset/OpenAssetInSite` 只校验站点 + `scan_status=clean`，没有 owner/被已发布内容引用/用途谓词）。列表项也不含 owner 字段，无法在前端区分归属。
- **影响边界（Authz 面补测 2026-11-02T04:24Z）：** 匿名可下载的是**任意 clean 资产**，不是"仅已发布内容引用"：`content` 已发布引用 200、`content` 未引用 200、`attachment` 私有 PDF 未引用 200、`avatar` 未引用 200、`site` 图未引用 200，全部 `Content-Disposition: inline`。媒体列表字段为 `created_at/id/mime_type/purpose/scan_reason/scan_status/size/storage_key/url`，**不含 owner/上传者**（不泄露归属，但 id 足以逐个下载；ULID 随机部分 80 bit，匿名侧需先拿到 id）。本版本私信只有正文、无附件面，不存在私信附件泄露路径。`members_only` 站点匿名仍 401（D-4 修复有效面）。
- **修复建议（最小）：** 列表只对 `editor+` 开放，或按 owner 过滤；下载增加"owner==actor 或 资产被已发布 revision 引用 或 editor+"；匿名仅允许 `purpose∈{content,site,avatar}` 且被已发布内容引用的资产。与 2026-10-31 审计 DATA-4 的修复方向一致（那次只解决了"已发布文章图片匿名可读"，没有解决"对象级归属"）。

### V-02（Medium，新发现，Lead 独立复现 + Authz 面交叉确认）角色/成员状态变更不即时生效：access token 内的旧 `role` 与身份被多个模块继续信任

- **攻击者：** 持有一个**曾经**合法的高权限/已撤权 token 的人（被解雇编辑、被盗账号、被挂起/移除的成员）
- **影响：** 撤职/挂起/移出站点后最长 15 分钟（access token TTL）内仍可：跳过审核直接发布内容（review 模式）、继续评论、继续建草稿、继续用媒体/通知/事件接口。被移除成员不再是站点成员却仍能向该站写入内容。不涉及站点管理接口（那些读数据库角色，立刻生效）。
- **复现（i0，2026-11-02T04:17Z）：**
  1. 管理员创建一个 `site_admin` 用户 A → A 登录，token claim `role=site_admin`；A 建稿+发布 → 200；
  2. 管理员把 A 降为 `member`（`PATCH /sites/{id}/members/{uid}/role` → 204）；
  3. A 用**旧 token**：`POST /articles` → 201；`POST /articles/{id}/publish` → **200**（直接发布）；
  4. A 重新登录拿新 token：`role=member`，同样操作 publish → **409「该站点要求先提交审核」**；
  5. 同类：管理员挂起 member B → B 旧 token 仍 `POST /comments` 201、`POST /articles` 201；管理员移除 member C → C 旧 token 仍 `POST /articles` 201；但 `GET /sites/{id}` 对挂起者 403（该模块查库）。
- **根因：** 授权判断在多个模块直接使用 JWT claim：`apps/api/cmd/server/main.go` 把 `middleware.PrincipalFrom` 的 `Role/SiteID` 灌进 content/community/messaging/media/notifications/events 的 Actor；`apps/api/internal/content/domain.go`、`community/domain.go` 等按 token role 判定；`auth/tokens.go` 的 access token 校验是纯签名/声明校验，不查会话/成员状态。
- **修复建议：** 对**写操作**在 handler 入口用数据库成员状态覆盖 token role（或统一 guard 中间件按 siteID+userID 查一次 active membership，失败即 401/403）；或在成员状态/角色变更时吊销该用户全部会话（session 表已有，可实现）。至少内容发布、评论、上传、私信写入要先过 DB 成员校验。

### V-03（Medium，新发现；Content 面真实 Chromium 验证）H-1 服务端持久化把"站点设计"变成全站分发面，但服务端零内容校验：`custom_css` 可做持久 CSS 重绘/钓鱼覆盖层

- **攻击者：** ①`site_admin`/`platform_admin`（如被雇佣编辑、被盗站长账号）；②更现实：站长被诱导**导入第三方导出的设计包**（产品自带导入/导出，导入后 `customizationSync` 会把整份文档原样 PUT 到服务端，此后每个已安装浏览器都拉取应用）。
- **影响：** `customization.custom_css`（≤20,000 字符）原样进入全站 `<style>`，可隐藏真实 UI、铺满全屏伪造"会话已过期/请重新登录"覆盖层（纯 CSS，`position:fixed; inset:0; z-index:2147483647`），也可 `url()`/`@import` 向第三方发信标；同文档里的 `code` 区块（`html/css/js` 原样进 `iframe[sandbox="allow-scripts"]`）会随设计文档在**每个访客**浏览器执行（不同源，但可发信标/伪造 iframe 区域/耗 CPU）。这不是 H-3 的回归：服务端 ammonia 对文章路径 0 绕过、客户端 H-3 scheme 清洗器 0 绕过；问题是 H-1 把原本"站长本机自伤"的字段升级成"服务端分发给所有已安装浏览器"后，**没有任何一层做内容安全校验**。
- **复现（i3，2026-11-02T04:40Z）：** 站点管理员 PUT `{"customization":{"custom_css":"html{outline:9px solid rgb(255,0,0)} body::before{content:\"会话已过期…\";position:fixed;inset:0;z-index:2147483647;…}"},"revision":N}` → 200 revision+1；匿名 GET 读回同一文档；匿名 Chrome（仅注入安装配置、不登录）→ `htmlOutline=rgb(255,0,0)`、全屏伪层生效（截图 `work/content/evidence/css-overlay.png`）。
- **前提/当前爆炸半径（重要，见 O-1）：** 受害浏览器需已存在本站安装配置（`localStorage['pp.web.config.v1']`）——当前"全新访客"会先看到安装引导、不会 hydrate 服务端设计（见 §10 O-1）。所以当前影响面 = 所有已完成安装/连接的浏览器（站长多设备、同机多浏览器）；**一旦补上匿名访客 bootstrap，本项与 V-20 的影响面会扩大到全部访客，应相应上调为 High。**
- **根因：** `apps/api/internal/site/customization.go:83-95`（只校验 JSON 对象/大小）；`apps/web/src/lib/customize.ts:729`（`custom_css` 仅截断长度）；`apps/web/src/components/SiteChrome.tsx:532`（原样 `<style>`）；`apps/web/src/lib/customizationSync.ts:325-350`（保存时上传原始对象）；导入链路 `pages/admin/Appearance.tsx:139-150` + `lib/customize.ts:962-984`。
- **修复建议：** 服务端对 customization 做字段级 schema 白名单（`custom_css` 只允许声明块/变量、禁 `@`/`url(`/全屏定位；`code` 区块与 `custom_extensions` 标记为"需站长二次确认"；未知字段拒绝而非透传）；前端 `custom_css` 用 CSSOM 逐条校验后 `insertRule`，非法规则丢弃；导入流程对"自定义 CSS/代码区块/页面编排"做字段级差异预览与二次确认。

### V-04（High，前提：launcher 置于同机反向代理之后；Lead 独立复现 + Infra 面确认）启动器运行时接口把"同机反代"当成本机：未认证远程可改监听端口造成持续 DoS，并泄露内部信息

- **攻击者：** P1 公网（前提：站长按常规做法在 launcher 前放同机 Nginx/TLS 反代，且反代把 `/__pp/*` 一起转发——`location / { proxy_pass ... }` 的常见写法）。
- **影响：**
  1. **未认证改端口 → 持续 DoS**：`POST /__pp/runtime/port` 只校验 `RemoteAddr` 是否回环（同机反代后天然是 127.0.0.1；Origin 头可缺省，curl/脚本即可），攻击者可把站点改到任意端口 → 旧端口立即拒绝连接、反代持续 502，且端口选择持久化到 `practacu-web.json`，**重启不会自动恢复**（需站长手动改回）。
  2. **内部信息泄露**：`GET /__pp/runtime` 没有回环校验（相邻接口都有），匿名返回安装目录绝对路径、日志路径、内部 API 端口、PID、安全服务状态。
  3. **迁移数据读取**：改端口响应里的 `import_token` 可换取 `GET /__pp/state/<token>`（2 分钟一次性）读到浏览器迁移快照。
- **复现（Lead 在全新 i5 上独立复现，2026-11-02T04:30Z）：** 起一个同机 Node 反代 `127.0.0.1:19085 -> 127.0.0.1:18085` 模拟 Nginx；不带任何凭据/Origin：`POST http://127.0.0.1:19085/__pp/runtime/port {"port":18086}` → **200**，`{"ok":true,"port":18086,"previous":18085}`；随后 18085 拒绝连接、18086 正常服务、**反代 502**；再 POST 回 18085 才恢复。Infra 面独立记录同现象并读到 `/__pp/state`。
- **缓解/前提：** 纯本机回环访问（不暴露）时仅本机进程可利用；项目默认只绑回环，因此"直接暴露"不是默认行为。但只要站长把 launcher 放进反代对外提供站点（本项目鼓励的部署方式），该前提就成立。
- **根因：** `apps/launcher/main.go`（`handlePortChange`/`handleStateImport` 用 `r.RemoteAddr` 判本机，代理场景失效；`handleRuntime` 根本没有本机校验）。
- **修复建议：** Nginx 只转发 `/`、`/api/`、`/healthz`、`/readyz`，显式 `location /__pp/ { return 404; }`；launcher 端对 `/__pp/*` 增加不可绕过的校验（一次性启动 token 由站长在本地打开时携带、校验 `X-Forwarded-For` 为空 + `Host` 为回环、或改为本地 Unix/命名管道控制面）；文档显著提示"不要把 launcher 端口直接反代到公网"。Windows 启动器形态建议默认彻底关闭公网可达的端口修改接口。

### V-05（Medium，已知未修 WEB-4 复核）缺少 CSP / X-Frame-Options / Referrer-Policy / HSTS / Permissions-Policy

- 实测所有响应只有 `X-Content-Type-Options: nosniff`；站点可被任意站点 iframe 嵌入（点击劫持/钓鱼），无 CSP 意味着一旦出现 HTML 注入没有任何第二道防线，HSTS 缺失让"装完在反代加 TLS"的部署存在降级/中间人窗口。Content 面用真实 Chromium 确认站点可被跨源 iframe 加载（`clickjacking.png`）。
- 根因：`apps/launcher/main.go` 静态服务与 `apps/api` 中间件均未设置安全头；`deploy/docker/web.Dockerfile` 的 Nginx 配置同样未设置（Infra 面确认）。
- 修复：启动器/Nginx 加 `Content-Security-Policy`（至少 `frame-ancestors 'self'; script-src 'self'`，注意内联主题/扩展 iframe 的兼容）、`X-Frame-Options: SAMEORIGIN`、`Referrer-Policy`、`Permissions-Policy`、生产 TLS 下 `Strict-Transport-Security`。

### V-06（Medium，新发现，Lead 实测）开放注册 + 无配额草稿 = 低成本存储/审核队列耗尽

- **攻击者：** P2（免费注册）。
- **实测（i0）：** 管理员/成员 `POST /articles` 单篇 source_body 上限 200,000 字符（超限 400）；3 篇 150KB 正文在 82ms 内全部 201（约 450KB 入 SQLite）。按启动器 1200 请求/分/进程与 Compose 240 请求/分的限流，仅一篇/秒的速度就能在数分钟内写入数百 MB（SQLite 文件 + WAL），并同时把审核队列刷满（默认 review 模式）。注册没有任何审核/邀请限制。
- **根因：** `apps/api/internal/content/domain.go` 只有单篇上限，没有账号级配额/频率；注册默认开放；限流是进程内每 IP 固定窗口（多 IP 绕过）。
- **修复建议：** 注册加可选邀请码/邮件验证/管理员审核开关；草稿数量/总字节按账号配额；审核队列分页与批量处理；对 `POST /articles` 加账号级更严限流。部署侧在反代加 WAF/CC 规则。

### V-07（Low，已知未修 L-3）WebSocket 不校验 Origin

- 实测带 `Origin: https://evil.example` 的 WS 握手在 `CORS_ALLOWED_ORIGINS` 为空时成功建立（200 open）。缓解：连接必须携带一次性 `ws-ticket`（登录后签发、60 秒、一次性、站内作用域），恶意站点拿不到受害者的 ticket，因此不能直接跨站劫持会话；但 Origin 校验缺失仍是纵深防御缺口。
- 根因：`apps/api/internal/transport/ws/handler.go`（`InsecureSkipVerify: true` 当未配置来源模式时）。
- 修复：默认只接受同源 Origin；跨源场景显式配置白名单。

### V-08（Low，新发现）登出后 access token 在有效期内仍可用

- 实测：`POST /auth/logout` 204 后，用登出前拿到的 access token `GET /me` 仍 200；refresh 已失效（401）。TTL 15 分钟。属标准 JWT 取舍，但前端"退出登录"的语义应说明或改为短期 token + 撤销列表。
- 修复建议：access token TTL 缩短到 2-5 分钟并静默刷新；或维护 jti 撤销表（登出/改密时写入）。

### V-09（Low，新发现）安装元数据匿名可见

- `GET /api/v1/setup/status` 匿名返回 `site_id/site_name/has_admin`。`site_id` 被大量接口路径使用、站点名可能是未公开品牌；`has_admin=false` 直接告诉攻击者"这里可以抢注管理员"。
- 修复：未安装时也无须返回站点名；或在响应里去掉 `site_name` 与 `site_id`（前端需要时可用 `GET /sites/{id}/customization` 已经匿名可读的公开信息替代）。

### V-10（Medium，已知未修 DATA-2）分析埋点匿名可写、报表全量读内存

- 上一轮审计已确认为 Medium（允许未认证写入，报表把整个时间窗读入内存）。本轮 **Authz 面完整复现**（i2，2026-11-02T04:19–04:21Z）：匿名 `POST /api/v1/analytics/visits {"path":"/pwned-by-anonymous","session":"atk-…","surface":"site","title":"PWNED TITLE","referrer":"https://evil.example/"}` → **204**；管理员 `GET /sites/{id}/analytics?range=24h` → 200，`top_pages`/`recent` 里出现攻击者注入的 path/title/referrer，连 `<script>alert(1)</script>` 也被原样存进 title（前端以文本渲染时只是数据污染）。`members_only` 站点匿名写入同样 204。
- 根因：`apps/api/internal/analytics/handler.go:54`（匿名路由）、`:110-135`（只要求 host 解析到站点，不要求身份/可见性/去重）；报表全量读窗口（DATA-2 后半）。
- 修复：匿名写加站点 visibility 判定 + 会话/路径幂等去重（`(site_id, session, path, minute)` 唯一索引）；报表改 SQL 聚合分页。

### V-11（Medium，已知未修 DATA-1）members_only 站点匿名可读 taxonomy

- Authz 面实测仍存在（i2，2026-11-02T04:19:49Z）：把站点切为 `members_only` 后，匿名 `GET /articles`、`GET /articles/{published}`、`GET /comments`、`GET /search`、`GET /users/{member}`、`GET /sites/{id}/customization` 全部 401/404，**唯独 `GET /sites/{id}/taxonomy` → 200**，返回分类/标签名称。
- 根因：`apps/api/internal/taxonomy/handler.go:94-111` 没有 `resolved.IsMembersOnly()` 判定（content/community/site 都有，taxonomy 是唯一遗漏）。
- 修复：照抄 `content/handler.go:60-63` 的匿名拒绝逻辑；建议抽公共 `allowsAnonymous(site)` 给四个模块共用。

### V-12（Medium，已知未修 AUTH-6）任意 site_admin 可声明任意未占用域名（无所有权验证）

- 上一轮审计已确认：`domain_verified_at` 直接写 now，无任何 DNS/TXT/文件挑战；schema 里预留的 `domain_verification_token` 从不写入。本轮 **Authz 面复现并补充可用性副作用**（i2，04:17:20Z）：
  1. `site_admin` 执行 `PUT /sites/{id}/domain {"domain":"evil-claim.i2.test"}` → 204；
  2. 之后所有原 Host（`127.0.0.1:18082`）请求 → 404 `site_not_found`（launcher 前端与 API 全部不可用，等同站点被"绑走"/自伤停机）；
  3. 恢复只能发 `Host: evil-claim.i2.test` 的请求（Host 头成了唯一访问凭证）或直接改库。
- 修复：实现已预留的 DNS/文件验证挑战后再置 `domain_verified_at`；或把端点收敛为 platform_admin + 运维操作；单站点桌面形态限制只能声明回环/内网地址。

### V-13（Medium，已知未修 AUTH-4，Auth 面实测）登录账号枚举：未知邮箱在哈希前提前返回，耗时差约 85 倍

- **攻击者：** 匿名。
- **影响：** 可批量判定任意邮箱是否在本安装注册过（install-global 唯一），对管理员邮箱枚举后可配合 V-24 做定向口令爆破。响应体完全同形，仅耗时不同：未知邮箱 **1.4ms** vs 已注册+错密码 **118.8ms**（n=5，85 倍差；Lead 在 i0 复测 5ms vs 164ms 同样成立，单次即可判定）。
- **根因：** `apps/api/internal/auth/service.go:270-276`（未知账号提前返回）、`:286`（仅存在账号才 Verify）、`:301-303`（禁用分支）；`handler.go:479-480`（禁用映射 403 `account_disabled`，与 401 可区分）。
- **修复建议：** 未知账号分支对固定占位 PHC 串执行一次 dummy `Verify`；禁用账号统一返回 `invalid_credentials`（密码校验通过后再提示），保证响应体与耗时同形。

### V-14（Low，新发现）私信会话成员注入：可把任意 userID（含不存在用户/管理员）写进会话成员

- **攻击者：** 任意登录用户（member）。
- **影响：** `POST /api/v1/conversations` 的 `members` 只做数量/去重/非空校验，不校验目标是否为**本站活跃成员**、甚至不校验用户是否存在。可（a）写入不存在的 ULID 造成幽灵成员/数据污染；（b）单方面把任意真实用户（含管理员）拉进群会话，管理员会话列表中立即出现该会话（实测 `GET /conversations as admin` 返回被注入会话），可用于钓鱼/骚扰。单站点部署无跨租户受害者，故 Low；多站点部署下可能构成跨站成员关系写入。
- **证据（i2，04:21Z）：** `POST /conversations {"kind":"group","members":[<editor>, "01a19a76-0000-0000-0000-000000000000"]}` → 201，返回的 members 含不存在的用户；`POST ... {"members":[<admin>,<site_admin>]}` → 201 并出现在 admin 的会话列表。
- **根因：** `apps/api/internal/messaging/service.go:54-86`（`StartConversation` 只调 `ValidateDirectMembers/ValidateGroupMembers`，`messaging/domain.go:134-165` 只查数量/去重）；store 直接写 `conversation_member`，无 `site.Membership` 查询。
- **修复：** 对每个 memberID 查 `siteService.Membership(actor.SiteID, id)`，非本站活跃成员一律 `ErrInvalidInput`；群聊改为邀请-接受两阶段。

### V-15（Low，新发现）社区互动目标不校验存在性/可见性

- **攻击者：** 任意登录用户。
- **影响：** 可对不存在的文章 id 或**未发布草稿 id** 创建评论（201）、reaction/bookmark（200）、follow 不存在的用户（200），在数据库制造指向不存在/不可见对象的关系行；污染互动计数与后续风控数据。草稿 id 不可枚举，故维持 Low。
- **证据（i2，04:21Z）：** 对 `01a19a76-0000-…` 的 comment/reaction/bookmark/follow 全部 201/200；对他人草稿 id 评论 201。
- **根因：** `apps/api/internal/community/service.go:88-106`（评论只校验父评论 site/深度，不校验 target）、`:279-315`、`:332-380`（互动直接落库不查目标）；关系表插入无外键。
- **修复：** 写入前校验目标存在且对调用者可见（评论/reaction/bookmark：已发布；follow：本站活跃成员），或加外键 + 站点谓词。

### V-16（Medium，新发现，Lead 独立复现 + Infra 面确认）全新实例"先暴露后安装"：第一个注册者确定性地成为 platform_admin

- **攻击者：** P1 公网（实例已启动但尚未注册管理员、且 web 端口可达）。
- **影响：** 桌面/Compose 引导把"第一个注册账号"提升为 platform_admin（`BootstrapFirstAdmin`）。这不是竞态而是**确定性行为**：攻击者只要比站长早一步访问站点，就能完成"安装"，随后改站点设置/发内容/建 site_admin 全部成功，站长再注册只是普通 member（站点实际被攻击者接管）。
- **复现（Lead 在全新 i5 上独立复现，04:30:38Z）：** `GET /api/v1/setup/status` → `{"has_admin":false,...}`；匿名 `POST /auth/register/email` → 201；`GET /me` → **`role=platform_admin`**；`PATCH /sites/{id}/settings` → **204**；站点名变为 `PWNED BY ATTACKER`。Infra 面同样复现（确定性、非竞态）。
- **前提/定级说明：** 默认 launcher/Compose 只绑 `127.0.0.1`，README 也明确"装完后才对外开放"，纯默认不可远程利用 → 故 Medium；一旦"先暴露再安装"（自建反代、容器端口映射、云主机安全组提前放行）→ **High/Critical（平台被接管）**。与既有 L-4/L-5 同源，本轮建议从 Low 上调并产品化防护。
- **根因：** `apps/api/cmd/server/bootstrap.go` + `auth/service.go` 的 `bootstrapFirstAdmin` 规则；`setup/status` 公开 `has_admin` 直接把"可抢注窗口"告诉攻击者。
- **修复建议：** 安装引导改为一次性安装令牌/本机回环校验（与 V-04 同一套本机控制面）；或首次启动生成随机安装码打印在启动器窗口，注册管理员必须携带；至少确保"有站点但无管理员"时禁止非回环注册；`setup/status` 不返回 `has_admin`。

### V-17（Medium，新发现；仅静态+日志实测，容器未实跑）docker-compose 默认是"开发形态"上线

- `docker-compose.yml` 默认：`APP_ENV=development`、`PP_DESKTOP=true`、`PP_ALLOW_REMOTE_API=1`、`TRUSTED_PROXIES=172.28.0.0/16`；未设置 `AUTH_JWT_ED25519_PRIVATE_KEY` → API 每次启动生成临时密钥，**重启后所有人被登出**（运维/安全双重问题）；`COOKIE_SECURE` 在 development 下不强制（经 TLS 反代时 Cookie 仍可能走明文）；gin debug 模式把路由表写进 `api.log`；Nginx 侧无 CSP/HSTS/XFO/TLS/`server_tokens off`。
- 影响：默认交付即"开发配置上生产"，与 README 的"生产必填/建议"存在落差；日志与 Cookie 属性弱化。属配置/交付问题，非代码漏洞（未实跑 Docker，静态+运行时日志证据）。
- 修复：镜像/compose 提供 production profile（持久 JWT key、`APP_ENV=production`、Secure Cookie、Nginx 安全头与 TLS 模板、关闭 debug 路由日志）。

### V-18（Low，新发现）`practacu-web.json` 明文存 Ed25519 JWT 私钥，权限依赖继承 ACL

- Windows 启动器把站点签名私钥明文写在 exe 同目录 `practacu-web.json`（0644，实测 ACL 依赖目录继承：本机 `Authenticated Users: M` / `Users: RX`）。任何能读该文件的人（同机其他用户、备份/同步工具、误打包的 `data/` 副本）都可**伪造任意角色 token**（平台管理员）——这是本机"文件泄露→全站接管"的直达链路；不可远程直接利用，故 Low。
- 修复：DPAPI/凭据管理器保存私钥；文件 ACL 收紧为仅当前用户；文档提醒备份/分享时排除该文件；发布包与数据目录分离。

### V-19（Low，部署面，已知未修 L-3/SEC-5 复核）WebSocket Origin 不校验、安全服务 gRPC 明文无认证

- WS（`V-07`）与 gRPC（SEC-5/S-4）复核仍存在；gRPC 默认仅回环监听，只有本机/同容器网络可达，不单独提高定级。

### V-20（Medium，新发现；Content 面真实 Chromium 验证）定制化 text 区块客户端清洗器保留 `id`/`name` → DOM clobbering，全站白屏（持久 DoS，无需点击）

- **前提：** 同 V-03（`ManageSite` 或导入恶意设计包；受害浏览器已安装配置）。**文章路径不受影响**：服务端 ammonia 会丢弃 `id`/`name`（实测渲染为 `<p><img src="x"></p>`），所以这是定制化文档独有的客户端 sink。
- **影响：** text 区块正文走 `dangerouslySetInnerHTML={{__html: sanitizeHtml(renderMarkdown(body))}}`（`components/blocks/MediaBlocks.tsx:51`），而 `sanitizeHtml` 只删 `on*`/`srcdoc`/`style` 与非法 URL 属性，**保留 `id`/`name`**。`<img name="getElementById" src=x>` 覆盖 `document.getElementById`，根组件 `CustomizationLayer` 的 `useLayoutEffect` 无条件调用 `document.getElementById('pp-theme')` → TypeError → React 整树卸载 → **每个访问者白屏**；站长重新打开后台也白屏，须手工清文档才能恢复。
- **复现（i3）：** PUT customization `home.blocks` 内两个 text 区块，第一个 body = `<p>欢迎</p><img name="getElementById" src=x>` → 匿名 Chrome `pageerror: TypeError: document.getElementById is not a function`，`bodyLen=0`（`evidence/clobber-mxss-results.json`、纯白截图）；对照组 `<img name="fetch">`/`<img name="parent">` 正常渲染（证明命中的是真实 gadget 而非任意 name 崩溃）。
- **根因：** `apps/web/src/lib/markdown.ts:446-484`（sanitizeHtml 未处理 `id`/`name`）；`apps/web/src/components/CustomizationLayer.tsx:13`（布局副作用依赖 `getElementById`）。
- **修复：** sanitizeHtml 删除/白名单 `id`、`name`（以及 `is`、`form`、`for` 等 named-access 属性）；`CustomizationLayer` 改用 ref 而不是 `getElementById`；服务端同步方案见 V-03。

### V-21（Low，新发现）定制化 text 区块 `<a target="_blank">` 不补 `rel=noopener/noreferrer`（反向 tabnabbing）

- 内容：客户端 `sanitizeHtml` 不处理 `target`/`rel`，定制化文本里的外链新标签页可通过 `window.opener` 反向改写本站页面；服务端 ammonia 对文章路径会补 `rel`，前端路径没有对齐。修复：客户端清洗器对 `target=_blank` 强制补 `rel=noopener noreferrer`（或直接用 React 组件渲染链接）。

### V-22（Low，已知未修复核）SEC-7 上传"4 字节魔数 + 声明 MIME"即可把 HTML 内容判 clean；SEC-11 文章保留任意 `class`

- **SEC-7（已知未修，Content 面复测）：** 声明 `image/png` + `%PNG` 前缀的 HTML/polyglot 文件 `complete` 后 `scan_status=clean` 并可 inline 下载；当前因**声明 MIME + `X-Content-Type-Options: nosniff`** 浏览器不会按 HTML 执行，故维持 Low；若未来放开 MIME/下载策略即升级为存储型 XSS。（另发现响应头 `X-Content-Type-Options: nosniff, nosniff` 重复——launcher 与 API 各加一次，无害但可清理。）
- **SEC-11（已知未修，复测）：** 文章 HTML 保留任意 `class`（如 `<p class="btn btn-danger">`），可在正文内伪装站点 UI；结合 V-03 的 CSS 面可做更精细的钓鱼。
- **修复：** 上传检查改为真实类型探测（不只前缀），下载按允许列表强制 `Content-Type` + `Content-Security-Policy: sandbox`；class 改为站点白名单前缀（如 `pp-*`）。

### V-23（Medium，已知未修 AUTH-2，Auth 面实测）refresh 族没有绝对寿命：每次轮换把有效期重置为"现在 + 30 天"

- **攻击者：** 窃取到 `pp_refresh` cookie 的人（备份/终端失陷/日志邻接存储等）。
- **影响：** 只要每 30 天内刷新一次，令牌族永不过期——被窃会话可无限续命（与 `RefreshTTL` 注释声明的 "absolute lifetime of one refresh lineage" 相反）。实测 `refresh_expires_at` 每次轮换整体后移（+2146ms），无 `family_created_at`。
- **根因：** `apps/api/internal/auth/service.go:449-459`（轮换时 `ExpiresAt = now + 30d`）；无族创建时间字段。
- **修复建议：** refresh 族落库 `family_created_at`/`family_expires_at`，轮换时只继承不重置；超过绝对寿命整族撤销。

### V-24（Medium，已知未修 AUTH-3，Auth 面实测）登录没有按账号的失败计数/锁定，唯一屏障是"每 IP 10 次/分钟"

- **攻击者：** 分布式 IP 或 IPv6 轮换的攻击者；对本机单 IP 也只需等待窗口。
- **影响：** 连续 5 次错误后正确密码仍 200（无账号级退避）；唯一限制是 `AUTH_CREDENTIAL_RATE_LIMIT_PER_MINUTE=10` 的**每 IP** 固定窗口（4 个凭据端点共享，第 11 次 429 + Retry-After；伪造 X-Forwarded-For/X-Real-IP 在未配置可信代理时不重置预算——防御有效）。多 IP 即可对单个账号进行无上限口令爆破；结合 V-13 可先枚举出管理员邮箱。
- **根因：** `apps/api/internal/auth/service.go` 登录路径没有 per-account 计数/锁定；限流中间件 `middleware/rate_limit.go` 按 IP 固定窗口。
- **修复建议：** 按"账号 + IP"双键退避（指数/验证码），并对失败计数做服务端持久化（多副本一致）。

### V-25（Low，新发现）refresh 并发轮换时复用检测失效：CAS 输家返回 401 但不撤销族

- **攻击者：** 同时持有同一 refresh token 的攻击者与受害者（竞态窗口）。
- **影响：** 同一 refresh token 并发两次刷新时，CAS 输家返回 `401 session_revoked` 而非 `refresh_reuse`，且**不撤销族**；3 次试验中 2 次"赢家新 token 仍可刷新（200）"——即受害者被登出、攻击者会话存活，与"重放即撤销整族"的设计承诺不符。
- **根因：** `apps/api/internal/auth/service.go:371-377`（并发 CAS 失败路径没有按 reuse 处理）。
- **修复建议：** CAS 失败一律按 reuse 处理：撤销整族 + 记录安全事件；与 V-23 同一处逻辑一起改。

### V-26（Low，新发现）登录/注册端点不校验 Origin 且不强制 JSON Content-Type → 登录 CSRF 面

- **攻击者：** 恶意站点（受浏览器第三方 Cookie 策略影响，故 Low）。
- **影响：** `Origin: http://evil.example` + `Content-Type: text/plain` 的 JSON 登录请求实测 **200 并 Set-Cookie**（`text/plain` 是 CORS simple request，无预检）；若浏览器允许第三方 Cookie，恶意站点可把受害者静默登录进攻击者账号（登录 CSRF / session fixation 变体）。
- **根因：** 认证端点未要求 `application/json`（`ShouldBindJSON` 不校验媒体类型）且无 Origin 校验。
- **修复建议：** 所有跨站可发的认证写端点强制 `Content-Type: application/json`（拒绝 text/plain）+ 校验 `Origin`/`Sec-Fetch-Site`；Cookie 保持 SameSite=Lax/Strict。

### V-27（Low，新发现）refresh 的 CSRF 双提交 token 不与会话绑定

- **影响：** 任意相等的 cookie/header pair 即可通过 CSRF 校验；已撤销旧会话的旧 csrf 值配新 refresh cookie 也可通过（403 只在缺失/不等时触发）。攻击面有限（需能写 cookie），但使 CSRF 防护退化为"任意常量"。
- **根因：** `apps/api/internal/auth/handler.go:345-360` 只做双提交等值比较，csrf 未绑定 session/refresh token。
- **修复建议：** CSRF token 与会话绑定（会话内随机 + 刷新时轮换），或改用 SameSite + Origin 校验为主。

### V-28（Low，新发现，Lead 复核）256–320 字符邮箱注册返回 500（校验上限与持久层长度不一致）

- **攻击者：** 匿名。
- **影响：** 255 字符注册 → 201，**260 字符 → 500**（Lead 在 i0 复现：`{"code":"internal","status":500}`）；API 日志 `ent: validator failed for field "UserIdentity.provider_subject": value is greater than the required length`。`validation.go MaxEmailLength=320` 与 schema `MaxLen 255` 不一致，属输入校验缺陷（可制造 5xx/日志噪音，不影响数据）。
- **根因：** `apps/api/internal/auth/validation.go`（MaxEmailLength=320）vs `apps/api/ent/schema/useridentity.go`（MaxLen 255）。
- **修复建议：** 统一单一上限（建议 254 按 RFC 5321），在 API 层返回 400 而不是落到 ent 5xx。

### V-29（Low，已知未修 AUTH-7/AUTH-8 复核）`POST /auth/logout` 无 CSRF（可跨站强制登出）；注册 409 `identity_exists` 可枚举账号

- AUTH-7：仅 cookie + 外站 Origin → 204（开发形态 SameSite=Lax 缓解；生产若 SameSite=None 可跨站）。修复：logout 也校验 Origin/CSRF。
- AUTH-8：注册重复邮箱返回 409 `identity_exists`（与 V-13 的登录时序互补）。修复：注册接口对重复邮箱返回统一 202/409 模糊语义或加验证码。

### V-30（Low，hardening 复核）密码策略仅长度：8 个空格即为合法密码

- Auth 面实测：`"        "`（8 空格）可注册且可登录 200；无强度/字符类/常见口令检查（Argon2id 抗离线爆破，但弱口令仍可被在线撞库，结合 V-24 无账号锁定更危险）。
- 修复：密码策略增加最小字符类/常见弱口令黑名单/长度上限（如 8–128），登录失败走 V-24 的退避。

---

## 5. 上一轮 High 的复测结果

| 编号 | 内容 | 复测结论 |
| --- | --- | --- |
| H-1 | 站点设计只存 localStorage | **已修但验收有缺口**：`GET/PUT /sites/{id}/customization` 服务端持久化、乐观锁、1MB 上限、只接受 JSON 对象；跨浏览器可同步。**但全新访客不会加载服务端设计（进入安装引导，O-1）**；且服务端零内容校验引入 `V-03`/`V-20` |
| H-2 | token 不绑定 Host 解析站点 | **已修**：`RequireAuthForSite`/`OptionalAuth` 站点比对、`PublicUser` 改为查本站点成员；members_only 下匿名读 PublicUser 401、customization 404（Authz 面实测） |
| H-3 | 客户端清洗器 `javascript:` tab 绕过 | **修复有效**：真实 Chromium 下 30 条 scheme/mXSS 语料 0 执行——但 `id/name` 不在 H-3 范围（`V-20` 是另一类新问题，不是旧洞回归） |
| H-4 | 主题 token CSS 注入 | **修复有效**：`safeCssValue` 整串白名单；实测恶意 token 被丢弃 |
| H-5 | Argon2 阻塞 async 运行时 | **修复有效**：10 并发真实 Argon2 总 1054ms、内存峰值 263MiB、`/readyz` 全程 1–20ms、并发期间发布 3ms 成功（Infra 面数据） |
| DATA-4 | 匿名媒体下载 401 | **已修**：公网站点匿名下载 200、members_only 401；但对象级授权仍缺失（`V-01`） |

---

## 6. 攻击失败 / 防御有效清单（本轮实测）

| 攻击面 | 尝试 | 结果 |
| --- | --- | --- |
| JWT 伪造 | alg=none、HS256 混淆、kid 篡改/注入、真实 payload 篡改（role/exp/sid/sub）、签名截断/拼接、过期 token、双 token | 全部 401 |
| 会话 | refresh 双提交校验、refresh 顺序重放（族撤销）、跨站 refresh、会话轮换 | 顺序重放触发 `refresh_reuse` 整族撤销；缺/错 CSRF 403 |
| 登录/注册边界 | 邮箱大小写/空白归一、CRLF 注入、5000 字符密码、方法覆盖、开放重定向 | 归一化正确、CRLF 拒绝、长密码快速 401（不烧 Argon2）、无开放重定向 |
| 限流 | 凭据 10/min/IP、全局 1200/min、伪造 XFF/X-Real-IP 绕过 | 第 11 次 429 + Retry-After；全局 ~1170 次起 429；伪造头不重置预算（未配置可信代理） |
| WS 票据 | 无 Bearer 签发、重复消费、60s TTL、跨用户事件订阅 | 需 Bearer；单次消费；62s 后 401；事件受众隔离严格（REST+WS 均验证） |
| 写接口 CSRF | 仅带 cookie / 跨站 form / text/plain JSON | 写接口 Bearer-only（cookie-only → 401）；登录端点有 CSRF 面（`V-26`，Low） |
| 内容 IDOR | 匿名/member 直取他人草稿 ID、PATCH、发布、删除动作 | 404/403/409，未越权；草稿 404 无存在性 oracle |
| 已发布内容完整性 | 作者/site_admin 重发布、PATCH 已发布、非法状态跃迁、并发双发布 | 409；1×200+1×409，无双重发布 |
| 审核模式 | member 直接发布自己草稿 / editor 审批他人 pending | member 409 须先审；editor 审批 200（审核流可用） |
| 权限提升 | 自改角色、建号时 role 注入、改站点设置/域名/设计、site_admin 授 platform_admin | 403；未知角色 400；注册伪造 role 被忽略（token=member） |
| 站点 RBAC | member/editor 读写成员列表（含邮箱）、settings、domain、customization、analytics、taxonomy 写 | 全部 403；成员资料/挂起/删除仅 platform_admin |
| 最后管理员保护 | 降级/删除最后一个 platform_admin、挂起自己 | 403 `last_platform_admin` / `self_management` |
| 路径 siteID 越权 | 用真实 token 访问 `/sites/{伪造 ULID}/*`、taxonomy/customization 路径站点不一致 | 全部 403 `cross_site` |
| 自定义化并发 | 旧 revision 写入（H-1 新端点） | 409 `revision_conflict` |
| Host / X-Forwarded-Host | `X-Forwarded-Host: evil.example`、未配置域名的任意 Host | 转发头被忽略；配置已验证域名后不匹配 Host 一律 404 |
| 事件/私信/评论/通知 IDOR | 三类专项：他人会话消息、任意 notification id、评论越权改/删 | 均未发现越权（404/403/按 user+site 过滤） |
| HTML/XSS（服务端） | 75 条载荷：script/on*/javascript: 混淆、svg/math/foreignObject、mXSS、iframe/form/meta/base/template/noscript/srcset/ping/xlink、500 层嵌套、幂等性 | **0 绕过**（ammonia 白名单 + goldmark 顺序正确） |
| HTML/XSS（客户端 H-3） | 30 条 mXSS/scheme 语料，真实 Chrome 打开定制化页面 | **0 执行**（清洗 + React 19 `javascript:` 拦截） |
| 主题 token 注入（H-4） | 构造非法 CSS token / `;}` 闭合 / `url()` | token 被丢弃，未落地 |
| 上传 getshell | HTML/SVG/polyglot 上传（PNG/GIF 魔数 + HTML），MIME 欺骗、声明大小不一致、文件名穿越 | 创建期 MIME 拒绝；声明大小必须=实际；storage_key 服务端生成；nosniff 使 polyglot 不执行（SEC-7 仍记 Low） |
| 静态站路径穿越 | 21 种编码变体（`%2e%2e`、双编码、反斜杠、分号、NUL）读 `practacu-web.json`/`db`/日志 | 全 404，未泄露私钥/数据库/日志 |
| 文本字段 XSS | 标题/摘要/标签/评论/私信/显示名/URL 参数，真实浏览器 | 全部 React 文本节点，0 执行 |
| 图表 SVG | `pp-diagram` 围栏 + 标题/标签/颜色/坐标语料 | `escapeXml` 完整、数值收敛，0 注入 |
| SQL 注入 | 引号/SQL 关键字/畸形 ULID/游标/超长参数 | 全部走 Ent 构造器参数化；统一 problem+json，无栈/SQL 泄露 |
| CSRF | 跨站 form/fetch 触发写操作；refresh 缺 X-CSRF-Token；跨站 WS | Bearer-only + 双提交（定长比较），未成功；WS 需一次性 ticket |
| 匿名读 members_only | 内容/评论/搜索/自定义页/用户资料 | 401/404（taxonomy 除外，`V-11`） |
| 日志/错误泄露 | 触发 4xx/5xx 畸形请求；检查 api.log/err.log/security.log | 响应无栈/路径/SQL；日志无口令/token/邮箱/IP |
| 配置启动校验 | CORS `*`+credentials、production 缺 JWT key、PP_DESKTOP+production、非回环监听 | 全部启动即拒绝 |
| SSRF | 全仓库 Go HTTP 调用面 grep（媒体/URL 抓取/webhook/S3） | **无攻击面**：Go 侧无对外 HTTP 调用，launcher 仅探测写死回环端口 |
| 安全服务 fail-closed | 停掉 Rust 服务后发布/上传 | 503，未降级放行 |
| DoS（受控） | 10–20 并发 Argon2、4MiB body、慢 header/慢 body | 未打挂；慢 header 10s / 慢 body 30s 断开（L-1 有效） |

---

## 7. 与 2026-10-31 静态审计对照

- **已修复并复测通过：** H-1、H-2、H-3、H-4、H-5、D-4、L-1、L-2、DATA-3（部分）。
- **本轮新发现：** `V-01`（媒体对象授权，High）、`V-04`（launcher 反代端口修改/信息泄露，条件 High）、`V-02`（撤权延迟，Medium）、`V-16`（首注册抢管理员，Medium→High）、`V-17`（compose 开发形态上线，Medium）、`V-03`（自定义 CSS 持久钓鱼，Medium）、`V-20`（DOM clobbering 白屏，Medium）、`V-06`（开放注册+资源耗尽，Medium）、`V-09`（安装元数据，Low）、`V-14`（私信成员注入，Low）、`V-15`（互动目标不校验，Low）、`V-18`（JWT 私钥明文，Low）、`V-21`（tabnabbing，Low）、`V-25`（refresh 并发复用检测，Low）、`V-26`（登录 CSRF 面，Low）、`V-27`（refresh CSRF 不绑定，Low）、`V-28`（超长邮箱 500，Low）。
- **已知未修、本轮运行态复测仍存在：** `V-05`（WEB-4 安全头）、`V-07`/`V-19`（L-3 WS Origin、SEC-5 gRPC）、`V-08`（登出 token/AUTH-7 部分）、`V-10`（DATA-2）、`V-11`（DATA-1）、`V-12`（AUTH-6）、`V-13`（AUTH-4）、`V-22`（SEC-7/SEC-11）、`V-23`（AUTH-2）、`V-24`（AUTH-3）、`V-29`（AUTH-7/AUTH-8）、`V-30`（密码策略 hardening）。DATA-10 已读游标、DATA-7 消息列表、DATA-5/DATA-6 功能缺口由 Authz 面确认（见 `findings/authz.md` §V-AUTHZ-08/09/10），未单列编号。
- **本轮未覆盖/退回待确认：** AUTH-1/H-2 跨租户（无 HTTP 建站路由，单站点无法构造第二租户令牌，仅代码复核 + members_only/路径 siteID 面实测替代）；AUTH-5 限流内存表 50k 上限（单 IP 预算内无法触发）；AUTH-11 密码重置 Host 注入（SMTP 未配置，不可利用）；密码重置 token 一次性/TTL 未实测；DATA-8 草稿降级竞态、AUTH-10 重复域名 500 需第二站点/精确时序。上一轮其余条目（DATA-8/9、SEC-2/3/6 等）保持原结论。

---

## 8. 修复优先级建议

**P0（本周）：**
1. `V-01` 媒体对象级授权：列表限 editor+ 或按 owner 过滤、下载校验 owner/被已发布内容引用/editor+、匿名限"被已发布内容引用"的 content/site/avatar。
2. `V-02` 撤权即时生效：写操作入口用 DB 成员状态覆盖 token role；角色/状态变更时吊销该用户会话（或 token 加版本号）。
3. `V-04` 部署文档 + 反代样例：Nginx 显式拒绝 `/__pp/*`；launcher 对控制面接口加不可绕过的本机校验（一次性本地 token / 仅本地命名管道）；README 显著警告"launcher 端口不要直接反代到公网"。
4. `V-16` 安装期防抢注：安装令牌/仅回环可注册管理员；`setup/status` 不返回 `has_admin`。

**P1（发布前）：**
5. `V-17` 提供 production compose profile：持久 Ed25519 私钥、`APP_ENV=production`、Secure Cookie、Nginx 安全头/TLS 模板、关闭 debug 路由日志。
6. 认证面三件套（上轮遗留 Medium，修复成本低、收益高）：`V-13` 未知账号 dummy hash 抹平时序 + 禁用账号统一 401；`V-23` refresh 族绝对寿命；`V-24` 账号 + IP 双键失败退避/锁定（`V-25` 并发复用撤销同批改）。
7. `V-03`/`V-20` 落地：服务端 customization 字段级 schema 白名单（custom_css/code 区块/未知字段）；前端 `custom_css` CSSOM 逐条校验、`sanitizeHtml` 去除 `id/name`、`CustomizationLayer` 改 ref；导入流程二次确认。
8. `V-05` 安全响应头（CSP/frame-ancestors/XFO/Referrer-Policy/HSTS）。
9. `V-06` 注册防滥用（邀请/邮件验证/配额开关）+ 草稿配额 + 审核队列限流。

**P2：**
10. `V-10`/`V-11`/`V-12` 三条已知 Medium 收口（analytics 匿名写 + 幂等、taxonomy 可见性、域名所有权验证）。
11. `V-07`/`V-19` WS Origin 默认同源、gRPC 增加认证/TLS；`V-08`/`V-29` 登出 token 缩短 TTL + 登出 CSRF；`V-09` 安装元数据收敛；`V-14`/`V-15` 成员/目标校验；`V-18` 私钥 DPAPI + ACL 收紧；`V-21` rel=noopener；`V-26`/`V-27` 认证端点强制 JSON + Origin/CSRF 绑定；`V-28` 统一邮箱长度上限；`V-30` 密码策略。
12. 功能缺口：通知生产（DATA-5）、举报/审核 HTTP 面（DATA-6）、消息列表倒序游标（DATA-7）。

**P3（产品级，非本轮安全项）：**
13. `O-1` 匿名访客 bootstrap（否则公开站点对新访客不可见、H-1 目标未达成；修完后同步复测 V-03/V-20 并升级定级）。
14. `O-2` 明确 review 模式语义、`O-3` 注册开关、`O-4` OpenAPI/契约一致性。

---

## 9. 附录

### 9.1 靶场与脚本

**从当前源码重建（< 5 分钟）：**

```powershell
# 前端（已存在 apps/web/dist 时可跳过；需要 Node 22+）
cd apps/web && npm run build
# 启动器（把当前 dist 嵌入）
Copy-Item apps/web/dist/* apps/launcher/web/dist -Recurse -Force
cd apps/launcher; $env:GOARCH='amd64'; go build -trimpath -o ..\..\.tmp\attacklab\bin\PractacuPress.exe .
# Go API
cd ../..; $env:GOARCH='amd64'; go build -trimpath -o .tmp\attacklab\bin\PractacuPressAPI.exe ./apps/api/cmd/server
# Rust 安全服务（默认工具链是 gnu 时需显式 msvc）
cd services/security; rustup run stable-x86_64-pc-windows-msvc cargo build --release
Copy-Item target/release/practacu-security.exe ..\..\.tmp\attacklab\bin\
```

**靶场管理（Node 版，PowerShell 版在本机沙箱下会卡住，已弃用）：**

```powershell
cd .tmp\attacklab
node scripts/lab.mjs setup i1 18081      # 创建隔离实例（hardlink 三个二进制 + 空 data/）
node scripts/lab.mjs start i1            # 启动 launcher（自带 API/安全服务），等待 /__pp/runtime ready
node scripts/lab.mjs status i1           # 查看 runtime + setup/status
node scripts/lab.mjs reset i1            # 停止并清库，重新开始
node scripts/lab.mjs stop-all            # 收尾：停止全部实例（测试结束已执行）
node scripts/seed.mjs --id i1            # 首个注册账号 → platform_admin，写 instances/i1/creds.json
```

**脚本/证据规模：**

| 面 | 脚本 | 证据 | 请求量（约） |
| --- | --- | --- | --- |
| Lead | `work/lead/*.mjs`（recon/attack2-6/verify-infra） | `work/lead/*.json` + 浏览器截图 | ~350 |
| Auth | `work/auth/` 13 个 `.mjs` | `work/auth/evidence/*.jsonl` | ~1,460（含一次全局限流压测） |
| Authz | `work/authz/` 00–10 脚本 | `evidence.log`（~500 条请求级）+ 06/07/10 JSON | ~500 |
| Content | `work/content/` 10+ 个 `.mjs` | `evidence/*.json/png`（真实 Chrome 截图） | ~420 |
| Infra | `work/infra/` 10+ 个 `.mjs` | `tmp-*` 独立库 + 脚本输出 | ~600 |
| **合计** | — | — | **~3,300 次 HTTP 请求，并发 ≤20** |

**测试环境：** Windows 11 / Go 1.26（windows/amd64 交叉编译）/ Node 24 / Rust stable-msvc / 系统 Chrome 156（playwright-core 驱动，headless）。所有实例仅监听 `127.0.0.1`。

### 9.2 清理说明

所有实例均在 `.tmp/attacklab/instances/` 下独立运行，测试结束后已 `node scripts/lab.mjs stop-all` 停止；仓库真实 `data/`、`release/`、`.git` 未被读写；未修改系统配置/注册表/防火墙；未下载可执行 payload；未对外网发起任何请求；每实例数据（SQLite/媒体）全部留在 `.tmp/attacklab` 内，可直接删除。
启动器源码与前端均**未做任何修改**（本轮只读+运行）；唯一的非证据产物是本报告 `docs/audit/2026-11-02-attack-simulation.md`。

### 9.3 证据文件

- Lead：`.tmp/attacklab/work/lead/`（recon/attack/verify-*.json + 脚本 + 匿名访客浏览器截图）
- Auth：`.tmp/attacklab/work/auth/` + `.tmp/attacklab/findings/auth.md`
- Authz：`.tmp/attacklab/work/authz/` + `.tmp/attacklab/findings/authz.md`
- Content：`.tmp/attacklab/work/content/`（含真实 Chromium 截图 `css-overlay.png`/`clobber-*.png`/`clickjacking2.png`）+ `.tmp/attacklab/findings/content.md`
- Infra：`.tmp/attacklab/work/infra/` + `.tmp/attacklab/findings/infra.md`

### 9.4 本轮未覆盖 / 能力边界

| 项 | 原因 | 已有证据 |
| --- | --- | --- |
| AUTH-1/H-2 跨租户令牌拒绝 | 单站点部署没有 HTTP 建站路由，无法铸造 `sid=B` 令牌 | 代码核对（`RequireAuthForSite`/`OptionalAuth`/`PublicUser`）+ members_only/路径 siteID 面实测 |
| AUTH-5 限流内存表 50k 上限 | XFF 不受信、单 IP 预算内无法造出 5 万 key | 代码 + 受控限流测试 |
| AUTH-11 密码重置 Host 注入 | 本实例 SMTP 未配置，请求在 origin 使用前 503 | SMTP-off 行为已实测 |
| 多租户影响（AUTH-6 抢注、跨站媒体等） | 需第二个站点实例 | 单站点复现 + 代码定位 |
| DATA-8 草稿降级竞态 / AUTH-10 重复域名 500 | 需第二站点或精确读写窗口 | 代码路径仍存在，未复现 |
| docker-compose 实跑 | 宿主无 Docker（项目 README 也说明未实跑） | 静态审计 + 启动器实跑对照 |
| 密码重置 token 一次性/TTL | 不直接改实例数据库/无 SMTP | 代码审查（上一轮已列为安全项） |

---

## 10. 产品级观察（非安全漏洞，但影响安全结论）

### O-1（重要）H-1 验收缺口：全新访客不会加载服务端站点设计，而是进入安装引导

- **实测（Lead，真实 Chrome，i0）：** 无 `localStorage['pp.web.config.v1']` 的浏览器打开 `http://127.0.0.1:18080/` 或 `/?mode=live` → 标题 `安装引导 · Practacu Press`，正文为"第 1/7 步 · 欢迎 / 第 2/7 步 · 运行方式"，等待 9 秒后仍停在引导页；`hasConfig=false`；网络请求只有 `/__pp/runtime`、`/healthz`、`/readyz`、`/api/v1/openapi.json`——**没有** `GET /api/v1/setup/status`，也没有拉取 `/sites/{id}/customization`。
- **后果：** H-1 目标写的是"服务端副本是跨设备、跨访客的事实来源"，但匿名访客实际上看到的是安装引导而不是站点。也就是说：**当前版本里，公开站点只有"自己浏览器装过/连过"的人能看到**；新设备、新访客、搜索引擎爬虫（不执行 JS 的只看到默认 index.html）都拿不到真实站点。这与 README/截图展示的公开站点形态不一致。
- **安全影响：** V-03/V-20 的当前爆炸半径被限制在"已完成安装的浏览器"；一旦按 H-1 目标补上匿名 bootstrap（用 `/api/v1/setup/status` + `/sites/{id}/customization` 构造配置），这两条 Medium 的受影响面会扩大到全部访客，应同步升级为 High 并先修服务端字段校验。
- **建议修复：** App 启动时若无本地配置→探测 `/__pp/runtime`/`setup/status`：`installed && has_admin` 则用服务端站点/设计自动构造 live 配置并渲染站点；只有真正未安装时才进入 7 步引导。同时把"访客看站点、站长看安装/后台"的判定从 localStorage 移到服务端状态。

### O-2（产品语义）review 模式的"审核"只拦 member

- Authz 面实测：`review`/`role_based` 的 `CanPublishDirectly` 都按 role ≥ editor 放行，因此 editor 可以直接发布**自己**的草稿，也可以直接发布**他人**草稿（实测 200），只有 member 必须走 submit→editor approve。若产品意图是"review 模式下所有发布都要第二人审核"，这是策略缺陷；若"editor 即审核者"是设计，请写进文档/后台提示。
- 影响：审核模式对"注册用户投稿"有效（member 被拦），对"内部编辑账号"无效；结合 V-02 的撤权延迟，被解雇编辑在 15 分钟内仍可发布。

### O-3（运营）注册默认开放、无邀请/邮件验证开关

- 任何能访问站点的人都能注册为 member（可建草稿、评论、私信、上传）。作为社区 CMS 这可能是有意设计，但产品没有暴露"关闭注册/邀请制/邮件验证"的配置项（代码里也没有对应开关）；建议至少提供站点级开关并写入 `.env.example`。

### O-4（文档/契约一致性）

- `GET /events` 文档/预期参数 `since` 实际是 `after_id`（本轮实测 `since` 被忽略）；`/api/v1/openapi.json` 仍是空壳，`docs` 与真实路由（media 列表、customization、auth/ws-ticket）不一致；`register`/`login` 响应里的 `csrf_token` 与 cookie 双写，契约未说明。
- 建议把 OpenAPI 生成/一致性测试接回 CI（上一轮审计也提过"路由 ↔ 契约 ↔ 依赖注入"一致性测试缺失）。
