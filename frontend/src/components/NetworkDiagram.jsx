// Status colors are the dataviz skill's fixed, validated status palette —
// never themed, never reused for anything but connection state.
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

function formatHandshake(latestHandshake) {
  if (!latestHandshake) return 'never';
  const date = new Date(Number(latestHandshake) * 1000);
  return date.toLocaleString();
}

/**
 * Server node in the center, peers arranged radially around it. Line color
 * and peer-dot color both encode connection status (never color alone —
 * every node is also text-labeled, and a legend spells out what each color
 * means). Native <title> gives a hover tooltip without pulling in a charting
 * dependency for something this small.
 */
export function NetworkDiagram({ interfaceLabel, peers }) {
  const width = 640;
  const height = 420;
  const cx = width / 2;
  const cy = height / 2;
  const radius = Math.min(width, height) / 2 - 70;

  const nodes = peers.map((p, i) => {
    const angle = (2 * Math.PI * i) / Math.max(peers.length, 1) - Math.PI / 2;
    return {
      ...p,
      x: cx + radius * Math.cos(angle),
      y: cy + radius * Math.sin(angle),
      status: peerStatus(p.latestHandshake),
    };
  });

  return (
    <div>
      <svg viewBox={`0 0 ${width} ${height}`} style={{ width: '100%', height: 'auto', maxHeight: 420 }}>
        {nodes.map((n) => (
          <line
            key={`line-${n.publicKey}`}
            x1={cx}
            y1={cy}
            x2={n.x}
            y2={n.y}
            stroke={STATUS[n.status].color}
            strokeWidth={2}
            opacity={0.7}
          />
        ))}

        {/* Server node */}
        <circle cx={cx} cy={cy} r={10} fill="var(--accent-dim)" stroke="var(--bg-code)" strokeWidth={2} />
        <text x={cx} y={cy + 24} textAnchor="middle" fontSize={11} fill="var(--text)" fontFamily="var(--font-mono)">
          {interfaceLabel}
        </text>

        {nodes.map((n) => (
          <g key={n.publicKey}>
            <title>
              {n.name}
              {'\n'}Status: {STATUS[n.status].label}
              {'\n'}Allowed IPs: {n.allowedIps}
              {'\n'}Endpoint: {n.endpoint || 'none'}
              {'\n'}Last handshake: {formatHandshake(n.latestHandshake)}
            </title>
            <circle cx={n.x} cy={n.y} r={7} fill={STATUS[n.status].color} stroke="var(--bg-code)" strokeWidth={2} />
            <text
              x={n.x}
              y={n.y + (n.y > cy ? 20 : -14)}
              textAnchor="middle"
              fontSize={11}
              fill="var(--text)"
              fontFamily="var(--font-mono)"
            >
              {n.name}
            </text>
          </g>
        ))}
      </svg>

      <div className="row wrap" style={{ marginTop: 4 }}>
        {Object.entries(STATUS).map(([key, s]) => (
          <span key={key} className="row" style={{ gap: 5 }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: s.color, display: 'inline-block' }} />
            <span className="hint-text">{s.label}</span>
          </span>
        ))}
      </div>
    </div>
  );
}
