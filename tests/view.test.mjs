import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { orderFloors, nextFloor, fallbackFloor, fitBox, fitColumns, pruneEvents, activityScore, busiestFloor, chooseFollow } from '../web/view.mjs';

test('view: orderFloors sorts by floor number', () => {
  const views = [{ sessionId: 'c', floorNo: 3 }, { sessionId: 'a', floorNo: 1 }, { sessionId: 'b', floorNo: 2 }];
  assert.deepEqual(orderFloors(views), ['a', 'b', 'c']);
  assert.deepEqual(orderFloors([]), []);
});

test('view: nextFloor wraps around and starts at the first for an unknown floor', () => {
  assert.equal(nextFloor(['a', 'b', 'c'], 'a'), 'b');
  assert.equal(nextFloor(['a', 'b', 'c'], 'c'), 'a');
  assert.equal(nextFloor(['a'], 'a'), 'a');
  assert.equal(nextFloor(['a', 'b'], 'gone'), 'a');
  assert.equal(nextFloor(['a', 'b'], null), 'a');
  assert.equal(nextFloor([], 'a'), null);
});

test('view: fallbackFloor keeps a present floor, else the next one in the old order, else the one before', () => {
  assert.equal(fallbackFloor(['a', 'b', 'c'], 'b', ['a', 'b', 'c']), 'b');
  assert.equal(fallbackFloor(['a', 'b', 'c'], 'b', ['a', 'c']), 'c');
  assert.equal(fallbackFloor(['a', 'b', 'c'], 'c', ['a', 'b']), 'b');
  assert.equal(fallbackFloor(['a', 'b', 'c', 'd'], 'b', ['a', 'd']), 'd');
  assert.equal(fallbackFloor(['a', 'b', 'c'], 'a', ['x']), 'x');
  assert.equal(fallbackFloor(['a'], 'a', []), null);
});

test('view: fitBox takes the tighter of width and height and caps the zoom', () => {
  assert.equal(fitBox(512, 1000, 1024, 512, 3), 0.5);
  assert.equal(fitBox(2000, 256, 1024, 512, 3), 0.5);
  assert.equal(fitBox(4000, 4000, 1024, 512, 3), 3);
  assert.equal(fitBox(2048, Infinity, 1024, 0, 3), 2);
  assert.equal(fitBox(-5, 100, 1024, 512, 3), 0);
});

const FLOOR = [1024, 576];
const floors = (n) => Array.from({ length: n }, () => FLOOR);

test('view: fitColumns keeps one column for one floor, and for an empty stack', () => {
  assert.deepEqual(fitColumns(floors(1), 1800, 1000, 12, 3), { cols: 1, scale: fitBox(1800, 1000, 1024, 576, 3) });
  assert.equal(fitColumns([], 1800, 1000, 12, 3).cols, 1);
});

test('view: fitColumns puts two floors side by side on a wide screen', () => {
  const r = fitColumns(floors(2), 1800, 900, 12, 3);
  assert.equal(r.cols, 2);
  assert.equal(r.scale, fitBox(1800, 900, 2 * 1024 + 12, 576, 3));
  assert.ok(r.scale > fitBox(1800, 900, 1024, 2 * 576 + 12, 3)); // better than the one column
});

test('view: fitColumns takes two columns for four floors on 16:9', () => {
  const r = fitColumns(floors(4), 1888, 1000, 12, 3);
  assert.deepEqual(r, { cols: 2, scale: Math.min(1888 / (2 * 1024 + 12), 1000 / (2 * 576 + 12)) });
  assert.ok(r.scale > fitBox(1888, 1000, 1024, 4 * 576 + 3 * 12, 3));
});

test('view: fitColumns for eight floors fills a 2x4 or 3x3 grid, whichever scales more', () => {
  const r = fitColumns(floors(8), 1888, 1000, 12, 3);
  const by = (c) => fitBox(1888, 1000, c * 1024 + (c - 1) * 12, Math.ceil(8 / c) * 576 + (Math.ceil(8 / c) - 1) * 12, 3);
  const best = Math.max(...[1, 2, 3, 4, 5, 6, 7, 8].map(by));
  assert.equal(r.scale, best);
  assert.equal(by(r.cols), best);
  assert.ok(r.cols >= 3);
});

