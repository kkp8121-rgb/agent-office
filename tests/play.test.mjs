import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextPoke, pickLine, daypart, throwVelocity, openBox, throwPath, playPartner } from '../web/play.mjs';
import { rngFor } from '../web/ambient.mjs';
import { cfg } from './helpers/fixture.mjs';

const { poke: P, throw: T, play: PL, lines: L } = cfg.ui;

test('poke: quick clicks escalate to the cap, a pause starts over', () => {
  let s = null;
  const levels = [];
  for (let i = 0; i < 6; i++) {
    s = nextPoke(s, i * (P.resetMs - 100), P);
    levels.push(s.level);
  }
  assert.deepEqual(levels, [1, 2, 3, 4, 4, 4]);
  assert.equal(nextPoke(s, s.at + P.resetMs + 1, P).level, 1);
  assert.equal(nextPoke(s, s.at + P.resetMs, P).level, 4); // exactly on the edge still counts
});

test('lines: never the previous line, every line of a pool shows up', () => {
  const pool = L.smallTalk;
  const rng = rngFor('lines');
  let last;
  const seen = new Set();
  for (let i = 0; i < 400; i++) {
    const line = pickLine(rng, pool, last);
    assert.notEqual(line, last);
    assert.ok(pool.includes(line));
    seen.add(line);
    last = line;
  }
  assert.equal(seen.size, pool.length);
  assert.equal(pickLine(rng, ['하나'], '하나'), '하나');
  assert.equal(pickLine(rng, [], undefined), '');
  assert.ok(pool.includes(pickLine(rng, pool, '목록에 없는 줄')));
});

test('lines: every situation has at least 8 distinct lines that fit a bubble; day parts have a greeting pool', () => {
  for (const [name, pool] of Object.entries(L)) {
    assert.ok(pool.length >= 8, `${name} has ${pool.length}`);
    assert.equal(new Set(pool).size, pool.length, `${name} repeats a line`);
    const max = name === 'report' ? 26 : 16;
    for (const line of pool) assert.ok([...line].length <= max, `${name}: ${line}`);
  }
  for (const line of L.report) assert.ok(line.includes('{task}'), line);
  for (const h of [0, 4, 5, 10, 11, 16, 17, 21, 22, 23]) assert.ok(L[`greeting${daypart(h)}`], String(h));
  assert.deepEqual([4, 5, 10, 11, 16, 17, 21, 22].map(daypart), ['Night', 'Morning', 'Morning', 'Day', 'Day', 'Evening', 'Evening', 'Night']);
});

test('throw: velocity from the last samples; slow, stale or one-sample releases are not throws', () => {
  const fast = [{ t: 0, x: 0, y: 0 }, { t: 40, x: 40, y: 0 }, { t: 80, x: 100, y: 0 }];
  const v = throwVelocity(fast, 90, T);
  assert.ok(v.vx > 1000 && Math.abs(v.vy) < 1e-9);
  assert.equal(throwVelocity(fast, 80 + T.staleMs + 1, T), null); // the pointer rested before release
  assert.equal(throwVelocity([{ t: 0, x: 0, y: 0 }], 10, T), null);
  assert.equal(throwVelocity([], 10, T), null);
  const slow = [{ t: 0, x: 0, y: 0 }, { t: 100, x: 20, y: 0 }];
  assert.equal(throwVelocity(slow, 105, T), null);
  const old = [{ t: 0, x: 0, y: 0 }, { t: 300, x: 500, y: 0 }, { t: 340, x: 502, y: 0 }]; // only the last window counts
  assert.equal(throwVelocity(old, 345, T), null);
});

const BOX = { x0: 20, y0: 40, x1: 420, y1: 240 };
const FAST = (vx, vy) => ({ vx, vy, speed: Math.hypot(vx, vy) });

test('throw: openBox is the bounds of the open cells', () => {
  const grid = { cols: 6, rows: 4, cellPx: 8, open: [0,0,0,0,0,0, 0,1,1,0,0,0, 0,0,1,1,0,0, 0,0,0,0,0,0] };
  assert.deepEqual(openBox(grid), { x0: 8, y0: 8, x1: 32, y1: 24 });
  assert.equal(openBox({ ...grid, open: new Array(24).fill(0) }), null);
});

