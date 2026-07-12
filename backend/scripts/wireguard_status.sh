#!/usr/bin/env bash
# Usage:
#   wireguard_status.sh list
#   wireguard_status.sh show <interfaceName>
# Read-only. `list` enumerates every /etc/wireguard/*.conf tunnel with its
# up/down state, listen port, and peer count — the Tunnels tab reads from
# this. `show` prints one interface's live status cross-referenced with the
# "# name:" markers in its config. Never prints any private key.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$DIR/lib/common.sh"

require_root

WG_DIR=/etc/wireguard
subcommand="${1:-}"

case "$subcommand" in
  list)
    require_arg_count 1 "$#"
    mkdir -p "$WG_DIR"
    shopt -s nullglob
    for f in "${WG_DIR}"/*.conf; do
      [[ -f "$f" ]] || continue
      name="$(basename "$f" .conf)"
      [[ "$name" =~ ^wg[0-9]{1,3}$ ]] || continue
      up=0
      wg show "$name" >/dev/null 2>&1 && up=1
      listen_port="$(grep -i '^listenport' "$f" | head -1 | sed -E 's/^[Ll]isten[Pp]ort[[:space:]]*=[[:space:]]*//' || true)"
      peer_count="$(grep -c '^\[Peer\]' "$f" || true)"
      echo -e "${name}\t${up}\t${listen_port:-}\t${peer_count:-0}"
    done
    ;;

  show)
    require_arg_count 2 "$#"
    name="$2"
    validate_wg_interface_name "$name"
    CONF="${WG_DIR}/${name}.conf"

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
      elif [[ "$line" =~ ^[Pp]ublic[Kk]ey[[:space:]]*=[[:space:]]*(.+)$ ]] && [[ -n "$current_name" ]]; then
        NAME_OF["${BASH_REMATCH[1]}"]="$current_name"
        current_name=""
      fi
    done < "$CONF"

    if ! dump="$(wg show "$name" dump 2>&1)"; then
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
        peer_name="${NAME_OF[$a]:-unknown}"
        echo -e "PEER\t${peer_name}\t${a}\t${c}\t${d}\t${e}\t${f}\t${g}"
      fi
    done <<< "$dump"
    ;;

  *)
    echo "invalid subcommand: $subcommand" >&2
    exit 2
    ;;
esac
