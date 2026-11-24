# Practacu Press

**简体中文**　·　[English](README.en.md)

| 站点前台（默认主题：原版 · 纸白浅色） | 管理后台（仪表盘） |
| :---: | :---: |
| ![站点前台](.github/readme/frontend.png) | ![管理后台](.github/readme/admin.png) |

> **自托管的社区型 CMS：占地少、跑得快、开箱即用、想怎么改就怎么改。**
> Go API（内嵌前端与安全检查）+ React 前台与后台，由同一份 OpenAPI 3.1 契约对齐；
> Windows 与 Linux 都是一等公民，源码、容器、Windows 便携包三种装法共用一套配置。

## 为什么是它

| | |
| --- | --- |
| **占地少** | 单文件 API **内嵌整套前端**；前端构建产物 1.3 MB。SQLite 用纯 Go 驱动，数据库就是一个文件——不用另装、另调、另备份一个数据库服务。默认容器部署只有两个镜像：API（内嵌前端与安全检查）。 |
| **性能高** | 请求只经过 Gin 一层，Ent 生成的代码直连 `database/sql`；连接池与 SQLite 的 WAL / busy_timeout 由服务端自己配好。前端是纯静态单页应用，**运行时不依赖 Node**，没有服务端渲染往返；网关负责 gzip 与「带哈希资源长期缓存」，首屏请求合并、媒体懒加载都在后台可配。 |
| **使用便捷** | 八步安装引导自带健康检查，装完即用：`docker compose up -d` 或 `启动.bat` 一条命令起全栈（API 已内嵌前端与安全检查）。备份就是把 `data/` 目录整体复制走。 |
| **自定义好** | 2 套大主题（原版：纸白浅色单栏 / 夜航：冷石墨深色双栏）+ 7 套配色预设，主题可导入 / 导出 JSON；页面编排支持桌面 / 平板 / 手机**三端独立布局**，每个组件可单独设置圆角、阴影、裁剪、背景、内边距与描边，内置按钮组件；写作时可插入思维导图、逻辑图、统计图与鱼骨图，随文章发布并按主题重绘；导航、页脚、SEO、访问限制、域名与证书、存储策略都在后台逐项配置；所有能力都摆在 OpenAPI 3.1（当前契约 157 条路径 / 188 个操作，含健康检查与安装状态；站点根路径的 sitemap / robots 与内置 `/api/v1/docs` 不在契约内）后面，想换前端按契约写就行。 |

**功能面**

- **写作**：工具栏编辑器 + Markdown、实时预览、按渲染后的纯文本计字数；可插入思维导图、逻辑图、统计图（柱状 / 折线 / 环形 / 饼图）与鱼骨图，保存在正文的 `pp-diagram` 围栏里
- **社区**：评论、点赞、收藏、关注、私信、通知、举报，配 5 状态审核流
- **运营**：主题、页面编排、SEO、访问限制、域名与 SSL、存储策略、访问统计
- **安全**：Argon2id（12–128 位、弱口令黑名单）、HTML 白名单清洗、上传检查都在 API 进程内完成；失败时按设计 fail-closed。静态数据另有字段级 AES-256-GCM 加密（登录邮箱 / 手机号 / 私信正文）、整库备份加密（`.ppbak`）与 Windows DPAPI 私钥保护。本地授权安全审计报告见 [`.github/readme/md/security/2026-11-14-security-audit.md`](.github/readme/md/security/2026-11-14-security-audit.md)
- **多站点**：单站点开箱即用；需要时按站点隔离内容、成员、主题、审核规则与权限边界

**平台与许可**：Windows / Linux 皆可（源码、Windows 便携包、Docker Compose）；数据库支持 SQLite、MySQL、PostgreSQL。
**AGPL-3.0**——可商用，但修改版与网络服务必须同样开源并保留署名。

