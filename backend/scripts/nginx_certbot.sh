#!/usr/bin/env bash
# Usage: nginx_certbot.sh <serverName> <email>
# Installs certbot + the nginx plugin if missing, then issues/renews a cert
# non-interactively for the given server_name via the certbot nginx plugin
# (which edits the vhost itself and reloads nginx only after validating).
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$DIR/lib/common.sh"

require_root
require_arg_count 2 "$#"

server_name="$1"
email="$2"

if [[ ! "$server_name" =~ ^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$ ]]; then
  echo "invalid server name: $server_name" >&2
  exit 2
fi
if [[ ! "$email" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]]; then
  echo "invalid email: $email" >&2
  exit 2
fi

if ! command -v certbot >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y
  apt-get install -y certbot python3-certbot-nginx
fi

certbot --nginx -d "$server_name" -m "$email" --agree-tos -n --redirect
echo "ok"
