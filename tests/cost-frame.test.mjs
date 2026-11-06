import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { loadConfig } from '../server/config.mjs';
import { Office } from '../server/office.mjs';
import { createServer } from '../server/http.mjs';
import { CostLedger, localClock } from '../server/cost.mjs';

const clock = localClock(0, () => 540);
const HOUR = 3600 * 1000;
const T0 = clock.dayStart('2026-11-06') + 10 * HOUR;
const S = (id, o = {}) => ({ provider: 'claude', pid: 100, sessionId: id, cwd: 'C:\\Project', status: 'busy', name: '', startedAt: 1000, ...o });
const use = (ts, msgId, tokens, o = {}) => ({ ts, sessionId: 's1', agentKey: null, provider: 'claude', msgId, tokens, cacheRead: 100, ...o });

/** A server with a ledger and a clock the test moves by hand; `ssePingMs` is short so a ping marks "a while has passed". */
async function start(t) {
  const cfg = loadConfig({ server: { ssePingMs: 30 } });
  const office = new Office(cfg, { hidden: [], names: {} });
  office.syncSessions([S('s1')], 1000);
  const ledger = new CostLedger({ clock, keepDays: cfg.cost.keepDays, dedupePerFile: cfg.cost.dedupePerFile, topCount: cfg.ui.cost.topCount });
  const time = { now: T0 };
  const server = createServer(cfg, office, { cost: ledger, now: () => time.now });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  t.after(() => new Promise((r) => { server.closeSse(); server.close(r); server.closeAllConnections(); }));
  return { cfg, office, ledger, time, server, port };
}

/** Opens /api/events; resolves with all the text once `until(text)` holds. */
function sse(c, until) {
  return new Promise((resolve, reject) => {
    let text = '';
    const r = http.request({ host: '127.0.0.1', port: c.port, path: '/api/events', headers: { Host: `127.0.0.1:${c.port}` } }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (d) => {
        text += d;
        if (until(text)) { r.destroy(); resolve(text); }
      });
    });
    r.on('error', (e) => { if (e.code !== 'ECONNRESET') reject(e); });
    r.end();
  });
}

const costFrames = (text) =>
  text.split('\n\n').filter((b) => b.startsWith('event: cost')).map((b) => JSON.parse(b.split('\n')[1].slice(6)));
const pings = (text) => text.split(': ping').length - 1;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('cost-frame: cost is sent once on connect', async (t) => {
  const c = await start(t);
  c.ledger.add(use(T0 - HOUR, 'm1', 1000)); // the lead of s1, which is on screen
  c.ledger.add(use(T0 - HOUR, 'm2', 400, { agentKey: 'a1' })); // a person who has left
  c.ledger.add(use(T0 - HOUR, 'm3', 50, { sessionId: 'gone' })); // a floor that has left
  c.ledger.add(use(T0 - 7 * 24 * HOUR - HOUR, 'w1', 300)); // the same weekday last week, an hour earlier
  const text = await sse(c, (x) => pings(x) >= 2);
  const frames = costFrames(text);
  assert.equal(frames.length, 1, 'once on connect, nothing more while nothing changed');
  const [f] = frames;
  const lead = c.office.snapshot().floors[0];
  assert.deepEqual(Object.keys(f).sort(), ['cacheRead', 'day', 'floors', 'lastWeek', 'partial', 'scanning', 'tokens', 'top']);
  assert.equal(f.day, '2026-11-06');
  assert.equal(f.tokens, 1450);
  assert.equal(f.cacheRead, 300);
  assert.deepEqual(f.lastWeek, { day: '2026-10-30', tokensSameHour: 300, partial: false });
  assert.deepEqual(f.floors, [{ sessionId: 's1', tokens: 1400 }], 'only the floors on screen');
  assert.deepEqual(f.top, [
    { sessionId: 's1', agentKey: null, name: lead.lead.name, floorName: lead.title, tokens: 1000 },
    { sessionId: 's1', agentKey: 'a1', name: c.cfg.ui.cost.goneName, floorName: lead.title, tokens: 400 },
    { sessionId: 'gone', agentKey: null, name: c.cfg.ui.cost.goneName, floorName: '', tokens: 50 },
  ]);
  // the only strings are the values of these five keys
  const keys = new Set();
  (function walk(v, key) {
    if (typeof v === 'string') keys.add(key);
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, Array.isArray(v) ? key : k);
  })(f, '');
  assert.deepEqual([...keys].sort(), ['agentKey', 'day', 'floorName', 'name', 'sessionId']);
});

