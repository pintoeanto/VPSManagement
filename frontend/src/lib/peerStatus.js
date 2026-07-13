// Status colors are the dataviz skill's fixed, validated status palette —
// never themed, never reused for anything but connection state. Shared
// between the explorer sidebar dots and the radar diagram so both always
// agree on what "connected" means.
export const STATUS = {
  good: { color: '#0ca30c', label: 'Connected (<3m)' },
  warning: { color: '#fab219', label: 'Idle (<10m)' },
  critical: { color: '#d03b3b', label: 'Offline / never' },
};

// Exported so views that draw a *continuous* position/color from age (the
// radar) can share the exact same cutoffs peerStatus() uses for the
// discrete good/warning/critical label, instead of duplicating magic
// numbers that could silently drift apart.
export const GOOD_THRESHOLD_SECONDS = 180;
export const WARNING_THRESHOLD_SECONDS = 600;

export function peerStatus(latestHandshake) {
  if (!latestHandshake) return 'critical';
  const ageSeconds = Date.now() / 1000 - Number(latestHandshake);
  if (!Number.isFinite(ageSeconds) || ageSeconds < 0) return 'critical';
  if (ageSeconds <= GOOD_THRESHOLD_SECONDS) return 'good';
  if (ageSeconds <= WARNING_THRESHOLD_SECONDS) return 'warning';
  return 'critical';
}

export function formatHandshake(latestHandshake) {
  if (!latestHandshake) return 'never';
  const date = new Date(Number(latestHandshake) * 1000);
  return date.toLocaleString();
}

// Relative form ("3m ago") for compact displays (topology/list views) where
// a full timestamp doesn't fit — formatHandshake's absolute form is still
// used in the radar's detail tooltip where there's room for it.
export function formatHandshakeAge(latestHandshake) {
  if (!latestHandshake) return 'never';
  const ageSeconds = Date.now() / 1000 - Number(latestHandshake);
  if (!Number.isFinite(ageSeconds) || ageSeconds < 0) return 'never';
  if (ageSeconds < 60) return `${Math.floor(ageSeconds)}s ago`;
  if (ageSeconds < 3600) return `${Math.floor(ageSeconds / 60)}m ago`;
  if (ageSeconds < 86400) return `${Math.floor(ageSeconds / 3600)}h ago`;
  return `${Math.floor(ageSeconds / 86400)}d ago`;
}

const BYTE_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];

export function formatBytes(n) {
  const value = Number(n);
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const exp = Math.min(BYTE_UNITS.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  return `${(value / 1024 ** exp).toFixed(exp === 0 ? 0 : 1)} ${BYTE_UNITS[exp]}`;
}

// Severity order for "worst first" sorting — the ops-triage convention: the
// thing most likely to need attention should sort to the top.
export const STATUS_SEVERITY = { critical: 0, warning: 1, good: 2 };

// A peer whose AllowedIPs has more than one entry is routing something
// beyond just itself (e.g. "10.200.200.13/32, 10.57.0.0/16" — that /16 is a
// whole extra network this peer gateways into), not just a plain client.
export function extraNetworks(allowedIps) {
  if (!allowedIps) return [];
  return allowedIps
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(1);
}

export function isGatewayPeer(allowedIps) {
  return extraNetworks(allowedIps).length > 0;
}

// Fixed set a peer can be tagged with, purely to pick an icon in the
// network views — must match the backend's deviceTypeSchema enum
// (backend/src/catalog/actions/wireguard.js) exactly, since the value is
// validated server-side against this same list.
export const DEVICE_TYPES = [
  { value: 'mobile', label: 'Mobile' },
  { value: 'server', label: 'Server' },
  { value: 'pc', label: 'PC' },
  { value: 'laptop', label: 'Laptop' },
  { value: 'router', label: 'Router' },
];
