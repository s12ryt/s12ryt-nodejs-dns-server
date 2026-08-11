#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "This installer must run as root" >&2
  exit 1
fi

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)

install -D -m 0644 "$SCRIPT_DIR/s12-dns-server.sysusers" /usr/lib/sysusers.d/s12-dns-server.conf
install -D -m 0644 "$SCRIPT_DIR/s12-dns-server.tmpfiles" /usr/lib/tmpfiles.d/s12-dns-server.conf
systemd-sysusers /usr/lib/sysusers.d/s12-dns-server.conf
systemd-tmpfiles --create /usr/lib/tmpfiles.d/s12-dns-server.conf
install -D -o root -g root -m 0644 "$PROJECT_DIR/index.js" /opt/s12-dns-server/index.js
install -D -o root -g root -m 0644 "$SCRIPT_DIR/s12-dns-server.service" /etc/systemd/system/s12-dns-server.service
systemctl daemon-reload
systemctl enable --now s12-dns-server.service
