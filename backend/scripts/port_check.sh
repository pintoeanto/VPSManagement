#!/usr/bin/env bash
# Usage: port_check.sh <port> [tcp|udp]
# Read-only. Prints one line per process listening on the given port
# (process name/PID included), or nothing if none. Protocol defaults to tcp
# — WireGuard listen ports are udp, so callers checking those must pass it
# explicitly. Needs root to see other users' process names via `ss -p`,
# which is why this goes through the sudo-scoped helper path rather than
# being a plain unprivileged read.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$DIR/lib/common.sh"

require_root

port="$1"
protocol="${2:-tcp}"
if [[ ! "$port" =~ ^[0-9]+$ ]] || [[ "$port" -lt 1 ]] || [[ "$port" -gt 65535 ]]; then
  echo "invalid port: $port" >&2
  exit 2
fi
if [[ "$protocol" != "tcp" && "$protocol" != "udp" ]]; then
  echo "invalid protocol: $protocol (expected tcp or udp)" >&2
  exit 2
fi

if [[ "$protocol" == "udp" ]]; then
  ss -H -lunp "sport = :${port}" 2>/dev/null || true
else
  ss -H -ltnp "sport = :${port}" 2>/dev/null || true
fi
