#!/usr/bin/env bash
#
# Practacu Press · Linux 卸载脚本
#
#   sudo ./uninstall.sh            # 移除程序与服务，保留数据目录
#   sudo ./uninstall.sh --purge    # 连数据、系统用户与环境文件一起删除（不可恢复）
#
# 默认保留 $DATA_DIR（数据库与上传文件），方便重装或迁移；
# 只有显式 --purge 才会删除它。

set -Eeuo pipefail
umask 022

SELF_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

INSTALL_DIR="/opt/practacu-press"
DATA_DIR="/var/lib/practacu-press"
SERVICE_USER="practacu"
ENV_ROOT="/etc/practacu-press"
CONF_FILE="$ENV_ROOT/install.conf"
ENV_FILE="$ENV_ROOT/practacu.env"
NGINX_CONF="/etc/nginx/conf.d/practacu-press.conf"
LOCATIONS_CONF="/etc/nginx/practacu-press-locations.conf"
ACME_ROOT="/var/www/practacu-acme"
PURGE="0"
ASSUME_YES="0"

C_BOLD=$'\033[1m'; C_CYAN=$'\033[1;36m'; C_YELLOW=$'\033[1;33m'
C_RED=$'\033[1;31m'; C_GREEN=$'\033[1;32m'; C_RESET=$'\033[0m'
if [ ! -t 1 ]; then C_BOLD=""; C_CYAN=""; C_YELLOW=""; C_RED=""; C_GREEN=""; C_RESET=""; fi

log()  { printf '%s==>%s %s\n' "$C_CYAN" "$C_RESET" "$*"; }
ok()   { printf '%s  ✓%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
warn() { printf '%s[警告]%s %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2; }
die()  { printf '%s[错误]%s %s\n' "$C_RED" "$C_RESET" "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
    case "$1" in
        --purge) PURGE="1"; shift ;;
        --yes)   ASSUME_YES="1"; shift ;;
        --help|-h)
            cat <<'USAGE'
用法：
  sudo ./uninstall.sh            移除程序与服务，保留数据目录
  sudo ./uninstall.sh --purge    连数据、系统用户与环境文件一起删除
  --yes                          不交互确认
USAGE
            exit 0 ;;
        *) die "未知参数：$1" ;;
    esac
done

[ "$(id -u)" -eq 0 ] || die "需要 root 权限：请用 sudo ./uninstall.sh 运行"

if [ -f "$CONF_FILE" ]; then
    # shellcheck disable=SC1090
    . "$CONF_FILE"
fi

printf '\n%sPractacu Press · 卸载%s\n\n' "$C_BOLD" "$C_RESET"
printf '  程序目录：%s\n' "$INSTALL_DIR"
printf '  数据目录：%s%s\n' "$DATA_DIR" "$([ "$PURGE" = "1" ] && printf '  （将被删除！）' || printf '  （保留）')"

if [ "$ASSUME_YES" != "1" ]; then
    printf '确认继续？[y/N]: '
    read -r answer || true
    case "$answer" in
        y|Y|yes|YES) ;;
        *) die "已取消" ;;
    esac
fi

log "停止并移除 systemd 服务"
for unit in practacu-press-api; do
    systemctl stop "$unit" 2>/dev/null || true
    systemctl disable "$unit" 2>/dev/null || true
    rm -f "/etc/systemd/system/$unit.service"
done
systemctl daemon-reload 2>/dev/null || true
systemctl reset-failed 2>/dev/null || true
ok "服务已移除"

log "移除 Nginx 站点配置"
rm -f "$NGINX_CONF" "$LOCATIONS_CONF"
if command -v nginx >/dev/null 2>&1; then
    if nginx -t >/dev/null 2>&1; then
        if systemctl is-active --quiet nginx 2>/dev/null; then systemctl reload nginx; fi
        ok "Nginx 已重载"
    else
        warn "Nginx 配置检查未通过：可能还有别的配置引用了已删除的文件，请手工检查 nginx -t"
    fi
fi

log "移除程序目录"
rm -rf "$INSTALL_DIR"
ok "$INSTALL_DIR 已删除"

if [ "$PURGE" = "1" ]; then
    log "移除数据、环境文件与系统用户（--purge）"
    rm -rf "$DATA_DIR"
    rm -rf "$ENV_ROOT"
    rm -rf "$ACME_ROOT"
    if id -u "$SERVICE_USER" >/dev/null 2>&1; then
        userdel "$SERVICE_USER" 2>/dev/null || warn "删除用户 $SERVICE_USER 失败（可手工处理）"
    fi
    ok "数据与配置已删除"
    printf '\n%s卸载完成（已清空数据）。%s\n\n' "$C_BOLD" "$C_RESET"
else
    printf '\n%s卸载完成，数据保留在 %s%s\n' "$C_BOLD" "$DATA_DIR" "$C_RESET"
    printf '  保留的还有 %s（JWT 私钥与安装记录），重装时会自动沿用。\n' "$ENV_ROOT"
    printf '  想彻底清空：重新解压安装包后执行 sudo ./uninstall.sh --purge\n\n'
fi
