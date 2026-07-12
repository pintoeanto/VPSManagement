#!/usr/bin/env bash
# Usage: nginx_install.sh
# Idempotent: does nothing if nginx is already installed.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$DIR/lib/common.sh"

require_root
require_arg_count 0 "$#"

if dpkg -l nginx 2>/dev/null | grep -q '^ii'; then
  echo "already installed"
  exit 0
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y nginx
systemctl enable nginx
systemctl start nginx
echo "installed"
