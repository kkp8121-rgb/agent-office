import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { lightAt, lunarNewYear, msToNextChange, placeSeason, seasonOn } from '../web/season.mjs';
import { pickAt, snackOutcome } from '../web/snack.mjs';
import { cfg } from './helpers/fixture.mjs';

const items = JSON.parse(readFileSync(new URL('../assets/seasonal/items.json', import.meta.url), 'utf8'));
const noon = (y, m, d) => new Date(y, m - 1, d, 12);

test('lunar new year comes from the Korean calendar, not a table', () => {
  assert.deepEqual([2025, 2026, 2027, 2028].map(lunarNewYear), [[1, 29], [2, 17], [2, 7], [1, 27]]);
});

test('season: the date windows from the config, nothing outside them', () => {
  const S = cfg.ui.season;
  const at = (y, m, d) => seasonOn(noon(y, m, d), S);
  assert.deepEqual([[10, 23], [10, 24], [10, 30], [10, 31], [11, 1]].map(([m, d]) => at(2026, m, d)), ['none', 'halloween', 'halloween', 'halloween', 'none']);
  assert.deepEqual([[12, 17], [12, 18], [12, 26], [12, 27]].map(([m, d]) => at(2026, m, d)), ['none', 'christmas', 'christmas', 'none']);
  assert.deepEqual([[2, 14], [2, 15], [2, 17], [2, 19], [2, 20]].map(([m, d]) => at(2026, m, d)), ['none', 'lunar', 'lunar', 'lunar', 'none']);
  assert.equal(at(2026, 6, 1), 'none');
});

test('light: day, sunset and night by hour, the night wraps midnight', () => {
  const D = cfg.ui.daylight;
  assert.deepEqual([5, 6, 12, 16, 17, 18, 19, 23, 0].map((h) => lightAt(h, D)), ['night', 'day', 'day', 'day', 'sunset', 'sunset', 'night', 'night', 'night']);
});

test('the one timer goes to the next boundary hour or midnight', () => {
  const D = cfg.ui.daylight;
  const h = (x) => x * 3600000;
  assert.equal(msToNextChange(new Date(2026, 9, 30, 12, 0, 0), D), h(5)); // 17:00
  assert.equal(msToNextChange(new Date(2026, 9, 30, 17, 30, 0), D), h(1.5)); // 19:00
  assert.equal(msToNextChange(new Date(2026, 9, 30, 20, 0, 0), D), h(4)); // midnight
  assert.equal(msToNextChange(new Date(2026, 9, 30, 3, 0, 0), D), h(3)); // 06:00
});

test('decorations: every one fits its anchor, a design always gets the same, each picture before a repeat', () => {
  const anchors = (d) => JSON.parse(readFileSync(new URL(`../assets/scenes/${d}/scene.json`, import.meta.url), 'utf8')).seasonal;
  for (const design of cfg.designOrder) {
    for (const season of ['halloween', 'christmas', 'lunar']) {
      const a = placeSeason(items, anchors(design), season, design);
      assert.deepEqual(a.map((p) => p.item.name), placeSeason(items, anchors(design), season, design).map((p) => p.item.name));
      for (const { anchor, item } of a) {
        assert.equal(item.season, season);
        assert.equal(item.kind, anchor.kind);
        assert.ok(item.size[0] <= anchor.max[0] && item.size[1] <= anchor.max[1], `${design} ${anchor.id} ${item.name}`);
      }
      assert.ok(a.some((p) => p.anchor.kind === 'wall'), `${design} ${season} has a wall piece`);
    }
  }
  const two = placeSeason(items, [{ id: 'a', kind: 'floor', at: [0, 0], max: [40, 60] }, { id: 'b', kind: 'floor', at: [0, 0], max: [40, 60] }], 'christmas', 'x');
  assert.notEqual(two[0].item, two[1].item);
  assert.deepEqual(placeSeason(items, [{ id: 'a', kind: 'floor', at: [0, 0], max: [5, 5] }], 'christmas', 'x'), []);
});

test('snack: the drop lands on the nearest box under the point, none elsewhere', () => {
  const rects = [{ id: 'a', left: 0, top: 0, right: 40, bottom: 60 }, { id: 'b', left: 30, top: 0, right: 70, bottom: 60 }];
  assert.equal(pickAt(rects, 10, 30, 8), 'a');
  assert.equal(pickAt(rects, 60, 30, 8), 'b');
  assert.equal(pickAt(rects, 32, 30, 8), 'a'); // inside both: the nearer centre wins
  assert.equal(pickAt(rects, 38, 30, 8), 'b');
  assert.equal(pickAt(rects, 200, 30, 8), null);
  assert.equal(pickAt(rects, 74, 30, 8), 'b'); // the margin
});

test('snack: fish is the cat\'s, the rest is for people; the cooldown only blocks eating', () => {
  const C = cfg.ui.snack.cooldownSeconds;
  assert.equal(snackOutcome('fish', true, undefined, 1000, C), 'eat');
  assert.equal(snackOutcome('coffee', false, undefined, 1000, C), 'eat');
  assert.equal(snackOutcome('fish', false, undefined, 1000, C), 'refuse');
  assert.equal(snackOutcome('donut', true, undefined, 1000, C), 'refuse');
  assert.equal(snackOutcome('coffee', false, 1000, 1000 + C * 1000 - 1, C), 'full');
  assert.equal(snackOutcome('coffee', false, 1000, 1000 + C * 1000, C), 'eat');
  assert.equal(snackOutcome('fish', false, 1000, 1500, C), 'refuse'); // refusing is not eating
});

test('config: snack and daylight numbers and lines exist', () => {
  assert.ok(cfg.ui.snack.cooldownSeconds > 0 && cfg.ui.snack.sparkleMs > cfg.ui.snack.eatMs);
  assert.deepEqual(cfg.ui.snack.kinds, ['coffee', 'donut', 'cookie', 'fish']);
  assert.deepEqual(cfg.ui.lines.snackEat, ['냠냠']);
  assert.deepEqual(cfg.ui.lines.snackDone, ['힘이 난다!']);
  for (const k of ['snackFull', 'snackNoFish', 'snackNoCat', 'catSnackDone']) assert.ok(cfg.ui.lines[k].length >= 8, k);
});
