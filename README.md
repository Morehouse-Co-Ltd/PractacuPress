# Practacu Press

**简体中文**　·　[English](README.en.md)

> **一个双击就能跑起来的社区型多站点 CMS。**
> 写作、社区、站点运营装进同一个系统：Go API + Rust 安全服务 + React 前台与后台，
> 三端由同一份 OpenAPI 3.1 契约对齐。

你可以**只把它当一个干净的写作站**——富文本 / Markdown 双模式，Markdown 在服务端渲染成 HTML 再过白名单清洗，分栏、图集、视频卡片都是真实标签；也可以**开多个互相隔离的站点做社区**——成员、4 级角色、审核状态机、私信、通知、举报在同一条权限链上；而且**落地成本接近零**——SQLite 用纯 Go 驱动，桌面形态不需要安装数据库、Node 或 Docker，一个 exe 就是一套完整站点。

- **写作**：工具栏编辑器 + Markdown、实时预览、按渲染后的纯文本计字数
- **社区**：评论、点赞、收藏、关注、私信、通知、举报，配 5 状态审核流
- **运营**：主题、页面编排（桌面 / 平板 / 手机独立）、SEO、访问限制、域名与 SSL、存储策略
- **安全**：Argon2id、HTML 白名单清洗、上传检查都在 Rust 服务里；连不上就 fail-closed 返回 503
- **分发**：`打包.bat` 产出自带前端的 exe，并在临时端口真启动产物做自检
- **许可**：AGPL-3.0——可商用；修改版或作为网络服务提供时必须同样开源，并保留署名

