// Lobby life (pure): who may stroll, and where a stroll goes. A lobby figure stands behind its desk; now and then it steps out
// into the aisle in front of its row, walks a short way and comes back. Numbers come from `ui.lobby.life` (config.json).
// The timing is the floors' own clock (ambient.mjs createFloorClock); the walk itself is app.mjs (walkPath, the nav grid).
import { between } from './ambient.mjs';
import { isOpen, lineOfSight } from './nav.mjs';

/** @typedef {[number, number]} Pt */

/** The states a figure may stroll in: not a sleeper, not one that reported, nobody on a floor that is leaving. */
export const canStroll = (state, floorStatus) => floorStatus !== 'leaving' && state !== 'stale' && state !== 'done';

/** How long until the next stroll for a figure in `state`, as a [min, max] range, or null when it does not stroll. */
export const strollRange = (life, who) => (canStroll(who.state, who.floorStatus) ? life.strollEveryMs[who.state === 'enter' ? 'idle' : who.state] ?? null : null);

/**
 * When a figure strolls next (a time in ms), or Infinity when it does not in its state. `fresh` (the lobby was just opened): somewhere inside
 * the first wait, like a crowd that has been at it for a while, but not before `life.firstDelayMs[0]`.
 * @param {{state: string, floorStatus: string}} who
 */
export function nextStrollAt(rng, life, who, now, fresh) {
  const range = strollRange(life, who);
  if (!range) return Infinity;
  const wait = between(rng, range);
  return now + (fresh ? Math.max(life.firstDelayMs[0], wait * rng()) : wait);
}

/** Distance of `p` from the segment a-b. */
function distToSeg(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/**
 * Where a stroll from `from` goes: a point `life.strollPx` away (sideways along the aisle when `aisle`, any direction otherwise)
 * that is open on the nav grid, in sight of `from`, and at least `life.strollGapPx` from every `keepClear` point (the standing
 * spots and the other walkers) and from the walk itself. A seat's stroll is refused (null) while another walker is in the same aisle
 * (`busyLanes`: the y of every aisle that has one). Tries `life.strollTries` times, null when none fits.
 * @param {() => number} rng
 * @param {{cols: number, rows: number, cellPx: number, open: Uint8Array}} grid
 * @param {Pt} from
 * @param {{strollPx: Pt, strollGapPx: number, strollTries: number}} life
 * @param {{keepClear: Pt[], busyLanes: number[], aisle: boolean}} ctx
 * @returns {Pt | null}
 */
export function strollTarget(rng, grid, from, life, { keepClear, busyLanes, aisle }) {
  if (aisle && busyLanes.some((y) => Math.abs(y - from[1]) < life.strollGapPx / 2)) return null;
  if (!isOpen(grid, from)) return null;
  for (let i = 0; i < life.strollTries; i++) {
    const dist = between(rng, life.strollPx);
    const ang = aisle ? (rng() < 0.5 ? 0 : Math.PI) : rng() * 2 * Math.PI;
    const p = [Math.round(from[0] + Math.cos(ang) * dist), Math.round(from[1] + Math.sin(ang) * dist)];
    if (!isOpen(grid, p) || !lineOfSight(grid, from, p)) continue;
    if (keepClear.some((k) => Math.hypot(k[0] - p[0], k[1] - p[1]) < life.strollGapPx || distToSeg(k, from, p) < life.strollGapPx / 2)) continue;
    return p;
  }
  return null;
}

/** Every range of `life` times `k` (?debug=ambient makes the lobby life visible within seconds, like the floors'). */
export function scaleLife(life, k) {
  const range = (v) => v.map((n) => n * k);
  return {
    ...life,
    tickMinMs: life.tickMinMs * k,
    firstDelayMs: range(life.firstDelayMs),
    fidgetEveryMs: range(life.fidgetEveryMs),
    strollEveryMs: Object.fromEntries(Object.entries(life.strollEveryMs).map(([s, v]) => [s, range(v)])),
    stayMs: range(life.stayMs),
  };
}
