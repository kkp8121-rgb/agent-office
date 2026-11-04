// Task Manager style CPU %: the helper line parser, the helper's life (fake child, fake timers), the basis switch in createSysLoad, POST /api/sysload and the settings switch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { SCRIPT } from '../server/taskmgr-cpu-script.mjs';
import { loadConfig } from '../server/config.mjs';
import { Office } from '../server/office.mjs';
import { createServer } from '../server/http.mjs';
import { createSysLoad } from '../server/sysload.mjs';
import { createTaskMgrCpu, parseLine, spawnHelper } from '../server/taskmgr-cpu.mjs';

const core = (idle, busy) => ({ times: { user: busy, nice: 0, sys: 0, idle, irq: 0 } });

/** Fake spawner: every spawn() makes a child you drive by hand. */
function fakeSpawner() {
  const kids = [];
  const spawn = () => {
    const lines = [];
    const exits = [];
    const kid = {
      pid: 1000 + kids.length,
      alive: true,
      onLine: (fn) => lines.push(fn),
      onExit: (fn) => exits.push(fn),
      kill() { kid.killed = true; },
      say: (l) => lines.forEach((fn) => fn(l)),
      exit() { kid.alive = false; exits.forEach((fn) => fn()); },
    };
    kids.push(kid);
    return kid;
  };
  return { spawn, kids, get alive() { return kids.filter((k) => k.alive).length; } };
}

function fakeClock() {
  let t = 0;
  const timers = new Map();
  let id = 0;
  return {
    now: () => t,
    setTimer: (fn, ms) => { id += 1; timers.set(id, { fn, at: t + ms }); return id; },
    clearTimer: (h) => timers.delete(h),
    advance(ms) {
      t += ms;
      for (const [h, x] of [...timers]) if (x.at <= t) { timers.delete(h); x.fn(); }
    },
    get pending() { return timers.size; },
    delays: () => [...timers.values()].map((x) => x.at - t),
  };
}

test('taskmgr: a helper line is "C <0..100>"; cut lines, noise and out-of-range values are dropped', () => {
  assert.equal(parseLine('C 58'), 58);
  assert.equal(parseLine('C 0\r'), 0);
  assert.equal(parseLine('C 100'), 100);
  assert.equal(parseLine('C 101'), null);
  assert.equal(parseLine('C 1000'), null);
  assert.equal(parseLine('C -3'), null);
  assert.equal(parseLine('C 5.5'), null);
  assert.equal(parseLine('C '), null);
  assert.equal(parseLine('C'), null);
  assert.equal(parseLine('58'), null);
  assert.equal(parseLine('프로세서 58'), null);
  assert.equal(parseLine(''), null);
});

test('taskmgr: start() is idempotent, one child at a time, value comes from its lines, stop() kills it and clears the value', () => {
  const sp = fakeSpawner();
  const clk = fakeClock();
  const h = createTaskMgrCpu({ spawn: sp.spawn, ...clk });
  assert.equal(sp.kids.length, 0, 'nothing starts by itself');
  h.start();
  h.start();
  assert.equal(sp.kids.length, 1);
  assert.equal(h.pid, 1000);
  assert.equal(h.value(), null, 'no value before the first line');
  sp.kids[0].say('garbage');
  assert.equal(h.value(), null);
  sp.kids[0].say('C 58');
  assert.equal(h.value(), 58);
  h.stop();
  assert.equal(sp.kids[0].killed, true);
  assert.equal(h.value(), null);
  assert.equal(h.pid, null);
  assert.equal(clk.pending, 0, 'a stopped helper is not restarted');
  sp.kids[0].exit();
  assert.equal(sp.kids.length, 1, 'its exit after stop() is not a crash');
});

test('taskmgr: a value older than 30 s is not used', () => {
  const sp = fakeSpawner();
  const clk = fakeClock();
  const h = createTaskMgrCpu({ spawn: sp.spawn, intervalSeconds: 3, ...clk });
  h.start();
  sp.kids[0].say('C 40');
  clk.advance(29000);
  assert.equal(h.value(), 40);
  clk.advance(2000);
  assert.equal(h.value(), null);
});

