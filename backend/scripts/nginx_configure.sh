#!/usr/bin/env bash
# Usage:
#   nginx_configure.sh apply <name> <static|proxy> <listenPort> [proxyPassUrl]
#   nginx_configure.sh setraw <name>          (new content read from stdin)
#   nginx_configure.sh remove <name>
#   nginx_configure.sh list
#   nginx_configure.sh get <name>
#   nginx_configure.sh listbackups <name>
#   nginx_configure.sh getbackup <name> <backupFilename>
#   nginx_configure.sh restore <name> <backupFilename>
#   nginx_configure.sh test
#
# <name> is the literal filename under sites-available/sites-enabled — NGINX
# doesn't require any particular extension, and this manages both configs
# created through this tool and any pre-existing hand-written vhosts (e.g.
# "cupo-route-alfattan" with no ".conf" suffix) identically, by filename.
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

validate_site_name() {
  local name="$1"
  if [[ ! "$name" =~ ^[A-Za-z0-9]([A-Za-z0-9._-]{0,120}[A-Za-z0-9])?$ ]]; then
    echo "invalid site name: $name" >&2
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

# validate_and_activate <target> <link> <backup> <link_existed>
# Shared rollback logic for anything that just wrote $target and possibly
# created $link: runs `nginx -t`, and on failure restores the previous state
# exactly as it was before this invocation.
validate_and_activate() {
  local target="$1" link="$2" backup="$3" link_existed="$4"
  local test_err
  test_err="$(mktemp)"
  if ! nginx -t 2>"$test_err"; then
    local err
    err="$(cat "$test_err")"
    rm -f "$test_err"
    if [[ -n "$backup" ]]; then
      restore_backup "$target" "$backup"
    else
      rm -f "$target"
    fi
    if [[ "$link_existed" -eq 0 ]]; then
      rm -f "$link"
    fi
    echo "nginx -t failed, rolled back: $err" >&2
    return 1
  fi
  rm -f "$test_err"
  reload_or_start_nginx
  return 0
}

subcommand="${1:-}"

case "$subcommand" in
  apply)
    if [[ "$#" -lt 4 || "$#" -gt 5 ]]; then
      echo "apply requires 3 or 4 arguments" >&2
      exit 2
    fi
    name="$2"
    mode="$3"
    listen_port="$4"
    proxy_pass="${5:-}"

    validate_site_name "$name"
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

    target="${SITES_AVAILABLE}/${name}"
    link="${SITES_ENABLED}/${name}"
    mkdir -p "$SITES_AVAILABLE" "$SITES_ENABLED"

    backup="$(backup_file "$target")"
    link_existed=0
    [[ -L "$link" ]] && link_existed=1

    if [[ "$mode" == "static" ]]; then
      doc_root="${WEBROOT_BASE}/${name}"
      mkdir -p "$doc_root"
      chown www-data:www-data "$doc_root" 2>/dev/null || true
      sed \
        -e "s#__SERVER_NAME__#${name}#g" \
        -e "s#__LISTEN_PORT__#${listen_port}#g" \
        -e "s#__DOC_ROOT__#${doc_root}#g" \
        "${TEMPLATES_DIR}/nginx-server-static.conf.tmpl" | atomic_write "$target"
    else
      sed \
        -e "s#__SERVER_NAME__#${name}#g" \
        -e "s#__LISTEN_PORT__#${listen_port}#g" \
        -e "s#__PROXY_PASS__#${proxy_pass}#g" \
        "${TEMPLATES_DIR}/nginx-server-proxy.conf.tmpl" | atomic_write "$target"
    fi

    if [[ "$link_existed" -eq 0 ]]; then
      ln -s "$target" "$link"
    fi

    validate_and_activate "$target" "$link" "$backup" "$link_existed"
    echo "ok"
    ;;

  setraw)
    require_arg_count 2 "$#"
    name="$2"
    validate_site_name "$name"

    target="${SITES_AVAILABLE}/${name}"
    link="${SITES_ENABLED}/${name}"
    mkdir -p "$SITES_AVAILABLE" "$SITES_ENABLED"

    backup="$(backup_file "$target")"
    link_existed=0
    [[ -L "$link" ]] && link_existed=1

    atomic_write "$target"   # new content read from stdin by the caller

    if [[ "$link_existed" -eq 0 ]]; then
      ln -s "$target" "$link"
    fi

    validate_and_activate "$target" "$link" "$backup" "$link_existed"
    echo "ok"
    ;;

  remove)
    require_arg_count 2 "$#"
    name="$2"
    validate_site_name "$name"
    link="${SITES_ENABLED}/${name}"
    if [[ ! -L "$link" ]]; then
      echo "not enabled"
      exit 0
    fi
    rm -f "$link"
    test_err="$(mktemp)"
    if ! nginx -t 2>"$test_err"; then
      err="$(cat "$test_err")"
      rm -f "$test_err"
      ln -s "${SITES_AVAILABLE}/${name}" "$link"
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
    for f in "${SITES_AVAILABLE}"/*; do
      [[ -f "$f" ]] || continue
      name="$(basename "$f")"
      if [[ -L "${SITES_ENABLED}/${name}" ]]; then
        echo -e "${name}\t1"
      else
        echo -e "${name}\t0"
      fi
    done
    ;;

  get)
    require_arg_count 2 "$#"
    name="$2"
    validate_site_name "$name"
    target="${SITES_AVAILABLE}/${name}"
    if [[ ! -f "$target" ]]; then
      exit 1
    fi
    cat "$target"
    ;;

  listbackups)
    require_arg_count 2 "$#"
    name="$2"
    validate_site_name "$name"
    shopt -s nullglob
    for f in "${SITES_AVAILABLE}/${name}.bak."*; do
      [[ -f "$f" ]] || continue
      basename "$f"
    done
    ;;

  getbackup)
    require_arg_count 3 "$#"
    name="$2"
    backup_name="$3"
    validate_site_name "$name"
    if [[ ! "$backup_name" =~ ^${name//./\\.}\.bak\.[0-9]{8}T[0-9]{6}Z$ ]]; then
      echo "invalid backup filename: $backup_name" >&2
      exit 2
    fi
    target="${SITES_AVAILABLE}/${backup_name}"
    if [[ ! -f "$target" ]]; then
      exit 1
    fi
    cat "$target"
    ;;

  restore)
    require_arg_count 3 "$#"
    name="$2"
    backup_name="$3"
    validate_site_name "$name"
    if [[ ! "$backup_name" =~ ^${name//./\\.}\.bak\.[0-9]{8}T[0-9]{6}Z$ ]]; then
      echo "invalid backup filename: $backup_name" >&2
      exit 2
    fi
    backup_source="${SITES_AVAILABLE}/${backup_name}"
    if [[ ! -f "$backup_source" ]]; then
      echo "backup not found: $backup_name" >&2
      exit 1
    fi

    target="${SITES_AVAILABLE}/${name}"
    link="${SITES_ENABLED}/${name}"
    mkdir -p "$SITES_AVAILABLE" "$SITES_ENABLED"

    # Restoring still backs up whatever is currently live first, so a
    # restore is itself undoable the same way any other change is.
    backup="$(backup_file "$target")"
    link_existed=0
    [[ -L "$link" ]] && link_existed=1

    cat "$backup_source" | atomic_write "$target"

    if [[ "$link_existed" -eq 0 ]]; then
      ln -s "$target" "$link"
    fi

    validate_and_activate "$target" "$link" "$backup" "$link_existed"
    echo "ok"
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
