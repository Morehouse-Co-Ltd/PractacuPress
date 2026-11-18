# Practacu Press 项目介绍

> **一套自托管的社区型 CMS：占地少、跑得快、开箱即用、想怎么改就怎么改。**
> Go API + Rust 安全服务 + React 前台与后台，三端用同一份 OpenAPI 3.1 契约对齐；
> Windows 与 Linux 都是一等公民，源码、启动器、容器三种装法共用一套配置。

**中文** · [English](#english)

---

## 1. 这是什么

Practacu Press 是一个**自托管的社区型内容管理系统**。它把三件事装进同一个系统：

- **写作**——富文本 / Markdown 双模式的编辑器，服务端把 Markdown 渲染成 HTML 再清洗，标题、表格、图片都是真实标签；
- **社区**——评论、点赞、收藏、关注、私信、通知、举报，配套一套审核状态机；
- **站点运营**——主题、页面编排、导航页脚、SEO、访问限制、域名与证书、存储策略、性能参数，都在后台可视化配置。

同一套代码支持三种形态：

| 形态 | 怎么用 | 适合 |
| --- | --- | --- |
| **桌面形态** | 运行 `PractacuPress.exe`（或双击），本机 80 端口起站点，数据留在 exe 同目录的 `data/` | 个人写作、内网小社区、演示交付 |
| **容器形态** | `docker compose up -d` 起三个容器：API、安全服务、Nginx 静态站 | Linux 服务器、单机自托管的公网站点 |
| **服务器形态** | Go API + 前端静态资源 + Rust 安全服务，接 SQLite / MySQL / PostgreSQL | 公网多站点、SaaS 多租户 |

以及两种运行模式：

- **单站点模式**：装完只有你自己的一个站，不需要理解"站点空间"这种概念；
- **SaaS 多站点模式**：平台管理员创建多个站点，每个站点有独立内容、成员、主题、审核规则与权限边界。

## 2. 它解决什么问题

现成的方案通常要你在三件事里选两件：要么是纯博客引擎（写作舒服，但没有社区关系）；要么是论坛/社区程序（互动齐全，但写作与排版体验粗糙）；要么是重型 CMS（功能齐全，但部署要 Docker、要调数据库、要装一堆依赖）。

**四个能实际感知到的优势**

| 优势 | 具体是什么 |
| --- | --- |
| **占地少** | Windows 启动器 8.3 MB，内嵌整套前端；Rust 安全服务 3.3 MB；前端构建产物 1.3 MB。SQLite 用纯 Go 驱动，数据库就是一个文件，不用另装、另调、另备份一个数据库服务。默认容器部署只有两个镜像：API（内嵌前端）与安全服务。 |
| **性能高** | 请求只经过 Gin 一层，Ent 生成的代码直连 `database/sql`；连接池与 SQLite 的 WAL / busy_timeout 由服务端自己配好。前端是纯静态单页应用，运行时不依赖 Node，没有服务端渲染往返；网关负责 gzip 与「带哈希资源长期缓存」，首屏请求合并、媒体懒加载都在后台可配。 |
| **使用便捷** | 八步安装引导自带健康检查，装完即用；`docker compose up -d` 或 `启动.bat` 一条命令起全栈。备份就是把 `data/` 目录整体复制走。 |
| **自定义好** | 3 套大主题 + 8 套配色预设，主题可导入 / 导出 JSON；页面编排支持桌面 / 平板 / 手机三端独立布局，每个组件可设圆角、阴影、裁剪等外观并内置按钮组件；写作时可插入思维导图、逻辑图、统计图与鱼骨图；导航、页脚、SEO、访问限制、域名与证书、存储策略都可逐项配置；全部能力摆在 OpenAPI 3.1（当前契约 83 条路径 / 100 个操作）之后，换前端按契约写即可。 |

然后再回到产品本身——Practacu Press 想同时拿到三样：

1. **写作体验不打折**——分栏、图集、提示框、视频卡片这些排版块都是服务端白名单保留的真实 HTML，不是字面量。
2. **社区是一等公民**——成员、角色、审核、通知、私信、举报在同一条权限链上，不是外挂插件。
3. **落地成本接近零**——SQLite 用纯 Go 驱动（`modernc.org/sqlite`），桌面形态**不需要安装数据库、Node 或 Docker**；要上服务器时，`docker compose up -d` 就是完整的一套。

它大概适合三类人：

- 想自建写作站或小社区、又不想维护一整套运维栈的人；
- 想读一个横跨 Go / Rust / React 三语言、契约先行的完整工程的人；
- 想只按 OpenAPI 契约写自己前端（Web / 小程序 / 原生）的人——前端不是必需的。

## 3. 核心能力

### 3.1 写作与阅读

- **双编辑模式**：富文本与 Markdown。Markdown 由服务端 goldmark 按 GFM 渲染（表格、删除线、任务列表、自动链接），再交给 Rust 安全服务按白名单清洗。
- **编辑器工具栏**：标题、分栏、图片（含素材库上传）、视频卡片、嵌入网址卡片、链接、表格、图集、提示框、引用、分割线、图标与图表；右侧实时预览；字数按**渲染后的纯文本**统计。
- **文章图表**：思维导图、逻辑图、统计图（柱状 / 折线 / 环形 / 饼图）与鱼骨图。规格以 `pp-diagram` 围栏随正文保存成 Markdown，阅读页按当前主题重绘成 SVG；不把 SVG 写进正文，因此服务端的 HTML 白名单不需要放宽。
- **站内搜索**：头部常驻搜索框，输入即搜（防抖 220 ms，取前 6 条），`/` 聚焦，回车进入完整结果页；窄屏只留放大镜。
- **SEO**：标题模板、描述、关键词、canonical、Open Graph / Twitter、JSON-LD（WebSite / SearchAction / Article / BreadcrumbList / Person）、站长验证、全站 noindex 开关，以及后台可下载的 `sitemap.xml` / `robots.txt`。

### 3.2 社区互动

- **内容**：文章（长文）与帖子（短内容），带版本与状态机。
- **互动**：评论与回复（有深度上限）、点赞、收藏、关注、私信会话、站内通知、举报与审核。
- **审核流**：5 状态 5 动作的状态机，配合站点级发布模式（开放发布 / 审核发布 / 按角色发布）；作者不能审批自己的内容，已发布内容不可直接改写。
- **实时推送**：WebSocket 用**一次性票据**升级（票据 60 秒、单次消费、只存哈希），不把 access token 放进 URL；同时提供 REST 补偿端点 `GET /events?after_id=&limit=`，断线可用它补齐。

### 3.3 站点运营后台

| 模块 | 能做什么 |
| --- | --- |
| **主题** | 3 套内置大主题（原版：纸白单栏 / 白昼：白底日报 / 夜航：暖黑暗色双栏）+ 8 套配色预设；导入 JSON 主题、导出当前主题、另存为自定义主题 |
| **页面编排** | 区块组件库（文本、图片、视频、网站、幻灯片、按钮、图表、留言箱等），每个组件可单独设圆角、阴影、裁剪、背景、内边距与描边；首页与自定义页面可编排，**桌面 / 平板 / 手机三端各自独立**；可一键恢复默认组件 |
| **导航与页脚** | 顶部 Tab 可配图标、左右位置与排序，最多 8 个二级入口（胶囊栏或下拉）；页脚栏目、条目、版权、社交快捷链接逐项可配 |
| **主题微调** | 背景柔光、组件混色、过渡时长、页头模糊；系统开启"减少动效"时自动降级 |
| **访问限制** | 限制页面切换、页面请求与同浏览器并发页面，生成 Nginx `limit_req` / `limit_conn` 与 API `.env` |
| **访问与域名** | 主域名、别名白名单、SSL 证书（Let's Encrypt / 手动）、CORS、Cookie 作用域、可信代理 |
| **性能与存储** | 首屏读取、请求合并、媒体懒加载；本地目录或 S3 兼容对象存储，并可按用途（文章媒体 / 站点图片 / 头像 / 附件）分别覆盖 |
| **其他** | 成员与权限、媒体库、评论管理、审核台、分类法、访问统计、内置扩展、内置文档、加载动画 |

> 后台生成的服务器参数需要部署片段并重启生效——它不是"点一下就改好线上"的魔法开关。

### 3.4 安装与分发

- **八步安装引导**：欢迎 → 连接后端 → 数据库 → 管理员 → 安全 → 默认站点 → 字体大小 → 检查与完成。
- **两种模式任选**：**演示数据**只写浏览器 `localStorage`，不需要任何服务；**真实环境**自动连上同源 API，不用填地址。
- **Windows 一键启动器**：前端经 `go:embed` 打进 exe，默认 80 端口，被占用自动退到 8080；`/api`、`/healthz`、`/readyz` 由启动器同源反向代理，因此没有跨域配置，Cookie 与 WebSocket 天然同源；后台改端口会立即生效并迁移浏览器数据。
- **一键打包**：`打包.bat` 走完构建前端 → 编译 Rust → 内嵌 → 编译启动器 → **在临时端口真启动产物做自检** → 出 zip 与 sha256，自检不通过不产出新包。

## 4. 架构

```text
            浏览器（React 19 单页应用：前台 / 管理后台 / 安装引导）
                              │
              REST · OpenAPI 3.1          WebSocket（一次性票据）
                              │
                              ▼
    ┌──────────────────────────────────────────────────────────────┐
    │  Go API —— 模块化单体（Gin）                                  │
    │  auth · site · content · community · messaging ·             │
    │  notifications · moderation · media · search · analytics ·    │
    │  taxonomy · outbox                                           │
    └───────────┬──────────────────────────────────┬───────────────┘
                │ Ent + database/sql               │ gRPC
                ▼                                  ▼
    SQLite / MySQL / PostgreSQL        Rust 安全服务（tonic）
    （SQLite 为纯 Go 驱动）             Argon2id · HTML 白名单清洗 · 上传检查
```

三条决定这套结构的设计选择：

1. **模块化单体，而不是一上来就微服务。** 文章审核、站点权限、评论、通知、审计之间存在大量事务关系。单体保留清晰模块边界（`Handler → Service → Domain → Repository 接口`，数据库/存储/gRPC 客户端都在 `infrastructure`），同时不用为本地安装付出分布式代价；`outbox`、内部 gRPC 与独立 Rust 服务则为将来拆分留了缝。
2. **安全原语外置到 Rust。** 密码哈希（Argon2id）、HTML 白名单清洗、上传检查这些"细节最容易做错、又最不能做错"的部分不散落在业务代码里，而是收敛成一个独立的 gRPC 服务；Go 侧只调用，不实现。
3. **fail-closed 优先于可用性。** 安全服务连不上时，**发布内容与完成上传返回 503**，而不是"跳过检查先放行"。站点浏览、写作、统计仍然可用——降级范围是显式设计过的。

## 5. 技术栈

| 层 | 选型 |
| --- | --- |
| 后端 | Go 1.26 · Gin · Ent（schema-as-code）· `database/sql` |
| 数据库 | SQLite（纯 Go 驱动）/ MySQL / PostgreSQL |
| 安全服务 | Rust · tonic（gRPC）· argon2 · ammonia（白名单清洗）· zeroize |
| 前端 | React 19 · Vite 7 · TypeScript 5.9 · React Router 7（零 UI 框架依赖） |
| 契约 | OpenAPI 3.1（**83 条路径 / 100 个操作**；站点根路径的 sitemap / robots 与内置文档页不在契约内）+ protobuf（`security.proto`） |
| 实时 | WebSocket（`coder/websocket`）+ outbox 事件补偿 |
| 桌面分发 | Go 启动器（`go:embed` 内嵌前端 + 同源反向代理 + 子进程管理） |

## 6. 工程亮点

挑几个"做了但看代码才知道"的地方：

- **契约先行**：`packages/contracts/openapi/openapi.yaml` 是唯一事实来源，前端只依赖公开 REST 接口。契约有测试守着，不是写完就烂在仓库里。
- **认证细节**：Ed25519 签名的 JWT（15 分钟）+ refresh 令牌轮换。**检测到 refresh 重放就吊销整族会话**，并发刷新用条件更新避免竞态；refresh 走 HttpOnly Cookie + CSRF 双提交，响应体里永远不出现 refresh token；未知邮箱与密码错误返回同一个错误，防账号枚举。
- **两阶段上传**：声明 → 传字节 → 扫描 → `clean` 才可下载。存储键**不含用户提供的文件名**（路径穿越无从谈起），MIME 走闭集白名单（拒绝 svg / html / exe），流式写入超限即截断——不会多写一个字节；被拒绝的资源一律返回 404，连"它存在"都不透露。
- **权限在服务端强制**：4 角色 × 4 动作矩阵，跨站操作直接拒绝；前端隐藏按钮只改善体验，不承担安全控制。
- **三方言无方言依赖**：不用 FTS、不用方言特有 SQL；SQLite 的 pragma（外键、WAL、busy_timeout）由服务端自己补，所以桌面形态"解压即用"。
- **可验证的打包**：打包脚本在临时端口真启动产物，跑静态站、SPA 回退、注册、文章创建（验证 `<script>` 被清洗掉）与发布，全绿才出 zip。
- **事件按人隔离**：outbox 事件带 `audience_user_id`，REST 补偿与 WebSocket 投递是**两套独立实现**——一处有 bug 不会两处都漏。

## 7. 快速开始

### Docker（Linux / 服务器）

仓库自带 `docker-compose.yml`，默认只启动 API（已用 `go:embed` 内嵌前端）与安全服务：

```bash
docker compose up -d --build
```

打开 `http://localhost:8080` 走完八步安装引导，**第一个账户即平台管理员**。默认只绑 `127.0.0.1`；数据在命名卷 `practacu-data`（`practacu.db` 与 `media/`）。完整说明见 [README 的 Docker 章节](../README.md)。

> 默认 API（内嵌前端）与安全服务镜像及 compose 栈已经在本机 Docker 中实际构建并启动验证（两容器 healthy，注册/登录、上传扫描、备份与 RSS/sitemap 链路均跑通）；宿主机 TLS 反代仍需在预发环境验证。

### Windows 启动器

**前提**：Go 1.26+、Node.js 22+；Rust（MSVC 工具链）可选——没有安全服务时 API 会降级启动，但发布文章与完成上传会按设计返回 503。

在仓库根目录运行 **`启动.bat`**（或双击）。它会按需 `npm install`，在独立窗口起 Go API 与 Rust 安全服务，再起 Vite 前端，最后打开 `http://127.0.0.1:5173/?mode=live`。

```bat
启动.bat --check    :: 只检查环境、不启动服务
```

### 手动启动

```powershell
$env:APP_ENV='development'; $env:HTTP_ADDR='127.0.0.1:8080'
$env:DATABASE_DRIVER='sqlite'; $env:DATABASE_DSN='file:./data/practacu.db'
$env:SECURITY_GRPC_ADDR='127.0.0.1:9001'; $env:STORAGE_DIR='./data/media'
$env:PP_DESKTOP='true'      # 首个注册账户成为平台管理员；服务器部署不要打开

go run ./apps/api/cmd/seed -driver sqlite -dsn $env:DATABASE_DSN
go run ./apps/api/cmd/migrate
go run ./apps/api/cmd/server
```

```powershell
cd apps/web; npm install; npm run build; npm start   # http://localhost
```

```powershell
# 打包成免安装的 Windows 分发目录 + zip + sha256（含产物自检）
powershell -ExecutionPolicy Bypass -File scripts\package.ps1
```

跑测试：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\test.ps1   # go build + vet + test
cd services/security; cargo test                            # Rust（需 MSVC 工具链）
```

完整步骤、配置项与打包参数见 [根目录 README](../README.md) 与 [前端说明](../apps/web/README.md)。

## 8. 现状与已知限制

这个项目明确区分"实跑验证过"和"写完没验过"，不含推测。

**已验证（本机实跑）**

认证链路与会话轮换 · 站点解析与权限矩阵 · 内容状态机与审核 · 媒体两阶段上传与下载 · 搜索 · 通知 · 私信 · WebSocket 与票据 · 事件补偿 · 举报与审核 · 审计查询 · 邮箱验证 · 打包产物自检（真实进程注册 / 发稿 / 清洗 / 发布）。

**未验证**

| 项 | 原因 |
| --- | --- |
| MySQL / PostgreSQL | 代码层无方言依赖，但开发机没有这两个数据库，需要 CI 跑矩阵 |
| S3 兼容存储 | 适配器已实现（`aws-sdk-go-v2`），S3 测试默认跳过，需要真实端点（MinIO / moto / AWS）才能验收 |

**未实现 / 已知边界**

| 项 | 说明 |
| --- | --- |
| Docker | 已提供 `docker-compose.yml`（API 内嵌前端 + 安全服务；静态站可选 profile）；默认两镜像与 compose 栈已实机构建运行，注册/登录、上传与备份链路已验证 |
| Windows 安装包（MSI） | 未实现；Windows 通过启动器 + zip 分发 |
| 多副本部署 | WebSocket 票据与 hub 在进程内存，限流是进程内固定窗口；多副本需要共享存储与边缘限流 |
| 浏览器端访问限制 | 只能约束使用本站脚本的访问者；IP 级请求/并发由 Nginx / Cloudflare 执行，后台只生成片段 |
| 域名别名 | 服务端按 Host 解析单一站点，别名域名需要反向代理改写 Host（生成的片段已包含） |
| S3 上传内存占用 | 受 SigV4 限制需先缓冲，上限等于单文件上限（25 MiB） |
| 邮件 | 已接入找回密码与邮箱验证两种事务邮件；评论回复、审核结果等通知邮件模板尚未接入 |
| SEO | 标签由前端写入 `<head>`，不执行 JS 的抓取器只能看到 `index.html` 的默认值 |
| sitemap / robots | Go API 已按 Host 在站点根路径动态输出 `/sitemap.xml` 与 `/robots.txt`，后台也可下载静态副本；纯静态托管时仍需手动放到站点根目录 |
| 尚未实现 | 前端 SDK 生成、OAuth 适配器、手机验证码、搜索分页游标 |

更细的现状见 [当前实现与文档差异](superpowers/reports/2026-11-07-documentation-reality-check.md)。[2026-10-20 交付状态报告](superpowers/reports/2026-10-20-delivery-status.md) 保留为历史快照，其中的“未实现”清单已不代表当前代码。

## 9. 目录结构

```text
apps/api/           Go API
  cmd/{server,migrate,seed}     进程入口与运维命令
  ent/schema/                   持久化模型（Ent）
  internal/
    auth/ site/ content/        业务模块（domain + service + handler）
    community/ messaging/ notifications/ moderation/ media/ search/
    outbox/                     可靠事件与重试
    platform/{config,logging,errors,page,mailer}/
    infrastructure/             Ent 仓储、存储适配器、Rust gRPC 客户端
    transport/{http/gin,ws}     HTTP 中间件与 WebSocket
apps/web/           React 前台、管理后台与八步安装引导
apps/launcher/      Windows 一键启动器（go:embed + 同源反代）
services/security/  Rust 安全服务（tonic）
packages/contracts/ OpenAPI 3.1 与 protobuf，含生成代码
docs/               设计稿、实施计划、评审报告、交付状态
scripts/            dev / test / gen / package
```

## 10. 文档与参与

- [根目录 README](../README.md)——功能全景、启动、配置、已知限制
- [前端说明](../apps/web/README.md)——路由、主题、页面编排、打包
- [产品与技术设计](superpowers/specs/2026-10-18-practacu-press-design.md)
- [计划评审与可行性](superpowers/reviews/2026-10-18-practacu-press-plan-review.md)
- [当前实现与文档差异](superpowers/reports/2026-11-07-documentation-reality-check.md)
- [2026-10-20 交付状态报告（历史快照）](superpowers/reports/2026-10-20-delivery-status.md)

**许可证**：**AGPL-3.0**，全文见 [LICENSE](../LICENSE)。它可以商用——部署、修改、对外提供付费服务都不需要授权；但**修改版必须以同一许可证开源**，包括"只作为网络服务提供、并不分发二进制"的情况（AGPL 第 13 条），同时**必须保留版权声明、项目名称与仓库地址**，并在改动过的文件上标明改动（第 5 条、第 7(b) 条）。不能接受 AGPL 的场景（例如嵌进闭源产品）目前没有商业双许可。

**怎么参与**：仓库目前是单人作品，没有 `CONTRIBUTING.md`。想提问题、报 bug、要某个功能，开 issue 就好；因为代码里大量决策都有测试与文档背书，提 PR 时请一并说明动机与验证方式。

---

## 附：GitHub 仓库设置（About / Topics）

### About 简介

**中文**（约 80 字，可直接粘贴）：

```text
自托管的社区型 CMS：占地少、跑得快、开箱即用、高度可定制。Go API + Rust 安全服务 + React 前后台，Windows / Linux 均可部署，OpenAPI 3.1 契约对齐。
```

**English**（约 210 字符，GitHub 上限 350）：

```text
A self-hosted community CMS: small footprint, fast, quick to set up and deeply customisable. Go API + Rust security service + React frontend/admin on Windows or Linux, aligned by an OpenAPI 3.1 contract.
```

### Topics

```text
cms  content-management-system  community-platform  multi-tenant  self-hosted
blog-engine  golang  go  gin  ent  rust  react  typescript  vite  sqlite
openapi  websocket  self-hosted-blog
```

（18 个，GitHub 上限 20 个。若要更突出"能本地跑"，可把 `blog-engine` 换成 `desktop-app`。）

### 仓库设置清单

- **许可证**：已加，`AGPL-3.0`（[LICENSE](../LICENSE)）。仓库根目录的 About 区可以不再写"未开源许可"。
- **社交预览图**：待补。用一张前台首页截图（建议 1280×640）放进仓库并设为 Social preview，About 区会更像"产品"而不是"作业"。

---

# English

> **A self-hosted community CMS: small footprint, fast, quick to run, easy to make your own.**
> A Go API, a Rust security service, and a React frontend + admin, all aligned by one
> OpenAPI 3.1 contract. Windows and Linux are both first-class, and source, launcher and
> container installs share the same configuration.

**Practacu Press** is a self-hosted, community-oriented content management system that puts three things in one product: **writing**, **community**, and **site operations**.

Same codebase, three shapes:

| Shape | How it runs | Good for |
| --- | --- | --- |
| **Desktop** | Run `PractacuPress.exe` (or double-click it). The site serves on port 80 and data stays in `data/` next to the exe. | Personal writing, internal communities, demos |
| **Container** | `docker compose up -d` starts three containers: API, security service and an Nginx static site. | Linux servers, single-host self-hosting |
| **Server** | Go API + static frontend + Rust security service, on SQLite / MySQL / PostgreSQL. | Public multi-site deployments, multi-tenant SaaS |

And two modes: **single-site** (one site, no "tenant" concepts to learn) or **multi-site SaaS** (each site has its own content, members, theme, review rules and permission boundary).

## What it is for

Most options force a trade-off: blog engines write well but have no community; forum software has community but clumsy authoring; heavyweight CMSs have both but demand Docker, database tuning and a pile of dependencies.

**Four advantages you can actually feel**

| Advantage | What it means here |
| --- | --- |
| **Small footprint** | The Windows launcher is 8.3 MB and embeds the whole frontend; the Rust security service is 3.3 MB; the frontend build is 1.3 MB. SQLite runs on a pure-Go driver, so the database is one file — nothing extra to install, tune or back up. The container deployment is three images. |
| **Fast** | One request layer (Gin); Ent-generated code talks straight to `database/sql`; pool and SQLite WAL / busy_timeout are configured by the server. The frontend is a static SPA with no Node at runtime and no server-render round trip; the gateway handles gzip and long-lived caching for fingerprinted assets. |
| **Quick to run** | A seven-step wizard with live health checks: `docker compose up -d` or `启动.bat` brings up the whole stack. Backup means copying the `data/` directory. |
| **Easy to make your own** | 2 themes + 7 colour presets with JSON import/export; independent desktop / tablet / phone layouts where every block can set its own corner radius, shadow, crop, background, padding and border, with a built-in button block; mind maps, logic charts, statistical charts and fishbone diagrams can be inserted while writing; navigation, footer, SEO, access limits, domains and TLS all configurable; everything behind an OpenAPI 3.1 contract (currently 83 paths / 100 operations; site-root sitemap / robots and the built-in docs page are outside the contract). |

Practacu Press aims for all three at low deployment cost:

1. **Authoring is not compromised.** Columns, galleries, callouts and video cards survive sanitization as real HTML, not escaped literals.
2. **Community is first-class.** Members, roles, review, notifications, DMs and reports sit on one permission chain — not bolted on as plugins.
3. **Deployment is cheap.** SQLite runs on a pure-Go driver, so the desktop build needs **no database, no Node, no Docker**; on a server, `docker compose up -d` is the whole stack.

## Feature highlights

- **Writing** — rich text and Markdown side by side; Markdown is rendered by goldmark (GFM) on the server, then sanitized against an allow-list in Rust. Toolbar blocks, live preview, and a word count measured on the *rendered* text. Mind maps, logic charts, statistical charts (bar / line / donut / pie) and fishbone diagrams are stored in the body as `pp-diagram` fenced blocks and redrawn as SVG on the reading page, so the server allow-list stays untouched.
- **Reading** — header search that queries as you type (220 ms debounce, top 6 hits, `/` to focus, Enter for the full result page); SEO with title templates, canonical, Open Graph / Twitter, JSON-LD (WebSite, SearchAction, Article, BreadcrumbList, Person), site verification, a global noindex switch, and downloadable `sitemap.xml` / `robots.txt`.
- **Community** — articles and posts, threaded comments, likes, bookmarks, follows, DM conversations, in-app notifications, reports and moderation. A 5-state / 5-action review state machine, with per-site publishing policy; authors cannot approve their own work.
- **Realtime** — WebSocket upgrades with a **one-time ticket** (60 s, single use, stored hashed) so access tokens never land in URLs, plus a REST catch-up endpoint (`GET /events`) for reconnects.
- **Admin** — 3 built-in themes (paper single-column; "Daylight" white card-based editorial; "Night Flight" warm-dark two-column) with 8 colour presets and JSON import/export; no-code page composition **independently per desktop / tablet / phone**; fully configurable navigation and footer; access limits, domains and TLS, performance and storage settings that emit ready-to-deploy Nginx and `.env` snippets; members and 4-role permissions; media library, review queue, taxonomy, analytics, built-in extensions.
- **Delivery** — seven-step first-run wizard (demo data in `localStorage`, or a real backend found automatically); a Windows launcher that embeds the frontend via `go:embed`, proxies `/api`, `/healthz` and `/readyz` on the same origin, and falls back from port 80 to 8080 when busy; and a packaging script that **actually boots the artifact on a temporary port** and smoke-tests registration, article creation (verifying `<script>` is stripped) and publishing before producing a zip.

## Architecture

```text
Browser (React 19 SPA: site / admin / setup wizard)
        │  REST · OpenAPI 3.1        WebSocket (one-time ticket)
        ▼
Go API — modular monolith (Gin)
  auth · site · content · community · messaging · notifications
  moderation · media · search · analytics · taxonomy · outbox
        │ Ent + database/sql                    │ gRPC
        ▼                                       ▼
SQLite (pure Go) / MySQL / PostgreSQL     Rust security service (tonic)
                                          Argon2id · HTML allow-list · upload inspection
```

Three decisions worth calling out:

1. **A modular monolith, not premature microservices.** Review, permissions, comments, notifications and audit are deeply transactional. Modules keep hard boundaries (`Handler → Service → Domain → Repository interface`, with Ent, storage and gRPC clients in `infrastructure`) while local installs avoid distributed overhead. `outbox`, internal gRPC and the standalone Rust service keep the seams open.
2. **Security primitives live in Rust.** Password hashing (Argon2id), HTML sanitization and upload inspection are exactly the details that are easiest to get wrong and least affordable to get wrong — so they are one gRPC service, not scattered business code.
3. **Fail closed, deliberately.** If the security service is unreachable, **publishing and upload completion return 503** instead of skipping the check. Browsing, drafting and analytics keep working — the degraded surface is explicit, not accidental.

## Stack

| Layer | Choice |
| --- | --- |
| Backend | Go 1.26 · Gin · Ent · `database/sql` |
| Database | SQLite (pure Go) / MySQL / PostgreSQL |
| Security service | Rust · tonic (gRPC) · argon2 · ammonia · zeroize |
| Frontend | React 19 · Vite 7 · TypeScript 5.9 · React Router 7 (no UI framework) |
| Contract | OpenAPI 3.1 (**83 paths / 100 operations**; site-root sitemap / robots and the built-in docs page are outside the contract) + protobuf |
| Realtime | WebSocket (`coder/websocket`) + outbox catch-up |
| Desktop | Go launcher (`go:embed` + same-origin reverse proxy) |

## Engineering details

- **Contract first.** `packages/contracts/openapi/openapi.yaml` is the single source of truth and is covered by tests; the frontend only depends on public REST.
- **Auth.** Ed25519-signed JWTs (15 min) with rotating refresh tokens: **a replayed refresh token revokes the entire token family**, concurrent refreshes are settled with conditional updates, refresh lives in an HttpOnly cookie with double-submit CSRF, the response body never carries the refresh token, and unknown emails fail identically to wrong passwords.
- **Two-phase uploads.** Declare → send bytes → scan → downloadable only when `clean`. Storage keys never contain a user-supplied filename, MIME types come from a closed allow-list, oversize streams are truncated by `io.CopyN` (not one extra byte written), and rejected assets return `404` — not even their existence is disclosed.
- **Server-side permissions.** A 4-role × 4-action matrix, with cross-site operations rejected outright.
- **No dialect-specific SQL.** No FTS, no vendor SQL; SQLite pragmas (foreign keys, WAL, busy timeout) are applied by the server, which is why the desktop build is unzip-and-run.
- **Outbox with audience.** Events carry `audience_user_id`; REST catch-up and WebSocket delivery are two independent implementations, so a bug in one does not leak through both.

## Status and limitations

The project separates "actually exercised" from "written but unverified":

- **Verified locally:** auth and session rotation, site resolution and permissions, the content state machine, two-phase media upload and download, search, notifications, DMs, WebSocket tickets, event catch-up, reports and moderation, audit queries, email verification, and the packaging self-test against a real process.
- **Implemented but unverified:** MySQL / PostgreSQL (no local instances; needs a CI matrix) and S3-compatible storage (S3 tests are skipped without a real endpoint such as MinIO or AWS).
- **Not done / known edges:** the host TLS proxy has not been exercised in staging; no MSI installer; multi-replica deployment (WebSocket tickets and the hub are in-process; rate limiting is per process), granular IP/concurrency limits (the admin generates Nginx snippets, it does not enforce them), notification email beyond password reset and email verification, SEO tags written client-side (crawlers without JS see `index.html` defaults), sitemap/robots served by the API at the site root but still manual for static-only hosting, and no frontend SDK generation, OAuth adapters, SMS codes or search pagination.

Details in [Current implementation vs. documentation](superpowers/reports/2026-11-07-documentation-reality-check.md). The [2026-10-20 delivery status report](superpowers/reports/2026-10-20-delivery-status.md) is a historical snapshot whose "not implemented" list no longer describes the current code.

## Getting started

### Docker (Linux / servers)

```bash
docker compose up -d --build     # API + security service + Nginx static site
```

Open `http://localhost:8080` and finish the seven-step wizard — the first account becomes the platform administrator. The port is bound to loopback by default, and data lives in the named volume `practacu-data`. Full details in the [README](../README.md).

> The three images and the compose stack have been built and started for real (three healthy containers; registration/login, media upload with the security-service scan, an instance backup and the RSS/sitemap paths were exercised). The host TLS proxy still needs a staging run.

### Windows launcher

Prerequisites: Go 1.26+, Node.js 22+. Rust is optional — the API still starts without the security service, but publishing and upload completion then return 503 by design.

```bat
启动.bat            :: starts everything, opens the browser
启动.bat --check    :: environment check only
```

```powershell
# manual
go run ./apps/api/cmd/seed -driver sqlite -dsn $env:DATABASE_DSN
go run ./apps/api/cmd/server
cd apps/web; npm install; npm run build; npm start

# tests
powershell -ExecutionPolicy Bypass -File scripts\test.ps1
cd services/security; cargo test

# distributable Windows build (boots and smoke-tests the artifact)
powershell -ExecutionPolicy Bypass -File scripts\package.ps1
```

Full steps, configuration and packaging flags: [README](../README.md) and the [frontend guide](../apps/web/README.md).

## License

Practacu Press is released under the **GNU Affero General Public License v3.0** (`AGPL-3.0`) — see [LICENSE](../LICENSE). In short:

- **Commercial use is allowed.** Deploy it, modify it, sell a service on top of it — no permission or fee required.
- **Derivatives must stay open.** If you distribute a modified version, or run it as a network service for others (exactly the case AGPL §13 covers), you must publish the complete modified source under the same license.
- **Attribution is required.** Keep the copyright notice, the project name and the repository URL, and mark the files you changed (AGPL §5 and §7(b)).

There is no commercial dual-licensing for cases that cannot accept AGPL — embedding it in a closed-source product, for example.

## Contributing

There is no `CONTRIBUTING.md` yet. Issues (bug reports, feature requests) are welcome. Because most decisions here are backed by tests and written design docs, pull requests should explain both the motivation and how the change was verified.
