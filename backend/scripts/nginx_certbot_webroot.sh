#!/usr/bin/env bash
# Usage: nginx_certbot_webroot.sh <hostname> <email>
#
# Issues/renews a cert via the webroot method — this does NOT touch nginx
# config at all (unlike `certbot --nginx`, whose automatic vhost-editing we
# found unpredictable on real-world hand-edited configs). It just drops a
# challenge file under WEBROOT and expects an NGINX location already
# serving that path (see nginx_configure.sh's ACME challenge location,
# always present in every generated HTTP block). Never stops NGINX.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$DIR/lib/common.sh"

require_root
require_arg_count 2 "$#"

hostname="$1"
email="$2"
WEBROOT=/var/www/letsencrypt

if [[ ! "$hostname" =~ ^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$ ]]; then
  echo "invalid hostname: $hostname" >&2
  exit 2
fi
if [[ ! "$email" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]]; then
  echo "invalid email: $email" >&2
  exit 2
fi

mkdir -p "${WEBROOT}/.well-known/acme-challenge"
chmod 755 "$WEBROOT" "${WEBROOT}/.well-known" "${WEBROOT}/.well-known/acme-challenge"

if ! command -v certbot >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y
  apt-get install -y certbot
fi

certbot certonly --webroot -w "$WEBROOT" -d "$hostname" -m "$email" --agree-tos -n

cert_path="/etc/letsencrypt/live/${hostname}/fullchain.pem"
key_path="/etc/letsencrypt/live/${hostname}/privkey.pem"
if [[ ! -f "$cert_path" || ! -f "$key_path" ]]; then
  echo "certbot reported success but certificate files are missing" >&2
  exit 1
fi

expiry="$(openssl x509 -enddate -noout -in "$cert_path" 2>/dev/null | sed 's/notAfter=//')"
echo "CERT_PATH=${cert_path}"
echo "KEY_PATH=${key_path}"
echo "EXPIRY=${expiry}"
