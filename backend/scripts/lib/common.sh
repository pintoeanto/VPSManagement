#!/usr/bin/env bash
# Shared helpers sourced by every root-owned helper script in this directory.
# This file must be root-owned, not writable by the app service user.
set -euo pipefail

require_root() {
  if [[ "$(id -u)" -ne 0 ]]; then
    echo "must be run as root (via sudo)" >&2
    exit 1
  fi
}

# backup_file <path>
# Copies <path> to <path>.bak.<timestamp> if it exists. Prints the backup path
# (empty string if there was nothing to back up) to stdout on its own line.
backup_file() {
  local target="$1"
  if [[ -f "$target" ]]; then
    local ts
    ts="$(date -u +%Y%m%dT%H%M%SZ)"
    local backup="${target}.bak.${ts}"
    cp -p "$target" "$backup"
    echo "$backup"
  else
    echo ""
  fi
}

# restore_backup <path> <backup>
restore_backup() {
  local target="$1"
  local backup="$2"
  if [[ -n "$backup" && -f "$backup" ]]; then
    cp -p "$backup" "$target"
  fi
}

# atomic_write <target_path>
# Reads new content from stdin, writes it to a temp file in the same
# directory as target, then renames it into place (atomic on the same fs).
atomic_write() {
  local target="$1"
  local dir
  dir="$(dirname "$target")"
  local tmp
  tmp="$(mktemp "${dir}/.tmp.XXXXXX")"
  cat > "$tmp"
  chmod --reference="$target" "$tmp" 2>/dev/null || chmod 644 "$tmp"
  mv -f "$tmp" "$target"
}

# require_arg_count <expected> <actual>
require_arg_count() {
  local expected="$1"
  local actual="$2"
  if [[ "$actual" -ne "$expected" ]]; then
    echo "wrong argument count: expected $expected, got $actual" >&2
    exit 2
  fi
}

# validate_unit_name <name>
# Systemd unit names we accept: alnum, @, -, _, ., must not start with '-' or contain '/'.
validate_unit_name() {
  local name="$1"
  if [[ ! "$name" =~ ^[A-Za-z0-9@._-]+$ ]]; then
    echo "invalid unit name: $name" >&2
    exit 2
  fi
}

# validate_safe_token <value>
# Generic conservative allowlist for identifiers we interpolate into paths
# (peer names, listener names, etc.): alnum, dash, underscore, dot. No slashes.
validate_safe_token() {
  local value="$1"
  if [[ ! "$value" =~ ^[A-Za-z0-9._-]+$ ]]; then
    echo "invalid token: $value" >&2
    exit 2
  fi
}

# validate_wg_interface_name <name>
# WireGuard interface names this tool manages are restricted to the wgN
# convention (wg0, wg1, ...) — tighter than validate_safe_token since this
# value is interpolated into `wg show <name>`, `wg-quick strip <name>`, and
# a systemd unit name (wg-quick@<name>).
validate_wg_interface_name() {
  local value="$1"
  if [[ ! "$value" =~ ^wg[0-9]{1,3}$ ]]; then
    echo "invalid interface name: $value (expected wgN)" >&2
    exit 2
  fi
}
