// Office life: more to watch while the owner waits. Three groups of activities, all of them real moves of real characters:
//   desk   working and thinking characters stay seated: a typing burst, a sip, a stretch, rubbing the eyes, a scribbled note, a nod,
//          a lean toward the neighbour with a quick line, a little chair roll, a small "eureka" when thinking turns into working;
//   roam   idle and stale characters walk to a spot: coffee or water, watering the plant, the window, the shelf, a sofa nap, a snack
//          for two at the pantry, a visit to a working colleague's desk to cheer (or bring coffee), a doodle on the whiteboard;
//   cat    the cat visits working desks, the window, naps on the sofa and dashes after a walking colleague.
// The choice rules (pure, time and randomness injected, so the tests drive a fake clock) come first; init(ctx) wires them to the office:
// the trip picker (the office's own trip machinery walks, holds the spot and walks home), the cat picker, ctx.line / ctx.chatter for words
// and CSS classes on .body for the gestures (web/officelife.css, transform and opacity only). Nobody is moved by this file directly.
// Behaviour runs with the effects off too (like ui.ambient); only the props (mug, steam, zzz, "!", notes) wait for fxOn().
// Every number lives in config ui.officeLife (plus the frequencies in ui.ambient and ui.cat).
import { between, rngFor } from './ambient.mjs';
import { openPoint } from './cat.mjs';

// ---------------------------------------------------------------------------------------------------------------------
// pure rules
// ---------------------------------------------------------------------------------------------------------------------

/** A roaming character goes back to its desk at once when its work resumes: always for working, for thinking when the trip is one of the life trips. */
export const headsBack = (state, lifeKind) => state === 'working' || (state === 'thinking' && !!lifeKind);

/**
 * Whether a character may start something now: at its place (arrived), not walking or away, not held / pressed / in a scene (report, meeting,
 * high-five), not speaking, not already busy with a life activity, and not finished or gone.
 * @param {{walk?: any, away?: boolean, grab?: any, press?: any, play?: any, say?: any, arrived?: boolean, state?: string, gone?: boolean, busy?: boolean}} r
 */
export const isFree = (r) => !!r.arrived && !r.walk && !r.away && !r.grab && !r.press && !r.play && !r.say && !r.busy && !r.gone && r.state !== 'done';

/** Per-character memory of when each kind started: `{chars: Map(id -> {at, kinds: {kind: at}})}`. */
export const newMem = () => ({ chars: new Map() });

/** Whether `id` may start `kind` now: past the character's own cooldown and the kind's cooldown. */
export function ready(mem, L, id, kind, now) {
  const c = mem.chars.get(id);
  if (!c) return true;
  return now - c.at >= L.charCooldownMs && now - (c.kinds[kind] ?? -Infinity) >= (L.acts[kind]?.cooldownMs ?? 0);
}

/** Remembers that `id` started `kind` at `now`. */
export function noteStart(mem, id, kind, now) {
  const c = mem.chars.get(id) ?? { at: 0, kinds: {} };
  c.at = now;
  c.kinds[kind] = now;
  mem.chars.set(id, c);
}

const pickOf = (rng, list) => list[Math.floor(rng() * list.length)];

/** One stop of a trip: `life` names what to do there, `stayMs` how long it lasts (the office's trip machinery reads x, y, face, spotId, stayMs). */
const stop = (spot, slot, life, stayMs) => ({
  x: slot === 'pair' ? spot.pair[0] : spot.at[0], y: slot === 'pair' ? spot.pair[1] : spot.at[1],
  face: slot === 'pair' ? (spot.at[0] < spot.pair[0] ? 'left' : 'right') : spot.face, spotId: spot.id, slot, life, stayMs,
});

const freeSpots = (snap, kinds, needPair = false) => snap.spots.filter((s) => kinds.includes(s.kind) && !snap.taken.get(s.id) && (!needPair || s.pair));

/** A neighbour that could be leaned toward: another free member within `L.neighborPx`. */
const neighbourOf = (L, snap, m) => snap.members.filter((o) => o.id !== m.id && o.free && Math.hypot(o.x - m.x, o.y - m.y) <= L.neighborPx);

