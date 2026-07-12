#!/usr/bin/env bash
# Usage:
#   ufw_rule.sh status
#   ufw_rule.sh allow <port> <tcp|udp>
#   ufw_rule.sh deny <port> <tcp|udp>
#   ufw_rule.sh delete-allow <port> <tcp|udp>
#   ufw_rule.sh delete-deny <port> <tcp|udp>
# No raw ufw command passthrough — only these five fixed shapes.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$DIR/lib/common.sh"

require_root

subcommand="$1"

case "$subcommand" in
  status)
    require_arg_count 1 "$#"
    ufw status verbose
    ;;
  allow|deny|delete-allow|delete-deny)
    require_arg_count 3 "$#"
    port="$2"
    proto="$3"
    if [[ ! "$port" =~ ^[0-9]+$ ]] || [[ "$port" -lt 1 ]] || [[ "$port" -gt 65535 ]]; then
      echo "invalid port: $port" >&2
      exit 2
    fi
    if [[ "$proto" != "tcp" && "$proto" != "udp" ]]; then
      echo "invalid proto: $proto" >&2
      exit 2
    fi
    case "$subcommand" in
      allow) ufw allow "${port}/${proto}" ;;
      deny) ufw deny "${port}/${proto}" ;;
      delete-allow) ufw delete allow "${port}/${proto}" ;;
      delete-deny) ufw delete deny "${port}/${proto}" ;;
    esac
    ;;
  *)
    echo "invalid subcommand: $subcommand" >&2
    exit 2
    ;;
esac
