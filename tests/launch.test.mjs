import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { decide, probe } from '../server/launch.mjs';

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
