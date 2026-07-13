import { useEffect, useRef, useState } from 'react';
import {
  STATUS,
  peerStatus,
  formatHandshake,
  formatHandshakeAge,
  isGatewayPeer,
  extraNetworks,
  peerGroupName,
  groupPeers,
  groupColor,
  STATUS_SEVERITY,
} from '../lib/peerStatus.js';

const MIN_ZOOM = 0.3;
const MAX_ZOOM = 3;
const DEFAULT_VIEW = { zoom: 1, panX: 0, panY: 0 };
const FULL_CIRCLE = Math.PI * 2;

// ---------------- Hierarchical (grouped bus/tree) layout ----------------
const H_ROW = 40;
const H_GROUP_GAP = 16;
const H_HUB_X = 60;
const H_HUB_R = 20;
const H_TRUNK_X = H_HUB_X + 80;
const H_GROUP_X = H_TRUNK_X + 20;
const H_GROUP_PILL_W = 150;
const H_PEER_X = H_GROUP_X + 190;
const H_PILL_W = 170;
const H_TOP_MARGIN = 26;

// ---------------- Radial (sunburst) layout ----------------
const R_BASE_RADIUS = 120;
const R_RING_STEP = 86;
const R_SLICE_GAP = 0.12; // rad, gap between adjacent group slices
const R_HUB_R = 24;

