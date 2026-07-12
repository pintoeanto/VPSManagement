import { useState } from 'react';
import { STATUS, peerStatus, formatHandshake, formatHandshakeAge, isGatewayPeer, extraNetworks } from '../lib/peerStatus.js';

// Grid spacing for positioning group clusters and the peers within them
// (not any cube's own pixel size — see peerR/hubR below). Generous on
// purpose: two adjacent cubes plus their two-line labels must never touch.
const TILE_W = 150;
const TILE_H = 76;
const TOP_MARGIN = 40;
const LEFT_MARGIN = 70;

// Groups are laid out as tiles in their own 2D grid (not a single receding
// line) — every 2nd group starts a new row, so the whole thing reads as a
// cluster of neighborhoods rather than one long chain.
const GROUPS_PER_ROW = 2;
const GROUP_COL_STEP = 3.4;
const GROUP_ROW_STEP = 2.6;

// Within one group, peers form their own small 2-column block hanging off
// the group's marker.
const PEER_COLS = 2;
const PEER_COL_STEP = 1.15;
const PEER_ROW_STEP = 1.15;
const PEER_OFFSET_FROM_ROOT = 1.3;

function isoPos(gx, gy) {
  return { x: LEFT_MARGIN + (gx - gy) * (TILE_W / 2), y: TOP_MARGIN + (gx + gy) * (TILE_H / 2) };
}

