import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { blockedPolys, buyBlock, changedDesigns, decorNodes, houseSpots, ownedList } from '../web/decor.mjs';
import { createNav } from '../web/nav.mjs';
import { splitWalk } from '../web/depth.mjs';
import { resolveScene } from '../web/scene.mjs';
import { chooseCatAct } from '../web/cat.mjs';
import { rngFor } from '../web/ambient.mjs';
import { cfg } from './helpers/fixture.mjs';

const kinds = new Map(cfg.shop.catalog.map((c) => [c.id, c]));
const sizes = cfg.ui.decor.items;
const depth = cfg.depth;

test('decor: every catalog item has a picture size and anchor in ui.decor.items', () => {
  for (const c of cfg.shop.catalog) {
    assert.ok(sizes[c.id], c.id);
    const { size, anchor } = sizes[c.id];
    assert.ok(anchor[0] < size[0] && anchor[1] < size[1], c.id);
  }
});

test('decor: only blocking items bake into the walking grid; the rug never does', () => {
  const placed = [{ uid: 'a', item: 'rug', x: 100, y: 100 }, { uid: 'b', item: 'plant-small', x: 200, y: 150 }];
  const polys = blockedPolys(placed, kinds);
  assert.equal(polys.length, 1);
  assert.deepEqual(polys[0][0], [192, 145]);
});

test('decor: depth follows the contact point, the rug lies under everything', () => {
  const placed = [{ uid: 'a', item: 'rug', x: 100, y: 100 }, { uid: 'b', item: 'sofa', x: 200, y: 150 }];
  const [rug, sofa] = decorNodes(placed, kinds, sizes, depth);
  assert.equal(rug.z, depth.zBase - 1);
  assert.equal(sofa.z, depth.zBase + 300);
  assert.equal(sofa.x, 200 - sizes.sofa.anchor[0]);
  assert.equal(sofa.depthY, 150);
});

test('decor: a walk is cut where it passes a piece of furniture, and not at a rug', () => {
  const walk = [[100, 100], [100, 200]];
  const withSofa = decorNodes([{ uid: 'b', item: 'sofa', x: 100, y: 150 }], kinds, sizes, depth);
  assert.equal(splitWalk(walk, withSofa, depth).length, 2);
  const withRug = decorNodes([{ uid: 'a', item: 'rug', x: 100, y: 150 }], kinds, sizes, depth);
  assert.equal(splitWalk(walk, withRug, depth).length, 1);
});

test('decor: nav.invalidate bakes one design again and forgets only its cached paths', () => {
  const open = { size: [200, 160], walkable: [[[0, 0], [200, 0], [200, 160], [0, 160]]], blocked: [], objects: [] };
  const scenes = new Map([['a', open], ['b', open]]);
  const nav = createNav(scenes, cfg.nav);
  const from = [20, 80];
  const to = [180, 80];
  assert.equal(nav.path('a', from, to).length, 2); // straight line
  nav.path('b', from, to);
  scenes.set('a', { ...open, blocked: [[[80, 70], [120, 70], [120, 90], [80, 90]]] });
  assert.equal(nav.path('a', from, to).length, 2, 'cached path until told');
  nav.invalidate('a');
  assert.ok(nav.path('a', from, to).length > 2, 'walks around the new furniture');
  const before = nav.stats().hits;
  nav.path('b', from, to);
  assert.equal(nav.stats().hits, before + 1, 'the other design keeps its cache');
});

test('decor: a cat house is a sleeping spot with an approach; the cat picks it', () => {
  const placed = [{ uid: 'h', item: 'cat-house', x: 300, y: 200 }, { uid: 'p', item: 'plant-small', x: 10, y: 10 }];
  const spots = houseSpots(placed, (p) => [p.x, p.y + 20]);
  assert.deepEqual(spots, [{ id: 'decor:h', kind: 'cat-house', at: [300, 200], face: 'right', approach: [300, 220] }]);
  assert.deepEqual(houseSpots(placed, () => null), []);
  const pick = chooseCatAct(rngFor('bed'), { cat: cfg.ui.cat, spots, taken: new Map(), desks: [], point: () => null, leaveDue: false, force: 'sleep' });
  assert.equal(pick.spotId, 'decor:h');
  assert.equal(pick.pose, 'sleep');
  const taken = chooseCatAct(rngFor('bed'), { cat: cfg.ui.cat, spots, taken: new Map([['decor:h', 1]]), desks: [], point: () => null, leaveDue: false, force: 'sleep' });
  assert.equal(taken, null);
});

test('decor: only rooms whose list changed are reported', () => {
  const a = { studio2: [{ uid: '1', item: 'rug', x: 1, y: 2 }], lounge: [] };
  assert.deepEqual(changedDesigns(a, a), []);
  assert.deepEqual(changedDesigns(a, { ...a, lounge: [{ uid: '2', item: 'sofa', x: 1, y: 1 }] }), ['lounge']);
  assert.deepEqual(changedDesigns(a, { studio2: [] }), ['studio2']);
  assert.deepEqual(changedDesigns(undefined, { library: [] }), []);
});

test('shop: the reason a buy is blocked, and the owned list in catalog order', () => {
  assert.equal(buyBlock(50, 30), '');
  assert.equal(buyBlock(50, 50), '');
  assert.equal(buyBlock(50, 70), '코인이 20개 모자라요');
  const owned = ownedList(cfg.shop.catalog, { sofa: 2, rug: 1, 'plant-small': 0 });
  assert.deepEqual(owned.map((o) => [o.id, o.count]), [['rug', 1], ['sofa', 2]]);
  assert.equal(readFileSync(new URL('../web/index.html', import.meta.url), 'utf8').includes('id="shop"'), true);
});
