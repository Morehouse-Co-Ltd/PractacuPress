#!/usr/bin/env bash
#
# Practacu Press · macOS uninstaller
#
#   sudo ./uninstall.sh            remove program and launchd services, keep data
#   sudo ./uninstall.sh --purge    also remove data and the environment file
#
set -Eeuo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

SELF_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="/usr/local/practacu-press"
DATA_DIR="/usr/local/var/practacu-press"
ENV_ROOT="/usr/local/etc/practacu-press"
LAUNCH_DIR="/Library/LaunchDaemons"
PURGE="0"

while [ $# -gt 0 ]; do
    case "$1" in
        --purge) PURGE="1"; shift ;;
        --yes) shift ;;
        --help|-h) sed -n '/^# Practacu Press/,/^#   sudo/p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "未知参数：$1" >&2; exit 1 ;;
    esac
done

[ "$(id -u)" -eq 0 ] || { echo "需要 root：请用 sudo ./uninstall.sh" >&2; exit 1; }

for label in com.practacu.press-api com.practacu.press-security; do
    launchctl bootout "system/$label" 2>/dev/null || true
    rm -f "$LAUNCH_DIR/$label.plist"
done

if [ -d /opt/homebrew/etc/nginx ]; then BREW_PREFIX="/opt/homebrew"
elif [ -d /usr/local/etc/nginx ]; then BREW_PREFIX="/usr/local"
else BREW_PREFIX=""; fi
if [ -n "$BREW_PREFIX" ]; then
    rm -f "$BREW_PREFIX/etc/nginx/servers/practacu-press.conf" \
          "$BREW_PREFIX/etc/nginx/practacu-press-locations.conf"
    if command -v nginx >/dev/null 2>&1 && nginx -t >/dev/null 2>&1; then
        nginx -s reload >/dev/null 2>&1 || true
    fi
fi

rm -rf "$INSTALL_DIR"
echo "已移除 $INSTALL_DIR 与 launchd 服务。"

if [ "$PURGE" = "1" ]; then
    rm -rf "$DATA_DIR" "$ENV_ROOT"
    echo "已删除数据与配置（--purge）。"
else
    echo "数据保留在 $DATA_DIR，配置保留在 $ENV_ROOT。"
    echo "彻底清空：sudo ./uninstall.sh --purge"
fi
