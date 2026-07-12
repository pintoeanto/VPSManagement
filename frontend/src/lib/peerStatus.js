// Status colors are the dataviz skill's fixed, validated status palette —
// never themed, never reused for anything but connection state. Shared
// between the explorer sidebar dots and the radar diagram so both always
// agree on what "connected" means.
export const STATUS = {
  good: { color: '#0ca30c', label: 'Connected (<3m)' },
  warning: { color: '#fab219', label: 'Idle (<10m)' },
  critical: { color: '#d03b3b', label: 'Offline / never' },
};

export function peerStatus(latestHandshake) {
  if (!latestHandshake) return 'critical';
  const ageSeconds = Date.now() / 1000 - Number(latestHandshake);
  if (!Number.isFinite(ageSeconds) || ageSeconds < 0) return 'critical';
  if (ageSeconds <= 180) return 'good';
  if (ageSeconds <= 600) return 'warning';
  return 'critical';
}

export function formatHandshake(latestHandshake) {
  if (!latestHandshake) return 'never';
  const date = new Date(Number(latestHandshake) * 1000);
  return date.toLocaleString();
}

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
