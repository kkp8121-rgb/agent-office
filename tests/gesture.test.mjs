import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createGestures } from '../web/gesture.mjs';

const PRIORITY = JSON.parse(readFileSync(fileURLToPath(new URL('../config.json', import.meta.url)), 'utf8')).ui.gesture.priority;

test('a higher kind preempts a lower one and calls onPreempt once', () => {
  const cleared = [];
  const g = createGestures(PRIORITY, (rec) => cleared.push(rec));
  const rec = {};
  const low = g.acquire(rec, 'folder');
  let calls = 0;
  g.onPreempt(low, () => calls++);
  const high = g.acquire(rec, 'faint');
  assert.ok(high);
  assert.equal(calls, 1);
  assert.deepEqual(cleared, [rec]); // the character is cleared before the new holder starts
  assert.equal(g.current(rec), 'faint');
  g.release(low); // the old token no longer owns anything
  assert.equal(g.current(rec), 'faint');
  assert.equal(calls, 1);
});

test('an equal or lower kind is refused', () => {
  const g = createGestures(PRIORITY);
  const rec = {};
  assert.ok(g.acquire(rec, 'tug'));
  assert.equal(g.acquire(rec, 'tug'), null);
  assert.equal(g.acquire(rec, 'folder'), null);
  assert.equal(g.acquire(rec, 'life'), null);
  assert.equal(g.current(rec), 'tug');
});

test('release frees the character', () => {
  const g = createGestures(PRIORITY);
  const rec = {};
  const token = g.acquire(rec, 'bellwave');
  g.release(token);
  assert.equal(g.current(rec), null);
  assert.ok(g.acquire(rec, 'life')); // anything may start again
  assert.ok(g.acquire({}, 'life')); // and another character was never held
});

test('an unknown kind is refused', () => {
  const g = createGestures(PRIORITY);
  const rec = {};
  assert.equal(g.acquire(rec, 'dance'), null);
  assert.equal(g.current(rec), null);
  assert.equal(g.acquire(rec, undefined), null);
});

test('canAmbient is false while any gesture is held', () => {
  const g = createGestures(PRIORITY);
  const rec = {};
  assert.equal(g.canAmbient(rec), true);
  for (const kind of PRIORITY) {
    const token = g.acquire(rec, kind);
    assert.ok(token, kind);
    assert.equal(g.canAmbient(rec), false, kind);
    g.release(token);
    assert.equal(g.canAmbient(rec), true, kind);
  }
});

test('the order comes from ui.gesture.priority', () => {
  const rec = {};
  const flipped = createGestures(['b', 'a']);
  assert.ok(flipped.acquire(rec, 'a'));
  assert.ok(flipped.acquire(rec, 'b')); // b is first = stronger
  assert.equal(flipped.current(rec), 'b');
  const normal = createGestures(['a', 'b']);
  assert.ok(normal.acquire(rec, 'b'));
  assert.ok(normal.acquire(rec, 'a'));
  assert.equal(normal.current(rec), 'a');
  const refuse = createGestures(['a', 'b']);
  assert.ok(refuse.acquire({}, 'a') && refuse.acquire(rec, 'a'));
  assert.equal(refuse.acquire(rec, 'b'), null);
});