function cssVar(name, fallback) {
  if (typeof document === 'undefined') return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function worstStatus(peersInGroup) {
  let worst = 'good';
  for (const p of peersInGroup) {
    const s = peerStatus(p.latestHandshake);
    if (STATUS_SEVERITY[s] < STATUS_SEVERITY[worst]) worst = s;
  }
  return worst;
}

// Hub → group → peer, three rows tall per group (collapsed groups skip
// their own peer rows entirely) — the classic NOC bus/tree shape, just
// with an extra grouping tier over the original flat hub-to-peer version.
function computeHierarchicalLayout(groups, collapsed) {
  let y = H_TOP_MARGIN;
  const groupNodes = [];
  const peerNodes = [];
  groups.forEach((g, gi) => {
    const color = groupColor(gi);
    const groupY = y + H_ROW / 2;
    groupNodes.push({
      key: g.key,
      y: groupY,
      color,
      count: g.peers.length,
      worst: worstStatus(g.peers),
      collapsed: collapsed.has(g.key),
    });
    y += H_ROW;
    if (!collapsed.has(g.key)) {
      g.peers.forEach((p) => {
        const peerY = y + H_ROW / 2;
        peerNodes.push({ peer: p, y: peerY, color });
        y += H_ROW;
      });
    }
    y += H_GROUP_GAP;
  });
  const contentHeight = Math.max(y, 140);
  const firstY = groupNodes[0]?.y ?? contentHeight / 2;
  const lastY = groupNodes[groupNodes.length - 1]?.y ?? firstY;
  const hubY = (firstY + lastY) / 2;
  return { groupNodes, peerNodes, contentHeight, hubY };
}

// Hub-centered sunburst: each group gets its own angular slice (equal
// slices, a small gap between), and within a slice peers fill a wedge grid
// (columns across the angle, rows out along the radius) so a large group
// naturally grows outward instead of cramming onto one crowded ring.
function computeRadialLayout(groups) {
  const n = Math.max(groups.length, 1);
  const sliceSpan = FULL_CIRCLE / n;
  const peerNodes = [];
  const groupArcs = [];
  groups.forEach((g, gi) => {
    const color = groupColor(gi);
    const sliceStart = gi * sliceSpan + R_SLICE_GAP / 2;
    const sliceEnd = (gi + 1) * sliceSpan - R_SLICE_GAP / 2;
    const usableSpan = Math.max(0.01, sliceEnd - sliceStart);
    const cols = Math.max(1, Math.ceil(Math.sqrt(g.peers.length)));
    let maxRadius = R_BASE_RADIUS;
    g.peers.forEach((p, pi) => {
      const col = pi % cols;
      const row = Math.floor(pi / cols);
      const t = cols === 1 ? 0.5 : (col + 0.5) / cols;
      const angle = sliceStart + t * usableSpan;
      const radius = R_BASE_RADIUS + row * R_RING_STEP;
      maxRadius = Math.max(maxRadius, radius);
      peerNodes.push({ peer: p, angle, radius, color, x: radius * Math.cos(angle), y: radius * Math.sin(angle) });
    });
    const midAngle = (sliceStart + sliceEnd) / 2;
    groupArcs.push({ key: g.key, color, midAngle, labelRadius: maxRadius + 46, count: g.peers.length });
  });
  const maxExtent = Math.max(R_BASE_RADIUS + 60, ...groupArcs.map((a) => a.labelRadius + 40));
  return { peerNodes, groupArcs, maxExtent };
}

function HierarchicalDiagram({ interfaceLabel, layout, onToggleGroup, onHover, colors }) {
  const { border, text, textDim, accent, surface } = colors;
  const { groupNodes, peerNodes, hubY } = layout;
  const firstY = groupNodes[0]?.y ?? hubY;
  const lastY = groupNodes[groupNodes.length - 1]?.y ?? hubY;

  return (
    <>
      {groupNodes.length > 0 && (
        <>
          <line x1={H_HUB_X + H_HUB_R} y1={hubY} x2={H_TRUNK_X} y2={hubY} stroke={border} strokeWidth={1.5} />
          <line x1={H_TRUNK_X} y1={firstY} x2={H_TRUNK_X} y2={lastY} stroke={border} strokeWidth={1.5} />
        </>
      )}

      {/* Hub */}
      <g>
        <rect x={H_HUB_X - H_HUB_R} y={hubY - H_HUB_R} width={H_HUB_R * 2} height={H_HUB_R * 2} rx={6} fill={accent} stroke={surface} strokeWidth={2} />
        <text x={H_HUB_X} y={hubY + 4} textAnchor="middle" fontSize={10} fontWeight={700} fill={surface}>
          VPS
        </text>
        <text x={H_HUB_X} y={hubY + H_HUB_R + 16} textAnchor="middle" fontSize={10} fill={textDim}>
          {interfaceLabel}
        </text>
      </g>

      {/* Group headers — click to collapse/expand, like a NOC map's site nodes */}
      {groupNodes.map((g) => {
        const badge = STATUS[g.worst];
        return (
          <g
            key={g.key}
            style={{ cursor: 'pointer' }}
            onClick={() => onToggleGroup(g.key)}
            // Without this, the SVG's own onPointerDown (for background
            // pan) fires first and calls setPointerCapture — once the SVG
            // has captured the pointer, the browser retargets the
            // resulting click event to the capturing element too, so this
            // group's own onClick never fires. Stopping propagation here
            // keeps a click on the header from ever starting a pan.
            onPointerDown={(e) => e.stopPropagation()}
          >
            <line x1={H_TRUNK_X} y1={g.y} x2={H_GROUP_X - 8} y2={g.y} stroke={g.color} strokeWidth={2} />
            <rect x={H_GROUP_X} y={g.y - 15} width={H_GROUP_PILL_W} height={30} rx={5} fill="var(--bg-panel-raised)" stroke={g.color} strokeWidth={1.4} />
            <text x={H_GROUP_X + 12} y={g.y - 2} fontSize={9} fontWeight={700} fill={text}>
              {g.collapsed ? '▸' : '▾'} {g.key.length > 16 ? g.key.slice(0, 15) + '…' : g.key}
            </text>
            <text x={H_GROUP_X + 12} y={g.y + 11} fontSize={8.5} fill={textDim}>
              {g.count} peer{g.count === 1 ? '' : 's'}
            </text>
            <circle cx={H_GROUP_X + H_GROUP_PILL_W - 14} cy={g.y} r={4} fill={badge.color} />
          </g>
        );
      })}

      {/* Peers — only rendered for expanded groups */}
      {peerNodes.map(({ peer: p, y, color }) => {
        const status = peerStatus(p.latestHandshake);
        const dotColor = STATUS[status].color;
        const gateway = isGatewayPeer(p.allowedIps);
        return (
          <g
            key={p.publicKey}
            onMouseEnter={(e) => onHover({ peer: p, status, x: e.clientX, y: e.clientY })}
            onMouseMove={(e) => onHover({ peer: p, status, x: e.clientX, y: e.clientY })}
            onMouseLeave={() => onHover(null)}
            style={{ cursor: 'pointer' }}
          >
            <line x1={H_GROUP_X + H_GROUP_PILL_W} y1={y} x2={H_PEER_X - 8} y2={y} stroke={color} strokeWidth={1.4} opacity={0.6} />
            <rect x={H_PEER_X} y={y - 14} width={H_PILL_W} height={28} rx={5} fill="var(--bg-panel-raised)" stroke={border} strokeWidth={1} />
            <circle cx={H_PEER_X + 14} cy={y} r={4} fill={dotColor} style={status === 'good' ? { animation: 'status-pulse 1.6s ease-in-out infinite' } : undefined} />
            <text x={H_PEER_X + 24} y={y - 1} fontSize={11} fill={text}>
              {p.name.length > 16 ? p.name.slice(0, 15) + '…' : p.name}
            </text>
            <text x={H_PEER_X + 24} y={y + 11} fontSize={9} fill={textDim}>
              {formatHandshakeAge(p.latestHandshake)}
            </text>
            {gateway && (
              <>
                <line x1={H_PEER_X + H_PILL_W} y1={y} x2={H_PEER_X + H_PILL_W + 26} y2={y} stroke={accent} strokeWidth={1.5} strokeDasharray="3,2" />
                <text x={H_PEER_X + H_PILL_W + 30} y={y + 3} fontSize={9} fill={accent}>
                  ▸ {extraNetworks(p.allowedIps).join(', ')}
                </text>
              </>
            )}
          </g>
        );
      })}
    </>
  );
}

function RadialDiagram({ interfaceLabel, layout, onHover, colors }) {
  const { text, textDim, accent, surface } = colors;
  const { peerNodes, groupArcs } = layout;

  return (
    <>
      {/* Faint depth rings, purely a visual cue (like the radar's shaded
          bands but static/uniform — this view has no age-based motion). */}
      {[0, 1, 2].map((i) => (
        <circle key={i} cx={0} cy={0} r={R_BASE_RADIUS + i * R_RING_STEP} fill="none" stroke={textDim} strokeOpacity={0.12} strokeWidth={1} />
      ))}

      {/* Spokes, colored by group — drawn before the nodes so nodes sit on top */}
      {peerNodes.map(({ peer: p, x, y, color }) => (
        <line key={`spoke-${p.publicKey}`} x1={0} y1={0} x2={x} y2={y} stroke={color} strokeWidth={1.2} opacity={0.55} />
      ))}

      {/* Group labels at the outer edge of each slice, anchored left/right
          depending which half of the circle they fall on so text always
          reads away from the hub, never back over it. */}
      {groupArcs.map((a) => {
        const lx = a.labelRadius * Math.cos(a.midAngle);
        const ly = a.labelRadius * Math.sin(a.midAngle);
        const anchor = Math.cos(a.midAngle) > 0.15 ? 'start' : Math.cos(a.midAngle) < -0.15 ? 'end' : 'middle';
        return (
          <text key={`label-${a.key}`} x={lx} y={ly} textAnchor={anchor} fontSize={10} fontWeight={700} fill={a.color}>
            {a.key.length > 18 ? a.key.slice(0, 17) + '…' : a.key} ({a.count})
          </text>
        );
      })}

      {/* Peer nodes + their own labels, on top of the spokes */}
      {peerNodes.map(({ peer: p, x, y }) => {
        const status = peerStatus(p.latestHandshake);
        const dotColor = STATUS[status].color;
        const gateway = isGatewayPeer(p.allowedIps);
        return (
          <g
            key={`node-${p.publicKey}`}
            onMouseEnter={(e) => onHover({ peer: p, status, x: e.clientX, y: e.clientY })}
            onMouseMove={(e) => onHover({ peer: p, status, x: e.clientX, y: e.clientY })}
            onMouseLeave={() => onHover(null)}
            style={{ cursor: 'pointer' }}
          >
            <circle cx={x} cy={y} r={9} fill="var(--bg-panel-raised)" stroke={dotColor} strokeWidth={1.6} />
            <circle cx={x} cy={y} r={4} fill={dotColor} style={status === 'good' ? { animation: 'status-pulse 1.6s ease-in-out infinite' } : undefined} />
            <text x={x} y={y + 20} textAnchor="middle" fontSize={9} fill={text}>
              {p.name.length > 14 ? p.name.slice(0, 13) + '…' : p.name}
            </text>
            {gateway && (
              <text x={x} y={y - 13} textAnchor="middle" fontSize={9} fill={accent}>
                ▸
              </text>
            )}
          </g>
        );
      })}

      {/* Hub, drawn last so it's always on top of every spoke */}
      <circle cx={0} cy={0} r={R_HUB_R} fill={accent} stroke={surface} strokeWidth={2} />
      <text x={0} y={4} textAnchor="middle" fontSize={10} fontWeight={700} fill={surface}>
        VPS
      </text>
      <text x={0} y={R_HUB_R + 16} textAnchor="middle" fontSize={10} fill={textDim}>
        {interfaceLabel}
      </text>
    </>
  );
}

// Plain HTML card-per-group dashboard — deliberately not an SVG diagram:
// this is the "site health at a glance" shape most NOC tools use alongside
// their topology map (Grafana/Datadog-style status cards), so it doesn't
// get pan/zoom the other two modes do.
function GridView({ groups, onHover }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 12, padding: '4px 2px' }}>
      {groups.map((g, gi) => {
        const color = groupColor(gi);
        const badge = STATUS[worstStatus(g.peers)];
        return (
          <div key={g.key} style={{ border: `1px solid ${color}`, borderRadius: 6, overflow: 'hidden', background: 'var(--bg-surface)' }}>
            <div className="row between" style={{ padding: '7px 10px', background: 'var(--bg-panel-raised)', borderBottom: `1px solid ${color}` }}>
              <span className="mono" style={{ fontWeight: 700, fontSize: 12 }}>
                {g.key}
              </span>
              <span className="row" style={{ gap: 5 }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: badge.color, display: 'inline-block' }} />
                <span className="hint-text">{g.peers.length}</span>
              </span>
            </div>
            <div className="row wrap" style={{ padding: 10, gap: 6 }}>
              {g.peers.map((p) => {
                const status = peerStatus(p.latestHandshake);
                const dotColor = STATUS[status].color;
                const gateway = isGatewayPeer(p.allowedIps);
                return (
                  <span
                    key={p.publicKey}
                    className="row"
                    style={{
                      gap: 5,
                      padding: '3px 8px',
                      borderRadius: 999,
                      background: 'var(--bg-panel-raised)',
                      border: '1px solid var(--border)',
                    }}
                    onMouseEnter={(e) => onHover({ peer: p, status, x: e.clientX, y: e.clientY })}
                    onMouseLeave={() => onHover(null)}
                    title={`${p.name} — ${STATUS[status].label}`}
                  >
                    <span style={{ width: 7, height: 7, borderRadius: '50%', background: dotColor, display: 'inline-block' }} />
                    <span className="mono" style={{ fontSize: 10.5 }}>
                      {p.name.length > 18 ? p.name.slice(0, 17) + '…' : p.name}
                    </span>
                    {gateway && <span style={{ color: 'var(--accent-dim)', fontSize: 9 }}>▸</span>}
                  </span>
                );
              })}
              {g.peers.length === 0 && <span className="hint-text">No peers.</span>}
            </div>
          </div>
        );
      })}
      {groups.length === 0 && (
        <div className="hint-text" style={{ padding: 20 }}>
          No peers yet.
        </div>
      )}
    </div>
  );
}

