#!/usr/bin/env bash
#
# Practacu Press · Linux 安装向导
#
#   sudo ./install.sh                 # 交互式安装；装完在浏览器里走八步安装引导
#   sudo ./install.sh --finalize      # 引导完成后，切换为「内网 HTTP」或「公网 HTTPS」
#   sudo ./install.sh --status        # 查看安装状态与访问地址
#   sudo ./install.sh --help          # 全部参数
#
# 为什么分两步（这是产品约束，不是安装器偷懒）：
#   * 首个管理员只能通过回环地址注册（V-16 修复），所以安装引导阶段 Nginx
#     只监听 127.0.0.1:8080，必须用本机浏览器或 SSH 隧道打开。
#   * APP_ENV=production 与 PP_DESKTOP=true 互斥，所以「装好管理员」与
#     「切换生产语义」不能在同一次启动里完成。
#
# 写入的位置：
#   /opt/practacu-press              程序（--install-dir 可改）
#   /var/lib/practacu-press          数据库与媒体（--data-dir 可改）
#   /etc/practacu-press/{install.conf,practacu.env}
#   /etc/systemd/system/practacu-press-*.service
#   /etc/nginx/conf.d/practacu-press.conf、/etc/nginx/practacu-press-locations.conf
# 卸载见同目录 uninstall.sh。

set -Eeuo pipefail
umask 022

SELF_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
VERSION="$(cat "$SELF_DIR/VERSION" 2>/dev/null || printf 'unknown')"
TEMPLATE_DIR="$SELF_DIR/deploy"

# ---- 默认值与状态 ---------------------------------------------------------
INSTALL_DIR="/opt/practacu-press"
DATA_DIR="/var/lib/practacu-press"
SERVICE_USER="practacu"
API_PORT="8081"
SETUP_PORT="8080"
PUBLIC_PORT="80"
ENV_ROOT="/etc/practacu-press"
CONF_FILE="$ENV_ROOT/install.conf"
ENV_FILE="$ENV_ROOT/practacu.env"
NGINX_CONF="/etc/nginx/conf.d/practacu-press.conf"
LOCATIONS_CONF="/etc/nginx/practacu-press-locations.conf"
ACME_ROOT="/var/www/practacu-acme"
MODE="setup"
LAN_HOST=""
DOMAIN=""
NGINX_ENABLED="yes"
APP_ENV="development"
PP_DESKTOP="true"
PUBLIC_BASE_URL=""
JWT_KEY=""
ASSUME_YES="0"
ACTION="install"
FINALIZE_MODE=""
CERT_EMAIL=""
# 命令行显式给过的值：load_conf 之后要把它们盖回来，否则升级 / 切形态时
# 会被上一次安装记录里的默认值覆盖。
CLI_INSTALL_DIR=""; CLI_DATA_DIR=""; CLI_SERVICE_USER=""
CLI_API_PORT=""; CLI_SETUP_PORT=""; CLI_PUBLIC_PORT=""
CLI_DOMAIN=""; CLI_LAN_HOST=""; CLI_NO_NGINX="0"

# ---- 彩色输出 -------------------------------------------------------------
if [ -t 1 ]; then
    C_BOLD=$'\033[1m'; C_CYAN=$'\033[1;36m'; C_YELLOW=$'\033[1;33m'
    C_RED=$'\033[1;31m'; C_GREEN=$'\033[1;32m'; C_RESET=$'\033[0m'
else
    C_BOLD=""; C_CYAN=""; C_YELLOW=""; C_RED=""; C_GREEN=""; C_RESET=""
fi