/**
 * Each builder answers null when the kind is impossible now, or a function that makes the choice (so the random draws happen only for the
 * kind that was picked). `who` = members that may do it (state, cooldown, free); `room` = how many more may be away.
 */
const BUILD = {
  desk(rng, L, def, kind, snap, who) {
    const use = def.needs === 'neighbor' ? who.filter((m) => neighbourOf(L, snap, m).length) : who;
    if (!use.length) return null;
    return () => {
      const m = pickOf(rng, use);
      const mate = def.needs === 'neighbor' ? pickOf(rng, neighbourOf(L, snap, m)) : null;
      return { group: 'desk', kind, id: m.id, mate: mate?.id ?? null, dir: mate ? Math.sign(mate.x - m.x) || 1 : rng() < 0.5 ? -1 : 1 };
    };
  },
  spot(rng, L, def, kind, snap, who, room) {
    const spots = freeSpots(snap, def.spotKinds);
    if (room < 1 || !spots.length) return null;
    return () => {
      const m = pickOf(rng, who);
      return { group: 'roam', kind, picks: [{ id: m.id, legs: [stop(pickOf(rng, spots), 'at', kind, def.stayMs)] }] };
    };
  },
  snack(rng, L, def, kind, snap, who, room) {
    const spots = freeSpots(snap, def.spotKinds, true);
    if (room < 2 || who.length < 2 || !spots.length) return null;
    return () => {
      const spot = pickOf(rng, spots);
      const a = pickOf(rng, who);
      const b = pickOf(rng, who.filter((m) => m.id !== a.id));
      return { group: 'roam', kind, picks: [{ id: a.id, legs: [stop(spot, 'at', kind, def.stayMs)] }, { id: b.id, legs: [stop(spot, 'pair', kind, def.stayMs)] }] };
    };
  },
  visit(rng, L, def, kind, snap, who, room) {
    const hosts = snap.desks.filter((d) => d.free && !snap.visiting.has(d.id));
    if (room < 1 || !hosts.length) return null;
    const bring = freeSpots(snap, def.bringKinds);
    return () => {
      const m = pickOf(rng, who);
      const hs = hosts.filter((d) => d.id !== m.id);
      if (!hs.length) return null;
      const d = pickOf(rng, hs);
      const fetch = bring.length > 0 && rng() < def.bringChance;
      const legs = [];
      if (fetch) legs.push(stop(pickOf(rng, bring), 'at', 'pickup', def.pickupMs));
      legs.push({ x: d.x, y: d.y, face: d.face, life: 'visit', stayMs: def.stayMs, host: d.id, bring: fetch });
      return { group: 'roam', kind, host: d.id, picks: [{ id: m.id, legs }] };
    };
  },
};

/**
 * What starts next on one floor, or null. `snap` = {now, meeting, members: [{id, state, isLead, x, y, free}], spots, taken: Map(spotId -> n),
 * desks: [{id, x, y, face, free}] (seated working colleagues one may visit), visiting: Set(host id), awayCount, maxAway, lastKind}.
 * `opts.only` limits the actor to one member, `opts.group` to 'desk' or 'roam'. Nothing starts during a meeting.
 * @returns {{group: 'desk', kind: string, id: any, mate: any, dir: number} | {group: 'roam', kind: string, picks: {id: any, legs: object[]}[], host?: any} | null}
 */
export function chooseLifeAct(rng, L, snap, mem, opts = {}) {
  if (snap.meeting) return null;
  const pool = snap.members.filter((m) => m.free && (opts.only === undefined || m.id === opts.only));
  const room = snap.maxAway - snap.awayCount;
  const options = [];
  for (const [kind, def] of Object.entries(L.acts)) {
    if (def.group === 'event' || (opts.group && def.group !== opts.group)) continue;
    const who = pool.filter((m) => def.states.includes(m.state) && ready(mem, L, m.id, kind, snap.now));
    if (!who.length) continue;
    const make = BUILD[def.group === 'desk' ? 'desk' : (BUILD[kind] ? kind : 'spot')](rng, L, def, kind, snap, who, room);
    if (make) options.push({ w: def.weight * (kind === snap.lastKind ? L.repeatWeight : 1), make });
  }
  while (options.length) {
    let roll = rng() * options.reduce((n, o) => n + o.w, 0);
    const i = Math.max(0, options.findIndex((o) => (roll -= o.w) < 0));
    const made = options[i].make();
    if (made) return made;
    options.splice(i, 1);
  }
  return null;
}

