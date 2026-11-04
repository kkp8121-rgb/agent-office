// Office life (web/officelife.mjs): what may start, who may do it, how often, and what always wins. A fake clock drives everything.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../server/config.mjs';
import { rngFor } from '../web/ambient.mjs';
import {
  chooseCatLife, chooseLifeAct, createDirector, headsBack, init, isFree, newMem, noteStart, ready, scaleCat, scaleLife,
} from '../web/officelife.mjs';
import { ROOT } from './helpers/fixture.mjs';

const cfg = loadConfig();
const L = cfg.ui.officeLife;
const C = L.cat;
const AMB = cfg.ui.ambient;
const css = readFileSync(join(ROOT, 'web', 'officelife.css'), 'utf8');

// ---------------------------------------------------------------------------------------------------------------------
// a simulated floor for the pure rules: seven characters, the usual spots, one pair spot
// ---------------------------------------------------------------------------------------------------------------------

const SPOTS = [
  { id: 'coffee', kind: 'coffee', at: [100, 100], face: 'left', pair: [130, 100] },
  { id: 'water', kind: 'water', at: [200, 100], face: 'left', pair: null },
  { id: 'window', kind: 'window', at: [300, 100], face: 'right', pair: null },
  { id: 'sofa', kind: 'sofa', at: [400, 100], face: 'left', pair: null },
  { id: 'plant', kind: 'plant', at: [500, 100], face: 'left', pair: null },
  { id: 'board', kind: 'whiteboard', at: [600, 100], face: 'right', pair: null },
  { id: 'shelf', kind: 'shelf', at: [700, 100], face: 'right', pair: null },
];
const ROSTER = [
  ['lead', 'working', true], ['w1', 'working'], ['w2', 'working'], ['w3', 'thinking'], ['i1', 'idle'], ['i2', 'idle'], ['s1', 'stale'],
].map(([id, state, isLead], n) => ({ id, state, isLead: !!isLead, x: 50 + n * 60, y: 300 }));

/** The floor the rules read, advanced by a fake clock: busy characters and away trips end at their time. */
function simFloor(roster = ROSTER, over = {}) {
  const sim = { t: 0, busy: new Map(), away: new Map(), taken: new Map(), meeting: false, roster, log: [], ...over };
  sim.snap = () => {
    for (const [id, until] of sim.busy) if (until <= sim.t) sim.busy.delete(id);
    for (const [id, a] of sim.away) if (a.until <= sim.t) { sim.away.delete(id); sim.taken.delete(a.spot); }
    const members = roster.map((m) => ({ ...m, free: !sim.busy.has(m.id) && !sim.away.has(m.id) && !m.held }));
    const desks = members.filter((m) => !m.isLead && m.state === 'working').map((m) => ({ id: m.id, x: m.x, y: m.y + 20, face: 'left', free: m.free }));
    return {
      now: sim.t, meeting: sim.meeting, members, spots: SPOTS, taken: new Map([...sim.taken].map(([k, v]) => [k, v])), desks, visiting: new Set(),
      awayCount: sim.away.size, maxAway: AMB.maxAway, lastKind: sim.lastKind ?? '',
    };
  };
  sim.apply = (pick, mem) => {
    sim.lastKind = pick.kind;
    if (pick.group === 'desk') {
      noteStart(mem, pick.id, pick.kind, sim.t);
      sim.busy.set(pick.id, sim.t + L.acts[pick.kind].ms);
      if (pick.mate) sim.busy.set(pick.mate, sim.t + L.acts[pick.kind].ms);
    } else {
      for (const p of pick.picks) {
        noteStart(mem, p.id, pick.kind, sim.t);
        const leg = p.legs.at(-1);
        sim.away.set(p.id, { until: sim.t + 5000 + (Array.isArray(leg.stayMs) ? leg.stayMs[1] : leg.stayMs ?? 5000), spot: leg.spotId });
        if (leg.spotId) sim.taken.set(leg.spotId, (sim.taken.get(leg.spotId) ?? 0) + 1);
      }
    }
  };
  return sim;
}

