# 生产部署 profile（Docker Compose + TLS 反代）

这份文档把仓库从「本机零配置安装」推进到「公网 HTTPS 生产形态」：持久 JWT 私钥、
production 语义、Secure Cookie、TLS 终止、安全响应头，以及首次安装的先后顺序。

对应攻击模拟报告中的：

| 编号 | 问题 | 本仓库的处置 |
| --- | --- | --- |
| V-17 | `docker-compose.yml` 默认是开发形态 | 新增 `docker-compose.prod.yml`（production 语义 + 持久私钥 + Secure Cookie）、宿主机 TLS 反代模板 `deploy/production/nginx.conf` |
| V-05 | 静态站没有 CSP/XFO/Referrer-Policy/Permissions-Policy/HSTS | API 中间件对每个响应加安全头，启动器 `apps/launcher/main.go` 与宿主机 TLS 模板各一份（TLS 层补 HSTS）；可选静态站镜像沿用 `deploy/docker/nginx.conf` |
| V-04 | 同机反代可绕过启动器回环校验改端口/读信息 | `/__pp/*` 现在要求「TCP 对端回环 **且** Host 回环」；反代模板显式 `location /__pp/ { return 404; }`；`/__pp/runtime` 只返回页面必需字段 |
| V-18 | 启动器明文保存 JWT 私钥 | Windows 上用 DPAPI `CryptProtectData` 加密后写 `practacu-web.json`（`dpapi:` 前缀），旧明文文件读取时兼容并在下次写盘迁移 |

> **验证状态**：默认 API（内嵌前端）与 security 镜像已在本机 Docker 中实际构建并起栈验证
> （两个服务 healthy，`/healthz`、`/readyz`、`/api/v1/setup/status`、RSS/Atom/sitemap/robots、
> 首个管理员注册、登录、媒体上传与整库备份均跑通），`docker compose config` 通过。
> 宿主机 TLS 反代模板仍建议按 §7 在预发环境走一遍证书与 HSTS 检查。

---

## 1. 目标架构

```
浏览器 ──443/TLS──▶ 宿主机 Nginx（deploy/production/nginx.conf）
                          │  proxy_pass http://127.0.0.1:8080
                          ▼
                 compose api 容器（Go API + go:embed 内嵌前端，SQLite /data/practacu.db）
                          │  内部网络 172.28.0.0/16
                          ▼
                 compose security 容器（Rust gRPC：Argon2id / HTML 清洗 / 上传检查）
```

- 只有宿主机 Nginx 监听公网 443；API 端口保持 `127.0.0.1:8080:8080`。
- api 与 security 不发布到宿主机，只在 compose 内部网络可达。
- 前端已编入 API 二进制，默认不再需要 `web` 容器；需要独立静态 Nginx 时才用
  `docker compose --profile static up -d`（端口 `PP_STATIC_PORT`，默认 8081）。
- 备份对象是命名卷 `practacu-data`（数据库 + 媒体）与 `.env.prod`（含签名私钥）。

## 2. 前置条件

- Linux 服务器，Docker Engine + Docker Compose v2（`docker compose version`）。
- 一个已把 A/AAAA 记录指向服务器的域名（示例用 `press.example.com`）。
- 宿主机 Nginx（≥ 1.25.1，或把模板里的 `http2 on;` 改成 `listen 443 ssl http2;`）
  与 certbot（或其他 ACME 客户端）。

## 3. 首次安装（两阶段，顺序不能反）

**为什么要两阶段：** 生产语义与「首个注册即管理员」的零配置引导互斥——
`APP_ENV=production` 与 `PP_DESKTOP=true` 组合会在 API 启动期被拒绝
（`invalid_desktop_mode`）；而没有 `PP_DESKTOP` 时，产品没有其他创建首个管理员的
HTTP 入口。此外生产模式下单站点没有域名时只接受公网 IP 字面量，`localhost` 会被
判为 `site_not_found`。所以：**先在回环上完成安装和域名设置，再切生产语义。**

### 阶段 A：本机装好管理员与域名

```bash
# 1) 默认 compose（development + PP_DESKTOP=true），API 只绑 127.0.0.1:8080
docker compose up -d --build

# 2) 在这台服务器上用浏览器打开 http://localhost:8080
#    （或 SSH 隧道：ssh -L 8080:127.0.0.1:8080 user@server）
```