test('cost-frame: an unchanged value sends nothing on the next tick', async (t) => {
  const c = await start(t);
  c.ledger.add(use(T0 - HOUR, 'm1', 1000));
  const got = sse(c, (x) => pings(x) >= 3);
  await sleep(10);
  c.time.now += c.cfg.cost.sendMinMs * 2; // long enough since the last frame
  c.server.broadcast(); // the ledger has not changed
  c.ledger.add(use(T0 - HOUR, 'm1', 1000)); // the same message again: not counted, nothing changes
  c.time.now += c.cfg.cost.sendMinMs * 2;
  c.server.broadcast();
  assert.equal(costFrames(await got).length, 1);
});

test('cost-frame: a change inside sendMinMs is held', async (t) => {
  const c = await start(t);
  c.ledger.add(use(T0 - HOUR, 'm1', 1000));
  const seen = [];
  let text = '';
  const got = sse(c, (x) => { text = x; return pings(x) >= 5; });
  await sleep(10);
  assert.equal(costFrames(text).length, 1);
  c.ledger.add(use(T0 - HOUR, 'm2', 500));
  c.time.now = T0 + c.cfg.cost.sendMinMs - 1; // not yet sendMinMs since the frame on connect
  c.server.broadcast();
  seen.push(costFrames(text).length);
  await sleep(10);
  seen.push(costFrames(text).length);
  c.time.now = T0 + c.cfg.cost.sendMinMs; // now it may go
  c.server.broadcast();
  await sleep(10);
  seen.push(costFrames(text).length);
  c.time.now += c.cfg.cost.sendMinMs;
  c.server.broadcast(); // and then it is quiet again
  const frames = costFrames(await got);
  assert.deepEqual(seen, [1, 1, 2], 'held at first, sent at sendMinMs');
  assert.equal(frames.length, 2);
  assert.equal(frames[0].tokens, 1000);
  assert.equal(frames[1].tokens, 1500, 'the held change arrives whole');
});

test('cost-frame: a new hour resends the frame without new usage, an unchanged hour does not', async (t) => {
  const lastWeekAt = (h) => T0 - 7 * 24 * HOUR - 10 * HOUR + h * HOUR; // last week's same weekday at hour h (T0 is 10:00)
  const c = await start(t);
  c.ledger.add(use(lastWeekAt(9), 'w9', 300));
  c.ledger.add(use(lastWeekAt(11), 'w11', 700)); // only counts once the clock reaches 11:00
  c.ledger.add(use(T0 - HOUR, 'm1', 1000));
  let text = '';
  const got = sse(c, (x) => { text = x; return pings(x) >= 6; });
  await sleep(10);
  assert.equal(costFrames(text).length, 1);
  assert.equal(costFrames(text)[0].lastWeek.tokensSameHour, 300);
  c.time.now = T0 + 50 * 60 * 1000; // 10:50, still the 10 o'clock hour, long after sendMinMs
  c.server.broadcast();
  await sleep(10);
  assert.equal(costFrames(text).length, 1, 'same hour, no new usage: nothing is sent');
  c.time.now = T0 + HOUR; // 11:00
  c.server.broadcast();
  await sleep(10);
  assert.equal(costFrames(text).length, 2, 'the hour changed: sent again with no new usage');
  assert.equal(costFrames(text)[1].lastWeek.tokensSameHour, 1000);
  assert.equal(costFrames(text)[1].tokens, 1000, 'nothing else changed');
  c.time.now += 10 * 60 * 1000;
  c.server.broadcast();
  const frames = costFrames(await got);
  assert.equal(frames.length, 2, 'and quiet again inside the new hour');
});
