import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../server/config.mjs';
import { Office } from '../server/office.mjs';
import { createServer } from '../server/http.mjs';
import { loadSaved, saveSaved } from '../server/hidden.mjs';

const EMPTY = { hidden: [], names: {} };
const S = (id, o = {}) => ({
  provider: 'claude', pid: 100, sessionId: id, cwd: 'C:\\Project', status: 'busy', name: '', startedAt: 1000, ...o,
});

/** Starts a server on an ephemeral port; it is stopped when the test ends, pass or fail. */
async function start(t, { cfg = loadConfig(), sessions = [S('s1')], saved = EMPTY, hooks = {} } = {}) {
  const office = new Office(cfg, saved);
  office.syncSessions(sessions, 1000);
  const server = createServer(cfg, office, hooks);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  let stopping;
  const stop = () =>
    (stopping ??= new Promise((r) => {
      server.closeSse();
      server.close(r);
      server.closeAllConnections();
    }));
  t.after(stop);
  return { cfg, office, server, port, stop };
}

function req(ctx, method, path, { headers = {}, body, host, origin } = {}) {
  const h = { Host: host ?? `127.0.0.1:${ctx.port}`, ...headers };
  if (method === 'POST') h.Origin = origin ?? `http://127.0.0.1:${ctx.port}`;
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: ctx.port, method, path, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    r.on('error', reject);
    r.end(body);
  });
}

const post = (ctx, path, obj, o = {}) => req(ctx, 'POST', path, { body: JSON.stringify(obj), ...o });

test('server: health', async (t) => {
  const c = await start(t);
  const r = await req(c, 'GET', '/health');
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(r.body), { app: 'agent-office', pid: process.pid });
});

test('server: localhost host is accepted, wrong Host is 403', async (t) => {
  const c = await start(t);
  assert.equal((await req(c, 'GET', '/health', { host: `localhost:${c.port}` })).status, 200);
  assert.equal((await req(c, 'GET', '/health', { host: 'evil.example' })).status, 403);
  assert.equal((await req(c, 'GET', '/health', { host: `evil.example:${c.port}` })).status, 403);
  assert.equal((await req(c, 'GET', '/health', { host: '127.0.0.1' })).status, 403);
  assert.equal((await req(c, 'GET', '/api/state', { host: 'evil.example' })).status, 403);
});

test('server: cross-origin POST is 403', async (t) => {
  let saves = 0;
  const c = await start(t, { hooks: { onSavedChange: () => saves++ } });
  const r = await post(c, '/api/hide', { sessionId: 's1' }, { origin: 'http://evil.example' });
  assert.equal(r.status, 403);
  const noOrigin = await new Promise((resolve, reject) => {
    const q = http.request(
      { host: '127.0.0.1', port: c.port, method: 'POST', path: '/api/hide', headers: { Host: `127.0.0.1:${c.port}` } },
      (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); },
    );
    q.on('error', reject);
    q.end('{"sessionId":"s1"}');
  });
  assert.equal(noOrigin, 403);
  assert.equal(c.office.snapshot().floors.length, 1);
  assert.equal(saves, 0);
});

test('server: no CORS header on any response', async (t) => {
  const c = await start(t);
  const rs = [
    await req(c, 'GET', '/health'),
    await req(c, 'GET', '/api/state'),
    await req(c, 'GET', '/api/ui'),
    await req(c, 'GET', '/nope'),
    await req(c, 'GET', '/health', { host: 'evil.example' }),
    await post(c, '/api/hide', { sessionId: 'zzz' }),
    await post(c, '/api/rename', { sessionId: 's1', name: 'x' }, { origin: 'http://evil.example' }),
    await req(c, 'OPTIONS', '/api/state', { headers: { Origin: 'http://evil.example' } }),
  ];
  for (const r of rs) {
    assert.deepEqual(Object.keys(r.headers).filter((k) => k.startsWith('access-control-')), []);
  }
});