在八步安装引导里：

1. 第一个注册的账号会自动成为 `platform_admin`（这是桌面/单站点形态的设计）。
2. **站点设置 → 域名** 填 `press.example.com`（生产按 Host 解析站点；切生产后
   `localhost` 不再可用）。
3. 同时设好站点名、发布模式、是否开放注册等业务设置。

```bash
# 3) 用与生产一致的 Host 验证站点已就绪
curl -fsS -H 'Host: press.example.com' http://127.0.0.1:8080/healthz
curl -fsS -H 'Host: press.example.com' http://127.0.0.1:8080/api/v1/setup/status
# -> "has_admin":true
```

> ⚠️ 这一阶段**不要**把 8080 暴露到公网：未安装完的实例谁先注册谁是管理员（V-16）。
> 默认端口映射 `127.0.0.1:8080:8080` 就是为此而设，安装完成前请保持原样。
>
> 阶段 A 是 **http** 访问：未设置 `PUBLIC_BASE_URL` 时，服务端在没有请求上下文的地方
> 按 https 推导绝对链接。要在这个阶段测试通知邮件或第三方登录，请先在 API 环境里
> 显式设置 `PUBLIC_BASE_URL=http://localhost:8080`；切到生产 profile 后再改成
> `https://press.example.com`。API 启动日志与安装引导最后一步都会提示这一点。

### 阶段 B：切到生产 profile

```bash
# 1) 环境文件（含签名私钥，权限收紧）
cp deploy/production/env.prod.example .env.prod
chmod 600 .env.prod
# 按 §4 生成 AUTH_JWT_ED25519_PRIVATE_KEY 填进去，并把 PUBLIC_BASE_URL 改成 https 域名
# PUBLIC_BASE_URL 必须是浏览器实际访问的地址；桌面 / localhost 的 http 部署写成
# http://127.0.0.1:<端口>。未设置时服务端会假定 https。

# 2) 用叠加文件启动：生产语义 + 持久私钥 + Secure Cookie
docker compose -f docker-compose.yml -f docker-compose.prod.yml \
  --env-file .env.prod up -d --build

# 3) 容器健康检查
docker compose -f docker-compose.yml -f docker-compose.prod.yml ps
docker compose -f docker-compose.yml -f docker-compose.prod.yml logs -f api
```

切换后**旧会话会失效**（阶段 A 的 API 用临时密钥；换到持久私钥后旧 token 无法
验签），重新登录即可。想避免这次登出，可以在阶段 A 就把 `.env.prod` 里的同一个
密钥通过环境变量传给 api——但首次安装时通常还没生成，按「重新登录一次」处理更简单。

### 阶段 C：宿主机 TLS 反代

```bash
# 1) 安装模板并改域名/证书路径
sudo cp deploy/production/nginx.conf /etc/nginx/conf.d/practacu-press.conf
sudo sed -i 's/press\.example\.com/你的域名/g' /etc/nginx/conf.d/practacu-press.conf

# 2) 申请证书（模板已给 HTTP-01 挑战留出 /.well-known/acme-challenge/）
sudo certbot certonly --webroot -w /var/www/certbot -d 你的域名
sudo mkdir -p /var/www/certbot

# 3) 语法检查后重载
sudo nginx -t && sudo systemctl reload nginx
```

## 4. 生成 Ed25519 签名私钥

需要 **base64 编码的 PKCS#8 Ed25519 私钥（单行）**，三种方式任选。

**Go**（与启动器 `apps/launcher/state.go` 的生成逻辑一致；保存为 `genkey.go` 后
`go run genkey.go`）：

```go
package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"fmt"
)

func main() {
	_, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		panic(err)
	}
	der, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		panic(err)
	}
	fmt.Println(base64.StdEncoding.EncodeToString(der))
}
```

**OpenSSL（Linux / macOS / Git Bash）**：

```bash
openssl genpkey -algorithm ED25519 -out jwt_keys.pem
openssl pkey -in jwt_keys.pem -outform DER -out jwt_key.der
base64 -w0 jwt_key.der; echo
```

**PowerShell（Windows，需要 OpenSSL 在 PATH 中）**：