完整介绍（架构、技术栈、工程取舍、现状与限制）见 **[.github/readme/md/introduction.md](.github/readme/md/introduction.md)**　·　English: **[Introduction](.github/readme/md/introduction.md#english)**

---

**技术分层**：后端所有能力通过 REST（OpenAPI 3.1）与 WebSocket 暴露；`web` 是按同一份契约实现的前台、管理后台与首次安装引导。

- **Go API**（`cmd/server` + `internal/`）：身份、站点、内容、社区、媒体、通知、私信、事件补偿
- **内置安全检查**（`internal/security`）：Argon2id 密码哈希、内容清洗、上传检查
- **契约**（`internal/packages/contracts`）：OpenAPI 3.1
- **React 前端**（`web`）：站点前台、管理后台、八步安装引导（含高威胁操作保护与前后台字号设置）、邮箱或用户名登录（登录表单居中 + 主题背景）、主题库与页面编排（可按桌面 / 平板 / 手机独立编排，组件可设圆角、阴影、裁剪等外观，含按钮组件）、文章写作（可插思维导图 / 逻辑图 / 统计图 / 鱼骨图）、自定义页面、扩展系统（内置扩展 + 导入 zip：纯前端扩展与 Go/WASM 后端扩展；性能面板即内置扩展）、站点更新（显示名称 / 当前版本与仓库 version.json 对比 / 手动或自动检查 / GitHub 或镜像更新源下拉 / 手动切换构建且不停机）、访问限制、访问与域名（含 SSL 证书与访问端口）、性能设置与加载动画、性能面板（圆环显示本软件与其他软件的 CPU / 内存 / 磁盘占用，可选模块）
- **高威胁操作二次验证**：删除 / 编辑账户、重置两步验证、覆盖导入站点数据、删除敏感词与 IP 规则等操作，开启保护后必须再次输入密码。验证按**浏览器会话**生效：每打开一次浏览器，第一次高危操作需要验证；同一次浏览器会话内反复操作只验证一次（刷新页面不重复询问，关闭浏览器后重新验证）。安装引导第 5 步可开启保护并选择“账户登录密码”或另设专用安全密码（之后可在「站点设置 → 高威胁操作保护」修改）。

### 写作与阅读

- **写作**：编辑器带工具栏，可插入标题、分栏、图片（含素材库上传）、视频卡片、
  嵌入网址卡片、链接、表格、图集、提示框、引用、分割线与图标；右侧是预览，
  字数按渲染后的纯文本统计。全局快捷键是 `Shift+K` 命令面板、`Shift+S` 搜索、
  `Shift+D` 切换深浅色、`Shift+H` 回首页。
- **Markdown**：服务端先用 goldmark 把 Markdown 转成 HTML（GFM：表格、删除线、任务列表、
  图片、自动链接），再在进程内按白名单清洗——所以 `标题`、`表格`、`图片` 在真实环境里
  也是真的标签，而不是字面量。写作工具栏插入的区块是可被白名单保留的 HTML
  （分栏用 `table.pp-columns` 承载布局，视频是封面卡片而不是 iframe）。
- **搜索**：站点头部常驻搜索框，输入即搜（防抖 220ms，前 6 条），`/` 聚焦，回车进完整结果页；
  窄屏只留放大镜。
- **SEO**：标题模板、描述、关键词、canonical、Open Graph / Twitter、JSON-LD
  （WebSite、SearchAction、Article、BreadcrumbList、Person）、站长验证 meta、全站 noindex 开关，
  以及后台可下载的 `sitemap.xml` / `robots.txt`。边界见
  [管理后台 → SEO](web/src/pages/admin/Seo.tsx) 里的说明：标签由前端写入 `<head>`，
  不执行 JS 的社交抓取器只能看到 `index.html` 的默认值。
- **主题**：后台「主题设置」把配色、排版与单栏/卡片/双栏版式作为一套「大主题」整体切换。
  内置原版（纸白浅色单栏）与夜航（冷石墨深色双栏）；主题选择区可导入 / 导出
  主题包（zip：主题清单 + 组件 + 页面编排，见 [主题开发文档](.github/readme/md/themes/README.md)）、
  另存为自定义主题与删除自定义主题。页面编排、外观（品牌/页脚）与加载动画归入同一导航组；
  只有首页仍为默认编排时，切换主题才会同步替换默认组件。页脚的全部内容（品牌标题/副标题/简介、
  状态标签、栏目与条目、版权与底部说明）都可以在「主题设置 → 导航与页脚」里逐项自定义；
  顶部导航也完全可配：每个 Tab 可设内置图标与左右位置、自由排序，最多挂 8 个二级入口，
  二级入口可渲染成页头下方的胶囊栏或收进下拉菜单。页头左上角（夜航）与页脚底栏上方还能放
  一排可配置的软件 / 社交快捷链接（GitHub、X、Mastodon、RSS、邮箱、任意网站）；「主题微调」
  新增柔化与过渡：背景柔光、组件混色、过渡时长与页头模糊，系统开启“减少动效”时自动降级。
  夜航首页的文章卡另可在「封面在上」（默认）与「模糊背景」（封面铺满整张卡并高斯模糊，
  标题与简介压在卡内毛玻璃面板上）之间切换，只改展示、不改内容与排序。
- **访问与性能**：后台「访问限制」限制页面切换、页面请求与同浏览器并发页面，并生成
  Nginx `limit_req` / `limit_conn` 与 API `.env`；「访问与域名」设置主域名、别名白名单、
  SSL 证书（Let's Encrypt / 手动证书）、CORS、Cookie 作用域与可信代理；没有设置主域名时，
  生产环境只允许公网 IP 直接访问；「性能优化」减少首屏读取、合并重复请求、懒加载媒体，并生成
  网关压缩/缓存与 API 超时、数据库连接池参数；「存储策略」先用全局本地目录或 S3 兼容云对象存储
  （AWS、MinIO、阿里云 OSS、腾讯云 COS），再按用途单独覆盖：文章媒体、站点图片、用户头像、
  用户数据/附件可以各自选本地目录或桶/前缀，生成 `STORAGE_<SCOPE>_*` 服务端片段；「加载动画」
  可制作前台加载画面，也可以切换成页面原位骨架（SKELETON / SHIMMER / 两者叠加），让等待中的
  内容占位直接落在最终版式的位置。
  这些设置都保存在本地安装配置里，服务器参数需要部署片段后重启生效。
- **一键恢复**：页面编排可对当前首页或自定义页面恢复默认组件（页面标题、路径与发布状态不变）；
  「外观」可按范围重置品牌文案、首页/页面编排、加载动画、性能、访问限制与访问域名；
  「主题设置」可恢复当前主题定义或回到原版主题。

---

## 中英双语

站点可以在**简体中文 ↔ English** 之间切换，但选择只在装站时做一次：

- **安装引导第一步（欢迎页）**右上角的语言胶囊；装完之后后台不提供语言开关。

语言是**站点级**设置：一个站点一种语言，前台、后台、安装引导与全部提示文案一起切换，
访客不需要（也不能）单独选择。选择存在站点设计里并随它同步到服务端，所以换浏览器、
换设备看到的语言一致。默认简体中文，老站点升级后观感完全不变。

实现上中文原文就是翻译键：`t('站点设置')` 在中文下原样返回，在英文下查字典。
好处是中文输出逐字不变，改文案不需要同步维护两套键名。英文文案按**源文件**拆成
`web/src/lib/i18n/dict/fragments/*.ts` 片段，新增页面只需要加自己的片段。

后端错误提示（Go 返回的中文 message）在英文界面下按 `problem.code` 翻译，
未收录的错误码回退服务端原文，不会出现空白提示。

自查与验收：

```powershell
cd web
npm run i18n:audit                 # 未迁移文案与覆盖率
npx vitest run src/lib/i18n        # 缺译 / 英文含中文 / 占位符一致性
npm run build
node scripts/serve.mjs --port 8099 # 另开一个窗口
node scripts/e2e-i18n.mjs          # 中英切换、刷新保持、零残留中文（截图在 .tmp/shots-i18n）
```

**不翻译**：文章正文、评论、自定义页面内容等用户内容；站点导航与页脚里站长自己填的文案
（它们属于站点内容，不是界面文案）。

---

## 安装

三种装法任选：**Docker**（Linux / 服务器推荐）、**Windows 便携包**（本机最省事）、**源码**（任意平台，需要 Go 1.26+，前端需要 Node.js 22+；安全检查已编译进 API，无需额外服务）。

### Docker 部署（Linux / 服务器）

#### 先装 Docker（本机已有就跳过）

需要 Docker Engine 与 Compose v2：启动命令是 `docker compose`（子命令），不是老版的
`docker-compose`；下面装好之后 `docker compose version` 能打印版本就说明齐了。

Ubuntu / Debian（Docker 官方 apt 仓库，`${ID}` 由系统自动取 `ubuntu` 或 `debian`）：

```bash
sudo apt-get update && sudo apt-get install -y ca-certificates curl gnupg
sudo install -m 0755 -d /etc/apt/keyrings
. /etc/os-release
curl -fsSL "https://download.docker.com/linux/${ID}/gpg" | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/${ID} ${VERSION_CODENAME} stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"   # 注销重登（或 newgrp docker）后不用再写 sudo
docker compose version
```

> Linux Mint 等衍生版把 `${ID}` 手动改成 `ubuntu`，并核对 `${VERSION_CODENAME}` 是官方仓库里存在的代号。

RHEL / CentOS / Rocky（dnf 系）：

```bash
sudo dnf -y install dnf-plugins-core
# RHEL 9 / 10：
sudo dnf config-manager --add-repo https://download.docker.com/linux/rhel/docker-ce.repo
# Rocky / AlmaLinux / CentOS Stream 改用 centos 仓库：
# sudo dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
sudo dnf -y install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"
docker compose version
```

> RHEL 10 等 dnf5 环境若没有 `config-manager --add-repo`，改用
> `sudo dnf config-manager addrepo --from-repofile=<上面的 .repo 地址>`。

#### 构建并启动

仓库自带 `docker-compose.yml`，默认只启动一个 API 容器（已用 `go:embed` 内嵌前端，安全检查也编译在同一进程），在仓库根目录执行：

```bash
docker compose up -d --build
```

首次构建要拉基础镜像并编译，视网络需要几分钟。起来后先确认健康：

```bash
docker compose ps                      # practacu-press 应为 running / healthy
curl -fsS http://127.0.0.1:8080/api/healthz
```

打开 **http://localhost:8080** 走完八步安装引导；**引导里创建的第一个账户就是平台管理员**。

- **组成**：`practacu-press`（Go 二进制，内嵌 SPA，同时提供 `/api`、静态资源与 SPA 回退）。只有 `practacu-press` 映射到宿主机；没有独立的 web/Nginx 容器，也没有安全服务容器。
- **默认只绑回环**：API 端口写成 `127.0.0.1:8080:8080`，避免还没装完的实例被公网抢先注册成管理员。装完后复制 `deploy/production/env.prod.example` 为 `.env.prod`，用 `docker compose --env-file .env.prod up -d --build` 切生产，并在前面加一层 TLS 反代；不要把未安装完的实例直接改成 `0.0.0.0:8080`。
- **数据**：命名卷 `practacu-data` 里是 `practacu.db` 与 `media/`。`docker compose down` 不删数据，`down -v` 才删。想直接用宿主机目录，把 compose 里的卷换成 `./data:/data` 并先 `mkdir -p data && sudo chown 10001:10001 data`。
- **单站点形态**：compose 用 `PP_DESKTOP=true`，走的是和 Windows 便携包一样的零配置引导（自动建表、建默认站点、首个账户成为平台管理员）。Docker 端口映射会隐藏客户端地址，所以默认开启 `PP_FIRST_ADMIN_TRUST_PROXY=1` 放宽首个管理员判定；它只在回环端口上安全，完成安装后可设为 `0`。多站点 / SaaS 请设为 `false`，并自行准备数据库与管理员账户。
- **日志与运维**：`docker compose logs -f`、`docker compose exec practacu-press migrate`、`docker compose exec practacu-press seed`；`backup`、`media-gc`、`searchindex` 是同一个二进制里的子命令，镜像不含第二个可执行文件。
- **生产部署**：同一份 `docker-compose.yml` 配合 `--env-file .env.prod` 提供 production 语义、持久 JWT 私钥与 Secure Cookie；`deploy/production/nginx.conf` 负责 TLS 终止、安全响应头与 `location /__pp/ { return 404; }`。**首次安装必须在回环完成后再切生产**，步骤、密钥生成、备份/升级见 [.github/readme/md/deployment/production-profile.md](.github/readme/md/deployment/production-profile.md)。
- **单独构建镜像**：`docker build -f Dockerfile .`。

> 默认 API 镜像与 compose 栈已在 Docker 中构建并启动验证：API healthy，`/api/healthz`、`/api/readyz`、RSS/Atom/sitemap/robots、首个管理员注册与登录、媒体上传（含内置安全检查）和整库备份均跑通；`docker compose config` 通过。宿主机 TLS 反代仍需在预发环境按部署文档验证证书与 HSTS。

### Linux 原生安装包（tar.gz / deb / rpm）

既不想用 Docker、也不想在服务器上装 Go / Node 时，用仓库打好的原生包：里面是
对应架构（x86_64 或 aarch64）的 API / seed / migrate / backup / media-gc / searchindex
二进制、内嵌在 API 二进制里的 SPA 与安全检查，以及一个**交互式安装向导**（`install.sh`）。目标机
只需要 systemd 与 Nginx，不需要任何开发工具链。

```bash
tar -xzf PractacuPress-Linux-<x64|arm64>.tar.gz
cd PractacuPress-Linux-<x64|arm64>
sudo ./install.sh
```

Debian/Ubuntu 与 RHEL/Fedora/openSUSE 也可以直接装 `.deb` / `.rpm`（两者都提供
`amd64` 与 `arm64`）：安装包会自动执行一次非交互安装，依赖 `nginx`、`curl`、`openssl`。

```bash
sudo apt install ./practacu-press_<version>_<arch>.deb
sudo dnf install ./practacu-press-<version>.<arch>.rpm
```

向导会询问程序目录、数据目录、端口与是否配置 Nginx，然后创建系统用户与目录、生成
Ed25519 签名私钥、注册 systemd 服务、建库建站，并只把安装引导暴露在 `127.0.0.1:8080`——
**首个管理员只能从回环地址注册**，所以远程服务器要用 SSH 隧道（`ssh -L 8080:127.0.0.1:8080 用户@服务器`）
或本机浏览器打开。走完八步安装引导后，再切访问形态：

```bash
sudo /opt/practacu-press/install.sh --finalize --mode lan                    # 内网 / 单机 HTTP
sudo /opt/practacu-press/install.sh --finalize --mode public --domain a.com  # 公网 HTTPS（自动申请证书）
```

`--status` 看状态；重跑 `sudo ./install.sh` 是升级（保留数据库、密钥与访问形态）；
`uninstall.sh` 卸载（默认保留数据）。SSH 隧道、域名验证、备份/升级/卸载与排障的完整步骤见
[deploy/linux/INSTALL.md](deploy/linux/INSTALL.md)。

自己打包：`node scripts/package-linux.mjs --arch amd64|arm64`（Windows 与 Linux 构建机都可用：
构建前端、交叉编译 Go、自检 ELF/脚本/模板，最后生成 tar.gz 与 sha256），产物在
`release/`。

### 发布版本（GitHub Release / Docker 镜像）

推送提交信息里带版本号（`v1.0.0` 正式版，`v1.0.1-beta1` 测试版；大小写 `v` 均可）就会触发
[.github/workflows/release.yml](.github/workflows/release.yml)：创建 GitHub Release，并上传
Windows x64/arm64 便携包、Linux x86_64/aarch64 的 tar.gz + deb + rpm、macOS x86_64/arm64
的 tar.gz 与 `SHA256SUMS`；同时把镜像以 `linux/amd64,linux/arm64` 推到 Docker Hub 的
`practacupress/press`。稳定版和测试版都会更新 `<version>` 与 `latest` 两个标签。

- 需要配置仓库 Secrets：`DOCKERHUB_USERNAME`、`DOCKERHUB_TOKEN`。
- 镜像：`practacupress/press:<version>` 与 `practacupress/press:latest`。
- 用发布镜像运行：`PP_IMAGE=practacupress/press:v1.0.0 docker compose pull`，然后 `PP_IMAGE=practacupress/press:v1.0.0 docker compose up -d`。
- 也可以手动触发 Action 并填写版本；打 `v*` / `V*` tag 同样会触发。完整说明见
  [.github/readme/md/deployment/releases.md](.github/readme/md/deployment/releases.md)。

### Linux 源码运行（bash）

不想用容器时可以直接跑源码（开发、调试或自托管）。前提：**Go 1.26+**、**Node.js 22+**、Git；
安全检查已编译进 API，不需要额外服务。

```bash
# Ubuntu / Debian 的基础工具与 Node.js 22（Go 见下）
sudo apt-get update && sudo apt-get install -y git build-essential
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# Go 1.26+：从 https://go.dev/dl/ 下载 linux-amd64 压缩包，解到 /usr/local 后加进 PATH。
# 以 go1.26.0 为例（补丁版本可换新，只要 ≥ go.mod 里的 1.26）：
#   curl -fsSLO https://go.dev/dl/go1.26.0.linux-amd64.tar.gz
#   sudo rm -rf /usr/local/go && sudo tar -C /usr/local -xzf go1.26.0.linux-amd64.tar.gz
#   export PATH=/usr/local/go/bin:$PATH
```

> RHEL 系把第一条换成 `sudo dnf install -y git gcc-c++ make`，Node.js 22 用 NodeSource 的 RPM 源：
> `curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash -` 然后 `sudo dnf install -y nodejs`。
> Go 同样以官方发布包为准（发行版仓库里的版本通常低于要求）。

```bash
cd practacu-press                      # 仓库根目录（git clone 或解压后进入）

# 1) 前端：构建一次，产物是 web/dist 里的纯静态文件
cd web && npm ci && npm run build && cd ../..

# 2) 环境变量：存成 ~/.practacu-env.sh，之后每个终端 source 一次（新终端不继承 export）
cat > ~/.practacu-env.sh <<'EOF'
export APP_ENV=development
export HTTP_ADDR=127.0.0.1:8080
export DATABASE_DRIVER=sqlite
export DATABASE_DSN='file:./data/practacu.db'
export STORAGE_DRIVER=local
export STORAGE_DIR=./data/media
# 单站点自托管：首个注册账户成为平台管理员；多站点 / SaaS 部署不要打开
export PP_DESKTOP=true
EOF
source ~/.practacu-env.sh
mkdir -p data/media
```

> **GoLand / 本机直接运行**：把 `.env.example` 复制为仓库根目录的 `.env`，Run Configuration 的 Working directory 保持仓库根目录，直接运行 `cmd/server` 即可。服务会从当前目录向上找到最近的 `.env`（到 `go.mod` 为止）并加载；已经存在的环境变量优先级更高。开发模式下如果 `web/dist` 已构建，API 会直接从磁盘提供前端；`make embed-web` 可验证单二进制形态。

建库并创建默认站点（只需一次）。新开的终端不会继承环境变量，所以下面每个终端都先 `source` 一次：

```bash
# 只做一次：建表 + 默认站点
source ~/.practacu-env.sh
go run ./cmd/seed -driver sqlite -dsn "$DATABASE_DSN"

# 终端：Go API（监听 127.0.0.1:8080）
source ~/.practacu-env.sh
go run ./cmd/server
```

确认 API 就绪（两个都返回 200；`readyz` 检查数据库连接）：

```bash
curl -fsS http://127.0.0.1:8080/api/healthz
curl -fsS http://127.0.0.1:8080/api/readyz
```

> 发布包与 Docker 镜像会自动把 `web/dist` 同步进 `internal/web/dist`
> 再编译，所以单个 API 进程同时提供前端与 `/api`。源码直接 `go run` 时默认只有
> API；要本地验证单二进制形态，先执行 `make embed-web`（或
> `node scripts/sync-web-embed.mjs`）再启动。

前端用开发服务器：它会把 `/api`、`/api/healthz`、`/api/readyz`、`/plugins` 代理到本机 8080。

```bash
cd web
npm run dev -- --port 5173
```

打开 **http://127.0.0.1:5173/?mode=live** 走完八步安装引导；**引导里创建的第一个账户就是平台管理员**。
（Vite 配置默认想监听 80，Linux 上非 root 绑不上会自动顺延，所以这里显式指定 5173。）

> 单域名自托管、不用开发服务器时：先 `make embed-web` 把前端编进 API，再用 Nginx 之类的反向代理把 `/` 与 `/api` 都转到 API 端口（模板见 `deploy/production/nginx.conf` 与 [生产部署 profile](.github/readme/md/deployment/production-profile.md)）。`npm start` 只托管静态文件、自己不代理 API，默认端口也是 8080，会和 API 撞车——那种部署里不要跑它。

### Windows 本地启动

在仓库根目录运行 **`启动.bat`**（或双击）：

- 首次运行会在缺少 `web/node_modules` 时自动执行 `npm install`；
- 在独立窗口启动 Go API 与 SQLite；
- 在独立窗口启动 Vite 前端（`http://127.0.0.1:5173`，自动代理 `/api` 到 8080）；
- 浏览器打开 `http://127.0.0.1:5173/?mode=live`：已有真实安装会直接进入站点，否则进入
  **真实环境**安装引导并自动探测本机 8080；
- 以桌面模式运行 API：安装引导里创建的第一个账户就是平台管理员；
- 如果 API 或前端已经在运行，会直接复用，不会重复占端口。

只检查环境、不启动服务：

```bat
启动.bat --check
```

停止时在「Practacu Press - API」窗口按 `Ctrl+C`，并关闭「Practacu Press - Web」窗口。

### PowerShell 启动（只启动后端）

```powershell
powershell -ExecutionPolicy Bypass -File scripts\dev.ps1
```

它会：建库并创建默认站点 → 编译并起 Go API → 等 `/api/healthz` 就绪 → 打印地址。按 `Ctrl+C` 停止。

首次运行会编译 Go API（约几十秒），之后直接启动。

```
API        http://127.0.0.1:8080
OpenAPI    http://127.0.0.1:8080/api/v1/openapi.json
healthz    http://127.0.0.1:8080/api/healthz
```

### 手动启动

```powershell
$env:PATH = 'C:\Program Files\Go\bin;' + $env:PATH
$env:APP_ENV='development'; $env:HTTP_ADDR='127.0.0.1:8080'
$env:DATABASE_DRIVER='sqlite'; $env:DATABASE_DSN='file:./data/practacu.db'
$env:STORAGE_DIR='./data/media'
# 本地单站点安装：首个注册账户成为平台管理员；服务器部署不要打开这一项。
$env:PP_DESKTOP='true'

go run ./cmd/seed  -driver sqlite -dsn $env:DATABASE_DSN
go run ./cmd/migrate                      # 只建表，不建站点
go run ./cmd/server
```

### 前端

```powershell
cd web
npm install
npm run build
npm start
```

`http://localhost:8080`（默认 8080 端口）。后台「站点设置 → 访问与域名 → 访问端口」可以改端口，
服务会立即在新端口监听并记住选择。**`npm start` 只托管静态文件、不代理 API**，默认端口又是 8080，
要和本机 API 同时用时改走开发模式：`npm run dev`（开发服务器用 80，8080 留给本机 API）把
`/api`、`/api/healthz`、`/api/readyz`、`/plugins` 转到 `127.0.0.1:8080`；Linux 上非 root 绑不上 80 时加
`-- --port 5173`。也可以把静态站交给 Nginx 反代（见上面的 Linux 源码运行）。

首次打开会进入安装引导；没有后端时可选「演示数据」直接体验完整前台与后台。
细节见[前端说明](web/README.md)。

### Windows 便携包（一键打包）

```powershell
# 双击仓库根目录的 打包.bat，或者：
powershell -ExecutionPolicy Bypass -File scripts\package.ps1
```

打包脚本会检查工具链，然后自动完成整套流程：

1. 构建前端（`web`，缺少 `node_modules` 时自动 `npm ci`）；
2. 把前端同步进 API 的 `internal/web/dist`，并编译 Windows API（x64 或 arm64，纯 Go）；
3. 组装 `.env`、`启动.cmd`、`data/`、`VERSION` 与 `README.txt`；
4. **在临时端口实际启动打包产物做自检**：首页、SPA 回退、`/api/healthz`、`/api/readyz`、
   注册、文章创建（验证内置清洗移除 `<script>`）与发布；
5. 压缩成 zip，并同步 `release/PractacuPress`（保留用户已有的 `data/` 与 `.env`）。

任何一步失败都会立刻停下并打印原因；自检不通过不会产出新包。

产物：

- `release/PractacuPress/PractacuPress.exe`：单文件 Go 程序，内嵌前台、后台、安装引导与安全检查；
- `release/PractacuPress/启动.cmd`：双击启动并打开 `http://127.0.0.1:8080`；
- `release/PractacuPress-Windows-<x64|arm64>.zip`（及同名 `.sha256`）：整个文件夹的压缩包。

`scripts/package.ps1` 的常用参数：

| 参数 | 说明 |
| --- | --- |
| `-Arch amd64\|arm64` | 目标架构（默认当前机器；arm64 包由 Windows arm64 runner 原生构建） |
| `-SkipSmoke` | 跳过打包后的自检（不推荐） |
| `-NoZip` | 只生成 `release/PractacuPress` 目录 |
| `-ReleaseDir <目录>` | 换输出目录 |
| `-Port <端口>` | 自检固定端口（默认自动挑空闲端口） |

CI 可以直接调用底层脚本（与上面是同一套流程）：
`node scripts\package-windows.mjs --arch amd64|arm64 [--skip-smoke] [--no-zip] [--release-dir <目录>]`。

解压后双击 `启动.cmd`，或在该目录运行 `PractacuPress.exe`，然后打开
`http://127.0.0.1:8080`。数据库、媒体与备份都在同目录 `data/`。

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

# 创建文章（内容会经过内置清洗，<script> 会被移除）
Invoke-RestMethod http://127.0.0.1:8080/api/v1/articles -Method Post `
  -Headers @{ Authorization = "Bearer $token" } -ContentType 'application/json' `
  -Body '{"title":"Hello","source_body":"<h1>Hi</h1><script>alert(1)</script>"}'
```

未认证也能读公开站点：`Invoke-RestMethod http://127.0.0.1:8080/api/v1/articles`

---

## 目录结构

```
cmd/{server,migrate,seed,backup,media-gc,searchindex}  进程入口与运维命令
internal/ent/schema/             持久化模型（Ent）
internal/
  auth/ site/ content/           业务模块（domain + service + handler）
  community/ messaging/ notifications/ moderation/ media/
  outbox/                        可靠事件与重试
  platform/{config,logging,errors,page}
  infrastructure/                Ent 仓储、存储适配器、securityclient
  security/                      Argon2id、内容清洗与上传检查（进程内）
  transport/{http/gin,ws}        HTTP 中间件与 WebSocket
  web/                           内嵌 SPA 的 go:embed 与静态文件处理器
  packages/contracts/            OpenAPI 契约
  migrations/                    SQL 变更集
  tests/                         CI / 部署 / 迁移测试
  plugins/                       插件宿主与示例
web/                          React 前台、管理后台与安装引导
.github/readme/md/superpowers/     设计稿、实施计划、评审报告、交付状态
scripts/                           dev / test / gen 脚本
```

---

## 测试

```powershell
powershell -ExecutionPolicy Bypass -File scripts\test.ps1     # go build + vet + test
```

真实浏览器冒烟（自动起 Go API、全新 SQLite 与前端构建，
无头跑安装/登录、草稿/发布、阅读/评论/举报、点赞收藏、`/me`、后台设置持久化、
sitemap/robots/openapi/docs；失败留截图与 trace）：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\e2e.ps1
# 报告与截图：.tmp\e2e\artifacts\
```

前置：Chrome（默认 `PP_E2E_CHANNEL=chrome`）、`web` 已 `npm install`、
安全检查已编译进 API。细节见 [tests/README.md](internal/tests/README.md)；
CI 里是独立的可选工作流 `.github/workflows/e2e.yml`，不阻塞基础 CI。

S3 适配器默认跳过，需要真实端点（MinIO / moto / AWS）：

```powershell
python -m moto.server -p 9100
$env:S3_TEST_ENDPOINT='http://127.0.0.1:9100'
$env:AWS_ACCESS_KEY_ID='test'; $env:AWS_SECRET_ACCESS_KEY='testsecret'
go test ./internal/media/ -run TestS3 -v
```

---

## 配置

见 [.env.example](.env.example)。几个容易踩的点：

| 变量 | 说明 |
| --- | --- |
| `DATABASE_DRIVER` | `sqlite` / `mysql` / `postgres`。SQLite 的 pragma 由服务端自动补 |
| `SECURITY_ARGON2_CONCURRENCY` / `SECURITY_ARGON2_TIMEOUT_MS` | 内置 Argon2 的并发与超时上限 |
| `AUTH_JWT_ED25519_PRIVATE_KEY` | 生产必填；开发环境未配置会自动生成临时密钥并告警 |
| `TRUSTED_PROXIES` | 留空表示不信任任何代理，`X-Forwarded-*` 全被忽略 |
| `RATE_LIMIT_PER_MINUTE` | 每 IP 每分钟 API 请求上限；`0` 关闭。浏览器端限制不能替代它 |
| `MEDIA_DEFAULT_USER_QUOTA_BYTES` / `MEDIA_DEFAULT_SITE_QUOTA_BYTES` | 用户与站点媒体默认累计额度（默认 512 MiB / 10 GiB）；后台可分别覆盖，`0` 表示无限制 |
| `HTTP_READ_TIMEOUT_SECONDS` / `HTTP_IDLE_TIMEOUT_SECONDS` | HTTP 读超时与空闲 keep-alive 超时，默认 30 / 120 秒 |
| `DB_MAX_OPEN_CONNS` / `DB_MAX_IDLE_CONNS` | 数据库连接池；`0` 使用驱动默认（SQLite 1，MySQL/Postgres 25） |
| `DB_CONN_MAX_LIFETIME_SECONDS` | 连接生命周期；默认 1800 秒，`0` 表示不主动回收 |
| `STORAGE_DRIVER` | `local` 或 `s3`。S3 需要 `STORAGE_S3_BUCKET` |
| `SMTP_HOST` | 留空即关闭找回密码；配置后 `/auth/password-reset/*` 才可用 |
| `SMTP_ENCRYPTION` | `starttls`（587）/ `ssl`（465）/ `none`（25，仅本机中继） |
| `SMTP_USERNAME` / `SMTP_PASSWORD` | 必须成对出现；除本机中继外只能走 TLS |
| `SMTP_FROM` | 发件地址，缺省取 `SMTP_USERNAME` |
| `PUBLIC_BASE_URL` | 绝对链接的前缀。留空时服务端按 https 推导（第三方登录回调、邮件里的绝对地址都依赖它）；桌面 / localhost 通过 http 访问时必须显式设置 |

找回密码的完整链路：登录页「忘记密码」→ `POST /auth/password-reset/request`
（无论邮箱是否存在都返回 202）→ 邮件里的 `?token=` 打开 `/reset-password` →
`POST /auth/password-reset/confirm` 换新密码，并吊销该账户所有会话。
令牌 30 分钟过期、只能用一次，同一账户 60 秒内只发一封。
管理后台「登录设置 → 邮件通知」可以直接生成这段 `.env`。

> **未设置 `PUBLIC_BASE_URL` 时，服务端会在没有请求上下文的地方按 https 推导绝对链接。**
> 第三方登录回调按站点域名的 `https://` 拼接，通知邮件也依赖它决定能否放入站内链接；
> 桌面模式、本机 `http://localhost` 或其他 http 部署必须显式设置，例如
> `PUBLIC_BASE_URL=http://127.0.0.1:80`（端口换成站点实际端口），否则这些链接会指向
> 不存在的 https 地址。API 启动时会在日志里为此打一条 warning；安装向导最后一步也会
> 给出要粘贴的那一行。

---

## 已知限制

| 项 | 说明 |
| --- | --- |
| MySQL / PostgreSQL | 代码层无方言依赖，但**本机没有这两个数据库，未实跑验证**，需在 CI 上跑矩阵 |
| Docker | 已提供 `docker-compose.yml`（单 API，前端与安全检查内嵌）；已实机构建，compose 栈、注册/登录、上传与备份已跑通（宿主机 TLS 反代未实跑） |
| Linux 安装包 | 发布 `PractacuPress-Linux-{x64,arm64}.tar.gz` 以及各自架构的 `.deb` / `.rpm`（预编译二进制 + `install.sh` 向导 + systemd/Nginx 模板）；交叉编译与包内容已校验，**安装脚本尚未在真实 Linux 主机上实跑**（bash 语法、模板渲染与 `nginx -t` 已通过） |
| Windows 安装包（MSI） | 未实现；Windows 通过 API zip 分发 |
| WebSocket 多副本 | 票据与 hub 在进程内存，多副本部署需要共享存储 |
| 限流 | 进程内固定窗口，多副本下是每副本独立计数；真正的 DDoS/CC 防护需要反向代理或边缘 WAF |
| 浏览器端访问限制 | 只能约束使用本站脚本的访问者；IP 级请求/并发由 Nginx/Cloudflare 配置执行，后台只生成片段 |
| 域名别名 | 服务端按 Host 解析单一站点；别名域名需要反向代理把 Host 改写为主域名（生成片段已包含） |
| S3 上传内存占用 | 受 SigV4 限制需先缓冲，上限等于单文件上限（25 MiB） |
| 邮件 | 已接入找回密码与邮箱验证两种事务邮件；评论回复、审核结果等通知邮件模板尚未接入 |
| SEO | 标签由前端写入 `<head>`；不执行 JS 的抓取器只能看到 `index.html` 的默认值 |
| sitemap / robots | Go API 已按 Host 在站点根路径动态输出 `/sitemap.xml` 与 `/robots.txt`，后台也可下载静态副本；不经 API 的纯静态托管仍需手动放到站点根目录 |
| 未实现 | 前端 SDK 生成、OAuth 适配器、手机验证码、搜索分页游标 |

更细的现状见 [当前实现与文档差异](.github/readme/md/superpowers/reports/2026-11-07-documentation-reality-check.md)。[2026-10-20 交付状态报告](.github/readme/md/superpowers/reports/2026-10-20-delivery-status.md) 保留为历史快照，其中“未实现”清单已不代表当前代码。

---

## 设计文档

- [产品与技术设计](.github/readme/md/superpowers/specs/2026-10-18-practacu-press-design.md)
- [计划评审与可行性](.github/readme/md/superpowers/reviews/2026-10-18-practacu-press-plan-review.md)
- [详细实施计划](.github/readme/md/superpowers/plans/2026-10-18-practacu-press-backend-detailed-plan.md)
- [实施进度](.github/readme/md/superpowers/plans/2026-10-18-practacu-press-progress.md)

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
> 把 `Copyright (C) 2026 <你的名字>` 替换到上面这段、并在 [.github/readme/md/introduction.md](.github/readme/md/introduction.md) 的许可段落同步即可。
