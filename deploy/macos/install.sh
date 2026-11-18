#!/usr/bin/env bash
#
# Practacu Press · macOS installer (launchd + optional Homebrew Nginx)
#
#   sudo ./install.sh
#   sudo ./install.sh --no-nginx
#
# Installs the prebuilt binaries and frontend under /usr/local/practacu-press,
# creates a launchd daemon for the API and (when
# Homebrew Nginx is already installed) renders a same-origin site on
# 127.0.0.1:8080. The first-run wizard must be completed from this machine.
#
set -Eeuo pipefail
umask 022
# sudo's secure_path does not include Homebrew on Apple Silicon.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

SELF_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
VERSION="$(cat "$SELF_DIR/VERSION" 2>/dev/null || printf 'unknown')"

INSTALL_DIR="/usr/local/practacu-press"
DATA_DIR="/usr/local/var/practacu-press"
ENV_ROOT="/usr/local/etc/practacu-press"
ENV_FILE="$ENV_ROOT/practacu.env"
LAUNCH_DIR="/Library/LaunchDaemons"
API_PORT="8081"
SITE_PORT="8080"
RUN_USER="${SUDO_USER:-$(id -un)}"
NGINX_ENABLED="yes"

log()  { printf '==> %s\n' "$*"; }
ok()   { printf '  ✓ %s\n' "$*"; }
warn() { printf '[警告] %s\n' "$*" >&2; }
die()  { printf '[错误] %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
    case "$1" in
        --no-nginx) NGINX_ENABLED="no"; shift ;;
        --help|-h)
            sed -n '/^# Practacu Press/,/^# 127.0.0.1/p' "$0" | sed 's/^# \{0,1\}//'
            exit 0
            ;;
        *) die "未知参数：$1" ;;
    esac
done

[ "$(id -u)" -eq 0 ] || die "需要 root：请用 sudo ./install.sh 运行"
[ "$(uname -s)" = "Darwin" ] || die "这个安装器只适用于 macOS"
[ "$RUN_USER" != "root" ] || die "请通过 sudo 由普通管理员账户运行，服务不会以 root 身份运行"
command -v launchctl >/dev/null 2>&1 || die "缺少 launchctl"

case "$(uname -m)" in
    arm64) HOST_ARCH="arm64" ;;
    x86_64) HOST_ARCH="amd64" ;;
    *) die "不支持的 CPU 架构：$(uname -m)" ;;
esac
PKG_ARCH="$(cat "$SELF_DIR/ARCH" 2>/dev/null | tr -d '[:space:]' || true)"
if [ -n "$PKG_ARCH" ] && [ "$PKG_ARCH" != "$HOST_ARCH" ]; then
    die "这个包是 ${PKG_ARCH} 版本，当前机器是 ${HOST_ARCH}。"
fi

[ -x "$SELF_DIR/bin/practacu-api" ] || die "安装包不完整：缺少 bin/practacu-api"

log "安装程序文件到 $INSTALL_DIR"
install -d -m 0755 "$INSTALL_DIR"
rm -rf "$INSTALL_DIR/bin" "$INSTALL_DIR/deploy"
cp -a "$SELF_DIR/bin" "$INSTALL_DIR/bin"
cp -a "$SELF_DIR/deploy" "$INSTALL_DIR/deploy"
for name in INSTALL.md README.txt VERSION ARCH; do
    [ -f "$SELF_DIR/$name" ] && cp -a "$SELF_DIR/$name" "$INSTALL_DIR/$name"
