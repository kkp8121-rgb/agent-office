import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rngFor, between, tripRange, chooseSpot, chooseFidget, createFloorClock } from '../web/ambient.mjs';
import { cfg } from './helpers/fixture.mjs';

const AMB = cfg.ui.ambient;

/** A fake clock: timers are stored and only run when the test fires them. */
function fakeTime(start = 100000) {
  let t = start;
  const timers = new Map();
  let seq = 0;
  return {
    now: () => t,
    advance: (ms) => { t += ms; },
    timers: { setTimeout: (fn, ms) => { timers.set(++seq, { fn, ms }); return seq; }, clearTimeout: (id) => { timers.delete(id); } },
    pending: () => [...timers.values()],
    fire: () => { const [[id, tm]] = [...timers]; timers.delete(id); tm.fn(); },
  };
}
const member = (o = {}) => ({ id: 'm', nextFidgetAt: Infinity, nextTripAt: Infinity, returnAt: 0, ...o });

test('ambient: same seed same rhythm, different seeds differ', () => {
  const take = (seed) => { const r = rngFor(seed); return Array.from({ length: 5 }, r); };
  assert.deepEqual(take('a1'), take('a1'));
  assert.notDeepEqual(take('a1'), take('a2'));
  assert.ok(take('a1').every((v) => v >= 0 && v < 1));
  const r = rngFor('x');
  for (let i = 0; i < 200; i++) { const v = between(r, [10, 20]); assert.ok(v >= 10 && v < 20); }
});

test('ambient: trip range by state', () => {
  const who = (state, extra = {}) => ({ isLead: false, state, floorStatus: 'busy', ...extra });
  const w = tripRange(AMB, who('working'));
  const t = tripRange(AMB, who('thinking'));
  assert.ok(w[0] > t[1], 'working trips are rarer than thinking trips');
  assert.deepEqual(tripRange(AMB, who('enter')), AMB.tripEveryMs.idle);
  assert.deepEqual(tripRange(AMB, who('stale')), AMB.tripEveryMs.stale);
  assert.equal(tripRange(AMB, who('done')), null);
  assert.deepEqual(tripRange(AMB, who('idle', { isLead: true, floorStatus: 'waiting' })), AMB.leadTourEveryMs);
  assert.equal(tripRange(AMB, who('idle', { isLead: true, floorStatus: 'busy' })), null);
});

test('ambient: one timer per floor', () => {
  const ft = fakeTime();
  const ms = Array.from({ length: 20 }, (_, i) => member({ id: `m${i}`, nextFidgetAt: ft.now() + 5000 + i * 1000, nextTripAt: ft.now() + 60000 }));
  const clock = createFloorClock({ amb: AMB, now: ft.now, timers: ft.timers, members: () => ms, act: {}, awayCount: () => 0 });
  clock.start();
  assert.equal(ft.pending().length, 1);
  clock.kick();
  clock.kick();
  assert.equal(ft.pending().length, 1);
  clock.stop();
  assert.equal(ft.pending().length, 0);
});

test('ambient: tick fires only due members and reschedules to the earliest', () => {
  const ft = fakeTime();
  const ms = [member({ id: 'a', nextFidgetAt: ft.now() + 4000 }), member({ id: 'b', nextFidgetAt: ft.now() + 9000 }), member({ id: 'c', nextFidgetAt: ft.now() + 30000 })];
  const fired = [];
  const act = {
    fidget: (m) => { fired.push(m.id); m.nextFidgetAt = ft.now() + 50000; },
    trip: () => assert.fail('no trip is due'),
    tripEnd: () => assert.fail('nobody is away'),
  };
  const clock = createFloorClock({ amb: AMB, now: ft.now, timers: ft.timers, members: () => ms, act, awayCount: () => 0 });
  clock.start();
  assert.equal(ft.pending()[0].ms, 4000);
  ft.advance(4000);
  ft.fire();
  assert.deepEqual(fired, ['a']);
  assert.equal(ft.pending().length, 1);
  assert.equal(ft.pending()[0].ms, 5000, 'b is next, 5s away');
  ms[1].nextFidgetAt = ft.now() + 10; // a very near time still waits tickMinMs
  clock.kick();
  assert.equal(ft.pending()[0].ms, AMB.tickMinMs);
});