test('taskmgr: a helper that reported and then died is restarted after 1 s, and that is not a failure', () => {
  const sp = fakeSpawner();
  const clk = fakeClock();
  const h = createTaskMgrCpu({ spawn: sp.spawn, ...clk });
  h.start();
  sp.kids[0].say('C 50');
  sp.kids[0].exit();
  assert.equal(h.value(), null);
  assert.equal(h.failing, false);
  assert.deepEqual(clk.delays(), [1000]);
  assert.equal(sp.kids.length, 1);
  clk.advance(1000);
  assert.equal(sp.kids.length, 2);
  assert.equal(sp.alive, 1, 'never two alive');
});

test('taskmgr: children that die before any line wait longer each time, and after maxFailures the helper gives up with one log line', () => {
  const sp = fakeSpawner();
  const clk = fakeClock();
  const logs = [];
  const h = createTaskMgrCpu({ spawn: sp.spawn, maxFailures: 4, log: (m) => logs.push(m), ...clk });
  h.start();
  const waits = [];
  for (let i = 0; i < 3; i++) {
    sp.kids.at(-1).exit();
    assert.equal(h.failing, true);
    waits.push(clk.delays()[0]);
    clk.advance(clk.delays()[0]);
  }
  assert.deepEqual(waits, [1000, 2000, 4000]);
  assert.equal(sp.kids.length, 4);
  assert.equal(h.failed, false);
  sp.kids.at(-1).exit(); // the 4th in a row
  assert.equal(h.failed, true);
  assert.equal(clk.pending, 0, 'no more tries');
  assert.equal(logs.length, 1);
  h.start();
  assert.equal(sp.kids.length, 4, 'given up: start() does nothing');
  h.stop();
  h.start();
  assert.equal(sp.kids.length, 4, 'a page leaving and coming back does not retry either');
  h.retryAgain();
  h.start();
  assert.equal(sp.kids.length, 5, 'the option switched off and on tries again');
  assert.equal(logs.length, 1, 'the log line is once per server run');
});

test('taskmgr: a good line resets the failure count; a spawn that throws counts as a failure and is retried', () => {
  const sp = fakeSpawner();
  const clk = fakeClock();
  const h = createTaskMgrCpu({ spawn: sp.spawn, maxFailures: 3, log() {}, ...clk });
  h.start();
  sp.kids[0].exit();
  assert.equal(h.failing, true);
  clk.advance(1000);
  sp.kids[1].say('C 10');
  assert.equal(h.failing, false);
  const clk2 = fakeClock();
  let boom = true;
  const h2 = createTaskMgrCpu({ spawn: () => { if (boom) throw new Error('spawn ENOENT'); return sp.spawn(); }, maxFailures: 3, log() {}, ...clk2 });
  h2.start();
  assert.equal(h2.failing, true);
  assert.deepEqual(clk2.delays(), [1000]);
  boom = false;
  clk2.advance(1000);
  assert.equal(h2.running, true);
});

test('taskmgr: start() right after stop() waits until the old child is really gone (never two alive)', () => {
  const sp = fakeSpawner();
  const clk = fakeClock();
  const h = createTaskMgrCpu({ spawn: sp.spawn, ...clk });
  h.start();
  h.stop();
  h.start();
  assert.equal(sp.kids.length, 1, 'the old child is still dying');
  sp.kids[0].exit();
  assert.equal(sp.kids.length, 2);
  assert.equal(sp.kids.filter((k) => k.alive).length, 1);
  h.stop();
  h.start();
  h.stop(); // changed its mind while the second child was dying
  sp.kids[1].exit();
  assert.equal(sp.kids.length, 2, 'no start was wanted any more');
});

function fakeLoad(opts = {}) {
  const sp = fakeSpawner();
  const clk = fakeClock();
  const helper = createTaskMgrCpu({ spawn: sp.spawn, intervalSeconds: 3, log() {}, ...clk });
  let busy = 0;
  let idle = 0;
  const timers = new Set();
  const deps = {
    cpus: () => [core(idle, busy)],
    freemem: () => 40,
    totalmem: () => 100,
    setTimer: (fn) => { const h = { fn, unref() {} }; timers.add(h); return h; },
    clearTimer: (h) => timers.delete(h),
    platform: 'win32',
    helper,
  };
  return {
    sp, clk, helper, deps,
    svc: createSysLoad({ enabled: true, intervalSeconds: 3, ...opts }, deps),
    step(b, i) { busy += b; idle += i; },
    tick() { for (const h of [...timers]) h.fn(); },
  };
}