test('view: fitColumns keeps one column on a tall narrow screen', () => {
  assert.equal(fitColumns(floors(4), 600, 2400, 12, 3).cols, 1);
  assert.equal(fitColumns(floors(2), 700, 1800, 12, 3).cols, 1);
});

test('view: fitColumns breaks a tie toward fewer columns (the cap, an empty last row)', () => {
  assert.equal(fitColumns(floors(2), 100000, 100000, 12, 3).cols, 1); // all capped at 3
  // 3 floors on a very wide, short screen: 3 columns (one row) beat 2 columns (two rows)
  assert.equal(fitColumns(floors(3), 3300, 300, 12, 3).cols, 3);
  // 5 floors: 3 and 4 columns both make two rows and both are tall-limited (same scale), 5 columns are too wide: the 3 wins
  const r = fitColumns(floors(5), 4000, 1000, 12, 3);
  assert.equal(r.cols, 3);
  assert.equal(r.scale, fitBox(4000, 1000, 4 * 1024 + 3 * 12, 2 * 576 + 12, 3));
});

test('view: fitColumns sizes a column by its widest floor and a row by its tallest', () => {
  const sizes = [[1024, 576], [1024, 512], [1024, 576], [1024, 512]];
  const r = fitColumns(sizes, 2060, 1200, 12, 3);
  assert.equal(r.cols, 2);
  assert.equal(r.scale, Math.min(2060 / (2 * 1024 + 12), 1200 / (576 + 576 + 12), 3));
});

test('view: config.json gives the rotation a positive number of seconds', () => {
  const { seconds } = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8')).ui.rotate;
  assert.ok(seconds > 0);
});

// ---- follow the busiest floor ----
const F = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8')).ui.follow;
const ev = (t, w = F.eventWeight) => ({ t, w });
const burst = (now, n, agoMs = 1000) => Array.from({ length: n }, (_, i) => ev(now - agoMs - i));
const scoresOf = (o) => new Map(Object.entries(o));
const ids = ['a', 'b', 'c'];
const choose = (scores, current, shownForSeconds = 1000, now = 1e9) =>
  chooseFollow({ ids, scores: scoresOf(scores), current, now, shownSince: now - shownForSeconds * 1000 }, F);

test('follow: config.json has sane numbers', () => {
  for (const k of ['windowSeconds', 'eventWeight', 'phaseWeight', 'workingWeight', 'minScore', 'switchMargin', 'minDwellSeconds', 'throttleMs']) assert.ok(F[k] > 0, k);
  assert.ok(F.switchRatio >= 1);
  assert.ok(F.label.length > 0 && F.title.length > 0 && F.marker.length > 0);
});

test('follow: score = weights of events in the window + working characters x workingWeight', () => {
  const now = 1e9;
  assert.equal(activityScore([], 0, now, F), 0);
  assert.equal(activityScore(burst(now, 5), 0, now, F), 5 * F.eventWeight);
  assert.equal(activityScore([ev(now - 1000, F.phaseWeight)], 0, now, F), F.phaseWeight);
  assert.equal(activityScore([], 2, now, F), 2 * F.workingWeight);
  assert.equal(activityScore(burst(now, 3), 1, now, F), 3 * F.eventWeight + F.workingWeight);
});

test('follow: events leave the score when they slide out of the window', () => {
  const now = 1e9;
  const events = [ev(now - F.windowSeconds * 1000 - 1), ev(now - F.windowSeconds * 1000), ev(now - 1000)];
  assert.equal(activityScore(events, 0, now, F), 2 * F.eventWeight); // exactly on the edge still counts
  assert.equal(activityScore(events, 0, now + 1, F), F.eventWeight);
  assert.equal(activityScore(events, 0, now + F.windowSeconds * 1000 + 1, F), 0);
  assert.equal(pruneEvents(events, now, F).length, 2);
  assert.equal(pruneEvents(events, now + F.windowSeconds * 1000 + 1, F).length, 0);
});

