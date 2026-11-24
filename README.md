# Practacu Press

**简体中文**　·　[English](README.en.md)

| 站点前台（默认主题：原版 · 纸白浅色） | 管理后台（仪表盘） |
| :---: | :---: |
| ![站点前台](.github/readme/frontend.png) | ![管理后台](.github/readme/admin.png) |

> **自托管的社区型 CMS：占地少、跑得快、开箱即用、想怎么改就怎么改。**
> Go API（内嵌前端与安全检查）+ React 前台与后台，由同一份 OpenAPI 3.1 契约对齐；
> Windows 与 Linux 都是一等公民，源码、容器、Linux 原生包与 Windows 便携包共用一套配置。

## 为什么是它

- **一个进程就够**：Go API 内嵌整套前端与安全检查，SQLite 数据库就是一个文件；默认部署只有一个 API 容器，运行时不依赖 Node。
- **装完即用**：八步安装引导自带健康检查，`docker compose up -d` 或 Windows 便携包一条命令起全栈；备份只需复制 `data/`。
- **可定制**：2 套大主题 + 7 套配色，主题可导入导出；页面编排支持桌面 / 平板 / 手机三端独立布局，写作可插入思维导图、逻辑图、统计图与鱼骨图。
- **开放**：所有能力都通过 REST（OpenAPI 3.1）与 WebSocket 暴露，想换前端按契约接入即可；数据库支持 SQLite、MySQL、PostgreSQL。

**功能面**：写作与 Markdown、评论 / 点赞 / 收藏 / 关注 / 私信 / 通知 / 举报与审核流、主题与页面编排、SEO、访问限制、域名与 SSL、存储策略、访问统计、扩展系统、站点更新、多站点隔离。