log()  { printf '%s==>%s %s\n' "$C_CYAN" "$C_RESET" "$*"; }
ok()   { printf '%s  ✓%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
warn() { printf '%s[警告]%s %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2; }
die()  { printf '%s[错误]%s %s\n' "$C_RED" "$C_RESET" "$*" >&2; exit 1; }

on_error() {
    printf '\n%s[错误]%s 安装脚本在第 %s 行失败。已完成的步骤保留在磁盘上，修好问题后可以重跑。\n' \
        "$C_RED" "$C_RESET" "$1" >&2
    printf '        查看日志：journalctl -u practacu-press-api -n 80 --no-pager\n' >&2
}
trap 'on_error "$LINENO"' ERR

usage() {
    sed -n '/^# Practacu Press · Linux 安装向导/,/^# 卸载见/p' "$0" | sed 's/^# \{0,1\}//'
    cat <<'USAGE'

用法：
  sudo ./install.sh [选项]                安装（已安装时自动进入升级流程）
  sudo ./install.sh --finalize [选项]     安装引导完成后，切换访问形态
  sudo ./install.sh --status              查看安装状态
  sudo ./install.sh --help                显示本帮助

安装选项：
  --install-dir DIR       程序目录（默认 /opt/practacu-press）
  --data-dir DIR          数据目录（默认 /var/lib/practacu-press）
  --user NAME             运行服务的系统用户（默认 practacu）
  --api-port PORT         Go API 的本机回环端口（默认 8081）
  --setup-port PORT       安装引导阶段的站点端口（默认 8080，只绑 127.0.0.1）
  --no-nginx              不安装/不配置 Nginx（需自行准备反向代理）
  --yes                   全部使用默认值，不交互（自动化部署）

切换形态（--finalize）：
  --mode lan              内网 / 单机 HTTP（无需域名与证书）
  --mode public           公网 HTTPS（需要已验证域名 + 可用的 80/443 端口）
  --domain DOMAIN         公网站点域名（--mode public 必填）
  --lan-host HOST         内网访问用的 IP 或主机名（默认自动探测）
  --public-port PORT      内网 HTTP 端口（默认 80）
  --email ADDR            Let's Encrypt 通知邮箱（可留空）

示例：
  sudo ./install.sh
  # …在浏览器里完成八步安装引导（第一个账户就是平台管理员）…
  sudo ./install.sh --finalize --mode public --domain press.example.com
  sudo ./install.sh --finalize --mode lan
USAGE
}

# ---- 参数解析 -------------------------------------------------------------
while [ $# -gt 0 ]; do
    case "$1" in
        --install-dir)   INSTALL_DIR="${2:?--install-dir 需要目录}"; CLI_INSTALL_DIR="$INSTALL_DIR"; shift 2 ;;
        --data-dir)      DATA_DIR="${2:?--data-dir 需要目录}"; CLI_DATA_DIR="$DATA_DIR"; shift 2 ;;
        --user)          SERVICE_USER="${2:?--user 需要用户名}"; CLI_SERVICE_USER="$SERVICE_USER"; shift 2 ;;
        --api-port)      API_PORT="${2:?--api-port 需要端口}"; CLI_API_PORT="$API_PORT"; shift 2 ;;
        --setup-port)    SETUP_PORT="${2:?--setup-port 需要端口}"; CLI_SETUP_PORT="$SETUP_PORT"; shift 2 ;;
        --public-port)   PUBLIC_PORT="${2:?--public-port 需要端口}"; CLI_PUBLIC_PORT="$PUBLIC_PORT"; shift 2 ;;
        --domain)        DOMAIN="${2:?--domain 需要域名}"; CLI_DOMAIN="$DOMAIN"; shift 2 ;;
        --lan-host)      LAN_HOST="${2:?--lan-host 需要主机名或 IP}"; CLI_LAN_HOST="$LAN_HOST"; shift 2 ;;
        --email)         CERT_EMAIL="${2:?--email 需要邮箱}"; shift 2 ;;
        --mode)          FINALIZE_MODE="${2:?--mode 需要 lan 或 public}"; shift 2 ;;
        --finalize)      ACTION="finalize"; shift ;;
        --status)        ACTION="status"; shift ;;
        --no-nginx)      NGINX_ENABLED="no"; CLI_NO_NGINX="1"; shift ;;
        --yes)           ASSUME_YES="1"; shift ;;
        --help|-h)       usage; exit 0 ;;
        *) die "未知参数：$1（--help 查看用法）" ;;
    esac
done

case "$FINALIZE_MODE" in
    ""|lan|public) ;;
    *) die "--mode 只能是 lan 或 public" ;;
esac

# ---- 交互与基础工具 -------------------------------------------------------
prompt_value() { # 提示文本 默认值 变量名
    local label="$1" default="${2:-}" outvar="$3" answer=""
    if [ "$ASSUME_YES" = "1" ]; then
        printf -v "$outvar" '%s' "$default"
        return 0
    fi
    if [ -n "$default" ]; then printf '%s [%s]: ' "$label" "$default"; else printf '%s: ' "$label"; fi
    read -r answer || true
    [ -n "$answer" ] || answer="$default"
    printf -v "$outvar" '%s' "$answer"
}

prompt_yes_no() { # 提示文本 默认(y/n) 变量名
    local label="$1" default="$2" outvar="$3" answer=""
    if [ "$ASSUME_YES" = "1" ]; then
        printf -v "$outvar" '%s' "$default"
        return 0
    fi
    while true; do
        printf '%s [%s]: ' "$label" "$default"
        read -r answer || true
        answer="${answer:-$default}"
        case "$answer" in
            y|Y|yes|YES) printf -v "$outvar" 'y'; return 0 ;;
            n|N|no|NO)   printf -v "$outvar" 'n'; return 0 ;;
            *) printf '请输入 y 或 n。\n' ;;
        esac
    done
}

prompt_choice() { # 提示文本 默认序号 变量名（选项由调用方打印）
    local label="$1" default="$2" outvar="$3" answer=""
    if [ "$ASSUME_YES" = "1" ]; then
        printf -v "$outvar" '%s' "$default"
        return 0
    fi
    while true; do
        printf '%s [%s]: ' "$label" "$default"
        read -r answer || true
        answer="${answer:-$default}"
        case "$answer" in
            1|2) printf -v "$outvar" '%s' "$answer"; return 0 ;;
            *) printf '请输入 1 或 2。\n' ;;
        esac
    done
}

need_root()   { [ "$(id -u)" -eq 0 ] || die "需要 root 权限：请用 sudo ./install.sh 运行"; }
need_systemd() {
    command -v systemctl >/dev/null 2>&1 || die "本安装器依赖 systemd，未找到 systemctl；容器环境请改用 Docker 部署"
    [ -d /run/systemd/system ] || die "systemd 未在运行；容器环境请改用 Docker 部署"
}
need_arch() {
    local host_arch pkg_arch
    case "$(uname -m)" in
        x86_64|amd64) host_arch="amd64" ;;
        aarch64|arm64) host_arch="arm64" ;;
        *) die "不支持的 CPU 架构：$(uname -m)（支持 x86_64 与 aarch64）" ;;
    esac
    pkg_arch="$(cat "$SELF_DIR/ARCH" 2>/dev/null | tr -d '[:space:]' || true)"
    if [ -n "$pkg_arch" ] && [ "$pkg_arch" != "$host_arch" ]; then
        die "这个包是 ${pkg_arch} 版本，当前机器是 ${host_arch}。请下载对应架构的安装包。"
    fi
}

