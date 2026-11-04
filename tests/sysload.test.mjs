// Board header CPU / memory: the percent maths, sampling only while a page is connected, the push over /api/events, and the page text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { loadConfig } from '../server/config.mjs';
import { Office } from '../server/office.mjs';
import { createServer } from '../server/http.mjs';
import { cpuPercent, createSysLoad, memPercent } from '../server/sysload.mjs';

const core = (idle, busy) => ({ times: { user: busy, nice: 0, sys: 0, idle, irq: 0 } });
const S = { enabled: true, intervalSeconds: 3, taskManager: false }; // the os.cpus way: these tests never start the Windows helper
const flush = () => new Promise((r) => setTimeout(r, 120));

test('sysload: CPU % is the busy share of the time that passed, over all cores', () => {
  assert.equal(cpuPercent([core(0, 0), core(0, 0)], [core(75, 25), core(25, 75)]), 50);
  assert.equal(cpuPercent([core(100, 100)], [core(100, 200)]), 100);
  assert.equal(cpuPercent([core(100, 100)], [core(200, 100)]), 0);
  assert.equal(cpuPercent([core(10, 10)], [core(10, 10)]), null, 'no time passed');
  assert.equal(cpuPercent([core(0, 0)], [core(2, 1)]), 33, 'integer');
});

test('sysload: memory % is 1 - free/total, integer, clamped', () => {
  assert.equal(memPercent(25, 100), 75);
  assert.equal(memPercent(0, 100), 100);
  assert.equal(memPercent(100, 100), 0);
  assert.equal(memPercent(1, 3), 67);
  assert.equal(memPercent(5, 0), null);
});

function fake() {
  const timers = new Set();
  let busy = 0;
  let idle = 0;
  const f = {
    cpuCalls: 0,
    free: 40,
    step(b, i) { busy += b; idle += i; },
    deps: {
      cpus: () => { f.cpuCalls++; return [core(idle, busy)]; },
      freemem: () => f.free,
      totalmem: () => 100,
      setTimer: (fn) => { const h = { fn, unref() {} }; timers.add(h); return h; },
      clearTimer: (h) => timers.delete(h),
    },
    tick() { for (const h of [...timers]) h.fn(); },
    get pending() { return timers.size; },
  };
  return f;
}

test('sysload: no timer and no sampling until a page connects; the last page leaving stops it', () => {
  const f = fake();
  const svc = createSysLoad(S, f.deps);
  assert.equal(f.pending, 0);
  assert.equal(f.cpuCalls, 0);
  svc.connect();
  svc.connect();
  assert.equal(f.pending, 1, 'one timer for any number of pages');
  assert.equal(svc.current(), null, 'no value before a second snapshot');
  f.step(30, 70);
  f.tick();
  assert.deepEqual(svc.current(), { cpu: 30, mem: 60 });
  svc.disconnect();
  assert.equal(f.pending, 1);
  svc.disconnect();
  assert.equal(f.pending, 0);
  assert.equal(svc.current(), null, 'the next run starts fresh');
  const calls = f.cpuCalls;
  f.tick();
  assert.equal(f.cpuCalls, calls, 'no sampling while nobody is connected');
  svc.disconnect();
  assert.equal(svc.connections, 0);
});

test('sysload: disabled does nothing; subscribers hear only changed values', () => {
  const off = fake();
  const a = createSysLoad({ ...S, enabled: false }, off.deps);
  a.connect();
  assert.equal(off.pending, 0);
  const f = fake();
  const svc = createSysLoad(S, f.deps);
  const got = [];
  svc.subscribe((v) => got.push(v));
  svc.connect();
  f.step(10, 90); f.tick();
  f.step(10, 90); f.tick(); // same 10 % / 60 %
  f.step(50, 50); f.tick();
  assert.deepEqual(got, [{ cpu: 10, mem: 60 }, { cpu: 50, mem: 60 }]);
});

test('server: a page gets sysload events while connected; the sampler stops when it leaves', async (t) => {
  const f = fake();
  const svc = createSysLoad(S, f.deps);
  const cfg = loadConfig();
  const server = createServer(cfg, new Office(cfg, { hidden: [], names: {} }), { sysload: svc });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeSse(); server.close(); server.closeAllConnections(); });
  const port = server.address().port;
  const seen = [];
  let buf = '';
  const req = http.get({ host: '127.0.0.1', port, path: '/api/events', headers: { Host: `127.0.0.1:${port}` } }, (res) => {
    res.setEncoding('utf8');
    res.on('data', (d) => {
      buf += d;
      for (const m of buf.matchAll(/event: sysload\ndata: (.+)\n\n/g)) seen.push(JSON.parse(m[1]));
      buf = buf.slice(buf.lastIndexOf('\n\n') + 2);
    });
  });
  await flush();
  assert.equal(svc.connections, 1);
  f.step(20, 80);
  f.tick();
  await flush();
  assert.deepEqual(seen, [{ cpu: 20, mem: 60 }]);
  req.destroy();
  await flush();
  assert.equal(svc.connections, 0);
  assert.equal(f.pending, 0);
});

test('page: config text, header slot, hidden until the first value, no second stream', () => {
  const cfg = loadConfig();
  assert.deepEqual(cfg.sysload, { enabled: true, intervalSeconds: 3, taskManager: true });
  assert.equal(cfg.ui.lobby.sysText, 'CPU {cpu}% · 메모리 {mem}%');
  const app = readFileSync(new URL('../web/app.mjs', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../web/style.css', import.meta.url), 'utf8');
  assert.match(app, /wall\.sys\.hidden = true/);
  assert.match(app, /hd\.append\(el\('b', '', L\.boardTitle\), wall\.page, wall\.sys, clk\)/);
  assert.match(app, /sys\.hidden = !sysLoad/);
  assert.match(app, /addEventListener\('sysload'/);
  assert.equal((app.match(/new EventSource/g) ?? []).length, 1);
  assert.match(css, /\.led-hd \.sys \{[^}]*left: 50%/);
  const text = cfg.ui.lobby.sysText.replace('{cpu}', '7').replace('{mem}', '63');
  assert.equal(text, 'CPU 7% · 메모리 63%');
});