/**
 * One timer for all floors: each floor has its own next time (`L.everyMs` after a start, `L.retryMs` after nothing could start); one wake
 * handles the due floors and sleeps until the earliest. `floors()` lists the floors that may run now (shown, page visible);
 * `tick(id)` tries to start something and answers whether it did. A floor met for the first time waits `L.firstDelayMs`; `reset(id)` does the same.
 */
export function createDirector({ L, now, rng, timers, floors, tick }) {
  const next = new Map();
  let timer = null;
  let running = false;
  const dueOf = (id) => {
    if (!next.has(id)) next.set(id, now() + between(rng, L.firstDelayMs));
    return next.get(id);
  };
  const schedule = () => {
    if (timer !== null) timers.clearTimeout(timer);
    timer = null;
    if (!running) return;
    let at = Infinity;
    for (const id of floors()) at = Math.min(at, dueOf(id));
    if (at !== Infinity) timer = timers.setTimeout(wake, Math.max(L.minTickMs, at - now()));
  };
  function wake() {
    timer = null;
    const t = now();
    for (const id of floors()) if (dueOf(id) <= t) next.set(id, t + (tick(id) ? between(rng, L.everyMs) : L.retryMs));
    schedule();
  }
  return {
    start() {
      running = true;
      schedule();
    },
    stop() {
      running = false;
      schedule();
    },
    kick: schedule,
    reset(id) {
      next.delete(id);
    },
  };
}

/**
 * The cat's next act on a floor, in the shape of cat.mjs chooseCatAct (plus `kind`), or null to leave it to the default rules.
 * `s` = {now, desks: [{id, x, y, face, agent}], spots, taken, walkers: [{id, x, y}], point() -> pt|null, snapPt(pt) -> pt|null, visited: Map(id -> at),
 * dashLeft, lastKind}. A dash chain (`dashLeft` > 0) goes on first; `pick.dashLeft` is the number of dashes still to come.
 */