test('server: hide and rename persist across restart', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'saved-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cfg = loadConfig();
  let c;
  const hooks = { onSavedChange: () => saveSaved(dir, c.office.saved()) };
  c = await start(t, { cfg, sessions: [S('s1'), S('s2', { startedAt: 2000 })], hooks });
  assert.equal((await post(c, '/api/hide', { sessionId: 's1' })).status, 204);
  assert.equal((await post(c, '/api/rename', { sessionId: 's2', name: '내 층' })).status, 204);

  const saved = loadSaved(dir);
  assert.deepEqual(saved.hidden, [{ sessionId: 's1', pid: 100, startedAt: 1000 }]);
  assert.deepEqual(saved.names, { s2: '내 층' });
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(dir, 'hidden.json'), 'utf8'))[0]).sort(), ['pid', 'sessionId', 'startedAt']);

  const next = new Office(cfg, saved);
  next.syncSessions([S('s1'), S('s2', { startedAt: 2000 })], 5000);
  const floors = next.snapshot().floors;
  assert.deepEqual(floors.map((f) => [f.sessionId, f.title]), [['s2', '내 층']]);
});

test('server: hide of unknown session is 404; rename with oversized body is 400', async (t) => {
  const c = await start(t);
  assert.equal((await post(c, '/api/hide', { sessionId: 'nope' })).status, 404);
  assert.equal((await post(c, '/api/hide', { sessionId: 5 })).status, 400);
  assert.equal((await req(c, 'POST', '/api/rename', { body: '{not json' })).status, 400);
  assert.equal((await req(c, 'POST', '/api/rename', { body: '[]' })).status, 400);
  const big = JSON.stringify({ sessionId: 's1', name: 'x'.repeat(2000) });
  assert.equal((await req(c, 'POST', '/api/rename', { body: big })).status, 400);
  assert.equal(c.office.snapshot().floors[0].title, 'Project');
});

test('server: static path traversal is blocked', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'root-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'web'));
  mkdirSync(join(root, 'assets'));
  writeFileSync(join(root, 'config.json'), '{"secret":1}');
  writeFileSync(join(root, 'web', 'index.html'), '<h1>hi</h1>');
  writeFileSync(join(root, 'web', 'log.html'), '<h1>log</h1>');
  writeFileSync(join(root, 'web', 'app.js'), 'export {}');
  writeFileSync(join(root, 'assets', 'a.png'), Buffer.from([0x89, 0x50]));
  const c = await start(t, { cfg: { ...loadConfig(), root } });

  for (const p of ['/web/../config.json', '/web/%2e%2e/config.json', '/web/..%5Cconfig.json', '/assets/../config.json', '/web/%00', '/web/%zz', '/web/', '/web']) {
    const r = await req(c, 'GET', p);
    assert.equal(r.status, 404, p);
    assert.ok(!r.body.includes('secret'), p);
  }

  const index = await req(c, 'GET', '/');
  assert.equal(index.status, 200);
  assert.equal(index.body, '<h1>hi</h1>');
  assert.match(index.headers['content-type'], /^text\/html/);
  assert.equal(index.headers['cache-control'], undefined);
  assert.equal((await req(c, 'GET', '/log')).body, '<h1>log</h1>');
  const js = await req(c, 'GET', '/web/app.js');
  assert.match(js.headers['content-type'], /javascript/);
  assert.equal(js.headers['cache-control'], undefined);
  const png = await req(c, 'GET', '/assets/a.png');
  assert.equal(png.headers['content-type'], 'image/png');
  assert.equal(png.headers['cache-control'], 'max-age=3600');
});

test('server: / and /log are 404 when the page files do not exist', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'root-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const c = await start(t, { cfg: { ...loadConfig(), root } });
  assert.equal((await req(c, 'GET', '/')).status, 404);
  assert.equal((await req(c, 'GET', '/log')).status, 404);
});

