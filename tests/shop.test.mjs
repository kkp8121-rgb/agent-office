import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../server/config.mjs';
import { Office } from '../server/office.mjs';
import { Shop } from '../server/shop.mjs';
import { createServer } from '../server/http.mjs';
import { resolveScene } from '../web/scene.mjs';
import { checkPlacement } from '../web/placement.mjs';

const HOUR = 3600000;
const NOW = 1_800_000_000_000;
const EMPTY = { hidden: [], names: {} };
const S = (id, o = {}) => ({ provider: 'claude', pid: 100, sessionId: id, cwd: 'C:\\Project', status: 'busy', name: '', startedAt: 1000, ...o });
const M = (id, o = {}) => ({ agentId: id, agentType: 'worker', description: '조사', finished: false, transcriptPath: '', mtimeMs: NOW, workflow: null, ...o });

function tmpCfg(t) {
  const dir = mkdtempSync(join(tmpdir(), 'shop-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { ...loadConfig(), dataDir: dir };
}
const newShop = (cfg, logs = []) => new Shop(cfg, { log: (m) => logs.push(m) });

/** An office whose finished agents are credited to `shop`, like main.mjs wires it. */
function wire(cfg, shop, provider = 'claude') {
  const o = new Office(cfg, EMPTY);
  o.onFinish = (info, now) => shop.credit(info, now);
  o.syncSessions([S('s1', { provider })], NOW);
  return o;
}

/** First spots on a 24px lattice where the shared rule says yes. */
function okSpots(cfg, design, item, n) {
  const r = resolveScene(cfg.scenes[design].raw);
  const kinds = new Map(cfg.shop.catalog.map((c) => [c.id, c]));
  const out = [];
  for (let y = 0; y < r.size[1] && out.length < n; y += 24) {
    for (let x = 0; x < r.size[0] && out.length < n; x += 24) if (checkPlacement(r, cfg.nav, kinds, [], { item, x, y }).ok) out.push([x, y]);
  }
  return out;
}
const rich = (shop, coins = 5000) => { shop.coins = coins; };

// ---- earning ----

test('shop: a new store starts with startCoins and is written at the first save', async (t) => {
  const cfg = tmpCfg(t);
  const shop = newShop(cfg);
  assert.equal(shop.coins, cfg.shop.startCoins);
  await shop.save();
  assert.equal(JSON.parse(readFileSync(join(cfg.dataDir, 'shop.json'), 'utf8')).coins, 50);
});

test('shop: an agent that works and finishes earns coinsPerAgent once, however often it is seen done', (t) => {
  const cfg = tmpCfg(t);
  const shop = newShop(cfg);
  const o = wire(cfg, shop);
  o.syncAgents('s1', [M('a1')], NOW);
  assert.equal(shop.coins, 50, 'running earns nothing');
  for (let k = 1; k <= 4; k++) o.syncAgents('s1', [M('a1', { finished: true })], NOW + k * 1000);
  assert.equal(shop.coins, 60);
  const ev = shop.drainEvents();
  assert.equal(ev.length, 1);
  assert.deepEqual(ev[0], { type: 'earn', amount: 10, coins: 60, sessionId: 's1', key: 's1:a1', live: true });
  // released after the linger time and listed done again: still once
  o.tick(NOW + 10 * 60000);
  o.syncAgents('s1', [M('a1', { finished: true })], NOW + 10 * 60000 + 1);
  assert.equal(shop.coins, 60);
});

test('shop: stale and abandoned agents earn nothing, the boss never earns', (t) => {
  const cfg = tmpCfg(t);
  const shop = newShop(cfg);
  const o = wire(cfg, shop);
  o.syncAgents('s1', [M('stale1'), M('gone1')], NOW);
  o.tick(NOW + cfg.agent.staleMs + 1000); // silent for too long
  assert.equal(o.snapshot().floors[0].agents.find((a) => a.agentId === 'stale1').state, 'stale');
  o.syncAgents('s1', [M('stale1'), M('gone1', { abandoned: true })], NOW + cfg.agent.staleMs + 2000);
  o.applySessionEvents('s1', [{ kind: 'end', ts: NOW + 1 }], NOW + 5); // the boss ends its turn
  assert.equal(shop.coins, 50);
  assert.equal(shop.drainEvents().length, 0);
  // a stale agent that really finishes later does earn
  o.syncAgents('s1', [M('stale1', { finished: true })], NOW + cfg.agent.staleMs + 3000);
  assert.equal(shop.coins, 60);
});

test('shop: a Codex sub-agent counts only on a real end, not when it merely went silent', (t) => {
  const cfg = tmpCfg(t);
  const shop = newShop(cfg);
  const o = wire(cfg, shop, 'codex');
  const C = (id, o2) => M(id, { agentType: 'codex:worker', ...o2 });
  o.syncAgents('s1', [C('c1')], NOW);
  o.syncAgents('s1', [C('c1', { finished: true, ended: false })], NOW + 1000); // silent: finished for the office, not for the shop
  assert.equal(shop.coins, 50);
  o.syncAgents('s1', [C('c1', { finished: true, ended: true })], NOW + 2000);
  assert.equal(shop.coins, 60, 'the real end arrives later and is still credited');
  assert.equal(shop.drainEvents()[0].key, 's1:c1');
});

test('shop: workflow agents earn like any sub-agent', (t) => {
  const cfg = tmpCfg(t);
  const shop = newShop(cfg);
  const o = wire(cfg, shop);
  const W = (id, f) => M(id, { finished: f, workflow: { runId: 'wf_1', phase: '조사', label: '조사' } });
  o.syncAgents('s1', [W('w1', false), W('w2', false)], NOW);
  o.syncAgents('s1', [W('w1', true), W('w2', true)], NOW + 1000);
  assert.equal(shop.coins, 70);
});

test('shop: the same agent id on another provider or session is a different credit', (t) => {
  const cfg = tmpCfg(t);
  const shop = newShop(cfg);
  shop.credit({ provider: 'claude', sessionId: 's1', agentId: 'x', mtimeMs: NOW, live: true }, NOW);
  shop.credit({ provider: 'codex', sessionId: 's1', agentId: 'x', mtimeMs: NOW, live: true }, NOW);
  shop.credit({ provider: 'claude', sessionId: 's2', agentId: 'x', mtimeMs: NOW, live: true }, NOW);
  assert.equal(shop.coins, 80);
});

test('shop: no double credit after a restart or when the startup backfill re-reads the finished agent', async (t) => {
  const cfg = tmpCfg(t);
  const shop = newShop(cfg);
  const o = wire(cfg, shop);
  o.syncAgents('s1', [M('a1')], NOW);
  o.syncAgents('s1', [M('a1', { finished: true })], NOW + 1000);
  await shop.save();
  assert.equal(shop.coins, 60);

  const shop2 = newShop(cfg); // restart
  assert.equal(shop2.coins, 60);
  const o2 = wire(cfg, shop2); // backfill: the office has never seen a1 and lists it done
  o2.syncAgents('s1', [M('a1', { finished: true })], NOW + 5000);
  o2.syncAgents('s1', [M('a1', { finished: true })], NOW + 9000);
  assert.equal(shop2.coins, 60);
});

test('shop: an agent that finished while the server was off is credited once, if recent', (t) => {
  const cfg = tmpCfg(t);
  const shop = newShop(cfg);
  const o = wire(cfg, shop);
  const recent = M('recent', { finished: true, mtimeMs: NOW - 2 * HOUR });
  o.syncAgents('s1', [recent, M('old', { finished: true, mtimeMs: NOW - 30 * HOUR }), M('nomtime', { finished: true, mtimeMs: 0 })], NOW);
  o.syncAgents('s1', [recent], NOW + 1000);
  assert.equal(shop.coins, 60, 'only the recent one');
});

test('shop: the credited set is bounded, and a pruned key cannot be paid again', (t) => {
  const cfg = tmpCfg(t);
  const shop = newShop(cfg);
  const keep = cfg.shop.creditKeepHours;
  assert.ok(keep >= cfg.shop.creditWindowHours, 'keep time covers the credit window');
  shop.credit({ provider: 'claude', sessionId: 's1', agentId: 'old', mtimeMs: NOW, live: false }, NOW);
  assert.equal(shop.coins, 60);
  // much later another agent is credited: the old key is pruned
  const later = NOW + (keep + 5) * HOUR;
  shop.credit({ provider: 'claude', sessionId: 's1', agentId: 'new', mtimeMs: later, live: false }, later);
  assert.deepEqual(Object.keys(shop.credited), ['claude:s1:new'], 'old key dropped, store stays small');
  assert.equal(shop.coins, 70);
  // the old agent still sits finished on disk with its old mtime: the window refuses it
  assert.equal(shop.credit({ provider: 'claude', sessionId: 's1', agentId: 'old', mtimeMs: NOW, live: false }, later + 1000), null);
  assert.equal(shop.coins, 70);
});

test('shop: a hidden floor still earns but its event names no floor', (t) => {
  const cfg = tmpCfg(t);
  const shop = newShop(cfg);
  shop.credit({ provider: 'claude', sessionId: 's1', agentId: 'a', mtimeMs: NOW, live: true, hidden: true }, NOW);
  const [e] = shop.drainEvents();
  assert.equal(e.sessionId, null);
  assert.equal(e.key, null);
});

// ---- store file ----

test('shop: a corrupt file is moved aside, logged, and the store starts fresh', (t) => {
  const cfg = tmpCfg(t);
  writeFileSync(join(cfg.dataDir, 'shop.json'), '{"coins": 9999, "inv', 'utf8');
  const logs = [];
  const shop = newShop(cfg, logs);
  assert.equal(shop.coins, 50);
  assert.equal(existsSync(join(cfg.dataDir, 'shop.json')), false);
  const aside = readdirSync(cfg.dataDir).filter((n) => n.startsWith('shop.corrupt-'));
  assert.equal(aside.length, 1);
  assert.equal(readFileSync(join(cfg.dataDir, aside[0]), 'utf8'), '{"coins": 9999, "inv', 'the old bytes are kept');
  assert.ok(logs.some((m) => m.includes('깨져')));
});

test('shop: a file of the wrong shape counts as corrupt too', (t) => {
  const cfg = tmpCfg(t);
  writeFileSync(join(cfg.dataDir, 'shop.json'), JSON.stringify({ version: 1, coins: -5, inventory: {}, placed: {}, credited: {} }), 'utf8');
  const shop = newShop(cfg, []);
  assert.equal(shop.coins, 50);
  assert.equal(readdirSync(cfg.dataDir).filter((n) => n.startsWith('shop.corrupt-')).length, 1);
});

test('shop: save is atomic (no temp file left) and a reload gives the same state', async (t) => {
  const cfg = tmpCfg(t);
  const shop = newShop(cfg);
  rich(shop);
  shop.buy('plant-small');
  const [[x, y]] = okSpots(cfg, 'studio2', 'plant-small', 1);
  const placed = shop.place('plant-small', 'studio2', x, y);
  assert.ok(placed.ok);
  shop.credit({ provider: 'claude', sessionId: 's1', agentId: 'a', mtimeMs: NOW, live: true }, NOW);
  await shop.save();
  assert.deepEqual(readdirSync(cfg.dataDir), ['shop.json']);
  const again = newShop(cfg);
  assert.deepEqual(again.view(), shop.view());
  assert.equal(again.credit({ provider: 'claude', sessionId: 's1', agentId: 'a', mtimeMs: NOW, live: true }, NOW), null);
  // a new uid never reuses an old one
  again.buy('plant-small');
  const [, spot2] = okSpots(cfg, 'studio2', 'plant-small', 2);
  assert.notEqual(again.place('plant-small', 'studio2', ...spot2).uid, placed.uid);
});

// ---- buying and placing ----

test('shop: buy needs coins and a known item', (t) => {
  const cfg = tmpCfg(t);
  const shop = newShop(cfg);
  const v0 = shop.version;
  assert.equal(shop.buy('arcade').code, 'no-coins');
  assert.equal(shop.buy('nope').code, 'unknown-item');
  assert.equal(shop.buy(42).code, 'unknown-item');
  assert.equal(shop.buy('__proto__').code, 'unknown-item');
  assert.equal(shop.version, v0, 'a refusal changes nothing');
  assert.equal(shop.buy('plant-small').ok, true);
  assert.equal(shop.coins, 20);
  assert.deepEqual(shop.inventory, { 'plant-small': 1 });
  assert.equal(shop.buy('plant-small').code, 'no-coins', '30 > 20');
});

test('shop: place, move and store keep the box and the room in step', (t) => {
  const cfg = tmpCfg(t);
  const shop = newShop(cfg);
  rich(shop);
  shop.buy('plant-small');
  const [a, b] = okSpots(cfg, 'studio2', 'plant-small', 2);
  const p = shop.place('plant-small', 'studio2', a[0], a[1]);
  assert.ok(p.ok);
  assert.deepEqual(shop.inventory, {});
  assert.deepEqual(shop.view().placed.studio2, [{ uid: p.uid, item: 'plant-small', x: a[0], y: a[1] }]);
  assert.ok(shop.move(p.uid, b[0], b[1]).ok);
  assert.deepEqual(shop.view().placed.studio2[0], { uid: p.uid, item: 'plant-small', x: b[0], y: b[1] });
  assert.ok(shop.move(p.uid, b[0], b[1]).ok, 'moving onto its own spot is fine (it does not collide with itself)');
  assert.ok(shop.store(p.uid).ok);
  assert.deepEqual(shop.view().placed.studio2, []);
  assert.deepEqual(shop.inventory, { 'plant-small': 1 });
  assert.equal(shop.coins, 5000 - 30, 'storing refunds nothing and costs nothing');
});

test('shop: place and move rejections', (t) => {
  const cfg = tmpCfg(t);
  const shop = newShop(cfg);
  rich(shop);
  assert.equal(shop.place('plant-small', 'studio2', 100, 100).code, 'not-owned');
  shop.buy('plant-small');
  shop.buy('plant-small');
  const [a] = okSpots(cfg, 'studio2', 'plant-small', 1);
  assert.equal(shop.place('nope', 'studio2', a[0], a[1]).code, 'unknown-item');
  assert.equal(shop.place('plant-small', 'attic', a[0], a[1]).code, 'unknown-design');
  assert.equal(shop.place('plant-small', '__proto__', a[0], a[1]).code, 'unknown-design');
  for (const bad of [NaN, Infinity, '12', null, undefined]) assert.equal(shop.place('plant-small', 'studio2', bad, 100).code, 'bad-position', String(bad));
  assert.equal(shop.place('plant-small', 'studio2', -5, 100).code, 'bad-position');
  assert.equal(shop.place('plant-small', 'studio2', 100, 99999).code, 'bad-position');
  assert.equal(shop.place('plant-small', 'studio2', 2, 2).code, 'off-floor');
  assert.deepEqual(shop.inventory, { 'plant-small': 2 }, 'rejections keep the box');
  assert.deepEqual(shop.placed.studio2, []);
  const p = shop.place('plant-small', 'studio2', a[0], a[1]);
  assert.equal(shop.place('plant-small', 'studio2', a[0], a[1]).code, 'overlap', 'two plants cannot share a spot');
  assert.equal(shop.move('nope', 10, 10).code, 'unknown-uid');
  assert.equal(shop.move(p.uid, 2, 2).code, 'off-floor');
  assert.equal(shop.move(p.uid, NaN, 5).code, 'bad-position');
  assert.deepEqual(shop.placed.studio2[0], { uid: p.uid, item: 'plant-small', x: a[0], y: a[1] }, 'a refused move leaves it where it was');
  assert.equal(shop.store('nope').code, 'unknown-uid');
  assert.equal(shop.store(7).code, 'unknown-uid');
});

test('shop: a room holds at most maxPerRoom items', (t) => {
  const cfg = tmpCfg(t);
  cfg.shop = { ...cfg.shop, maxPerRoom: 1 };
  const shop = newShop(cfg);
  rich(shop);
  shop.buy('rug');
  shop.buy('rug');
  const [a, b] = okSpots(cfg, 'studio2', 'rug', 2);
  assert.ok(shop.place('rug', 'studio2', ...a).ok);
  assert.equal(shop.place('rug', 'studio2', ...b).code, 'room-full');
});

// ---- the shared placement rule ----

test('placement: studio2 samples - a blocking item at a seat approach is refused, a rug on the same spot is not', (t) => {
  const cfg = tmpCfg(t);
  const r = resolveScene(cfg.scenes.studio2.raw);
  const kinds = new Map(cfg.shop.catalog.map((c) => [c.id, c]));
  const at = (item, x, y, placed = []) => checkPlacement(r, cfg.nav, kinds, placed, { item, x, y });
  const [ax, ay] = r.seats[0].approach;
  const onSeat = at('plant-small', ax, ay + 3);
  assert.equal(onSeat.ok, false);
  assert.match(onSeat.code, /covers-slot|blocks-path|overlap/);
  assert.equal(at('rug', ax, ay + 3).ok, true, 'a rug is flat: it may lie on a seat approach');
  let found = null; // a spot a plant cannot take because of the walk, but a rug can
  for (let y = 0; y < r.size[1] && !found; y += 12) {
    for (let x = 0; x < r.size[0] && !found; x += 12) if (at('plant-small', x, y).code === 'blocks-path' && at('rug', x, y).ok) found = [x, y];
  }
  assert.ok(found, 'such a spot exists');
  assert.equal(at('plant-small', 648, 156).ok, true);
  assert.equal(at('plant-small', 3, 3).code, 'off-floor');
  assert.equal(at('plant-small', 336, 192).code, 'covers-slot');
});

test('placement: a flat rug never blocks the walk, so a plant is judged the same with rugs on the floor', (t) => {
  const cfg = tmpCfg(t);
  const shop = newShop(cfg);
  rich(shop);
  for (let i = 0; i < 4; i++) shop.buy('rug');
  for (const [x, y] of okSpots(cfg, 'studio2', 'rug', 4)) assert.ok(shop.place('rug', 'studio2', x, y).ok);
  const r = resolveScene(cfg.scenes.studio2.raw);
  const kinds = new Map(cfg.shop.catalog.map((c) => [c.id, c]));
  const plant = { item: 'plant-small', x: 648, y: 156 };
  const empty = checkPlacement(r, cfg.nav, kinds, [], plant);
  const withRugs = checkPlacement(r, cfg.nav, kinds, shop.placed.studio2, plant);
  assert.deepEqual(withRugs, empty);
  assert.equal(withRugs.ok, true);
});

test('placement: furniture already standing counts when the next piece is judged', (t) => {
  const cfg = tmpCfg(t);
  const r = resolveScene(cfg.scenes.studio2.raw);
  const kinds = new Map(cfg.shop.catalog.map((c) => [c.id, c]));
  const standing = [{ uid: 'd1', item: 'sofa', x: 684, y: 168 }];
  assert.equal(checkPlacement(r, cfg.nav, kinds, [], { item: 'sofa', x: 684, y: 168 }).ok, true);
  assert.equal(checkPlacement(r, cfg.nav, kinds, standing, { item: 'plant-small', x: 684, y: 168 }).code, 'overlap');
});

test('placement: every shipped design has plant spots and refuses off-floor corners', (t) => {
  const cfg = tmpCfg(t);
  const kinds = new Map(cfg.shop.catalog.map((c) => [c.id, c]));
  for (const d of cfg.designOrder) {
    const r = resolveScene(cfg.scenes[d].raw);
    assert.equal(okSpots(cfg, d, 'plant-small', 1).length, 1, d);
    assert.equal(checkPlacement(r, cfg.nav, kinds, [], { item: 'plant-small', x: 1, y: 1 }).ok, false);
  }
});

// ---- HTTP ----

async function start(t, { sessions = [S('s1')] } = {}) {
  const cfg = tmpCfg(t);
  const office = new Office(cfg, EMPTY);
  office.syncSessions(sessions, NOW);
  const shop = newShop(cfg);
  office.onFinish = (info, now) => shop.credit(info, now);
  let saves = 0;
  const server = createServer(cfg, office, { shop, onShopChange: async () => { saves++; await shop.save(); } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const ctx = { cfg, office, shop, server, port: server.address().port, saves: () => saves };
  t.after(() => new Promise((r) => { server.closeSse(); server.close(r); server.closeAllConnections(); }));
  return ctx;
}

function req(ctx, method, path, { body, host, origin } = {}) {
  const h = { Host: host ?? `127.0.0.1:${ctx.port}` };
  if (method === 'POST') h.Origin = origin ?? `http://127.0.0.1:${ctx.port}`;
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: ctx.port, method, path, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    r.on('error', reject);
    r.end(body);
  });
}
const post = (ctx, path, obj, o = {}) => req(ctx, 'POST', path, { body: typeof obj === 'string' ? obj : JSON.stringify(obj), ...o });

/** Collects SSE frames {event, data} until stopped. */
function listen(ctx) {
  const frames = [];
  let buf = '';
  const r = http.request({ host: '127.0.0.1', port: ctx.port, path: '/api/events', headers: { Host: `127.0.0.1:${ctx.port}` } }, (res) => {
    res.setEncoding('utf8');
    res.on('data', (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = /^event: (.+)$/m.exec(raw)?.[1];
        const data = /^data: (.+)$/m.exec(raw)?.[1];
        if (ev) frames.push({ event: ev, data: JSON.parse(data) });
      }
    });
  });
  r.on('error', () => {});
  r.end();
  return { frames, stop: () => r.destroy() };
}
const until = async (fn, ms = 2000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  assert.fail('timed out');
};

test('http: GET /api/shop shows coins, box, placed furniture and the catalog', async (t) => {
  const c = await start(t);
  const r = await req(c, 'GET', '/api/shop');
  assert.equal(r.status, 200);
  const j = JSON.parse(r.body);
  assert.equal(j.coins, 50);
  assert.deepEqual(j.inventory, {});
  assert.deepEqual(Object.keys(j.placed).sort(), [...c.cfg.designOrder].sort());
  assert.equal(j.catalog.length, 11);
  assert.deepEqual(j.catalog.find((i) => i.id === 'rug'), { id: 'rug', name: '러그', price: 70, blocks: false, footprint: [[-40, -16], [40, -16], [40, 0], [-40, 0]] });
  assert.equal(JSON.stringify(j).includes('credited'), false, 'credit keys stay private');
});

test('http: buy, place, move and store round trip with a saved file', async (t) => {
  const c = await start(t);
  c.shop.coins = 500;
  let r = await post(c, '/api/shop/buy', { item: 'plant-small' });
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(r.body).shop.coins, 470);
  const [a, b] = okSpots(c.cfg, 'studio2', 'plant-small', 2);
  r = await post(c, '/api/shop/place', { item: 'plant-small', design: 'studio2', x: a[0], y: a[1] });
  assert.equal(r.status, 200);
  const { uid } = JSON.parse(r.body);
  assert.match(uid, /^d\d+$/);
  r = await post(c, '/api/shop/move', { uid, x: b[0], y: b[1] });
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(readFileSync(join(c.cfg.dataDir, 'shop.json'), 'utf8')).placed.studio2, [{ uid, item: 'plant-small', x: b[0], y: b[1] }]);
  r = await post(c, '/api/shop/store', { uid });
  assert.deepEqual(JSON.parse(r.body).shop.inventory, { 'plant-small': 1 });
  assert.equal(c.saves(), 4);
});

