// Workflow meetings and failure faces (pure): who stands where, which mood a failure shows, when the boss comes to pat.
// Numbers come from `ui.meeting` and `ui.fail`. DOM, walking and timers live in app.js.

/**
 * Gives each character a meeting spot: the closest (character, spot) pair first, then the next closest of those left.
 * `chars` are `{id, x, y}` (feet), `spots` are `{at: [x, y], ...}`. Characters left over (more characters than spots) get none.
 * @returns {Map<any, object>} id -> spot
 */
export function assignSpots(chars, spots) {
  const pairs = [];
  for (const c of chars) for (const s of spots) pairs.push({ c, s, d: Math.hypot(c.x - s.at[0], c.y - s.at[1]) });
  pairs.sort((a, b) => a.d - b.d);
  const out = new Map();
  const used = new Set();
  for (const { c, s } of pairs) {
    if (out.has(c.id) || used.has(s)) continue;
    out.set(c.id, s);
    used.add(s);
  }
  return out;
}

/** A sweat drop for the first failure in a row, a rain cloud from the second on. */
export const moodKind = (streak) => (streak >= 2 ? 'cloud' : 'sweat');

/** The boss comes to pat after `f.patStreak` failures in a row, at most once per `f.patCooldownSeconds` (`lastAt` and `now` in ms). */
export const patDue = (streak, lastAt, now, f) => streak >= f.patStreak && now - lastAt >= f.patCooldownSeconds * 1000;

/** A phase title short enough for a speech bubble. */
export function clipPhase(text, max) {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : text;
}
