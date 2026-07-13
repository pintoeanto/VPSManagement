---
name: viewport-confinement
description: How peers (goats/monks) are confined to the visible viewport in the
  radial WireGuard graph. Load whenever editing peer positioning, grazing,
  ring placement, or anything involving pan/zoom, world<->screen coordinates,
  or peers disappearing on zoom/pan.
---

# Viewport confinement — NetworkRadar

All of this lives in one file: `frontend/src/components/NetworkRadar.jsx`.
There is no D3, no d3-zoom, no SVG for this view — it's plain **Canvas 2D**
with a hand-rolled `requestAnimationFrame` loop (the `draw()` function inside
the big `useEffect` at line ~293). Don't reach for d3-zoom helpers here; the
pan/zoom transform is three plain numbers.

## Where the state actually lives

- **Live pan/zoom transform**: `viewRef.current = { zoom, panX, panY }`
  (a `useRef`, not React state — mutated directly every frame/event so the
  rAF loop never waits on a re-render). Written by the wheel handler, drag
  handlers, `zoomBy()`, and `resetView()`; read every frame at the top of
  `draw()` as `const view = viewRef.current`.
- **Ring radii**: `RING_FRACS = [0.34, 0.67, 1.0]` (module-level, line 4) —
  fractions of `maxRx`/`maxRy`, not pixels. `maxRx = Math.min(width, height)
  / 2 - 20` is recomputed both in the peer-seeding effect and inside
  `draw()`. There's no literal `R_INNER`/`R_OUTER` pair — instead
  `STATUS_BAND` (line 34) maps each status to a `[lo, hi]` fraction range
  derived from `RING_FRACS`, e.g. `critical: [RING_FRACS[1] + 0.05,
  RING_FRACS[2] - 0.04]` is the band between ring 2 and ring 3. Whichever
  band you're touching, treat `STATUS_BAND[status]` as the "R_INNER/R_OUTER"
  of that ring.
- Peer world position: `nodeStateRef.current` is a `Map<publicKey, {x, y,
  vx, vy, ...}>` — plain world-space pixels, hub-relative (`cx, cy` = canvas
  center).

## Coordinate model

Peers live in **world space**: `x`/`y` on each node-state entry, radius from
the hub driven by handshake age via `peerContinuousState()` (line 87) using
`GOOD_THRESHOLD_SECONDS`/`WARNING_THRESHOLD_SECONDS` from
`frontend/src/lib/peerStatus.js`. "Visible" is a **screen/viewport**
concept — it only exists once you apply `view.zoom`/`view.panX`/`view.panY`.

The bug class this skill exists to prevent: confining a peer's position
using only world-space math (band clamp, separation push) while forgetting
that the *viewport* — not the world — is what the user can actually see.
A peer can be perfectly legal in its status band and still be panned or
zoomed completely off-canvas. World-space band membership and screen-space
visibility are two independent constraints; you need both, every frame.

## Transform-inversion recipe (this stack, exactly)

Computed once per frame in `draw()` (lines 382–391), not per peer, since
every peer shares the same viewport:

```js
const viewportMarginWorld = VIEWPORT_MARGIN_PX / view.zoom;
const visLeft   = (0     - view.panX) / view.zoom + viewportMarginWorld;
const visRight  = (width - view.panX) / view.zoom - viewportMarginWorld;
const visTop    = (0     - view.panY) / view.zoom + viewportMarginWorld;
const visBottom = (height - view.panY) / view.zoom - viewportMarginWorld;
```

`width`/`height` here are the CSS-pixel `dims` state (React state, resize-
observed), **not** `canvas.width`/`canvas.height`. `VIEWPORT_MARGIN_PX = 30`
(line 66) is the screen-space clearance a dot's glow/label needs from the
physical edge; dividing by `view.zoom` converts it to world units fresh
every frame since that conversion depends on the live zoom level.

**dpr gotcha**: `canvas.width = width * dpr` and the draw transform is
`ctx.setTransform(dpr * view.zoom, 0, 0, dpr * view.zoom, dpr * view.panX,
dpr * view.panY)` — but `view.panX/panY/zoom` themselves are pure CSS-pixel
values (derived from `getBoundingClientRect()` in `screenToWorld()`, which
is CSS-space). So the visibility-rect math above must **not** multiply or
divide by `dpr` anywhere — dpr only enters at the final `ctx.setTransform`
call for backing-store resolution. Reintroducing dpr into `visLeft`/etc. is
the classic way to re-derive this wrong.

## The confinement invariant

Canonical rule:

```
legal region for peer P = STATUS_BAND[status(P)] (world-space ring band, hub-relative)
                           ∩ (visLeft, visRight, visTop, visBottom)  (visible world rect, inset)
```

