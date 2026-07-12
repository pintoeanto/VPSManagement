#!/usr/bin/env bash
# Usage: wireguard_peer_add.sh <peerName> <allowedIpsCidr>
# Generates a fresh keypair for the peer, appends it to wg0.conf atomically,
# validates with `wg-quick strip`, applies live via `wg syncconf` if the
# interface is up, and rolls back the config on any validation failure.
# Prints CLIENT_PRIVATE_KEY once — it is never stored server-side.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$DIR/lib/common.sh"

require_root
require_arg_count 2 "$#"

peer_name="$1"
allowed_ips="$2"
CONF=/etc/wireguard/wg0.conf

validate_safe_token "$peer_name"
if [[ ! "$allowed_ips" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}/[0-9]{1,2}$ ]]; then
  echo "invalid allowedIps: $allowed_ips" >&2
  exit 2
fi
if [[ ! -f "$CONF" ]]; then
  echo "wg0.conf does not exist; run wireguard.initInterface first" >&2
  exit 1
fi
if grep -q "^# name: ${peer_name}\$" "$CONF"; then
  echo "peer already exists: $peer_name" >&2
  exit 3
fi

umask 077
client_privkey="$(wg genkey)"
client_pubkey="$(echo "$client_privkey" | wg pubkey)"
# Case-insensitive: WireGuard's own parser treats key names case-
# insensitively, and real configs on this box mix "PublicKey"/"publicKey".
server_privkey="$(grep -i '^privatekey' "$CONF" | head -1 | sed -E 's/^[Pp]rivate[Kk]ey[[:space:]]*=[[:space:]]*//')"
server_pubkey="$(echo "$server_privkey" | wg pubkey)"
server_listen_port="$(grep -i '^listenport' "$CONF" | head -1 | sed -E 's/^[Ll]isten[Pp]ort[[:space:]]*=[[:space:]]*//')"

backup="$(backup_file "$CONF")"

{
  cat "$CONF"
  echo ""
  echo "# name: ${peer_name}"
  echo "[Peer]"
  echo "PublicKey = ${client_pubkey}"
  echo "AllowedIPs = ${allowed_ips}"
} | atomic_write "$CONF"
chmod 600 "$CONF"

if ! stripped="$(wg-quick strip wg0 2>&1)"; then
  restore_backup "$CONF" "$backup"
  echo "wg config invalid after adding peer, rolled back: $stripped" >&2
  exit 1
fi

if wg show wg0 >/dev/null 2>&1; then
  sync_err="$(mktemp)"
  if ! echo "$stripped" | wg syncconf wg0 /dev/stdin 2>"$sync_err"; then
    err="$(cat "$sync_err")"
    rm -f "$sync_err"
    restore_backup "$CONF" "$backup"
    echo "wg syncconf failed, rolled back: $err" >&2
    exit 1
  fi
  rm -f "$sync_err"
fi

echo "PEER_NAME=${peer_name}"
echo "CLIENT_PRIVATE_KEY=${client_privkey}"
echo "CLIENT_PUBLIC_KEY=${client_pubkey}"
echo "SERVER_PUBLIC_KEY=${server_pubkey}"
echo "SERVER_LISTEN_PORT=${server_listen_port}"
echo "ALLOWED_IPS=${allowed_ips}"