/** Runs the director on the fake clock for `minutes`; returns every start {t, pick, awayBefore}. */
function run(sim, minutes, seed = 'sim') {
  const rng = rngFor(seed);
  const mem = newMem();
  const starts = [];
  const timers = [];
  const fake = {
    setTimeout: (fn, ms) => { const h = { at: sim.t + ms, fn }; timers.push(h); return h; },
    clearTimeout: (h) => { const i = timers.indexOf(h); if (i >= 0) timers.splice(i, 1); },
  };
  const director = createDirector({
    L, now: () => sim.t, rng: rngFor(`${seed}:dir`), timers: fake, floors: () => ['f'],
    tick: () => {
      const snap = sim.snap();
      const pick = chooseLifeAct(rng, L, snap, mem);
      if (!pick) return false;
      starts.push({ t: sim.t, pick, awayBefore: snap.awayCount, members: snap.members });
      sim.apply(pick, mem);
      return true;
    },
  });
  director.start();
  const end = minutes * 60000;
  while (timers.length) {
    timers.sort((a, b) => a.at - b.at);
    const next = timers.shift();
    if (next.at > end) break;
    sim.t = next.at;
    next.fn();
  }
  return starts;
}

const stateOf = (members, id) => members.find((m) => m.id === id).state;

// ---------------------------------------------------------------------------------------------------------------------
// the rules
// ---------------------------------------------------------------------------------------------------------------------

test('rules: a working or thinking character never gets a roaming activity, and a roaming one is never asked to sit and fidget', () => {
  const starts = run(simFloor(), 30);
  assert.ok(starts.length > 50);
  for (const { pick, members } of starts) {
    if (pick.group === 'roam') for (const p of pick.picks) assert.ok(['idle', 'enter', 'stale'].includes(stateOf(members, p.id)), `${pick.kind} for ${stateOf(members, p.id)}`);
    else assert.ok(L.acts[pick.kind].states.includes(stateOf(members, pick.id)), `${pick.kind} for ${stateOf(members, pick.id)}`);
  }
  assert.ok(starts.some((s) => s.pick.group === 'roam') && starts.some((s) => s.pick.group === 'desk'), 'both groups happen');
  assert.ok(!starts.some((s) => s.pick.group === 'roam' && s.pick.picks.some((p) => p.id === 'lead')), 'a working lead keeps to the desk activities');
  const idleLead = run(simFloor(ROSTER.map((m) => (m.isLead ? { ...m, state: 'idle' } : m))), 30, 'lead');
  assert.ok(idleLead.some((s) => s.pick.group === 'roam' && s.pick.picks.some((p) => p.id === 'lead')), 'an idle lead (the only one who is ever idle) roams too');
});

test('rules: with only working characters on a floor nothing ever leaves a desk', () => {
  const roster = ROSTER.map((m) => ({ ...m, state: 'working' }));
  const starts = run(simFloor(roster), 30);
  assert.ok(starts.length > 50);
  assert.ok(starts.every((s) => s.pick.group === 'desk'));
});

test('rules: frequency over 30 simulated minutes stays inside the configured bounds (a start every 5-10 s on a busy floor)', () => {
  const starts = run(simFloor(), 30);
  const min = Math.min(...L.everyMs);
  const gaps = starts.slice(1).map((s, i) => s.t - starts[i].t);
  assert.ok(gaps.every((g) => g >= min - 1), `no two starts closer than everyMs[0] = ${min}: ${Math.min(...gaps)}`);
  const avg = (starts.at(-1).t - starts[0].t) / (starts.length - 1);
  assert.ok(avg >= min && avg <= 1.5 * L.everyMs[1], `average gap ${Math.round(avg)} ms`);
  const per30 = starts.length;
  assert.ok(per30 >= (30 * 60000) / (1.5 * L.everyMs[1]) && per30 <= (30 * 60000) / min, `${per30} starts`);
});

test('rules: nobody starts twice inside its own cooldown, and a kind keeps its cooldown for the same character', () => {
  const starts = run(simFloor(), 30, 'cooldown');
  const lastAny = new Map();
  const lastKind = new Map();
  for (const { t, pick } of starts) {
    const ids = pick.group === 'desk' ? [pick.id] : pick.picks.map((p) => p.id);
    for (const id of ids) {
      assert.ok(t - (lastAny.get(id) ?? -Infinity) >= L.charCooldownMs, `${id} repeats too soon`);
      assert.ok(t - (lastKind.get(`${id}:${pick.kind}`) ?? -Infinity) >= L.acts[pick.kind].cooldownMs, `${id} repeats ${pick.kind}`);
      lastAny.set(id, t);
      lastKind.set(`${id}:${pick.kind}`, t);
    }
  }
});

