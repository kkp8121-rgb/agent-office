import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { arrivalSteps, cutWalk, diffFloors, doorBox, leaveSteps, planCar } from '../web/commute.mjs';
import { readPng } from './helpers/png-read.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const cfg = JSON.parse(readFileSync(`${ROOT}config.json`, 'utf8'));
const C = cfg.ui.commute;
const B = cfg.ui.building;
const floor = (sessionId, status = 'busy') => ({ sessionId, status });

test('the first draw plays nothing: floors that are already there neither arrive nor leave', () => {
  const d = diffFloors(null, [floor('a'), floor('b', 'leaving')]);
  assert.deepEqual(d.arrivals, []);
  assert.deepEqual(d.leavings, []);
  assert.deepEqual(d.veilNow, ['b']); // an already finished floor is dark at once, without a show
  assert.equal(d.next.get('a'), 'busy');
});

test('a new floor arrives in the order panel, door, walk, close', () => {
  const d = diffFloors(new Map([['a', 'busy']]), [floor('a'), floor('n')]);
  assert.deepEqual(d.arrivals, ['n']);
  const steps = arrivalSteps(C, true);
  assert.deepEqual(steps.map((s) => s.step), ['panel', 'open', 'walk', 'close']);
  assert.ok(steps.every((s, i) => i === 0 || s.atMs > steps[i - 1].atMs), 'strictly in time order');
  assert.equal(steps[1].atMs, C.walkInDelayMs);
  assert.equal(steps[2].atMs - steps[1].atMs, C.doorOpenMs);
  assert.deepEqual(arrivalSteps(C, false), [{ step: 'walk', atMs: 0 }]); // no door cover for this design: only the walk
});

test('a leaving floor leaves one after another and ends within leaveBudgetMs', () => {
  const d = diffFloors(new Map([['a', 'busy']]), [floor('a', 'leaving')]);
  assert.deepEqual(d.leavings, ['a']);
  for (const count of [1, 3, 8, 30]) {
    const plan = leaveSteps(count, C, { fx: true, night: false });
    assert.equal(plan.people.length, count);
    assert.equal(plan.veil.fadeMs, C.offFadeMs);
    assert.equal(plan.veil.dim, C.offDim);
    plan.people.forEach((p, i) => {
      assert.ok(p.startMs + p.maxWalkMs <= C.leaveBudgetMs, `person ${i} ends within the budget`);
      if (i) assert.ok(p.startMs >= plan.people[i - 1].startMs);
    });
    assert.ok(plan.endMs <= C.leaveBudgetMs && C.leaveBudgetMs < cfg.floor.leaveMs);
  }
  assert.equal(leaveSteps(2, C, { fx: true, night: true }).veil.dim, C.offDimNight); // the picture is already dark at night
  assert.equal(cutWalk(5000, 1200), 1200);
  assert.equal(cutWalk(800, 1200), 800);
  assert.equal(cutWalk(800, -5), 0);
});

test('with the effects off only the veil is left: no walkers, no fade', () => {
  const plan = leaveSteps(5, C, { fx: false, night: false });
  assert.deepEqual(plan.people, []);
  assert.equal(plan.veil.fadeMs, 0);
  assert.equal(plan.veil.dim, C.offDim);
  assert.equal(plan.endMs, 0);
});

test('the car move time is distance over speed, cut to carMinMs and carMaxMs', () => {
  const at = (dist) => planCar({ y: 0 }, [{ id: 'f', y: dist }], B).move;
  assert.equal(at(10).ms, B.carMinMs); // a short hop is not instant
  assert.equal(at(99999).ms, B.carMaxMs); // a long ride is cut
  const mid = Math.round(((B.carMinMs + B.carMaxMs) / 2 / 1000) * B.carPxPerSec);
  assert.ok(Math.abs(at(mid).ms - (mid / B.carPxPerSec) * 1000) < 1e-6);
  assert.equal(planCar({ y: 40 }, [{ id: 'f', y: 40 }], B).move.ms, 0); // already there
  assert.deepEqual(planCar({ y: 0 }, [], B), { move: null, skipped: [] });
});

test('two requests during a move: only the nearest is served, the other is skipped (no queue)', () => {
  const plan = planCar({ y: 100 }, [{ id: 'far', y: 900 }, { id: 'near', y: 160 }], B);
  assert.equal(plan.move.id, 'near');
  assert.deepEqual(plan.skipped, ['far']);
  assert.equal(plan.move.from, 100);
  assert.equal(plan.move.to, 160);
  const tie = planCar({ y: 0 }, [{ id: 'first', y: -50 }, { id: 'second', y: 50 }], B);
  assert.equal(tie.move.id, 'first'); // the earlier request wins a tie
});

// ---- the door cover fits the door of each room (picture size x scale, bottom middle near door.at, box inside the scene) ----
const pic = readPng(`${ROOT}assets/props/elev-door-closed.png`);
for (const design of cfg.designOrder) {
  test(`the lift door cover of ${design} sits on its door and inside the scene`, () => {
    const scene = JSON.parse(readFileSync(`${ROOT}assets/scenes/${design}/scene.json`, 'utf8'));
    const d = C.door[design];
    assert.ok(d && typeof d === 'object', 'a value, not null');
    const box = doorBox(scene.door.at, { w: pic.w, h: pic.h }, d);
    assert.equal(box.w, pic.w * d.scale);
    assert.equal(box.h, pic.h * d.scale);
    const [fx, fy] = box.foot;
    const dist = Math.hypot(fx - scene.door.at[0], fy - scene.door.at[1]);
    assert.ok(dist <= 12, `bottom middle is ${dist.toFixed(1)}px from door.at`);
    const [w, h] = scene.size;
    assert.ok(box.left >= 0 && box.top >= 0 && box.left + box.w <= w && box.top + box.h <= h, 'the box is inside the scene');
  });
}
