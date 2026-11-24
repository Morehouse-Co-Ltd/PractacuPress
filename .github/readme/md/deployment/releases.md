# 发布流程（GitHub Release + Docker 镜像）

仓库用 `.github/workflows/release.yml` 在版本号出现时同时产出：

| 产物 | 架构 | 文件 |
| --- | --- | --- |
| Windows 便携包 | x64、arm64 | `PractacuPress-Windows-{x64,arm64}.zip` |
| Linux 原生包 | x86_64、aarch64 | `PractacuPress-Linux-{x64,arm64}.tar.gz` |
| Debian / Ubuntu | amd64、arm64 | `practacu-press_<version>_<arch>.deb` |
| RHEL / Fedora / openSUSE | x86_64、aarch64 | `practacu-press-<version>.<arch>.rpm` |
| macOS | x86_64、arm64 | `PractacuPress-macOS-{x86_64,arm64}.tar.gz` |
| 校验和 | — | `SHA256SUMS` |
| 容器镜像 | linux/amd64、linux/arm64 | `practacu-press`（前端与安全检查已内嵌） |

## 1. 怎么触发

三种方式等价：

1. 向 `main` 推送提交，**提交信息包含版本号**：
   ```text
   feat: cut v1.2.0
   release: v1.2.1-beta1
   ```
2. 推送一个版本 tag（`v1.2.0` / `V1.2.0` / `v1.2.1-beta1`）。
3. 在 Actions 页面手动运行 **Release**，填写 `version`。

版本格式：`v<major>.<minor>.<patch>[-beta<N>]`，例如 `v1.0.0`、`V1.0.1-beta1`。
解析逻辑在 [`scripts/release-version.mjs`](../../../../scripts/release-version.mjs)：

- 大小写 `v` 都接受，内部统一规范成小写 `v1.0.1-beta1`；
- `-beta1`、`-beta.1`、`-Beta1` 都归一化成 `-beta1`；
- 没有匹配到版本时，除 `version` 外的所有 job 都会跳过，不会误发 Release；
- 一提交里出现多个版本时取第一个；不要把版本号写进无关提交。

版本号会写进：

- GitHub Release 的 tag / 标题；
- 各安装包的 `VERSION` 与前端 `version.json`（`style=stable|beta`）；
- Docker tag：正式版 `vX.Y.Z` + `latest`，测试版 `vX.Y.Z-betaN` + `beta`。

## 2. 必需的仓库设置

| 名称 | 用途 |
| --- | --- |
| `DOCKERHUB_USERNAME`（Secret） | Docker Hub 用户名；为空时自动跳过 Docker Hub |
| `DOCKERHUB_TOKEN`（Secret） | Docker Hub access token（需要 Read & Write） |
| `GITHUB_TOKEN`（自动） | GitHub Release 与 GHCR 推送（workflow 已声明 `contents: write`、`packages: write`） |

GHCR 的包默认是私有的；要在别的机器上拉取，先 `docker login ghcr.io`，或把包的可见性改为
public。Docker Hub 的仓库第一次推送时会自动创建（token 需要对应命名空间的写权限）。

## 3. 镜像名

只发布一个镜像；默认栈只需要 `api`（已用 `go:embed` 内嵌前端与安全检查）：

```text
ghcr.io/<owner>/practacu-press:<tag>

<dockerhub-user>/practacu-press:<tag>
```

`<owner>` 取 `github.repository_owner` 并转小写。`<tag>` 是 `vX.Y.Z[-betaN]`。beta 额外
有 `:beta`，stable 额外有 `:latest`；`beta` 与 `latest` 都不会互相覆盖。

用发布镜像替代本地构建：

```bash
export PP_IMAGE=ghcr.io/<owner>/practacu-press:v1.2.0
docker compose pull
docker compose up -d
```

生产部署时再加 `--env-file .env.prod`（同一份 compose 文件）：

