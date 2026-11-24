# Practacu Press · Linux 安装引导

这是 `PractacuPress-Linux-x64.tar.gz` / `PractacuPress-Linux-arm64.tar.gz` 里的安装说明。
目标是一台 x86_64 或 aarch64 的 Linux 服务器（systemd 发行版，Debian / Ubuntu /
RHEL / Rocky / Alma / Fedora / openSUSE 等）用两条命令跑起来：

1. `sudo ./install.sh` —— 装程序、建数据库、起服务，**只监听本机回环**；
2. 在浏览器里走完产品自带的八步安装引导，创建第一个账户（平台管理员）；
3. `sudo ./install.sh --finalize ...` —— 按需要切成「内网 HTTP」或「公网 HTTPS」。

> 第 2、3 步分开不是安装器多事：产品规定**首个管理员只能在回环地址上注册**
> （防止未装完的实例被公网抢先注册成管理员），并且 `APP_ENV=production` 与
> `PP_DESKTOP=true` 互斥。安装器必须遵循这两条规则。

---

## 1. 包内容

```
PractacuPress-Linux-<x64|arm64>/
├── install.sh                 安装 / 升级 / 切换形态的向导
├── uninstall.sh               卸载（默认保留数据）
├── INSTALL.md                 本文件
├── README.txt                 一页快速上手
├── VERSION
├── ARCH                       本包的架构（amd64 / arm64）
├── bin/
│   ├── practacu-press           Go API（内嵌前端静态文件 + SQLite 驱动）
│   ├── practacu-migrate       只应用数据库结构（升级/排障用）
│   ├── practacu-seed          建表 + 创建默认站点（幂等）
│   ├── practacu-backup        整库备份 / 恢复 / 校验
│   ├── practacu-media-gc      清理无引用的媒体对象
│   ├── practacu-searchindex   重建全文搜索索引
└── deploy/
    ├── systemd/*.service.in   systemd 单元模板（安装器渲染后写入 /etc/systemd/system）
    └── nginx/*.conf.in        Nginx 站点模板（安装器渲染后写入 /etc/nginx）
```

包里的程序都是 **对应架构的 Linux 二进制**，目标机不需要安装
Go / Node，也不需要 Docker。

## 2. 前置条件

| 要求 | 说明 |
| --- | --- |
| Linux x86_64 / aarch64 | `uname -m` 应为 `x86_64` 或 `aarch64`；安装器会核对包里的 `ARCH`。 |
| systemd | 安装器用 systemd 管理两个服务。容器环境请改用 Docker Compose。 |
| root | 安装、切形态、卸载都需要 `sudo`。 |
| curl、openssl | 缺失时安装器会尝试用 apt / dnf / yum / zypper / pacman 自动安装。 |
| Nginx | TLS、域名与边缘反向代理需要它；缺失时安装器会提示并尝试自动安装。也可以 `--no-nginx` 自备反代。 |
| 域名 + 证书（可选） | 只有「公网 HTTPS」形态需要。内网 / 单机形态不需要域名。 |

服务器最低配置：1 核 / 1 GB 内存 / 1 GB 磁盘可跑；上传与备份占空间时按需加盘。

### 2.1 .deb / .rpm 安装（可选）

发布页同时提供 Debian/Ubuntu 的 `.deb` 与 RHEL/Fedora/openSUSE 的 `.rpm`
（`amd64` / `arm64` 各自独立）。包内是同一套 `/usr/lib/practacu-press` 便携树，
安装后会自动执行一次非交互安装（创建服务用户、数据目录、systemd、Nginx 与密钥）：

```bash
sudo apt install ./practacu-press_<version>_<arch>.deb
# 或
sudo dnf install ./practacu-press-<version>.<arch>.rpm
```

包依赖 `nginx`、`curl`、`openssl`、`ca-certificates`。卸载会停止服务并保留
`/var/lib/practacu-press` 与 `/etc/practacu-press`；彻底删除请再用安装目录里的
`uninstall.sh --purge`。容器或非 systemd 环境请使用 tar.gz + 手动命令或 Docker。

## 3. 快速开始（推荐流程）

### 3.1 解压并运行安装向导

```bash
tar -xzf PractacuPress-Linux-<x64|arm64>.tar.gz
cd PractacuPress-Linux-<x64|arm64>
sudo ./install.sh
```

> 如果提示 `Permission denied`（某些解压工具丢了可执行位），改用
> `sudo bash ./install.sh`。

向导会依次询问（直接回车使用括号里的默认值）：

| 问题 | 默认 | 说明 |
| --- | --- | --- |
| 程序目录 | `/opt/practacu-press` | 二进制、前端与模板 |
| 数据目录 | `/var/lib/practacu-press` | SQLite、上传文件、备份；**备份就是复制它** |
| 系统用户 | `practacu` | 服务以这个用户运行 |
| API 回环端口 | `8081` | 只监听 127.0.0.1，不对外 |
| 安装引导端口 | `8080` | 只监听 127.0.0.1，装完后由 `--finalize` 接管 |
| 是否安装/配置 Nginx | 是 | 选 n 则你需要自己把 `/` 与 `/api` 反代到 API 端口 |

