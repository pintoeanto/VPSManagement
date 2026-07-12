#!/usr/bin/env bash
# Usage: wireguard_peer_update.sh <interfaceName> <currentPeerName> <newPeerName> <allowedIpsCidr> [group]
# Rewrites one peer's "# name:"/"# group:" markers and AllowedIPs in place —
# PublicKey (and any PresharedKey) are left completely untouched, since
# those are the peer's cryptographic identity, not editable metadata. This
# is how the app edits a single peer without exposing the whole raw config
# file; the raw editor remains available for anything this doesn't cover.
# Validates with `wg-quick strip`, applies live via `wg syncconf` if the
# interface is up, and rolls back on any failure.
#
# Passing a group of "" removes any existing "# group:" line for the peer
# (clears it); a non-empty group replaces or adds it.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$DIR/lib/common.sh"

require_root
if [[ "$#" -lt 4 || "$#" -gt 5 ]]; then
  echo "wrong argument count: expected 4 or 5, got $#" >&2
  exit 2
fi

interface_name="$1"
current_peer_name="$2"
new_peer_name="$3"
allowed_ips="$4"
group="${5:-}"

validate_wg_interface_name "$interface_name"
validate_safe_token "$current_peer_name"
validate_safe_token "$new_peer_name"
if [[ -n "$group" ]]; then
  validate_safe_token "$group"
fi
validate_allowed_ips_list "$allowed_ips"

CONF="/etc/wireguard/${interface_name}.conf"
if [[ ! -f "$CONF" ]]; then
  echo "${interface_name}.conf does not exist" >&2
  exit 1
fi
if ! grep -q "^# name: ${current_peer_name}\$" "$CONF"; then
  echo "peer not found: $current_peer_name" >&2
  exit 1
fi
if [[ "$new_peer_name" != "$current_peer_name" ]] && grep -q "^# name: ${new_peer_name}\$" "$CONF"; then
  echo "a peer named $new_peer_name already exists" >&2
  exit 3
fi

have_group=0
if [[ -n "$group" ]]; then
  have_group=1
fi

backup="$(backup_file "$CONF")"

awk -v marker="# name: ${current_peer_name}" \
    -v new_name_line="# name: ${new_peer_name}" \
    -v group_line="# group: ${group}" \
    -v have_group="$have_group" \
    -v new_allowed="AllowedIPs = ${allowed_ips}" '
  BEGIN { in_block = 0 }
  $0 == marker {
    in_block = 1
    print new_name_line
    if (have_group == 1) { print group_line }
    next
  }
  in_block == 1 && /^# group: / {
    # Old group line — either already superseded above, or intentionally
    # dropped (group cleared). Either way, do not print the original.
    next
  }
  in_block == 1 && /^# name: / {
    # Next peer'"'"'s marker — this block is over.
    in_block = 0
  }
  in_block == 1 && $0 ~ /^[Aa]llowed[Ii][Pp]s[[:space:]]*=/ {
    print new_allowed
    next
  }
  { print }
' "$CONF" | atomic_write "$CONF"
chmod 600 "$CONF"

if ! stripped="$(wg-quick strip "$interface_name" 2>&1)"; then
  restore_backup "$CONF" "$backup"
  echo "wg config invalid after updating peer, rolled back: $stripped" >&2
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

echo "ok"
