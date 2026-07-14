import { useEffect, useRef, useState } from 'react';
import {
  STATUS,
  peerStatus,
  formatHandshake,
  isGatewayPeer,
  extraNetworks,
  GOOD_THRESHOLD_SECONDS,
  WARNING_THRESHOLD_SECONDS,
  consumptionFractions,
  peerTransferBytes,
  formatBytes,
} from '../lib/peerStatus.js';

const RING_FRACS = [0.34, 0.67, 1.0];
const FULL_CIRCLE = Math.PI * 2;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 4;
const DEFAULT_VIEW = { zoom: 1, panX: 0, panY: 0 };
// Minimum comfortable world-space gap between two meditating (good-status)
// peers before they start gently pushing each other apart.
const MIN_SEPARATION = 26;

// Click-and-hold: a user can pick a peer dot up and drag it anywhere on
// screen. Let go outside its status band and it doesn't teleport back — a
// damped spring pulls it home with a little organic overshoot-and-settle,
// the way a released rubber band recoils rather than snapping rigidly.
const SPRING_STIFFNESS = 55;
const SPRING_DAMPING = 9;

// Pulsar burst: fired once every time a peer's handshake timestamp actually
// advances (a fresh handshake just happened), not a continuous ambient
// glow — a ring expands outward from the dot and fades, like a pulsar's
// beam sweeping past. Two staggered rings per burst reads richer than one.
const PULSE_DURATION_MS = 1400;
const PULSE_RING_DELAYS = [0, 0.4];

// The three rings ARE the three status zones (good/warning/critical, same
// thresholds STATUS/peerStatus already use for dot color) — each status
// still only ever occupies its own ring band ("critical" between ring 2 and
// ring 3, etc), but *within* that band a peer's exact distance is now a
// continuous function of handshake age (see continuousRadiusFrac), not a
// random wander — so it's a live clock, not just a fixed zone. Insets keep
// dots off the ring lines themselves.
const STATUS_BAND = {
  good: [0.06, RING_FRACS[0] - 0.05],
  warning: [RING_FRACS[0] + 0.05, RING_FRACS[1] - 0.05],
  critical: [RING_FRACS[1] + 0.05, RING_FRACS[2] - 0.04],
};

// How long a "critical" peer keeps creeping outward past the point it went
// critical before settling at the band's outer edge — a peer that just
// tipped over the warning threshold starts at the band's inner edge, not
// immediately parked at the far rim.
const CRITICAL_SATURATE_SECONDS = 900;

// A fresh handshake resets a peer's age-target back to ~0 — the SAME
// radial spring used for the ordinary, barely-moving-per-frame aging drift
// naturally overshoots and settles on a sudden reset like that, so "slow
// and bouncy on the way back to wg0" falls out of one spring rather than
// needing a second, separate mechanism. Underdamped on purpose (well below
// critical damping for this stiffness, 2*sqrt(12)≈6.9).
const RADIAL_STIFFNESS = 12;
const RADIAL_DAMPING = 4.5;

// Data-consumption ring: a small halo drawn around each peer's dot, gray
// track + green arc proportional to that peer's share of the tunnel's total
// rx+tx bytes — a separate visual channel from the dot's own status color,
// so "how much data" and "how healthy is the connection" never compete for
// the same color.
const CONSUMPTION_RING_COLOR = '#1fa855';

// The warning band's color itself creeps from yellow toward orange as a
// peer nears the critical threshold — an early, gradual warning instead of
// one flat color for the whole 180s-600s span.
const WARNING_COLOR_NEAR = '#fab219';
const WARNING_COLOR_FAR = '#f2791a';

// Every peer is an "attention seeker" — it must always stay inside the
// currently visible viewport, at any zoom/pan, so it never wanders off-
// screen and out of sight. Screen-space margin (kept clear of the edge for
// the dot + its label), converted to world units fresh every frame since
// that conversion depends on the live zoom level.
const VIEWPORT_MARGIN_PX = 30;

