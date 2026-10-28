import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveScene } from '../web/scene.mjs';
import { bakeGrid, isOpen, snapOpen, lineOfSight, findPath, createNav } from '../web/nav.mjs';
import { fixtureRaw, cfg } from './helpers/fixture.mjs';

const NAV = cfg.nav;
const OPTS = { snapRadiusCells: NAV.snapRadiusCells };

/** An empty rectangular room (no objects) from the fixture's shape. */
function room({ w = 400, h = 300, blocks = [], blocked = [] } = {}) {
  const r = resolveScene(fixtureRaw());
  r.size = [w, h];
  r.walkable = [[[0, 0], [w, 0], [w, h], [0, h]]];
  r.blocked = blocked;
  r.objects = blocks.map((fp, i) => ({ id: `b${i}`, kind: 'box', at: fp[0], flipX: false, rect: [0, 0, 1, 1], anchor: [0, 0], footprint: fp, blocks: true, depth: 'auto' }));
  return r;
}
const box = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

test('nav: bake blocks inflate radius around a box', () => {
  const r = room({ blocks: [box(150, 100, 250, 200)] });
  const g = bakeGrid(r, NAV);
  assert.equal(isOpen(g, [144, 150]), false); // 6px from the box
  assert.equal(isOpen(g, [140, 150]), false); // 10px
  assert.equal(isOpen(g, [200, 150]), false); // inside
  assert.equal(isOpen(g, [130, 150]), true); // 20px
  assert.equal(isOpen(g, [200, 220]), true);
  // the floor's own border: 12px in is closed
  assert.equal(isOpen(g, [6, 150]), false);
  assert.equal(isOpen(g, [20, 150]), true);
  assert.equal(isOpen(g, [200, 292]), false);
});

test('nav: path goes around the box', () => {
  const r = room({ blocks: [box(150, 60, 250, 240)] });
  const g = bakeGrid(r, NAV);
  const p = findPath(g, [60, 150], [340, 150], OPTS);
  assert.ok(p && p.length > 2);
  assert.deepEqual(p[0], [60, 150]);
  assert.deepEqual(p.at(-1), [340, 150]);
  for (let i = 0; i < p.length - 1; i++) assert.ok(lineOfSight(g, p[i], p[i + 1]), `segment ${i}`);
  for (const q of p) assert.ok(isOpen(g, q));
});

test('nav: no diagonal corner cutting', () => {
  // two closed cells touching only at a corner: a walker may not squeeze between them
  const r = room({ w: 64, h: 64 });
  const g = bakeGrid(r, { ...NAV, inflatePx: 0 });
  g.open.fill(1);
  const at = (c, row) => row * g.cols + c;
  g.open[at(3, 3)] = 0;
  g.open[at(4, 4)] = 0;
  const p = findPath(g, [28, 36], [36, 28], OPTS); // from cell (3,4) to cell (4,3): the diagonal passes the two closed cells' corner
  assert.ok(p);
  assert.ok(p.length > 2, 'detour instead of a straight corner squeeze');
  assert.equal(lineOfSight(g, [28, 36], [36, 28]), false);
});

test('nav: smoothing merges collinear runs', () => {
  const g = bakeGrid(room(), NAV);
  assert.equal(findPath(g, [40, 40], [340, 240], OPTS).length, 2);
  assert.equal(findPath(g, [40, 40], [340, 40], OPTS).length, 2);
});

test('nav: blocked goal snaps to nearest open cell', () => {
  const g = bakeGrid(room({ blocks: [box(150, 100, 250, 200)] }), NAV);
  assert.equal(isOpen(g, [143, 150]), false);
  const p = findPath(g, [40, 150], [143, 150], OPTS);
  assert.ok(p);
  const end = p.at(-1);
  assert.ok(isOpen(g, end));
  assert.ok(dist(end, [143, 150]) < 16);
  // deep inside the box nothing open lies within the snap radius: no route
  assert.equal(snapOpen(g, [200, 150], NAV.snapRadiusCells), null);
  assert.equal(findPath(g, [40, 150], [200, 150], OPTS), null);
});

test('nav: unreachable returns null', () => {
  // a closed ring of blocked polygons around [200,150]
  const ring = [box(150, 100, 250, 110), box(150, 190, 250, 200), box(150, 100, 160, 200), box(240, 100, 250, 200)];
  const g = bakeGrid(room({ blocked: ring }), { ...NAV, inflatePx: 4 });
  assert.equal(isOpen(g, [200, 150]), true);
  assert.equal(findPath(g, [60, 60], [200, 150], OPTS), null);
});

test('nav: cache hits on repeat and bakes once', () => {
  const nav = createNav(new Map([['d', room({ blocks: [box(150, 60, 250, 240)] })]]), NAV);
  const a = nav.path('d', [60, 150], [340, 150]);
  const b = nav.path('d', [60, 150], [340, 150]);
  assert.deepEqual(a, b);
  assert.notEqual(a, b);
  assert.deepEqual(nav.stats(), { bakes: 1, hits: 1, misses: 1 });
  b[0][0] = 999; // a caller editing its copy must not poison the cache
  assert.deepEqual(nav.path('d', [60, 150], [340, 150]), a);
});

test('nav: a cache hit never returns an end leg through closed cells', () => {
  const r = room({ blocks: [box(150, 60, 250, 240)] });
  const g = bakeGrid(r, NAV);
  const nav = createNav(new Map([['d', r]]), NAV);
  nav.path('d', [60, 150], [340, 150]);
  let rechecked = 0;
  for (let i = 0; i < 400; i++) {
    const from = [20 + ((i * 37) % 120), 120 + ((i * 11) % 60)];
    const to = [300 + ((i * 29) % 90), 120 + ((i * 17) % 60)];
    const p = nav.path('d', from, to);
    if (!p || !isOpen(g, from) || !isOpen(g, to)) continue;
    rechecked++;
    for (let k = 1; k < p.length; k++) assert.ok(lineOfSight(g, p[k - 1], p[k]), `${from}->${to} leg ${k}`);
  }
  assert.ok(rechecked > 300);
});

test('nav: cache keeps at most pathCache entries', () => {
  const nav = createNav(new Map([['d', room()]]), { ...NAV, pathCache: 2 });
  nav.path('d', [20, 20], [100, 100]);
  nav.path('d', [20, 20], [200, 100]);
  nav.path('d', [20, 20], [300, 100]);
  nav.path('d', [20, 20], [100, 100]); // evicted: a miss again
  assert.equal(nav.stats().misses, 4);
});

test('nav: fixture bakes under 50 ms', () => {
  const r = resolveScene(fixtureRaw());
  bakeGrid(r, NAV); // warm up the JIT
  const t0 = performance.now();
  const g = bakeGrid(r, NAV);
  const ms = performance.now() - t0;
  assert.equal(g.cols * g.rows, 128 * 64);
  assert.ok(ms < 50, `bake took ${ms.toFixed(1)} ms`);
});

test('nav: fixture seat approaches are reachable from the door', () => {
  const r = resolveScene(fixtureRaw());
  const g = bakeGrid(r, NAV);
  for (const s of r.seats) {
    const p = findPath(g, r.door.at, s.approach, OPTS);
    assert.ok(p, s.deskId);
    assert.ok(dist(p.at(-1), s.approach) < 1);
  }
});
