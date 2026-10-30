// Group E (ops) fixes: idle polling, anti-framing headers, data dir override, parse path clipping, launcher spawn options.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { loadConfig, pollDelayMs } from '../server/config.mjs';
import { createServer } from '../server/http.mjs';
import { parseLine } from '../server/parse.mjs';
import { readFileSync } from 'node:fs';
import { DETACHED_OPTIONS, detachedSpawn } from '../server/launch.mjs';

/** Minimal office double: counts snapshot() calls. */
function fakeOffice() {
  const o = {
    snapshots: 0,
    snapshot() { o.snapshots++; return { floors: [], seq: 0 }; },
    drainLog: () => [],
    drainSignals: () => [],
    queryLog: () => [],
  };
  return o;
}

async function start(t, hooks = {}) {
  const office = fakeOffice();
  const server = createServer(loadConfig(), office, hooks);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeSse(); server.close(); server.closeAllConnections(); });
  return { office, server, port: server.address().port };
}

const get = (port, p) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: p, headers: { Host: `127.0.0.1:${port}` } }, (res) => {
    res.resume();
    res.on('end', () => resolve(res));
  }).on('error', reject);
});

test('F26: idle interval applies only while no SSE client is connected', () => {
  const cfg = loadConfig();
  assert.ok(cfg.idlePollMs > cfg.pollMs);
  assert.equal(pollDelayMs(cfg, 0), cfg.idlePollMs);
  assert.equal(pollDelayMs(cfg, 2), cfg.pollMs);
});

test('F26: broadcast with no client skips the snapshot', async (t) => {
  const c = await start(t);
  const before = c.office.snapshots;
  c.server.broadcast();
  c.server.broadcast();
  assert.equal(c.office.snapshots, before);
});

test('F26: connecting an SSE client triggers onSseConnect', async (t) => {
  let n = 0;
  const c = await start(t, { onSseConnect: () => { n++; } });
  const req = http.get({ host: '127.0.0.1', port: c.port, path: '/api/events', headers: { Host: `127.0.0.1:${c.port}` } });
  t.after(() => req.destroy());
  await new Promise((r) => req.on('response', (res) => { res.once('data', r); }));
  assert.equal(n, 1);
});

test('F27: every response carries anti-framing headers', async (t) => {
  const c = await start(t);
  for (const p of ['/', '/health', '/api/state', '/nope']) {
    const res = await get(c.port, p);
    assert.equal(res.headers['x-frame-options'], 'DENY', p);
    assert.equal(res.headers['content-security-policy'], "frame-ancestors 'none'", p);
  }
});

test('F28: AGENT_OFFICE_DATA_DIR overrides the data folder', () => {
  const prev = process.env.AGENT_OFFICE_DATA_DIR;
  try {
    delete process.env.AGENT_OFFICE_DATA_DIR;
    const cfg = loadConfig();
    assert.equal(cfg.dataDir, path.join(cfg.root, 'data'));
    process.env.AGENT_OFFICE_DATA_DIR = 'X:/tmp-data';
    assert.equal(loadConfig().dataDir, 'X:/tmp-data');
  } finally { if (prev === undefined) delete process.env.AGENT_OFFICE_DATA_DIR; else process.env.AGENT_OFFICE_DATA_DIR = prev; }
});

const launchLine = (scriptPath) => JSON.stringify({
  type: 'user', timestamp: '2026-10-28T06:48:50.000Z', message: { content: [] },
  toolUseResult: { taskType: 'local_workflow', runId: 'wf_1', workflowName: 'w', scriptPath },
});

test('F34: a long scriptPath is kept whole (readable), not clipped to a dead path', () => {
  const long = `C:/${'d'.repeat(250)}/s.js`;
  const ev = parseLine(launchLine(long)).find((e) => e.kind === 'workflowLaunch');
  assert.equal(ev.scriptPath, long);
});

test('F34: an absurdly long scriptPath is dropped, not clipped', () => {
  const ev = parseLine(launchLine(`C:/${'d'.repeat(5000)}/s.js`)).find((e) => e.kind === 'workflowLaunch');
  assert.equal(ev.scriptPath, '');
});

test('T8A: detached spawns hide their console window', () => {
  assert.equal(DETACHED_OPTIONS.windowsHide, true);
  assert.equal(DETACHED_OPTIONS.detached, true);
});

test('T8A: detachedSpawn passes the hidden-window options to spawn', () => {
  const calls = [];
  detachedSpawn('cmd', ['/c'], (...a) => { calls.push(a); return { unref() {} }; });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][2].windowsHide, true);
});

test('T8A: main.mjs --open spawn uses DETACHED_OPTIONS', () => {
  const src = readFileSync(new URL('../server/main.mjs', import.meta.url), 'utf8');
  assert.match(src, /spawn\('cmd', \['\/c', 'start', '', url\], DETACHED_OPTIONS\)/);
});

test('F26: a new client never overwrites the last-sent state of an older one', async (t) => {
  let floors = [{ a: 1 }];
  const office = { snapshot: () => ({ floors, seq: 0 }), drainLog: () => [], drainSignals: () => [], queryLog: () => [] };
  const server = createServer(loadConfig(), office, {});
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeSse(); server.close(); server.closeAllConnections(); });
  const port = server.address().port;
  const connect = () => new Promise((resolve) => {
    const frames = [];
    const req = http.get({ host: '127.0.0.1', port, path: '/api/events', headers: { Host: `127.0.0.1:${port}` } }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (d) => frames.push(d));
      resolve({ frames, req });
    });
    t.after(() => req.destroy());
  });
  const a = await connect();
  await new Promise((r) => setTimeout(r, 50));
  floors = [{ a: 2 }];
  await connect();
  await new Promise((r) => setTimeout(r, 50));
  const before = a.frames.join('').split('event: state').length;
  server.broadcast();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(a.frames.join('').split('event: state').length, before + 1);
});
