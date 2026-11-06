import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../server/config.mjs';
import { LOBBY_ID, CEO_ID } from '../web/view.mjs';
import {
  BASEMENT_ID, ROOF_ID, blinkMs, buildingOrder, fitBuilding, floorScale, idleDim, insertSlot, layoutBuilding, pickLive, racksOn, slideDir, windowPic,
} from '../web/building.mjs';

const B = loadConfig().ui.building;
const ROWS = [{ id: CEO_ID, w: 1024, h: 512 }, { id: 'b', w: 1024, h: 576 }, { id: 'a', w: 1024, h: 512 }, { id: LOBBY_ID, w: 1280, h: 720 }];

test('building: every floor is scaled to the inner width, the lobby to 0.8', () => {
  assert.equal(floorScale(1024, B.innerW), 1);
  assert.equal(floorScale(1280, B.innerW), 0.8);
  const L = layoutBuilding(ROWS, B);
  assert.deepEqual(L.rows.map((r) => r.s), [1, 1, 1, 0.8]);
  assert.equal(L.rows[3].h, 576);
});

test('building: the total height is the roof, every floor and slab, and the basement', () => {
  const L = layoutBuilding(ROWS, B);
  assert.equal(L.outerW, B.facadePx + B.innerW + B.shaftPx);
  assert.equal(L.totalH, B.roofPx + (512 + 576 + 512 + 576) + 4 * B.slabPx + B.basementPx);
  assert.equal(L.rows[0].top, B.roofPx);
  assert.equal(L.rows[1].top, B.roofPx + 512 + B.slabPx);
  assert.equal(L.basement.top, L.totalH - B.basementPx);
});

test('building: the zoom is cut at maxZoom', () => {
  const L = layoutBuilding([ROWS[0]], B);
  const r = fitBuilding(99999, 99999, L.outerW, L.totalH, B);
  assert.equal(r.z, B.maxZoom);
  assert.equal(r.scroll, false);
});

test('building: the zoom is cut at minZoom and the building scrolls', () => {
  const L = layoutBuilding(ROWS, B);
  const r = fitBuilding(1400, 300, L.outerW, L.totalH, B);
  assert.equal(r.z, B.minZoom);
  assert.equal(r.scroll, true);
  const narrow = fitBuilding(200, 300, L.outerW, L.totalH, B); // never wider than the room
  assert.equal(narrow.z, 200 / L.outerW);
});

test('building: no scroll while the whole building fits', () => {
  const L = layoutBuilding(ROWS, B);
  const r = fitBuilding(1400, 3000, L.outerW, L.totalH, B);
  assert.ok(r.z >= B.minZoom && r.z <= B.maxZoom);
  assert.equal(r.scroll, false);
});

test('building: the order is roof, CEO room, floors high to low, lobby, basement', () => {
  const views = [{ sessionId: 'a', floorNo: 2 }, { sessionId: 'c', floorNo: 4 }, { sessionId: 'b', floorNo: 3 }];
  assert.deepEqual(buildingOrder(views), [ROOF_ID, CEO_ID, 'c', 'b', 'a', LOBBY_ID, BASEMENT_ID]);
  assert.deepEqual(buildingOrder([], { ceo: false, lobby: false }), [ROOF_ID, BASEMENT_ID]);
});

test('building: the live floors are the ones nearest to the middle of the view, at most maxLive', () => {
  const rows = Array.from({ length: 10 }, (_, i) => ({ id: `f${i}`, top: i * 500, h: 500 }));
  const live = pickLive(rows, { viewTop: 1000, viewH: 1500, z: 1, marginPx: 0, maxLive: 2 });
  assert.deepEqual([...live].sort(), ['f2', 'f3']);
  const all = pickLive(rows, { viewTop: 1000, viewH: 1500, z: 1, marginPx: 0, maxLive: 8 });
  assert.deepEqual([...all].sort(), ['f2', 'f3', 'f4']);
  assert.ok(!all.has('f9') && !all.has('f0'));
  const margin = pickLive(rows, { viewTop: 1000, viewH: 500, z: 0.5, marginPx: 200, maxLive: 8 }); // 200 screen px = 400 building px
  assert.ok(margin.has('f1') && margin.has('f3') && !margin.has('f4'));
});

test('building: the slide goes down to a higher floor and up to a lower one', () => {
  const order = buildingOrder([{ sessionId: 'a', floorNo: 1 }, { sessionId: 'b', floorNo: 2 }]);
  assert.equal(slideDir(order, 'a', 'b'), 'down');
  assert.equal(slideDir(order, 'b', 'a'), 'up');
  assert.equal(slideDir(order, LOBBY_ID, CEO_ID), 'down');
  assert.equal(slideDir(order, 'a', 'a'), null);
  assert.equal(slideDir(order, 'a', 'zz'), null);
});

test('building: a new floor goes right under the CEO room', () => {
  const order = buildingOrder([{ sessionId: 'a', floorNo: 1 }, { sessionId: 'n', floorNo: 2 }]);
  assert.equal(order[insertSlot(order)], 'n');
  assert.equal(insertSlot([ROOF_ID, LOBBY_ID, BASEMENT_ID]), 1);
});

test('building: lit racks follow the CPU and the blink period gets shorter with the load', () => {
  assert.equal(racksOn(0, B.basement.racks), 0);
  assert.equal(racksOn(50, B.basement.racks), 4);
  assert.equal(racksOn(100, B.basement.racks), B.basement.racks);
  assert.equal(racksOn(250, B.basement.racks), B.basement.racks);
  assert.equal(blinkMs(0, B.basement), B.basement.blinkSlowMs);
  assert.equal(blinkMs(100, B.basement), B.basement.blinkFastMs);
  assert.ok(blinkMs(50, B.basement) < B.basement.blinkSlowMs && blinkMs(50, B.basement) > B.basement.blinkFastMs);
});

test('building: no system sample means no lit rack', () => {
  assert.equal(racksOn(null, B.basement.racks), 0);
  assert.equal(racksOn(undefined, B.basement.racks), 0);
  assert.equal(racksOn(Number.NaN, B.basement.racks), 0);
});

test('building: at night only busy floors have lit windows (the lobby and the CEO room always)', () => {
  assert.equal(windowPic({ id: 's', status: 'busy' }, true), 'night-on');
  assert.equal(windowPic({ id: 's', status: 'waiting' }, true), 'night-off');
  assert.equal(windowPic({ id: 's', status: 'leaving' }, true), 'night-off');
  assert.equal(windowPic({ id: LOBBY_ID }, true), 'night-on');
  assert.equal(windowPic({ id: CEO_ID }, true), 'night-on');
  assert.equal(windowPic({ id: 's', status: 'idle' }, false), 'day');
  assert.equal(idleDim({ id: 's', status: 'waiting' }, true, B), B.idleNightDim);
  assert.equal(idleDim({ id: 's', status: 'busy' }, true, B), 0);
  assert.equal(idleDim({ id: 's', status: 'waiting' }, false, B), 0);
});