function lerpColorHex(hexA, hexB, t) {
  const a = parseInt(hexA.slice(1), 16);
  const b = parseInt(hexB.slice(1), 16);
  const ar = (a >> 16) & 255;
  const ag = (a >> 8) & 255;
  const ab = a & 255;
  const br = (b >> 16) & 255;
  const bg = (b >> 8) & 255;
  const bb = b & 255;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bch = Math.round(ab + (bb - ab) * t);
  return `#${[r, g, bch].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

// Single source of truth for "where should this peer sit right now, and
// what color is it" — both driven continuously by handshake age rather
// than a discrete band lookup, computed once per peer per frame and reused
// for the radial spring target, the springback target, and rendering.
function peerContinuousState(p, status) {
  const hasHandshake = !!p.latestHandshake;
  const ageSeconds = hasHandshake ? Math.max(0, Date.now() / 1000 - Number(p.latestHandshake)) : Infinity;

  if (!hasHandshake || status === 'critical') {
    const t = hasHandshake ? Math.min(1, (ageSeconds - WARNING_THRESHOLD_SECONDS) / CRITICAL_SATURATE_SECONDS) : 1;
    return { frac: STATUS_BAND.critical[0] + t * (STATUS_BAND.critical[1] - STATUS_BAND.critical[0]), color: STATUS.critical.color };
  }
  if (status === 'good') {
    const t = ageSeconds / GOOD_THRESHOLD_SECONDS;
    return { frac: STATUS_BAND.good[0] + t * (STATUS_BAND.good[1] - STATUS_BAND.good[0]), color: STATUS.good.color };
  }
  const t = (ageSeconds - GOOD_THRESHOLD_SECONDS) / (WARNING_THRESHOLD_SECONDS - GOOD_THRESHOLD_SECONDS);
  return {
    frac: STATUS_BAND.warning[0] + t * (STATUS_BAND.warning[1] - STATUS_BAND.warning[0]),
    color: lerpColorHex(WARNING_COLOR_NEAR, WARNING_COLOR_FAR, Math.min(1, Math.max(0, t))),
  };
}

function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

// Recompute the canvas's DPI-correct buffer size from its current CSS
// (logical) size and push it to the element — but only actually touch
// canvas.width/height when they've changed, since reassigning either
// property clears the canvas immediately regardless of value, which would
// otherwise flash the canvas blank on every call even when nothing moved.
// Called fresh every frame (not just on a resize event) so a live-dragged
// resize is picked up on the very next paint without needing to tear down
// and restart the whole draw loop.
function syncCanvasSize(canvas, width, height) {
  const dpr = window.devicePixelRatio || 1;
  const pixelWidth = Math.round(width * dpr);
  const pixelHeight = Math.round(height * dpr);
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  return dpr;
}

// Where a ray from (cx,cy) in `angle` direction exits the visible world
// rect — used to place an off-screen indicator right at the edge of what's
// currently in view. Assumes the origin is inside the rect (true for the
// hub in all but the most extreme pans), matching the same "exit point"
// shortcut used elsewhere in this file's confinement math.
function rayToRectEdge(cx, cy, angle, left, right, top, bottom) {
  const ux = Math.cos(angle);
  const uy = Math.sin(angle);
  let t = Infinity;
  if (ux > 0) t = Math.min(t, (right - cx) / ux);
  else if (ux < 0) t = Math.min(t, (left - cx) / ux);
  if (uy > 0) t = Math.min(t, (bottom - cy) / uy);
  else if (uy < 0) t = Math.min(t, (top - cy) / uy);
  if (!isFinite(t) || t < 0) t = 0;
  return { x: cx + t * ux, y: cy + t * uy };
}

// The classic RTS-minimap "something's out there" marker: a narrow,
// elongated triangle sitting just inside the visible edge, its long axis
// pointing straight out toward the off-screen peer(s) it represents.
function drawEdgePointer(ctx, x, y, angle, zoom, color) {
  const tipLen = 13 / zoom;
  const backLen = 7 / zoom;
  const halfWidth = 3.2 / zoom;
  const ux = Math.cos(angle);
  const uy = Math.sin(angle);
  const px = -uy;
  const py = ux;
  const tipX = x + ux * tipLen;
  const tipY = y + uy * tipLen;
  const backX = x - ux * backLen;
  const backY = y - uy * backLen;
  ctx.beginPath();
  ctx.moveTo(tipX, tipY);
  ctx.lineTo(backX + px * halfWidth, backY + py * halfWidth);
  ctx.lineTo(backX - px * halfWidth, backY - py * halfWidth);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

// A held or springing-back peer's light-beam is drawn as a tapered spindle
// instead of a uniform-width stroke — wide at the hub, wide at the dot,
// pinched in the middle — so the more it's stretched the thinner its
// waist gets, like a rubber band under tension. `stretch` is 0..1.
function drawElasticBeam(ctx, x1, y1, x2, y2, baseHalfWidth, stretch, fillStyle) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const px = -uy;
  const py = ux;
  // The idle beam is deliberately hair-thin, so a taper scaled off that
  // alone would be imperceptible — while actively stretched, the anchors
  // themselves widen too (rubber pooling at the ends under tension), which
  // is what actually makes the pinched waist read as elastic rather than
  // just "a slightly uneven line."
  const endHalf = baseHalfWidth * (2.2 + stretch * 4.5);
  const midHalf = Math.max(baseHalfWidth * 0.15, endHalf * (1 - stretch * 0.92));
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  ctx.beginPath();
  ctx.moveTo(x1 + px * endHalf, y1 + py * endHalf);
  ctx.lineTo(mx + px * midHalf, my + py * midHalf);
  ctx.lineTo(x2 + px * endHalf, y2 + py * endHalf);
  ctx.lineTo(x2 - px * endHalf, y2 - py * endHalf);
  ctx.lineTo(mx - px * midHalf, my - py * midHalf);
  ctx.lineTo(x1 - px * endHalf, y1 - py * endHalf);
  ctx.closePath();
  ctx.fillStyle = fillStyle;
  ctx.fill();
}

/**
 * Canvas + rAF radar: the VPS sits at the center, and each peer's distance
 * from it is a continuous function of handshake age — a spring tracks a
 * live age-derived target radius, always somewhere inside that peer's own
 * status band (good inside ring 1, warning strictly between ring 1 and 2,
 * critical strictly between ring 2 and 3 — a peer can never visually claim
 * a status it doesn't have), with a hard world-space clamp on that same
 * band as a safety net against anything (separation, a drag-release bounce)
 * nudging it further. That band confinement is entirely in world-space —
 * hub-relative, independent of pan/zoom — so it never fights panning or
 * zooming directly.
 *
 * Layered on top of that (see the "attention seeker" viewport confinement
 * block in the draw loop): every peer must also always stay inside whatever
 * portion of the world is currently visible. The visible world rect is
 * inverted from the live pan/zoom transform fresh every frame; a peer whose
 * position has drifted outside it is rotated — angle only, radius never
 * touched — to wherever its own exact ring actually crosses that rect,
 * solved analytically per edge. Radius is deliberately off-limits here: the
 * three status bands are strict non-overlapping rings, so pulling an
 * off-screen peer inward to reach the viewport would walk it into a ring it
 * doesn't belong to, which this confinement must never do — it can only
 * slide a peer along its own correct ring, never toward or away from the
 * hub. Deliberately plain Canvas 2D — no WebGL/Three.js. Supports
 * scroll-to-zoom (toward the cursor) and drag-to-pan, with a reset button
 * back to the default framing.
 */
export function NetworkRadar({ interfaceLabel, peers, fullscreen }) {
  const canvasRef = useRef(null);
  const canvasWrapRef = useRef(null); // the flex-grown wrapper around the canvas — measured directly for sizing, so fullscreen height comes from real layout, not a guess
  const nodeStateRef = useRef(new Map()); // key -> { x, y, vx, vy } — world-space physics state
  const hitboxesRef = useRef([]); // world-space: [{x,y,r,peer,status}]
  const viewRef = useRef({ ...DEFAULT_VIEW });
  const dragRef = useRef(null); // { startClientX, startClientY, startPanX, startPanY } while panning the view
  const draggedKeyRef = useRef(null); // publicKey of the peer currently being hand-dragged, if any
  const [hover, setHover] = useState(null); // { peer, status, screenX, screenY }
  const [dims, setDims] = useState({ width: 640, height: 380 });
  const dimsRef = useRef(dims); // mirrors `dims` for the draw loop to read fresh each frame without needing dims in its own effect deps
  const [, setViewTick] = useState(0); // bump to re-render after button-driven view changes
  const prevDimsRef = useRef(null); // last dims this effect actually ran with, for the resize rescale below
  dimsRef.current = dims; // kept live every render — safe, since it's only ever read from the async rAF loop, never during render

  // Seed new peers with a starting position/velocity; existing peers keep
  // their live physics state untouched here — the collision loop in the
  // draw effect is what reacts to a status change (band membership is
  // re-checked from live data every frame, not cached at mount time).
  useEffect(() => {
    const map = nodeStateRef.current;
    const seen = new Set();
    const cx = dims.width / 2;
    const cy = dims.height / 2;
    const maxRx = Math.min(dims.width, dims.height) / 2 - 20;
    const maxRy = maxRx;

    // The panel resizing (window resize, fullscreen toggle, sidebar
    // collapse...) moves the hub and rescales the rings, but every peer's
    // x/y is stored in absolute canvas pixels — left untouched, they'd
    // visibly jump relative to the new hub position instead of staying put.
    // Rescale every existing peer proportionally around the new center so
    // its relative angle and radius fraction survive the resize exactly.
    const prevDims = prevDimsRef.current;
    if (prevDims && (prevDims.width !== dims.width || prevDims.height !== dims.height) && map.size > 0) {
      const prevCx = prevDims.width / 2;
      const prevCy = prevDims.height / 2;
      const prevMaxRx = Math.min(prevDims.width, prevDims.height) / 2 - 20;
      if (prevMaxRx > 0) {
        const scale = maxRx / prevMaxRx;
        for (const st of map.values()) {
          st.x = cx + (st.x - prevCx) * scale;
          st.y = cy + (st.y - prevCy) * scale;
        }
      }
    }
    prevDimsRef.current = dims;

    peers.forEach((p, i) => {
      seen.add(p.publicKey);
      if (!map.has(p.publicKey)) {
        const [lo, hi] = STATUS_BAND[peerStatus(p.latestHandshake)];
        const frac = lo + Math.random() * (hi - lo);
        const placeAngle = (FULL_CIRCLE * (i + 0.5)) / Math.max(peers.length, 1) + (Math.random() - 0.5) * 0.4;
        const speed = 4 + Math.random() * 6; // "fluid slow" — world units/sec
        const moveAngle = Math.random() * FULL_CIRCLE;
        map.set(p.publicKey, {
          x: cx + maxRx * frac * Math.cos(placeAngle),
          y: cy + maxRy * frac * Math.sin(placeAngle),
          vx: Math.cos(moveAngle) * speed,
          vy: Math.sin(moveAngle) * speed,
          baseSpeed: speed,
          dragging: false, // true while the user is actively holding this dot
          springingBack: false, // true while it's elastically recoiling home after release
          lastHandshake: p.latestHandshake ?? null,
          pulseStartedAt: null, // rAF timestamp a pulsar burst started, or null when idle
        });
        return;
      }
      // Existing peer — a newly-arrived handshake timestamp (not just a
      // still-loading poll returning the same value) fires a one-shot
      // pulsar burst. Guards against the initial mount case above (a brand
      // new node never bursts just for being seen for the first time).
      const st = map.get(p.publicKey);
      const cur = p.latestHandshake ?? null;
      if (cur != null && Number(cur) !== Number(st.lastHandshake) && (st.lastHandshake == null || Number(cur) > Number(st.lastHandshake))) {
        st.pulseStartedAt = performance.now();
      }
      st.lastHandshake = cur;
    });
    for (const key of map.keys()) {
      if (!seen.has(key)) map.delete(key);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peers, dims.width, dims.height]);

  useEffect(() => {
    const el = canvasWrapRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect?.width;
      const h = entries[0]?.contentRect?.height;
      if (!w) return;
      if (fullscreen) {
        // canvasWrapRef is flex:1 inside the fullscreen column (toolbar +
        // tabs + this + legend), so its own contentRect.height IS exactly
        // the space left over after the legend below it takes its share —
        // measured from real layout, not guessed via window.innerHeight.
        if (!h) return;
        setDims({ width: Math.max(360, w), height: Math.max(320, h) });
      } else {
        // Capped at 480px normally so the radar doesn't dominate the page inline.
        setDims({ width: Math.max(360, w), height: Math.max(320, Math.min(w * 0.6, 480)) });
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [fullscreen]);

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
    const ctx = canvas.getContext('2d');

    let raf;
    let lastTime = performance.now();

    const textDim = cssVar('--text-dim', '#55555a');
    const text = cssVar('--text', '#1e1e1e');
    const accent = cssVar('--accent-dim', '#0068c7');
    const codeBg = cssVar('--bg-code', '#fafafa');

    function draw(now) {
      const dt = Math.min(0.1, (now - lastTime) / 1000);
      lastTime = now;
      const view = viewRef.current;

      // Canvas size is recalculated fresh every frame from the live
      // container dims (a ref, not a value captured once when this effect
      // last ran) and pushed to the canvas element's own buffer — so a
      // resize (dragging the fullscreen window, the ResizeObserver firing
      // mid-drag, a sidebar collapse...) is picked up smoothly on the very
      // next frame, without tearing down and restarting this whole rAF
      // loop the way depending on `dims` here would (which previously
      // reset lastTime and re-fetched CSS vars on every resize tick,
      // flashing the canvas blank each time).
      const { width, height } = dimsRef.current;
      const dpr = syncCanvasSize(canvas, width, height);

      // Centered, not pinned to the left edge — peers now wander the full
      // ring (both sides), so the hub needs equal room in every direction for
      // the default framing to show the whole ring without any edge-hugging.
      const cx = width / 2;
      const cy = height / 2;
      const maxRx = Math.min(width, height) / 2 - 20;
      const maxRy = maxRx;

      // Bounded panning: clamp so the hub itself can never be dragged fully
      // off-canvas — everything else (peers, rings) is positioned relative
      // to it, so keeping the hub reachable within a margin keeps the whole
      // constellation from getting lost off-screen, in either direction.
      // (Clamping the outer content's bounding box instead — checked
      // independently at each edge — sounds equivalent but isn't: for
      // content wider than the canvas, both edge checks can pass at once
      // while the hub itself, in the middle, is the part that's off-screen.)
      const panMargin = 70;
      const minPanX = panMargin - cx * view.zoom;
      const maxPanX = width - panMargin - cx * view.zoom;
      const minPanY = panMargin - cy * view.zoom;
      const maxPanY = height - panMargin - cy * view.zoom;
      view.panX = Math.min(maxPanX, Math.max(minPanX, view.panX));
      view.panY = Math.min(maxPanY, Math.max(minPanY, view.panY));

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(dpr * view.zoom, 0, 0, dpr * view.zoom, dpr * view.panX, dpr * view.panY);

      // Shaded ring bands — no outline strokes at all; the three status
      // zones (good/warning/critical) read purely as gray regions of
      // increasing opacity, each drawn as the outer ellipse minus the
      // previous one via the evenodd fill rule.
      const RING_BAND_ALPHA = ['00', '11', '16']; // 0.2, 0.4, 0.6
      RING_FRACS.forEach((f, i) => {
        ctx.beginPath();
        ctx.ellipse(cx, cy, maxRx * f, maxRy * f, 0, 0, Math.PI * 2);
        if (i > 0) {
          ctx.ellipse(cx, cy, maxRx * RING_FRACS[i - 1], maxRy * RING_FRACS[i - 1], 0, 0, Math.PI * 2, true);
        }
        ctx.fillStyle = textDim + RING_BAND_ALPHA[i];
        ctx.fill('evenodd');
      });

      // Center VPS node — the sun everything else orbits/worships. A slow
      // breathing pulse on the corona keeps it feeling alive without being
      // distracting. Same zoom-invariant sizing as the peer dots/labels.
      const hubNodeR = 12 / view.zoom;
      const hubFontPx = 11 / view.zoom;
      const pulse = 1 + Math.sin((now / 1000) * 0.6) * 0.1;
      const coronaR = hubNodeR * 3.4 * pulse;
      const corona = ctx.createRadialGradient(cx, cy, 0, cx, cy, coronaR);
      corona.addColorStop(0, accent + 'aa');
      corona.addColorStop(0.45, accent + '40');
      corona.addColorStop(1, accent + '00');
      ctx.beginPath();
      ctx.arc(cx, cy, coronaR, 0, Math.PI * 2);
      ctx.fillStyle = corona;
      ctx.fill();

      ctx.beginPath();
      ctx.arc(cx, cy, hubNodeR, 0, Math.PI * 2);
      ctx.fillStyle = accent;
      ctx.strokeStyle = codeBg;
      ctx.lineWidth = 2 / view.zoom;
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = text;
      ctx.font = `${hubFontPx}px "SFMono-Regular", Consolas, monospace`;
      ctx.textAlign = 'center';
      ctx.fillText(interfaceLabel, cx, cy + hubNodeR + 15 / view.zoom);

      // Visible-world rect for this frame's viewport confinement — inverted
      // from the live pan/zoom transform once here (not per-peer) since
      // every peer shares the same viewport. Inset by a margin (converted
      // from screen px to world units at the current zoom) so a confined
      // dot's glow/label still clears the physical edge of the canvas.
      const viewportMarginWorld = VIEWPORT_MARGIN_PX / view.zoom;
      const visLeft = (0 - view.panX) / view.zoom + viewportMarginWorld;
      const visRight = (width - view.panX) / view.zoom - viewportMarginWorld;
      const visTop = (0 - view.panY) / view.zoom + viewportMarginWorld;
      const visBottom = (height - view.panY) / view.zoom - viewportMarginWorld;

      // Peers
      const fractions = consumptionFractions(peers);
      const hitboxes = [];
      // Off-screen edge pointers — populated below for any peer whose ring
      // never crosses the visible rect at all (the documented edge case in
      // the viewport-confinement block: a peer stays on its correct ring
      // even when that whole ring is out of view, rather than being pulled
      // inward). Bucketed by a coarse angle so several peers hidden in
      // roughly the same direction share one pointer instead of stacking.
      const offscreenBuckets = new Map(); // bucketKey -> { angle, color, count }
      const OFFSCREEN_BUCKET_RAD = 0.18;
      const map = nodeStateRef.current;
      for (const p of peers) {
        const st = map.get(p.publicKey);
        if (!st) continue;

        const status = peerStatus(p.latestHandshake);
        const { frac: targetFrac, color } = peerContinuousState(p, status);

        if (st.dragging) {
          // Direct manipulation — position is already being set by the
          // pointer-move handler every frame; no forces apply while the
          // user is actively holding this dot, and it's free to wander
          // outside its own status band until released.
        } else if (st.springingBack) {
          // Elastic recoil: a damped spring pulls the dot back toward the
          // nearest valid point in its status band. Underdamped on purpose
          // (SPRING_DAMPING is below critical for SPRING_STIFFNESS) so it
          // overshoots and settles rather than gliding straight in — an
          // organic snap-back instead of a mechanical slide.
          const dx0 = st.x - cx;
          const dy0 = st.y - cy;
          const edist = Math.hypot(dx0 / maxRx, dy0 / maxRy) || 0.0001;
          const scale = targetFrac / edist;
          const targetX = cx + dx0 * scale;
          const targetY = cy + dy0 * scale;
          const ax = (targetX - st.x) * SPRING_STIFFNESS - st.vx * SPRING_DAMPING;
          const ay = (targetY - st.y) * SPRING_STIFFNESS - st.vy * SPRING_DAMPING;
          st.vx += ax * dt;
          st.vy += ay * dt;
          st.x += st.vx * dt;
          st.y += st.vy * dt;
          const settleDist = Math.hypot(st.x - targetX, st.y - targetY);
          const speed = Math.hypot(st.vx, st.vy);
          if (settleDist < 1.5 && speed < 8) {
            st.springingBack = false;
            // Hand back to normal wandering with a small, direction-valid
            // nudge rather than exactly zero velocity (zero would leave the
            // speed-damping math above with no direction to normalize).
            const wakeAngle = Math.random() * FULL_CIRCLE;
            st.vx = Math.cos(wakeAngle) * st.baseSpeed * 0.2;
            st.vy = Math.sin(wakeAngle) * st.baseSpeed * 0.2;
          }
        } else {
          // Continuous handshake-age radial positioning: a peer's distance
          // from the hub is a live function of how long it's been since its
          // last handshake — fresh means "right next to wg0", and it creeps
          // steadily outward the longer it goes without a new one, instead
          // of wandering randomly within a fixed band. Velocity is split
          // into a radial component (toward/away from the hub) and a
          // tangential one (orbiting) — radial is pulled by a spring toward
          // the live age target; since that target normally only creeps a
          // hair each frame, the spring just tracks it smoothly, and only
          // overshoots into a slow bounce when a fresh handshake yanks it
          // sharply inward (see RADIAL_STIFFNESS/RADIAL_DAMPING).
          const dx0 = st.x - cx;
          const dy0 = st.y - cy;
          const curDist = Math.hypot(dx0, dy0) || 0.0001;
          const ux = dx0 / curDist;
          const uy = dy0 / curDist;
          const targetDist = targetFrac * maxRx;

          const radialSpeed = st.vx * ux + st.vy * uy;
          const tangentialVx = st.vx - radialSpeed * ux;
          const tangentialVy = st.vy - radialSpeed * uy;

          // Peers are meditating, not spinning — the tangential (orbiting)
          // component is eased down to a very subtle drift instead of left
          // at raw wander speed, which at the small radius near the hub
          // would otherwise read as aggressive circling. Good/connected
          // peers meditate almost still; farther-out (aging) peers get a
          // little more allowance, but everything stays subtle.
          const tangentialSpeed = Math.hypot(tangentialVx, tangentialVy) || 0.0001;
          const targetTangentialSpeed = st.baseSpeed * (status === 'good' ? 0.05 : status === 'warning' ? 0.18 : 0.28);
          const nextTangentialSpeed = tangentialSpeed + (targetTangentialSpeed - tangentialSpeed) * Math.min(1, 0.8 * dt);
          const dampedTangentialVx = (tangentialVx / tangentialSpeed) * nextTangentialSpeed;
          const dampedTangentialVy = (tangentialVy / tangentialSpeed) * nextTangentialSpeed;

          const radialError = targetDist - curDist;
          const radialAccel = radialError * RADIAL_STIFFNESS - radialSpeed * RADIAL_DAMPING;
          const newRadialSpeed = radialSpeed + radialAccel * dt;
          st.vx = dampedTangentialVx + newRadialSpeed * ux;
          st.vy = dampedTangentialVy + newRadialSpeed * uy;

          st.x += st.vx * dt;
          st.y += st.vy * dt;
        }

        // Every peer keeps a respectful distance from every other, not just
        // from the sun — a gentle mutual push-apart whenever two peers end
        // up closer than MIN_SEPARATION. Applied last, after the ring/edge
        // collisions above, deliberately: those collisions hard-set position
        // to an exact boundary coordinate, which would otherwise stack
        // multiple peers pinned to the very same wall — or pulled to the
        // very same flock-cohesion point — on the identical pixel, undoing
        // any earlier separation nudge. Applied directly to position (not
        // velocity) — a near-stationary meditating peer's speed is damped
        // so low that a velocity nudge here would just get damped away
        // again next frame before it could accumulate into any real
        // separation. Skipped entirely for a peer that's currently held or
        // springing back — it shouldn't fight the user's direct
        // manipulation or the spring's own recoil path — but idle peers
        // still push away from it below (their own loop includes it), so
        // the flock naturally parts around a dot the user is dragging
        // through it.
        if (!st.dragging && !st.springingBack) {
          let pushX = 0;
          let pushY = 0;
          for (const other of map.values()) {
            if (other === st) continue;
            const ddx = st.x - other.x;
            const ddy = st.y - other.y;
            const d = Math.hypot(ddx, ddy);
            if (d < MIN_SEPARATION) {
              const force = (MIN_SEPARATION - d) / MIN_SEPARATION;
              // Two peers hard-clamped to the exact same edge/corner land on
              // literally the same point — d is 0, so (ddx/d, ddy/d) is a
              // degenerate 0/0 "direction" that pushes nowhere, and they'd
              // stay stacked forever despite "colliding". Fall back to a
              // direction derived from each peer's own (stable, already
              // random) baseSpeed so coincident peers still separate, each
              // toward a different, consistent direction.
              if (d < 0.5) {
                const fallbackAngle = (st.baseSpeed * 137.5) % FULL_CIRCLE;
                pushX += Math.cos(fallbackAngle) * force;
                pushY += Math.sin(fallbackAngle) * force;
              } else {
                pushX += (ddx / d) * force;
                pushY += (ddy / d) * force;
              }
            }
          }
          st.x += pushX * 34 * dt;
          st.y += pushY * 34 * dt;

          // Hard safety net, entirely in world-space (hub-relative, no
          // dependency on pan/zoom): after the spring and the separation
          // nudge above, clamp the peer back inside its own status band's
          // radius range so it can never visually cross into a different
          // ring's territory, no matter what pushed it there. Normally a
          // no-op — the spring already tracks well within-band — it only
          // engages when separation (or several peers crowding the same
          // spot) has shoved a peer past its band edge.
          const [bandLo, bandHi] = STATUS_BAND[status];
          const bcx = st.x - cx;
          const bcy = st.y - cy;
          const bedist = Math.hypot(bcx / maxRx, bcy / maxRy) || 0.0001;
          if (bedist < bandLo || bedist > bandHi) {
            const bscale = (bedist < bandLo ? bandLo : bandHi) / bedist;
            st.x = cx + bcx * bscale;
            st.y = cy + bcy * bscale;
          }

          // Viewport confinement — "attention seeker": every peer must stay
          // visible at any zoom/pan. Crucially this must NEVER change the
          // peer's radius — the three status bands are strict, non-
          // overlapping rings (good ends exactly where warning begins, and
          // so on), so pulling an off-screen peer inward toward the hub to
          // reach the viewport would visually walk it into a ring it
          // doesn't belong to, which is worse than being off-screen. So
          // instead: solve analytically for where THIS peer's own ring
          // (fixed radius, unchanged) actually crosses the visible rect's 4
          // edges, and rotate the peer — angle only — to the point on that
          // ring closest to its current bearing that lies within one of the
          // resulting visible arcs. It "respawns" on the still-visible part
          // of its own ring, never a different one. Skipped entirely when
          // the peer is already visible, so normal meditation/grazing
          // motion at the default framing (the common case) is untouched.
          if (st.x < visLeft || st.x > visRight || st.y < visTop || st.y > visBottom) {
            const ringR = Math.hypot(st.x - cx, st.y - cy) || 0.0001;
            const curAngle = Math.atan2(st.y - cy, st.x - cx);

            // Angles where this exact ring crosses each of the 4 rect
            // edges (solving (edge - cx/cy)^2 + (other)^2 = ringR^2 per
            // edge, keeping only crossings that fall within that edge's
            // actual segment) — these split the ring into arcs, some
            // inside the rect and some outside.
            const crossAngles = [];
            for (let s = 0; s < 2; s++) {
              const X = s === 0 ? visLeft : visRight;
              const rhs = ringR * ringR - (X - cx) * (X - cx);
              if (rhs >= 0) {
                const dy = Math.sqrt(rhs);
                const y1 = cy + dy;
                const y2 = cy - dy;
                if (y1 >= visTop && y1 <= visBottom) crossAngles.push(Math.atan2(y1 - cy, X - cx));
                if (y2 >= visTop && y2 <= visBottom) crossAngles.push(Math.atan2(y2 - cy, X - cx));
              }
            }
            for (let s = 0; s < 2; s++) {
              const Y = s === 0 ? visTop : visBottom;
              const rhs = ringR * ringR - (Y - cy) * (Y - cy);
              if (rhs >= 0) {
                const dx = Math.sqrt(rhs);
                const x1 = cx + dx;
                const x2 = cx - dx;
                if (x1 >= visLeft && x1 <= visRight) crossAngles.push(Math.atan2(Y - cy, x1 - cx));
                if (x2 >= visLeft && x2 <= visRight) crossAngles.push(Math.atan2(Y - cy, x2 - cx));
              }
            }

            let targetAngle = null;
            if (crossAngles.length >= 2) {
              crossAngles.sort((a, b) => a - b);
              let bestDist = Infinity;
              for (let i = 0; i < crossAngles.length; i++) {
                const lo = crossAngles[i];
                const hi = i + 1 < crossAngles.length ? crossAngles[i + 1] : crossAngles[0] + FULL_CIRCLE;
                const mid = (lo + hi) / 2;
                const midX = cx + ringR * Math.cos(mid);
                const midY = cy + ringR * Math.sin(mid);
                if (midX < visLeft || midX > visRight || midY < visTop || midY > visBottom) continue;
                // This arc lies inside the visible rect — find the angle
                // within it closest to curAngle (shifted into the same
                // winding as [lo, hi], which may extend past PI).
                let ca = curAngle;
                if (ca < lo) ca += FULL_CIRCLE;
                const clamped = Math.min(hi, Math.max(lo, ca));
                let d = Math.abs(clamped - curAngle);
                if (d > Math.PI) d = FULL_CIRCLE - d;
                if (d < bestDist) {
                  bestDist = d;
                  targetAngle = clamped;
                }
              }
            }
            if (targetAngle == null) {
              // Either the ring never crosses the rect at all, or it
              // crosses but no resulting arc actually lies inside it (a
              // sliver of viewport slicing through without containing any
              // of the ring) — this peer's ring can't be made visible at
              // this zoom/pan. Hold it at the angle facing the rect's
              // nearest point instead of leaving it wherever it drifted;
              // not guaranteed on-screen in this edge case, but always on
              // its own correct ring.
              const clampedX = Math.min(visRight, Math.max(visLeft, st.x));
              const clampedY = Math.min(visBottom, Math.max(visTop, st.y));
              targetAngle = Math.atan2(clampedY - cy, clampedX - cx);
            }

            st.x = cx + ringR * Math.cos(targetAngle);
            st.y = cy + ringR * Math.sin(targetAngle);
          }
        }

        const x = st.x;
        const y = st.y;
        const drawAngle = Math.atan2(y - cy, x - cx);

        // Still off-screen despite the confinement block above — its own
        // ring never crosses the visible rect at this zoom/pan (e.g. the
        // critical ring, zoomed in past where it can reach). Record it for
        // an edge pointer instead of leaving it silently invisible.
        if (x < visLeft || x > visRight || y < visTop || y > visBottom) {
          const bucketKey = Math.round(drawAngle / OFFSCREEN_BUCKET_RAD);
          const existing = offscreenBuckets.get(bucketKey);
          if (existing) existing.count += 1;
          else offscreenBuckets.set(bucketKey, { angle: drawAngle, color, count: 1 });
        }

        // Light-beam connection to the hub — a gradient from the hub's own
        // color to the peer's status color, so it reads as light radiating
        // outward rather than a flat wire. Void (no beam at all) once the
        // peer is critical — an offline/never-handshaked peer isn't
        // connected to anything, so it shouldn't look like it is.
        if (status !== 'critical') {
          const beamGrad = ctx.createLinearGradient(cx, cy, x, y);
          beamGrad.addColorStop(0, accent + '99');
          beamGrad.addColorStop(1, color + 'cc');
          const baseHalfWidth = (status === 'good' ? 0.8 : 0.6) / view.zoom / 2;
          // While held (or still recoiling), the beam behaves like a
          // stretched rubber band — the further this dot sits outside its
          // own status band, the thinner its waist gets. At rest, or once
          // fully settled back inside the band, it's just the plain thin
          // line as before.
          let stretch = 0;
          if (st.dragging || st.springingBack) {
            const edist = Math.hypot((x - cx) / maxRx, (y - cy) / maxRy) || 0.0001;
            stretch = Math.min(1, Math.abs(edist - targetFrac) / 0.35);
          }
          if (stretch > 0.02) {
            drawElasticBeam(ctx, cx, cy, x, y, baseHalfWidth, stretch, beamGrad);
          } else {
            ctx.beginPath();
            ctx.moveTo(cx, cy);
            ctx.lineTo(x, y);
            ctx.strokeStyle = beamGrad;
            ctx.lineWidth = baseHalfWidth * 2;
            ctx.stroke();
          }
        }

        // Dot (and its glow/gateway-arrow) shrink as you zoom in — divided
        // by zoom so their on-screen size stays close to constant instead
        // of growing with the rest of the scaled world, keeping a dense
        // zoomed-in view from turning into a field of oversized circles.
        const dotR = 4 / view.zoom;
        const glowR = 10 / view.zoom;

        // Pulsar burst — fires once per fresh handshake (set in the
        // peer-seeding effect when latestHandshake advances), not a
        // continuous ambient animation. Drawn under the glow/dot so the
        // solid dot stays the crisp focal point as the ring expands past it.
        if (st.pulseStartedAt != null) {
          const elapsed = now - st.pulseStartedAt;
          if (elapsed > PULSE_DURATION_MS) {
            st.pulseStartedAt = null;
          } else {
            PULSE_RING_DELAYS.forEach((delayFrac) => {
              const t = (elapsed / PULSE_DURATION_MS - delayFrac) / (1 - delayFrac);
              if (t <= 0 || t > 1) return;
              const ringR = dotR + t * (24 / view.zoom);
              const alpha = Math.round((1 - t) * 200)
                .toString(16)
                .padStart(2, '0');
              ctx.beginPath();
              ctx.arc(x, y, ringR, 0, Math.PI * 2);
              ctx.strokeStyle = color + alpha;
              ctx.lineWidth = (2.2 * (1 - t * 0.5)) / view.zoom;
              ctx.stroke();
            });
          }
        }

        // Glow
        const glow = ctx.createRadialGradient(x, y, 0, x, y, glowR);
        glow.addColorStop(0, color + '55');
        glow.addColorStop(1, color + '00');
        ctx.beginPath();
        ctx.arc(x, y, glowR, 0, Math.PI * 2);
        ctx.fillStyle = glow;
        ctx.fill();

        // Data-consumption ring: a small halo just outside the glow — a gray
        // track showing the full circle, with a green arc proportional to
        // this peer's share of total rx+tx bytes across every peer on the
        // tunnel. The arc is centered on the point where the hub-connector
        // beam meets the ring (drawAngle points hub->peer, so the beam
        // touches the ring on the near-hub side at drawAngle + PI) and
        // grows outward equally in both directions from there as the
        // percentage rises, rather than starting from an arbitrary fixed
        // clock position unrelated to the beam. Purely additive to the
        // status dot/glow above — never changes the dot's own color or the
        // peer's radial position (see the radar-ring-confinement constraint
        // on this file: only the existing status-band radius logic governs
        // distance-from-hub).
        const consumeRingR = glowR + 1 / view.zoom;
        const consumeRingWidth = 1.5 / view.zoom;
        ctx.beginPath();
        ctx.arc(x, y, consumeRingR, 0, Math.PI * 2);
        ctx.strokeStyle = textDim + '10';
        ctx.lineWidth = consumeRingWidth;
        ctx.stroke();
        const consumeFrac = fractions.get(p.publicKey) || 0;
        if (consumeFrac > 0.003) {
          const ringCenterAngle = drawAngle + Math.PI;
          const halfSweep = Math.min(1, consumeFrac) * Math.PI;
          ctx.beginPath();
          ctx.arc(x, y, consumeRingR, ringCenterAngle - halfSweep, ringCenterAngle + halfSweep);
          ctx.strokeStyle = CONSUMPTION_RING_COLOR;
          ctx.lineWidth = consumeRingWidth;
          ctx.lineCap = 'round';
          ctx.stroke();
          ctx.lineCap = 'butt';
        }

        ctx.beginPath();
        ctx.arc(x, y, dotR, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.strokeStyle = codeBg;
        ctx.lineWidth = 1.5 / view.zoom;
        ctx.fill();
        ctx.stroke();

        // Gateway marker: a small outward-pointing arrowhead for peers whose
        // AllowedIPs routes more than just themselves (a whole extra
        // subnet) — never the only signal, the tooltip/legend spell it out too.
        if (isGatewayPeer(p.allowedIps)) {
          const tipD = 15 / view.zoom;
          const baseD = 7 / view.zoom;
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

        // Font size also divided by zoom (same "keep screen size roughly
        // constant" trick as the dot) — otherwise labels balloon to huge
        // sizes at high zoom even as the dots themselves shrink.
        const fontPx = 9 / view.zoom;
        ctx.font = `${fontPx}px "SFMono-Regular", Consolas, monospace`;
        ctx.fillStyle = textDim;
        const labelWidth = ctx.measureText(p.name).width;
        // Room available must be measured in screen space (accounting for
        // the current pan/zoom) and converted back to world units — x is a
        // world coordinate, so comparing it against the canvas's raw pixel
        // width directly (ignoring pan/zoom) gives a nonsensical answer
        // whenever the view isn't at its default framing, which is exactly
        // when edge-hugging dots need this check to be right.
        const screenX = x * view.zoom + view.panX;
        const roomOnRight = (width - screenX) / view.zoom - 14;
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

      // Edge pointers — one per angle bucket that had an off-screen peer,
      // placed right at the visible rect's boundary and inset slightly so
      // the triangle itself stays fully on-canvas. A small count label
      // appears when more than one peer shares a bucket.
      if (offscreenBuckets.size > 0) {
        const pointerInset = 14 / view.zoom;
        for (const { angle, color, count } of offscreenBuckets.values()) {
          const edge = rayToRectEdge(cx, cy, angle, visLeft, visRight, visTop, visBottom);
          const px = edge.x - Math.cos(angle) * pointerInset;
          const py = edge.y - Math.sin(angle) * pointerInset;
          drawEdgePointer(ctx, px, py, angle, view.zoom, color);
          if (count > 1) {
            const labelR = 11 / view.zoom;
            ctx.font = `${8 / view.zoom}px "SFMono-Regular", Consolas, monospace`;
            ctx.textAlign = 'center';
            ctx.fillStyle = color;
            ctx.fillText(String(count), px - Math.cos(angle) * labelR, py - Math.sin(angle) * labelR + 3 / view.zoom);
          }
        }
      }

      raf = requestAnimationFrame(draw);
    }
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
    // dims is deliberately excluded — draw() reads dimsRef.current fresh
    // every frame instead, so a resize doesn't restart this whole effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [peers, interfaceLabel]);

  function screenToWorld(clientX, clientY) {
    const rect = canvasRef.current.getBoundingClientRect();
    const view = viewRef.current;
    const mx = clientX - rect.left;
    const my = clientY - rect.top;
    return { x: (mx - view.panX) / view.zoom, y: (my - view.panY) / view.zoom, rect };
  }

  function handlePointerDown(e) {
    const { x, y } = screenToWorld(e.clientX, e.clientY);
    // A little more generous than the hover hitbox (h.r alone) — grabbing
    // is a coarser gesture than hovering, and should forgive a near-miss.
    const hit = hitboxesRef.current.find((h) => Math.hypot(h.x - x, h.y - y) <= h.r + 4);
    if (hit) {
      const st = nodeStateRef.current.get(hit.peer.publicKey);
      if (st) {
        draggedKeyRef.current = hit.peer.publicKey;
        st.dragging = true;
        st.springingBack = false;
        st.vx = 0;
        st.vy = 0;
      }
      setHover(null);
      canvasRef.current.setPointerCapture(e.pointerId);
      canvasRef.current.style.cursor = 'grabbing';
      return;
    }
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
    if (draggedKeyRef.current) {
      const st = nodeStateRef.current.get(draggedKeyRef.current);
      if (st) {
        const { x, y } = screenToWorld(e.clientX, e.clientY);
        st.x = x;
        st.y = y;
      }
      return;
    }
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
    if (draggedKeyRef.current) {
      const st = nodeStateRef.current.get(draggedKeyRef.current);
      if (st) {
        st.dragging = false;
        // Always hand off to the spring — if it's already inside its band
        // the spring's target is ~its current position, so it settles on
        // the very next frame with no visible snap.
        st.springingBack = true;
        st.vx = 0;
        st.vy = 0;
      }
      draggedKeyRef.current = null;
      if (canvasRef.current) canvasRef.current.style.cursor = 'grab';
      return;
    }
    dragRef.current = null;
  }

  function zoomBy(factor) {
    const view = viewRef.current;
    // Anchor on the hub's world position (== canvas center, same formula
    // draw() uses for cx/cy) so the hub — and everything wandering around
    // it — stays fixed on screen across repeated zooms, wherever the
    // current pan has left it.
    const hubWorldX = dims.width / 2;
    const hubWorldY = dims.height / 2;
    const newZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, view.zoom * factor));
    const screenX = hubWorldX * view.zoom + view.panX;
    const screenY = hubWorldY * view.zoom + view.panY;
    view.panX = screenX - hubWorldX * newZoom;
    view.panY = screenY - hubWorldY * newZoom;
    view.zoom = newZoom;
    setViewTick((t) => t + 1);
  }

  function resetView() {
    viewRef.current = { ...DEFAULT_VIEW };
    setViewTick((t) => t + 1);
  }

  return (
    <div style={fullscreen ? { display: 'flex', flexDirection: 'column', height: '100%', width: '100%' } : { width: '100%' }}>
      <div
        ref={canvasWrapRef}
        style={{ position: 'relative', width: '100%', ...(fullscreen ? { flex: '1 1 auto', minHeight: 0 } : {}) }}
      >
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
            cursor: dragRef.current || draggedKeyRef.current ? 'grabbing' : 'grab',
            touchAction: 'none',
          }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerLeave={() => setHover(null)}
        />
      </div>
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
          <div className="hint-text">
            Data usage: {formatBytes(peerTransferBytes(hover.peer))} ({Math.round((consumptionFractions(peers).get(hover.peer.publicKey) || 0) * 100)}% of total)
          </div>
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
          <span style={{ color: 'var(--accent-dim)', fontSize: 11 }}>▲</span>
          <span className="hint-text">Routes an additional subnet</span>
        </span>
        <span className="row" style={{ gap: 5 }}>
          <span
            style={{
              width: 10,
              height: 10,
              borderRadius: '50%',
              display: 'inline-block',
              border: `2px solid ${CONSUMPTION_RING_COLOR}`,
              borderRightColor: 'var(--text-dim)',
              borderBottomColor: 'var(--text-dim)',
            }}
          />
          <span className="hint-text">Ring = share of total data transferred</span>
        </span>
        <span className="hint-text">Scroll to zoom, drag empty space to pan, drag a dot to move it</span>
      </div>
    </div>
  );
}