完整介绍（架构、技术栈、工程取舍、现状与限制）见 **[docs/introduction.md](docs/introduction.md)**　·　English: **[Introduction](docs/introduction.md#english)**

---

**技术分层**：后端所有能力通过 REST（OpenAPI 3.1）与 WebSocket 暴露；`apps/web` 是按同一份契约实现的前台、管理后台与首次安装引导。

- **Go API**（`apps/api`）：身份、站点、内容、社区、媒体、通知、私信、事件补偿
- **Rust 安全服务**（`services/security`）：Argon2id 密码哈希、内容清洗、上传检查
- **契约**（`packages/contracts`）：OpenAPI 3.1 与 protobuf
- **React 前端**（`apps/web`）：站点前台、管理后台、七步安装引导、主题库与页面编排（可按桌面 / 平板 / 手机独立编排）、自定义页面、内置扩展、访问限制、访问与域名（含 SSL 证书）、性能设置与加载动画

### 写作与阅读

- **写作**：编辑器带工具栏，可插入标题、分栏、图片（含素材库上传）、视频卡片、
  嵌入网址卡片、链接、表格、图集、提示框、引用、分割线与图标；右侧是预览，
  字数按渲染后的纯文本统计。全局快捷键是 `Shift+K` 命令面板、`Shift+S` 搜索、
  `Shift+D` 切换深浅色、`Shift+H` 回首页。
- **Markdown**：服务端先用 goldmark 把 Markdown 转成 HTML（GFM：表格、删除线、任务列表、
  图片、自动链接），再交给安全服务按白名单清洗——所以 `标题`、`表格`、`图片` 在真实环境里
  也是真的标签，而不是字面量。写作工具栏插入的区块是可被白名单保留的 HTML
  （分栏用 `table.pp-columns` 承载布局，视频是封面卡片而不是 iframe）。
- **搜索**：站点头部常驻搜索框，输入即搜（防抖 220ms，前 6 条），`/` 聚焦，回车进完整结果页；
  窄屏只留放大镜。
- **SEO**：标题模板、描述、关键词、canonical、Open Graph / Twitter、JSON-LD
  （WebSite、SearchAction、Article、BreadcrumbList、Person）、站长验证 meta、全站 noindex 开关，
  以及后台可下载的 `sitemap.xml` / `robots.txt`。边界见
  [管理后台 → SEO](apps/web/src/pages/admin/Seo.tsx) 里的说明：标签由前端写入 `<head>`，
  不执行 JS 的社交抓取器只能看到 `index.html` 的默认值。
- **主题**：后台「主题设置」把配色、排版与单栏/双栏版式作为一套「大主题」整体切换。
  内置原版（纸白单栏）与夜航（暖黑暗色双栏）；主题选择区可导入 JSON 主题、导出当前主题、
  另存为自定义主题与删除自定义主题。页面编排、外观（品牌/页脚）与加载动画归入同一导航组；
  只有首页仍为默认编排时，切换主题才会同步替换默认组件。页脚的全部内容（品牌标题/副标题/简介、
  状态标签、栏目与条目、版权与底部说明）都可以在「主题设置 → 导航与页脚」里逐项自定义；
  顶部导航也完全可配：每个 Tab 可设内置图标与左右位置、自由排序，最多挂 8 个二级入口，
  二级入口可渲染成页头下方的胶囊栏或收进下拉菜单。页头左上角（夜航）与页脚底栏上方还能放
  一排可配置的软件 / 社交快捷链接（GitHub、X、Mastodon、RSS、邮箱、任意网站）；「主题微调」
  新增柔化与过渡：背景柔光、组件混色、过渡时长与页头模糊，系统开启“减少动效”时自动降级。
- **访问与性能**：后台「访问限制」限制页面切换、页面请求与同浏览器并发页面，并生成
  Nginx `limit_req` / `limit_conn` 与 API `.env`；「访问与域名」设置主域名、别名白名单、
  SSL 证书（Let's Encrypt / 手动证书）、CORS、Cookie 作用域与可信代理；没有设置主域名时，
  生产环境只允许公网 IP 直接访问；「性能优化」减少首屏读取、合并重复请求、懒加载媒体，并生成
  网关压缩/缓存与 API 超时、数据库连接池参数；「存储策略」先用全局本地目录或 S3 兼容云对象存储
  （AWS、MinIO、阿里云 OSS、腾讯云 COS），再按用途单独覆盖：文章媒体、站点图片、用户头像、
  用户数据/附件可以各自选本地目录或桶/前缀，生成 `STORAGE_<SCOPE>_*` 服务端片段；「加载动画」
  可制作前台加载画面。
  这些设置都保存在本地安装配置里，服务器参数需要部署片段后重启生效。
- **一键恢复**：页面编排可对当前首页或自定义页面恢复默认组件（页面标题、路径与发布状态不变）；
  「外观」可按范围重置品牌文案、首页/页面编排、加载动画、性能、访问限制与访问域名；
  「主题设置」可恢复当前主题定义或回到原版主题。

---

## 快速开始（Windows）

前提：Go 1.26+、Node.js 22+（前端依赖与 Vite）；Rust（`rustup`，MSVC 工具链）可选，
没有安全服务时 API 会降级启动。

### 一键启动（推荐）

双击项目根目录的 **`启动.bat`**：

- 首次运行会在缺少 `apps/web/node_modules` 时自动执行 `npm install`；
- 在独立窗口启动 Go API、SQLite、可用时启动 Rust 安全服务；
- 在独立窗口启动 Vite 前端（`http://127.0.0.1:5173`，自动代理 `/api` 到 8080）；
- 浏览器打开 `http://127.0.0.1:5173/?mode=live`：已有真实安装会直接进入站点，否则进入
  **真实环境**安装引导并自动探测本机 8080，不会默认切到演示数据；
- 一键启动以桌面模式运行 API：安装引导里创建的第一个账户就是平台管理员；
  如果旧数据库已有成员但没有管理员，启动时会自动提升最早的活动成员，修复无法完成安装的情况；
- 等待就绪后自动打开浏览器；
- 如果 API 或前端已经在运行，会直接复用，不会重复占端口。

只检查环境、不启动服务：

```bat
启动.bat --check
```

停止时在「Practacu Press - API」窗口按 `Ctrl+C`，并关闭「Practacu Press - Web」窗口。

如果机器没有可用的 Rust 安全服务，脚本会以 `-SkipSecurity` 启动 API：站点浏览、写作与统计可用，
但发布文章和完成上传会按设计返回 503。

### PowerShell 启动（只启动后端）

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
# 本地单站点安装：首个注册账户成为平台管理员；服务器部署不要打开这一项。
$env:PP_DESKTOP='true'

go run ./apps/api/cmd/seed  -driver sqlite -dsn $env:DATABASE_DSN
go run ./apps/api/cmd/migrate                      # 只建表，不建站点
go run ./apps/api/cmd/server
```

Rust 侧：

```powershell
cd services/security
rustup run stable-x86_64-pc-windows-msvc cargo run --release
```

### 前端

```powershell
cd apps/web
npm install
npm run build
npm start
```

`http://localhost`（默认 80 端口，地址栏不用写端口号）。后台「站点设置 → 访问端口」可以改端口，
服务会立即在新端口监听并记住选择。开发模式用 `npm run dev`，同样默认 80，会把 `/api`、
`/healthz`、`/readyz` 转到 `127.0.0.1:8080`。

首次打开会进入安装引导；没有后端时可选「演示数据」直接体验完整前台与后台。
细节见[前端说明](apps/web/README.md)。

### Windows 一键启动包（一键打包）

```powershell
# 双击仓库根目录的 打包.bat，或者：
powershell -ExecutionPolicy Bypass -File scripts\package.ps1
```

打包脚本会检查工具链，然后自动完成整套流程：

1. 构建前端（`apps/web`，缺少 `node_modules` 时自动 `npm ci`）；
2. 编译 Rust 安全服务（`services/security`，release）；
3. 把前端产物同步进启动器的 `go:embed` 目录；
4. 编译 Go 启动器与 Go API（Windows amd64，纯 Go）；
5. 组装干净的分发目录，**在临时端口实际启动打包产物做自检**：
   静态站与 SPA 回退、`/__pp/runtime`、`/healthz`、`/readyz`、注册、文章创建
   （验证 Rust 清洗掉 `<script>`）与发布；
6. 压缩成 zip，并同步 `release/PractacuPress`（保留用户已有的 `data/` 与
   `practacu-web.json`）。

任何一步失败都会立刻停下并打印原因；自检不通过不会产出新包。

产物：

- `release/PractacuPress/PractacuPress.exe`：原生启动器，双击即用，**不需要安装 Node**；
- `release/PractacuPress/PractacuPressAPI.exe`：Go API，由启动器在真实环境下自动拉起；
- `release/PractacuPress/practacu-security.exe`：Rust 安全服务，默认自动编译并附带；
- `release/PractacuPress-Windows-x64.zip`（及同名 `.sha256`）：整个文件夹的压缩包，
  解压后双击 exe 即可。压缩包里只有程序与 `README.txt`，不会带开发机的 `data/`。

`scripts/package.ps1` 的常用参数：

| 参数 | 说明 |
| --- | --- |
| `-SkipSecurity` | 不编译也不附带 Rust 安全服务（发布与上传会 fail-closed 返回 503） |
| `-SkipSmoke` | 跳过打包后的自检（不推荐，自检是“保持原有功能”的保障） |
| `-NoZip` | 只生成 `release/PractacuPress` 目录 |
| `-ReleaseDir <目录>` | 换输出目录 |
| `-Port <端口>` | 自检固定端口（默认自动挑空闲端口） |

CI 可以直接调用底层脚本（与上面是同一套流程）：
`node scripts\package-windows.mjs [--skip-security] [--skip-smoke] [--no-zip] [--release-dir <目录>]`。
在没有 Rust 工具链的机器上，用 `-SkipSecurity` 打出的包仍能浏览、写作与演示，只是发布文章与完成上传会返回 503。

启动器默认在 80 端口提供站点并自动打开浏览器；80 被占用时改用 8080，窗口里会显示实际地址。
后台「站点设置 → 访问端口」的修改会写进 exe 同目录的 `practacu-web.json`，下次启动沿用。
站点只监听本机回环地址，关闭窗口即停止，拉起的 API 与安全服务也会一并退出。

安装引导里的两种运行方式都能直接用：

- **演示数据**：只写浏览器 `localStorage`，不需要任何服务；
- **真实环境**：启动器已在同源后面跑好 API，引导自动连上，不用填地址。数据库是
  exe 同目录 `data/practacu.db`（纯 Go SQLite），第一次启动自动建表并创建默认站点，
  引导里创建的第一个账户就是平台管理员。`/api`、`/healthz`、`/readyz` 由启动器
  反向代理到本机 API，因此没有跨域配置，Cookie 与 WebSocket 也按同源处理。

真实环境的数据都在 `data/`：`practacu.db`、`media/`、`api.log`、`api.err.log`，
关掉窗口后整体复制即可备份。exe 目录不可写时改用 `%LOCALAPPDATA%\PractacuPress\data`。
需要强制只用前端可以运行 `PractacuPress.exe --mode demo`。

> 安全服务缺失时站点仍可运行，但发布文章与完成上传会 fail-closed 返回 503。
> 默认打包会自己编译 `practacu-security.exe`；只有用 `-SkipSecurity` 打出的包才缺它。

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
apps/web/                          React 前台、管理后台与安装引导
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
| `RATE_LIMIT_PER_MINUTE` | 每 IP 每分钟 API 请求上限；`0` 关闭。浏览器端限制不能替代它 |
| `HTTP_READ_TIMEOUT_SECONDS` / `HTTP_IDLE_TIMEOUT_SECONDS` | HTTP 读超时与空闲 keep-alive 超时，默认 30 / 120 秒 |
| `DB_MAX_OPEN_CONNS` / `DB_MAX_IDLE_CONNS` | 数据库连接池；`0` 使用驱动默认（SQLite 1，MySQL/Postgres 25） |
| `DB_CONN_MAX_LIFETIME_SECONDS` | 连接生命周期；默认 1800 秒，`0` 表示不主动回收 |
| `STORAGE_DRIVER` | `local` 或 `s3`。S3 需要 `STORAGE_S3_BUCKET` |
| `SMTP_HOST` | 留空即关闭找回密码；配置后 `/auth/password-reset/*` 才可用 |
| `SMTP_ENCRYPTION` | `starttls`（587）/ `ssl`（465）/ `none`（25，仅本机中继） |
| `SMTP_USERNAME` / `SMTP_PASSWORD` | 必须成对出现；除本机中继外只能走 TLS |
| `SMTP_FROM` | 发件地址，缺省取 `SMTP_USERNAME` |
| `PUBLIC_BASE_URL` | 重置链接的前缀；留空则用请求来源域名 |

找回密码的完整链路：登录页「忘记密码」→ `POST /auth/password-reset/request`
（无论邮箱是否存在都返回 202）→ 邮件里的 `?token=` 打开 `/reset-password` →
`POST /auth/password-reset/confirm` 换新密码，并吊销该账户所有会话。
令牌 30 分钟过期、只能用一次，同一账户 60 秒内只发一封。
管理后台「登录设置 → 邮件通知」可以直接生成这段 `.env`。

---

## 已知限制

| 项 | 说明 |
| --- | --- |
| MySQL / PostgreSQL | 代码层无方言依赖，但**本机没有这两个数据库，未实跑验证**，需在 CI 上跑矩阵 |
| Docker / Windows 安装包 | 未实现 |
| WebSocket 多副本 | 票据与 hub 在进程内存，多副本部署需要共享存储 |
| 限流 | 进程内固定窗口，多副本下是每副本独立计数；真正的 DDoS/CC 防护需要反向代理或边缘 WAF |
| 浏览器端访问限制 | 只能约束使用本站脚本的访问者；IP 级请求/并发由 Nginx/Cloudflare 配置执行，后台只生成片段 |
| 域名别名 | 服务端按 Host 解析单一站点；别名域名需要反向代理把 Host 改写为主域名（生成片段已包含） |
| S3 上传内存占用 | 受 SigV4 限制需先缓冲，上限等于单文件上限（25 MiB） |
| 邮件 | 只实现找回密码这一种事务邮件；注册验证、回复提醒等模板尚未接入 |
| SEO | 标签由前端写入 `<head>`；不执行 JS 的抓取器只能看到 `index.html` 的默认值 |
| sitemap / robots | 由后台生成并下载，静态托管时需要手动放到站点根目录 |
| 未实现 | 前端 SDK 生成、OAuth 适配器、手机验证码、搜索分页游标 |

更细的现状见 [交付状态报告](docs/superpowers/reports/2026-10-20-delivery-status.md)。

---

## 设计文档

- [产品与技术设计](docs/superpowers/specs/2026-10-18-practacu-press-design.md)
- [计划评审与可行性](docs/superpowers/reviews/2026-10-18-practacu-press-plan-review.md)
- [详细实施计划](docs/superpowers/plans/2026-10-18-practacu-press-backend-detailed-plan.md)
- [实施进度](docs/superpowers/plans/2026-10-18-practacu-press-progress.md)

---

## 许可证

本项目以 **GNU Affero General Public License v3.0**（`AGPL-3.0`）发布，全文见 [LICENSE](LICENSE)。

用三句话概括它对使用者的要求：

- **可以商用**：你可以部署、修改、对外提供付费服务，不需要向作者付费或申请授权。
- **改后必须开源**：分发修改版，或把它作为网络服务提供给别人使用（AGPL 第 13 条覆盖的正是这一场景），都必须按同一许可证公开修改后的完整源码。
- **必须署名**：衍生作品须保留本项目的版权声明、项目名称与仓库地址，并在修改过的文件上标明改动；这是 AGPL 第 5 条与第 7(b) 条的要求，也是"不要抹掉作者信息当成自己的作品"的正式表述。

不能接受 AGPL 的场景（例如要把它嵌进闭源产品）目前**没有**商业双许可，需要另行联系作者。

```text
Practacu Press — 多站点社区型 CMS
Copyright (C) 2026 Practacu Press contributors

SPDX-License-Identifier: AGPL-3.0-only
```

> 版权行里的名字是占位口径（"contributors"）。如果你希望以个人名义持有版权，
> 把 `Copyright (C) 2026 <你的名字>` 替换到上面这段、并在 [docs/introduction.md](docs/introduction.md) 的许可段落同步即可。