非交互安装（全部用默认值）：

```bash
sudo ./install.sh --yes
```

安装器会自动完成：创建系统用户与目录、生成 Ed25519 签名私钥、写
`/etc/practacu-press/practacu.env`、注册并启动 `practacu-press`、
应用数据库结构并创建默认站点、写好 Nginx 配置。

### 3.2 打开安装引导（关键一步）

安装引导阶段 Nginx **只监听 `127.0.0.1:8080`**，所以：

- 服务器本机有桌面环境：直接打开 <http://127.0.0.1:8080>
- 远程服务器：在你自己的电脑上开 SSH 隧道，再打开本地地址：

  ```bash
  ssh -L 8080:127.0.0.1:8080 你的用户@服务器地址
  # 然后浏览器打开 http://127.0.0.1:8080
  ```

在产品自带的八步引导里：

1. 选择语言；
2. 连接后端（安装器已经起好 API，通常自动通过）；
3. 创建**第一个账户** —— 它就是平台管理员；
4. 按需开启高威胁操作保护；
5. 填写站点名称、发布规则等；
6. 进入「检查与完成」。

> 不要在这一阶段把 8080 开放到公网，也不要用 `http://服务器IP:8080` 访问：
> 首个管理员注册只接受回环 Host，用 IP/域名访问会创建不出管理员。

### 3.3 切换访问形态

引导完成后，回到服务器终端，二选一：

**内网 / 单机 HTTP**（不需要域名与证书，适合内网或本机使用）：

```bash
sudo /opt/practacu-press/install.sh --finalize --mode lan
```

会询问内网访问用的 IP / 主机名（默认自动探测本机 IP）与端口（默认 80），然后 Nginx 从
`127.0.0.1:8080` 切到 `0.0.0.0:80`。完成后访问 `http://<IP>`。

**公网 HTTPS**（需要域名）：

```bash
sudo /opt/practacu-press/install.sh --finalize --mode public --domain press.example.com
```

前提（缺一不可）：

1. 域名的 A/AAAA 记录已经指向这台服务器；
2. 已经在管理后台完成**域名验证**：登录 → 站点设置 → 域名与访问 → 填域名 →
   按提示添加 DNS TXT 记录 → 点「验证域名」；
3. 80 / 443 端口能从公网访问（云安全组与系统防火墙都放行）。

切换过程会自动：把 Nginx 切到 80 端口做 HTTP-01 挑战 → 用 certbot 申请证书
（没有 certbot 会询问是否安装）→ 写 HTTPS 配置 → 把环境切成 `APP_ENV=production`、
`PP_DESKTOP=false`、`PUBLIC_BASE_URL=https://<域名>` → 重启 API 并自检。
换到生产语义后旧会话可能失效，重新登录一次即可。

切完可以随时查看状态：

```bash
sudo /opt/practacu-press/install.sh --status
```

## 4. 安装器做了什么

| 位置 | 内容 |
| --- | --- |
| `/opt/practacu-press/` | 程序、前端、模板、安装/卸载脚本、说明 |
| `/var/lib/practacu-press/data/` | `practacu.db`、`media/`、`backups/` |
| `/etc/practacu-press/practacu.env` | 服务环境变量（含 JWT 私钥，root 0600） |
| `/etc/practacu-press/install.conf` | 安装记录：目录、端口、站点形态 |
| `/etc/systemd/system/practacu-press.service` | Go API |
| `/etc/nginx/conf.d/practacu-press.conf` | Http / Https 站点（安装器生成） |
| `/etc/nginx/practacu-press-locations.conf` | 全站反向代理规则（安装器生成） |
| `/var/www/practacu-acme/` | certbot 的 HTTP-01 挑战目录 |

两个 systemd 单元都启用了 `ProtectSystem=strict`、`PrivateTmp`、`NoNewPrivileges`，
只允许写数据目录。API 只监听 `127.0.0.1`，公网只能经 Nginx 进来，所以同源策略、
Cookie 与 WebSocket 都不需要额外跨域配置。

## 5. 日常运维

```bash
# 服务状态
sudo systemctl status practacu-press
systemctl status nginx

# 日志
sudo journalctl -u practacu-press -f

# 健康检查
curl -fsS http://127.0.0.1:8081/api/healthz
curl -fsS http://127.0.0.1:8081/api/readyz
```

**备份**：数据都在 `/var/lib/practacu-press/data/`，停机或低峰期复制即可：

```bash
sudo systemctl stop practacu-press
sudo tar -czf "practacu-backup-$(date +%F).tar.gz" -C /var/lib/practacu-press data
sudo systemctl start practacu-press
```

