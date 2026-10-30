import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { chooseCatAct, openPoint, otherFloor } from '../web/cat.mjs';
import { legVars } from '../web/walk.mjs';
import { rngFor } from '../web/ambient.mjs';
import { cfg } from './helpers/fixture.mjs';

const C = cfg.ui.cat;
const W = cfg.ui.walk;
const SPOTS = [
  { id: 'sofa', kind: 'sofa', at: [10, 20], face: 'left', pair: null },
  { id: 'window', kind: 'window', at: [30, 40], face: 'right', pair: null },
  { id: 'board', kind: 'whiteboard', at: [50, 60], face: 'right', pair: null },
];
const DESK = { x: 70, y: 80, face: 'left', agent: { id: 'a' } };
const ctx = (over = {}) => ({ cat: C, spots: SPOTS, taken: new Map(), desks: [DESK], point: () => [5, 6], leaveDue: false, force: '', ...over });

test('cat: a random walkable point is the centre of an open cell; none when nothing is open', () => {
  const grid = { cols: 4, rows: 2, cellPx: 8, open: [0, 0, 0, 0, 0, 1, 0, 0] };
  assert.deepEqual(openPoint(rngFor('p'), grid), [12, 12]);
  assert.equal(openPoint(rngFor('p'), { ...grid, open: new Array(8).fill(0) }), null);
});

test('cat: the next floor is another one, or null when there is none', () => {
  const rng = rngFor('floors');
  for (let i = 0; i < 50; i++) assert.notEqual(otherFloor(rng, ['a', 'b', 'c'], 'b'), 'b');
  assert.equal(otherFloor(rng, ['a'], 'a'), null);
  assert.equal(otherFloor(rng, [], 'a'), null);
  assert.equal(otherFloor(rng, ['a', 'b'], 'zzz') !== null, true);
});

test('cat: acts come only from what the floor offers, with the right pose and stay', () => {
  const rng = rngFor('acts');
  const seen = new Set();
  for (let i = 0; i < 300; i++) {
    const a = chooseCatAct(rng, ctx());
    seen.add(a.act);
    if (a.act === 'sleep') assert.deepEqual([a.spotId, a.pose, a.x, a.y], ['sofa', 'sleep', 10, 20]);
    if (a.act === 'spot') assert.deepEqual([a.spotId, a.pose], ['window', 'sit']); // never the whiteboard
    if (a.act === 'desk') assert.deepEqual([a.x, a.y, a.face, a.pose, a.desk], [70, 80, 'left', 'sit', DESK]);
    if (a.act === 'stroll') assert.deepEqual([a.x, a.y, a.pose], [5, 6, 'stand']);
    const range = { sleep: C.sleepMs, spot: C.sitMs, desk: C.deskMs, stroll: C.pauseMs }[a.act];
    assert.ok(a.ms >= range[0] && a.ms < range[1], `${a.act} ${a.ms}`);
  }
  assert.deepEqual([...seen].sort(), ['desk', 'sleep', 'spot', 'stroll']);
});

test('cat: taken spots are not offered; nothing possible gives null; force limits the choice', () => {
  const rng = rngFor('taken');
  const taken = new Map([['sofa', 1], ['window', 1]]);
  for (let i = 0; i < 100; i++) assert.ok(['desk', 'stroll'].includes(chooseCatAct(rng, ctx({ taken })).act));
  assert.equal(chooseCatAct(rng, ctx({ taken, desks: [], point: () => null })), null);
  for (let i = 0; i < 30; i++) assert.equal(chooseCatAct(rng, ctx({ force: 'sleep' })).act, 'sleep');
  assert.equal(chooseCatAct(rng, ctx({ force: 'sleep', taken })), null); // forced but impossible
});

test('cat: weights decide how often, and a due move overrides everything', () => {
  const rng = rngFor('weights');
  const only = { ...C, weights: { stroll: 1, desk: 0, sleep: 0, spot: 0 } };
  for (let i = 0; i < 50; i++) assert.equal(chooseCatAct(rng, ctx({ cat: only })).act, 'stroll');
  assert.deepEqual(chooseCatAct(rng, ctx({ leaveDue: true })), { act: 'leave' });
});

test('walk: the leg lines come from the table, unknown sprites use the default', () => {
  assert.deepEqual(legVars(W, 'worker'), { hip: `${W.hips.worker[0]}%`, sp: `${W.hips.worker[1]}%` });
  assert.deepEqual(legVars(W, 'some-future-sprite'), { hip: `${W.hipDefault[0]}%`, sp: `${W.hipDefault[1]}%` });
});

test('walk: every shipped character sprite has its leg lines, below the middle and near the centre; hip lines sit on pixel rows', () => {
  const dir = new URL('../assets/sprites/', import.meta.url);
  const keys = readdirSync(dir).filter((f) => f.endsWith('.png') && !f.endsWith('-sit.png') && !f.startsWith('cat-')).map((f) => f.slice(0, -4));
  assert.ok(keys.length >= 22);
  for (const k of keys) {
    assert.ok(W.hips[k], `${k} has no leg lines`);
    const [hip, split] = W.hips[k];
    assert.ok(hip >= 60 && hip <= 90, `${k} hip ${hip}`);
    assert.ok(split >= 35 && split <= 65, `${k} split ${split}`);
    assert.ok(Math.abs((hip * 64) / 100 - Math.round((hip * 64) / 100)) < 1e-6, `${k} hip is not on a pixel row`);
  }
  for (const k of Object.keys(W.hips)) assert.ok(keys.includes(k), `${k} has leg lines but no sprite`);
});
