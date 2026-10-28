import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { decide, probe, launch } from '../server/launch.mjs';

test('decide: our app answering -> open', () => {
  assert.equal(decide({ up: true, body: { app: 'agent-office', pid: 1 } }), 'open');
});
test('decide: no answer -> start', () => {
  assert.equal(decide({ up: false }), 'start');
});
test('decide: foreign or unreadable answer -> conflict', () => {
  assert.equal(decide({ up: true, body: { app: 'other' } }), 'conflict');
  assert.equal(decide({ up: true, body: null }), 'conflict');
  assert.equal(decide({ up: true, body: 'x' }), 'conflict');
});

function listen(handler) {
  return new Promise((resolve) => {
    const s = http.createServer(handler).listen(0, '127.0.0.1', () => resolve(s));
  });
}

test('probe: foreign /health body -> conflict', async () => {
  const s = await listen((req, res) => { res.end(JSON.stringify({ app: 'something-else' })); });
  try {
    const r = await probe(s.address().port, 800);
    assert.equal(decide(r), 'conflict');
  } finally { s.close(); s.closeAllConnections(); }
});
test('probe: non-JSON answer -> conflict', async () => {
  const s = await listen((req, res) => { res.end('<html>hi</html>'); });
  try {
    assert.equal(decide(await probe(s.address().port, 800)), 'conflict');
  } finally { s.close(); s.closeAllConnections(); }
});
test('probe: our /health body -> open, and carries the pid', async () => {
  const s = await listen((req, res) => { res.end(JSON.stringify({ app: 'agent-office', pid: 4242 })); });
  try {
    const r = await probe(s.address().port, 800);
    assert.equal(decide(r), 'open');
    assert.equal(r.body.pid, 4242);
  } finally { s.close(); s.closeAllConnections(); }
});
test('probe: closed port -> start', async () => {
  const s = await listen((req, res) => res.end());
  const port = s.address().port;
  await new Promise((r) => s.close(r));
  assert.equal(decide(await probe(port, 800)), 'start');
});
test('probe: hung server times out -> start-side "down" result', async () => {
  const s = await listen(() => { /* never answers */ });
  try {
    const r = await probe(s.address().port, 150);
    assert.equal(r.up, false);
  } finally { s.close(); s.closeAllConnections(); }
});

// ---- launch(): spawner injected, no real window ----

const cfg = { port: 47999, root: 'C:\\root', launch: { healthTimeoutMs: 800 } };
const fakeProbe = (result) => async () => result;

test('launch: nothing answering -> spawns the server once, minimized, with --open', async () => {
  const calls = [];
  const action = await launch(cfg, { spawn: (c, a) => calls.push([c, a]), probe: fakeProbe({ up: false }) });
  assert.equal(action, 'start');
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'cmd');
  assert.ok(calls[0][1].includes('/min'));
  assert.ok(calls[0][1].includes('--open'));
  assert.ok(calls[0][1].some((a) => a.endsWith('main.mjs')));
});
test('launch: healthy /health -> no server spawn, only the browser opener', async () => {
  const calls = [];
  const action = await launch(cfg, { spawn: (c, a) => calls.push([c, a]), probe: fakeProbe({ up: true, body: { app: 'agent-office', pid: 1 } }) });
  assert.equal(action, 'open');
  assert.equal(calls.length, 1);
  assert.ok(!calls[0][1].some((a) => String(a).endsWith('main.mjs')));
  assert.equal(calls[0][1].at(-1), 'http://127.0.0.1:47999/');
});
test('launch: noBrowser + healthy -> spawns nothing; noBrowser + down -> no --open', async () => {
  const calls = [];
  const spawn = (c, a) => calls.push(a);
  await launch(cfg, { spawn, noBrowser: true, probe: fakeProbe({ up: true, body: { app: 'agent-office' } }) });
  assert.equal(calls.length, 0);
  await launch(cfg, { spawn, noBrowser: true, probe: fakeProbe({ up: false }) });
  assert.equal(calls.length, 1);
  assert.ok(!calls[0].includes('--open'));
});
test('launch: foreign app on the port -> spawns nothing, Korean message names the port', async () => {
  const calls = []; const logs = [];
  const action = await launch(cfg, { spawn: (c, a) => calls.push(a), log: (m) => logs.push(m), probe: fakeProbe({ up: true, body: { app: 'x' } }) });
  assert.equal(action, 'conflict');
  assert.equal(calls.length, 0);
  assert.match(logs[0], /포트 47999 을/);
});
