// The CEO room is read like the lobby (cfg.ceo), is never in designOrder, and a scenes folder without it simply has no CEO room.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { loadConfig } from '../server/config.mjs';
import { Office } from '../server/office.mjs';
import { createServer } from '../server/http.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodePng } from '../scripts/make-lit-sprites.mjs';
import { readPngSize } from '../server/scenes.mjs';
import { checkScene } from '../server/scene-check.mjs';
import { findPath, isOpen } from '../web/nav.mjs';
import { pointInPolys } from '../web/scene.mjs';
import { FIXTURE_SCENES, ROOT, cfg, namedScenesDir } from './helpers/fixture.mjs';

const EMPTY = { hidden: [], names: {} };

/** GET /api/ui of a server made from `cfg`; the server is stopped when the test ends. */
async function apiUi(t, cfg) {
  const office = new Office(cfg, EMPTY);
  const server = createServer(cfg, office, {});
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => {
    server.closeSse();
    server.close(r);
    server.closeAllConnections();
  }));
  const body = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: server.address().port, path: '/api/ui' }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    }).on('error', reject);
  });
  return JSON.parse(body);
}

test('no ceo folder: no ceo scene and the server config still loads', () => {
  const cfg = loadConfig({ scenesDir: FIXTURE_SCENES, designOrder: ['studio2'] });
  assert.equal(cfg.ceo.enabled, true); // switched on in config.json, but there is nothing to read
  assert.deepEqual(Object.keys(cfg.scenes), ['studio2']);
  const off = loadConfig({ scenesDir: namedScenesDir('studio2', 'ceo'), designOrder: ['studio2'], ceo: { enabled: false } });
  assert.deepEqual(Object.keys(off.scenes), ['studio2']); // switched off: a folder that is there is left alone
});

test('ceo is not in designOrder and /api/ui says ceo:null', async (t) => {
  assert.equal(loadConfig().designOrder.includes('ceo'), false);
  const none = await apiUi(t, loadConfig({ scenesDir: FIXTURE_SCENES, designOrder: ['studio2'] }));
  assert.equal(none.ceo, null);
  assert.deepEqual(Object.keys(none.scenes), ['studio2']);
  // with a ceo folder next to the rooms: read as a scene of its own, still not a floor design
  const cfg = loadConfig({ scenesDir: namedScenesDir('studio2', 'ceo'), designOrder: ['studio2'] });
  assert.deepEqual(cfg.designOrder, ['studio2']);
  const ui = await apiUi(t, cfg);
  assert.deepEqual(ui.ceo, { design: 'ceo' });
  assert.deepEqual(Object.keys(ui.scenes).sort(), ['ceo', 'studio2']);
  assert.equal(ui.scenes.ceo.url, '/scenes/ceo/');
});

// ---- the shipped ceo room (assets/scenes/ceo) ----
const SHIPPED_CEO = join(ROOT, 'assets', 'scenes', 'ceo');
const shippedRaw = () => JSON.parse(readFileSync(join(SHIPPED_CEO, 'scene.json'), 'utf8'));
const checked = () => checkScene(shippedRaw(), { atlasSize: readPngSize(join(SHIPPED_CEO, 'objects.png')), cfg });

test('the shipped ceo scene passes the scene checker with no seats, its pictures have the sizes scene.json promises', () => {
  const raw = shippedRaw();
  const res = checked();
  assert.deepEqual(res.errors, []);
  assert.equal(raw.minSeats, 0);
  assert.deepEqual(raw.seats, []);
  assert.equal(raw.lead.desk, 'ceo-desk');
  assert.ok(raw.kinds['ceo-chair'] && raw.kinds['ceo-desk'], 'the big leather chair and the desk are kinds of the scene');
  assert.deepEqual(raw.door, { at: raw.door.at, face: 'left' });
  assert.ok(raw.door.at[0] > raw.size[0] / 2, 'the door is on the right side of the room');
  assert.deepEqual(readPngSize(join(SHIPPED_CEO, raw.shell)), raw.size);
  for (const f of [raw.view.day, raw.view.night, 'sky-day.png', 'sky-night.png']) assert.deepEqual(readPngSize(join(SHIPPED_CEO, f)), raw.view.size, f);
});