test('ambient: maxAway caps concurrent trips', () => {
  const ft = fakeTime();
  const m = member({ nextTripAt: ft.now() - 1 });
  let trips = 0;
  const act = { fidget() {}, trip: () => { trips++; }, tripEnd() {} };
  const capped = createFloorClock({ amb: AMB, now: ft.now, timers: ft.timers, members: () => [m], act, awayCount: () => 2 });
  capped.start();
  assert.equal(ft.pending().length, 0, 'a capped, due trip does not keep a timer awake');
  assert.equal(trips, 0);
  const free = createFloorClock({
    amb: AMB, now: ft.now, timers: ft.timers, members: () => [m], awayCount: () => 1,
    act: { ...act, trip: (x) => { trips++; x.nextTripAt = Infinity; } },
  });
  free.start();
  ft.fire();
  assert.equal(trips, 1, 'with room again the trip runs on the next wake');
});

test('ambient: a trip step runs when returnAt comes', () => {
  const ft = fakeTime();
  const m = member({ returnAt: ft.now() + 7000 });
  const ended = [];
  const act = { fidget() {}, trip() {}, tripEnd: (x) => { ended.push(x.id); x.returnAt = 0; } };
  const clock = createFloorClock({ amb: AMB, now: ft.now, timers: ft.timers, members: () => [m], act, awayCount: () => 1 });
  clock.start();
  assert.equal(ft.pending()[0].ms, 7000);
  ft.advance(7000);
  ft.fire();
  assert.deepEqual(ended, ['m']);
});

test('ambient: spot taken by one offers pair only by chance', () => {
  const spots = [{ id: 'coffee', pair: [1, 1] }, { id: 'window', pair: null }, { id: 'plant', pair: null }];
  const seq = (...v) => { let i = 0; return () => v[i++ % v.length]; };
  const taken = new Map([['coffee', 1]]);
  assert.deepEqual(chooseSpot(seq(0.1), spots, taken, 0.5), { spot: spots[0], slot: 'pair' });
  const other = chooseSpot(seq(0.9, 0), spots, taken, 0.5);
  assert.equal(other.slot, 'at');
  assert.notEqual(other.spot.id, 'coffee');
  assert.equal(chooseSpot(seq(0), [spots[1]], new Map([['window', 1]]), 1), null, 'a spot without a pair point is out once one person stands there');
  assert.equal(chooseSpot(seq(0.9), [spots[0]], new Map([['coffee', 2]]), 1), null, 'two people fill a pair spot');
  assert.equal(chooseSpot(seq(0.2), spots, new Map(), 1).slot, 'at');
});

test('ambient: seated fidget never hops', () => {
  const r = rngFor('seat');
  const seen = new Set();
  for (let i = 0; i < 1000; i++) seen.add(chooseFidget(r, true, AMB));
  assert.ok(!seen.has('hop'));
  assert.deepEqual([...seen].sort(), [...AMB.fidgets.seated].sort());
  const standing = new Set();
  for (let i = 0; i < 1000; i++) standing.add(chooseFidget(r, false, AMB));
  assert.ok(standing.has('hop'));
});

test('ambient: disabled does nothing', () => {
  const ft = fakeTime();
  const clock = createFloorClock({ amb: { ...AMB, enabled: false }, now: ft.now, timers: ft.timers, members: () => [member({ nextFidgetAt: ft.now() + 10 })], act: {}, awayCount: () => 0 });
  clock.start();
  clock.kick();
  assert.equal(ft.pending().length, 0);
});
