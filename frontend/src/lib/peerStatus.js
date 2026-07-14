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

// A peer's total data transfer (both directions) — the raw quantity every
// "data consumption" indicator (radar ring, topology bar) is a share of.
export function peerTransferBytes(peer) {
  return (Number(peer.rxBytes) || 0) + (Number(peer.txBytes) || 0);
}

// Each peer's share of the tunnel's total rx+tx bytes, as a 0..1 fraction —
// computed once for the whole peer set so every view that draws a
// consumption indicator (the radar's ring, the topology's bar) agrees on
// the same percentage instead of each computing its own total.
export function consumptionFractions(peers) {
  const total = peers.reduce((sum, p) => sum + peerTransferBytes(p), 0);
  const map = new Map();
  for (const p of peers) {
    map.set(p.publicKey, total > 0 ? peerTransferBytes(p) / total : 0);
  }
  return map;
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

// A peer's group is either an explicit "# group: <name>" comment in the
// tunnel config (surfaced as peer.group) or, when unset, an automatic
// fallback grouping by the peer's own /24 — so grouping always produces
// something sensible even before anyone assigns explicit labels. Shared by
// every view that clusters peers (isometric, topology) so they always
// agree on which peers belong together.
export function subnetKey(allowedIps) {
  const first = (allowedIps || '').split(',')[0].trim();
  const ip = first.split('/')[0];
  const octets = ip.split('.');
  return octets.length === 4 ? octets.slice(0, 3).join('.') : ip || '0.0.0';
}

export function peerGroupName(peer) {
  const explicit = (peer.group || '').trim();
  if (explicit) return explicit;
  return `${subnetKey(peer.allowedIps)}.0/24`;
}

export function groupPeers(peers) {
  const groups = new Map();
  for (const p of peers) {
    const key = peerGroupName(p);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  const keys = [...groups.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return keys.map((key) => ({ key, peers: groups.get(key) }));
}

// Validated categorical palette (dataviz skill reference instance) — fixed
// hue order, never cycled/reassigned by filtering. Every view that colors
// something by *group identity* (a zone platform's edge, a topology
// swimlane, a legend swatch) takes the next slot in this same order, so a
// given group reads as the same color everywhere in the app — a different
// visual channel from peer-status color, which stays reserved for
// connection health. Passes the six-check validator against this app's
// actual surface (#f2f2f2): lightness band, chroma floor, and CVD
// separation all PASS; the contrast WARN on 4 of the 8 slots is satisfied
// by the always-visible group label + legend text.
export const GROUP_PALETTE = ['#2a78d6', '#1baf7a', '#eda100', '#008300', '#4a3aa7', '#e34948', '#e87ba4', '#eb6834'];
export const GROUP_FALLBACK_COLOR = '#8a8a8a';

export function groupColor(index) {
  return index < GROUP_PALETTE.length ? GROUP_PALETTE[index] : GROUP_FALLBACK_COLOR;
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
