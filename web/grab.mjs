// Picking a character up (pure): the grab-vs-click rule, where a dropped character lands, which rest spot it is near.
// Numbers come from `ui.grab`. Pointer and DOM handling live in app.js.
import { isOpen, snapOpen } from './nav.mjs';

/** A press becomes a grab once the pointer moved `movePx` or was held `holdMs`; shorter and stiller it is a plain click. */
export function shouldLift(dx, dy, heldMs, g) {
  return Math.hypot(dx, dy) >= g.movePx || heldMs >= g.holdMs;
}

/**
 * Where a character dropped at `p` ends up: `p` itself (kept inside the floor) when that cell is walkable, else the
 * centre of the nearest walkable cell, searched over the whole floor. Null only when the floor has no walkable cell.
 * @param {{cols: number, rows: number, cellPx: number, open: ArrayLike<number>}} grid
 */
export function dropPoint(grid, p, size) {
  const q = [Math.min(Math.max(p[0], 0), size[0] - 1), Math.min(Math.max(p[1], 0), size[1] - 1)];
  return isOpen(grid, q) ? q : snapOpen(grid, q, Math.max(grid.cols, grid.rows));
}

/**
 * The nearest free rest spot (sofa, coffee machine, ...) whose standing point is within `radius` of `p`, or null.
 * `taken` maps a spot id to how many stand there; an occupied spot is not offered.
 */
export function restSpotNear(spots, taken, p, radius) {
  let best = null;
  let bestD = radius;
  for (const s of spots) {
    if ((taken.get(s.id) ?? 0) > 0) continue;
    const d = Math.hypot(s.at[0] - p[0], s.at[1] - p[1]);
    if (d <= bestD) {
      best = s;
      bestD = d;
    }
  }
  return best;
}
