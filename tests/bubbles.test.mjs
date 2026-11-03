import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { clearBubbles } from '../web/bubbles.mjs';
import { cfg } from './helpers/fixture.mjs';

const C = cfg.ui.bubbleClear;
const box = (id, kind, x, y, w = 100, h = 20) => ({ id, kind, x, y, w, h });
const hit = (a, b) => Math.min(a.x + a.w, b.x + b.w) > Math.max(a.x, b.x) && Math.min(a.y + a.h, b.y + b.h) > Math.max(a.y, b.y);
/** The boxes that stay on show, each moved up by its lift. */
const shown = (items, out) => items.filter((b) => !out.get(b.id).hide).map((b) => ({ ...b, y: b.y - out.get(b.id).lift }));
const assertClear = (items, out) => {
  const s = shown(items, out);
  for (let i = 0; i < s.length; i++) for (let j = i + 1; j < s.length; j++) assert.ok(!hit(s[i], s[j]), `${s[i].id} covers ${s[j].id}`);
};

test('config: the bubble clearing numbers are in ui.bubbleClear', () => {
  assert.ok(C.checkMs > 0 && C.gapPx >= 0 && C.maxLifts >= 1);
});

test('a text line over another text line moves up above it', () => {
  const items = [box('a', 'txt', 100, 100), box('b', 'txt', 120, 104)];
  const out = clearBubbles(items, C);
  assert.equal(out.get('a').lift, 0); // the first one keeps its place
  assert.ok(out.get('b').lift > 0);
  assert.equal(out.get('b').hide, false);
  assertClear(items, out);
});

test('a 「…」 marker on top of a text line hides, and never the other way round', () => {
  const items = [box('dot', 'dot', 140, 106, 22, 18), box('txt', 'txt', 100, 100)]; // the marker comes first in the list, as in the bug
  const out = clearBubbles(items, C);
  assert.deepEqual(out.get('dot'), { lift: 0, hide: true });
  assert.deepEqual(out.get('txt'), { lift: 0, hide: false });
});

test('two markers on one spot: one stays, the other hides', () => {
  const out = clearBubbles([box('a', 'dot', 100, 100, 22, 18), box('b', 'dot', 105, 102, 22, 18)], C);
  assert.equal(out.get('a').hide, false);
  assert.equal(out.get('b').hide, true);
});

test('rank: a held line beats a canned line, a canned line beats the task text', () => {
  const items = [box('txt', 'txt', 100, 100), box('say', 'say', 100, 100), box('grab', 'grab', 100, 100)];
  const out = clearBubbles(items, C);
  assert.equal(out.get('grab').lift, 0);
  assert.ok(out.get('say').lift > 0);
  assert.ok(out.get('txt').lift > out.get('say').lift);
  assertClear(items, out);
});

test('bubbles that do not touch stay as they are', () => {
  const items = [box('a', 'txt', 0, 100), box('b', 'say', 200, 100), box('c', 'dot', 400, 100, 22, 18), box('d', 'txt', 0, 140)];
  const out = clearBubbles(items, C);
  for (const b of items) assert.deepEqual(out.get(b.id), { lift: 0, hide: false });
});

test('a stack of greeters climbs one above the other', () => {
  const items = [0, 1, 2].map((i) => box(`s${i}`, 'say', 100 + i * 10, 100));
  const out = clearBubbles(items, C);
  assert.deepEqual(items.map((b) => out.get(b.id).lift > 0), [false, true, true]);
  assertClear(items, out);
});

test('the pass is wired in: app.mjs runs it and style.css moves and hides the bubbles', () => {
  const app = readFileSync(new URL('../web/app.mjs', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../web/style.css', import.meta.url), 'utf8');
  assert.match(app, /import \{ clearBubbles \} from '\.\/bubbles\.mjs'/);
  assert.match(app, /clearBubbles\(items, C\)/);
  assert.match(css, /\.bub \{ --lift: 0px; translate: 0 calc\(var\(--lift\) \* -1\); \}/);
  assert.match(css, /\.bub\.shy \{ opacity: 0;/);
});
