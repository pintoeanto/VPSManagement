import { useState } from 'react';
import { STATUS, peerStatus, formatHandshake, formatHandshakeAge, isGatewayPeer, extraNetworks } from '../lib/peerStatus.js';

const ROW_HEIGHT = 44;
const HUB_X = 60;
const HUB_R = 20;
const TRUNK_X = HUB_X + 70;
const PEER_X = TRUNK_X + 60;
const TOP_MARGIN = 24;

function cssVar(name, fallback) {
  if (typeof document === 'undefined') return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/**
 * Static bus/backbone topology — the deliberate opposite of the radar's
 * organic drift: fixed grid positions, orthogonal (elbow) connectors, a
 * shared neutral trunk line off the hub with each peer's own stub colored by
 * that peer's link status. This is the standard "network map" shape used by
 * NOC/SCADA tooling (Zabbix Maps, LibreNMS Weathermap, SolarWinds NTM) —
 * stable and scannable rather than animated, so it reads well as a static
 * screenshot or a wallboard.
 */
export function NetworkTopology({ interfaceLabel, peers }) {
  const [hover, setHover] = useState(null); // { peer, status, x, y }

  const border = cssVar('--border', '#bdbdbd');
  const text = cssVar('--text', '#1e1e1e');
  const textDim = cssVar('--text-dim', '#55555a');
  const accent = cssVar('--accent-dim', '#0068c7');
  const surface = cssVar('--bg-surface', '#ffffff');

  const height = Math.max(peers.length * ROW_HEIGHT + TOP_MARGIN * 2, 140);
  const hubY = TOP_MARGIN + (peers.length * ROW_HEIGHT) / 2;
  const trunkTop = TOP_MARGIN + ROW_HEIGHT / 2;
  const trunkBottom = TOP_MARGIN + (Math.max(peers.length, 1) - 1) * ROW_HEIGHT + ROW_HEIGHT / 2;

  const width = 460;

  return (
    <div style={{ overflowX: 'auto' }}>
      <svg width={width} height={height} style={{ display: 'block', fontFamily: 'var(--font-mono)' }}>
        {/* Backbone trunk — neutral, not status-colored (it's shared infrastructure, not a single link) */}
        {peers.length > 0 && <line x1={TRUNK_X} y1={trunkTop} x2={TRUNK_X} y2={trunkBottom} stroke={border} strokeWidth={1.5} />}
        {peers.length > 0 && <line x1={HUB_X + HUB_R} y1={hubY} x2={TRUNK_X} y2={hubY} stroke={border} strokeWidth={1.5} />}

        {/* Hub */}
        <g>
          <rect x={HUB_X - HUB_R} y={hubY - HUB_R} width={HUB_R * 2} height={HUB_R * 2} rx={6} fill={accent} stroke={surface} strokeWidth={2} />
          <text x={HUB_X} y={hubY + 4} textAnchor="middle" fontSize={10} fontWeight={700} fill={surface}>
            VPS
          </text>
          <text x={HUB_X} y={hubY + HUB_R + 16} textAnchor="middle" fontSize={10} fill={textDim}>
            {interfaceLabel}
          </text>
        </g>

        {peers.map((p, i) => {
          const y = TOP_MARGIN + i * ROW_HEIGHT + ROW_HEIGHT / 2;
          const status = peerStatus(p.latestHandshake);
          const color = STATUS[status].color;
          const gateway = isGatewayPeer(p.allowedIps);
          const pillW = 150;

          return (
            <g
              key={p.publicKey}
              onMouseEnter={(e) => setHover({ peer: p, status, x: e.clientX, y: e.clientY })}
              onMouseMove={(e) => setHover({ peer: p, status, x: e.clientX, y: e.clientY })}
              onMouseLeave={() => setHover(null)}
              style={{ cursor: 'pointer' }}
            >
              {/* Per-peer stub — colored by that peer's own status, the link-quality signal */}
              <line x1={TRUNK_X} y1={y} x2={PEER_X - 8} y2={y} stroke={color} strokeWidth={2} />
              {status === 'good' && (
                <circle cx={TRUNK_X + 10} cy={y} r={2} fill={color} style={{ animation: 'status-pulse 1.6s ease-in-out infinite' }} />
              )}

              <rect x={PEER_X} y={y - 14} width={pillW} height={28} rx={5} fill="var(--bg-panel-raised)" stroke={border} strokeWidth={1} />
              <circle cx={PEER_X + 14} cy={y} r={4} fill={color} style={status === 'good' ? { animation: 'status-pulse 1.6s ease-in-out infinite' } : undefined} />
              <text x={PEER_X + 24} y={y - 1} fontSize={11} fill={text}>
                {p.name.length > 16 ? p.name.slice(0, 15) + '…' : p.name}
              </text>
              <text x={PEER_X + 24} y={y + 11} fontSize={9} fill={textDim}>
                {formatHandshakeAge(p.latestHandshake)}
              </text>

              {gateway && (
                <>
                  <line x1={PEER_X + pillW} y1={y} x2={PEER_X + pillW + 26} y2={y} stroke={accent} strokeWidth={1.5} strokeDasharray="3,2" />
                  <text x={PEER_X + pillW + 30} y={y + 3} fontSize={9} fill={accent}>
                    ▸ {extraNetworks(p.allowedIps).join(', ')}
                  </text>
                </>
              )}
            </g>
          );
        })}

        {peers.length === 0 && (
          <text x={width / 2} y={height / 2} textAnchor="middle" fontSize={12} fill={textDim}>
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