check_package() {
    [ -x "$SELF_DIR/bin/practacu-press" ]  || die "安装包不完整：缺少 bin/practacu-press"
    [ -x "$SELF_DIR/bin/practacu-seed" ] || die "安装包不完整：缺少 bin/practacu-seed"
    [ -d "$TEMPLATE_DIR/nginx" ]         || die "安装包不完整：缺少 deploy/nginx 模板"
    [ -d "$TEMPLATE_DIR/systemd" ]       || die "安装包不完整：缺少 deploy/systemd 模板"
}

port_in_use() {
    local port="$1"
    if command -v ss >/dev/null 2>&1; then
        ss -ltn 2>/dev/null | awk -v p=":${port}" '$4 ~ p"$" {found=1} END{exit !found}'
    elif command -v netstat >/dev/null 2>&1; then
        netstat -ltn 2>/dev/null | awk -v p=":${port}" '$4 ~ p"$" {found=1} END{exit !found}'
    else
        return 1
    fi
}

pkg_install() {
    if command -v apt-get >/dev/null 2>&1; then
        apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y "$@"
    elif command -v dnf >/dev/null 2>&1; then
        dnf install -y "$@"
    elif command -v yum >/dev/null 2>&1; then
        yum install -y "$@"
    elif command -v zypper >/dev/null 2>&1; then
        zypper --non-interactive install "$@"
    elif command -v pacman >/dev/null 2>&1; then
        pacman -Sy --noconfirm --needed "$@"
    else
        return 1
    fi
}

detect_lan_host() {
    local ip=""
    if command -v hostname >/dev/null 2>&1; then
        ip="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
    fi
    if [ -z "$ip" ] && command -v ip >/dev/null 2>&1; then
        ip="$(ip route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}' || true)"
    fi
    if [ -z "$ip" ]; then
        ip="$(hostname -f 2>/dev/null || hostname 2>/dev/null || printf '127.0.0.1')"
    fi
    printf '%s' "$ip"
}

render_template() { # 源 目标 键=值...
    local src="$1" dest="$2" pair; shift 2
    local sed_args=()
    for pair in "$@"; do sed_args+=(-e "s|@@${pair%%=*}@@|${pair#*=}|g"); done
    sed "${sed_args[@]}" "$src" > "$dest"
}

wait_http() { # url 次数
    local url="$1" tries="${2:-60}" i
    for i in $(seq 1 "$tries"); do
        if curl -fsS --max-time 3 "$url" >/dev/null 2>&1; then return 0; fi
        sleep 1
    done
    return 1
}

nginx_reload() {
    nginx -t >/dev/null 2>&1 || { nginx -t; die "Nginx 配置检查失败，请查看上面的报错"; }
    if systemctl is-active --quiet nginx 2>/dev/null; then
        systemctl reload nginx
    else
        systemctl start nginx || nginx -s reload
    fi
}

# ---- 配置文件 -------------------------------------------------------------
load_conf() {
    if [ -f "$CONF_FILE" ]; then
        # 本安装器生成的固定格式（root 0600）；升级时用来保留原来的目录与端口。
        # shellcheck disable=SC1090
        . "$CONF_FILE"
    fi
}

reapply_cli() {
    if [ -n "$CLI_INSTALL_DIR" ]; then INSTALL_DIR="$CLI_INSTALL_DIR"; fi
    if [ -n "$CLI_DATA_DIR" ]; then DATA_DIR="$CLI_DATA_DIR"; fi
    if [ -n "$CLI_SERVICE_USER" ]; then SERVICE_USER="$CLI_SERVICE_USER"; fi
    if [ -n "$CLI_API_PORT" ]; then API_PORT="$CLI_API_PORT"; fi
    if [ -n "$CLI_SETUP_PORT" ]; then SETUP_PORT="$CLI_SETUP_PORT"; fi
    if [ -n "$CLI_PUBLIC_PORT" ]; then PUBLIC_PORT="$CLI_PUBLIC_PORT"; fi
    if [ -n "$CLI_DOMAIN" ]; then DOMAIN="$CLI_DOMAIN"; fi
    if [ -n "$CLI_LAN_HOST" ]; then LAN_HOST="$CLI_LAN_HOST"; fi
    if [ "$CLI_NO_NGINX" = "1" ] || [ "$NGINX_ENABLED" = "no" ]; then NGINX_ENABLED="no"; fi
}

save_conf() {
    local tmp="$CONF_FILE.tmp"
    install -d -m 0700 "$ENV_ROOT"
    cat > "$tmp" <<EOF
# Practacu Press 安装配置（由 install.sh 生成，root 0600）
INSTALL_DIR='$INSTALL_DIR'
DATA_DIR='$DATA_DIR'
SERVICE_USER='$SERVICE_USER'
API_PORT='$API_PORT'
SETUP_PORT='$SETUP_PORT'
PUBLIC_PORT='$PUBLIC_PORT'
ENV_FILE='$ENV_FILE'
CONF_FILE='$CONF_FILE'
NGINX_CONF='$NGINX_CONF'
LOCATIONS_CONF='$LOCATIONS_CONF'
ACME_ROOT='$ACME_ROOT'
MODE='$MODE'
LAN_HOST='$LAN_HOST'
DOMAIN='$DOMAIN'
NGINX_ENABLED='$NGINX_ENABLED'
EOF
    chmod 0600 "$tmp"
    mv -f "$tmp" "$CONF_FILE"
}

load_jwt_key() {
    [ -f "$ENV_FILE" ] || return 0
    JWT_KEY="$(sed -n 's/^AUTH_JWT_ED25519_PRIVATE_KEY=//p' "$ENV_FILE" | head -n1)"
}

