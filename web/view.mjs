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

// ---- follow the busiest floor (pure) ----
// Activity of a floor = events inside the last `windowSeconds` (each with its weight) + `workingWeight` per character that is working or thinking now.

/** Drops the events older than the window (in place) and returns the array. `events` is oldest-first [{t, w}]. */
export function pruneEvents(events, now, cfg) {
  const from = now - cfg.windowSeconds * 1000;
  let n = 0;
  while (n < events.length && events[n].t < from) n++;
  if (n) events.splice(0, n);
  return events;
}

/** Score of one floor at `now`: weights of its events in the window plus `working` characters x workingWeight. */
export function activityScore(events, working, now, cfg) {
  const from = now - cfg.windowSeconds * 1000;
  let s = working * cfg.workingWeight;
  for (const e of events) if (e.t >= from && e.t <= now) s += e.w;
  return s;
}

/** The floor with the highest score; a tie keeps `current`, else the first in `ids`. Null when every floor is below `minScore` (or none). */
export function busiestFloor(ids, scores, current, minScore) {
  let best = null;
  let top = -Infinity;
  for (const id of ids) {
    const s = scores.get(id) ?? 0;
    if (s > top || (s === top && id === current)) {
      best = id;
      top = s;
    }
  }
  return best !== null && top >= minScore ? best : null;
}

/**
 * Which floor to show while following. Switches only when another floor beats `current` by a clear margin
 * (>= current + switchMargin and >= current x switchRatio, and at least minScore) and `current` has been on screen for minDwellSeconds.
 * Returns {id, waitMs}: waitMs > 0 means a switch is wanted but the dwell time is not over yet (re-check after that long).
 */
export function chooseFollow({ ids, scores, current, now, shownSince }, cfg) {
  if (!ids.includes(current)) return { id: busiestFloor(ids, scores, null, cfg.minScore) ?? ids[0] ?? null, waitMs: 0 };
  const best = busiestFloor(ids, scores, current, cfg.minScore);
  if (best === null || best === current) return { id: current, waitMs: 0 };
  const cur = scores.get(current) ?? 0;
  const top = scores.get(best) ?? 0;
  if (top < cur + cfg.switchMargin || top < cur * cfg.switchRatio) return { id: current, waitMs: 0 };
  const left = cfg.minDwellSeconds * 1000 - (now - shownSince);
  return left > 0 ? { id: current, waitMs: left } : { id: best, waitMs: 0 };
}
