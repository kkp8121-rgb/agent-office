import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { arrivalSteps, cutWalk, diffFloors, doorBox, leaveSteps, planCar } from '../web/commute.mjs';
import { readPng } from './helpers/png-read.mjs';
import { resolveScene } from '../web/scene.mjs';
import { bakeGrid, isOpen } from '../web/nav.mjs';

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

// ---- the door cover fits the door drawn in each room picture ----
// DRAWN = the door frame as it is painted in assets/scenes/<design>/shell.png, in scene px, clockwise from the top left (measured on the picture with a 10px grid, +-2px).
// The doors of studio2, lounge and library are parallelograms (the wall they are in runs at an angle); greenhouse has no door, its "door" is the gap between the
// two railing posts, whose floor edge is the white lip at y 514. `over` is how far the cover may reach past the frame (px): the cover has to hide the door and not much else.
const DRAWN = {
  studio2: { frame: [[936, 214], [976, 240], [976, 337], [936, 310]], over: { top: 6, side: 6, bottom: 3 } },
  lounge: { frame: [[802, 418], [854, 391], [854, 474], [802, 496]], over: { top: 6, side: 6, bottom: 3 } },
  library: { frame: [[914, 300], [970, 322], [970, 434], [914, 409]], over: { top: 6, side: 6, bottom: 3 } },
  greenhouse: { frame: [[454, 468], [569, 468], [569, 514], [454, 514]], over: { top: 60, side: 2, bottom: 3 } },
};
const pic = readPng(`${ROOT}assets/props/elev-door-closed.png`);
const SLACK = 1.5; // the frame may not be missed by more than this (the painted frame has a dark outline)
const line = (a, b, x) => a[1] + ((b[1] - a[1]) * (x - a[0])) / (b[0] - a[0]); // y of the line a-b at x (a.x != b.x)
const spawnOf = (design, scene) => C.door[design]?.at ?? scene.door.at; // where the lead appears (and the others vanish) at the door
for (const design of cfg.designOrder) {
  test(`the lift door cover of ${design} sits on its door and inside the scene`, () => {
    const scene = JSON.parse(readFileSync(`${ROOT}assets/scenes/${design}/scene.json`, 'utf8'));
    const d = C.door[design];
    assert.ok(d && typeof d === 'object', 'a value, not null');
    const box = doorBox(scene.door.at, { w: pic.w, h: pic.h }, d);
    assert.equal(box.w, pic.w * d.scale);
    assert.equal(box.h, pic.h * (d.scaleY ?? d.scale));
    const [tl, tr, br, bl] = box.corners;
    const [w, h] = scene.size;
    assert.ok(box.corners.every(([x, y]) => x >= 0 && y >= 0 && x <= w && y <= h), 'the cover is inside the scene');
    const { frame, over } = DRAWN[design];
    assert.ok(frame, `no drawn door frame measured for ${design}`);
    const [ftl, ftr, fbr, fbl] = frame;
    const topAt = (x) => line(tl, tr, x);
    const bottomAt = (x) => line(bl, br, x);
    // 1 the cover hides the drawn door: every corner of the frame is inside the cover
    for (const [x, y] of frame) {
      assert.ok(x >= tl[0] - SLACK && x <= tr[0] + SLACK, `frame corner ${x},${y}: outside the cover across (cover ${tl[0].toFixed(1)}..${tr[0].toFixed(1)})`);
      assert.ok(y >= topAt(x) - SLACK, `frame corner ${x},${y}: above the cover's top edge (${topAt(x).toFixed(1)})`);
      assert.ok(y <= bottomAt(x) + SLACK, `frame corner ${x},${y}: below the cover's bottom edge (${bottomAt(x).toFixed(1)})`);
    }
    // 2 it hides little else
    assert.ok(ftl[0] - tl[0] <= over.side, `the cover reaches ${(ftl[0] - tl[0]).toFixed(1)}px past the frame on the left`);
    assert.ok(tr[0] - ftr[0] <= over.side, `the cover reaches ${(tr[0] - ftr[0]).toFixed(1)}px past the frame on the right`);
    assert.ok(line(ftl, ftr, ftl[0]) - topAt(ftl[0]) <= over.top && line(ftl, ftr, ftr[0]) - topAt(ftr[0]) <= over.top, 'the cover reaches too far above the frame');
    // 3 the floor line goes on under it: the cover stops where the door's foot is, not lower
    for (const x of [ftl[0], ftr[0]]) {
      const drop = bottomAt(x) - line(fbl, fbr, x);
      assert.ok(drop <= over.bottom, `the cover comes down ${drop.toFixed(1)}px below the door's foot at x ${x}`);
    }
    // 4 the lead appears inside it, on floor the staff can walk on
    const at = spawnOf(design, scene);
    assert.ok(at[0] >= tl[0] && at[0] <= tr[0], `the spawn x ${at[0]} is outside the cover ${tl[0].toFixed(1)}..${tr[0].toFixed(1)}`);
    assert.ok(at[1] >= topAt(at[0]) && at[1] <= bottomAt(at[0]) + cfg.nav.arrivalGapPx, `the spawn y ${at[1]} is not at the cover (${topAt(at[0]).toFixed(1)}..${bottomAt(at[0]).toFixed(1)})`);
    assert.ok(isOpen(bakeGrid(resolveScene(scene), cfg.nav), at), `the spawn ${at} is not open floor`);
  });
}