export function chooseCatLife(rng, C, s) {
  const dash = () => {
    const w = s.walkers.length ? pickOf(rng, s.walkers) : null; // follows a walking colleague to where it is going, else runs to a random point
    const to = w ? s.snapPt([w.x + pickOf(rng, C.chaseOffsetPx), w.y]) : s.point();
    return to ? { kind: 'chase', act: 'stroll', pose: 'stand', ms: between(rng, C.chaseStayMs), x: to[0], y: to[1], face: rng() < 0.5 ? 'left' : 'right' } : null;
  };
  if (s.dashLeft > 0) {
    const d = dash();
    if (d) return { ...d, dashLeft: s.dashLeft - 1 };
  }
  if (rng() >= C.ownChance) return null;
  const options = [];
  const add = (kind, make) => make && options.push({ kind, w: C.weights[kind] * (kind === s.lastKind ? C.repeatWeight : 1), make });
  const desks = s.desks.filter((d) => s.now - (s.visited.get(d.id) ?? -Infinity) >= C.visitCooldownMs);
  add('visit', desks.length && (() => {
    const d = pickOf(rng, desks);
    return { kind: 'visit', act: 'desk', pose: 'sit', ms: between(rng, C.visitMs), x: d.x, y: d.y, face: d.face, desk: d, deskId: d.id };
  }));
  const at = (kinds, act, pose, ms, kind) => {
    const spots = freeSpots(s, kinds);
    return spots.length && (() => {
      const sp = pickOf(rng, spots);
      return { kind, act, pose, ms: between(rng, ms), x: sp.at[0], y: sp.at[1], face: sp.face, spotId: sp.id };
    });
  };
  add('window', at(C.windowKinds, 'spot', 'sit', C.windowMs, 'window'));
  add('nap', at(C.napKinds, 'sleep', 'sleep', C.napMs, 'nap'));
  add('chase', (s.walkers.length || C.zoomies) && (() => {
    const d = dash();
    return d && { ...d, dashLeft: Math.round(between(rng, C.dashes)) - 1 };
  }));
  while (options.length) {
    let roll = rng() * options.reduce((n, o) => n + o.w, 0);
    const i = Math.max(0, options.findIndex((o) => (roll -= o.w) < 0));
    const made = options[i].make();
    if (made) return made;
    options.splice(i, 1);
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------
// the office side
// ---------------------------------------------------------------------------------------------------------------------

/** Every animation class this module puts on `.body` (web/officelife.css). */
const CLASS_PREFIX = 'life-';

/** @param {import('./fx.mjs').FxCtx} ctx */
export function init(ctx) {
  const L0 = ctx.ui.officeLife;
  if (!L0?.enabled || !ctx.ui.ambient.enabled) return;
  const { fx } = ctx;
  const k = ctx.ui.ambient.tickMinMs ? ctx.life.ambient.tickMinMs / ctx.ui.ambient.tickMinMs : 1; // ?debug=ambient shrinks every time range
  const L = scaleLife(L0, k);
  const C = scaleCat(L0.cat, k);
  const params = new URLSearchParams(location.search);
  const debug = params.get('debug') === 'ambient';

  const floorState = new Map(); // floor id -> {rng, mem, lastKind}
  const acts = new Map(); // rec -> {kind, timer, prop}: the life activity a character is in
  const roamers = new Map(); // rec -> {floor, kind, shown, last, timer}: a character on a life trip
  const pending = new Map(); // rec -> {legs, kind, at}: a trip chosen but not yet taken (the floor clock takes it within about a second)
  const visiting = new Map(); // host id -> floor id: a colleague is on the way to that desk
  const counts = {};
  const log = [];

  const stateOf = (f) => {
    let s = floorState.get(f.sid);
    if (!s) floorState.set(f.sid, (s = { rng: rngFor(`life:${f.sid}`), mem: newMem(), lastKind: '' }));
    return s;
  };
  const idOf = (rec) => rec.m?.id ?? rec.sprite;
  const isFloor = (f) => !!f.agents && f !== ctx.lobby();
  const runnable = () => [...ctx.floors()].filter((f) => isFloor(f) && ctx.floorActive(f));

  // ---- gestures and props ----

  function clearClasses(rec) {
    for (const c of [...rec.body.classList]) if (c.startsWith(CLASS_PREFIX)) rec.body.classList.remove(c);
    rec.body.style.removeProperty('--life-ms');
    rec.body.style.removeProperty('--life-dir');
  }

  function removeProp(a) {
    a.prop?.remove();
    a.prop = null;
  }

  /** A prop (mug, "zzz", "!", note, drops) next to the character: only while the effects are on, and only one per character. */
  function addProp(rec, a, name) {
    if (!fx.fxOn() || !name) return;
    removeProp(a);
    const p = document.createElement('i');
    p.className = `life-prop life-p-${name}`;
    if (name === 'zzz' || name === 'bang') p.textContent = name === 'zzz' ? 'z Z' : '!';
    if (name === 'note') p.textContent = '✎';
    rec.tagRoot.append(p);
    a.prop = p;
  }

  function stopAct(rec) {
    const a = acts.get(rec);
    if (!a) return;
    if (a.timer) ctx.timers.clearTimeout(a.timer);
    removeProp(a);
    clearClasses(rec);
    acts.delete(rec);
  }

  /** Starts a gesture: class `life-<anim>` on .body for `ms` (once), or until stopAct when `loop`. */
  function gesture(rec, kind, def, { ms = def.ms, loop = false, dir = 0, prop = def.prop } = {}) {
    stopAct(rec);
    ctx.clearGestures(rec);
    const a = { kind, timer: 0, prop: null };
    acts.set(rec, a);
    rec.body.style.setProperty('--life-ms', `${ms}ms`);
    if (dir) rec.body.style.setProperty('--life-dir', String(dir));
    rec.body.classList.add(`${CLASS_PREFIX}${def.anim}`);
    if (loop) rec.body.classList.add('life-loop');
    addProp(rec, a, prop);
    if (!loop) a.timer = ctx.timers.setTimeout(() => stopAct(rec), ms + L.tailMs);
    return a;
  }

  function speak(rec, def, key = def.line) {
    if (!key || Math.random() >= (def.lineChance ?? 1)) return;
    ctx.chatter(rec, ctx.line(key, undefined, rec), L.sayMs);
  }

  function count(kind, f, rec) {
    counts[kind] = (counts[kind] ?? 0) + 1;
    if (debug) {
      log.push({ t: Math.round(ctx.now() / 100) / 10, floor: f.sid, who: idOf(rec), kind });
      if (log.length > L.logCap) log.shift();
    }
  }

  // ---- desk activities ----

  function startDesk(f, rec, kind, extra = {}) {
    const def = L.acts[kind];
    const a = gesture(rec, kind, def, extra);
    speak(rec, def);
    count(kind, f, rec);
    return a;
  }

  function playDesk(f, pick, byId) {
    const rec = byId.get(pick.id);
    if (!rec) return false;
    const def = L.acts[pick.kind];
    if (pick.kind === 'lean') {
      const mate = byId.get(pick.mate);
      if (!mate) return false;
      gesture(rec, 'lean', def, { dir: pick.dir });
      gesture(mate, 'nod', L.acts.nod); // the neighbour answers with a nod
      ctx.chatter(rec, ctx.line('smallTalk', undefined, rec), L.sayMs);
      count('lean', f, rec);
      return true;
    }
    startDesk(f, rec, pick.kind, { dir: pick.dir });
    return true;
  }

  // ---- roaming ----

  const arrivedAt = (rec, leg) => rec.arrived && !rec.walk && Math.hypot(rec.x - leg.x, rec.y - leg.y) <= L.arriveSnapPx;

  function stopRoamVisual(rec) {
    stopAct(rec);
  }

  /** The character stands at a stop of its trip: what it does there. */
  function atStop(r, rec, leg) {
    const def = L.acts[leg.life];
    if (leg.life === 'pickup') return;
    if (leg.life === 'visit') {
      gesture(rec, 'visit', def, { prop: leg.bring ? 'mug' : null });
      const host = ctx.chars(r.floor).find((h) => idOf(h) === leg.host);
      speak(rec, L.acts.visit, leg.bring ? L.acts.visit.bringLine : L.acts.visit.line);
      count('visit', r.floor, rec);
      if (host && isFree({ ...host, busy: acts.has(host) })) {
        ctx.timers.setTimeout(() => {
          if (!host.walk && !host.away && !host.grab && !host.play && host.state === 'working' && !rec.walk) {
            if (leg.bring) gesture(host, 'sip', L.acts.sip);
            else gesture(host, 'nod', L.acts.nod);
            ctx.chatter(host, ctx.line(L.acts.visit.replyLine, undefined, host), L.sayMs);
          }
        }, L.replyMs);
      }
      return;
    }
    gesture(rec, leg.life, def, { ms: def.ms, loop: true });
    speak(rec, def);
    if (leg.life === 'snack') count('snack', r.floor, rec); // each of the two
    else count(leg.life, r.floor, rec);
  }

  function pollRoamer(rec) {
    const r = roamers.get(rec);
    if (!r) return;
    r.timer = 0;
    if (!rec.away || !rec.trip) return endRoam(rec);
    const leg = rec.trip.cur;
    if (rec.walk) {
      if (r.shown) {
        stopRoamVisual(rec);
        r.shown = false;
      }
    } else if (leg?.life && leg !== r.last && arrivedAt(rec, leg)) {
      r.last = leg;
      r.shown = true;
      atStop(r, rec, leg);
    }
    r.timer = ctx.timers.setTimeout(() => pollRoamer(rec), L.pollMs);
  }

  function endRoam(rec) {
    const r = roamers.get(rec);
    if (!r) return;
    if (r.timer) ctx.timers.clearTimeout(r.timer);
    roamers.delete(rec);
    for (const [host, sid] of [...visiting]) if (sid === r.floor.sid && r.host === host) visiting.delete(host);
    stopRoamVisual(rec);
  }

  function beginRoam(f, rec, kind, legs) {
    const host = legs.find((l) => l.host)?.host;
    if (host !== undefined) visiting.set(host, f.sid);
    roamers.set(rec, { floor: f, kind, shown: false, last: null, host, timer: ctx.timers.setTimeout(() => pollRoamer(rec), L.pollMs) });
  }

  /** The floor clock asks for the trip of `rec`: a chosen one first, else (a natural trip of an idle or stale character) a new choice. */
  ctx.life.addTripPicker((f, rec) => {
    if (!isFloor(f) || !ctx.floorActive(f)) return null;
    const s = stateOf(f);
    const p = pending.get(rec);
    if (p) {
      pending.delete(rec);
      if (!L.acts[p.kind].states.includes(rec.state) || f.meeting) return null; // it changed meanwhile: the office's own rules decide
      beginRoam(f, rec, p.kind, p.legs);
      return p.legs;
    }
    if (rec.isLead && s.rng() >= L.leadOwnChance) return null; // an idle lead goes on its desk tour (the office's own rules) part of the time
    const snap = snapshot(f, s);
    const pick = chooseLifeAct(s.rng, L, snap, s.mem, { only: idOf(rec), group: 'roam' });
    if (!pick || pick.picks.length !== 1) return null; // a pair is the director's job
    return take(f, s, pick, rec);
  });

  function take(f, s, pick, rec) {
    const { id, legs } = pick.picks[0];
    noteStart(s.mem, id, pick.kind, ctx.now());
    s.lastKind = pick.kind;
    beginRoam(f, rec, pick.kind, legs);
    return legs;
  }

  function startRoam(f, s, pick, byId) {
    const t = ctx.now();
    const recs = pick.picks.map((p) => byId.get(p.id));
    if (recs.some((r) => !r?.m)) return false;
    pick.picks.forEach((p, i) => {
      noteStart(s.mem, p.id, pick.kind, t);
      pending.set(recs[i], { legs: p.legs, kind: pick.kind, at: t });
      recs[i].m.nextTripAt = t; // the floor clock takes the trip within its next wake
    });
    s.lastKind = pick.kind;
    f.clock?.kick();
    return true;
  }

  // ---- the floor snapshot the rules read ----

  function snapshot(f, s) {
    const t = ctx.now();
    for (const [rec, p] of pending) if (t - p.at > L.pendingMs) pending.delete(rec); // never taken: forget it
    const { r } = f.scene;
    const recs = ctx.life.members(f);
    const members = recs.map((rec) => ({
      id: idOf(rec), state: rec.state, isLead: rec.isLead, x: rec.x, y: rec.y, rec,
      free: isFree({ ...rec, busy: acts.has(rec) || pending.has(rec) || (ctx.gesture ? !ctx.gesture.canAmbient(rec) : false), gone: rec.el.classList.contains('gone') }), // a stronger gesture (ctx.gesture) holds it: not free
    }));
    const desks = [];
    for (const m of members) {
      const seat = !m.isLead && m.rec.slot?.kind === 'seat' && m.state === 'working' ? r.seats[m.rec.slot.i] : null;
      if (seat?.visit) desks.push({ id: m.id, x: seat.visit[0], y: seat.visit[1], face: seat.at[0] < seat.visit[0] ? 'left' : 'right', free: m.free });
    }
    const taken = ctx.life.takenSpots(f, null);
    for (const [rec, p] of pending) { // spots of trips chosen but not yet started
      if (rec.frec !== f) continue;
      for (const leg of p.legs) if (leg.spotId) taken.set(leg.spotId, (taken.get(leg.spotId) ?? 0) + 1);
    }
    const away = recs.filter((rec) => rec.away).length + [...pending.keys()].filter((rec) => rec.frec === f && !rec.away).length;
    return {
      now: t, meeting: !!f.meeting, members, spots: r.spots, taken, desks,
      visiting: new Set([...visiting].filter(([, sid]) => sid === f.sid).map(([h]) => h)),
      awayCount: away, maxAway: ctx.life.ambient.maxAway, lastKind: s.lastKind,
    };
  }

  function tickFloor(id) {
    const f = ctx.floor(id);
    if (!f || !ctx.floorActive(f) || f.meeting) return false;
    const s = stateOf(f);
    const snap = snapshot(f, s);
    const pick = chooseLifeAct(s.rng, L, snap, s.mem);
    if (!pick) return false;
    const byId = new Map(snap.members.map((m) => [m.id, m.rec]));
    if (pick.group === 'roam') return startRoam(f, s, pick, byId);
    noteStart(s.mem, pick.id, pick.kind, snap.now);
    s.lastKind = pick.kind;
    return playDesk(f, pick, byId);
  }

  const director = createDirector({
    L, now: ctx.now, rng: rngFor('life:director'), timers: ctx.timers,
    floors: () => runnable().map((f) => f.sid), tick: tickFloor,
  });

  // ---- events: what always wins over a life activity, and the eureka ----

  const stopAll = () => {
    for (const rec of [...acts.keys()]) stopAct(rec);
    for (const rec of [...roamers.keys()]) endRoam(rec);
  };
  const stopOf = (rec) => {
    if (rec) stopAct(rec);
  };
  const always = { always: true };
  fx.onFx('walk-start', ({ rec }) => {
    stopOf(rec); // any walk ends the gesture at once (a roamer leaving its stop included; its poll ends the trip)
    const r = roamers.get(rec);
    if (r) r.shown = false;
  }, always);
  for (const name of ['lift', 'drop', 'thrown', 'poke']) fx.onFx(name, ({ rec }) => stopOf(rec), always);
  fx.onFx('report', ({ rec, lead }) => { stopOf(rec); stopOf(lead); }, always);
  fx.onFx('high-five', ({ a, b }) => { stopOf(a); stopOf(b); }, always);
  fx.onFx('meeting-start', ({ floor }) => { for (const rec of ctx.chars(floor)) { stopOf(rec); if (roamers.has(rec)) endRoam(rec); } }, always);
  const thinkSince = new Map(); // rec -> when it began thinking: a eureka needs a real stretch of thinking before
  fx.onFx('state', ({ rec, from, to }) => {
    if (to === 'thinking') thinkSince.set(rec, ctx.now());
    if (roamers.has(rec) && headsBack(to, true)) stopOf(rec); // the office walks it home; the poll ends the trip
    if (from === 'thinking' && to === 'working' && !rec.isCat && ctx.now() - (thinkSince.get(rec) ?? ctx.now()) >= L.acts.eureka.minThinkMs) eureka(rec);
    if (to !== 'thinking') thinkSince.delete(rec);
  }, always);
  fx.onFx('floor-hidden', ({ floor, removed }) => {
    for (const rec of ctx.chars(floor)) { stopOf(rec); if (roamers.has(rec)) endRoam(rec); if (removed) thinkSince.delete(rec); }
    if (removed) floorState.delete(floor.sid);
  }, always);
  fx.onFx('floor-shown', ({ floor }) => { director.reset(floor.sid); director.kick(); }, always);
  ctx.onPauseChange((paused) => {
    if (paused) stopAll();
    director.kick();
  });
  fx.onFxChange(({ fx: on }) => {
    if (!on) for (const a of acts.values()) removeProp(a); // the behaviour goes on, the props go
  });

  function eureka(rec) {
    const f = rec.frec;
    if (!f || !isFloor(f) || !ctx.floorActive(f) || f.meeting) return;
    const s = stateOf(f);
    const t = ctx.now();
    if (t - (s.mem.chars.get(idOf(rec))?.kinds.eureka ?? -Infinity) < L.acts.eureka.cooldownMs || !isFree({ ...rec, busy: acts.has(rec), gone: rec.el.classList.contains('gone') })) return;
    noteStart(s.mem, idOf(rec), 'eureka', t);
    startDesk(f, rec, 'eureka');
  }

  // ---- the cat ----

  const cs = { dashLeft: 0, lastKind: '', visited: new Map() };
  const catRng = rngFor('life:cat');
  ctx.life.addFidgetPicker((f, rec) => acts.has(rec) || roamers.has(rec)); // no plain fidget over a life gesture
  ctx.life.addCatPicker(({ cat, floor }) => {
    if (!C.enabled || !isFloor(floor)) return null;
    const t = ctx.now();
    if (cs.dashLeft <= 0 && ctx.floors && [...ctx.floors()].filter((x) => isFloor(x) && !x.off).length > 1 && t >= cat.leaveAt) return null; // time to move on: the default rules open the door
    const { r } = floor.scene;
    const recs = ctx.life.members(floor);
    const desks = [];
    for (const a of recs) {
      const seat = !a.isLead && a.slot?.kind === 'seat' && a.arrived && !a.walk && (a.state === 'working' || a.state === 'thinking') ? r.seats[a.slot.i] : null;
      if (seat?.visit) desks.push({ id: idOf(a), x: seat.visit[0], y: seat.visit[1], face: seat.at[0] < seat.visit[0] ? 'left' : 'right', agent: a });
    }
    const grid = ctx.nav.grid(floor.design);
    const pick = chooseCatLife(catRng, C, {
      now: t, desks, spots: r.spots, taken: ctx.life.takenSpots(floor, null), visited: cs.visited, dashLeft: cs.dashLeft, lastKind: cs.lastKind,
      walkers: recs.filter((a) => a.walk && a.arrived === false).map((a) => ({ id: idOf(a), x: a.x, y: a.y })),
      point: () => openPoint(catRng, grid), snapPt: (p) => ctx.nav.snap(floor.design, p),
    });
    if (!pick) {
      cs.dashLeft = 0;
      return null;
    }
    cs.dashLeft = pick.dashLeft ?? 0;
    cs.lastKind = pick.kind;
    if (pick.deskId !== undefined) cs.visited.set(pick.deskId, t);
    counts[`cat-${pick.kind}`] = (counts[`cat-${pick.kind}`] ?? 0) + 1;
    if (debug) {
      log.push({ t: Math.round(t / 100) / 10, floor: floor.sid, who: 'cat', kind: `cat-${pick.kind}` });
      if (log.length > L.logCap) log.shift();
    }
    return pick;
  });

  if (debug && window.__ambient) window.__ambient.life = () => ({ counts: { ...counts }, distinct: Object.keys(counts).length, log: [...log], acts: acts.size, roamers: roamers.size, pending: pending.size });
  director.start();
}

/** Time ranges of ui.officeLife times `k` (?debug=ambient). Animation lengths stay as they are: a gesture must stay readable. */
export function scaleLife(L, k) {
  if (k === 1) return L;
  const range = (v) => v.map((n) => n * k);
  const acts = Object.fromEntries(Object.entries(L.acts).map(([name, a]) => [name, {
    ...a, cooldownMs: a.cooldownMs * k, ...(a.stayMs ? { stayMs: range(a.stayMs) } : {}), ...(a.pickupMs ? { pickupMs: a.pickupMs * k } : {}),
  }]));
  return { ...L, acts, everyMs: range(L.everyMs), firstDelayMs: range(L.firstDelayMs), retryMs: L.retryMs * k, charCooldownMs: L.charCooldownMs * k };
}

/** The cat block of ui.officeLife with its time ranges times `k`. */
export function scaleCat(C, k) {
  if (k === 1) return C;
  const range = (v) => v.map((n) => n * k);
  return { ...C, visitMs: range(C.visitMs), windowMs: range(C.windowMs), napMs: range(C.napMs), visitCooldownMs: C.visitCooldownMs * k };
}