load_env_values() {
    [ -f "$ENV_FILE" ] || return 0
    local v
    v="$(sed -n 's/^APP_ENV=//p' "$ENV_FILE" | head -n1)"
    if [ -n "$v" ]; then APP_ENV="$v"; fi
    v="$(sed -n 's/^PP_DESKTOP=//p' "$ENV_FILE" | head -n1)"
    if [ -n "$v" ]; then PP_DESKTOP="$v"; fi
    v="$(sed -n 's/^PUBLIC_BASE_URL=//p' "$ENV_FILE" | head -n1)"
    if [ -n "$v" ]; then PUBLIC_BASE_URL="$v"; fi
}

generate_jwt_key() {
    local tmpdir
    tmpdir="$(mktemp -d)"
    openssl genpkey -algorithm ED25519 -out "$tmpdir/key.pem" >/dev/null 2>&1 \
        || { rm -rf "$tmpdir"; die "openssl 生成 Ed25519 私钥失败（请确认已安装 openssl）"; }
    openssl pkey -in "$tmpdir/key.pem" -outform DER -out "$tmpdir/key.der" >/dev/null 2>&1 \
        || { rm -rf "$tmpdir"; die "openssl 导出 DER 失败"; }
    if base64 -w0 "$tmpdir/key.der" > "$tmpdir/key.b64" 2>/dev/null; then
        JWT_KEY="$(cat "$tmpdir/key.b64")"
    else
        JWT_KEY="$(base64 "$tmpdir/key.der" | tr -d '\n')"
    fi
    rm -rf "$tmpdir"
    [ -n "$JWT_KEY" ] || die "生成 JWT 私钥失败"
}

write_env_file() {
    install -d -m 0700 "$ENV_ROOT"
    local tmp="$ENV_FILE.tmp"
    cat > "$tmp" <<EOF
# Practacu Press 服务环境（由 install.sh 生成，含签名私钥，root 0600）
# 改完执行：sudo systemctl restart practacu-press-api
# 注意：APP_ENV=production 与 PP_DESKTOP=true 互斥；切换访问形态请用
#       sudo $INSTALL_DIR/install.sh --finalize
APP_ENV=$APP_ENV
HTTP_ADDR=127.0.0.1:$API_PORT
DATABASE_DRIVER=sqlite
DATABASE_DSN=file:$DATA_DIR/data/practacu.db
STORAGE_DRIVER=local
STORAGE_DIR=$DATA_DIR/data/media
BACKUP_DIR=$DATA_DIR/data/backups
# Nginx 从本机回环转发，信任它送来的 X-Forwarded-*（真实客户端 IP）。
TRUSTED_PROXIES=127.0.0.1/32
PP_DESKTOP=$PP_DESKTOP
# 安装引导经 Nginx 回环反代到达 API，端口映射/代理会隐藏客户端地址；
# 只放宽「首个管理员」判定，APP_ENV=production 时忽略。完成安装后可删掉。
PP_FIRST_ADMIN_TRUST_PROXY=1
PUBLIC_BASE_URL=$PUBLIC_BASE_URL
AUTH_JWT_ED25519_PRIVATE_KEY=$JWT_KEY
EOF
    chmod 0600 "$tmp"
    mv -f "$tmp" "$ENV_FILE"
}

write_units() {
    render_template "$TEMPLATE_DIR/systemd/practacu-press-api.service.in" \
        "/etc/systemd/system/practacu-press-api.service" \
        "INSTALL_DIR=$INSTALL_DIR" "DATA_DIR=$DATA_DIR" "SERVICE_USER=$SERVICE_USER" "ENV_FILE=$ENV_FILE"
    rm -f /etc/systemd/system/practacu-press-security.service
    systemctl daemon-reload
    systemctl enable practacu-press-api >/dev/null
}

run_as_service() {
    local runner=()
    if command -v runuser >/dev/null 2>&1; then
        runner=(runuser -u "$SERVICE_USER" --)
    elif command -v sudo >/dev/null 2>&1; then
        runner=(sudo -u "$SERVICE_USER" -H --)
    else
        die "缺少 runuser/sudo，无法以 $SERVICE_USER 身份执行命令"
    fi
    "${runner[@]}" env \
        APP_ENV="$APP_ENV" \
        DATABASE_DRIVER="sqlite" \
        DATABASE_DSN="file:$DATA_DIR/data/practacu.db" \
        STORAGE_DRIVER="local" \
        STORAGE_DIR="$DATA_DIR/data/media" \
        BACKUP_DIR="$DATA_DIR/data/backups" \
        PP_DESKTOP="$PP_DESKTOP" \
        PUBLIC_BASE_URL="$PUBLIC_BASE_URL" \
        AUTH_JWT_ED25519_PRIVATE_KEY="$JWT_KEY" \
        "$@"
}

seed_database() {
    log "建表并创建默认站点（幂等，可重复执行）"
    run_as_service "$INSTALL_DIR/bin/practacu-seed" \
        -driver sqlite -dsn "file:$DATA_DIR/data/practacu.db" >/dev/null
    ok "数据库与默认站点就绪"
}

# ---- Nginx 配置 -----------------------------------------------------------
write_locations() {
    render_template "$TEMPLATE_DIR/nginx/locations.conf.in" "$LOCATIONS_CONF" \
        "API_ADDR=127.0.0.1:$API_PORT" \
        "ACME_ROOT=$ACME_ROOT"
}

