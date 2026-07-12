#!/usr/bin/env bash
# Usage: port_check.sh <port>
# Read-only. Prints one line per process listening on the given TCP port
# (process name/PID included), or nothing if none. Needs root to see other
# users' process names via `ss -p`, which is why this goes through the
# sudo-scoped helper path rather than being a plain unprivileged read.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$DIR/lib/common.sh"

require_root
require_arg_count 1 "$#"

port="$1"
if [[ ! "$port" =~ ^[0-9]+$ ]] || [[ "$port" -lt 1 ]] || [[ "$port" -gt 65535 ]]; then
  echo "invalid port: $port" >&2
  exit 2
fi

ss -H -ltnp "sport = :${port}" 2>/dev/null || true
