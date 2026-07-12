#!/usr/bin/env bash
# Usage: nginx_install.sh
# Idempotent: skips the apt install if nginx is already present, but always
# ensures the shared support directories (fallback error page, ACME webroot)
# exist — those are needed by every route this tool generates, not just new
# installs.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$DIR/lib/common.sh"

require_root
require_arg_count 0 "$#"

already_installed=0
if dpkg -l nginx 2>/dev/null | grep -q '^ii'; then
  already_installed=1
else
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y
  apt-get install -y nginx
  systemctl enable nginx
  systemctl start nginx
fi

# Shared ACME webroot for certbot's webroot method (nginx_certbot_webroot.sh)
# — every generated HTTP vhost has a location pointing here.
mkdir -p /var/www/letsencrypt/.well-known/acme-challenge
chmod 755 /var/www/letsencrypt /var/www/letsencrypt/.well-known /var/www/letsencrypt/.well-known/acme-challenge

# Shared fallback page every generated vhost's error_page 502/503/504 points
# at. Only written if missing so a hand-customized page is never clobbered.
mkdir -p /var/www/vps-console-errors
if [[ ! -f /var/www/vps-console-errors/service-unavailable.html ]]; then
  cat > /var/www/vps-console-errors/service-unavailable.html <<'HTML'
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Service Temporarily Unavailable</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: #f2f2f2; color: #1e1e1e; margin: 0; min-height: 100vh;
    display: flex; align-items: center; justify-content: center; padding: 24px; }
  .card { background: #fff; border: 1px solid #ddd; border-radius: 8px; padding: 36px;
    max-width: 440px; width: 100%; text-align: center; box-shadow: 0 4px 16px rgba(0,0,0,.08); }
  h1 { font-size: 19px; margin: 0 0 10px; }
  p { color: #555; font-size: 14px; line-height: 1.6; margin: 0 0 18px; }
  .meta { font-size: 11px; color: #999; margin-top: 20px; font-family: monospace; }
  button, a.btn { display: inline-block; margin: 4px; padding: 9px 18px; border-radius: 6px;
    border: 1px solid #ccc; background: #fafafa; color: #1e1e1e; text-decoration: none;
    font-size: 13px; cursor: pointer; }
  @media (prefers-color-scheme: dark) {
    body { background: #1a1a1a; color: #eee; }
    .card { background: #242424; border-color: #3a3a3a; }
    p { color: #aaa; }
    button, a.btn { background: #2e2e2e; border-color: #444; color: #eee; }
  }
</style>
</head>
<body>
  <div class="card">
    <h1>Service Temporarily Unavailable</h1>
    <p>The requested application is currently offline or cannot be reached.<br>Please try again shortly.</p>
    <button onclick="location.reload()">Retry</button>
    <div class="meta" id="meta"></div>
  </div>
  <script>
    document.getElementById('meta').textContent =
      'Incident: ' + Date.now().toString(36) + ' — ' + new Date().toISOString();
  </script>
</body>
</html>
HTML
fi
chmod 644 /var/www/vps-console-errors/service-unavailable.html

if [[ "$already_installed" -eq 1 ]]; then
  echo "already installed"
else
  echo "installed"
fi
