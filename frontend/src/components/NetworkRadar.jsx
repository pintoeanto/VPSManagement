import { useEffect, useRef, useState } from 'react';
import { STATUS, peerStatus, formatHandshake, isGatewayPeer, extraNetworks } from '../lib/peerStatus.js';

// How quickly a node's radius eases toward its target each second (higher =
// snappier). Kept low on purpose — "fluid slow" was the ask.
const EASE_PER_SECOND = 0.6;
// Age (seconds) at which a peer sits at the halfway radius; the mapping is
// asymptotic (age/(age+HALF_LIFE)) so it's continuous rather than snapping
// between three fixed rings, and never quite reaches the outer edge —
// that's the "outer ring is infinite time" idea.
const HALF_LIFE_SECONDS = 240;
const RING_FRACS = [0.34, 0.67, 1.0];
// Peers live in a right-facing semicircle so they always land in the
// visible part of the panel (the center sits at the left edge, so the left
// half of each ring is off-canvas by design — "partial circles").
const ARC_START = -Math.PI / 2 + 0.08;
const ARC_END = Math.PI / 2 - 0.08;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 4;
const DEFAULT_VIEW = { zoom: 1, panX: 0, panY: 0 };

function targetRadiusFrac(latestHandshake) {
  if (!latestHandshake) return 0.95;
  const age = Date.now() / 1000 - Number(latestHandshake);
  if (!Number.isFinite(age) || age < 0) return 0.06;
  const frac = age / (age + HALF_LIFE_SECONDS);
  return Math.min(0.95, Math.max(0.06, frac));
}

function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/**
 * Canvas + rAF radar: VPS anchored at the left edge of the panel, peers
 * drift radially toward/away from it as their handshake freshness changes,
 * confined to a right-facing arc so the whole panel width gets used. Slow
 * angular wander (bounded within the arc, not a full sweep) keeps it feeling
 * alive rather than static. Deliberately plain Canvas 2D — no WebGL/Three.js.
 * Supports scroll-to-zoom (toward the cursor) and drag-to-pan, with a reset
 * button back to the default framing.
 */