recomputed every frame. **But** the real code does not compute this as a
single joint region — it applies two sequential, independent clamps in
`draw()`, in this order, both gated on `!st.dragging && !st.springingBack`:

1. **Band clamp** (lines 529–545): hub-relative, world-space only, no
   dependency on pan/zoom. If the peer's fractional distance from the hub
   (`bedist`) falls outside `STATUS_BAND[status]`, it's scaled back to the
   nearest band edge. This alone is what stops a peer from visually
   claiming a status ring it doesn't have.
2. **Viewport confinement** ("attention seeker" block, lines 547–601): if
   the position from step 1 is still outside `[visLeft, visRight] ×
   [visTop, visBottom]`, hold it at the point where the ray from the hub
   through the peer's own current bearing crosses the visible rect's
   boundary (a near/far slab ray/box test — correct whether the hub itself
   is still inside the visible rect or has been panned out too). This is a
   **screen-driven override**, not a re-intersection with the band: the
   resulting point is not guaranteed to still be at the band's exact
   radius, only somewhere on the peer's own bearing line. That's
   intentional (see the comment at lines 561–567) — status color always
   comes straight from handshake age regardless of render position, so
   only distance-from-hub is approximate while off-screen-confined, never
   status.

When writing new confinement logic, preserve this ordering: band clamp
first (cheap, world-only), viewport clamp second (only engages when
actually off-screen — "Skipped entirely when the peer is already visible").
Don't try to collapse them into one combined clamp; the two constraints are
allowed to disagree slightly by design.

## Hard invariants

- Every peer's rendered position must stay within the visible viewport at
  any zoom (`MIN_ZOOM=0.5`..`MAX_ZOOM=4`) and any pan offset.
- A peer must stay within its own `STATUS_BAND[status]` radius fraction and
  must never cross the band's inner edge into a different ring's territory
  (that would visually claim a status it doesn't have).
- Ring/band assignment is driven by handshake age via `peerStatus()` /
  `peerContinuousState()` — this is a **fixed input**. Do not change
  `GOOD_THRESHOLD_SECONDS`, `WARNING_THRESHOLD_SECONDS`, `RING_FRACS`, or
  `STATUS_BAND` as part of a viewport-confinement fix; those own a
  different concern.
- Springs, elastic recoil, the pulsar burst, and the "meditating/grazing"
  motion tuning (`SPRING_STIFFNESS`, `RADIAL_STIFFNESS`,
  `PULSE_DURATION_MS`, tangential-speed damping, etc.) are out of scope for
  this skill — don't touch them to fix a confinement bug.
- Both clamps are skipped while `st.dragging || st.springingBack` — direct
  manipulation and the release recoil intentionally ignore both band and
  viewport confinement.

## Re-entry / edge cases

There is **no random-respawn mechanic** in this codebase — don't add one.
Instead, when a peer drifts outside the visible rect, it's *held* (every
frame, not once) at the ray/box intersection point along its own bearing
from the hub, computed via the slab test at lines 575–598. Two edge cases
in that test matter:

- **Ray never reaches the rect** (`boxReachable = false`, e.g. the hub
  itself is outside the visible rect on an axis where the ray is parallel
  to it) or **no valid intersection** (`tmax < tmin`): `t` stays `0`, so the
  peer collapses to exactly `(cx, cy)` — it renders on top of the hub node
  itself rather than picking any point on the rect boundary. This is the
  actual empty-intersection behavior; it's a visible (if odd) fallback, not
  a crash, and is worth keeping in mind if peers seem to "vanish into" the
  hub during aggressive zoom/pan.
- The moment the peer's real (band-clamped) position is back inside
  `[visLeft, visRight] × [visTop, visBottom]`, this block stops running
  entirely and the ordinary radial spring resumes from wherever the peer
  actually is — there's no teleport back, just a silent handoff.

## How to verify

Screenshot (or eyeball) the radar at several zoom/pan combinations and
confirm no peer dot is ever clipped by the canvas edge:

1. Default framing (`resetView()`), `MIN_ZOOM` (fully zoomed out),
   `MAX_ZOOM` (fully zoomed in via the `+` button repeatedly).
2. Pan to each corner and edge at `MAX_ZOOM`, where confinement is most
   likely to be exercised (small visible world rect).
3. Pay particular attention to `critical`-band peers (outermost ring,
   `STATUS_BAND.critical`) — they're the first to leave the visible rect
   when zooming in since they sit farthest from the hub.
4. Confirm dots never render on top of each other at the hub center for
   more than a frame or two (that's the empty-intersection collapse case
   above — acceptable transiently, not as a steady state).