function cssVar(name, fallback) {
  if (typeof document === 'undefined') return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function shade(hex, factor) {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.min(255, Math.max(0, Math.round(((n >> 16) & 255) * factor)));
  const g = Math.min(255, Math.max(0, Math.round(((n >> 8) & 255) * factor)));
  const b = Math.min(255, Math.max(0, Math.round((n & 255) * factor)));
  return `rgb(${r},${g},${b})`;
}

// A peer's group is either an explicit "# group: <name>" comment in the
// tunnel config (surfaced as peer.group) or, when unset, an automatic
// fallback grouping by the peer's own /24 — so grouping always produces
// something sensible even before anyone assigns explicit labels.
function subnetKey(allowedIps) {
  const first = (allowedIps || '').split(',')[0].trim();
  const ip = first.split('/')[0];
  const octets = ip.split('.');
  return octets.length === 4 ? octets.slice(0, 3).join('.') : ip || '0.0.0';
}

function peerGroupName(peer) {
  const explicit = (peer.group || '').trim();
  if (explicit) return explicit;
  return `${subnetKey(peer.allowedIps)}.0/24`;
}

function groupPeers(peers) {
  const groups = new Map();
  for (const p of peers) {
    const key = peerGroupName(p);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  const keys = [...groups.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return keys.map((key) => ({ key, peers: groups.get(key) }));
}

// Isometric cube: (groundX, groundY) is the front-bottom vertex — where the
// cube visually "touches down" — so callers can position it with the same
// iso-projected ground coordinates used for the stub lines. The top diamond
// (back/right/front/left) is lifted by `height`; the two visible side faces
// hang from it back down to ground level.
function CubeFaces({ groundX, groundY, r, height, color, label, sublabel, onEnter, onMove, onLeave }) {
  const top = {
    N: { x: groundX, y: groundY - r - height },
    E: { x: groundX + r, y: groundY - r / 2 - height },
    S: { x: groundX, y: groundY - height },
    W: { x: groundX - r, y: groundY - r / 2 - height },
  };
  const groundS = { x: groundX, y: groundY };
  const groundE = { x: groundX + r, y: groundY - r / 2 };
  const groundW = { x: groundX - r, y: groundY - r / 2 };
  const pts = (arr) => arr.map((p) => `${p.x},${p.y}`).join(' ');

  return (
    <g onMouseEnter={onEnter} onMouseMove={onMove} onMouseLeave={onLeave} style={{ cursor: onEnter ? 'pointer' : 'default' }}>
      <polygon points={pts([top.N, top.E, top.S, top.W])} fill={shade(color, 1.3)} stroke="var(--bg-surface)" strokeWidth={1} />
      <polygon points={pts([top.W, top.S, groundS, groundW])} fill={shade(color, 0.75)} stroke="var(--bg-surface)" strokeWidth={1} />
      <polygon points={pts([top.S, top.E, groundE, groundS])} fill={shade(color, 0.52)} stroke="var(--bg-surface)" strokeWidth={1} />
      {label && (
        <text x={groundS.x} y={groundS.y + 16} textAnchor="middle" fontSize={10.5} fill="var(--text)" fontFamily="var(--font-mono)">
          {label}
        </text>
      )}
      {sublabel && (
        <text x={groundS.x} y={groundS.y + 29} textAnchor="middle" fontSize={9} fill="var(--text-dim)" fontFamily="var(--font-mono)">
          {sublabel}
        </text>
      )}
    </g>
  );
}

// A group's own position is a layout anchor, not a real machine — drawn as
// a flat marker (no extrusion) so it reads as "junction", not "peer".
function GroupMarker({ x, y, label, border }) {
  const r = 9;
  const pts = `${x},${y - r} ${x + r},${y - r / 2} ${x},${y} ${x - r},${y - r / 2}`;
  return (
    <g>
      <polygon points={pts} fill="var(--bg-panel-raised)" stroke={border} strokeWidth={1.5} />
      <text x={x} y={y + 15} textAnchor="middle" fontSize={9.5} fontWeight={600} fill="var(--text-dim)" fontFamily="var(--font-mono)">
        {label.length > 20 ? label.slice(0, 19) + '…' : label}
      </text>
    </g>
  );
}

/**
 * Isometric pseudo-3D cluster map: peers are grouped (explicit "# group:"
 * label, or an automatic /24 fallback) and each group forms its own small
 * cube cluster positioned on a 2D grid of "neighborhoods" fanning out from
 * the VPS hub — deliberately not a single receding line, so more groups
 * read as more spatial spread rather than a longer chain. Each peer's stub
 * back to its group is colored by that peer's handshake-derived status.
 * Pure SVG + isometric projection math, deliberately not WebGL/Three.js —
 * same rationale as the radar and topology views.
 */
export function NetworkIsometric({ interfaceLabel, peers }) {
  const [hover, setHover] = useState(null); // { peer, status, x, y }

  const accentColor = cssVar('--accent-dim', '#0068c7');
  const border = cssVar('--border', '#bdbdbd');

  const hubR = 30;
  const hubHeight = 34;
  const peerR = 20;
  const peerHeight = 22;

  const hub = isoPos(0, 0);
  const groups = groupPeers(peers);

  const groupNodes = groups.map((group, gi) => {
    const col = gi % GROUPS_PER_ROW;
    const row = Math.floor(gi / GROUPS_PER_ROW);
    const rootGx = 1 + col * GROUP_COL_STEP;
    const rootGy = row * GROUP_ROW_STEP;
    const root = isoPos(rootGx, rootGy);
    const peerNodes = group.peers.map((p, pi) => {
      const pc = pi % PEER_COLS;
      const pr = Math.floor(pi / PEER_COLS);
      const gx = rootGx + pc * PEER_COL_STEP;
      const gy = rootGy + PEER_OFFSET_FROM_ROOT + pr * PEER_ROW_STEP;
      return { peer: p, ground: isoPos(gx, gy) };
    });
    return { key: group.key, root, peerNodes };
  });

  const allPoints = [hub, ...groupNodes.flatMap((g) => [g.root, ...g.peerNodes.map((n) => n.ground)])];

  // The group grid pushes some points toward negative X/Y depending on
  // row/col — normalize against the actual bounding box instead of
  // guessing a fixed margin (guaranteed correct regardless of group count).
  const PAD = 110;
  const minX = Math.min(...allPoints.map((p) => p.x));
  const minY = Math.min(...allPoints.map((p) => p.y));
  const maxX = Math.max(...allPoints.map((p) => p.x));
  const maxY = Math.max(...allPoints.map((p) => p.y));
  const dx = PAD - minX;
  const dy = PAD - minY;
  const width = maxX - minX + PAD + 220;
  const height = maxY - minY + PAD + 90;

  return (
    <div style={{ overflowX: 'auto' }}>
      <svg width={width} height={height} style={{ display: 'block' }}>
        <defs>
          <marker id="iso-arrow" markerWidth={8} markerHeight={8} refX={6} refY={4} orient="auto">
            <path d="M0,0 L8,4 L0,8 z" fill="var(--text-dim)" />
          </marker>
        </defs>
        <g transform={`translate(${dx},${dy})`}>
          {/* Risers from hub to each group (neutral — shared infrastructure, not a single peer's link) */}
          {groupNodes.map((g) => (
            <line key={`riser-${g.key}`} x1={hub.x} y1={hub.y} x2={g.root.x} y2={g.root.y} stroke={border} strokeWidth={3} strokeLinecap="round" opacity={0.6} />
          ))}

          {groupNodes.map((g) => (
            <g key={`group-${g.key}`}>
              <GroupMarker x={g.root.x} y={g.root.y} label={g.key} border={border} />
              {g.peerNodes.map(({ peer: p, ground }) => {
                const status = peerStatus(p.latestHandshake);
                const color = STATUS[status].color;
                const gateway = isGatewayPeer(p.allowedIps);
                const midX = (g.root.x + ground.x) / 2;
                const midY = (g.root.y + ground.y) / 2;
                return (
                  <g key={p.publicKey}>
                    <line x1={g.root.x} y1={g.root.y} x2={ground.x} y2={ground.y - 4} stroke={color} strokeWidth={3} strokeLinecap="round" markerEnd="url(#iso-arrow)" />
                    {status === 'good' && <circle cx={midX} cy={midY} r={2.6} fill={color} style={{ animation: 'status-pulse 1.6s ease-in-out infinite' }} />}
                    <CubeFaces
                      groundX={ground.x}
                      groundY={ground.y}
                      r={peerR}
                      height={peerHeight}
                      color={color}
                      label={p.name.length > 16 ? p.name.slice(0, 15) + '…' : p.name}
                      sublabel={formatHandshakeAge(p.latestHandshake)}
                      onEnter={(e) => setHover({ peer: p, status, x: e.clientX, y: e.clientY })}
                      onMove={(e) => setHover({ peer: p, status, x: e.clientX, y: e.clientY })}
                      onLeave={() => setHover(null)}
                    />
                    {gateway && (
                      <text x={ground.x + peerR + 8} y={ground.y - peerHeight - peerR / 2} fontSize={9} fill={accentColor} fontFamily="var(--font-mono)">
                        ▸ {extraNetworks(p.allowedIps).join(', ')}
                      </text>
                    )}
                  </g>
                );
              })}
            </g>
          ))}

          {/* Hub cube, largest, at the center every group radiates from */}
          <CubeFaces groundX={hub.x} groundY={hub.y} r={hubR} height={hubHeight} color={accentColor} label="VPS" sublabel={interfaceLabel} />
        </g>

        {peers.length === 0 && (
          <text x={width / 2} y={height / 2} textAnchor="middle" fontSize={12} fill="var(--text-dim)">
            No peers yet.
          </text>
        )}
      </svg>

      {hover && (
        <div
          style={{
            position: 'fixed',
            left: hover.x + 14,
            top: hover.y + 14,
            background: 'var(--bg-surface)',
            border: '1px solid var(--border)',
            borderRadius: 5,
            padding: '8px 10px',
            fontSize: 11.5,
            boxShadow: '0 4px 14px rgba(0,0,0,0.2)',
            zIndex: 60,
            pointerEvents: 'none',
            maxWidth: 260,
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 3 }} className="mono">
            {hover.peer.name}
          </div>
          <div className="hint-text">Status: {STATUS[hover.status].label}</div>
          <div className="hint-text">Group: {peerGroupName(hover.peer)}</div>
          <div className="hint-text mono">Allowed IPs: {hover.peer.allowedIps}</div>
          <div className="hint-text mono">Endpoint: {hover.peer.endpoint || 'none'}</div>
          <div className="hint-text">Last handshake: {formatHandshake(hover.peer.latestHandshake)}</div>
        </div>
      )}

      <div className="row wrap" style={{ marginTop: 6, gap: 14 }}>
        {Object.entries(STATUS).map(([key, s]) => (
          <span key={key} className="row" style={{ gap: 5 }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: s.color, display: 'inline-block' }} />
            <span className="hint-text">{s.label}</span>
          </span>
        ))}
        <span className="row" style={{ gap: 5 }}>
          <span style={{ color: 'var(--accent-dim)', fontSize: 11 }}>▸</span>
          <span className="hint-text">Routes an additional subnet</span>
        </span>
        <span className="hint-text">
          Grouped by <code>#&nbsp;group:</code> label, or by /24 when unset
        </span>
      </div>
    </div>
  );
}
