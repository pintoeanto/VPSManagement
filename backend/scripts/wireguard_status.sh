#!/usr/bin/env bash
# Usage: wireguard_status.sh
# Read-only. Prints interface + peer status, cross-referenced with the
# "# name:" markers in wg0.conf. Never prints the server's private key.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$DIR/lib/common.sh"

require_root
require_arg_count 0 "$#"

CONF=/etc/wireguard/wg0.conf

if [[ ! -f "$CONF" ]]; then
  echo "not initialized"
  exit 1
fi
if ! command -v wg >/dev/null 2>&1; then
  echo "wg not installed" >&2
  exit 1
fi

# Build pubkey -> name map from the config's "# name:" markers.
declare -A NAME_OF
current_name=""
while IFS= read -r line; do
  if [[ "$line" =~ ^#\ name:\ (.+)$ ]]; then
    current_name="${BASH_REMATCH[1]}"
  elif [[ "$line" =~ ^PublicKey[[:space:]]*=[[:space:]]*(.+)$ ]] && [[ -n "$current_name" ]]; then
    NAME_OF["${BASH_REMATCH[1]}"]="$current_name"
    current_name=""
  fi
done < "$CONF"

if ! dump="$(wg show wg0 dump 2>&1)"; then
  echo "interface down or not found: $dump" >&2
  exit 1
fi

first=1
while IFS=$'\t' read -r a b c d e f g h; do
  if [[ "$first" -eq 1 ]]; then
    # interface line: privkey pubkey listenport fwmark
    echo -e "INTERFACE\t${c}\t${b}"
    first=0
  else
    # peer line: pubkey presharedkey endpoint allowedips latest-handshake rx tx keepalive
    name="${NAME_OF[$a]:-unknown}"
    echo -e "PEER\t${name}\t${a}\t${c}\t${d}\t${e}\t${f}\t${g}"
  fi
done <<< "$dump"