test('throw: the path stays in the box, reflects off a wall, ends where the distance runs out', () => {
  // toward the right wall from 40px away: hits it, comes back left
  const r = throwPath([380, 100], FAST(2000, 0), BOX, T);
  assert.equal(r.pts[0][0], 380);
  assert.deepEqual(r.pts[1], [420, 100]); // the wall
  assert.ok(r.pts[2][0] < 420 && r.pts[2][1] === 100, 'came back');
  assert.ok(r.bounces >= 1);
  for (const [x, y] of r.pts) assert.ok(x >= BOX.x0 && x <= BOX.x1 && y >= BOX.y0 && y <= BOX.y1);
  assert.equal(r.offsets[0], 0);
  assert.ok(Math.abs(r.offsets.at(-1) - 1) < 1e-9);
  assert.ok(r.ms >= T.minFlyMs);
  // a hit that clips a corner reflects both axes; a diagonal throw in a corner stays inside
  const c = throwPath([410, 230], FAST(1500, 1500), BOX, T);
  for (const [x, y] of c.pts) assert.ok(x >= BOX.x0 && x <= BOX.x1 && y >= BOX.y0 && y <= BOX.y1);
  assert.ok(c.bounces <= T.maxBounces);
});

test('throw: distance follows speed within min and max, a start outside the box is pulled in, no bounce in open space', () => {
  const short = throwPath([60, 140], FAST(T.minSpeedPxS, 0), BOX, T);
  const long = throwPath([60, 140], FAST(9000, 0), BOX, T);
  const len = (r) => r.pts.reduce((a, p, i) => (i ? a + Math.hypot(p[0] - r.pts[i - 1][0], p[1] - r.pts[i - 1][1]) : 0), 0);
  assert.equal(short.bounces, 0);
  assert.ok(len(short) >= T.minDistPx - 1e-6 && len(short) <= T.distPerSpeed * T.minSpeedPxS + T.minDistPx);
  assert.ok(len(long) <= T.maxDistPx + 1e-6);
  const out = throwPath([-50, 900], FAST(0, 1000), BOX, T);
  assert.deepEqual(out.pts[0], [20, 240]);
  for (const [x, y] of out.pts) assert.ok(x >= BOX.x0 && x <= BOX.x1 && y >= BOX.y0 && y <= BOX.y1);
});

const W = (id, x, y, isLead = false) => ({ id, isLead, x, y });
const R = { report: PL.reportRadiusPx, highFive: PL.highFiveRadiusPx };

test('play: a dropped worker near the boss reports, near a worker high-fives, boss near a worker gets a line', () => {
  const boss = W('lead', 100, 100, true);
  const a = W('a', 400, 400);
  const b = W('b', 140, 100);
  const me = W('me', 0, 0);
  assert.deepEqual(playPartner(me, [105, 100], [boss, a, b], R)?.kind, 'report'); // boss and b both near: the boss wins
  assert.equal(playPartner(me, [105, 100], [boss, a, b], R).other.id, 'lead');
  assert.equal(playPartner(me, [140, 120], [boss, a, b], { report: 10, highFive: 40 })?.kind, 'highFive');
  assert.equal(playPartner(me, [300, 300], [boss, a, b], R), null);
  assert.equal(playPartner(me, [400 + R.highFive + 1, 400], [a], R), null);
  assert.equal(playPartner(me, [400 + R.highFive, 400], [a], R)?.other.id, 'a');
  // the nearest of two workers
  assert.equal(playPartner(me, [500, 500], [W('c', 510, 500), W('d', 530, 500)], R).other.id, 'c');
  // never itself
  assert.equal(playPartner(me, [0, 0], [me], R), null);
  const lead = W('lead', 0, 0, true);
  assert.equal(playPartner(lead, [130, 100], [lead, b], R)?.kind, 'bossLine');
  assert.equal(playPartner(lead, [130 + R.report, 100], [lead, b], R)?.kind, 'bossLine');
  assert.equal(playPartner(lead, [400, 100], [lead, b], R), null);
});