```powershell
openssl genpkey -algorithm ED25519 -out jwt_keys.pem
openssl pkey -in jwt_keys.pem -outform DER -out jwt_key.der
[Convert]::ToBase64String([IO.File]::ReadAllBytes('jwt_key.der'))
```

把输出填进 `.env.prod` 的 `AUTH_JWT_ED25519_PRIVATE_KEY=`。同一份密钥也可以直接给
Windows 启动器形态使用（`.env.prod` 与启动器不共用文件系统，手动填入各自环境）。

> 密钥轮换 = 全员强制重新登录。生成后请纳入密码管理器/受控备份；
> 泄露即等于可以伪造任意角色 token。

## 4.1 静态数据加密密钥（生产必填）

生产 profile 强制要求两把独立的 32 字节 AES-256 密钥，各自解决一类泄露：

| 变量 | 保护对象 | 密钥放哪 | 丢失/轮换后果 |
| --- | --- | --- | --- |
| `FIELD_ENCRYPTION_KEY` | 登录邮箱、手机号、私信正文（数据库字段级） | 必须在服务器环境里，API 要在线使用 | 丢失 = 这些字段无法解密；轮换 = 先解密再重新加密全部数据 |
| `BACKUP_ENCRYPTION_KEY` | 整库备份包 `.ppbak` | 可以离线保管，只需在创建/恢复备份时提供 | 丢失 = 已有备份作废，无法恢复 |

生成（两把分别生成，不要相同）：

```bash
openssl rand -base64 32   # FIELD_ENCRYPTION_KEY
openssl rand -base64 32   # BACKUP_ENCRYPTION_KEY
```

填进 `.env.prod`。`APP_ENV=production` 时缺失任一变量会在启动期直接失败，
不会静默写明文。`docker-compose.prod.yml` 已用 `:?` 语法要求两者存在。

升级已有部署时注意**顺序**：先在旧版本上创建一份明文备份 → 填入两把密钥并升级
→ 新版本启动时会把历史明文行（邮箱、私信）自动加密并记录日志
（`sealed legacy identity addresses` / `sealed legacy private messages`）。
历史备份仍可用旧方式恢复，但建议升级后重新创建一份加密备份。

## 5. 部署文件清单

| 文件 | 作用 |
| --- | --- |
| `docker-compose.yml` | 基础栈：security / api（内嵌前端）、内部网络、命名卷、健康检查（开发引导形态）；web 为可选 static profile |
| `docker-compose.prod.yml` | 叠加文件：`APP_ENV=production`、`PP_DESKTOP=false`、持久 JWT 私钥必填、`COOKIE_SECURE=true`、`TRUSTED_PROXIES=172.28.0.0/16`、限流、日志轮转 |
| `deploy/production/env.prod.example` | `.env.prod` 模板（私钥、PUBLIC_BASE_URL、限流、可选 SMTP） |
| `deploy/production/nginx.conf` | 宿主机 TLS 终止模板：HSTS、CSP/XFO/Referrer/Permissions/nosniff、`/__pp/` 404、`server_tokens off`、真实 IP 覆盖 |
| `deploy/docker/nginx.conf` | 可选 `web` profile 的容器内 Nginx：静态站 + `/api` 反代，同样带安全头并拒绝 `/__pp/` |

`docker-compose.prod.yml` 是**叠加文件**，不要单独用 `docker compose -f
docker-compose.prod.yml up`（那样缺服务定义）。可以把它写进 shell 环境省掉重复参数：

```bash
export COMPOSE_FILE=docker-compose.yml:docker-compose.prod.yml
export COMPOSE_ENV_FILES=.env.prod   # Compose v2.24+；或继续显式 --env-file
```

## 6. 备份与恢复

备份对象：命名卷 `practacu-data`（`practacu.db` + `media/`）与 `.env.prod`。
卷的实际名字是 `<项目名>_practacu-data`，默认项目名 `practacu-press`。

> 生产 profile 下，后台创建/下载的整库备份是 **`.ppbak` 加密包**（AES-256-GCM
> 分块流式加密），不是可直接解压的 zip。下面这种卷级 `tar` 备份**不加密**，
> 只是在加密包之外用来搬整份卷；更推荐用后台/`backup` CLI 创建 `.ppbak`，
> 把加密包和 `BACKUP_ENCRYPTION_KEY` 分开保管。

