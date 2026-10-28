import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolveScene } from '../web/scene.mjs';
import { objectNodes, charZ, splitWalk } from '../web/depth.mjs';
import { fixtureRaw, cfg } from './helpers/fixture.mjs';

const D = cfg.depth;
const scene = (edit) => {
  const raw = fixtureRaw();
  edit?.(raw);
  return resolveScene(raw);
};
const nodesOf = (r, id) => objectNodes(r, D).filter((n) => n.objId === id);

test('depth: frontal desk is one node', () => {
  const [n, ...rest] = nodesOf(scene(), 'desk-1');
  assert.equal(rest.length, 0);
  assert.equal(n.depthY, 230);
  assert.equal(n.z, D.zBase + 2 * 230);
  assert.deepEqual([n.x, n.y, n.w, n.h], [260, 174, 80, 56]);
});

test('depth: diagonal cabinet is sliced', () => {
  const ns = nodesOf(scene(), 'cabinet-1');
  assert.ok(ns.length >= 2);
  for (let k = 1; k < ns.length; k++) {
    assert.ok(ns[k].depthY > ns[k - 1].depthY, `strip ${k} deeper than ${k - 1}`);
    assert.equal(ns[k - 1].x + ns[k - 1].w - D.sliceOverlapPx, ns[k].x);
  }
  assert.equal(ns.length, Math.ceil(120 / D.sliceWidthPx));
  assert.equal(ns.at(-1).x + ns.at(-1).w, 720 + 120, 'the last strip ends exactly at the picture edge');
  assert.ok(ns[0].depthY >= 300 && ns[0].depthY <= 304);
  assert.ok(ns.at(-1).depthY <= 330 && ns.at(-1).depthY > 325);
  assert.deepEqual(ns.map((n) => n.bgX), ns.map((n, k) => 156 + k * D.sliceWidthPx));
});

test('depth: flipped diagonal slices mirror depth', () => {
  const r = scene((raw) => { raw.objects.find((o) => o.id === 'cabinet-1').flipX = true; });
  const ns = nodesOf(r, 'cabinet-1');
  assert.ok(ns.length >= 2);
  for (let k = 1; k < ns.length; k++) assert.ok(ns[k].depthY < ns[k - 1].depthY, 'the deepest strip is on the left now');
  assert.ok(ns.every((n) => n.flipX));
  assert.equal(ns[0].bgX, 156 + 120 - ns[0].w, 'screen strip 0 shows the right part of the atlas picture');
});

test('depth: seated character sits between chair and desk', () => {
  const r = scene();
  const seat = r.seats[0];
  const chair = nodesOf(r, 'chair-1')[0];
  const desk = nodesOf(r, 'desk-1')[0];
  const z = charZ(seat.sitAt[1], D);
  assert.ok(z > chair.z, 'chair behind the seated character');
  assert.ok(z < desk.z, 'desk in front of the seated character');
  assert.ok(charZ(seat.at[1], D) < desk.z, 'standing at the seat is behind the desk too');
  assert.ok(charZ(r.lead.sitAt[1], D) < nodesOf(r, 'lead-desk-1')[0].z);
});

test('depth: character in front of the plant draws over it', () => {
  const plant = nodesOf(scene(), 'plant-1')[0];
  assert.ok(charZ(plant.depthY + 20, D) > plant.z);
  assert.ok(charZ(plant.depthY - 20, D) < plant.z);
  assert.ok(charZ(plant.depthY, D) > plant.z, 'same y: the character is in front');
});

test('depth: floor kind is below every character', () => {
  const r = scene((raw) => {
    raw.kinds.rug = { rect: [0, 0, 80, 56], anchor: [40, 56], depth: 'floor', blocks: true };
    raw.objects.push({ id: 'rug-1', kind: 'rug', at: [700, 450] });
  });
  const rug = nodesOf(r, 'rug-1')[0];
  assert.equal(rug.z, D.zBase - 1);
  assert.ok(rug.z < charZ(0, D));
  assert.equal(r.objects.find((o) => o.id === 'rug-1').blocks, false);
});

test('depth: overhead is below the front overlay', () => {
  const r = scene((raw) => {
    raw.kinds.lamp = { rect: [0, 0, 44, 70], anchor: [22, 70], depth: 'overhead' };
    raw.objects.push({ id: 'lamp-1', kind: 'lamp', at: [700, 200] });
  });
  const lamp = nodesOf(r, 'lamp-1')[0];
  assert.equal(lamp.z, D.frontZ - 1);
  assert.ok(lamp.z < D.frontZ);
  assert.ok(lamp.z > charZ(576, D));
});

test('depth: split cuts at a depth line and sets piece z', () => {
  const r = scene();
  const plant = nodesOf(r, 'plant-1')[0]; // front edge y 300
  const pieces = splitWalk([[640, 250], [640, 350]], objectNodes(r, D), D);
  assert.equal(pieces.length, 2);
  assert.deepEqual(pieces[0].to, pieces[1].from);
  assert.equal(pieces[0].to[1], plant.depthY);
  assert.ok(pieces[0].z < plant.z);
  assert.ok(pieces[1].z > plant.z);
  assert.deepEqual(pieces[0].from, [640, 250]);
  assert.deepEqual(pieces[1].to, [640, 350]);
});

test('depth: pick margin catches edge grazing', () => {
  const nodes = nodesOf(scene(), 'plant-1'); // plant picture spans x 618..662
  const walk = (x) => splitWalk([[x, 250], [x, 350]], nodes, D).length;
  assert.equal(walk(662 + 20), 2);
  assert.equal(walk(662 + 30), 1);
  assert.equal(walk(618 - 20), 2);
  assert.equal(walk(618 - 30), 1);
});

test('depth: split drops sub-pixel pieces', () => {
  const r = scene();
  assert.deepEqual(splitWalk([[100, 100], [100.5, 100]], objectNodes(r, D), D), []);
  const p = splitWalk([[100, 100], [100, 200], [100, 200.4]], [], D);
  assert.equal(p.length, 1);
  assert.deepEqual(p[0].to, [100, 200.4], 'a dropped tail extends the last piece to the true end');
});

test('web: code keeps to the no-frame-loop rule', () => {
  const dir = new URL('../web/', import.meta.url);
  for (const f of readdirSync(dir).filter((n) => /\.(js|mjs)$/.test(n))) {
    const src = readFileSync(new URL(f, dir), 'utf8');
    assert.ok(!/requestAnimationFrame|getContext\(|\.animate\(/.test(src), `${f} must not use a frame loop, canvas or element.animate`);
  }
});
