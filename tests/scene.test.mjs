import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkSceneFormat, resolveScene, trayPoint, overflowPoint, distToPolyEdge, distToUnionEdge, pointInPolys } from '../web/scene.mjs';
import { fixtureRaw, FORMAT_OPTS, cfg } from './helpers/fixture.mjs';

test('scene: fixture passes format check', () => {
  assert.deepEqual(checkSceneFormat(fixtureRaw(), FORMAT_OPTS), []);
});

test('scene: format errors name the field', () => {
  const bad = (edit) => {
    const raw = fixtureRaw();
    edit(raw);
    return checkSceneFormat(raw, FORMAT_OPTS);
  };
  assert.match(bad((r) => { r.seats[0] = 'no-such-desk'; })[0], /^seats\[0\]/);
  assert.ok(bad((r) => { r.kinds.desk.rect = [400, 0, 80, 56]; }).some((e) => /rect/.test(e)));
  assert.ok(bad((r) => { r.spots.pop(); }).some((e) => /^spots/.test(e)));
  assert.ok(bad((r) => { r.objects[1].id = 'desk-1'; }).some((e) => /id/.test(e)));
  assert.ok(bad((r) => { r.door.at = [1004, 420]; }).some((e) => /^door/.test(e)));
  assert.ok(bad((r) => { r.tray.queue.pop(); }).some((e) => /^tray\.queue/.test(e)));
  assert.ok(bad((r) => { r.spots[1].kind = 'disco'; }).some((e) => /kind/.test(e)));
});

test('scene: seat count follows minSeats (default 12)', () => {
  const raw = fixtureRaw();
  delete raw.minSeats;
  assert.ok(checkSceneFormat(raw, { ...FORMAT_OPTS, minSeats: undefined }).some((e) => /^seats/.test(e)));
});

test('scene: resolve flips footprint and seat for flipX', () => {
  const raw = fixtureRaw();
  raw.objects.find((o) => o.id === 'cabinet-1').flipX = true;
  raw.objects.find((o) => o.id === 'desk-1').flipX = true;
  const r = resolveScene(raw);
  const cab = r.objects.find((o) => o.id === 'cabinet-1');
  const plain = resolveScene(fixtureRaw()).objects.find((o) => o.id === 'cabinet-1');
  plain.footprint.forEach((p, i) => {
    assert.equal(cab.footprint[i][0], 2 * cab.at[0] - p[0]);
    assert.equal(cab.footprint[i][1], p[1]);
  });
  const seat = r.seats[0];
  const desk = r.objects.find((o) => o.id === 'desk-1');
  assert.equal(seat.visit[0], desk.at[0] - 66); // dx +66 mirrored
  assert.equal(seat.face, 'left');
  assert.equal(resolveScene(fixtureRaw()).seats[0].visit[0], desk.at[0] + 66);
});

test('scene: sitAt defaults to at, visit/pair default to null', () => {
  const raw = fixtureRaw();
  delete raw.kinds.desk.seat.sitAt;
  delete raw.kinds.desk.seat.visit;
  delete raw.lead.sitAt;
  const r = resolveScene(raw);
  assert.deepEqual(r.seats[0].sitAt, r.seats[0].at);
  assert.equal(r.seats[0].visit, null);
  assert.deepEqual(r.lead.sitAt, r.lead.at);
  assert.equal(r.spots.find((s) => s.id === 'window').pair, null);
  assert.ok(Array.isArray(r.spots.find((s) => s.id === 'coffee').pair));
});

test('scene: tray queue lifts rows past n', () => {
  const r = resolveScene(fixtureRaw());
  const q = r.tray.queue;
  assert.deepEqual(trayPoint(r, 3, 28), q[3]);
  assert.deepEqual(trayPoint(r, 12, 28), [q[0][0], q[0][1] - 28]);
  assert.deepEqual(trayPoint(r, 25, 28), [q[1][0], q[1][1] - 56]);
});

test('scene: overflow ring pushes away from room centre', () => {
  const r = resolveScene(fixtureRaw());
  const centre = [r.size[0] / 2, r.size[1] / 2];
  const o = overflowPoint(r, 8, 28);
  const base = r.overflow[0].at;
  const d = (p) => Math.hypot(p[0] - centre[0], p[1] - centre[1]);
  assert.equal(o.ring, 1);
  assert.ok(Math.abs(d(o.at) - d(base) - 28) < 1e-6);
  assert.deepEqual(overflowPoint(r, 3, 28), { at: r.overflow[3].at, ring: 0 });
});

test('scene: union edge distance ignores edges inside another polygon', () => {
  const polys = [[[0, 0], [100, 0], [100, 100], [0, 100]], [[50, 0], [200, 0], [200, 100], [50, 100]]];
  assert.ok(pointInPolys([90, 50], polys));
  assert.equal(Math.round(distToPolyEdge([90, 50], polys[0])), 10);
  assert.equal(distToUnionEdge([90, 50], polys), 50);
});

test('scene: shipped config blocks match the plan', () => {
  assert.equal(cfg.sitHeight, 50);
  assert.equal(cfg.nav.cellPx, 8);
  assert.equal(cfg.depth.frontZ, 7000);
  assert.equal(cfg.ui.ambient.maxAway, 2);
});