test('sysload basis: on Windows the default is the Task Manager number; the helper lives exactly while a page is connected', () => {
  const f = fakeLoad();
  assert.equal(f.svc.available, true);
  assert.equal(f.svc.taskManager, true, 'default on');
  assert.equal(f.sp.kids.length, 0);
  f.svc.connect();
  f.svc.connect();
  assert.equal(f.sp.kids.length, 1, 'first page starts it, second does not');
  f.step(100, 0); f.tick(); // helper has said nothing yet: no number, not the cores' 100
  assert.equal(f.svc.current(), null);
  f.sp.kids[0].say('C 58');
  f.step(100, 0); f.tick();
  assert.deepEqual(f.svc.current(), { cpu: 58, mem: 60 });
  f.svc.disconnect();
  assert.equal(f.sp.kids[0].killed, undefined, 'one page still there');
  f.svc.disconnect();
  assert.equal(f.sp.kids[0].killed, true);
  assert.equal(f.svc.current(), null);
});

test('sysload basis: switching off while running stops the helper and the next sample is the cores; switching on starts it again', () => {
  const f = fakeLoad();
  f.svc.connect();
  f.sp.kids[0].say('C 58');
  f.step(100, 0); f.tick();
  assert.equal(f.svc.current().cpu, 58);
  f.svc.setTaskManager(false);
  assert.equal(f.sp.kids[0].killed, true);
  assert.equal(f.svc.taskManager, false);
  f.step(90, 10); f.tick();
  assert.equal(f.svc.current().cpu, 90, 'cores basis from the very next sample, no warm-up');
  f.svc.setTaskManager(true);
  f.sp.kids[0].exit();
  assert.equal(f.sp.kids.length, 2);
  f.sp.kids[1].say('C 61');
  f.step(90, 10); f.tick();
  assert.equal(f.svc.current().cpu, 61);
  f.svc.setTaskManager(true);
  assert.equal(f.sp.kids.length, 2, 'setting the same value again starts nothing');
});

test('sysload basis: off in config starts no helper; switching it on with no page connected starts none either', () => {
  const f = fakeLoad({ taskManager: false });
  assert.equal(f.svc.taskManager, false);
  f.svc.connect();
  assert.equal(f.sp.kids.length, 0);
  f.step(70, 30); f.tick();
  assert.equal(f.svc.current().cpu, 70);
  f.svc.disconnect();
  f.svc.setTaskManager(true);
  assert.equal(f.sp.kids.length, 0, 'no page: no helper');
  f.svc.connect();
  assert.equal(f.sp.kids.length, 1);
});

test('sysload basis: while the helper keeps failing the cores number is shown; after giving up it stays so', () => {
  const f = fakeLoad();
  f.svc.connect();
  f.sp.kids[0].exit(); // failure 1
  f.step(80, 20); f.tick();
  assert.equal(f.svc.current().cpu, 80, 'retrying: cores meanwhile');
  for (let i = 0; i < 4; i++) { f.clk.advance(f.clk.delays()[0] ?? 0); f.sp.kids.at(-1).exit(); }
  assert.equal(f.helper.failed, true);
  f.step(60, 40); f.tick();
  assert.equal(f.svc.current().cpu, 60);
  const n = f.sp.kids.length;
  f.svc.disconnect();
  f.svc.connect();
  assert.equal(f.sp.kids.length, n, 'not retried on the next page');
  f.svc.setTaskManager(false);
  f.svc.setTaskManager(true);
  assert.equal(f.sp.kids.length, n + 1, 'switched off and on: a new try');
});

test('sysload basis: close() (server ends) kills the helper; other systems have no option and never start one', () => {
  const f = fakeLoad();
  f.svc.connect();
  f.svc.close();
  assert.equal(f.sp.kids[0].killed, true);
  const sp = fakeSpawner();
  const helper = createTaskMgrCpu({ spawn: sp.spawn });
  const svc = createSysLoad({ enabled: true, intervalSeconds: 3 }, { ...f.deps, platform: 'linux', helper });
  assert.equal(svc.available, false);
  assert.equal(svc.taskManager, false);
  svc.connect();
  svc.setTaskManager(true);
  assert.equal(svc.taskManager, false);
  assert.equal(sp.kids.length, 0);
});