test('rules: at most ui.ambient.maxAway are away at once, and a pair needs two free places', () => {
  const sim = simFloor();
  const starts = run(sim, 30, 'maxaway');
  for (const { pick, awayBefore } of starts) if (pick.group === 'roam') assert.ok(awayBefore + pick.picks.length <= AMB.maxAway, `${awayBefore} + ${pick.picks.length}`);
  const snap = { ...simFloor().snap(), awayCount: AMB.maxAway - 1 };
  const rng = rngFor('pair');
  for (let i = 0; i < 200; i++) {
    const pick = chooseLifeAct(rng, L, snap, newMem(), { group: 'roam' });
    if (pick) assert.equal(pick.picks.length, 1, 'with one place left only a single-person trip fits');
  }
  const full = { ...simFloor().snap(), awayCount: AMB.maxAway };
  assert.equal(chooseLifeAct(rng, L, full, newMem(), { group: 'roam' }), null);
});

test('rules: nothing starts during a meeting, and nobody who is held, walking, in a scene, speaking or gone is chosen', () => {
  const rng = rngFor('meeting');
  const snap = simFloor().snap();
  assert.equal(chooseLifeAct(rng, L, { ...snap, meeting: true }, newMem()), null);
  const none = { ...snap, members: snap.members.map((m) => ({ ...m, free: false })) };
  assert.equal(chooseLifeAct(rng, L, none, newMem()), null);
  const base = { arrived: true, state: 'working' };
  assert.equal(isFree(base), true);
  for (const bad of [{ walk: {} }, { away: true }, { grab: {} }, { press: {} }, { play: {} }, { say: {} }, { busy: true }, { gone: true }, { state: 'done' }, { arrived: false }]) {
    assert.equal(isFree({ ...base, ...bad }), false, JSON.stringify(bad));
  }
  const held = run(simFloor(ROSTER.map((m) => ({ ...m, held: true }))), 5);
  assert.equal(held.length, 0);
  const meeting = run(simFloor(ROSTER, { meeting: true }), 5);
  assert.equal(meeting.length, 0);
});

test('rules: a lean needs a neighbour in reach; a visit goes to a free working desk of someone else; a snack needs a pair spot', () => {
  const rng = rngFor('needs');
  const far = ROSTER.map((m, n) => ({ ...m, x: n * 1000 }));
  const snap = simFloor(far).snap();
  for (let i = 0; i < 300; i++) assert.notEqual(chooseLifeAct(rng, L, snap, newMem())?.kind, 'lean');
  const near = simFloor().snap();
  const kinds = new Set();
  for (let i = 0; i < 600; i++) {
    const pick = chooseLifeAct(rng, L, near, newMem());
    kinds.add(pick?.kind);
    if (pick?.kind === 'visit') {
      assert.notEqual(pick.host, pick.picks[0].id);
      assert.equal(near.members.find((m) => m.id === pick.host).state, 'working');
      assert.equal(pick.picks.length, 1, 'the visitor walks, the worker stays');
    }
    if (pick?.kind === 'snack') {
      assert.equal(pick.picks.length, 2);
      assert.deepEqual(pick.picks.map((p) => p.legs[0].slot), ['at', 'pair']);
    }
  }
  for (const k of ['type', 'sip', 'lean', 'visit', 'snack', 'coffee', 'plant', 'window', 'sofa', 'board', 'shelf']) assert.ok(kinds.has(k), `${k} is chosen sometimes`);
  const noPair = { ...near, spots: SPOTS.filter((s) => !s.pair) };
  for (let i = 0; i < 300; i++) assert.notEqual(chooseLifeAct(rng, L, noPair, newMem())?.kind, 'snack');
});

test('rules: a spot someone is already on is not offered; a trip ends with heads-back for working (and thinking on life trips)', () => {
  const rng = rngFor('taken');
  const snap = simFloor().snap();
  const taken = new Map(SPOTS.filter((s) => s.id !== 'sofa').map((s) => [s.id, 1]));
  for (let i = 0; i < 300; i++) {
    const pick = chooseLifeAct(rng, L, { ...snap, taken }, newMem(), { group: 'roam' });
    if (pick) assert.ok(pick.picks.every((p) => p.legs.every((l) => !l.spotId || l.spotId === 'sofa')), JSON.stringify(pick.picks[0].legs));
  }
  assert.equal(headsBack('working', 'sofa'), true);
  assert.equal(headsBack('working', undefined), true);
  assert.equal(headsBack('thinking', 'sofa'), true);
  assert.equal(headsBack('thinking', undefined), false, "today's thinking trips are not life trips");
  assert.equal(headsBack('idle', 'sofa'), false);
  assert.equal(headsBack('stale', 'sofa'), false);
});