```bash
# 备份（先停 api 写入，SQLite 更干净；停写期间站点不可用）
docker compose -f docker-compose.yml -f docker-compose.prod.yml stop api
docker run --rm \
  -v practacu-press_practacu-data:/data:ro \
  -v "$PWD/backup:/backup" \
  alpine sh -c 'tar czf /backup/practacu-data-$(date +%F-%H%M).tar.gz -C /data .'
docker compose -f docker-compose.yml -f docker-compose.prod.yml start api

# 备份文件与 .env.prod 分开保管；两者都视同口令
```

恢复：

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml down
docker volume create practacu-press_practacu-data
docker run --rm \
  -v practacu-press_practacu-data:/data \
  -v "$PWD/backup:/backup" \
  alpine sh -c 'rm -rf /data/* && tar xzf /backup/practacu-data-YYYY-MM-DD-HHMM.tar.gz -C /data'
# 放回 .env.prod（或重新生成密钥，代价是全员重新登录）
docker compose -f docker-compose.yml -f docker-compose.prod.yml --env-file .env.prod up -d
```

## 7. 上线检查清单

```bash
# 容器健康
docker compose -f docker-compose.yml -f docker-compose.prod.yml ps

# API 自身健康（回环，绕过 TLS）
curl -fsS -H 'Host: press.example.com' http://127.0.0.1:8080/healthz
curl -fsS -H 'Host: press.example.com' http://127.0.0.1:8080/readyz

# 经公网 TLS 的页面与安全头
curl -sSI https://press.example.com/ | grep -Ei 'strict-transport|content-security|x-frame|referrer|permissions|x-content-type'
# 期望：HSTS、CSP、X-Frame-Options: SAMEORIGIN、Referrer-Policy、
#       Permissions-Policy、X-Content-Type-Options: nosniff
# CSP 里的 frame-src 必须含 'self'：管理后台的「页面编排」用同源 iframe 预览真实前台，
# 缺了它编辑器只会显示浏览器的「此内容已被屏蔽」。

# 控制面必须不可达
curl -sS -o /dev/null -w '%{http_code}\n' https://press.example.com/__pp/runtime   # 期望 404
curl -sS -o /dev/null -w '%{http_code}\n' https://press.example.com/__pp/state/x   # 期望 404

# 安装状态与登录冒烟
curl -fsS -H 'Host: press.example.com' https://press.example.com/api/v1/setup/status
```

- 确认 `docker compose ... ps` 里 api / security 都是 `healthy`（启用 static profile 时 web 也应为 healthy）。
- 用浏览器登录后台，确认 Cookie 带 `Secure`（开发者工具 → Application → Cookies）。
- 确认站点设置里域名与 `PUBLIC_BASE_URL` 一致；`PUBLIC_BASE_URL` 必须是浏览器实际
  访问的地址（生产是 `https://` 域名，桌面 / localhost 是 `http://127.0.0.1:<端口>`）。
- 生产建议在后台关闭公开注册或开启审核（产品设置，非配置文件）。

## 8. 升级

```bash
# 1) 先备份（见 §6）
# 2) 拉取新代码后重建镜像并滚动重启
docker compose -f docker-compose.yml -f docker-compose.prod.yml \
  --env-file .env.prod up -d --build

# 3) 如有 schema 变更，显式执行迁移（镜像内自带 migrate/seed 命令）
docker compose -f docker-compose.yml -f docker-compose.prod.yml exec api migrate

# 4) 看日志与健康
docker compose -f docker-compose.yml -f docker-compose.prod.yml logs -f api
```

- `.env.prod` 里的 `AUTH_JWT_ED25519_PRIVATE_KEY` **不要随升级更换**，否则全员被登出。
- 证书续期：`certbot renew` 后 `systemctl reload nginx`（建议挂 timer）。
- 回滚：切回上一个镜像 tag / 恢复备份卷；如果新版本改过 schema，回滚代码前先确认
  旧版本能读新 schema（`schema.WithDropColumn(false)` 只加不删，通常可回退）。

## 9. 多站点 / SaaS 形态

当前版本的「单站点 + 桌面引导」与「多站点生产」是两条路径。本 profile 走
`PP_DESKTOP=false`：**没有**任何 HTTP 接口创建第一个站点或管理员，需要运维预置：