write_http_site() { # listen server_name
    write_locations
    render_template "$TEMPLATE_DIR/nginx/site.conf.in" "$NGINX_CONF" \
        "LISTEN=$1" "SERVER_NAME=$2" "LOCATIONS_CONF=$LOCATIONS_CONF"
}

write_tls_site() {
    write_locations
    render_template "$TEMPLATE_DIR/nginx/tls.conf.in" "$NGINX_CONF" \
        "DOMAIN=$DOMAIN" "ACME_ROOT=$ACME_ROOT" "LOCATIONS_CONF=$LOCATIONS_CONF" \
        "TLS_CERT=/etc/letsencrypt/live/$DOMAIN/fullchain.pem" \
        "TLS_KEY=/etc/letsencrypt/live/$DOMAIN/privkey.pem"
}

ensure_nginx() {
    [ "$NGINX_ENABLED" = "yes" ] || {
        warn "已按 --no-nginx 跳过 Nginx；请自行把 / 与 /api 反代到 127.0.0.1:$API_PORT"
        return 0
    }
    if ! command -v nginx >/dev/null 2>&1; then
        log "安装 Nginx"
        pkg_install nginx || die "自动安装 Nginx 失败，请手动安装后重跑（或加 --no-nginx 自备反代）"
    fi
    systemctl enable nginx >/dev/null 2>&1 || true
    systemctl start nginx >/dev/null 2>&1 || true
}

restore_nginx_for_mode() {
    [ "$NGINX_ENABLED" = "yes" ] || return 0
    case "$MODE" in
        lan)    write_http_site "$PUBLIC_PORT" "$LAN_HOST"; nginx_reload ;;
        public) write_tls_site; nginx_reload ;;
        *)      return 0 ;;
    esac
}

