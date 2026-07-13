import { useEffect, useRef, useState } from 'react';
import { STATUS, peerStatus, formatHandshake, formatHandshakeAge, isGatewayPeer, extraNetworks, DEVICE_TYPES } from '../lib/peerStatus.js';

// Grid spacing for positioning zone platforms and the peer racks within them
// (not any icon's own pixel size — see peerR/hubR below). Generous on
// purpose: two adjacent racks plus their two-line labels must never touch.
const TILE_W = 150;
const TILE_H = 76;
const TOP_MARGIN = 40;
const LEFT_MARGIN = 70;

// Groups are laid out as tiles in their own 2D grid (not a single receding
// line) — every 2nd group starts a new row, so the whole thing reads as a
// cluster of neighborhoods rather than one long chain. Each group's own
// footprint (driven by how many peers it has) is measured and the next
// group in the row is pushed clear of it.
const GROUPS_PER_ROW = 2;
const GROUP_GAP = 2.2;
const ROW_GAP = 2.0;

// Within one zone, peer racks form their own small block — column count
// grows with peer count (roughly square) instead of staying fixed at 2, so
// a large group fans out into a compact block instead of one long column.
const PEER_COL_STEP = 1.3;
const PEER_ROW_STEP = 1.3;
const PEER_OFFSET_FROM_ROOT = 1.3;

// Margin (grid units) between the peer rack sub-grid and the platform's own
// edge — back/left gets less because nothing overhangs there, front/right
// gets more because peer name + age labels hang below each rack in screen
// space and must stay inside the platform outline.
const PLATFORM_PAD_BACK = 0.55;
const PLATFORM_PAD_FRONT = 1.0;

function peerGridCols(n) {
  if (n <= 1) return 1;
  if (n <= 4) return 2;
  return 3;
}

const MIN_ZOOM = 0.3;
const MAX_ZOOM = 3;
const CORNER_R = 5; // routing bend radius, content units

// Validated categorical palette (dataviz skill reference instance) — fixed
// hue order, never cycled/reassigned by filtering. Each zone's front
// platform edge, heading tick, and legend swatch take the next slot in this
// order, purely for "which platform is which zone" identity — a different
// visual channel from peer-status color, which stays reserved for rack
// outlines. Passes the six-check validator against this app's actual
// surface (#f2f2f2): lightness band, chroma floor, and CVD separation all
// PASS; the contrast WARN on 4 of the 8 slots is satisfied by the
// always-visible zone heading + legend labels.
const ZONE_PALETTE = ['#2a78d6', '#1baf7a', '#eda100', '#008300', '#4a3aa7', '#e34948', '#e87ba4', '#eb6834'];
const ZONE_FALLBACK_COLOR = '#8a8a8a';

function zoneColor(index) {
  return index < ZONE_PALETTE.length ? ZONE_PALETTE[index] : ZONE_FALLBACK_COLOR;
}

function isoPos(gx, gy) {
  return { x: LEFT_MARGIN + (gx - gy) * (TILE_W / 2), y: TOP_MARGIN + (gx + gy) * (TILE_H / 2) };
}

