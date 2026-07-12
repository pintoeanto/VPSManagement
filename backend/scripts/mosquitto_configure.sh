#!/usr/bin/env bash
# Usage:
#   mosquitto_configure.sh listener <port> <allowAnonymous:0|1> <tlsEnabled:0|1> [certPath] [keyPath]
#   mosquitto_configure.sh adduser <username> <password>
#   mosquitto_configure.sh removeuser <username>
#   mosquitto_configure.sh listusers
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$DIR/lib/common.sh"

require_root

CONF_DIR=/etc/mosquitto/conf.d
LISTENER_CONF="${CONF_DIR}/vps-console-listener.conf"
PASSWD_FILE=/etc/mosquitto/vps-console-passwd

# Validates a candidate mosquitto config file by launching mosquitto briefly
# against a copy with the listener port swapped to a private test port, so it
# doesn't collide with the live broker. mosquitto has no dedicated
# "check config" mode, so we treat "ran without immediately exiting" (timeout
# reached = exit 124) as valid, and any other exit as a syntax/bind error.
validate_config() {
  local candidate="$1"
  local test_conf
  test_conf="$(mktemp)"
  sed -E 's/^([[:space:]]*port[[:space:]]+)[0-9]+/\118883/' "$candidate" > "$test_conf"

  local out
  set +e
  out="$(timeout 2 mosquitto -c "$test_conf" -v 2>&1)"
  local code=$?
  set -e
  rm -f "$test_conf"

  if [[ "$code" -ne 124 && "$code" -ne 0 ]]; then
    echo "$out" >&2
    return 1
  fi
  return 0
}

reload_mosquitto() {
  systemctl kill -s HUP mosquitto 2>/dev/null || systemctl restart mosquitto
}

restart_mosquitto() {
  systemctl restart mosquitto
}

subcommand="${1:-}"
mkdir -p "$CONF_DIR"

case "$subcommand" in
  listener)
    if [[ "$#" -lt 4 || "$#" -gt 6 ]]; then
      echo "listener requires 3-5 arguments" >&2
      exit 2
    fi
    port="$2"
    allow_anon="$3"
    tls_enabled="$4"
    cert_path="${5:-}"
    key_path="${6:-}"

    if [[ ! "$port" =~ ^[0-9]+$ ]] || [[ "$port" -lt 1 ]] || [[ "$port" -gt 65535 ]]; then
      echo "invalid port: $port" >&2
      exit 2
    fi
    if [[ "$allow_anon" != "0" && "$allow_anon" != "1" ]]; then
      echo "invalid allowAnonymous: $allow_anon" >&2
      exit 2
    fi
    if [[ "$tls_enabled" != "0" && "$tls_enabled" != "1" ]]; then
      echo "invalid tlsEnabled: $tls_enabled" >&2
      exit 2
    fi

    if [[ "$tls_enabled" == "1" ]]; then
      if [[ -z "$cert_path" || -z "$key_path" ]]; then
        echo "certPath and keyPath required when tlsEnabled=1" >&2
        exit 2
      fi
      if [[ ! "$cert_path" =~ ^/[A-Za-z0-9._/-]+$ ]] || [[ ! "$key_path" =~ ^/[A-Za-z0-9._/-]+$ ]]; then
        echo "invalid cert/key path" >&2
        exit 2
      fi
    fi

    candidate="$(mktemp)"
    {
      echo "listener ${port}"
      if [[ "$tls_enabled" == "1" ]]; then
        echo "certfile ${cert_path}"
        echo "keyfile ${key_path}"
      fi
      if [[ "$allow_anon" == "1" ]]; then
        echo "allow_anonymous true"
      else
        echo "allow_anonymous false"
        if [[ -f "$PASSWD_FILE" ]]; then
          echo "password_file ${PASSWD_FILE}"
        fi
      fi
    } > "$candidate"

    if ! validate_config "$candidate"; then
      rm -f "$candidate"
      echo "mosquitto config validation failed" >&2
      exit 1
    fi

    backup="$(backup_file "$LISTENER_CONF")"
    atomic_write "$LISTENER_CONF" < "$candidate"
    rm -f "$candidate"

    if ! validate_config "$LISTENER_CONF"; then
      restore_backup "$LISTENER_CONF" "$backup"
      echo "mosquitto config invalid after write, rolled back" >&2
      exit 1
    fi

    restart_mosquitto
    echo "ok"
    ;;

  adduser)
    require_arg_count 3 "$#"
    username="$2"
    password="$3"
    validate_safe_token "$username"
    if [[ -z "$password" ]]; then
      echo "password must not be empty" >&2
      exit 2
    fi
    touch "$PASSWD_FILE"
    chmod 600 "$PASSWD_FILE"
    mosquitto_passwd -b "$PASSWD_FILE" "$username" "$password"
    if ! grep -q "^password_file ${PASSWD_FILE}\$" "$LISTENER_CONF" 2>/dev/null; then
      echo "password_file ${PASSWD_FILE}" >> "$LISTENER_CONF"
    fi
    reload_mosquitto
    echo "ok"
    ;;

  removeuser)
    require_arg_count 2 "$#"
    username="$2"
    validate_safe_token "$username"
    if [[ ! -f "$PASSWD_FILE" ]]; then
      echo "not found"
      exit 0
    fi
    mosquitto_passwd -D "$PASSWD_FILE" "$username" || true
    reload_mosquitto
    echo "ok"
    ;;

  listusers)
    require_arg_count 1 "$#"
    if [[ -f "$PASSWD_FILE" ]]; then
      cut -d: -f1 "$PASSWD_FILE"
    fi
    ;;

  *)
    echo "invalid subcommand: $subcommand" >&2
    exit 2
    ;;
esac