# ---- 安装 / 升级 ----------------------------------------------------------
do_install() {
    need_root
    need_systemd
    need_arch
    check_package
    command -v curl >/dev/null 2>&1    || pkg_install curl    || die "需要 curl（健康检查用）"
    command -v openssl >/dev/null 2>&1 || pkg_install openssl || die "需要 openssl（生成 JWT 私钥用）"

    local upgrading="no"
    if [ -f "$CONF_FILE" ]; then
        load_conf
        reapply_cli
        upgrading="yes"
        load_jwt_key
        load_env_values
    fi

    printf '\n%sPractacu Press · Linux 安装向导%s（包版本 %s）\n\n' "$C_BOLD" "$C_RESET" "$VERSION"

    if [ "$upgrading" = "yes" ]; then
        warn "检测到已有安装（站点形态：$MODE）。继续会保留数据库、媒体与密钥，只更新程序并重启服务。"
        local proceed=""
        prompt_yes_no "继续升级？" "y" proceed
        [ "$proceed" = "y" ] || die "已取消"
    else
        log "选择安装位置（直接回车用默认值）"
        prompt_value "程序目录" "$INSTALL_DIR" INSTALL_DIR
        prompt_value "数据目录（数据库与上传文件，备份就是复制它）" "$DATA_DIR" DATA_DIR
        prompt_value "运行服务的系统用户" "$SERVICE_USER" SERVICE_USER

        local retry=""
        while true; do
            prompt_value "Go API 的本机回环端口" "$API_PORT" API_PORT
            if ! printf '%s' "$API_PORT" | grep -Eq '^[0-9]+$'; then warn "端口必须是数字"; continue; fi
            if port_in_use "$API_PORT"; then
                if [ "$ASSUME_YES" = "1" ]; then die "端口 $API_PORT 已被占用；请加 --api-port 指定别的端口"; fi
                warn "端口 $API_PORT 已被占用。"
                prompt_yes_no "重新输入端口？" "y" retry
                [ "$retry" = "y" ] || die "端口被占用，安装中止"
                continue
            fi
            break
        done

        while true; do
            prompt_value "安装引导阶段的站点端口（只绑 127.0.0.1）" "$SETUP_PORT" SETUP_PORT
            if ! printf '%s' "$SETUP_PORT" | grep -Eq '^[0-9]+$'; then warn "端口必须是数字"; continue; fi
            if port_in_use "$SETUP_PORT"; then
                if [ "$ASSUME_YES" = "1" ]; then die "端口 $SETUP_PORT 已被占用；请加 --setup-port 指定别的端口"; fi
                warn "端口 $SETUP_PORT 已被占用（本机其它服务或另一个安装）。"
                prompt_yes_no "重新输入端口？" "y" retry
                [ "$retry" = "y" ] || die "端口被占用，安装中止"
                continue
            fi
            break
        done

        local nginx_it=""
        prompt_yes_no "是否由安装器安装/配置 Nginx？（选 n 则反代你自己配）" "y" nginx_it
        if [ "$nginx_it" = "n" ]; then NGINX_ENABLED="no"; fi
    fi

    ensure_nginx

    log "创建系统用户与目录"
    if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
        useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin "$SERVICE_USER" \
            || die "创建系统用户 $SERVICE_USER 失败"
    fi
    install -d -m 0755 "$INSTALL_DIR"
    install -d -m 0750 -o "$SERVICE_USER" -g "$SERVICE_USER" "$DATA_DIR"
    install -d -m 0750 -o "$SERVICE_USER" -g "$SERVICE_USER" "$DATA_DIR/data"
    install -d -m 0750 -o "$SERVICE_USER" -g "$SERVICE_USER" "$DATA_DIR/data/media"
    install -d -m 0750 -o "$SERVICE_USER" -g "$SERVICE_USER" "$DATA_DIR/data/backups"
    install -d -m 0755 "$ACME_ROOT"

    if [ "$upgrading" = "yes" ]; then
        log "停止服务以便替换程序"
        systemctl stop practacu-press-api 2>/dev/null || true
    fi

    log "安装程序文件到 $INSTALL_DIR"
    if [ -d "$INSTALL_DIR" ] && [ "$(cd "$SELF_DIR" && pwd -P)" = "$(cd "$INSTALL_DIR" && pwd -P)" ]; then
        # Running the installed copy (for example after package postinst already
        # placed the files): deleting bin/ first would delete the source binaries.
        # Only refresh service state; upgrading binaries requires a new package.
        log "从安装目录内运行：跳过程序文件复制"
    else
        rm -rf "$INSTALL_DIR/bin" "$INSTALL_DIR/deploy"
        cp -a "$SELF_DIR/bin" "$INSTALL_DIR/bin"
        cp -a "$TEMPLATE_DIR" "$INSTALL_DIR/deploy"
        cp -a "$SELF_DIR/install.sh" "$INSTALL_DIR/install.sh"
        if [ -f "$SELF_DIR/uninstall.sh" ]; then cp -a "$SELF_DIR/uninstall.sh" "$INSTALL_DIR/uninstall.sh"; fi
        cp -a "$SELF_DIR/INSTALL.md" "$INSTALL_DIR/INSTALL.md"
        cp -a "$SELF_DIR/README.txt" "$INSTALL_DIR/README.txt"
        cp -a "$SELF_DIR/VERSION" "$INSTALL_DIR/VERSION"
        if [ -f "$SELF_DIR/ARCH" ]; then cp -a "$SELF_DIR/ARCH" "$INSTALL_DIR/ARCH"; fi
    fi
    chmod 0755 "$INSTALL_DIR/bin"/*
    chmod 0755 "$INSTALL_DIR/install.sh"
    if [ -f "$INSTALL_DIR/uninstall.sh" ]; then chmod 0755 "$INSTALL_DIR/uninstall.sh"; fi

    if [ -z "$JWT_KEY" ]; then
        log "生成 Ed25519 签名私钥（保存在 $ENV_FILE，权限 0600）"
        generate_jwt_key
    else
        ok "沿用已有 JWT 私钥（升级不会让所有人重新登录）"
    fi
    if [ -z "$PUBLIC_BASE_URL" ]; then PUBLIC_BASE_URL="http://127.0.0.1:$SETUP_PORT"; fi
    write_env_file
    ok "环境文件已写入 $ENV_FILE"

    log "注册 systemd 服务"
    write_units

    seed_database

    log "启动服务"
    systemctl restart practacu-press-api
    if ! wait_http "http://127.0.0.1:$API_PORT/api/healthz" 60; then
        systemctl status practacu-press-api --no-pager -n 20 >&2 || true
        die "API 没有在 60 秒内通过 /api/healthz，请查看上面的状态或 journalctl -u practacu-press-api"
    fi
    ok "API 已就绪：http://127.0.0.1:$API_PORT/api/healthz"
    if wait_http "http://127.0.0.1:$API_PORT/api/readyz" 20; then
        ok "就绪检查通过（/api/readyz）"
    else
        warn "/api/readyz 尚未通过：通常是数据库未迁移或数据目录权限不对。发布文章与上传会按设计 fail-closed。"
    fi

    if [ "$upgrading" = "yes" ] && [ "$MODE" != "setup" ]; then
        restore_nginx_for_mode
        save_conf
        printf '\n%s升级完成%s（访问形态保持不变：%s）\n' "$C_BOLD" "$C_RESET" "$MODE"
        printf '  数据目录：%s\n  日志：journalctl -u practacu-press-api -f\n\n' "$DATA_DIR"
    else
        MODE="setup"
        if [ "$NGINX_ENABLED" = "yes" ]; then
            log "配置 Nginx（安装引导阶段只监听 127.0.0.1:$SETUP_PORT）"
            write_http_site "127.0.0.1:$SETUP_PORT" "_"
            nginx_reload
            if curl -fsS --max-time 5 "http://127.0.0.1:$SETUP_PORT/api/v1/setup/status" >/dev/null 2>&1; then
                ok "Nginx 已监听 127.0.0.1:$SETUP_PORT，安装状态接口可达"
            else
                warn "Nginx 已在监听，但经它访问 /api/v1/setup/status 失败：请检查 nginx -t、防火墙与反代配置。"
            fi
        fi
        save_conf
        print_next_steps
    fi
}

print_next_steps() {
    local ssh_user="${SUDO_USER:-$(id -un)}"
    printf '\n%s安装完成，还差最后一步：在浏览器里走完八步安装引导。%s\n\n' "$C_BOLD" "$C_RESET"
    printf '  1. 打开安装引导（只绑回环，必须用本机浏览器或 SSH 隧道）：\n'
    if [ "$NGINX_ENABLED" = "yes" ]; then
        printf '       · 服务器本机有桌面：http://127.0.0.1:%s\n' "$SETUP_PORT"
        printf '       · 远程服务器：在你自己的电脑上执行\n'
        printf '           ssh -L %s:127.0.0.1:%s %s@<服务器地址>\n' "$SETUP_PORT" "$SETUP_PORT" "$ssh_user"
        printf '         然后打开 http://127.0.0.1:%s\n' "$SETUP_PORT"
    else
        printf '       · 你选了 --no-nginx：请把 / 与 /api 反代到 127.0.0.1:%s 后访问\n' "$API_PORT"
    fi
    printf '  2. 七步引导里创建的第一个账户就是平台管理员。\n'
    printf '  3. 引导完成后，回到服务器执行其一：\n'
    printf '       sudo %s/install.sh --finalize --mode lan\n' "$INSTALL_DIR"
    printf '       sudo %s/install.sh --finalize --mode public --domain <你的域名>\n' "$INSTALL_DIR"
    printf '\n  数据目录：%s（备份＝复制整个 data 目录）\n' "$DATA_DIR"
    printf '  日志：journalctl -u practacu-press-api -f\n'
    printf '  完整说明：%s/INSTALL.md\n\n' "$INSTALL_DIR"
}

print_firewall_hint() {
    local port="$1"
    if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q '^Status: active'; then
        printf '  防火墙提示（ufw 已启用）：sudo ufw allow %s/tcp\n' "$port"
    elif command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
        printf '  防火墙提示（firewalld 已启用）：sudo firewall-cmd --permanent --add-port=%s/tcp && sudo firewall-cmd --reload\n' "$port"
    fi
}

# ---- 切换访问形态 ---------------------------------------------------------
check_admin_ready() {
    local body
    body="$(curl -fsS --max-time 5 "http://127.0.0.1:$API_PORT/api/v1/setup/status" 2>/dev/null || true)"
    printf '%s' "$body" | grep -Eq '"has_admin"[[:space:]]*:[[:space:]]*true'
}

check_domain_ready() {
    local body
    body="$(curl -fsS --max-time 5 -H "Host: $DOMAIN" "http://127.0.0.1:$API_PORT/api/v1/setup/status" 2>/dev/null || true)"
    printf '%s' "$body" | grep -Eq '"installed"[[:space:]]*:[[:space:]]*true'
}

finalize_lan() {
    local detected="${LAN_HOST:-}"
    [ -n "$detected" ] || detected="$(detect_lan_host)"
    prompt_value "内网访问用的 IP 或主机名（写入 Nginx server_name）" "$detected" LAN_HOST
    [ -n "$LAN_HOST" ] || die "需要一个 IP 或主机名"
    prompt_value "对外 HTTP 端口" "$PUBLIC_PORT" PUBLIC_PORT
    [ -n "$PUBLIC_PORT" ] || PUBLIC_PORT="80"
    [ "$NGINX_ENABLED" = "yes" ] || die "安装时用了 --no-nginx；内网形态需要 Nginx 反代"

    local base="http://$LAN_HOST"
    if [ "$PUBLIC_PORT" != "80" ]; then base="http://$LAN_HOST:$PUBLIC_PORT"; fi

    APP_ENV="development"
    PP_DESKTOP="true"
    PUBLIC_BASE_URL="$base"
    write_env_file

    log "切换 Nginx 到内网形态：$base"
    write_http_site "$PUBLIC_PORT" "$LAN_HOST"
    nginx_reload

    systemctl restart practacu-press-api
    wait_http "http://127.0.0.1:$API_PORT/api/healthz" 60 \
        || die "API 重启后没有通过 /api/healthz，请查看 journalctl -u practacu-press-api"
    if ! curl -fsS --max-time 5 -H "Host: $LAN_HOST" "http://127.0.0.1:$PUBLIC_PORT/api/healthz" >/dev/null 2>&1; then
        warn "经 Nginx 的 /api/healthz 检查未通过：确认端口 $PUBLIC_PORT 未被其它站点占用、防火墙已放行。"
    fi

    MODE="lan"
    save_conf
    printf '\n%s已切换为内网 / 单机 HTTP 形态。%s\n\n' "$C_BOLD" "$C_RESET"
    printf '  访问：%s\n' "$base"
    printf '  说明：内网形态保持 development 语义（不强制 HTTPS Cookie），不要直接暴露到公网。\n'
    printf '        要上公网：sudo %s/install.sh --finalize --mode public --domain <域名>\n\n' "$INSTALL_DIR"
    print_firewall_hint "$PUBLIC_PORT"
}

finalize_public() {
    if [ -z "$DOMAIN" ]; then
        prompt_value "公网域名（必须已经解析到这台服务器）" "" DOMAIN
    fi
    [ -n "$DOMAIN" ] || die "--mode public 需要 --domain"
    [ "$NGINX_ENABLED" = "yes" ] || die "公网 HTTPS 形态需要 Nginx"

    if ! check_domain_ready; then
        cat >&2 <<EOF
[错误] 域名 $DOMAIN 还不能对外服务。

  先在管理后台完成域名设置与验证：
    登录安装引导地址 → 站点设置 → 域名与访问 → 填写 $DOMAIN
    → 按页面提示添加 DNS TXT 记录 → 点「验证域名」
  验证通过后重新执行：
    sudo $INSTALL_DIR/install.sh --finalize --mode public --domain $DOMAIN
EOF
        exit 1
    fi

    local cert_dir="/etc/letsencrypt/live/$DOMAIN"
    if [ ! -f "$cert_dir/fullchain.pem" ]; then
        if ! command -v certbot >/dev/null 2>&1; then
            local install_certbot=""
            prompt_yes_no "未检测到 certbot（申请 HTTPS 证书用）。现在安装吗？" "y" install_certbot
            if [ "$install_certbot" = "y" ]; then pkg_install certbot || warn "自动安装 certbot 失败"; fi
        fi
        command -v certbot >/dev/null 2>&1 || die "请先安装 certbot，或把已有证书放到 $cert_dir/ 后重跑"

        log "把 Nginx 切到 80 端口，供 Let's Encrypt 的 HTTP-01 挑战使用"
        print_firewall_hint 80
        write_http_site "80" "$DOMAIN"
        nginx_reload

        prompt_value "Let's Encrypt 通知邮箱（可留空）" "$CERT_EMAIL" CERT_EMAIL
        log "申请证书：$DOMAIN"
        if [ -n "$CERT_EMAIL" ]; then
            certbot certonly --webroot -w "$ACME_ROOT" -d "$DOMAIN" \
                --non-interactive --agree-tos --email "$CERT_EMAIL" \
                || die "证书申请失败：确认 $DOMAIN 的 A/AAAA 记录指向本机、80 端口公网可达、防火墙已放行。"
        else
            certbot certonly --webroot -w "$ACME_ROOT" -d "$DOMAIN" \
                --non-interactive --agree-tos --register-unsafely-without-email \
                || die "证书申请失败：确认 $DOMAIN 的 A/AAAA 记录指向本机、80 端口公网可达、防火墙已放行。"
        fi
    else
        ok "已找到证书：$cert_dir"
    fi

    APP_ENV="production"
    PP_DESKTOP="false"
    PUBLIC_BASE_URL="https://$DOMAIN"
    write_env_file

    log "切换 Nginx 到 HTTPS 形态"
    write_tls_site
    nginx_reload

    systemctl restart practacu-press-api
    wait_http "http://127.0.0.1:$API_PORT/api/healthz" 60 \
        || die "API 以生产语义启动后没有通过 /api/healthz；查看 journalctl -u practacu-press-api（常见原因：JWT 私钥缺失或损坏）"
    if ! curl -fsS --max-time 8 --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/api/healthz" >/dev/null 2>&1; then
        warn "本机经 HTTPS 的 /api/healthz 未通过（证书/DNS/防火墙）；用 curl --resolve $DOMAIN:443:127.0.0.1 https://$DOMAIN/api/healthz 排查。"
    else
        ok "HTTPS 链路检查通过"
    fi
    if check_admin_ready; then
        ok "管理员状态检查通过"
    else
        warn "生产形态下读不到管理员状态，请检查站点域名与数据库。"
    fi

    MODE="public"
    save_conf
    printf '\n%s已切换为公网 HTTPS 形态。%s\n\n' "$C_BOLD" "$C_RESET"
    printf '  访问：https://%s\n' "$DOMAIN"
    printf '  证书：%s（certbot 的 systemd timer 会自动续期）\n' "$cert_dir"
    printf '  注意：生产语义下旧会话可能失效，重新登录一次即可。\n\n'
    print_firewall_hint 80
    print_firewall_hint 443
}

do_finalize() {
    need_root
    need_systemd
    command -v curl >/dev/null 2>&1 || die "需要 curl"

    [ -f "$CONF_FILE" ] || die "没有找到安装记录（$CONF_FILE）。请先运行 sudo ./install.sh"
    load_conf
    reapply_cli
    load_jwt_key
    [ -n "$JWT_KEY" ] || die "环境文件里没有 JWT 私钥（$ENV_FILE）；请先重跑 sudo ./install.sh"

    curl -fsS --max-time 5 "http://127.0.0.1:$API_PORT/api/healthz" >/dev/null 2>&1 \
        || die "API 服务未运行：sudo systemctl start practacu-press-api 后重试"
    if ! check_admin_ready; then
        die "安装引导还没完成（没有管理员账户）。请先在浏览器里走完八步安装引导，再执行 --finalize。"
    fi

    local mode="$FINALIZE_MODE"
    if [ -z "$mode" ]; then
        printf '\n选择访问形态：\n'
        printf '  1) 内网 / 单机 HTTP     —— 无需域名与证书，适合内网或本机使用\n'
        printf '  2) 公网 HTTPS           —— 需要已验证域名，自动申请 Let'"'"'s Encrypt 证书\n'
        prompt_choice "请选择" "1" mode
    fi
    case "$mode" in
        lan) finalize_lan ;;
        public) finalize_public ;;
        *) die "未知形态：$mode" ;;
    esac
}

do_status() {
    [ -f "$CONF_FILE" ] || die "没有找到安装记录（$CONF_FILE）"
    load_conf
    reapply_cli
    printf '\nPractacu Press 安装状态\n'
    printf '  安装目录：%s\n' "$INSTALL_DIR"
    printf '  数据目录：%s\n' "$DATA_DIR"
    printf '  站点形态：%s\n' "$MODE"
    if [ "$NGINX_ENABLED" = "yes" ]; then
        case "$MODE" in
            setup)  printf '  访问地址：http://127.0.0.1:%s（只绑回环，需本机浏览器或 SSH 隧道）\n' "$SETUP_PORT" ;;
            lan)    printf '  访问地址：http://%s%s\n' "$LAN_HOST" "$([ "$PUBLIC_PORT" != "80" ] && printf ':%s' "$PUBLIC_PORT")" ;;
            public) printf '  访问地址：https://%s\n' "$DOMAIN" ;;
        esac
    else
        printf '  反向代理：由你自行配置（API 在 127.0.0.1:%s）\n' "$API_PORT"
    fi
    printf '  API 健康：'
    if curl -fsS --max-time 3 "http://127.0.0.1:$API_PORT/api/healthz" >/dev/null 2>&1; then
        printf '正常\n'
    else
        printf '不可达\n'
    fi
    printf '\n'
    systemctl --no-pager -n 0 status practacu-press-api 2>/dev/null | sed -n '1,6p' || true
}

# ---- 入口 -----------------------------------------------------------------
case "$ACTION" in
    install)  do_install ;;
    finalize) do_finalize ;;
    status)   do_status ;;
    *) die "未知动作：$ACTION" ;;
esac
