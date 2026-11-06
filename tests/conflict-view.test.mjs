// Tests of the conflict alarm's screen rules (web/conflict-view.mjs): marker text, lobby lamp, tug priority, effects off.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lampState, peerFloors, personMarks, tagLabel, tugAllowed } from '../web/conflict-view.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ui = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8')).ui;
const cfg = ui.conflict;

const views = new Map([['sa', { floorNo: 2 }], ['sb', { floorNo: 5 }], ['sc', { floorNo: 3 }]]);
const viewOf = (sid) => views.get(sid) ?? null;

test('the marker text names the floors on the other side, ascending, and skips floors the screen does not know', () => {
  const fv = { conflicts: [{ id: 'c1', with: ['sb', 'sa'], since: 1 }, { id: 'c2', with: ['sc', 'gone'], since: 2 }] };
  assert.deepEqual(peerFloors(fv, 'c1', viewOf), [2, 5]);
  assert.deepEqual(peerFloors(fv, 'c2', viewOf), [3]);
  assert.deepEqual(peerFloors(fv, null, viewOf), [2, 3, 5]); // the name plate lists every conflict of the floor
  assert.equal(tagLabel(cfg.tagText, [2, 5]), '2, 5층과 같은 파일');
  assert.equal(tagLabel(cfg.tagText, []), ''); // nobody known: the marker shows its picture only
});

test('the lobby lamp burns while any floor has a conflict and is not drawn when no place is set', () => {
  const calm = [{ conflicts: [] }, { conflicts: [] }];
  const hot = [{ conflicts: [] }, { conflicts: [{ id: 'c1', with: ['sa'], since: 1 }] }];
  assert.equal(lampState(hot, null), null); // lobbyLampAt null: nothing is drawn
  assert.deepEqual(lampState(calm, [10, 20]), { on: false, at: [10, 20] });
  assert.deepEqual(lampState(hot, [10, 20]), { on: true, at: [10, 20] });
  assert.equal(lampState([], [10, 20]).on, false);
});

test('a bell wave, a faint or a rest puts the tug off, a meeting too; folder and office life give way to it', () => {
  const p = ui.gesture.priority;
  assert.equal(tugAllowed(p, null, false), true);
  for (const stronger of ['rest', 'faint', 'bellwave']) assert.equal(tugAllowed(p, stronger, false), false, stronger);
  assert.equal(tugAllowed(p, 'tug', false), false);
  assert.equal(tugAllowed(p, 'folder', false), true);
  assert.equal(tugAllowed(p, 'life', false), true);
  assert.equal(tugAllowed(p, null, true), false); // a meeting on the floor
});

test('with the effects off the person keeps the tag and has no paper', () => {
  assert.deepEqual(personMarks(false, 'c1'), { tag: true, prop: false });
  assert.deepEqual(personMarks(true, 'c1'), { tag: true, prop: true });
  assert.deepEqual(personMarks(true, null), { tag: false, prop: false });
  assert.deepEqual(personMarks(false, null), { tag: false, prop: false });
});