test('server: api/state and api/ui', async (t) => {
  const c = await start(t);
  const state = JSON.parse((await req(c, 'GET', '/api/state')).body);
  assert.equal(state.floors.length, 1);
  assert.equal(state.floors[0].sessionId, 's1');
  const ui = JSON.parse((await req(c, 'GET', '/api/ui')).body);
  assert.equal(ui.spriteHeight, c.cfg.spriteHeight);
  assert.deepEqual(ui.layouts, c.cfg.layouts);
  assert.deepEqual(ui.ui, c.cfg.ui);
  assert.equal(ui.bubbleShowMs, c.cfg.agent.bubbleShowMs);
  assert.equal(ui.nameMaxChars, c.cfg.floor.nameMaxChars);
  assert.deepEqual(ui.roles.worker, { name: '서진', role: '개발' });
  assert.deepEqual(ui.roles.lead, { name: '유나', role: '팀장' });
  assert.deepEqual(ui.roles.default, { name: '나래', role: '지원' });
});

/** Opens /api/events and collects the raw text; `until(text)` resolves the wait. */
function sse(c, until) {
  return new Promise((resolve, reject) => {
    let text = '';
    const r = http.request({ host: '127.0.0.1', port: c.port, path: '/api/events', headers: { Host: `127.0.0.1:${c.port}` } }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (d) => {
        text += d;
        if (until(text)) { r.destroy(); resolve({ text, headers: res.headers, status: res.statusCode }); }
      });
    });
    r.on('error', (e) => { if (e.code !== 'ECONNRESET') reject(e); });
    r.end();
  });
}

const events = (text) =>
  text.split('\n\n').filter((b) => b.startsWith('event:')).map((b) => {
    const [ev, data] = b.split('\n');
    return [ev.slice(7), JSON.parse(data.slice(6))];
  });

test('server: SSE sends state then log on connect', async (t) => {
  const c = await start(t);
  c.office.syncAgents('s1', [], 1000);
  c.office.applySessionEvents('s1', [{ kind: 'tool', ts: 2000, toolUseId: 't1', name: 'Bash', text: '첫 작업' }, { kind: 'tool', ts: 3000, toolUseId: 't2', name: 'Bash', text: '둘째 작업' }], 3000);
  const r = await sse(c, (t) => t.includes('event: log'));
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /text\/event-stream/);
  const evs = events(r.text);
  assert.deepEqual(evs.map((e) => e[0]), ['state', 'log']);
  assert.equal(evs[0][1].floors.length, 1);
  assert.deepEqual(evs[1][1].map((e) => e.text), ['첫 작업', '둘째 작업']); // oldest first
});

test('server: SSE broadcasts state only on change, new log entries, and pings', async (t) => {
  const cfg = loadConfig({ server: { ssePingMs: 40 } });
  const c = await start(t, { cfg });
  const got = sse(c, (t) => t.includes(': ping') && t.includes('새 작업'));
  await new Promise((r) => setTimeout(r, 20));
  c.server.broadcast(); // nothing changed since connect: no state event
  c.office.applySessionEvents('s1', [{ kind: 'tool', ts: 5000, toolUseId: 't9', name: 'Bash', text: '새 작업' }], 5000);
  c.server.broadcast();
  const r = await got;
  const evs = events(r.text);
  assert.deepEqual(evs.map((e) => e[0]), ['state', 'log', 'state', 'log']);
  assert.equal(evs[2][1].floors[0].lead.bubble, '새 작업');
  assert.deepEqual(evs[3][1].map((e) => e.text), ['새 작업']);
});

test('server: closed SSE clients are dropped and stop() ends open streams', async (t) => {
  const c = await start(t);
  const done = sse(c, (text) => text.includes('event: log'));
  await done;
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(c.server.sseClients, 0);
  const open = http.request({ host: '127.0.0.1', port: c.port, path: '/api/events', headers: { Host: `127.0.0.1:${c.port}` } });
  const ended = new Promise((resolve) => open.on('response', (res) => { res.resume(); res.on('end', resolve); res.on('close', resolve); }));
  open.end();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(c.server.sseClients, 1);
  await c.stop();
  await ended;
});

