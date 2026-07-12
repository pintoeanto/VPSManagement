#!/usr/bin/env bash
# Usage: journalctl_tail.sh <unit> <lines>
# Read-only, bounded journal tail for a whitelisted unit.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$DIR/lib/common.sh"

require_root
require_arg_count 2 "$#"

ALLOWED_UNITS=(nginx mosquitto "wg-quick@wg0" ssh)

unit="$1"
lines="$2"

validate_unit_name "$unit"
if [[ ! "$lines" =~ ^[0-9]+$ ]] || [[ "$lines" -lt 1 ]] || [[ "$lines" -gt 500 ]]; then
  echo "lines must be an integer between 1 and 500" >&2
  exit 2
fi

allowed=0
for u in "${ALLOWED_UNITS[@]}"; do
  if [[ "$u" == "$unit" ]]; then
    allowed=1
    break
  fi
done
if [[ "$allowed" -ne 1 ]]; then
  echo "unit not in allowlist: $unit" >&2
  exit 2
fi

journalctl -u "$unit" -n "$lines" --no-pager --output=short-iso