function cssVar(name, fallback) {
  if (typeof document === 'undefined') return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
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

// Default layout: hub at the origin, zone platforms flowing left-to-right in
// rows of GROUPS_PER_ROW. Every position/footprint here is a *default* — the
// caller overlays any manually-dragged per-zone offset on top before
// rendering, so this only has to be a reasonable starting point, not
// collision-free for every possible dataset.
function computeDefaultLayout(groups) {
  const hub = isoPos(0, 0);
  const nodes = [];
  let cursorGx = 1.4;
  let rowGyBase = 0;
  let rowMaxDepth = 0;
  let colInRow = 0;

  groups.forEach((group) => {
    const cols = peerGridCols(group.peers.length);
    const rows = Math.max(1, Math.ceil(group.peers.length / cols));
    const widthUnits = (cols - 1) * PEER_COL_STEP + 1.6;
    const depthUnits = PEER_OFFSET_FROM_ROOT + (rows - 1) * PEER_ROW_STEP + 1.1;

    if (colInRow >= GROUPS_PER_ROW) {
      rowGyBase += rowMaxDepth + ROW_GAP;
      rowMaxDepth = 0;
      colInRow = 0;
      cursorGx = 1.4;
    }

    const rootGx = cursorGx;
    const rootGy = rowGyBase;
    const root = isoPos(rootGx, rootGy);
    const peerNodes = group.peers.map((p, pi) => {
      const pc = pi % cols;
      const pr = Math.floor(pi / cols);
      const gx = rootGx + pc * PEER_COL_STEP;
      const gy = rootGy + PEER_OFFSET_FROM_ROOT + pr * PEER_ROW_STEP;
      return { peer: p, ground: isoPos(gx, gy) };
    });
    const platformGrid = {
      bx: rootGx - PLATFORM_PAD_BACK,
      by: rootGy - PLATFORM_PAD_BACK,
      w: widthUnits + PLATFORM_PAD_BACK + PLATFORM_PAD_FRONT,
      d: depthUnits + PLATFORM_PAD_BACK + PLATFORM_PAD_FRONT,
    };
    nodes.push({ key: group.key, root, peerNodes, platformGrid });

    cursorGx += widthUnits + PLATFORM_PAD_BACK + PLATFORM_PAD_FRONT + GROUP_GAP;
    rowMaxDepth = Math.max(rowMaxDepth, depthUnits + PLATFORM_PAD_BACK + PLATFORM_PAD_FRONT);
    colInRow += 1;
  });

  return { hub, groupNodes: nodes };
}

// The 4 corners of an isometric rectangular platform spanning grid rect
// [bx,by] to [bx+w,by+d] — N=back, E=right, S=front/nearest, W=left — sized
// independently along each axis instead of a fixed radius.
function platformCorners(bx, by, w, d) {
  return { pN: isoPos(bx, by), pE: isoPos(bx + w, by), pS: isoPos(bx + w, by + d), pW: isoPos(bx, by + d) };
}

function shiftPoint(p, dx, dy) {
  return { x: p.x + dx, y: p.y + dy };
}

// Rounded orthogonal connector: drop straight down from the source, jog
// sideways at a bend row, drop straight down into the target — a clean
// right-angled trace instead of a diagonal, matching how routed cable runs
// are actually drawn in a rack diagram. `bendFrac` picks where along the
// vertical span the jog happens (0..1); staggering it per-zone keeps
// parallel branches from a shared hub from running on top of each other.
function elbowPath(x1, y1, x2, y2, bendFrac) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  if (Math.abs(dx) < 1 || Math.abs(dy) < 1) return `M ${x1},${y1} L ${x2},${y2}`;
  const bendY = y1 + dy * bendFrac;
  const rr = Math.max(0, Math.min(CORNER_R, Math.abs(dy) / 2, Math.abs(dx) / 2));
  const sx = dx > 0 ? 1 : -1;
  const sy = dy > 0 ? 1 : -1;
  return [
    `M ${x1},${y1}`,
    `L ${x1},${bendY - sy * rr}`,
    `Q ${x1},${bendY} ${x1 + sx * rr},${bendY}`,
    `L ${x2 - sx * rr},${bendY}`,
    `Q ${x2},${bendY} ${x2},${bendY + sy * rr}`,
    `L ${x2},${y2}`,
  ].join(' ');
}

// Small, index-derived stagger so zones sharing the hub as a source don't
// all bend at the exact same row.
function branchBendFrac(index) {
  return 0.3 + (index % 4) * 0.1;
}

// A device's silhouette (relative to the shared box shape) and one small
// accent detail per type — kept intentionally simple (hand-drawn line
// shapes, not imported artwork) so every icon stays in the exact same thin-
// outline style as everything else in this diagram. Unset/unrecognized
// falls through to 'server', the original plain rack-unit box.
const DEVICE_ICON_SHAPE = {
  mobile: { rMul: 0.5, heightMul: 1.5, decoration: null },
  server: { rMul: 1, heightMul: 1, decoration: null },
  pc: { rMul: 1.25, heightMul: 0.55, decoration: 'bay' },
  laptop: { rMul: 1.15, heightMul: 0.32, decoration: 'hinge' },
  router: { rMul: 1, heightMul: 0.6, decoration: 'antenna' },
};

function deviceIconShape(deviceType) {
  return DEVICE_ICON_SHAPE[deviceType] || DEVICE_ICON_SHAPE.server;
}