test('rules: ready() applies the character and kind cooldowns; the same seed gives the same choices', () => {
  const mem = newMem();
  assert.equal(ready(mem, L, 'a', 'type', 0), true);
  noteStart(mem, 'a', 'type', 1000);
  assert.equal(ready(mem, L, 'a', 'sip', 1000 + L.charCooldownMs - 1), false);
  assert.equal(ready(mem, L, 'a', 'sip', 1000 + L.charCooldownMs), true);
  assert.equal(ready(mem, L, 'a', 'type', 1000 + L.acts.type.cooldownMs - 1), false);
  assert.equal(ready(mem, L, 'a', 'type', 1000 + L.acts.type.cooldownMs), true);
  const a = run(simFloor(), 10, 'same').map((s) => `${s.t}:${s.pick.kind}`);
  const b = run(simFloor(), 10, 'same').map((s) => `${s.t}:${s.pick.kind}`);
  assert.deepEqual(a, b);
});

test('rules: the director gives a new floor its first delay, retries soon after nothing could start, and sleeps with no floor', () => {
  let t = 0;
  const timers = [];
  const fake = { setTimeout: (fn, ms) => { const h = { at: t + ms, fn }; timers.push(h); return h; }, clearTimeout: (h) => { const i = timers.indexOf(h); if (i >= 0) timers.splice(i, 1); } };
  const ticks = [];
  let can = false;
  let shown = [];
  const d = createDirector({ L, now: () => t, rng: rngFor('d'), timers: fake, floors: () => shown, tick: (id) => { ticks.push([id, t]); return can; } });
  d.start();
  assert.equal(timers.length, 0, 'no floor, no timer');
  shown = ['a'];
  d.kick();
  assert.equal(timers.length, 1);
  assert.ok(timers[0].at >= L.firstDelayMs[0] && timers[0].at <= L.firstDelayMs[1]);
  t = timers[0].at;
  timers.shift().fn();
  assert.equal(ticks.length, 1);
  assert.equal(timers[0].at - t, Math.max(L.minTickMs, L.retryMs), 'nothing started: retry soon');
  can = true;
  t = timers[0].at;
  timers.shift().fn();
  assert.ok(timers[0].at - t >= L.everyMs[0] && timers[0].at - t <= L.everyMs[1], 'something started: the normal gap');
  d.stop();
  assert.equal(timers.length, 0);
});

test('scale: ?debug=ambient shrinks the time ranges, not the animation lengths', () => {
  assert.equal(scaleLife(L, 1), L);
  const s = scaleLife(L, 0.1);
  assert.deepEqual(s.everyMs, L.everyMs.map((n) => n * 0.1));
  assert.equal(s.acts.sip.ms, L.acts.sip.ms);
  assert.deepEqual(s.acts.coffee.stayMs, L.acts.coffee.stayMs.map((n) => n * 0.1));
  assert.equal(s.acts.type.cooldownMs, L.acts.type.cooldownMs * 0.1);
  assert.deepEqual(scaleCat(C, 0.5).napMs, C.napMs.map((n) => n * 0.5));
  assert.equal(scaleCat(C, 1), C);
});

// ---------------------------------------------------------------------------------------------------------------------
// the cat
// ---------------------------------------------------------------------------------------------------------------------

const catState = (over = {}) => ({
  now: 1e6, desks: [{ id: 'w1', x: 10, y: 20, face: 'left', agent: { id: 'w1' } }], spots: SPOTS, taken: new Map(), walkers: [{ id: 'i1', x: 50, y: 60 }],
  point: () => [7, 8], snapPt: (p) => p, visited: new Map(), dashLeft: 0, lastKind: '', ...over,
});

