// Office life: seeded randomness, the choice rules (when to take a trip, where to, which fidget) and the one-timer
// floor clock. Pure: time and timers are injected, so the tests drive a fake clock. Numbers come from `ui.ambient`.

/** @typedef {[number, number]} Pt */

/** FNV-1a hash of `seed` feeding a mulberry32 generator: the same seed always gives the same sequence. */
export function rngFor(seed) {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A value in [a, b). */
export const between = (rng, [a, b]) => a + rng() * (b - a);

/**
 * How long until the next trip for one character, or null when it takes none.
 * The lead tours only while its session waits for input; a subagent that has arrived rests like an idle one.
 * @param {{tripEveryMs: Record<string, Pt>, leadTourEveryMs: Pt}} amb
 * @param {{isLead: boolean, state: string, floorStatus: string}} who
 * @returns {Pt | null}
 */
export function tripRange(amb, who) {
  if (who.isLead) return who.floorStatus === 'waiting' ? amb.leadTourEveryMs : null;
  if (who.state === 'done') return null;
  return amb.tripEveryMs[who.state === 'enter' ? 'idle' : who.state] ?? null;
}

/**
 * Picks a spot for a trip. `taken` maps a spot id to how many stand there. A free spot is offered at its `at`;
 * a spot with a single occupant and a `pair` point is offered at the `pair` with probability `chatChance`.
 * @returns {{spot: object, slot: 'at'|'pair'} | null}
 */
export function chooseSpot(rng, spots, taken, chatChance) {
  const count = (s) => taken.get(s.id) ?? 0;
  const pairable = spots.filter((s) => s.pair && count(s) === 1);
  if (pairable.length && rng() < chatChance) return { spot: pairable[Math.floor(rng() * pairable.length)], slot: 'pair' };
  const free = spots.filter((s) => count(s) === 0);
  return free.length ? { spot: free[Math.floor(rng() * free.length)], slot: 'at' } : null;
}

export function chooseFidget(rng, seated, amb) {
  const list = amb.fidgets[seated ? 'seated' : 'standing'];
  return list[Math.floor(rng() * list.length)];
}

/**
 * One timer per floor. Each wake handles only the members that are due, then sleeps until the earliest scheduled
 * time (at least `tickMinMs`). A member is `{id, nextFidgetAt, nextTripAt, returnAt}`; the `act` callbacks update
 * those times: `trip` sets `returnAt` (the next step of a trip) or moves `nextTripAt`, `tripEnd` is called when
 * `returnAt` has come. A due trip is skipped while `awayCount() >= amb.maxAway`; it is retried after a trip ends.
 * @param {{amb: object, now: () => number, timers: {setTimeout: Function, clearTimeout: Function},
 *          members: () => object[], act: {fidget: Function, trip: Function, tripEnd: Function}, awayCount: () => number}} deps
 */
export function createFloorClock({ amb, now, timers, members, act, awayCount }) {
  let timer = null;
  let running = false;

  const nextWake = () => {
    let at = Infinity;
    for (const m of members()) {
      at = Math.min(at, m.nextFidgetAt);
      if (m.returnAt > 0) at = Math.min(at, m.returnAt);
      else if (awayCount() < amb.maxAway) at = Math.min(at, m.nextTripAt);
    }
    return at;
  };

  const schedule = () => {
    if (timer !== null) timers.clearTimeout(timer);
    timer = null;
    if (!running) return;
    const at = nextWake();
    if (at === Infinity) return;
    timer = timers.setTimeout(wake, Math.max(amb.tickMinMs, at - now()));
  };

  function wake() {
    timer = null;
    const t = now();
    const list = members();
    for (const m of list) if (m.returnAt > 0 && m.returnAt <= t) act.tripEnd(m);
    for (const m of list) if (m.nextFidgetAt <= t) act.fidget(m);
    for (const m of list) {
      if (m.returnAt === 0 && m.nextTripAt <= t && awayCount() < amb.maxAway) act.trip(m);
    }
    schedule();
  }

  return {
    start() {
      if (!amb.enabled) return;
      running = true;
      schedule();
    },
    stop() {
      running = false;
      if (timer !== null) timers.clearTimeout(timer);
      timer = null;
    },
    kick: schedule,
  };
}