test('http: rejections carry a Korean message and a status, and save nothing', async (t) => {
  const c = await start(t);
  const bad = async (path, obj, status, code) => {
    const r = await post(c, path, obj);
    assert.equal(r.status, status, `${path} ${JSON.stringify(obj)}`);
    const j = JSON.parse(r.body);
    assert.equal(j.ok, false);
    assert.equal(j.code, code);
    assert.match(j.message, /[가-힣]/);
  };
  await bad('/api/shop/buy', { item: 'arcade' }, 409, 'no-coins');
  await bad('/api/shop/buy', { item: 'zzz' }, 400, 'unknown-item');
  await bad('/api/shop/buy', {}, 400, 'unknown-item');
  await bad('/api/shop/place', { item: 'rug', design: 'studio2', x: 100, y: 100 }, 409, 'not-owned');
  await bad('/api/shop/place', { item: 'rug', design: 'attic', x: 100, y: 100 }, 400, 'unknown-design');
  await bad('/api/shop/move', { uid: 'd99', x: 1, y: 1 }, 404, 'unknown-uid');
  await bad('/api/shop/store', { uid: 'd99' }, 404, 'unknown-uid');
  await bad('/api/shop/buy', '[1]', 400, 'bad-request');
  await bad('/api/shop/buy', 'not json', 400, 'bad-request');
  assert.equal((await post(c, '/api/shop/nope', {})).status, 404);
  assert.equal(c.saves(), 0);
});