```bash
docker compose --env-file .env.prod pull
docker compose --env-file .env.prod up -d
```

单份 `docker-compose.yml` 同时支持本地构建与发布镜像；数据卷、网络、健康检查、
环境变量保持一致。

## 4. 各平台包说明

### Windows

Windows 包包含 `PractacuPress.exe`、`.env`、`启动.cmd`、`data/`、`VERSION` 与
`README.txt`。API 内嵌前端与安全检查；arm64 包由 `windows-11-vs2026-arm` runner
原生构建，x64 由 `windows-2022` 构建。解压后双击 `启动.cmd` 即可，
不写注册表、不需要安装 Node/Go。

### Linux

- **tar.gz**：`install.sh` 交互安装，支持 Debian / Ubuntu / RHEL / Rocky / Alma / Fedora /
  openSUSE（systemd），架构由包内 `ARCH` 文件核对。
- **deb/rpm**：内容与 tar.gz 相同，安装到 `/usr/lib/practacu-press`，postinst 非交互执行
  `install.sh --yes`（创建服务用户、数据目录、systemd、Nginx、JWT 密钥），依赖
  `nginx`、`curl`、`openssl`、`ca-certificates`。卸载保留
  `/var/lib/practacu-press` 与 `/etc/practacu-press`。
- 两种包都只监听回环完成安装引导；首个管理员通过 `PP_FIRST_ADMIN_TRUST_PROXY` 在
  本机反代后仍可创建（只在回环端口安全）。

### macOS

- tar.gz 内含 `install.sh` / `uninstall.sh`，用 launchd 注册 API；数据在
  `/usr/local/var/practacu-press`。
- 先 `brew install nginx`，安装器会生成 `127.0.0.1:8080` 的同源站点；否则用
  `--no-nginx` 自行反代到 `127.0.0.1:8081`。
- Apple Silicon 用 arm64 包，Intel 用 x86_64 包；两者前端相同、二进制分别构建。

## 5. 本地复现

```bash
# 版本解析
node --test scripts/release-version.test.mjs

# 前端
cd web && npm ci && npm run build && cd ../..
node scripts/stamp-version.mjs --dist web/dist --version v1.2.0

# Linux
node scripts/package-linux.mjs --arch amd64 --skip-web --version v1.2.0
NFPM_ARCH=amd64 NFPM_VERSION=1.2.0 NFPM_RELEASE=1 \
  NFPM_STAGE="$PWD/.tmp/linuxpkg/PractacuPress-Linux-x64" \
  nfpm package -f deploy/package/nfpm.yaml -p deb -t release

# Windows（在 Windows 上）
node scripts/package-windows.mjs --arch amd64 --skip-web --version v1.2.0

# macOS（在 macOS 上）
node scripts/package-macos.mjs --arch arm64 --skip-web --version v1.2.0
```

## 6. 排错

- **没有触发**：提交信息里没有 `vX.Y.Z`；或 push 的分支不是 `main`（tag 与手动触发不受分支限制）。
- **Docker 推送 401/403**：检查 `DOCKERHUB_TOKEN` 是否有写权限；GHCR 需要 workflow 的
  `packages: write`（已配置）。
- **arm64 Windows job 排队失败**：`windows-11-vs2026-arm` 是 GitHub 面向公开仓库的
  arm64 Windows runner（带 Visual Studio）；私有仓库若不可用，可改用付费的 arm64
  larger runner，或在 x64 runner 上配置 ARM64 MSVC 交叉链接后把矩阵改成单 runner。
- **deb/rpm 在容器里安装失败**：postinst 需要 systemd；容器请用 tar.gz 或 Docker 镜像。
- **macOS 安装后打不开**：确认 `launchctl print system/com.practacu.press`，看
  `/usr/local/var/practacu-press/api.err.log`；首次启动可能被 Gatekeeper 拦截，需在
  「系统设置 → 隐私与安全性」允许。