test('cat: visits desks, the window, the sofa and chases; a chase chains dashes; a visited desk rests', () => {
  const rng = rngFor('cat');
  const seen = new Set();
  let own = 0;
  for (let i = 0; i < 400; i++) {
    const p = chooseCatLife(rng, C, catState());
    if (!p) continue;
    own++;
    seen.add(p.kind);
    assert.ok(['visit', 'window', 'nap', 'chase'].includes(p.kind));
    if (p.kind === 'visit') assert.deepEqual([p.act, p.pose, p.deskId], ['desk', 'sit', 'w1']);
    if (p.kind === 'nap') assert.deepEqual([p.act, p.pose, p.spotId], ['sleep', 'sleep', 'sofa']);
    if (p.kind === 'window') assert.ok(C.windowKinds.includes(SPOTS.find((s) => s.id === p.spotId).kind));
  }
  assert.deepEqual([...seen].sort(), ['chase', 'nap', 'visit', 'window']);
  assert.ok(own > 400 * (C.ownChance - 0.1) && own < 400 * (C.ownChance + 0.1), `ownChance ${own}/400`);
  const cool = catState({ visited: new Map([['w1', 1e6 - 1000]]) });
  for (let i = 0; i < 200; i++) assert.notEqual(chooseCatLife(rng, C, cool)?.kind, 'visit');
  const dash = chooseCatLife(rng, C, catState({ dashLeft: 2 }));
  assert.equal(dash.kind, 'chase');
  assert.equal(dash.dashLeft, 1);
  assert.equal(chooseCatLife(rng, C, catState({ dashLeft: 1 })).dashLeft, 0);
  const chased = chooseCatLife(rng, C, catState({ dashLeft: 1, point: () => null, walkers: [] }));
  assert.ok(chased === null || chased.kind !== 'chase', 'a dash with nowhere to go gives up');
});

