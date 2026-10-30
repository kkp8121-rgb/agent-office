import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { orderFloors, nextFloor, fallbackFloor, fitBox } from '../web/view.mjs';

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

test('view: config.json gives the rotation a positive number of seconds', () => {
  const { seconds } = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8')).ui.rotate;
  assert.ok(seconds > 0);
});
