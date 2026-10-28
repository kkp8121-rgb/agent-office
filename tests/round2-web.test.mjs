import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { loadConfig } from '../server/config.mjs';
import { Office } from '../server/office.mjs';
import { resolveScene } from '../web/scene.mjs';

const cfg = loadConfig();
const EMPTY = { hidden: [], names: {} };
const S = (id, o = {}) => ({
  provider: 'claude', pid: 100, sessionId: id, cwd: 'C:\Project', status: 'busy', name: '', startedAt: 1000, ...o,
});
const M = (id, o = {}) => ({
  agentId: id, agentType: 'worker', description: 'x', finished: false, transcriptPath: '', mtimeMs: 0, workflow: null, ...o,
});
const floorOf = (o, id) => o.snapshot().floors.find((f) => f.sessionId === id);
const appSrc = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
/** Source of one top-level function of web/app.js. */
const fnSrc = (name) => appSrc.match(new RegExp(`(?:async )?function ${name}[(].*?\n}\n`, 's'))[0];

// ---- F14: main panel keeps rows newest-first when a merged entry gets a newer ts ----

function fakeLog() {
  const kids = [];
  const mk = () => {
    const row = {
      dataset: {},
      remove() { const i = kids.indexOf(row); if (i >= 0) kids.splice(i, 1); },
      get nextElementSibling() { return kids[kids.indexOf(row) + 1] ?? null; },
    };
    return row;
  };
  const logEl = {
    get firstElementChild() { return kids[0] ?? null; },
    get lastElementChild() { return kids.at(-1) ?? null; },
    get childElementCount() { return kids.length; },
    insertBefore(row, before) { kids.splice(before ? kids.indexOf(before) : kids.length, 0, row); },
  };
  return { kids, logEl, mk };
}

test('F14: an updated log row moves to its place by ts', () => {
  const { kids, logEl, mk } = fakeLog();
  const ctx = vm.createContext({
    logEl, logRows: new Map(), forcedHidden: new Map(), ui: { ui: { logDomCap: 300 } },
    createLogRow: mk,
    fillLogRow: (row, e) => Object.assign(row.dataset, { id: e.id, sid: e.sessionId, ts: String(e.ts) }),
    learnColors: () => {},
  });
  vm.runInContext(fnSrc('appendLog'), ctx);
  const E = (id, ts) => ({ id, ts, sessionId: 's1' });
  vm.runInContext('globalThis.go = appendLog', ctx);
  const { go } = ctx;
  go([E('a', 50), E('b', 52), E('c', 54)]); // oldest first
  go([E('a', 56)]); // the oldest row merged a newer read
  assert.deepEqual(kids.map((r) => r.dataset.id), ['a', 'c', 'b']);
  assert.deepEqual(kids.map((r) => Number(r.dataset.ts)), [56, 54, 52]);
  go([E('b', 55)]);
  const ts = kids.map((r) => Number(r.dataset.ts));
  assert.deepEqual(ts, [...ts].sort((x, y) => y - x));
  assert.equal(kids.length, 3, 'a move never duplicates a row');
});

// ---- F16: arrival points apart, overflow spread, bubbles limited ----

test('F16a: arrival points of every room keep nav.arrivalGapPx apart', () => {
  for (const d of cfg.designOrder) {
    const r = resolveScene(cfg.scenes[d].raw);
    const pts = [...r.seats.map((s) => s.at), r.lead.at, ...r.idle.map((p) => p.at), ...r.overflow.map((p) => p.at), ...r.tray.queue];
    pts.forEach((a, i) => pts.slice(i + 1).forEach((b) => {
      assert.ok(Math.hypot(a[0] - b[0], a[1] - b[1]) >= cfg.nav.arrivalGapPx, `${d}: ${a} and ${b} are closer than ${cfg.nav.arrivalGapPx}px`);
    }));
  }
});

test('F16b: 30 sub-agents never share a coordinate and stay inside the floor', () => {
  for (const d of cfg.designOrder) {
    const o = new Office(loadConfig({ designOrder: [d] }), EMPTY);
    o.syncSessions([S('s1')], 1000);
    o.syncAgents('s1', Array.from({ length: 30 }, (_, i) => M(`a${i}`)), 1000);
    const slots = floorOf(o, 's1').agents.map((a) => a.slot);
    assert.equal(new Set(slots.map((s) => `${s.x},${s.y}`)).size, 30, d);
    const [w, h] = cfg.scenes[d].raw.size;
    for (const s of slots) assert.ok(s.x >= 0 && s.x <= w && s.y >= 0 && s.y <= h, `${d}: ${s.x},${s.y}`);
  }
});

test('F16c: only the last speakers keep the full bubble', () => {
  const ctx = vm.createContext({});
  vm.runInContext(fnSrc('limitBubbles'), ctx);
  const mk = (since, extra = {}) => ({ since, hasBubble: true, state: 'working', ...extra, el: { classList: { quiet: false, toggle(c, on) { this[c] = on; } } } });
  const recs = [mk(1), mk(5), mk(3), mk(9), mk(7), mk(2, { hasBubble: false })];
  ctx.recs = recs;
  vm.runInContext('limitBubbles(recs, 3)', ctx);
  assert.deepEqual(recs.map((r) => r.el.classList.quiet), [true, false, true, false, false, false]);
});

// ---- colours: the server hands out palette indexes ----

test('colours: five floors get five different palette indexes', () => {
  assert.ok(cfg.ui.sessionPalette.length >= 8);
  const o = new Office(cfg, EMPTY);
  o.syncSessions([1, 2, 3, 4, 5].map((n) => S(`s${n}`, { startedAt: n })), 1000);
  const idx = o.snapshot().floors.map((f) => f.colorIndex);
  assert.deepEqual([...idx].sort(), [0, 1, 2, 3, 4]);
});

test('colours: a new floor takes the least used index, and departed sessions keep theirs for the log', () => {
  const o = new Office(cfg, EMPTY);
  o.syncSessions([S('s1', { startedAt: 1 }), S('s2', { startedAt: 2 }), S('s3', { startedAt: 3 })], 1000);
  o.syncAgents('s2', [M('a')], 1000);
  o.syncSessions([S('s1', { startedAt: 1 }), S('s3', { startedAt: 3 })], 2000); // s2 (index 1) leaves
  o.tick(2000 + cfg.floor.leaveMs);
  assert.equal(o.floors.has('s2'), false);
  o.syncSessions([S('s1', { startedAt: 1 }), S('s3', { startedAt: 3 }), S('s4', { startedAt: 4 })], 9000);
  assert.equal(floorOf(o, 's4').colorIndex, 1, 'the freed index is reused');
  assert.equal(o.logColors(['s1', 's2', 's3', 'nope']).s1, 0);
});

test('colours: /api/log carries colors for the sessions in its entries', async () => {
  const { createServer } = await import('../server/http.mjs');
  const o = new Office(cfg, EMPTY);
  o.syncSessions([S('s1', { startedAt: 1 }), S('s2', { startedAt: 2 })], 1000);
  o.syncAgents('s2', [M('a')], 1000);
  o.applySessionEvents('s2', [{ kind: 'tool', ts: 1500, toolUseId: 't1', name: 'Bash', text: 'x' }], 1500);
  const server = createServer(cfg, o, {});
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const body = await (await fetch(`http://127.0.0.1:${server.address().port}/api/log`)).json();
    assert.ok(body.entries.length > 0);
    assert.equal(body.colors.s2, 1);
    assert.equal(Object.keys(body.colors).length, new Set(body.entries.map((e) => e.sessionId)).size);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
