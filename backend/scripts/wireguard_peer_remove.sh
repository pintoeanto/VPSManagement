#!/usr/bin/env bash
# Usage: wireguard_peer_remove.sh <interfaceName> <peerName>
# Removes the named peer's block from <interfaceName>.conf atomically,
# validates with `wg-quick strip`, applies live via `wg syncconf` if up,
# rolls back on failure.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$DIR/lib/common.sh"

require_root
require_arg_count 2 "$#"

interface_name="$1"
peer_name="$2"
validate_wg_interface_name "$interface_name"
CONF="/etc/wireguard/${interface_name}.conf"

validate_safe_token "$peer_name"
if [[ ! -f "$CONF" ]]; then
  echo "${interface_name}.conf does not exist" >&2
  exit 1
fi
if ! grep -q "^# name: ${peer_name}\$" "$CONF"; then
  echo "not found"
  exit 0
fi

backup="$(backup_file "$CONF")"

# Remove the "# name: <peer>" marker line, the following [Peer] block, up to
# (but not including) the next "# name:" marker or EOF, via awk.
awk -v marker="# name: ${peer_name}" '
  BEGIN { skip = 0 }
  $0 == marker { skip = 1; next }
  skip == 1 && /^# name: / { skip = 0 }
  skip == 1 { next }
  { print }
' "$CONF" | atomic_write "$CONF"
chmod 600 "$CONF"

if ! stripped="$(wg-quick strip "$interface_name" 2>&1)"; then
  restore_backup "$CONF" "$backup"
  echo "wg config invalid after removing peer, rolled back: $stripped" >&2
  exit 1
fi

if wg show "$interface_name" >/dev/null 2>&1; then
  sync_err="$(mktemp)"
  if ! echo "$stripped" | wg syncconf "$interface_name" /dev/stdin 2>"$sync_err"; then
    err="$(cat "$sync_err")"
    rm -f "$sync_err"
    restore_backup "$CONF" "$backup"
    echo "wg syncconf failed, rolled back: $err" >&2
    exit 1
  fi
  rm -f "$sync_err"
fi

echo "removed"
