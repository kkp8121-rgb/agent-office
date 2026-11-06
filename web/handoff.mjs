// Handing work over (pure rules, no DOM): when a folder, a paper or a paper plane may fly, and along which curve.
// The area that draws it is web/fx-handoff.mjs; the server signal is {type:'handoff', handoffKind, from, to} (call | phase | message).
// A point is [x, y] in floor px, or null when that person is not on screen (then the floor's door stands in).

const LIFT_DIV = 4; // the arc rises a quarter of the way it goes

/**
 * What to do with one handoff.
 * @param {object} a
 * @param {'call'|'phase'|'message'} a.kind
 * @param {boolean} a.fxOn      the 「화려한 효과」 switch (nothing is built without it)
 * @param {boolean} a.rest      the floor is on its lunch break (nothing moves)
 * @param {boolean} a.meeting   a workflow meeting is running on the floor
 * @param {number} a.planesInFlight  planes in the air on this floor now
 * @param {{flyMs:number, planeMs:number, planeMaxConcurrent:number}} a.cfg  ui.handoff
 * @param {number[]|null} a.from  where the sender stands, null = not on screen
 * @param {number[]|null} a.to    where the receiver stands, null = not on screen or unknown (a message to someone off the floor)
 * @param {number[]} a.door     the floor's door
 * @returns {{action:'skip'|'wait'|'give'|'fly', reason?:string, from?:number[], to?:number[], ms?:number, lift?:number}}
 */
export function planHandoff({ kind, fxOn, rest, meeting, planesInFlight, cfg, from, to, door }) {
  if (!fxOn) return { action: 'skip', reason: 'fx' };
  if (rest) return { action: 'skip', reason: 'rest' };
  if (kind === 'call') return { action: 'give' }; // the folder is carried, not flown
  if (kind === 'phase' && meeting) return { action: 'wait', reason: 'meeting' };
  if (kind === 'message' && planesInFlight >= cfg.planeMaxConcurrent) return { action: 'skip', reason: 'cap' };
  if (!from && !to) return { action: 'skip', reason: 'nowhere' };
  const a = from ?? door;
  const b = to ?? door;
  if (a[0] === b[0] && a[1] === b[1]) return { action: 'skip', reason: 'same' };
  return { action: 'fly', from: a, to: b, ms: kind === 'message' ? cfg.planeMs : cfg.flyMs, lift: Math.hypot(b[0] - a[0], b[1] - a[1]) / LIFT_DIV };
}

/** The curve of one flight as Web Animation keyframes (transform only). `faceLeft` mirrors the picture (a plane that flies to the left). */
export function flightFrames({ from, to, lift }, faceLeft = false) {
  const at = (p, up = 0) => `translate(${p[0].toFixed(1)}px, ${(p[1] - up).toFixed(1)}px) translate(-50%, -50%)${faceLeft ? ' scaleX(-1)' : ''}`;
  const mid = [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2];
  return [
    { offset: 0, transform: at(from), easing: 'ease-out' },
    { offset: 0.5, transform: at(mid, lift), easing: 'ease-in' },
    { offset: 1, transform: at(to) },
  ];
}
