#!/usr/bin/env bash
# Usage: wireguard_install.sh <interfaceName> [listenPort] [serverAddressCidr]
# Idempotent: installs the wireguard package if missing, and initializes
# /etc/wireguard/<interfaceName>.conf with a fresh server keypair only if it
# doesn't already exist. Never overwrites an existing config — this is also
# how a new tunnel (wg1, wg2, ...) gets created, by passing a name that
# doesn't have a config file yet.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$DIR/lib/common.sh"

require_root

interface_name="${1:?interface name required}"
listen_port="${2:-51820}"
server_address="${3:-10.8.0.1/24}"

validate_wg_interface_name "$interface_name"
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

CONF="/etc/wireguard/${interface_name}.conf"

if [[ -f "$CONF" ]]; then
  echo "already initialized"
  exit 0
fi

umask 077
privkey="$(wg genkey)"

cat <<EOF | atomic_write "$CONF"
[Interface]
Address = ${server_address}
ListenPort = ${listen_port}
PrivateKey = ${privkey}
SaveConfig = false
EOF
chmod 600 "$CONF"

echo "initialized"
