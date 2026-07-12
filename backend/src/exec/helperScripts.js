import path from 'node:path';
import { config } from '../config.js';

/**
 * Fixed allowlist of root-owned helper scripts this app is permitted to invoke
 * via sudo. This is the single choke point that maps a symbolic name to an
 * on-disk script path — action code never builds a script path from user input.
 * The corresponding sudoers file (deploy/sudoers/vps-console.sudoers) grants
 * NOPASSWD only for these exact absolute paths.
 */
export const HELPER_SCRIPTS = Object.freeze({
  NGINX_INSTALL: 'nginx_install.sh',
  NGINX_CONFIGURE: 'nginx_configure.sh',
  NGINX_CERTBOT: 'nginx_certbot.sh',
  NGINX_CERTBOT_WEBROOT: 'nginx_certbot_webroot.sh',
  PORT_CHECK: 'port_check.sh',
  WIREGUARD_INSTALL: 'wireguard_install.sh',
  WIREGUARD_PEER_ADD: 'wireguard_peer_add.sh',
  WIREGUARD_PEER_REMOVE: 'wireguard_peer_remove.sh',
  WIREGUARD_STATUS: 'wireguard_status.sh',
  WIREGUARD_CONFIG: 'wireguard_config.sh',
  MOSQUITTO_INSTALL: 'mosquitto_install.sh',
  MOSQUITTO_CONFIGURE: 'mosquitto_configure.sh',
  NODEJS_INSTALL: 'nodejs_install.sh',
  SERVICE_CTL: 'service_ctl.sh',
  JOURNALCTL_TAIL: 'journalctl_tail.sh',
  SYSTEM_UPDATE: 'system_update.sh',
  UFW_RULE: 'ufw_rule.sh',
});

export function resolveHelperPath(key) {
  const filename = HELPER_SCRIPTS[key];
  if (!filename) {
    throw new Error(`Unknown helper script key: ${key}`);
  }
  return path.join(config.helperScriptsDir, filename);
}