test('follow: busiestFloor takes the top score, ties keep the current floor, all quiet gives null', () => {
  assert.equal(busiestFloor(ids, scoresOf({ a: 3, b: 9, c: 5 }), 'a', F.minScore), 'b');
  assert.equal(busiestFloor(ids, scoresOf({ a: 5, b: 5, c: 5 }), 'b', F.minScore), 'b');
  assert.equal(busiestFloor(ids, scoresOf({ a: 5, b: 5, c: 1 }), 'c', F.minScore), 'a'); // tie without the current: the first
  assert.equal(busiestFloor(ids, scoresOf({ a: 0, b: F.minScore - 1, c: 0 }), 'a', F.minScore), null);
  assert.equal(busiestFloor([], new Map(), 'a', F.minScore), null);
});

test('follow: a clearly busier floor wins once the dwell time is over', () => {
  const big = 10 + F.switchMargin + 10;
  assert.deepEqual(choose({ a: 10, b: big, c: 0 }, 'a'), { id: 'b', waitMs: 0 });
});

test('follow: no flapping between two similar floors, in either direction', () => {
  const pair = (x, y) => [choose({ a: x, b: y, c: 0 }, 'a').id, choose({ a: y, b: x, c: 0 }, 'b').id];
  for (const [x, y] of [[10, 11], [10, 10 + F.switchMargin - 1], [20, 28], [10, 12]]) assert.deepEqual(pair(x, y), ['a', 'b'], `${x} vs ${y}`);
  // a margin that clears the absolute step but not the ratio does not move either
  assert.equal(choose({ a: 40, b: 40 + F.switchMargin, c: 0 }, 'a').id, 'a'); // switchRatio 1.5 would need 60
});

test('follow: the shown floor keeps its dwell time; the answer says when to look again', () => {
  const scores = { a: 2, b: 40, c: 0 };
  const now = 1e9;
  const r = chooseFollow({ ids, scores: scoresOf(scores), current: 'a', now, shownSince: now - 5000 }, F);
  assert.equal(r.id, 'a');
  assert.equal(r.waitMs, F.minDwellSeconds * 1000 - 5000);
  assert.equal(chooseFollow({ ids, scores: scoresOf(scores), current: 'a', now, shownSince: now - F.minDwellSeconds * 1000 }, F).id, 'b');
  assert.equal(chooseFollow({ ids, scores: scoresOf(scores), current: 'a', now, shownSince: 0 }, F).id, 'b'); // 0 = chosen by nobody: no dwell
});

test('follow: no wait is asked for when no switch is wanted', () => {
  assert.deepEqual(choose({ a: 10, b: 11, c: 0 }, 'a', 1), { id: 'a', waitMs: 0 });
  assert.deepEqual(choose({ a: 30, b: 2, c: 0 }, 'a', 1), { id: 'a', waitMs: 0 });
});

test('follow: all quiet stays put, a tie keeps the current floor', () => {
  assert.equal(choose({ a: 0, b: 0, c: 0 }, 'b').id, 'b');
  assert.equal(choose({ a: 0, b: F.minScore - 1, c: 0 }, 'a').id, 'a'); // busier but below minScore
  assert.equal(choose({ a: 50, b: 50, c: 50 }, 'c').id, 'c');
});

test('follow: a shown floor that is gone gives way at once, to the busiest (the first when quiet)', () => {
  const now = 1e9;
  const gone = (scores) => chooseFollow({ ids: ['a', 'c'], scores: scoresOf(scores), current: 'b', now, shownSince: now }, F);
  assert.deepEqual(gone({ a: 3, c: 20 }), { id: 'c', waitMs: 0 });
  assert.deepEqual(gone({ a: 0, c: 0 }), { id: 'a', waitMs: 0 });
  assert.deepEqual(chooseFollow({ ids: [], scores: new Map(), current: 'b', now, shownSince: now }, F), { id: null, waitMs: 0 });
});
