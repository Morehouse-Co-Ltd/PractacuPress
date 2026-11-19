#!/bin/sh
# Package pre-remove hook.
#
# Debian passes "remove"/"purge"/"upgrade"; RPM's %preun passes 0 (uninstall) or
# 1 (upgrade). The portable uninstaller is only run on a real removal: it stops
# the services and deletes /opt/practacu-press, systemd units and Nginx config,
# while preserving /var/lib/practacu-press and /etc/practacu-press unless the
# operator purges them explicitly.
set -e

case "${1:-}" in
    remove|purge|0)
        if [ -x /opt/practacu-press/uninstall.sh ]; then
            /opt/practacu-press/uninstall.sh --yes || true
        fi
        ;;
esac

exit 0
