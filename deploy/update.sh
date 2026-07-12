#!/usr/bin/env bash
# Pulls the latest code and does everything needed to pick it up: reinstalls
# deps, rebuilds the frontend, re-locks the helper scripts, re-validates and
# reinstalls the sudoers rule, reinstalls the systemd unit, and restarts the
# service.
#
# Run from anywhere with: sudo bash /opt/vps-console/deploy/update.sh
#
# Deliberately NOT handled here: the NGINX vhost. That file on this VPS has
# been hand-edited and certbot-modified since it was first copied from
# deploy/nginx/vps-console.conf, so blindly overwriting it here would wipe
# your cert paths and any other manual changes. Update NGINX config by hand.
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run this with sudo: sudo bash $0" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
BACKEND_DIR="$REPO_DIR/backend"
FRONTEND_DIR="$REPO_DIR/frontend"

echo "==> git pull ($REPO_DIR)"
cd "$REPO_DIR"
git pull

echo "==> backend: npm install"
cd "$BACKEND_DIR"
npm install --omit=dev

echo "==> frontend: npm install && build"
cd "$FRONTEND_DIR"
npm install
npm run build

echo "==> re-locking helper scripts (root-owned, not app-writable)"
chown -R root:root "$BACKEND_DIR/scripts"
chmod -R 750 "$BACKEND_DIR/scripts"

echo "==> validating and installing sudoers rule"
sudoers_tmp="$(mktemp)"
cp "$REPO_DIR/deploy/sudoers/vps-console.sudoers" "$sudoers_tmp"
if ! visudo -c -f "$sudoers_tmp" >/dev/null; then
  echo "sudoers file failed validation — NOT installed, previous rule left in place." >&2
  echo "Check deploy/sudoers/vps-console.sudoers before re-running." >&2
  rm -f "$sudoers_tmp"
  exit 1
fi
cp "$sudoers_tmp" /etc/sudoers.d/vps-console
chmod 440 /etc/sudoers.d/vps-console
chown root:root /etc/sudoers.d/vps-console
rm -f "$sudoers_tmp"

echo "==> installing systemd unit"
cp "$REPO_DIR/deploy/systemd/vps-console.service" /etc/systemd/system/vps-console.service
systemctl daemon-reload

echo "==> restarting vps-console"
systemctl restart vps-console

echo "==> status"
systemctl status vps-console --no-pager -l || true

echo "==> done"