test('spawnHelper: Windows PowerShell with the script as -EncodedCommand, no window, the parent pid in front of the script', () => {
  const calls = [];
  const fake = (exe, args, opts) => {
    calls.push({ exe, args, opts });
    return { pid: undefined, stdout: null, on() {}, kill() {} };
  };
  spawnHelper({ intervalSeconds: 3, parentPid: 4242, spawn: fake });
  const { exe, args, opts } = calls[0];
  assert.match(exe, /WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/);
  assert.ok(args.includes('-NoProfile') && args.includes('-NonInteractive'));
  const i = args.indexOf('-EncodedCommand');
  const text = Buffer.from(args[i + 1], 'base64').toString('utf16le');
  assert.match(text, /^\$ParentPid = 4242; \$IntervalSec = 3;\n/);
  assert.match(text, /ReadCategory/);
  assert.equal(opts.windowsHide, true);
  assert.deepEqual(opts.stdio, ['ignore', 'pipe', 'ignore']);
});

test('helper script: ASCII only, one "C <n>" line per interval, ends when the parent is gone, falls back from .NET to WMI in constrained mode', () => {
  const ps = SCRIPT;
  assert.match(ps, /Write-Output \('C ' \+ \[int\]\$pct\)/);
  assert.match(ps, /Get-Process -Id \$ParentPid/);
  assert.match(ps, /LanguageMode -eq 'FullLanguage'/);
  assert.match(ps, /Win32_PerfRawData_PerfProc_Process/);
  assert.doesNotMatch(ps, /Add-Type|csc\.exe/);
  // the script text itself is plain ASCII: the console code page never touches what the helper prints or runs
  assert.doesNotMatch(ps, /[^\x00-\x7f]/);
});

test('real helper (Windows only): it starts, and kill() ends it', { skip: process.platform !== 'win32', timeout: 5000 }, async () => {
  const kid = spawnHelper({ intervalSeconds: 3 });
  assert.ok(Number.isInteger(kid.pid));
  const gone = new Promise((resolve) => kid.onExit(resolve));
  kid.kill();
  await gone;
});

test('server: POST /api/sysload {taskManager} switches the basis; anything else is refused; /api/ui tells the page', async (t) => {
  const f = fakeLoad();
  const cfg = loadConfig();
  const server = createServer(cfg, new Office(cfg, { hidden: [], names: {} }), { sysload: f.svc });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeSse(); server.close(); server.closeAllConnections(); });
  const port = server.address().port;
  const call = (method, path, body) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers: { Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, 'Content-Type': 'application/json' } }, (res) => {
      let b = '';
      res.on('data', (d) => (b += d));
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', reject);
    req.end(body);
  });
  const ui = JSON.parse((await call('GET', '/api/ui')).body);
  assert.deepEqual(ui.sysload, { taskManager: true, on: true });
  assert.equal((await call('POST', '/api/sysload', '{"taskManager":false}')).status, 204);
  assert.equal(f.svc.taskManager, false);
  assert.deepEqual(JSON.parse((await call('GET', '/api/ui')).body).sysload, { taskManager: true, on: false });
  assert.equal((await call('POST', '/api/sysload', '{"taskManager":true}')).status, 204);
  assert.equal(f.svc.taskManager, true);
  for (const bad of ['{"taskManager":"yes"}', '{"taskManager":1}', '{}', '[]', 'nope', '{"sessionId":"x"}']) {
    assert.equal((await call('POST', '/api/sysload', bad)).status, 400, bad);
  }
  assert.equal(f.svc.taskManager, true);
  const cross = await new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/sysload', method: 'POST', headers: { Host: `127.0.0.1:${port}`, Origin: 'http://evil.example' } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.end('{"taskManager":false}');
  });
  assert.equal(cross, 403, 'a page of another site cannot flip it');
  assert.equal(f.svc.taskManager, true);
});

test('page: the settings switch, its texts and the server call', () => {
  const cfg = loadConfig();
  const S = cfg.ui.weather;
  assert.equal(S.sysSwitch, 'CPU 를 작업 관리자 기준으로 표시');
  assert.ok(S.sysGroup && S.sysHint && S.sysOnlyWin);
  const app = readFileSync(new URL('../web/app.mjs', import.meta.url), 'utf8');
  assert.match(app, /agent-office\.cpuTaskManager/);
  assert.match(app, /post\('\/api\/sysload', \{ taskManager: box\.checked \}\)/);
  assert.match(app, /box\.disabled = !avail/);
  assert.match(app, /initSysSwitch\(S\);/);
  assert.equal((app.match(/new EventSource/g) ?? []).length, 1);
  const pages = readFileSync(new URL('../server/pages.mjs', import.meta.url), 'utf8');
  assert.match(pages, /<fieldset id="sys-choices"><legend><\/legend><\/fieldset>/);
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  assert.match(readme, /작업 관리자 기준/);
});