test('http: shop POSTs are protected like hide and rename (Origin, Host, body size)', async (t) => {
  const c = await start(t);
  const body = { item: 'plant-small' };
  assert.equal((await post(c, '/api/shop/buy', body, { origin: 'http://evil.example' })).status, 403);
  assert.equal((await post(c, '/api/shop/buy', body, { origin: `http://127.0.0.1:${c.port + 1}` })).status, 403);
  assert.equal((await post(c, '/api/shop/buy', body, { host: 'evil.example' })).status, 403);
  const noOrigin = await new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: c.port, method: 'POST', path: '/api/shop/buy', headers: { Host: `127.0.0.1:${c.port}` } }, (res) => { res.resume(); resolve(res.statusCode); });
    r.on('error', reject);
    r.end(JSON.stringify(body));
  });
  assert.equal(noOrigin, 403);
  assert.equal((await post(c, '/api/shop/buy', { item: 'x'.repeat(5000) })).status, 400, 'oversized body');
  assert.equal((await req(c, 'GET', '/api/shop', { host: 'evil.example' })).status, 403);
  assert.equal(c.shop.coins, 50);
  assert.deepEqual(c.shop.inventory, {});
  assert.equal(c.saves(), 0);
});

test('http: SSE sends the shop on connect, a shop frame per change and an earn frame per credit', async (t) => {
  const c = await start(t);
  const sse = listen(c);
  t.after(() => sse.stop());
  await until(() => sse.frames.some((f) => f.event === 'shop'));
  assert.equal(sse.frames.find((f) => f.event === 'shop').data.coins, 50);

  // an agent finishes -> the next broadcast sends coins + earn
  c.office.syncAgents('s1', [M('a1')], NOW);
  c.office.syncAgents('s1', [M('a1', { finished: true })], NOW + 1000);
  c.server.broadcast();
  await until(() => sse.frames.some((f) => f.event === 'earn'));
  const earn = sse.frames.find((f) => f.event === 'earn').data;
  assert.deepEqual(earn, { type: 'earn', amount: 10, coins: 60, sessionId: 's1', key: 's1:a1', live: true });
  await until(() => sse.frames.filter((f) => f.event === 'shop').at(-1).data.coins === 60);

  // a purchase pushes the new state without waiting for a poll round
  const n = sse.frames.filter((f) => f.event === 'shop').length;
  await post(c, '/api/shop/buy', { item: 'plant-small' });
  await until(() => sse.frames.filter((f) => f.event === 'shop').length > n);
  const last = sse.frames.filter((f) => f.event === 'shop').at(-1).data;
  assert.equal(last.coins, 30);
  assert.deepEqual(last.inventory, { 'plant-small': 1 });

  // nothing changed: broadcast sends no further frame, and the earn is not repeated
  const total = sse.frames.length;
  c.server.broadcast();
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(sse.frames.length, total);
});

test('http: without a shop the shop routes do not exist', async (t) => {
  const cfg = tmpCfg(t);
  const office = new Office(cfg, EMPTY);
  const server = createServer(cfg, office, {});
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => { server.close(r); server.closeAllConnections(); }));
  const ctx = { port: server.address().port };
  assert.equal((await req(ctx, 'GET', '/api/shop')).status, 404);
  assert.equal((await post(ctx, '/api/shop/buy', { item: 'rug' })).status, 404);
});

test('shop: the state snapshot keeps its shape (no shop fields leak in)', (t) => {
  const cfg = tmpCfg(t);
  const shop = newShop(cfg);
  const o = wire(cfg, shop);
  o.syncAgents('s1', [M('a1')], NOW);
  o.syncAgents('s1', [M('a1', { finished: true })], NOW + 1000);
  const snap = o.snapshot();
  assert.deepEqual(Object.keys(snap), ['floors', 'now']);
  assert.equal(JSON.stringify(snap).includes('coins'), false);
});
