import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldLift, dropPoint, restSpotNear } from '../web/grab.mjs';
import { cfg } from './helpers/fixture.mjs';

const G = cfg.ui.grab;

test('grab: a still, short press is a click; a move or a long hold lifts', () => {
  assert.equal(shouldLift(0, 0, 80, G), false);
  assert.equal(shouldLift(G.movePx - 1, 0, 80, G), false);
  assert.equal(shouldLift(3, 3, G.holdMs - 1, G), false);
  assert.equal(shouldLift(G.movePx, 0, 10, G), true);
  assert.equal(shouldLift(0, -G.movePx, 10, G), true);
  assert.equal(shouldLift(0, 0, G.holdMs, G), true);
});

// 10x10 cells of 8px; the open block is columns 2-5, rows 2-5
const grid = { cols: 10, rows: 10, cellPx: 8, open: Array.from({ length: 100 }, (_, i) => {
  const c = i % 10; const r = Math.floor(i / 10);
  return c >= 2 && c <= 5 && r >= 2 && r <= 5 ? 1 : 0;
}) };
const SIZE = [80, 80];

test('grab: a walkable drop point stays, a wall point snaps to the nearest open cell, outside is clamped first', () => {
  assert.deepEqual(dropPoint(grid, [30, 30], SIZE), [30, 30]);
  assert.deepEqual(dropPoint(grid, [60, 30], SIZE), [44, 28]); // right of the block -> centre of cell (5,3)
  assert.deepEqual(dropPoint(grid, [-50, -50], SIZE), [20, 20]); // clamped to the corner, then the nearest cell (2,2)
  assert.deepEqual(dropPoint(grid, [500, 30], SIZE), [44, 28]);
});

test('grab: no walkable cell at all gives null', () => {
  assert.equal(dropPoint({ ...grid, open: new Array(100).fill(0) }, [10, 10], SIZE), null);
});

test('grab: rest spot is the nearest free one within the radius', () => {
  const spots = [{ id: 'sofa', at: [100, 100] }, { id: 'coffee', at: [130, 100] }, { id: 'far', at: [400, 400] }];
  assert.equal(restSpotNear(spots, new Map(), [120, 100], 50).id, 'coffee');
  assert.equal(restSpotNear(spots, new Map([['coffee', 1]]), [120, 100], 50).id, 'sofa');
  assert.equal(restSpotNear(spots, new Map(), [250, 250], 50), null);
  assert.equal(restSpotNear(spots, new Map([['sofa', 1], ['coffee', 2]]), [120, 100], 50), null);
});
