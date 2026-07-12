#!/usr/bin/env bash
# Usage: wireguard_install.sh [listenPort] [serverAddressCidr]
# Idempotent: installs the wireguard package if missing, and initializes
# /etc/wireguard/wg0.conf with a fresh server keypair only if it doesn't
# already exist. Never overwrites an existing wg0.conf.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$DIR/lib/common.sh"

require_root

listen_port="${1:-51820}"
server_address="${2:-10.8.0.1/24}"

if [[ ! "$listen_port" =~ ^[0-9]+$ ]] || [[ "$listen_port" -lt 1 ]] || [[ "$listen_port" -gt 65535 ]]; then
  echo "invalid listen port: $listen_port" >&2
  exit 2
fi
if [[ ! "$server_address" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}/[0-9]{1,2}$ ]]; then
  echo "invalid server address: $server_address" >&2
  exit 2
fi

if ! command -v wg >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y
  apt-get install -y wireguard
fi

mkdir -p /etc/wireguard
chmod 700 /etc/wireguard

if [[ -f /etc/wireguard/wg0.conf ]]; then
  echo "already initialized"
  exit 0
fi

umask 077
privkey="$(wg genkey)"

cat <<EOF | atomic_write /etc/wireguard/wg0.conf
[Interface]
Address = ${server_address}
ListenPort = ${listen_port}
PrivateKey = ${privkey}
SaveConfig = false
EOF
chmod 600 /etc/wireguard/wg0.conf

echo "initialized"