1. 用 `docker compose ... exec api seed -slug main -name "站点名"` 建站点；
2. 多租户的成员/管理员预置目前需要数据库运维或后续版本的管理控制台支持；
3. 若只是单站点自托管，**推荐按 §3 的两阶段流程**，不要打开 `PP_DESKTOP` 上生产。

## 10. Windows 启动器形态的加固（V-04 / V-18）

- **签名私钥**：`practacu-web.json` 里的 `jwt_key` 现在是 DPAPI 密文
  （`dpapi:` 前缀），只有写入它的 Windows 用户能解密。旧版本留下的明文
  `base64` 私钥仍可读取，并在下一次写盘时自动迁移为密文。
  - 换 Windows 用户、重装系统或拷贝到另一台机器后无法解密 → 启动器会生成新密钥，
    所有已登录会话失效，需要重新登录。
  - 备份/分发安装目录时仍建议排除 `practacu-web.json`（虽然已是密文，但仍可被
    同一用户解密）。
- **安装目录 ACL**：DPAPI 之外建议把安装目录收紧为当前用户与 SYSTEM 可读：
  `icacls "安装目录" /inheritance:r /grant:r "%USERNAME%:(OI)(CI)F" /grant:r "SYSTEM:(OI)(CI)F"`
  （执行前确认目录归属；这不在启动器代码里自动做）。
- **不要把启动器端口反代到公网**。如果必须放在同机 Nginx 后面：
  - 反代必须显式 `location /__pp/ { return 404; }`（`deploy/production/nginx.conf`
    已包含）；**这是唯一可靠的边界**，原因见下面第 4 条；
  - 启动器自身已经要求 `/__pp/*` 的 TCP 对端与 Host 都是回环，非回环 Host 一律
    403 `permission_denied`；
  - 带 `X-Forwarded-For` / `X-Forwarded-Host` / `X-Forwarded-Proto` / `X-Real-IP` /
    `Forwarded` 的请求也会被拒绝——反代通常会加这些头，而本机浏览器不会；
  - `/__pp/runtime` 只返回 `mode/runtime_mode/name/port/origin/dist_ready/api`，
    不再暴露安装路径、日志路径、内部 API 地址与 PID。
  - **残余风险（必须知道）**：如果反代既把 Host 改写成 `127.0.0.1:端口`、又
    不添加任何转发头（例如最裸的 `proxy_pass http://127.0.0.1:8080;`：
    默认 Host 是 `$proxy_host`，默认不加 `X-Forwarded-*`），启动器在协议层无法
    区分它和本机浏览器。因此生产反代**必须**按模板写
    `location /__pp/ { return 404; }`，只在启动器代码里做校验不足以覆盖所有反代配置。

## 11. 未验证项与已知限制

- **宿主机 TLS 反代未实跑**：容器栈与 `deploy/docker/nginx.conf` 已实际构建、启动并
  用 `nginx -t` 验证；`deploy/production/nginx.conf` 仍只做了语法与逐行核对，证书
  路径、HSTS 与真实客户端 IP 请在预发环境验证。
- **Docker 单主机首管理员**：端口映射会隐藏客户端地址，默认 compose 用
  `PP_FIRST_ADMIN_TRUST_PROXY=1` 放宽首个管理员判定（只检查 Host 回环）。这个开关
  只在 `api` 端口绑定 `127.0.0.1` 时安全；完成安装后可设为 `0`，生产 overlay 已显式
  关闭。不要把未完成安装的实例暴露到公网。
- **Nginx 版本**：模板使用 `http2 on;`（nginx ≥ 1.25.1）；容器镜像固定
  `nginx:1.29.8-alpine`。升级镜像时保留 ≥ 1.27.3，`proxy_pass` 的动态上游解析
  （`server api:8080 resolve`）依赖该版本。
- **HSTS 不可逆**：确认全站 HTTPS 长期可用后再考虑 `preload`；模板只给一年、
  不含 `preload`。
- **限流**：应用内是进程内固定窗口，多副本各自计数；公网部署建议在宿主机 Nginx
  再加 `limit_req` / 边缘 WAF。
- **本 profile 未改变应用代码**：内容安全、媒体授权等产品级问题见
  `docs/audit/2026-11-02-attack-simulation.md` 的对应条目。
