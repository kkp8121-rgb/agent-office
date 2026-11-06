// Lift commute rules (pure): who arrives or leaves when, in what order, and how the one shared lift car is sent.
// Numbers come from `ui.commute` (and `ui.building` for the car). No DOM, no timers, no clock: fx-commute.mjs does the drawing.

/**
 * What changed between two state frames. `prev` is the Map sessionId -> status of the last frame, or null before the first one.
 * The first frame never arrives or leaves anybody (the floors were already there); a floor that is already leaving then gets its veil at once.
 * @param {Map<string,string>|null} prev
 * @param {{sessionId: string, status: string}[]} list
 * @returns {{arrivals: string[], leavings: string[], veilNow: string[], lit: string[], next: Map<string,string>}}
 *   arrivals: floors seen for the first time; leavings: floors that turned 'leaving' now; veilNow: leaving floors of the first frame;
 *   lit: floors that were leaving and are not any more (the veil goes); next: the Map to hand in with the next frame.
 */
export function diffFloors(prev, list) {
  const next = new Map(list.map((f) => [f.sessionId, f.status]));
  const out = { arrivals: [], leavings: [], veilNow: [], lit: [], next };
  for (const [id, status] of next) {
    if (prev === null) {
      if (status === 'leaving') out.veilNow.push(id);
      continue;
    }
    const was = prev.get(id);
    if (was === undefined) {
      if (status === 'leaving') out.veilNow.push(id);
      else out.arrivals.push(id);
    } else if (status === 'leaving' && was !== 'leaving') out.leavings.push(id);
    else if (status !== 'leaving' && was === 'leaving') out.lit.push(id);
  }
  return out;
}

/**
 * The order of one arrival at the lift door of a floor: the panel lights, the door opens, the lead walks in, the door closes.
 * Without a door cover (no `door` value for the design) only the walk is left, at once.
 * @returns {{step: 'panel'|'open'|'walk'|'close', atMs: number}[]} sorted by atMs
 */
export function arrivalSteps(cfg, hasDoor) {
  if (!hasDoor) return [{ step: 'walk', atMs: 0 }];
  const openAt = cfg.walkInDelayMs;
  const walkAt = openAt + cfg.doorOpenMs;
  return [
    { step: 'panel', atMs: 0 },
    { step: 'open', atMs: openAt },
    { step: 'walk', atMs: walkAt },
    { step: 'close', atMs: walkAt + cfg.doorOpenMs },
  ];
}

/**
 * The order of one departure. The room goes dark at once; with the effects off that is all there is (the veil without a fade).
 * `count` people leave (staff first, the lead last, so the lead's good-bye is the last thing said), one every `leaveGapMs`,
 * and each one's walk is cut so that it is over by `leaveBudgetMs` (a person who would start too late just vanishes at the end).
 * @param {number} count
 * @param {object} cfg ui.commute
 * @param {{fx: boolean, night: boolean}} o
 * @returns {{veil: {dim: number, fadeMs: number}, people: {index: number, startMs: number, maxWalkMs: number}[], endMs: number}}
 */
export function leaveSteps(count, cfg, o) {
  const veil = { dim: o.night ? cfg.offDimNight : cfg.offDim, fadeMs: o.fx ? cfg.offFadeMs : 0 };
  if (!o.fx) return { veil, people: [], endMs: 0 };
  const budget = cfg.leaveBudgetMs;
  const people = [];
  for (let index = 0; index < count; index++) {
    const startMs = Math.min(index * cfg.leaveGapMs, budget);
    people.push({ index, startMs, maxWalkMs: budget - startMs });
  }
  return { veil, people, endMs: budget };
}

/** How long a walk really lasts when it is cut to the time that is left (0 or less left = the person vanishes now). */
export const cutWalk = (walkMs, maxWalkMs) => Math.max(0, Math.min(walkMs, maxWalkMs));

/**
 * The one shared lift car of the building view. Requests that arrive while it moves are not queued: after the move only the nearest
 * one is served and the rest are skipped (their floors show the lead at the desk at once).
 * @param {{y: number}} car where the car stands (px, any one axis)
 * @param {{id: string, y: number}[]} requests where passengers wait
 * @param {{carPxPerSec: number, carMinMs: number, carMaxMs: number}} cfg ui.building
 * @returns {{move: ?{from: number, to: number, ms: number, id: string}, skipped: string[]}}
 */
export function planCar(car, requests, cfg) {
  if (!requests.length) return { move: null, skipped: [] };
  let best = requests[0];
  for (const r of requests) if (Math.abs(r.y - car.y) < Math.abs(best.y - car.y)) best = r;
  const dist = Math.abs(best.y - car.y);
  const ms = dist === 0 ? 0 : Math.min(cfg.carMaxMs, Math.max(cfg.carMinMs, (dist / cfg.carPxPerSec) * 1000));
  return { move: { from: car.y, to: best.y, ms, id: best.id }, skipped: requests.filter((r) => r !== best).map((r) => r.id) };
}

/**
 * Where a door cover sits. Its bottom middle is on `at` + (dx, dy); its size is the picture's size times `scale` across and `scaleY` (default `scale`) up;
 * `skew` (degrees, default 0) tilts it along the wall the door is drawn in (a point to the right of the foot moves down by tan(skew) per px), because the doors of
 * the isometric rooms are parallelograms. `box` is the untilted rectangle (`top` and `foot` are those of the middle line, which the panel hangs on), `corners` the tilted
 * cover, clockwise from the top left.
 * @returns {{left: number, top: number, w: number, h: number, foot: [number, number], corners: [number, number][]}}
 */
export function doorBox(at, pic, d) {
  const w = pic.w * d.scale;
  const h = pic.h * (d.scaleY ?? d.scale);
  const foot = [at[0] + d.dx, at[1] + d.dy];
  const tilt = Math.tan(((d.skew ?? 0) * Math.PI) / 180);
  const [l, r] = [foot[0] - w / 2, foot[0] + w / 2];
  const lift = (x) => (x - foot[0]) * tilt;
  const corners = [[l, foot[1] - h + lift(l)], [r, foot[1] - h + lift(r)], [r, foot[1] + lift(r)], [l, foot[1] + lift(l)]];
  return { left: l, top: foot[1] - h, w, h, foot, corners };
}
