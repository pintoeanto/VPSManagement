#!/usr/bin/env bash
# Usage:
#   wireguard_config.sh get <interfaceName>
#   wireguard_config.sh setraw <interfaceName>   (new content read from stdin)
#   wireguard_config.sh test <interfaceName>
#
# get returns the raw <interfaceName>.conf content as-is (including the real
# private key) — redaction of that value before it ever reaches the browser is
# the Node layer's job (catalog/actions/wireguard.js), since this script's
# output only ever travels over the already-root-trusted sudo pipe, not the
# network.
#
# setraw is the reverse: if the submitted content's PrivateKey line is the
# redaction sentinel "<REDACTED>" (i.e. the browser echoed back what it was
# shown, unchanged), this splices the CURRENT real private key back in
# before writing, so the real key never has to round-trip through the
# browser for a normal edit. Deliberately supplying a real key value instead
# of the sentinel still works — that's how you'd rotate it.
#
# test validates the config on disk (wg-quick strip, no changes applied) —
# used for the tunnel diagnostic check, mirroring nginx's `nginx -t`.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$DIR/lib/common.sh"

require_root

SENTINEL='<REDACTED>'

subcommand="${1:-}"

case "$subcommand" in
  get)
    require_arg_count 2 "$#"
    name="$2"
    validate_wg_interface_name "$name"
    conf="/etc/wireguard/${name}.conf"
    if [[ ! -f "$conf" ]]; then
      exit 1
    fi
    cat "$conf"
    ;;

  setraw)
    require_arg_count 2 "$#"
    name="$2"
    validate_wg_interface_name "$name"
    conf="/etc/wireguard/${name}.conf"
    if [[ ! -f "$conf" ]]; then
      echo "${name}.conf does not exist; run wireguard.initInterface first" >&2
      exit 1
    fi

    # WireGuard's own config parser matches key names case-insensitively
    # (real-world configs on this box mix "PublicKey"/"publicKey"), so
    # key-line matching here has to tolerate that too, not just the
    # canonical case.
    current_privkey="$(grep -i '^privatekey' "$conf" | head -1 | sed -E 's/^[Pp]rivate[Kk]ey[[:space:]]*=[[:space:]]*//' || true)"

    backup="$(backup_file "$conf")"
    sed -E "s#^[Pp]rivate[Kk]ey[[:space:]]*=[[:space:]]*${SENTINEL}\$#PrivateKey = ${current_privkey}#" | atomic_write "$conf"
    chmod 600 "$conf"

    if ! stripped="$(wg-quick strip "$name" 2>&1)"; then
      restore_backup "$conf" "$backup"
      echo "wg config invalid, rolled back: $stripped" >&2
      exit 1
    fi

    if wg show "$name" >/dev/null 2>&1; then
      sync_err="$(mktemp)"
      if ! echo "$stripped" | wg syncconf "$name" /dev/stdin 2>"$sync_err"; then
        err="$(cat "$sync_err")"
        rm -f "$sync_err"
        restore_backup "$conf" "$backup"
        echo "wg syncconf failed, rolled back: $err" >&2
        exit 1
      fi
      rm -f "$sync_err"
    fi

    echo "ok"
    ;;

  test)
    require_arg_count 2 "$#"
    name="$2"
    validate_wg_interface_name "$name"
    conf="/etc/wireguard/${name}.conf"
    if [[ ! -f "$conf" ]]; then
      echo "config file not found: $conf" >&2
      exit 1
    fi
    wg-quick strip "$conf" >/dev/null
    echo "ok"
    ;;

  *)
    echo "invalid subcommand: $subcommand" >&2
    exit 2
    ;;
esac
