// ConflictTracker: which floors edited the same file lately. Keys are opaque strings here (parse.mjs makes them from salted hashes).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConflictTracker } from '../server/conflict.mjs';
import config from '../config.json' with { type: 'json' };

const WIN = config.conflict.windowMs;
const make = (o = {}) => new ConflictTracker({ ...config.conflict, ...o });

test('two floors editing one file inside the window give a conflict with one id', () => {
  const t = make();
  t.touch('k1', 's1', 'lead', 1000);
  t.touch('k1', 's2', 'lead', 2000);
  const r = t.evaluate(3000);
  assert.deepEqual(r.raised, [{ id: 'c1', sessionIds: ['s1', 's2'], since: 2000 }]);
  assert.deepEqual(r.bySession.get('s1'), [{ id: 'c1', with: ['s2'], since: 2000, actorKey: 'lead' }]);
  assert.deepEqual(r.bySession.get('s2'), [{ id: 'c1', with: ['s1'], since: 2000, actorKey: 'lead' }]);
  assert.equal(t.evaluate(3500).raised.length, 0, 'the same conflict is raised once');
  assert.equal(t.evaluate(3600).bySession.get('s1')[0].id, 'c1', 'and keeps its id while it lasts');
  assert.deepEqual(Object.keys(r.bySession.get('s1')[0]).sort(), ['actorKey', 'id', 'since', 'with']);
});

test('the lead and an agent of one floor are no conflict', () => {
  const t = make();
  t.touch('k1', 's1', 'lead', 1000);
  t.touch('k1', 's1', 's1:a1', 1500);
  const r = t.evaluate(2000);
  assert.equal(r.bySession.size, 0);
  assert.equal(r.raised.length, 0);
});

test('an edit outside the window is no conflict', () => {
  const t = make();
  t.touch('k1', 's1', 'lead', 1000);
  t.touch('k1', 's2', 'lead', 1000 + WIN + 1000);
  assert.equal(t.evaluate(1000 + WIN + 1000).bySession.size, 0, 's1 edited it more than a window ago');
  t.touch('k2', 's1', 'lead', 5000);
  t.touch('k2', 's2', 'lead', 5000);
  assert.equal(t.evaluate(5000 + WIN).bySession.size, 2, 'an edit exactly a window old still counts');
  assert.equal(t.evaluate(5000 + WIN + 1).bySession.size, 0);
});

test('a floor that leaves the window or the office releases the conflict', () => {
  const t = make();
  t.touch('k1', 's1', 'lead', 1000);
  t.touch('k1', 's2', 'lead', 1000 + WIN - 1);
  assert.equal(t.evaluate(1000 + WIN - 1).bySession.size, 2);
  const r = t.evaluate(1000 + WIN + 1); // s1's edit has aged out, s2's has not
  assert.equal(r.bySession.size, 0);
  assert.equal(r.changed, true);
  t.touch('k3', 's1', 'lead', 9000000);
  t.touch('k3', 's3', 'lead', 9000001);
  assert.equal(t.evaluate(9000002).bySession.size, 2);
  t.drop('s3'); // the floor left or was hidden
  assert.equal(t.evaluate(9000003).bySession.size, 0);
});

test('a conflict that comes back gets a new id', () => {
  const t = make();
  t.touch('k1', 's1', 'lead', 1000);
  t.touch('k1', 's2', 'lead', 1100);
  assert.equal(t.evaluate(1200).raised[0].id, 'c1');
  assert.equal(t.evaluate(1000 + WIN + 500).bySession.size, 0);
  t.touch('k1', 's1', 'lead', 1000 + WIN + 600);
  t.touch('k1', 's2', 'lead', 1000 + WIN + 700);
  const again = t.evaluate(1000 + WIN + 800);
  assert.deepEqual(again.raised.map((c) => c.id), ['c2']);
});

test('three floors on one file give each a with of the other two', () => {
  const t = make();
  t.touch('k1', 's1', 'lead', 1000);
  t.touch('k1', 's2', 'lead', 1100);
  const first = t.evaluate(1200);
  assert.equal(first.raised.length, 1);
  t.touch('k1', 's3', 'lead', 1300);
  const r = t.evaluate(1400);
  assert.equal(r.raised.length, 0, 'a third floor joins the conflict that is on');
  assert.deepEqual(r.bySession.get('s1')[0].with, ['s2', 's3']);
  assert.deepEqual(r.bySession.get('s3')[0].with, ['s1', 's2']);
  assert.equal(new Set([...r.bySession.values()].map((l) => l[0].id)).size, 1);
});

test('past maxKeys the oldest key is dropped', () => {
  const t = make({ maxKeys: 2 });
  t.touch('old', 's1', 'lead', 1000);
  t.touch('old', 's2', 'lead', 1000);
  t.touch('k2', 's1', 'lead', 1100);
  t.touch('k3', 's1', 'lead', 1200);
  assert.equal(t.keys.size, 2);
  assert.equal(t.evaluate(1300).bySession.size, 0, 'the pair on the oldest key is forgotten');
  t.touch('k2', 's2', 'lead', 1400); // k2 is still known: this makes a conflict
  assert.equal(t.evaluate(1500).bySession.size, 2);
});