// Thin outlined isometric box — a device icon, not a shaded solid: 3 faces
// as plain strokes over a very light fill, no gradient. (groundX, groundY)
// is the front-bottom vertex where it visually "touches down" — fixed
// regardless of deviceType, so peers keep their grid position exactly;
// only the box's own proportions and one accent line vary by type.
function DeviceIcon({ groundX, groundY, r, height, deviceType, color, label, sublabel, onEnter, onMove, onLeave }) {
  const shape = deviceIconShape(deviceType);
  const br = r * shape.rMul;
  const bh = height * shape.heightMul;
  const top = {
    N: { x: groundX, y: groundY - br - bh },
    E: { x: groundX + br, y: groundY - br / 2 - bh },
    S: { x: groundX, y: groundY - bh },
    W: { x: groundX - br, y: groundY - br / 2 - bh },
  };
  const groundS = { x: groundX, y: groundY };
  const groundE = { x: groundX + br, y: groundY - br / 2 };
  const groundW = { x: groundX - br, y: groundY - br / 2 };
  const pts = (arr) => arr.map((p) => `${p.x},${p.y}`).join(' ');

  return (
    <g onMouseEnter={onEnter} onMouseMove={onMove} onMouseLeave={onLeave} style={{ cursor: onEnter ? 'pointer' : 'default' }}>
      <polygon points={pts([top.W, top.S, groundS, groundW])} fill="var(--bg-surface)" stroke={color} strokeWidth={1.1} />
      <polygon points={pts([top.S, top.E, groundE, groundS])} fill="var(--bg-surface)" stroke={color} strokeWidth={1.1} />
      <polygon points={pts([top.N, top.E, top.S, top.W])} fill="var(--bg-surface)" stroke={color} strokeWidth={1.4} />
      {shape.decoration === 'antenna' && (
        <>
          <line x1={top.N.x} y1={top.N.y} x2={top.N.x - 6} y2={top.N.y - 11} stroke={color} strokeWidth={1} />
          <line x1={top.N.x} y1={top.N.y} x2={top.N.x + 6} y2={top.N.y - 11} stroke={color} strokeWidth={1} />
        </>
      )}
      {shape.decoration === 'bay' && (
        // A line parallel to the top edge, partway down the front-right
        // face (interpolated between its two vertical edges at the same
        // fraction) — NOT the midpoints of the face's two diagonals, which
        // coincide at the same center point for any parallelogram and so
        // draw as an invisible zero-length line.
        <line
          x1={top.S.x + (groundS.x - top.S.x) * 0.55}
          y1={top.S.y + (groundS.y - top.S.y) * 0.55}
          x2={top.E.x + (groundE.x - top.E.x) * 0.55}
          y2={top.E.y + (groundE.y - top.E.y) * 0.55}
          stroke={color}
          strokeWidth={0.9}
          opacity={0.6}
        />
      )}
      {shape.decoration === 'hinge' && <line x1={top.W.x} y1={top.W.y} x2={top.E.x} y2={top.E.y} stroke={color} strokeWidth={0.9} opacity={0.6} />}
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

// A flat isometric zone platform — a ground-plane outline, not a raised
// slab (no extrusion). Only the two front-facing edges (the ones nearest
// the viewer) take the zone's accent color; the two back edges stay
// neutral, echoing the reference's single colored border rather than
// outlining the whole shape in color.
function PlatformOutline({ corners, color }) {
  const { pN, pE, pS, pW } = corners;
  const pts = [pN, pE, pS, pW].map((p) => `${p.x},${p.y}`).join(' ');
  return (
    <>
      <polygon points={pts} fill="var(--bg-surface)" stroke="var(--border)" strokeWidth={1} />
      <path
        d={`M ${pW.x},${pW.y} L ${pS.x},${pS.y} L ${pE.x},${pE.y}`}
        fill="none"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  );
}

// A zone's name as a heading — a short colored tick beside bold text —
// instead of a bordered chip, matching how the reference labels each
// section (a colored dash, then the title) rather than boxing it.
function ZoneHeading({ x, y, label, color }) {
  const shown = label.length > 24 ? label.slice(0, 23) + '…' : label;
  return (
    <g>
      <rect x={x} y={y - 10} width={3} height={13} fill={color} />
      <text x={x + 8} y={y} fontSize={11} fontWeight={700} fill="var(--text)" fontFamily="var(--font-mono)">
        {shown}
      </text>
    </g>
  );
}

/**
 * Isometric pseudo-3D cluster map: peers are grouped (explicit "# group:"
 * label, or an automatic /24 fallback) and each group is drawn as a flat
 * isometric zone platform — an outlined ground plane with a single colored
 * front edge and a heading, the way a clean infrastructure diagram marks
 * out a zone without heavy shading — with the group's peers standing on it
 * as small thin-outlined device icons, colored by live status. Each icon's
 * silhouette (and one small accent detail) varies by the peer's optional
 * "# deviceType:" tag (mobile/server/pc/laptop/router) — see
 * DEVICE_ICON_SHAPE — falling back to the plain rack-unit box when unset.
 * Peers within a zone don't get individual wires; a single connector per zone runs from
 * the hub with a clean right-angled (elbow) trace and a small arrowhead,
 * not a diagonal, matching how routed cable runs are actually drawn.
 * Whole zones (platform + its racks, moved together as one rigid unit) can
 * be click-dragged to a new spot — routing re-flows live — for the cases
 * the automatic layout doesn't get perfectly right; positions persist
 * per-tunnel in localStorage. Pan (drag empty space) and zoom (wheel or
 * buttons) let a large cluster be explored without everything shrinking to
 * illegibility. Pure SVG + isometric projection math, deliberately not
 * WebGL/Three.js — this is a static, diagrammatic look, not a scene meant
 * to be orbited around.
 */
export function NetworkIsometric({ interfaceLabel, peers, fullscreen }) {
  const containerRef = useRef(null);
  const dragRef = useRef(null); // { startX, startY, startPanX, startPanY } while panning the view
  const groupDragRef = useRef(null); // { key, startClientX, startClientY, startDx, startDy } while dragging one zone
  const [hover, setHover] = useState(null); // { peer, status, x, y }
  const [dims, setDims] = useState({ width: 640, height: 480 });
  const [view, setView] = useState({ zoom: 1, panX: 0, panY: 0 });
  const [dragging, setDragging] = useState(false);
  const [draggingGroup, setDraggingGroup] = useState(null);
  const [overrides, setOverrides] = useState({}); // { [group.key]: {dx,dy} } manually-dragged zone offsets, content space

  const accentColor = cssVar('--accent-dim', '#0068c7');
  const border = cssVar('--border', '#bdbdbd');
  const textDim = cssVar('--text-dim', '#55555a');

  const hubR = 26;
  const hubHeight = 30;
  const peerR = 18;
  const peerHeight = 20;

  const storageKey = `vps-console:iso-layout:${interfaceLabel || 'default'}`;

  // Manually-dragged offsets are per-tunnel and persist across reloads —
  // loaded fresh whenever the selected tunnel changes.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      setOverrides(raw ? JSON.parse(raw) : {});
    } catch {
      setOverrides({});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey]);

  function persistOverrides(next) {
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      // best-effort only — a full/unavailable localStorage just means positions don't persist
    }
  }

  const groups = groupPeers(peers);
  const { hub, groupNodes: defaultGroupNodes } = computeDefaultLayout(groups);

  const groupNodes = defaultGroupNodes.map((g, index) => {
    const delta = overrides[g.key] ?? { dx: 0, dy: 0 };
    const root = shiftPoint(g.root, delta.dx, delta.dy);
    const peerNodes = g.peerNodes.map((n) => ({ peer: n.peer, ground: shiftPoint(n.ground, delta.dx, delta.dy) }));
    const corners0 = platformCorners(g.platformGrid.bx, g.platformGrid.by, g.platformGrid.w, g.platformGrid.d);
    const corners = {
      pN: shiftPoint(corners0.pN, delta.dx, delta.dy),
      pE: shiftPoint(corners0.pE, delta.dx, delta.dy),
      pS: shiftPoint(corners0.pS, delta.dx, delta.dy),
      pW: shiftPoint(corners0.pW, delta.dx, delta.dy),
    };
    return { key: g.key, root, peerNodes, corners, color: zoneColor(index) };
  });

  const allPoints = [hub, ...groupNodes.flatMap((g) => [g.corners.pN, g.corners.pE, g.corners.pS, g.corners.pW, ...g.peerNodes.map((n) => n.ground)])];

  const PAD = 110;
  const minX = Math.min(...allPoints.map((p) => p.x)) - PAD;
  const minY = Math.min(...allPoints.map((p) => p.y)) - PAD;
  const maxX = Math.max(...allPoints.map((p) => p.x)) + PAD + 150;
  const maxY = Math.max(...allPoints.map((p) => p.y)) + PAD + 60;

  function computeFitView() {
    const contentW = Math.max(1, maxX - minX);
    const contentH = Math.max(1, maxY - minY);
    const fitPad = 40;
    const scaleX = (dims.width - fitPad * 2) / contentW;
    const scaleY = (dims.height - fitPad * 2) / contentH;
    // Never zoom IN past 100% just because the diagram is small — only
    // shrink to fit when content overflows the viewport.
    const fitZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.min(scaleX, scaleY, 1)));
    const contentCx = (minX + maxX) / 2;
    const contentCy = (minY + maxY) / 2;
    return { zoom: fitZoom, panX: dims.width / 2 - contentCx * fitZoom, panY: dims.height / 2 - contentCy * fitZoom };
  }

  // Container width tracks the panel; height is capped the same way the
  // radar caps its own canvas, growing when the panel is maximized.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect?.width;
      if (!w) return;
      const maxH = fullscreen ? Math.max(480, window.innerHeight - 220) : 480;
      setDims({ width: Math.max(360, w), height: maxH });
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [fullscreen]);

  // Auto-fit whenever the panel is resized, the tunnel changes, or the peer
  // count changes — deliberately NOT on every poll refresh (peers is a new
  // array each poll even when nothing actually changed) and NOT on manual
  // drags, so it never yanks the view out from under someone mid-edit.
  useEffect(() => {
    if (!dims.width || !dims.height) return;
    setView(computeFitView());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interfaceLabel, dims.width, dims.height, peers.length]);

  // Non-passive wheel listener so preventDefault actually stops page scroll while zooming.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
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
  }, []);

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

  function resetLayout() {
    setOverrides({});
    persistOverrides({});
  }

  // A zone's own pointerdown starts a DRAG OF THAT WHOLE ZONE (platform +
  // all its peer racks, moved together as one rigid unit), not a view-pan —
  // stopPropagation keeps it from also triggering handlePointerDown on the
  // svg background. Position deltas are converted from screen pixels to
  // content units by dividing by the current zoom.
  function startGroupDrag(e, key) {
    e.stopPropagation();
    const cur = overrides[key] ?? { dx: 0, dy: 0 };
    groupDragRef.current = { key, startClientX: e.clientX, startClientY: e.clientY, startDx: cur.dx, startDy: cur.dy };
    setDraggingGroup(key);
    setHover(null);
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function moveGroupDrag(e) {
    const d = groupDragRef.current;
    if (!d) return;
    e.stopPropagation();
    const dx = (e.clientX - d.startClientX) / view.zoom;
    const dy = (e.clientY - d.startClientY) / view.zoom;
    setOverrides((prev) => ({ ...prev, [d.key]: { dx: d.startDx + dx, dy: d.startDy + dy } }));
  }

  function endGroupDrag(e) {
    if (!groupDragRef.current) return;
    e.stopPropagation();
    groupDragRef.current = null;
    setDraggingGroup(null);
    setOverrides((prev) => {
      persistOverrides(prev);
      return prev;
    });
  }

  // Hover handlers ignore mouse movement while a view-pan or a zone-drag is
  // in progress — otherwise the tooltip flickers on and off as the diagram
  // (or the zone itself) slides past the cursor mid-drag.
  function hoverPeer(peer, status, e) {
    if (dragRef.current || groupDragRef.current) return;
    setHover({ peer, status, x: e.clientX, y: e.clientY });
  }

  return (
    <div>
      <div
        ref={containerRef}
        style={{ position: 'relative', width: '100%', height: dims.height, overflow: 'hidden', borderRadius: 4, border: `1px solid ${border}` }}
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
          <button onClick={resetLayout} title="Clear manually-dragged zone positions and go back to the automatic layout">
            Reset layout
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
          <defs>
            <marker id="iso-arrow" markerWidth={7} markerHeight={7} refX={5.5} refY={3.5} orient="auto">
              <path d="M0,0 L7,3.5 L0,7 z" fill={textDim} />
            </marker>
          </defs>
          <g transform={`translate(${view.panX},${view.panY}) scale(${view.zoom})`}>
            {/* One connector per zone, drawn first so it sits UNDER every
                platform/rack — a wire tucks behind the devices it connects,
                not over them. */}
            {groupNodes.map((g, gi) => (
              <path
                key={`conn-${g.key}`}
                d={elbowPath(hub.x, hub.y, g.corners.pN.x, g.corners.pN.y, branchBendFrac(gi))}
                fill="none"
                stroke={border}
                strokeWidth={1.6}
                strokeLinecap="round"
                markerEnd="url(#iso-arrow)"
              />
            ))}

            {groupNodes.map((g) => (
              <g
                key={`zone-${g.key}`}
                onPointerDown={(e) => startGroupDrag(e, g.key)}
                onPointerMove={draggingGroup === g.key ? moveGroupDrag : undefined}
                onPointerUp={draggingGroup === g.key ? endGroupDrag : undefined}
                onPointerLeave={draggingGroup === g.key ? endGroupDrag : undefined}
                style={{ cursor: 'grab' }}
              >
                <PlatformOutline corners={g.corners} color={g.color} />
                <ZoneHeading x={g.corners.pN.x - 6} y={g.corners.pN.y - 14} label={g.key} color={g.color} />
                {g.peerNodes.map(({ peer: p, ground }) => {
                  const status = peerStatus(p.latestHandshake);
                  const color = STATUS[status].color;
                  const gateway = isGatewayPeer(p.allowedIps);
                  return (
                    <g key={p.publicKey}>
                      <DeviceIcon
                        groundX={ground.x}
                        groundY={ground.y}
                        r={peerR}
                        height={peerHeight}
                        deviceType={p.deviceType}
                        color={color}
                        label={p.name.length > 16 ? p.name.slice(0, 15) + '…' : p.name}
                        sublabel={formatHandshakeAge(p.latestHandshake)}
                        onEnter={(e) => hoverPeer(p, status, e)}
                        onMove={(e) => hoverPeer(p, status, e)}
                        onLeave={() => setHover(null)}
                      />
                      {gateway && (
                        <text x={ground.x + peerR + 6} y={ground.y - peerHeight - peerR / 2} fontSize={9} fill={accentColor} fontFamily="var(--font-mono)">
                          ▸ {extraNetworks(p.allowedIps).join(', ')}
                        </text>
                      )}
                    </g>
                  );
                })}
              </g>
            ))}

            {/* Hub, at the center every zone connects to */}
            <DeviceIcon groundX={hub.x} groundY={hub.y} r={hubR} height={hubHeight} deviceType="server" color={accentColor} label={interfaceLabel} />
          </g>
        </svg>

        {peers.length === 0 && (
          <div
            style={{
              position: 'absolute',
              left: '50%',
              top: '50%',
              transform: 'translate(-50%,-50%)',
              fontSize: 12,
              color: 'var(--text-dim)',
              pointerEvents: 'none',
            }}
          >
            No peers yet.
          </div>
        )}
      </div>

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
          {hover.peer.deviceType && (
            <div className="hint-text">Device type: {DEVICE_TYPES.find((t) => t.value === hover.peer.deviceType)?.label || hover.peer.deviceType}</div>
          )}
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
      {groupNodes.length > 0 && (
        <div className="row wrap" style={{ marginTop: 4, gap: 14 }}>
          {groupNodes.map((g) => (
            <span key={g.key} className="row" style={{ gap: 5 }}>
              <span style={{ width: 3, height: 11, background: g.color, display: 'inline-block' }} />
              <span className="hint-text">{g.key}</span>
            </span>
          ))}
        </div>
      )}
      <div className="row wrap" style={{ marginTop: 4, gap: 14 }}>
        <span className="hint-text">
          Grouped by <code>#&nbsp;group:</code> label, or by /24 when unset
        </span>
        <span className="hint-text">Scroll to zoom, drag empty space to pan, drag a zone to reposition it</span>
      </div>
    </div>
  );
}
