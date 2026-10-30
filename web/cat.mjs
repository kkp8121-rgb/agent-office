// The office cat (pure): which floor it visits next, what it does next and where. Numbers come from `ui.cat`.
// Timers, DOM and walking live in app.js.
import { between } from './ambient.mjs';

/** The centre of a random walkable cell of a navigation grid, or null when there is none. */
export function openPoint(rng, grid) {
  const cells = [];
  for (let i = 0; i < grid.open.length; i++) if (grid.open[i]) cells.push(i);
  if (!cells.length) return null;
  const i = cells[Math.floor(rng() * cells.length)];
  return [((i % grid.cols) + 0.5) * grid.cellPx, (Math.floor(i / grid.cols) + 0.5) * grid.cellPx];
}

/** Another floor than `current` (random), or null when there is none. */
export function otherFloor(rng, ids, current) {
  const rest = ids.filter((id) => id !== current);
  return rest.length ? rest[Math.floor(rng() * rest.length)] : null;
}

/** The pose and stay length (ms range key in `cat`) of each kind of act. */
const ACTS = { sleep: { pose: 'sleep', stay: 'sleepMs' }, spot: { pose: 'sit', stay: 'sitMs' }, desk: { pose: 'sit', stay: 'deskMs' }, stroll: { pose: 'stand', stay: 'pauseMs' } };

/**
 * What the cat does next. `leaveDue` (and another floor to go to) sends it out of the door. Otherwise one of: sleep on a free spot
 * of `sleepKinds` (sofa), sit at a free spot of `sitKinds`, sit beside a working colleague's desk (`desks`: `{x, y, face, ...}`),
 * or stroll to a random walkable point (`point()`), picked by `weights` among those that are possible. `force` limits the choice
 * to one kind (debugging). `taken` maps a spot id to how many stand there.
 * @returns {{act: string, x?: number, y?: number, face?: string, spotId?: string, pose?: string, ms?: number, desk?: object} | null}
 */
export function chooseCatAct(rng, { cat, spots, taken, desks, point, leaveDue, force }) {
  if (leaveDue) return { act: 'leave' };
  const free = (kinds) => spots.filter((s) => kinds.includes(s.kind) && !taken.get(s.id));
  const options = {
    sleep: () => {
      const s = free(cat.sleepKinds);
      return s.length ? s[Math.floor(rng() * s.length)] : null;
    },
    spot: () => {
      const s = free(cat.sitKinds);
      return s.length ? s[Math.floor(rng() * s.length)] : null;
    },
    desk: () => (desks.length ? desks[Math.floor(rng() * desks.length)] : null),
    stroll: () => point(),
  };
  const found = {};
  for (const [name, find] of Object.entries(options)) {
    if (force && force !== name) continue;
    const hit = find();
    if (hit) found[name] = hit;
  }
  const names = Object.keys(found);
  if (!names.length) return null;
  let roll = rng() * names.reduce((n, k) => n + cat.weights[k], 0);
  const act = names.find((k) => (roll -= cat.weights[k]) < 0) ?? names[0];
  const hit = found[act];
  const base = { act, pose: ACTS[act].pose, ms: between(rng, cat[ACTS[act].stay]) };
  if (act === 'stroll') return { ...base, x: hit[0], y: hit[1], face: rng() < 0.5 ? 'left' : 'right' };
  if (act === 'desk') return { ...base, x: hit.x, y: hit.y, face: hit.face, desk: hit };
  return { ...base, x: hit.at[0], y: hit.at[1], face: hit.face, spotId: hit.id };
}