test('cat: it moves more often than before (ui.cat.moveEveryMs) and visits only working desks, never an empty spot', () => {
  const base = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8')).ui.cat;
  assert.ok(base.moveEveryMs[1] <= 300000 && base.moveEveryMs[0] <= 120000);
  const rng = rngFor('cat2');
  for (let i = 0; i < 100; i++) {
    const p = chooseCatLife(rng, C, catState({ desks: [], walkers: [], point: () => null, spots: [] }));
    assert.equal(p, null);
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// the office side, with a fake office: init(ctx) wired to fake characters
// ---------------------------------------------------------------------------------------------------------------------

function fakeClassList() {
  const set = new Set();
  return { add: (c) => set.add(c), remove: (c) => set.delete(c), toggle: (c, on) => (on ? set.add(c) : set.delete(c)), contains: (c) => set.has(c), [Symbol.iterator]: () => set[Symbol.iterator](), has: (c) => set.has(c) };
}
const fakeNode = () => ({ classList: fakeClassList(), style: { setProperty() {}, removeProperty() {} }, kids: [], append(k) { this.kids.push(k); k.parent = this; }, remove() { this.parent.kids = this.parent.kids.filter((x) => x !== this); } });

/** A fake office: one floor (7 characters), a clock, the fx bus and the trip machinery reduced to what the area reads. */
function fakeOffice(over = {}) {
  const clock = { t: 1e6, timers: [], seq: 0 };
  const timers = {
    setTimeout: (fn, ms) => { const id = ++clock.seq; clock.timers.push({ id, at: clock.t + ms, fn }); return id; },
    clearTimeout: (id) => { clock.timers = clock.timers.filter((x) => x.id !== id); },
  };
  const advance = (ms) => {
    const end = clock.t + ms;
    for (;;) {
      clock.timers.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = clock.timers[0];
      if (!next || next.at > end) break;
      clock.timers.shift();
      clock.t = next.at;
      next.fn();
    }
    clock.t = end;
  };
  const handlers = new Map();
  let fxOn = over.fxOn ?? true;
  const fx = {
    fxOn: () => fxOn,
    onFx: (name, fn, opts) => { (handlers.get(name) ?? handlers.set(name, []).get(name)).push({ fn, always: opts?.always }); return () => {}; },
    onFxChange: () => () => {},
    emit: (name, detail) => { for (const h of handlers.get(name) ?? []) if (h.always || fxOn) h.fn(detail); },
    set: (on) => { fxOn = on; },
  };
  const floor = {
    sid: 'f1', off: false, meeting: null, design: 'd', agents: new Map(), clock: { kick() {} },
    scene: { r: { spots: SPOTS, seats: ROSTER.map((m) => ({ at: [m.x, m.y], visit: [m.x, m.y + 20] })) } },
  };
  const recs = ROSTER.map((m, n) => {
    const rec = {
      el: fakeNode(), body: fakeNode(), tagRoot: fakeNode(), frec: floor, slot: { kind: 'seat', i: n }, isLead: m.isLead, state: m.state, x: m.x, y: m.y,
      arrived: true, walk: null, away: false, trip: null, m: { id: m.id, nextTripAt: Infinity }, sprite: m.id,
    };
    floor.agents.set(m.id, rec);
    return rec;
  });
  const lobbyRec = { sid: 'lobby', agents: new Map() };
  const hooks = { trip: [], fidget: [], cat: [] };
  const lines = [];
  const ctx = {
    ui: { ...cfg.ui, officeLife: L, ambient: { ...AMB } },
    fx, floors: () => [floor, lobbyRec], floor: (id) => (id === 'f1' ? floor : null), lobby: () => lobbyRec,
    chars: () => [...floor.agents.values()], now: () => clock.t, timers,
    floorActive: (f) => !f.off && !over.paused,
    onPauseChange: () => () => {}, paused: () => !!over.paused,
    clearGestures() {}, chatter: (rec, text) => lines.push([rec.m.id, text]), line: (key) => `line:${key}`,
    nav: { grid: () => ({ open: [], cols: 1, cellPx: 8 }), snap: (_d, p) => p },
    life: {
      ambient: AMB, takenSpots: () => new Map(), members: (f) => [...f.agents.values()],
      addTripPicker: (fn) => hooks.trip.push(fn), addFidgetPicker: (fn) => hooks.fidget.push(fn), addCatPicker: (fn) => hooks.cat.push(fn),
    },
  };
  globalThis.location = { search: '' };
  globalThis.window = {};
  globalThis.document = { createElement: () => fakeNode() };
  init(ctx);
  return { clock, advance, fx, floor, recs, hooks, lines, ctx, byId: (id) => floor.agents.get(id) };
}

const lifeClasses = (rec) => [...rec.body.classList].filter((c) => c.startsWith('life-'));
const startedTrip = (o, rec) => o.hooks.trip[0](o.floor, rec);

test('office: working characters get desk gestures only, and the trip picker answers nothing for them', () => {
  const o = fakeOffice();
  const roamers = ['i1', 'i2', 's1'].map(o.byId);
  for (const r of roamers) r.state = 'working'; // everybody works
  o.advance(120000);
  assert.ok(o.recs.some((r) => lifeClasses(r).length || o.lines.length), 'something visible happened');
  for (const r of o.recs) {
    assert.equal(r.away, false);
    assert.equal(r.m.nextTripAt, Infinity, 'no trip was queued for a working character');
    assert.equal(startedTrip(o, r), null);
  }
});

test('office: an idle character gets a life trip with its stop details; at the stop the gesture loops; work ends it at once', () => {
  const o = fakeOffice();
  const rec = o.byId('i1');
  const legs = startedTrip(o, rec);
  assert.ok(legs?.length);
  const leg = legs.at(-1);
  assert.ok(leg.life && (leg.stayMs !== undefined));
  // the office machinery starts the trip and walks; the character arrives
  rec.away = true;
  rec.trip = { legs, i: 0, cur: legs[0] };
  rec.walk = {};
  o.advance(900);
  assert.equal(lifeClasses(rec).length, 0, 'no gesture while it walks');
  rec.walk = null;
  rec.x = legs[0].x;
  rec.y = legs[0].y;
  o.advance(1000);
  if (legs[0].life !== 'pickup') assert.ok(lifeClasses(rec).length >= 1, `a gesture at the stop (${legs[0].life})`);
  // it turns working: the gesture stops now, the office walks it home and the trip record goes
  rec.state = 'working';
  o.fx.emit('state', { rec, from: 'idle', to: 'working' });
  assert.equal(lifeClasses(rec).length, 0);
  rec.away = false;
  rec.trip = null;
  o.advance(2000);
  assert.equal(lifeClasses(rec).length, 0);
});

test('office: thinking ends a life trip too (the office checks it); a stale trip is cleaned and starts nothing while held or in a meeting', () => {
  const o = fakeOffice();
  const rec = o.byId('s1');
  const legs = startedTrip(o, rec);
  assert.ok(legs?.every((l) => l.life), 'every leg of a life trip is named, the office reads this to send it home on thinking');
  const held = o.byId('i2');
  held.grab = {};
  o.floor.meeting = {};
  assert.equal(startedTrip(o, held), null, 'during a meeting no life trip is offered');
  o.floor.meeting = null;
  assert.equal(startedTrip(o, held), null, 'a held character gets no life trip');
  held.grab = null;
});

test('office: meetings, reports, being held or thrown stop a gesture at once', () => {
  const o = fakeOffice();
  for (const [name, detail] of [['lift', (r) => ({ rec: r })], ['drop', (r) => ({ rec: r })], ['thrown', (r) => ({ rec: r })], ['poke', (r) => ({ rec: r })], ['walk-start', (r) => ({ rec: r })],
    ['report', (r) => ({ rec: r, lead: o.byId('lead') })], ['meeting-start', () => ({ floor: o.floor })]]) {
    const rec = o.byId('w1');
    let guard = 0;
    while (!lifeClasses(rec).length && guard++ < 200) o.advance(1000); // wait until w1 does something
    assert.ok(lifeClasses(rec).length, `${name}: a gesture was running`);
    o.fx.emit(name, detail(rec));
    assert.equal(lifeClasses(rec).length, 0, name);
  }
});

test('office: nothing starts while the floor is not shown or the page is hidden, and nothing while a meeting runs', () => {
  const o = fakeOffice({ paused: true });
  o.advance(120000);
  assert.ok(o.recs.every((r) => !lifeClasses(r).length));
  const p = fakeOffice();
  p.floor.off = true;
  p.advance(120000);
  assert.ok(p.recs.every((r) => !lifeClasses(r).length));
  const m = fakeOffice();
  m.floor.meeting = {};
  m.advance(120000);
  assert.ok(m.recs.every((r) => !lifeClasses(r).length));
});

test('office: props (mug, note, zzz) come only with the effects on; the gestures run either way', () => {
  for (const on of [true, false]) {
    const o = fakeOffice({ fxOn: on });
    let props = 0;
    let gestures = 0;
    for (let i = 0; i < 600; i++) {
      o.advance(1000);
      for (const r of o.recs) { props += r.tagRoot.kids.length; gestures += lifeClasses(r).length; }
    }
    assert.ok(gestures > 0, `gestures with fx ${on}`);
    if (on) assert.ok(props > 0, 'props with fx on');
    else assert.equal(props, 0, 'no prop with fx off');
  }
});

test('office: eureka when thinking turns into working, but only after real thinking, for a free character and not twice in a row', () => {
  const o = fakeOffice();
  const rec = o.byId('w3');
  const quick = o.byId('w2');
  o.fx.emit('state', { rec: quick, from: 'working', to: 'thinking' });
  o.advance(2000);
  quick.state = 'working';
  o.fx.emit('state', { rec: quick, from: 'thinking', to: 'working' });
  assert.ok(!lifeClasses(quick).includes('life-eureka'), 'a short think is not a eureka');
  o.fx.emit('state', { rec, from: 'working', to: 'thinking' });
  o.advance(L.acts.eureka.minThinkMs + 1);
  rec.state = 'working';
  o.fx.emit('poke', { rec }); // whatever it was doing ends
  o.fx.emit('state', { rec, from: 'thinking', to: 'working' });
  assert.ok(lifeClasses(rec).includes('life-eureka'));
  o.advance(5000);
  assert.equal(lifeClasses(rec).length, 0 || lifeClasses(rec).filter((c) => c === 'life-eureka').length);
  const again = fakeOffice();
  const r2 = again.byId('w3');
  again.fx.emit('state', { rec: r2, from: 'working', to: 'thinking' });
  again.advance(L.acts.eureka.minThinkMs + 1);
  again.fx.emit('poke', { rec: r2 });
  r2.grab = {};
  again.fx.emit('state', { rec: r2, from: 'thinking', to: 'working' });
  assert.ok(!lifeClasses(r2).includes('life-eureka'), 'not while held');
  const first = fakeOffice();
  const r3 = first.byId('w3');
  first.fx.emit('state', { rec: r3, from: '', to: 'working' });
  assert.equal(lifeClasses(r3).includes('life-eureka'), false, 'a first sight is not a thought finishing');
});

test('office: the plain fidget is skipped over a life gesture, and the cat picker returns the cat shape', () => {
  const o = fakeOffice();
  const rec = o.byId('w1');
  assert.equal(o.hooks.fidget[0](o.floor, rec), false);
  let guard = 0;
  while (!lifeClasses(rec).length && guard++ < 200) o.advance(1000);
  assert.equal(o.hooks.fidget[0](o.floor, rec), true);
  const cat = { leaveAt: Infinity };
  let own = 0;
  for (let i = 0; i < 40; i++) {
    const p = o.hooks.cat[0]({ cat, floor: o.floor });
    if (p) own++;
  }
  assert.ok(own > 10);
});

// ---------------------------------------------------------------------------------------------------------------------
// config and style
// ---------------------------------------------------------------------------------------------------------------------

test('config: every act has its animation in the style sheet and its lines in ui.lines (Korean), every number is in the config', () => {
  const keyframes = new Set([...css.matchAll(/@keyframes (life-[\w-]+)/g)].map((m) => m[1]));
  for (const [kind, def] of Object.entries(L.acts)) {
    if (def.anim) {
      assert.ok(keyframes.has(`life-${def.anim}`), `${kind}: @keyframes life-${def.anim}`);
      assert.match(css, new RegExp(`\\.body\\.life-${def.anim}\\b`), `${kind}: .body.life-${def.anim}`);
    }
    for (const key of [def.line, def.bringLine, def.replyLine].filter(Boolean)) {
      const lines = cfg.ui.lines[key];
      assert.ok(Array.isArray(lines) && lines.length >= 4, `${kind}: ui.lines.${key}`);
      for (const text of lines) assert.match(text, /[가-힣]/, `${key}: ${text}`);
    }
    if (def.prop) assert.match(css, new RegExp(`\\.life-p-${def.prop}\\b`), `${kind}: prop ${def.prop}`);
    assert.ok(def.cooldownMs > 0 && ['desk', 'roam', 'event'].includes(def.group), kind);
  }
  assert.ok(L.everyMs[0] >= 5000 && L.everyMs[1] <= 10000, 'a start every 5-10 s');
  const text = readFileSync(join(ROOT, 'config.json'), 'utf8');
  assert.ok(text.indexOf('"idleMutter": [') < text.indexOf('"lifeSip": ['), 'the new lines come right after idleMutter');
  assert.ok(text.indexOf('"lifeThanks": [') < text.indexOf('"catPet1": ['));
});

test('style: only transform and opacity are animated, no new image files, paused with the page, off under reduced motion', () => {
  const frames = [];
  for (const m of css.matchAll(/@keyframes [\w-]+ \{/g)) {
    let depth = 1;
    let i = m.index + m[0].length;
    const from = i;
    while (depth && i < css.length) {
      depth += css[i] === '{' ? 1 : css[i] === '}' ? -1 : 0;
      i++;
    }
    frames.push(css.slice(from, i - 1));
  }
  assert.ok(frames.length >= 19);
  for (const body of frames) {
    const props = [...body.matchAll(/([\w-]+)\s*:/g)].map((m) => m[1]);
    for (const p of props) assert.ok(['transform', 'opacity'].includes(p), `keyframes animate ${p}`);
  }
  assert.ok(!/url\(/.test(css), 'no raster image');
  assert.ok(!/@keyframes[^{]*\{[^}]*(filter|box-shadow|text-shadow|left:|top:|width:|height:|margin|padding|background-position|clip-path)/.test(css));
  assert.match(css, /body\.paused/);
  assert.match(css, /prefers-reduced-motion: reduce\) \{[^}]*animation: none/);
});

test('wiring: app.mjs reads a leg\'s own stay and ends life trips on thinking; the lines are all used', () => {
  const app = readFileSync(join(ROOT, 'web', 'app.mjs'), 'utf8');
  assert.match(app, /const stay = leg\.stayMs \?\? amb\.stayMs;/);
  assert.match(app, /av\.state === 'thinking' && rec\.trip\?\.legs\.some\(\(l\) => l\.life\)/);
  const src = readFileSync(join(ROOT, 'web', 'officelife.mjs'), 'utf8');
  for (const key of Object.keys(cfg.ui.lines).filter((k) => k.startsWith('life'))) {
    assert.ok(JSON.stringify(L).includes(`"${key}"`) || src.includes(`'${key}'`), `ui.lines.${key} is used`);
  }
});
