#!/usr/bin/env bash
# Usage: service_ctl.sh <unit> <start|stop|restart|enable|disable>
#
# This whitelist is intentionally hardcoded here rather than read from the
# app's .env: this script is root-owned and not writable by the app service
# user, whereas the app's config is. If the allowlist lived in app-writable
# config, a compromised app process could widen its own privileges by editing
# it. Keep this list in sync with ALLOWED_SERVICE_UNITS in backend/.env.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$DIR/lib/common.sh"

require_root
require_arg_count 2 "$#"

ALLOWED_UNITS=(nginx mosquitto "wg-quick@wg0" ssh)

unit="$1"
action="$2"

validate_unit_name "$unit"

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

case "$action" in
  start|stop|restart|enable|disable)
    systemctl "$action" "$unit"
    ;;
  *)
    echo "invalid action: $action" >&2
    exit 2
    ;;
esac

echo "ok"
