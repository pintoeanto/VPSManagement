import { serviceActions } from './actions/service.js';
import { systemActions } from './actions/system.js';
import { nginxActions } from './actions/nginx.js';
import { wireguardActions } from './actions/wireguard.js';
import { mosquittoActions } from './actions/mosquitto.js';
import { nodejsActions } from './actions/nodejs.js';

const registry = new Map();

function register(actions) {
  for (const action of actions) {
    if (registry.has(action.id)) {
      throw new Error(`Duplicate action id registered: ${action.id}`);
    }
    registry.set(action.id, action);
  }
}

register(serviceActions);
register(systemActions);
register(nginxActions);
register(wireguardActions);
register(mosquittoActions);
register(nodejsActions);

export function getAction(id) {
  return registry.get(id);
}

export function listActions() {
  return [...registry.values()].map(({ id, category, label, mutating }) => ({
    id,
    category,
    label,
    mutating,
  }));
}