/**
 * Network topology map — three switchable, NOC/NMS-style view modes over
 * the same grouped peer data (the same "# group:" convention the isometric
 * view uses, via the shared groupPeers/groupColor helpers, so a given
 * group reads as the same color in both places):
 *
 *  - Hierarchical: hub → group → peer bus/tree, the classic NOC map shape
 *    (Zabbix Maps, LibreNMS Weathermap). Groups are collapsible.
 *  - Radial: hub-centered sunburst, each group its own angular sector — a
 *    static, precise cousin of the radar view (no physics, fixed grid
 *    positions), good for eyeballing relative group sizes at a glance.
 *  - Grid: a plain card-per-group dashboard (no pan/zoom — it's a
 *    dashboard, not a diagram), the "site health" shape most NOC tools use
 *    for a status-first overview instead of a graph.
 *
 * Hierarchical and Radial share one pan/zoom viewport (wheel to zoom
 * toward the cursor, drag empty space to pan, buttons + reset), matching
 * the radar/isometric views. Pure SVG, no diagramming library.
 */
export function NetworkTopology({ interfaceLabel, peers, fullscreen }) {
  const [hover, setHover] = useState(null); // { peer, status, x, y }
  const [layoutMode, setLayoutMode] = useState('hierarchical'); // 'hierarchical' | 'radial' | 'grid'
  const [collapsed, setCollapsed] = useState(() => new Set());
  const [view, setView] = useState(DEFAULT_VIEW);
  const [dragging, setDragging] = useState(false);
  const containerRef = useRef(null);
  const dragRef = useRef(null);
  const [dims, setDims] = useState({ width: 640, height: 420 });

  const border = cssVar('--border', '#bdbdbd');
  const text = cssVar('--text', '#1e1e1e');
  const textDim = cssVar('--text-dim', '#55555a');
  const accent = cssVar('--accent-dim', '#0068c7');
  const surface = cssVar('--bg-surface', '#ffffff');

  const groups = groupPeers(peers);

  function toggleCollapsed(key) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  // Container size tracking — same ResizeObserver pattern as the radar and
  // isometric views, including the fullscreen flex-fill behavior (measures
  // the real allocated height directly instead of guessing).
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect?.width;
      const h = entries[0]?.contentRect?.height;
      if (!w) return;
      if (fullscreen && h) setDims({ width: Math.max(360, w), height: Math.max(240, h) });
      else setDims({ width: Math.max(360, w), height: 420 });
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [fullscreen]);

  // Non-passive wheel listener so preventDefault actually stops page scroll while zooming.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || layoutMode === 'grid') return;
    function onWheel(e) {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      setView((v) => {
        const factor = Math.exp(-e.deltaY * 0.001);
        const newZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.zoom * factor));
        const worldX = (mx - v.panX) / v.zoom;
        const worldY = (my - v.panY) / v.zoom;
        return { zoom: newZoom, panX: mx - worldX * newZoom, panY: my - worldY * newZoom };
      });
    }
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [layoutMode]);

  const hLayout = layoutMode === 'hierarchical' ? computeHierarchicalLayout(groups, collapsed) : null;
  const rLayout = layoutMode === 'radial' ? computeRadialLayout(groups) : null;

  function computeFitView() {
    let contentW = dims.width;
    let contentH = dims.height;
    let originX = 0;
    let originY = 0;
    if (layoutMode === 'hierarchical' && hLayout) {
      contentW = H_PEER_X + H_PILL_W + 140;
      contentH = hLayout.contentHeight;
    } else if (layoutMode === 'radial' && rLayout) {
      contentW = rLayout.maxExtent * 2;
      contentH = rLayout.maxExtent * 2;
      originX = -rLayout.maxExtent;
      originY = -rLayout.maxExtent;
    }
    const fitPad = 40;
    const scaleX = (dims.width - fitPad * 2) / Math.max(1, contentW);
    const scaleY = (dims.height - fitPad * 2) / Math.max(1, contentH);
    // Never zoom IN past 100% just because the diagram is small — only
    // shrink to fit when content overflows the viewport.
    const fitZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.min(scaleX, scaleY, 1)));
    const contentCx = originX + contentW / 2;
    const contentCy = originY + contentH / 2;
    return { zoom: fitZoom, panX: dims.width / 2 - contentCx * fitZoom, panY: dims.height / 2 - contentCy * fitZoom };
  }

  // Auto-fit whenever the layout mode, tunnel, panel size, or peer/group
  // count changes — deliberately not on every poll refresh (peers is a new
  // array each poll even when nothing changed) and not on collapse/expand
  // (that should feel stable, not jump-zoom underneath a click).
  useEffect(() => {
    if (!dims.width || !dims.height || layoutMode === 'grid') return;
    setView(computeFitView());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutMode, interfaceLabel, dims.width, dims.height, groups.length, peers.length]);

  function handlePointerDown(e) {
    dragRef.current = { startX: e.clientX, startY: e.clientY, startPanX: view.panX, startPanY: view.panY };
    setDragging(true);
    setHover(null);
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function handlePointerMove(e) {
    const d = dragRef.current;
    if (!d) return;
    setView((v) => ({ ...v, panX: d.startPanX + (e.clientX - d.startX), panY: d.startPanY + (e.clientY - d.startY) }));
    setHover(null);
  }

  function handlePointerUp() {
    dragRef.current = null;
    setDragging(false);
  }

  function zoomBy(factor) {
    setView((v) => {
      const cx = dims.width / 2;
      const cy = dims.height / 2;
      const newZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.zoom * factor));
      const worldX = (cx - v.panX) / v.zoom;
      const worldY = (cy - v.panY) / v.zoom;
      return { zoom: newZoom, panX: cx - worldX * newZoom, panY: cy - worldY * newZoom };
    });
  }

  return (
    <div style={fullscreen ? { display: 'flex', flexDirection: 'column', height: '100%', width: '100%' } : { width: '100%' }}>
      <div className="row wrap" style={{ gap: 4, marginBottom: 8, flexShrink: 0 }}>
        <button className={layoutMode === 'hierarchical' ? 'primary' : ''} onClick={() => setLayoutMode('hierarchical')}>
          Hierarchical
        </button>
        <button className={layoutMode === 'radial' ? 'primary' : ''} onClick={() => setLayoutMode('radial')}>
          Radial
        </button>
        <button className={layoutMode === 'grid' ? 'primary' : ''} onClick={() => setLayoutMode('grid')}>
          Grid
        </button>
      </div>

      {layoutMode === 'grid' ? (
        <div ref={containerRef} style={{ flex: fullscreen ? '1 1 auto' : undefined, minHeight: fullscreen ? 0 : undefined, overflow: 'auto' }}>
          <GridView groups={groups} onHover={setHover} />
        </div>
      ) : (
        <div
          ref={containerRef}
          style={{
            position: 'relative',
            width: '100%',
            border: `1px solid ${border}`,
            borderRadius: 4,
            overflow: 'hidden',
            ...(fullscreen ? { flex: '1 1 auto', minHeight: 0 } : { height: 420 }),
          }}
        >
          <div className="row" style={{ position: 'absolute', top: 6, right: 6, zIndex: 10, gap: 4 }}>
            <button onClick={() => zoomBy(1.25)} title="Zoom in">
              +
            </button>
            <button onClick={() => zoomBy(0.8)} title="Zoom out">
              −
            </button>
            <button onClick={() => setView(computeFitView())} title="Reset view">
              Reset view
            </button>
          </div>
          <svg
            width={dims.width}
            height={dims.height}
            style={{ display: 'block', cursor: dragging ? 'grabbing' : 'grab', touchAction: 'none' }}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerLeave={handlePointerUp}
          >
            <g transform={`translate(${view.panX},${view.panY}) scale(${view.zoom})`}>
              {layoutMode === 'hierarchical' && (
                <HierarchicalDiagram
                  interfaceLabel={interfaceLabel}
                  layout={hLayout}
                  onToggleGroup={toggleCollapsed}
                  onHover={setHover}
                  colors={{ border, text, textDim, accent, surface }}
                />
              )}
              {layoutMode === 'radial' && (
                <RadialDiagram interfaceLabel={interfaceLabel} layout={rLayout} onHover={setHover} colors={{ border, text, textDim, accent, surface }} />
              )}
            </g>
          </svg>
          {peers.length === 0 && (
            <div
              style={{
                position: 'absolute',
                inset: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--text-dim)',
                fontSize: 12,
                pointerEvents: 'none',
              }}
            >
              No peers yet.
            </div>
          )}
        </div>
      )}

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

      <div className="row wrap" style={{ marginTop: 6, gap: 14, flexShrink: 0 }}>
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
      {groups.length > 0 && (
        <div className="row wrap" style={{ marginTop: 4, gap: 14, flexShrink: 0 }}>
          {groups.map((g, gi) => (
            <span key={g.key} className="row" style={{ gap: 5 }}>
              <span style={{ width: 3, height: 11, background: groupColor(gi), display: 'inline-block' }} />
              <span className="hint-text">{g.key}</span>
            </span>
          ))}
        </div>
      )}
      <div className="row wrap" style={{ marginTop: 4, gap: 14, flexShrink: 0 }}>
        <span className="hint-text">
          Grouped by <code>#&nbsp;group:</code> label, or by /24 when unset
        </span>
        {layoutMode !== 'grid' && (
          <span className="hint-text">
            Scroll to zoom, drag empty space to pan{layoutMode === 'hierarchical' ? ', click a group to collapse it' : ''}
          </span>
        )}
      </div>
    </div>
  );
}
