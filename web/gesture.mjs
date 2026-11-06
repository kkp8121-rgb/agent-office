// Gesture arbiter (pure): one character does one "big" gesture at a time. The order of the kinds is ui.gesture.priority (first = strongest);
// the lowest kind, 'life', is the floor every ambient gesture and trip stands on. A stronger kind takes the character over and tells the old holder once.

/**
 * @param {string[]} priority ui.gesture.priority, strongest first
 * @param {(rec: object) => void} [clear] called on a takeover, before the new holder starts (the app's clearGestures)
 */
export function createGestures(priority, clear = () => {}) {
  const held = new Map(); // rec -> {token, kind, rank, onPreempt}

  /** @returns {object|null} a token, or null when the kind is unknown or the character is held by an equal or stronger kind */
  function acquire(rec, kind) {
    const rank = priority.indexOf(kind);
    if (rank < 0) return null;
    const cur = held.get(rec);
    if (cur) {
      if (rank >= cur.rank) return null;
      held.delete(rec);
      cur.onPreempt?.();
      clear(rec);
    }
    const token = { rec, kind };
    held.set(rec, { token, kind, rank, onPreempt: null });
    return token;
  }

  function release(token) {
    if (token && held.get(token.rec)?.token === token) held.delete(token.rec);
  }

  const current = (rec) => held.get(rec)?.kind ?? null;

  function onPreempt(token, fn) {
    const h = token && held.get(token.rec);
    if (h?.token === token) h.onPreempt = fn;
  }

  /** Office life (fidgets, trips, desk gestures) may start only while nothing else holds the character. */
  const canAmbient = (rec) => current(rec) === null;

  return { acquire, release, current, onPreempt, canAmbient };
}
