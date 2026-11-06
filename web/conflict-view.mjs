// Conflict alarm (feature 16), the screen rules. Pure functions only: no DOM, no timers (the glue is web/fx-conflict.mjs).
// The server says which floors edit the same file (floor view `conflicts`, person view `conflict`); the screen only decides what to show.

const JOIN = ', ';

/** The floor numbers of the floors that share a file with `fv`, ascending and without repeats. `id` picks one conflict, null takes all of the floor's.
 *  A floor the screen does not know (hidden, gone) is left out. */
export function peerFloors(fv, id, viewOf) {
  const nums = new Set();
  for (const c of fv?.conflicts ?? []) {
    if (id !== null && c.id !== id) continue;
    for (const sid of c.with) {
      const n = viewOf(sid)?.floorNo;
      if (Number.isFinite(n)) nums.add(n);
    }
  }
  return [...nums].sort((a, b) => a - b);
}

/** The text of a marker: ui.conflict.tagText with {floors} replaced by the numbers. Empty when no floor is known (the marker then shows its picture only). */
export const tagLabel = (template, nums) => (nums.length ? template.replace('{floors}', nums.join(JOIN)) : '');

/** What one conflicting person shows. The marker is information and always there; the paper and the tug are decoration, only with the effects on. */
export const personMarks = (fxOn, conflictId) => ({ tag: conflictId !== null, prop: fxOn && conflictId !== null });

/** The lobby lamp: null when it is not drawn (no place set), else whether it burns (any floor has a conflict) and where it stands. */
export function lampState(floors, lampAt) {
  if (!Array.isArray(lampAt)) return null;
  return { on: floors.some((f) => f.conflicts?.length > 0), at: lampAt };
}

/** May a tug start now? `current` is what ctx.gesture.current says; a stronger gesture (rest, faint, bell wave) or a meeting on the floor puts it off. */
export function tugAllowed(priority, current, inMeeting) {
  if (inMeeting) return false;
  if (current === null) return true;
  return priority.indexOf('tug') < priority.indexOf(current);
}
