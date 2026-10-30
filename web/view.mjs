// Floor switcher helpers (pure): the order of the floor buttons, which floor comes next, and how a single floor is scaled.

/** Session ids of `views` in floor-number order. */
export function orderFloors(views) {
  return [...views].sort((a, b) => a.floorNo - b.floorNo).map((v) => v.sessionId);
}

/** The floor after `current` in `ids`, wrapping around; the first one when `current` is not there. Null with no floors. */
export function nextFloor(ids, current) {
  if (!ids.length) return null;
  const i = ids.indexOf(current);
  return ids[(i + 1) % ids.length];
}

/**
 * The floor to show when `current` is gone: the next one that was after it in the old order (`oldIds`) and is still in `ids`,
 * else the nearest one before it. Null when nothing is left. `current` itself is returned while it is still there.
 */
export function fallbackFloor(oldIds, current, ids) {
  if (ids.includes(current)) return current;
  const at = oldIds.indexOf(current);
  const after = oldIds.slice(at + 1).find((id) => ids.includes(id));
  if (after !== undefined) return after;
  const before = oldIds.slice(0, Math.max(at, 0)).reverse().find((id) => ids.includes(id));
  return before ?? ids[0] ?? null;
}

/** Zoom that fits a `w` x `h` floor into `availW` x `availH` (either may be Infinity), at most `maxScale`. */
export function fitBox(availW, availH, w, h, maxScale) {
  const rw = w > 0 ? availW / w : Infinity;
  const rh = h > 0 ? availH / h : Infinity;
  return Math.max(0, Math.min(rw, rh, maxScale));
}
