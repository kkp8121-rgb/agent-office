// Snacks (pure): which character a snack was dropped on, and what happens. Numbers and lines come from `ui.snack` and `ui.lines`.

/**
 * The character a drop at (x, y) lands on: the one whose box (`rects`: `{id, left, top, right, bottom}`, grown by `margin`)
 * holds the point, the nearest box centre first. Null when none does.
 */
export function pickAt(rects, x, y, margin) {
  let best = null;
  let bestD = Infinity;
  for (const r of rects) {
    if (x < r.left - margin || x > r.right + margin || y < r.top - margin || y > r.bottom + margin) continue;
    const d = Math.hypot((r.left + r.right) / 2 - x, (r.top + r.bottom) / 2 - y);
    if (d < bestD) {
      best = r.id;
      bestD = d;
    }
  }
  return best;
}

/** 'eat', 'full' (still in its cooldown) or 'refuse' (fish to a person, anything else to the cat). `lastAt` is the time it last ate (ms) or undefined. */
export function snackOutcome(kind, isCat, lastAt, now, cooldownSeconds) {
  if (isCat !== (kind === 'fish')) return 'refuse';
  return lastAt !== undefined && now - lastAt < cooldownSeconds * 1000 ? 'full' : 'eat';
}