也可以使用后台「数据」页生成整站备份；`data/backups/` 是它写入的位置。

**升级**：用新版本的包覆盖解压后重新执行安装器，它会保留数据目录、密钥与访问形态：

```bash
tar -xzf PractacuPress-Linux-<x64|arm64>-<新版本>.tar.gz
cd PractacuPress-Linux-<x64|arm64>
sudo ./install.sh
```

也可以直接用新版本的 deb/rpm 覆盖安装；postinst 会执行同一套升级流程。

升级会停止服务、替换程序、应用数据库结构（幂等）、重新渲染 systemd / Nginx 配置并重启。
升级前建议先备份 `data/`。

**修改端口 / 域名 / 配置**：优先用 `--finalize` 重跑；直接改
`/etc/practacu-press/practacu.env` 或 Nginx 配置也可以，改完
`sudo systemctl restart practacu-press`、`sudo nginx -t && sudo systemctl reload nginx`。

## 6. 安全说明

- 安装引导与内网形态的监听范围由 Nginx 配置决定；公网形态只开放 80 / 443，
  API 始终只在回环上。
- 首个管理员只能从回环地址注册（产品 V-16 修复）；安装器不会提供绕过入口。
- `/etc/practacu-press/practacu.env` 含 Ed25519 签名私钥，权限 0600，不要外传；
  丢失它等于所有会话失效（重新生成后全员重登）。
- 生产语义（`APP_ENV=production`）要求证书与 HTTPS；内网 HTTP 形态保持 development 语义，
  **不要直接暴露到公网**。
- 安全响应头（CSP、HSTS、X-Frame-Options 等）由 Nginx 统一下发，模板已包含。
- 防火墙建议只放行需要的端口（80/443，或内网形态的 HTTP 端口），
  API 端口（默认 8081）不需要对外开放。

## 7. 故障排查

| 现象 | 处理 |
| --- | --- |
| 安装脚本报端口被占用 | 换 `--port` / `--setup-port`，或停掉占用端口的服务后重跑 |
| 浏览器打不开 `127.0.0.1:8080` | 确认 SSH 隧道方向正确；`ss -ltn \| grep 8080` 确认 Nginx 在听；看 `journalctl -u nginx` |
| 安装引导里注册后不是管理员 | 必须通过回环访问（`http://127.0.0.1:8080` 或 SSH 隧道），不要用服务器 IP / 域名访问 |
| `/api/readyz` 不通过 | 查看 `journalctl -u practacu-press -n 100`；通常是数据库未迁移或数据目录权限不对 |
| 发布文章/上传返回 503 | 查看 API 日志中的安全检查错误；内置检查失败时按设计 fail-closed |
| `--finalize --mode public` 提示域名不能服务 | 先到管理后台完成域名设置与 DNS TXT 验证，确认 `curl -H 'Host: 域名' http://127.0.0.1:8081/api/v1/setup/status` 返回 `installed: true` |
| certbot 申请失败 | 检查 DNS 是否指向本机、80 端口公网可达、云安全组与防火墙；也可手动 `certbot certonly --webroot -w /var/www/practacu-acme -d 域名` 后重跑 `--finalize` |
| Nginx 配置检查失败 | `sudo nginx -t` 看具体行；安装器生成的文件在 `/etc/nginx/conf.d/practacu-press.conf` 与 `/etc/nginx/practacu-press-locations.conf` |
| API 启动即退出 | `journalctl -u practacu-press -n 100`；常见原因是 `practacu.env` 被误改（`APP_ENV=production` 时必须有 JWT 私钥、不能 `PP_DESKTOP=true`） |
| RHEL / CentOS / Rocky 上 Nginx 访问 API 被拒 | SELinux 默认会拦反向代理：`sudo setsebool -P httpd_can_network_connect 1` |

## 8. 卸载

```bash
sudo /opt/practacu-press/uninstall.sh           # 移除程序与服务，保留数据与密钥
sudo /opt/practacu-press/uninstall.sh --purge   # 连数据、系统用户、环境文件一起删除
```

非 `--purge` 卸载会保留 `/var/lib/practacu-press` 与 `/etc/practacu-press`，
重装时自动沿用数据库与签名密钥（用户不需要重新注册/登录）。

## 9. 校验与重新打包

```bash
sha256sum -c PractacuPress-Linux-<x64|arm64>.tar.gz.sha256
```

这个安装包由仓库里的 `scripts/package-linux.mjs` 生成（前端构建 + Go 交叉编译 +
模板渲染 + 自检 + tar.gz）。修改 `deploy/linux/` 下的模板或安装器后重新打包（架构用
`--arch amd64` 或 `--arch arm64`）：

```bash
node scripts/package-linux.mjs --arch amd64
```

产物在 `release/`：`PractacuPress-Linux-x64/`（目录）、`.tar.gz` 与 `.sha256`。

