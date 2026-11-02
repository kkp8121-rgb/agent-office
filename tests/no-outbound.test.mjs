// The suite runs with tests/helpers/no-outbound.mjs (npm test passes --import): a connect to a non-loopback host is refused,
// so no test can reach api.open-meteo.com (or anything else) even though config.json has the weather on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

test('guard: a connect to a non-loopback host is refused, a loopback one is not', async () => {
  globalThis.__outboundProbe = true; // these probes are on purpose: the guard does not write them to the leak log
  try {
    assert.throws(() => net.connect({ host: 'weather.example.invalid', port: 443 }), /outbound connection blocked/);
    assert.throws(() => net.connect(443, '203.0.113.7'), /outbound connection blocked/); // TEST-NET-3, never routable
  } finally {
    globalThis.__outboundProbe = false;
  }
  const server = net.createServer((s) => s.end()).listen(0, '127.0.0.1');
  await new Promise((r) => server.on('listening', r));
  await new Promise((resolve, reject) => {
    const c = net.connect(server.address().port, '127.0.0.1', resolve);
    c.on('error', reject);
  });
  server.close();
});