done
cp -a "$SELF_DIR/install.sh" "$INSTALL_DIR/install.sh"
[ -f "$SELF_DIR/uninstall.sh" ] && cp -a "$SELF_DIR/uninstall.sh" "$INSTALL_DIR/uninstall.sh"
chmod 0755 "$INSTALL_DIR/bin"/* "$INSTALL_DIR/install.sh" 2>/dev/null || true
[ -f "$INSTALL_DIR/uninstall.sh" ] && chmod 0755 "$INSTALL_DIR/uninstall.sh"

log "创建数据与配置目录"
mkdir -p /usr/local/etc /usr/local/var
install -d -m 0750 -o "$RUN_USER" -g staff "$DATA_DIR" "$DATA_DIR/data" "$DATA_DIR/data/media" "$DATA_DIR/data/backups"
install -d -m 0700 -o "$RUN_USER" -g staff "$ENV_ROOT"
for log in api.log api.err.log; do
    : > "$DATA_DIR/$log"
    chown "$RUN_USER":staff "$DATA_DIR/$log"
    chmod 0640 "$DATA_DIR/$log"
done

if [ ! -f "$ENV_FILE" ]; then
    log "生成 $ENV_FILE"
    JWT_KEY=""
    if command -v openssl >/dev/null 2>&1; then
        TMPDIR_KEY="$(mktemp -d)"
        if openssl genpkey -algorithm ED25519 -out "$TMPDIR_KEY/key.pem" >/dev/null 2>&1 \
            && openssl pkey -in "$TMPDIR_KEY/key.pem" -outform DER -out "$TMPDIR_KEY/key.der" >/dev/null 2>&1; then
            JWT_KEY="$(base64 < "$TMPDIR_KEY/key.der" | tr -d '\n')"
        fi
        rm -rf "$TMPDIR_KEY"
    fi
    if [ -z "$JWT_KEY" ]; then
        warn "无法生成 Ed25519 私钥；开发模式会使用临时密钥（重启后需要重新登录）。"
        warn "生产使用前请在 $ENV_FILE 设置 AUTH_JWT_ED25519_PRIVATE_KEY。"
    fi
    cat > "$ENV_FILE" <<EOF
# Practacu Press 服务环境（macOS launchd 读取）
APP_ENV=development
HTTP_ADDR=127.0.0.1:$API_PORT
DATABASE_DRIVER=sqlite
DATABASE_DSN=file:$DATA_DIR/data/practacu.db
STORAGE_DRIVER=local
STORAGE_DIR=$DATA_DIR/data/media
BACKUP_DIR=$DATA_DIR/data/backups
TRUSTED_PROXIES=127.0.0.1/32
PP_DESKTOP=true
# 安装引导经本机 Nginx 反代到达 API；只放宽首个管理员判定。
PP_FIRST_ADMIN_TRUST_PROXY=1
PUBLIC_BASE_URL=http://127.0.0.1:$SITE_PORT
AUTH_JWT_ED25519_PRIVATE_KEY=$JWT_KEY
EOF
    chown "$RUN_USER":staff "$ENV_FILE"
    chmod 0600 "$ENV_FILE"
else
    ok "沿用已有 $ENV_FILE"
fi

render() { # src dest key=value...
    local src="$1" dest="$2" pair
    shift 2
    local args=()
    for pair in "$@"; do args+=(-e "s|@@${pair%%=*}@@|${pair#*=}|g"); done
    sed "${args[@]}" "$src" > "$dest"
}

brew_prefix() {
    if [ -d /opt/homebrew/etc/nginx ]; then printf '/opt/homebrew'
    elif [ -d /usr/local/etc/nginx ]; then printf '/usr/local'
    else printf ''
    fi
}

log "注册 launchd 服务"
install -d -m 0755 "$LAUNCH_DIR"
render "$SELF_DIR/deploy/macos/com.practacu.press-api.plist.in" \
    "$LAUNCH_DIR/com.practacu.press-api.plist" \
    "INSTALL_DIR=$INSTALL_DIR" "DATA_DIR=$DATA_DIR" "ENV_FILE=$ENV_FILE" "RUN_USER=$RUN_USER"
chmod 0644 "$LAUNCH_DIR/com.practacu.press-"*.plist

for label in com.practacu.press-api; do
    launchctl bootout "system/$label" 2>/dev/null || true
done
launchctl bootstrap system "$LAUNCH_DIR/com.practacu.press-api.plist"

log "等待 API 就绪"
for _ in $(seq 1 60); do
    if curl -fsS --max-time 2 "http://127.0.0.1:$API_PORT/api/healthz" >/dev/null 2>&1; then
        ok "API 已就绪：http://127.0.0.1:$API_PORT/api/healthz"
        break
    fi
    sleep 1
done
if ! curl -fsS --max-time 2 "http://127.0.0.1:$API_PORT/api/healthz" >/dev/null 2>&1; then
    warn "API 还没有通过健康检查，查看 $DATA_DIR/api.err.log 与 launchctl print system/com.practacu.press-api"
fi

if [ "$NGINX_ENABLED" = "yes" ]; then
    if command -v nginx >/dev/null 2>&1; then
        log "配置 Homebrew Nginx（127.0.0.1:$SITE_PORT）"
        BREW_PREFIX="$(brew_prefix)"
        if [ -z "$BREW_PREFIX" ]; then
            warn "没有找到 Homebrew Nginx 配置目录（/opt/homebrew/etc/nginx 或 /usr/local/etc/nginx）"
            warn "安装后按 README 手动配置反代；本轮跳过 Nginx。"
        else
            NGINX_CONF_DIR="$BREW_PREFIX/etc/nginx"
            install -d -m 0755 "$NGINX_CONF_DIR/servers"
            install -d -m 0755 "$DATA_DIR/acme"
            LOCATIONS_CONF="$NGINX_CONF_DIR/practacu-press-locations.conf"
            render "$SELF_DIR/deploy/linux/nginx/locations.conf.in" "$LOCATIONS_CONF" \
                "API_ADDR=127.0.0.1:$API_PORT" \
                "ACME_ROOT=$DATA_DIR/acme" "LOCATIONS_CONF=$LOCATIONS_CONF"
            render "$SELF_DIR/deploy/linux/nginx/site.conf.in" "$NGINX_CONF_DIR/servers/practacu-press.conf" \
                "LISTEN=127.0.0.1:$SITE_PORT" "SERVER_NAME=_" "LOCATIONS_CONF=$LOCATIONS_CONF"
            if nginx -t; then
                # Homebrew services run in the login user's launchd domain, so root
                # cannot restart them. Reload if the daemon is already running;
                # otherwise tell the operator the one command to run.
                if nginx -s reload >/dev/null 2>&1; then
                    ok "Nginx 已配置并重载：http://127.0.0.1:$SITE_PORT"
                else
                    warn "配置已写入，但 Nginx 没有在运行。请执行：brew services start nginx"
                fi
            else
                warn "nginx -t 失败；请检查 $NGINX_CONF_DIR 下的 Practacu Press 配置"
            fi
        fi
    else
        warn "没有找到 Nginx。先安装：brew install nginx，然后重新运行 sudo ./install.sh"
        warn "或加 --no-nginx 自行用 Caddy/其他反代：/ -> 127.0.0.1:$API_PORT（前端已内嵌在 API）"
    fi
fi

cat <<EOF

安装完成（版本 $VERSION）。
  打开：http://127.0.0.1:$SITE_PORT
  数据：$DATA_DIR
  环境：$ENV_FILE（含密钥，权限 0600）
  服务：launchctl print system/com.practacu.press-api
  卸载：sudo $INSTALL_DIR/uninstall.sh
EOF
