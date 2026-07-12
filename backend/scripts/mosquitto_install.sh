#!/usr/bin/env bash
# Usage: mosquitto_install.sh
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$DIR/lib/common.sh"

require_root
require_arg_count 0 "$#"

if dpkg -l mosquitto 2>/dev/null | grep -q '^ii'; then
  echo "already installed"
  exit 0
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y mosquitto mosquitto-clients
systemctl enable mosquitto
systemctl start mosquitto
mkdir -p /etc/mosquitto/conf.d
echo "installed"
