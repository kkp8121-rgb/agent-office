// The CEO room is read like the lobby (cfg.ceo), is never in designOrder, and a scenes folder without it simply has no CEO room.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { loadConfig } from '../server/config.mjs';
import { Office } from '../server/office.mjs';
import { createServer } from '../server/http.mjs';
import { FIXTURE_SCENES, namedScenesDir } from './helpers/fixture.mjs';

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
