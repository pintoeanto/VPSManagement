#!/usr/bin/env bash
# Usage: system_update.sh update|upgrade
#   update  - apt-get update only
#   upgrade - apt-get update && DEBIAN_FRONTEND=noninteractive apt-get upgrade -y
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$DIR/lib/common.sh"

require_root
require_arg_count 1 "$#"

mode="$1"
export DEBIAN_FRONTEND=noninteractive

case "$mode" in
  update)
    apt-get update -y
    ;;
  upgrade)
    apt-get update -y
    apt-get upgrade -y -o Dpkg::Options::="--force-confold"
    ;;
  *)
    echo "invalid mode: $mode" >&2
    exit 2
    ;;
esac

echo "ok"