test('the shipped assets: cfg.ceo reads the real room, designOrder keeps it out and /api/ui says ceo.design', async (t) => {
  const real = loadConfig();
  assert.equal(real.designOrder.includes('ceo'), false);
  assert.equal(real.scenes.ceo.raw.design, 'ceo');
  assert.equal(real.scenes.ceo.url, '/scenes/ceo/');
  const ui = await apiUi(t, real);
  assert.deepEqual(ui.ceo, { design: 'ceo' });
  assert.ok(ui.scenes.ceo && !real.designOrder.includes('ceo'));
});

test('costBoard.quad: four points inside the scene, wall-shaped, over the dark chalkboard of the shell picture', () => {
  const raw = shippedRaw();
  const q = raw.costBoard.quad;
  assert.equal(q.length, 4);
  for (const [x, y] of q) assert.ok(x >= 0 && x <= raw.size[0] && y >= 0 && y <= raw.size[1], `${x},${y}`);
  const [tl, tr, br, bl] = q;
  assert.ok(tr[0] > tl[0] && br[0] > bl[0] && bl[1] > tl[1] && br[1] > tr[1], 'top-left, top-right, bottom-right, bottom-left');
  assert.ok(Math.abs(tl[0] - bl[0]) <= 0.5 && Math.abs(tr[0] - br[0]) <= 0.5, 'vertical sides like a ledWall panel');
  assert.equal(q.some((p) => pointInPolys(p, raw.walkable)), false, 'the board hangs on the wall, not on the floor');
  const shell = decodePng(readFileSync(join(SHIPPED_CEO, raw.shell)));
  let dark = 0;
  let total = 0;
  for (let y = Math.ceil(tl[1]); y <= br[1]; y++) {
    for (let x = tl[0]; x <= tr[0]; x++) {
      const u = (x - tl[0]) / (tr[0] - tl[0]);
      if (y < tl[1] + (tr[1] - tl[1]) * u || y > bl[1] + (br[1] - bl[1]) * u) continue;
      const i = (y * shell.w + x) * 4;
      total++;
      if (0.299 * shell.rgba[i] + 0.587 * shell.rgba[i + 1] + 0.114 * shell.rgba[i + 2] <= 90) dark++;
    }
  }
  assert.ok(total > 1000 && dark === total, `${total - dark} of ${total} pixels inside the quad are not chalkboard (frame or wall)`);
});

test('visits: six places in a half circle in front of the desk, walkable, reachable from the door and a gap apart', () => {
  const raw = shippedRaw();
  const res = checked();
  assert.deepEqual(res.errors, []);
  assert.equal(raw.visits.length, 6);
  const desk = raw.objects.find((o) => o.id === 'ceo-desk');
  const blocked = [...raw.blocked, ...res.resolved.objects.filter((o) => o.blocks && o.footprint.length >= 3).map((o) => o.footprint)];
  raw.visits.forEach((v, i) => {
    assert.ok(['left', 'right'].includes(v.face), `visits[${i}].face`);
    assert.ok(pointInPolys(v.at, raw.walkable), `visits[${i}] is on the floor`);
    assert.equal(pointInPolys(v.at, blocked), false, `visits[${i}] is not under furniture`);
    assert.ok(isOpen(res.grid, v.at), `visits[${i}] is a free cell`);
    assert.ok(findPath(res.grid, raw.door.at, v.at, { snapRadiusCells: cfg.nav.snapRadiusCells }), `visits[${i}] is reachable from the door`);
    assert.ok(v.at[1] > desk.at[1], `visits[${i}] stands in front of the desk`);
    for (const w of raw.visits.slice(i + 1)) assert.ok(Math.hypot(v.at[0] - w.at[0], v.at[1] - w.at[1]) >= cfg.nav.arrivalGapPx, `visits[${i}] is a gap away from the others`);
  });
  const xs = raw.visits.map((v) => v.at[0]);
  assert.ok(Math.min(...xs) < desk.at[0] && Math.max(...xs) > desk.at[0], 'the half circle spreads to both sides of the desk');
});
