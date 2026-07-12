#!/usr/bin/env bash
# Usage:
#   nginx_configure.sh apply <serverName> <static|proxy> <listenPort> [proxyPassUrl]
#   nginx_configure.sh remove <serverName>
#   nginx_configure.sh list
#   nginx_configure.sh get <serverName>
#   nginx_configure.sh test
#
# Idempotent, backs up before writing, validates with `nginx -t` before ever
# reloading, and restores the previous state if validation fails.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$DIR/lib/common.sh"

require_root

SITES_AVAILABLE=/etc/nginx/sites-available
SITES_ENABLED=/etc/nginx/sites-enabled
TEMPLATES_DIR="$DIR/templates"
WEBROOT_BASE=/var/www

validate_server_name() {
  local name="$1"
  if [[ ! "$name" =~ ^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$ ]]; then
    echo "invalid server name: $name" >&2
    exit 2
  fi
}

reload_or_start_nginx() {
  if systemctl is-active --quiet nginx; then
    systemctl reload nginx
  else
    systemctl start nginx
  fi
}

subcommand="${1:-}"

case "$subcommand" in
  apply)
    if [[ "$#" -lt 4 || "$#" -gt 5 ]]; then
      echo "apply requires 3 or 4 arguments" >&2
      exit 2
    fi
    server_name="$2"
    mode="$3"
    listen_port="$4"
    proxy_pass="${5:-}"

    validate_server_name "$server_name"
    if [[ "$mode" != "static" && "$mode" != "proxy" ]]; then
      echo "invalid mode: $mode" >&2
      exit 2
    fi
    if [[ ! "$listen_port" =~ ^[0-9]+$ ]] || [[ "$listen_port" -lt 1 ]] || [[ "$listen_port" -gt 65535 ]]; then
      echo "invalid listen port: $listen_port" >&2
      exit 2
    fi
    if [[ "$mode" == "proxy" ]]; then
      if [[ ! "$proxy_pass" =~ ^https?://[A-Za-z0-9.:_-]+(/.*)?$ ]]; then
        echo "invalid proxyPass: $proxy_pass" >&2
        exit 2
      fi
    fi

    target="${SITES_AVAILABLE}/${server_name}.conf"
    link="${SITES_ENABLED}/${server_name}.conf"
    mkdir -p "$SITES_AVAILABLE" "$SITES_ENABLED"

    backup="$(backup_file "$target")"
    link_existed=0
    [[ -L "$link" ]] && link_existed=1

    if [[ "$mode" == "static" ]]; then
      doc_root="${WEBROOT_BASE}/${server_name}"
      mkdir -p "$doc_root"
      chown www-data:www-data "$doc_root" 2>/dev/null || true
      sed \
        -e "s#__SERVER_NAME__#${server_name}#g" \
        -e "s#__LISTEN_PORT__#${listen_port}#g" \
        -e "s#__DOC_ROOT__#${doc_root}#g" \
        "${TEMPLATES_DIR}/nginx-server-static.conf.tmpl" | atomic_write "$target"
    else
      sed \
        -e "s#__SERVER_NAME__#${server_name}#g" \
        -e "s#__LISTEN_PORT__#${listen_port}#g" \
        -e "s#__PROXY_PASS__#${proxy_pass}#g" \
        "${TEMPLATES_DIR}/nginx-server-proxy.conf.tmpl" | atomic_write "$target"
    fi

    if [[ "$link_existed" -eq 0 ]]; then
      ln -s "$target" "$link"
    fi

    test_err="$(mktemp)"
    if ! nginx -t 2>"$test_err"; then
      err="$(cat "$test_err")"
      rm -f "$test_err"
      # Roll back: restore previous config (or remove if it's new), remove symlink if we just created it.
      if [[ -n "$backup" ]]; then
        restore_backup "$target" "$backup"
      else
        rm -f "$target"
      fi
      if [[ "$link_existed" -eq 0 ]]; then
        rm -f "$link"
      fi
      echo "nginx -t failed, rolled back: $err" >&2
      exit 1
    fi
    rm -f "$test_err"

    reload_or_start_nginx
    echo "ok"
    ;;

  remove)
    require_arg_count 2 "$#"
    server_name="$2"
    validate_server_name "$server_name"
    link="${SITES_ENABLED}/${server_name}.conf"
    if [[ ! -L "$link" ]]; then
      echo "not enabled"
      exit 0
    fi
    rm -f "$link"
    test_err="$(mktemp)"
    if ! nginx -t 2>"$test_err"; then
      err="$(cat "$test_err")"
      rm -f "$test_err"
      ln -s "${SITES_AVAILABLE}/${server_name}.conf" "$link"
      echo "nginx -t failed after removal, rolled back: $err" >&2
      exit 1
    fi
    rm -f "$test_err"
    reload_or_start_nginx
    echo "ok"
    ;;

  list)
    require_arg_count 1 "$#"
    mkdir -p "$SITES_AVAILABLE" "$SITES_ENABLED"
    shopt -s nullglob
    for f in "${SITES_AVAILABLE}"/*.conf; do
      name="$(basename "$f" .conf)"
      if [[ -L "${SITES_ENABLED}/${name}.conf" ]]; then
        echo -e "${name}\t1"
      else
        echo -e "${name}\t0"
      fi
    done
    ;;

  get)
    require_arg_count 2 "$#"
    server_name="$2"
    validate_server_name "$server_name"
    target="${SITES_AVAILABLE}/${server_name}.conf"
    if [[ ! -f "$target" ]]; then
      exit 1
    fi
    cat "$target"
    ;;

  test)
    require_arg_count 1 "$#"
    nginx -t
    ;;

  *)
    echo "invalid subcommand: $subcommand" >&2
    exit 2
    ;;
esac