export function NetworkRadar({ interfaceLabel, peers }) {
  const canvasRef = useRef(null);
  const containerRef = useRef(null);
  const nodeStateRef = useRef(new Map()); // key -> { angle, wanderPhase, wanderFreq, driftSpeed, currentFrac, targetFrac }
  const hitboxesRef = useRef([]); // world-space: [{x,y,r,peer,status}]
  const viewRef = useRef({ ...DEFAULT_VIEW });
  const dragRef = useRef(null); // { startClientX, startClientY, startPanX, startPanY } while dragging
  const [hover, setHover] = useState(null); // { peer, status, screenX, screenY }
  const [dims, setDims] = useState({ width: 640, height: 380 });
  const [, setViewTick] = useState(0); // bump to re-render after button-driven view changes

  // Keep a stable per-peer angle/wander assignment across re-renders so
  // nodes don't reshuffle position when unrelated data (rx/tx bytes) changes.
  useEffect(() => {
    const map = nodeStateRef.current;
    const seen = new Set();
    peers.forEach((p, i) => {
      seen.add(p.publicKey);
      const existing = map.get(p.publicKey);
      const tFrac = targetRadiusFrac(p.latestHandshake);
      if (existing) {
        existing.targetFrac = tFrac;
      } else {
        const span = ARC_END - ARC_START;
        map.set(p.publicKey, {
          angle: ARC_START + (span * (i + 0.5)) / Math.max(peers.length, 1) + (Math.random() - 0.5) * 0.12,
          wanderPhase: Math.random() * Math.PI * 2,
          wanderFreq: 0.04 + Math.random() * 0.04,
          driftSpeed: (Math.random() < 0.5 ? -1 : 1) * (0.01 + Math.random() * 0.015),
          currentFrac: tFrac,
          targetFrac: tFrac,
        });
      }
    });
    for (const key of map.keys()) {
      if (!seen.has(key)) map.delete(key);
    }
  }, [peers]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect?.width;
      if (w) setDims({ width: Math.max(360, w), height: Math.max(320, Math.min(w * 0.6, 480)) });
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  // Non-passive wheel listener so preventDefault actually stops page scroll while zooming.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    function onWheel(e) {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const view = viewRef.current;
      const factor = Math.exp(-e.deltaY * 0.001);
      const newZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, view.zoom * factor));
      // Keep the world point under the cursor fixed on screen while zooming.
      const worldX = (mx - view.panX) / view.zoom;
      const worldY = (my - view.panY) / view.zoom;
      view.panX = mx - worldX * newZoom;
      view.panY = my - worldY * newZoom;
      view.zoom = newZoom;
    }
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const { width, height } = dims;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    const ctx = canvas.getContext('2d');

    let raf;
    let lastTime = performance.now();

    const border = cssVar('--border', '#bdbdbd');
    const textDim = cssVar('--text-dim', '#55555a');
    const text = cssVar('--text', '#1e1e1e');
    const accent = cssVar('--accent-dim', '#0068c7');
    const codeBg = cssVar('--bg-code', '#fafafa');

    const cx = 44;
    const cy = height / 2;
    // Small fixed margin — rings now reach almost to the panel edge. Labels
    // that would run off the right side flip to the peer's left instead of
    // reserving a big permanent margin for them.
    const maxR = Math.min(width - cx - 16, height / 2 - 16);

    function draw(now) {
      const dt = Math.min(0.1, (now - lastTime) / 1000);
      lastTime = now;
      const view = viewRef.current;

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(dpr * view.zoom, 0, 0, dpr * view.zoom, dpr * view.panX, dpr * view.panY);

      // Rings — partial, clipped by the canvas since the center sits at the left edge.
      ctx.strokeStyle = border;
      ctx.lineWidth = 1 / view.zoom;
      RING_FRACS.forEach((f) => {
        ctx.beginPath();
        ctx.arc(cx, cy, maxR * f, 0, Math.PI * 2);
        ctx.stroke();
      });

      // Center VPS node
      ctx.beginPath();
      ctx.arc(cx, cy, 9, 0, Math.PI * 2);
      ctx.fillStyle = accent;
      ctx.strokeStyle = codeBg;
      ctx.lineWidth = 2 / view.zoom;
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = text;
      ctx.font = '11px "SFMono-Regular", Consolas, monospace';
      ctx.textAlign = 'center';
      ctx.fillText(interfaceLabel, cx, cy + 24);

      // Peers
      const hitboxes = [];
      const map = nodeStateRef.current;
      for (const p of peers) {
        const st = map.get(p.publicKey);
        if (!st) continue;
        st.currentFrac += (st.targetFrac - st.currentFrac) * Math.min(1, EASE_PER_SECOND * dt);

        // Bounded wander: drift the base angle back and forth, bouncing off
        // the arc edges instead of sweeping past them into the clipped side.
        st.angle += st.driftSpeed * dt;
        if (st.angle < ARC_START) {
          st.angle = ARC_START;
          st.driftSpeed = Math.abs(st.driftSpeed);
        } else if (st.angle > ARC_END) {
          st.angle = ARC_END;
          st.driftSpeed = -Math.abs(st.driftSpeed);
        }
        const wobble = Math.sin((now / 1000) * st.wanderFreq * Math.PI * 2 + st.wanderPhase) * 0.05;
        const drawAngle = Math.min(ARC_END, Math.max(ARC_START, st.angle + wobble));

        const r = maxR * st.currentFrac;
        const x = cx + r * Math.cos(drawAngle);
        const y = cy + r * Math.sin(drawAngle);

        const status = peerStatus(p.latestHandshake);
        const color = STATUS[status].color;

        // Glow
        const glow = ctx.createRadialGradient(x, y, 0, x, y, 14);
        glow.addColorStop(0, color + '55');
        glow.addColorStop(1, color + '00');
        ctx.beginPath();
        ctx.arc(x, y, 14, 0, Math.PI * 2);
        ctx.fillStyle = glow;
        ctx.fill();

        ctx.beginPath();
        ctx.arc(x, y, 6, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.strokeStyle = codeBg;
        ctx.lineWidth = 1.5 / view.zoom;
        ctx.fill();
        ctx.stroke();

        // Gateway marker: a small outward-pointing arrowhead for peers whose
        // AllowedIPs routes more than just themselves (a whole extra
        // subnet) — never the only signal, the tooltip/legend spell it out too.
        if (isGatewayPeer(p.allowedIps)) {
          const tipD = 15;
          const baseD = 7;
          const spread = 0.4;
          const tipX = x + tipD * Math.cos(drawAngle);
          const tipY = y + tipD * Math.sin(drawAngle);
          const baseX1 = x + baseD * Math.cos(drawAngle - spread);
          const baseY1 = y + baseD * Math.sin(drawAngle - spread);
          const baseX2 = x + baseD * Math.cos(drawAngle + spread);
          const baseY2 = y + baseD * Math.sin(drawAngle + spread);
          ctx.beginPath();
          ctx.moveTo(tipX, tipY);
          ctx.lineTo(baseX1, baseY1);
          ctx.lineTo(baseX2, baseY2);
          ctx.closePath();
          ctx.fillStyle = accent;
          ctx.fill();
        }

        ctx.font = '10px "SFMono-Regular", Consolas, monospace';
        ctx.fillStyle = textDim;
        const labelWidth = ctx.measureText(p.name).width;
        const roomOnRight = width - x - 14;
        if (labelWidth + 10 <= roomOnRight) {
          ctx.textAlign = 'left';
          ctx.fillText(p.name, x + 10, y + 3);
        } else {
          ctx.textAlign = 'right';
          ctx.fillText(p.name, x - 10, y + 3);
        }

        hitboxes.push({ x, y, r: 9, peer: p, status });
      }
      hitboxesRef.current = hitboxes;

      raf = requestAnimationFrame(draw);
    }
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [dims, peers, interfaceLabel]);

  function screenToWorld(clientX, clientY) {
    const rect = canvasRef.current.getBoundingClientRect();
    const view = viewRef.current;
    const mx = clientX - rect.left;
    const my = clientY - rect.top;
    return { x: (mx - view.panX) / view.zoom, y: (my - view.panY) / view.zoom, rect };
  }

  function handlePointerDown(e) {
    dragRef.current = {
      startClientX: e.clientX,
      startClientY: e.clientY,
      startPanX: viewRef.current.panX,
      startPanY: viewRef.current.panY,
      moved: false,
    };
    canvasRef.current.setPointerCapture(e.pointerId);
    canvasRef.current.style.cursor = 'grabbing';
  }

  function handlePointerMove(e) {
    const drag = dragRef.current;
    if (drag) {
      const dx = e.clientX - drag.startClientX;
      const dy = e.clientY - drag.startClientY;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) drag.moved = true;
      viewRef.current.panX = drag.startPanX + dx;
      viewRef.current.panY = drag.startPanY + dy;
      setHover(null);
      return;
    }
    const { x, y, rect } = screenToWorld(e.clientX, e.clientY);
    const hit = hitboxesRef.current.find((h) => Math.hypot(h.x - x, h.y - y) <= h.r);
    if (hit) {
      const view = viewRef.current;
      setHover({
        peer: hit.peer,
        status: hit.status,
        screenX: rect.left + hit.x * view.zoom + view.panX,
        screenY: rect.top + hit.y * view.zoom + view.panY,
      });
    } else {
      setHover(null);
    }
  }

  function handlePointerUp() {
    dragRef.current = null;
  }

  function zoomBy(factor) {
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const view = viewRef.current;
    const mx = rect.width / 2;
    const my = rect.height / 2;
    const newZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, view.zoom * factor));
    const worldX = (mx - view.panX) / view.zoom;
    const worldY = (my - view.panY) / view.zoom;
    view.panX = mx - worldX * newZoom;
    view.panY = my - worldY * newZoom;
    view.zoom = newZoom;
    setViewTick((t) => t + 1);
  }

  function resetView() {
    viewRef.current = { ...DEFAULT_VIEW };
    setViewTick((t) => t + 1);
  }

  return (
    <div ref={containerRef} style={{ position: 'relative', width: '100%' }}>
      <div className="row" style={{ position: 'absolute', top: 0, right: 0, zIndex: 10, gap: 4 }}>
        <button onClick={() => zoomBy(1.25)} title="Zoom in">
          +
        </button>
        <button onClick={() => zoomBy(0.8)} title="Zoom out">
          −
        </button>
        <button onClick={resetView} title="Reset view">
          Reset view
        </button>
      </div>
      <canvas
        ref={canvasRef}
        style={{
          width: dims.width,
          height: dims.height,
          display: 'block',
          cursor: dragRef.current ? 'grabbing' : hover ? 'pointer' : 'grab',
          touchAction: 'none',
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerLeave={() => setHover(null)}
      />
      {hover && (
        <div
          style={{
            position: 'fixed',
            left: hover.screenX + 14,
            top: hover.screenY + 14,
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
          {isGatewayPeer(hover.peer.allowedIps) && (
            <div className="hint-text mono" style={{ color: 'var(--accent-dim)' }}>
              ▲ Gateway to: {extraNetworks(hover.peer.allowedIps).join(', ')}
            </div>
          )}
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
          <span style={{ color: 'var(--accent-dim)', fontSize: 11 }}>▲</span>
          <span className="hint-text">Routes an additional subnet</span>
        </span>
        <span className="hint-text">Scroll to zoom, drag to pan</span>
      </div>
    </div>
  );
}