完整介绍（架构、技术栈与工程取舍）见 **[.github/readme/md/introduction.md](.github/readme/md/introduction.md)**　·　English: **[Introduction](.github/readme/md/introduction.md#english)**

---

## 安装

四种方式任选：**Docker**（Linux / 服务器推荐）、**Linux 原生包**、**Windows 便携包**（本机最省事）、**源码**。所有方式共用同一套配置；首个安装账户即平台管理员。

### Docker（Linux / 服务器）

需要 Docker Engine 与 Compose v2（命令是 `docker compose`）。在仓库根目录：

```bash
docker compose up -d --build
docker compose ps
curl -fsS http://127.0.0.1:8080/api/healthz
```

打开 **http://localhost:8080** 走完八步安装引导。默认只绑定 `127.0.0.1`，避免未装完的实例被公网抢先注册；数据库与媒体在命名卷 `practacu-data`，`docker compose down` 不删数据。

生产部署用 `--env-file .env.prod` 切生产语义与持久密钥，并在前面加 TLS 反代；步骤见 [生产部署文档](.github/readme/md/deployment/production-profile.md)。发布镜像可直接运行：

```bash
PP_IMAGE=practacupress/press:v1.0.0 docker compose pull
PP_IMAGE=practacupress/press:v1.0.0 docker compose up -d
```

### Linux 原生包（tar.gz / deb / rpm）

包里是单个 `practacu-press` 二进制、交互式 `install.sh` 与 systemd / Nginx 模板，目标机不需要 Go / Node：

```bash
tar -xzf PractacuPress-Linux-<x64|arm64>.tar.gz
cd PractacuPress-Linux-<x64|arm64>
sudo ./install.sh

# 或直接安装 .deb / .rpm
sudo apt install ./practacu-press_<version>_<arch>.deb
sudo dnf install ./practacu-press-<version>.<arch>.rpm
```

安装后引导只监听 `127.0.0.1:8080`，远程服务器用 `ssh -L 8080:127.0.0.1:8080 用户@服务器` 打开；装完后切访问形态：

```bash
sudo /opt/practacu-press/install.sh --finalize --mode lan
sudo /opt/practacu-press/install.sh --finalize --mode public --domain a.com
```

完整步骤（含升级、卸载、备份与排障）见 [deploy/linux/INSTALL.md](deploy/linux/INSTALL.md)。

### Windows 便携包

仓库根目录运行 `启动.bat`：自动准备依赖，启动 Go API 与 SQLite，并在 `http://127.0.0.1:5173/?mode=live` 打开前端。只检查环境用 `启动.bat --check`。停止时在 API 窗口按 `Ctrl+C`。

打包 Windows 便携包：

```powershell
# 双击仓库根目录的 打包.bat，或者：
powershell -ExecutionPolicy Bypass -File scripts\package.ps1
```

脚本会构建前端、编译内嵌前端的 Windows API、组装启动文件，并在临时端口实际启动产物做自检；通过后输出 `release/PractacuPress/` 与 `release/PractacuPress-Windows-<x64|arm64>.zip`。解压后双击 `启动.cmd` 或运行 `PractacuPress.exe`，数据在同目录 `data/`。

### 源码运行

需要 **Go 1.26+**、**Node.js 22+**、Git；安全检查已编译进 API，无需额外服务。

```bash
cd web && npm ci && npm run build && cd ../..

cat > ~/.practacu-env.sh <<'EOF'
export APP_ENV=development
export HTTP_ADDR=127.0.0.1:8080
export DATABASE_DRIVER=sqlite
export DATABASE_DSN='file:./data/practacu.db'
export STORAGE_DRIVER=local
export STORAGE_DIR=./data/media
export PP_DESKTOP=true
EOF
source ~/.practacu-env.sh
mkdir -p data/media

go run ./cmd/server seed -driver sqlite -dsn "$DATABASE_DSN"
go run ./cmd/server
```

确认就绪后打开 **http://127.0.0.1:8080**；`/api/healthz` 与 `/api/readyz` 都返回 200 即正常。前端开发服务器用 `npm run dev -- --port 5173`，安装地址是 `http://127.0.0.1:5173/?mode=live`。源码直接 `go run` 只提供 API；要验证单二进制形态，先 `make embed-web`。更多细节见 [web/README.md](web/README.md)。

> **发布**：提交信息或 tag 带版本号（如 `v1.0.0`、`v1.0.1-beta1`）会触发 CI，生成 Windows / Linux / macOS 包、`SHA256SUMS` 与多架构 Docker 镜像。说明见 [发布文档](.github/readme/md/deployment/releases.md)。

---

## 中英双语

站点可在**简体中文 ↔ English** 之间切换，但只在安装引导第一步选择一次；语言是站点级设置，前台、后台与提示文案一起切换，访客不需要单独选择。

实现上中文原文就是翻译键：`t('站点设置')` 在中文下原样返回，在英文下查字典；英文片段按源文件放在 `web/src/lib/i18n/dict/fragments/*.ts`。文章正文、评论与站长填写的导航文案不翻译。

---

## 快速验证

```bash
# 注册并拿到 access token
curl -fsS http://127.0.0.1:8080/api/v1/auth/register/email \
  -H 'Content-Type: application/json' \
  -d '{"email":"a@example.com","password":"correct horse battery","display_name":"A"}'

# 公开文章列表（无需登录）
curl -fsS http://127.0.0.1:8080/api/v1/articles
```

更多接口见运行中的 `/api/v1/docs` 或 `internal/packages/contracts/openapi/openapi.yaml`。

---

## 目录结构

```
cmd/{server,migrate,seed,backup,media-gc,searchindex}  进程入口与运维命令
internal/
  auth/ site/ content/ community/ messaging/            业务模块
  notifications/ moderation/ media/ outbox/             通知、审核、媒体与事件补偿
  platform/ infrastructure/ security/                   配置、仓储、Argon2id 与内容清洗
  transport/{http/gin,ws}                               HTTP 中间件与 WebSocket
  web/ packages/contracts/                              内嵌前端与 OpenAPI 契约
  migrations/ tests/ plugins/                           变更集、测试与插件宿主
web/                                                    React 前台、管理后台与安装引导
scripts/                                                dev / test / gen / package 脚本
```

---

## 测试

```powershell
powershell -ExecutionPolicy Bypass -File scripts\test.ps1   # go build + vet + test
```

真实浏览器冒烟（自动起 API、全新 SQLite 与前端，覆盖安装、登录、草稿/发布、评论、后台设置等）：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\e2e.ps1
# 报告与截图：.tmp\e2e\artifacts\
```

前置：Chrome、`web` 已 `npm install`。细节见 [internal/tests/README.md](internal/tests/README.md)；E2E 是独立可选工作流，不阻塞基础 CI。

---

## 配置

完整变量见 [.env.example](.env.example)。容易踩的点：

| 变量 | 说明 |
| --- | --- |
| `DATABASE_DRIVER` | `sqlite` / `mysql` / `postgres`；SQLite pragma 由服务端自动补 |
| `AUTH_JWT_ED25519_PRIVATE_KEY` | 生产必填；开发环境缺省会生成临时密钥并告警 |
| `TRUSTED_PROXIES` | 留空表示不信任任何代理，`X-Forwarded-*` 全被忽略 |
| `PUBLIC_BASE_URL` | 绝对链接前缀；桌面 / localhost 的 http 部署必须显式设置，否则回调与邮件链接会指向 https |
| `STORAGE_DRIVER` | `local` 或 `s3`；S3 需要 `STORAGE_S3_BUCKET` |
| `SMTP_HOST` | 留空即关闭找回密码；配置后密码重置与邮箱验证才可用 |

---

## 已知限制

- **MySQL / PostgreSQL**：代码层无方言依赖，但尚未实跑验证。
- **Linux 安装包**：已交叉编译并校验包内容，安装脚本尚未在真实 Linux 主机上实跑。
- **Windows MSI**：未实现，发行方式为 API zip。
- **多副本**：WebSocket 票据与 hub、限流都在进程内存，多副本需要共享存储与边缘限流。
- **浏览器端访问限制**：只能约束使用本站脚本的访问者；IP 级防护需 Nginx / Cloudflare / WAF。
- **S3 上传**：受 SigV4 限制需先缓冲，内存上限等于单文件上限。
- **邮件**：已接入找回密码与邮箱验证；评论回复、审核结果等通知邮件尚未接入。
- **SEO**：标签由前端写入 `<head>`，不执行 JS 的抓取器只能看到 `index.html` 默认值。

---

## 文档与许可

- [产品与技术设计](.github/readme/md/superpowers/specs/2026-10-18-practacu-press-design.md)
- [计划评审与可行性](.github/readme/md/superpowers/reviews/2026-10-18-practacu-press-plan-review.md)
- [详细实施计划](.github/readme/md/superpowers/plans/2026-10-18-practacu-press-backend-detailed-plan.md)
- [实施进度](.github/readme/md/superpowers/plans/2026-10-18-practacu-press-progress.md)
- [部署](.github/readme/md/deployment/production-profile.md)　·　[安全审计](.github/readme/md/security/2026-11-14-security-audit.md)

本项目以 **AGPL-3.0** 发布，全文见 [LICENSE](LICENSE)：可商用、可修改、可自建服务；分发修改版或作为网络服务提供时必须公开修改后的完整源码，并保留版权与项目署名。暂不提供闭源商业双许可。

```text
Practacu Press — 多站点社区型 CMS
Copyright (C) 2026 Practacu Press contributors
SPDX-License-Identifier: AGPL-3.0-only
```
