#!/bin/sh
# Package post-install hook.
#
# The .deb/.rpm is a thin wrapper around the same portable tree the tar.gz ships:
# this runs the installer once in non-interactive mode, which creates the service
# user, data directories, systemd units, environment file (with a persistent JWT
# key) and the Nginx setup site. Re-running it on an upgrade keeps data and keys.
set -e

if [ ! -f /usr/lib/practacu-press/install.sh ]; then
    echo "Practacu Press: /usr/lib/practacu-press/install.sh is missing" >&2
    exit 1
fi

# nfpm's tree copy can normalise file modes (and a package built on Windows
# cannot carry POSIX exec bits at all). The payload is trusted package content;
# restore the executable bits before the installer runs.
chmod 0755 /usr/lib/practacu-press/install.sh \
           /usr/lib/practacu-press/uninstall.sh \
           /usr/lib/practacu-press/bin/* 2>/dev/null || true

if [ ! -x /usr/lib/practacu-press/install.sh ]; then
    echo "Practacu Press: cannot make /usr/lib/practacu-press/install.sh executable" >&2
    exit 1
fi

if [ ! -d /run/systemd/system ]; then
    echo "Practacu Press: systemd is not running; install manually with" >&2
    echo "  /usr/lib/practacu-press/install.sh" >&2
    exit 0
fi

# --yes accepts the defaults (8080 setup site, 8081 API, /opt + /var/lib paths).
# Ports in use make this fail loudly instead of leaving a half-configured install.
/usr/lib/practacu-press/install.sh --yes || {
    echo "Practacu Press: installer failed; fix the reported problem and run" >&2
    echo "  /usr/lib/practacu-press/install.sh --yes" >&2
    exit 1
}