test('server: shutdown replies 204 then calls onShutdown', async (t) => {
  let called = 0;
  const c = await start(t, { hooks: { onShutdown: () => called++ } });
  const r = await req(c, 'POST', '/api/shutdown', { body: '' });
  assert.equal(r.status, 204);
  await new Promise((r2) => setTimeout(r2, 20));
  assert.equal(called, 1);
  const bad = await req(c, 'POST', '/api/shutdown', { body: '', origin: 'http://evil.example' });
  assert.equal(bad.status, 403);
  assert.equal(called, 1);
});

test('server: /api/events is refused on a connection that outlives server.close()', async (t) => {
  const c = await start(t);
  const sock = net.connect(c.port, '127.0.0.1');
  t.after(() => sock.destroy());
  await new Promise((r) => sock.once('connect', r));
  sock.write(`GET /api/events HTTP/1.1\r\nHost: 127.0.0.1:${c.port}\r\n`); // request still being sent: not idle
  await new Promise((r) => setTimeout(r, 20));
  const closed = new Promise((r) => c.server.close(r));
  const reply = new Promise((resolve) => {
    let text = '';
    sock.on('data', (d) => { text += d; if (text.includes('\r\n\r\n')) resolve(text); });
  });
  sock.write('\r\n');
  assert.match(await reply, /^HTTP\/1\.1 503/);
  sock.destroy();
  await closed;
});

function logCtx(t, extra = {}) {
  return start(t, { sessions: [S('s1'), S('s2', { startedAt: 2000 })], ...extra }).then((c) => {
    c.office.syncAgents('s1', [], 1000);
    c.office.syncAgents('s2', [], 1000);
    c.office.applySessionEvents('s1', [{ kind: 'tool', ts: 2000, toolUseId: 't1', name: 'Bash', text: '에스원 작업' }], 2000);
    c.office.applySessionEvents('s2', [{ kind: 'tool', ts: 3000, toolUseId: 't2', name: 'Bash', text: '에스투 작업' }], 3000);
    return c;
  });
}

test('server: /api/log filters by session and excludes hidden', async (t) => {
  const c = await logCtx(t);
  const all = JSON.parse((await req(c, 'GET', '/api/log')).body);
  assert.deepEqual(all.map((e) => e.text), ['에스투 작업', '에스원 작업']); // newest first
  const one = JSON.parse((await req(c, 'GET', '/api/log?session=s1')).body);
  assert.deepEqual(one.map((e) => e.text), ['에스원 작업']);
  const name = one[0].name;
  assert.equal(JSON.parse((await req(c, 'GET', `/api/log?name=${encodeURIComponent(name)}`)).body).length >= 1, true);
  assert.deepEqual(JSON.parse((await req(c, 'GET', '/api/log?name=%EC%97%86%EC%9D%8C')).body), []);
  assert.equal((await req(c, 'GET', '/api/log', { host: 'evil.test' })).status, 403);
  await post(c, '/api/hide', { sessionId: 's1' });
  assert.deepEqual(JSON.parse((await req(c, 'GET', '/api/log')).body).map((e) => e.text), ['에스투 작업']);
  assert.deepEqual(JSON.parse((await req(c, 'GET', '/api/log?session=s1')).body), []);
});

test('server: /api/log rejects bad session id', async (t) => {
  const c = await logCtx(t);
  for (const bad of ['..', 'a%2Fb', 'a%20b', '%00', '.', '']) {
    assert.equal((await req(c, 'GET', `/api/log?session=${bad}`)).status, 400, bad);
  }
});

test('server: /api/log clamps limit', async (t) => {
  const cfg = loadConfig({ log: { pageLimit: 1 } });
  const c = await logCtx(t, { cfg });
  const n = async (q) => JSON.parse((await req(c, 'GET', `/api/log${q}`)).body).length;
  assert.equal(await n(''), 1); // default = log.pageLimit
  assert.equal(await n('?limit=abc'), 1);
  assert.equal(await n('?limit=0'), 1); // clamped up to 1
  assert.equal(await n('?limit=-5'), 1);
  assert.equal(await n('?limit=2'), 2);
  assert.equal(await n('?limit=999999'), 2); // all there is, capped by log.cap
});
