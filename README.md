# Practacu Press

**简体中文**　·　[English](README.en.md)

| 站点前台（默认主题：原版 · 纸白浅色） | 管理后台（仪表盘） |
| :---: | :---: |
| ![站点前台](.github/readme/frontend.png) | ![管理后台](.github/readme/admin.png) |

> 一个自托管的社区型 CMS。Go 写后端，React 写前台和后台；前端构建后嵌进 API 二进制，默认使用 SQLite，部署时跑一个进程就够了。

## 这是什么

Practacu Press 面向想自己托管社区的团队和个人。写文章、发帖子、评论、审核、成员与权限、主题和页面编排都在一套后台里。后端是 Go + Gin + Ent，前端是 React 19 + Vite，两边按同一份 OpenAPI 3.1 契约对接。

Windows 和 Linux 都能部署。源码、Docker、Linux 安装包和 Windows 便携包共用同一套环境变量与 `data/` 目录。架构和取舍放在[完整介绍](.github/readme/md/introduction.md)，英文版在[同一页面下方](.github/readme/md/introduction.md#english)。

写作界面支持 Markdown、实时预览和图文混排，也能插入思维导图、逻辑图、统计图和鱼骨图。社区功能包括评论、点赞、收藏、关注、私信、通知、举报和审核队列。后台可以换主题、编排首页、配置导航与页脚、SEO、访问限制、域名与 SSL、存储策略和访问统计；需要时也能拆成多站点，分别隔离内容、成员和权限。

## 安装

按运行环境选一种。单站点模式下，安装时创建的第一个账户是平台管理员。

### Docker

需要 Docker Engine 和 Compose v2，命令是 `docker compose`。在仓库根目录执行：

```bash
docker compose up -d --build
docker compose ps
curl -fsS http://127.0.0.1:8080/api/healthz
```

打开 **http://localhost:8080**，按八步引导装完。默认只把端口绑到 `127.0.0.1`，免得还没装好的实例被人从公网注册成管理员。数据库和媒体在 `practacu-data` 卷里；`docker compose down` 不会删数据，`down -v` 才会。

装完后按[生产部署文档](.github/readme/md/deployment/production-profile.md)创建 `.env.prod`，再用 `docker compose --env-file .env.prod up -d --build` 切到生产配置，并在前面加一层 TLS 反代。

官方镜像在 Docker Hub 的 `practacupress/press`，启动命令如下：

```bash
PP_IMAGE=practacupress/press:v1.0.0 docker compose pull
PP_IMAGE=practacupress/press:v1.0.0 docker compose up -d
```

### Linux 原生包

服务器上不想装 Go 和 Node，可以直接用发布的原生包。里面是单个 `practacu-press` 二进制、交互式 `install.sh`，以及 systemd 和 Nginx 模板：

```bash
tar -xzf PractacuPress-Linux-<x64|arm64>.tar.gz
cd PractacuPress-Linux-<x64|arm64>
sudo ./install.sh

# 或者装 deb / rpm
sudo apt install ./practacu-press_<version>_<arch>.deb
sudo dnf install ./practacu-press-<version>.<arch>.rpm
```

安装时引导只会监听 `127.0.0.1:8080`。如果服务器不在手边，用 `ssh -L 8080:127.0.0.1:8080 用户@服务器` 转发到本机浏览器完成安装，然后切访问模式：

```bash
sudo /opt/practacu-press/install.sh --finalize --mode lan
sudo /opt/practacu-press/install.sh --finalize --mode public --domain a.com
```

升级、卸载、备份和排障的步骤在 [deploy/linux/INSTALL.md](deploy/linux/INSTALL.md)。

### Windows 便携包

双击 `scripts\启动.bat`。第一次运行会在缺 `web/node_modules` 时自动安装依赖，然后分别打开 API 和 Vite 两个窗口，浏览器地址是 `http://127.0.0.1:5173/?mode=live`。只检查环境运行 `scripts\启动.bat --check`；停止时在 API 窗口按 `Ctrl+C`。

打包便携版时双击 `scripts\打包.bat`，或者执行：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\package.ps1
```

脚本会构建前端、把前端嵌进 Windows API，再在临时端口启动产物自检。通过后生成 `release/PractacuPress/` 和 `release/PractacuPress-Windows-<x64|arm64>.zip`。解压后双击 `启动.cmd`，数据在旁边的 `data/` 里。

### 源码

需要 Go 1.26+、Node.js 22+ 和 Git。下面以 Linux 的 bash 为例，先构建前端、准备环境变量：

```bash
cd web && npm ci && npm run build && cd ../..

cat > ~/.practacu-env.sh <<'EOF'
export APP_ENV=development
export HTTP_ADDR=127.0.0.1:8080
export DATABASE_DRIVER=sqlite
export DATABASE_DSN='file:./data/practacu.db'
export STORAGE_DRIVER=local
export STORAGE_DIR=./data/media
# 单站点自托管；多站点或 SaaS 部署不要打开
export PP_DESKTOP=true
EOF
source ~/.practacu-env.sh
mkdir -p data/media
```

SQLite 文件和默认站点都在第一次启动时自动创建，直接运行：

```bash
go run ./cmd/server
```

`/api/healthz` 和 `/api/readyz` 都返回 200 后，打开 **http://127.0.0.1:8080**。开发前端时改用 `npm run dev -- --port 5173`，安装地址是 `http://127.0.0.1:5173/?mode=live`。直接 `go run` 只提供 API；想看单二进制效果，先执行 `make embed-web`。前端相关说明在 [web/README.md](web/README.md)。

产品版本只写在根目录的 `VERSION`。改版本或检查一致性：

```bash
node scripts/version.mjs set 1.2.0-beta1   # 同步前端清单、npm、OpenAPI 与 Go 常量
node scripts/version.mjs check              # 只检查，不改文件
```

Windows 也可以运行 `scripts/version.ps1 1.2.0-beta1`。

提交信息或 tag 里带版本号（例如 `v1.0.0`、`v1.0.1-beta1`）会触发发布流程，产出 Windows、Linux、macOS 包和多架构 Docker 镜像。细节见[发布文档](.github/readme/md/deployment/releases.md)。

## 中英双语

安装第一步选择简体中文或 English，装完后后台不提供语言开关。语言是站点级设置，前台、后台和提示文案会一起切换，访客不用单独选择。

界面文案的中文原文就是翻译键。`t('站点设置')` 在中文下原样返回，在英文下查字典；英文片段按源文件放在 `web/src/lib/i18n/dict/fragments/*.ts`。文章正文、评论和站长填写的导航文案不翻译。

## 接口示例

装好后直接调 API：

```bash
# 注册，返回 access token
curl -fsS http://127.0.0.1:8080/api/v1/auth/register/email \
  -H 'Content-Type: application/json' \
  -d '{"email":"a@example.com","password":"correct horse battery","display_name":"A"}'

# 公开文章列表，不需要登录
curl -fsS http://127.0.0.1:8080/api/v1/articles
```

运行中的 `/api/v1/docs` 是接口文档，OpenAPI 文件在 `internal/packages/contracts/openapi/openapi.yaml`。

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

## 测试

日常检查用：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\test.ps1
```

浏览器冒烟会自己起一套全新的 API、SQLite 和前端，覆盖安装、登录、草稿与发布、评论、举报和后台设置：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\e2e.ps1
# 截图和报告在 .tmp\e2e\artifacts\
```

需要本机有 Chrome，`web` 目录也要先 `npm install`。更多细节见 [internal/tests/README.md](internal/tests/README.md)。E2E 在 CI 里是可选工作流，不会挡住基础 CI。

## 配置

完整变量清单在 [.env.example](.env.example)。下面几个如果留空或填错，行为会不一样：

| 变量 | 说明 |
| --- | --- |
| `DATABASE_DRIVER` | `sqlite`、`mysql` 或 `postgres`；SQLite 的 pragma 由服务端补 |
| `AUTH_JWT_ED25519_PRIVATE_KEY` | 生产环境必填。开发时缺省会临时生成，并在日志里告警 |
| `TRUSTED_PROXIES` | 留空表示谁都不信，`X-Forwarded-*` 会被忽略 |
| `PUBLIC_BASE_URL` | 绝对链接的前缀。本机用 http 访问时必须显式设置，否则邮件和第三方登录回调会拼成 https |
| `STORAGE_DRIVER` | `local` 或 `s3`；用 S3 还要配 `STORAGE_S3_BUCKET` |
| `SMTP_HOST` | 不配就没有找回密码；配好后密码重置和邮箱验证才能用 |

## TodoList

下面这些事还没做完，按影响面从大到小排。

- [ ] 在 MySQL 和 PostgreSQL 上跑一遍安装、迁移和回归测试；目前只有 SQLite 走完了完整流程。
- [ ] 在真实 Linux 主机上验证 deb / rpm 和 `install.sh`；现在只做了交叉编译和包内容检查。
- [ ] 评估 Windows MSI 安装包；如果不做，就在文档里明确 zip 是 Windows 唯一的预打包安装方式。
- [ ] 为多副本部署补共享 WebSocket 票据和事件总线，并补一份反向代理或 WAF 的限流配置示例。
- [ ] 给 Nginx 和 Cloudflare 补 IP 级访问控制示例；浏览器端限制只覆盖走本站脚本的请求。
- [ ] 把 S3 上传改成流式签名或分片上传，去掉整文件内存缓冲。
- [ ] 补评论回复和审核结果的通知邮件；现有邮件只覆盖找回密码和邮箱验证。
- [ ] 由服务端输出 SEO 标签，或者给不执行 JS 的抓取器提供预渲染快照。

## 许可证

项目使用 AGPL-3.0，全文见 [LICENSE](LICENSE)。商用和修改都允许。分发修改版，或者把它作为网络服务提供给别人时，需要按同一许可证公开修改后的源码，保留版权声明和项目署名。目前没有闭源商业许可。

```text
Practacu Press — 多站点社区型 CMS
Copyright (C) 2026 Practacu Press contributors
SPDX-License-Identifier: AGPL-3.0-only
```
