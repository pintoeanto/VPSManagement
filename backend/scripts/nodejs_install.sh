#!/usr/bin/env bash
# Usage: nodejs_install.sh <majorVersion>
# Installs a pinned Node.js LTS major version via the official NodeSource
# apt repository setup script. The major version is strictly validated as an
# integer before it ever touches the download URL. The setup script is
# downloaded to a file and inspected for a nonzero size / HTTP success before
# being executed, rather than piped directly from curl to bash.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$DIR/lib/common.sh"

require_root
require_arg_count 1 "$#"

major="$1"
if [[ ! "$major" =~ ^[0-9]{1,2}$ ]] || [[ "$major" -lt 12 ]] || [[ "$major" -gt 99 ]]; then
  echo "invalid major version: $major" >&2
  exit 2
fi

setup_script="$(mktemp)"
trap 'rm -f "$setup_script"' EXIT

if ! curl -fsSL "https://deb.nodesource.com/setup_${major}.x" -o "$setup_script"; then
  echo "failed to download NodeSource setup script for major ${major}" >&2
  exit 1
fi
if [[ ! -s "$setup_script" ]]; then
  echo "downloaded NodeSource setup script is empty" >&2
  exit 1
fi

bash "$setup_script"

export DEBIAN_FRONTEND=noninteractive
apt-get install -y nodejs

echo "ok"
