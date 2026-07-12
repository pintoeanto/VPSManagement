import { useState } from 'react';
import { STATUS, peerStatus, formatHandshake, formatHandshakeAge, isGatewayPeer, extraNetworks } from '../lib/peerStatus.js';

// Grid spacing for positioning cubes along the receding iso lane (not the
// cube's own pixel size — see peerR/hubR below). Generous on purpose: two
// adjacent cubes plus their two-line labels must never touch.
const TILE_W = 150;
const TILE_H = 76;
const TOP_MARGIN = 40;
const LEFT_MARGIN = 70;
// How far (in grid units, along the perpendicular iso axis) each peer cube
// sits off the shared lane — the "spoke" length.
const PEER_OFFSET = 1.4;

function isoPos(gx, gy) {
  return { x: LEFT_MARGIN + (gx - gy) * (TILE_W / 2), y: TOP_MARGIN + (gx + gy) * (TILE_H / 2) };
}

function cssVar(name, fallback) {
  if (typeof document === 'undefined') return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

// Groups peers into depth "levels" by their own tunnel address's /24 —
// e.g. 10.200.200.x and 10.8.0.x land on separate receding rows, so a
// deployment spanning multiple subnets reads as distinct levels instead of
// one long undifferentiated line of cubes.
function subnetKey(allowedIps) {
  const first = (allowedIps || '').split(',')[0].trim();
  const ip = first.split('/')[0];
  const octets = ip.split('.');
  return octets.length === 4 ? octets.slice(0, 3).join('.') : ip || '0.0.0';
}

function groupIntoLevels(peers) {
  const groups = new Map();
  for (const p of peers) {
    const key = subnetKey(p.allowedIps);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  const keys = [...groups.keys()].sort((a, b) => {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
      if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
    }
    return 0;
  });
  return keys.map((key) => ({ key, peers: groups.get(key) }));
}

function shade(hex, factor) {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.min(255, Math.max(0, Math.round(((n >> 16) & 255) * factor)));
  const g = Math.min(255, Math.max(0, Math.round(((n >> 8) & 255) * factor)));
  const b = Math.min(255, Math.max(0, Math.round((n & 255) * factor)));
  return `rgb(${r},${g},${b})`;
}

// Isometric cube: (groundX, groundY) is the front-bottom vertex — where the
// cube visually "touches down" — so callers can position it with the same
// iso-projected ground coordinates used for the lane/stub lines. The top
// diamond (back/right/front/left) is lifted by `height`; the two visible
// side faces hang from it back down to ground level.
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

/**
 * Isometric pseudo-3D lane: same hub-and-spoke data as the Topology view,
 * reprojected — the VPS is a larger cube at the near end of a receding
 * lane, each peer is a cube set off the lane on its own spoke, and the
 * spoke connecting the lane to each peer cube is colored by that peer's
 * handshake-derived status (a colored "flow" line, per-peer instead of a
 * flat accent). Pure SVG + isometric projection math, deliberately not
 * WebGL/Three.js — same rationale as the radar and topology views.
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
  const levels = groupIntoLevels(peers);

  // Each level (a /24 group) is its own straight trunk at fixed gy=levelIndex,
  // running from gx=0 (where its riser meets the hub's row) out through one
  // point per peer in that level. A riser (fixed gx=0, varying gy) connects
  // that trunk's start back to the hub — both are straight lines in iso
  // projection since isoPos is linear in each axis independently.
  const allPoints = [hub];
  const risers = [];
  const trunks = [];
  const cubes = []; // { peer, lane, ground, level }

  levels.forEach((level, levelIndex) => {
    const levelStart = isoPos(0, levelIndex);
    allPoints.push(levelStart);
    if (levelIndex > 0) risers.push({ from: hub, to: levelStart, key: level.key });

    const trunkPoints = [levelStart, ...level.peers.map((_, j) => isoPos(j + 1, levelIndex))];
    trunks.push({ points: trunkPoints, key: level.key });
    allPoints.push(...trunkPoints);

    level.peers.forEach((p, j) => {
      const lane = isoPos(j + 1, levelIndex);
      const ground = isoPos(j + 1, levelIndex + PEER_OFFSET);
      allPoints.push(ground);
      cubes.push({ peer: p, lane, ground, level: level.key });
    });
  });

  // Levels beyond the first push their cubes' perpendicular offset further
  // and further toward negative X (the two iso axes both have a leftward
  // component), so a fixed left margin isn't enough once there's more than
  // one level — normalize against the actual bounding box instead of
  // guessing a margin.
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

        {/* Risers + per-level trunks (neutral — shared infrastructure, not a single link) */}
        {risers.map((r) => (
          <line key={`riser-${r.key}`} x1={r.from.x} y1={r.from.y} x2={r.to.x} y2={r.to.y} stroke={border} strokeWidth={3} strokeLinecap="round" opacity={0.6} />
        ))}
        {trunks.map((t) => (
          <polyline
            key={`trunk-${t.key}`}
            points={t.points.map((p) => `${p.x},${p.y}`).join(' ')}
            fill="none"
            stroke={border}
            strokeWidth={3}
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity={0.6}
          />
        ))}
        {levels.length > 1 &&
          levels.map((level, levelIndex) => {
            const p = isoPos(0, levelIndex);
            return (
              <text key={`level-label-${level.key}`} x={p.x - 10} y={p.y + 3} textAnchor="end" fontSize={9} fill="var(--text-dim)" fontFamily="var(--font-mono)">
                {level.key}.0/24
              </text>
            );
          })}

        {cubes.map(({ peer: p, lane, ground }) => {
          const status = peerStatus(p.latestHandshake);
          const color = STATUS[status].color;
          const gateway = isGatewayPeer(p.allowedIps);
          const midX = (lane.x + ground.x) / 2;
          const midY = (lane.y + ground.y) / 2;

          return (
            <g key={p.publicKey}>
              <line x1={lane.x} y1={lane.y} x2={ground.x} y2={ground.y - 4} stroke={color} strokeWidth={3} strokeLinecap="round" markerEnd="url(#iso-arrow)" />
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

        {/* Hub cube, largest, at the near end of every level's lane */}
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
      </div>
    </div>
  );
}
