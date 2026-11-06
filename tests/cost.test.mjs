import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../server/config.mjs';
import { Office } from '../server/office.mjs';
import { Poller } from '../server/poller.mjs';
import { CostLedger, localClock, shiftDay } from '../server/cost.mjs';

const KST_MINUTES = 540;
const clock = localClock(0, () => KST_MINUTES); // a fixed zone: the result does not depend on the PC that runs the test
const HOUR = 3600 * 1000;
const at = (day, hour, minute = 0) => clock.dayStart(day) + hour * HOUR + minute * 60 * 1000;

const ledger = (o = {}) => new CostLedger({ clock, keepDays: 15, dedupePerFile: 4096, topCount: 5, ...o });
const use = (ts, msgId, tokens, o = {}) => ({ ts, sessionId: 's1', agentKey: null, provider: 'claude', msgId, tokens, cacheRead: 0, ...o });

test('cost: three lines of one message count once', () => {
  const l = ledger();
  const counted = [1, 2, 3].map((i) => l.add(use(at('2026-11-06', 9, i), 'msg_a', 50)));
  assert.deepEqual(counted, [true, false, false]);
  assert.equal(l.today(at('2026-11-06', 10)).tokens, 50);
  assert.equal(l.add(use(at('2026-11-06', 9, 5), 'msg_b', 7)), true, 'another message id counts');
  assert.equal(l.today(at('2026-11-06', 10)).tokens, 57);
});

test('cost: lead, agent and workflow agent usage go to their owners', () => {
  const l = ledger();
  const ts = at('2026-11-06', 9);
  l.add(use(ts, 'm1', 10)); // the lead's own transcript
  l.add(use(ts, 'm2', 20, { agentKey: 'a1' })); // subagents/agent-a1.jsonl
  l.add(use(ts, 'm3', 40, { agentKey: 'w1' })); // subagents/workflows/<run>/agent-w1.jsonl
  l.add(use(ts, 'm4', 80, { sessionId: 's2', provider: 'codex' }));
  const t = l.today(at('2026-11-06', 10));
  assert.deepEqual(t.floors, [{ sessionId: 's1', tokens: 70 }, { sessionId: 's2', tokens: 80 }]);
  assert.deepEqual(t.top, [
    { sessionId: 's2', agentKey: null, tokens: 80 },
    { sessionId: 's1', agentKey: 'w1', tokens: 40 },
    { sessionId: 's1', agentKey: 'a1', tokens: 20 },
    { sessionId: 's1', agentKey: null, tokens: 10 },
  ]);
  const small = ledger({ topCount: 2 });
  for (const [i, tokens] of [5, 6, 7].entries()) small.add(use(ts, `x${i}`, tokens, { agentKey: `k${i}` }));
  assert.deepEqual(small.today(ts).top.map((p) => p.agentKey), ['k2', 'k1'], 'only the biggest topCount people');
});

test('cost: 15:30 UTC lands on the next local day', () => {
  const l = ledger();
  l.add(use(Date.UTC(2026, 10, 6, 14, 59), 'm1', 10)); // 23:59 in the +9 zone: still the 6th
  l.add(use(Date.UTC(2026, 10, 6, 15, 30), 'm2', 20)); // 00:30 on the 7th
  assert.equal(clock.dayKey(Date.UTC(2026, 10, 6, 15, 30)), '2026-11-07');
  assert.equal(clock.hourOf(Date.UTC(2026, 10, 6, 15, 30)), 0);
  assert.equal(l.today(Date.UTC(2026, 10, 6, 14, 59)).tokens, 10);
  assert.equal(l.today(Date.UTC(2026, 10, 6, 15, 30)).tokens, 20);
  assert.equal(clock.dayStart('2026-11-07'), Date.UTC(2026, 10, 6, 15, 0), 'the day boundary is local midnight');
  assert.equal(localClock(4, () => KST_MINUTES).dayKey(Date.UTC(2026, 10, 6, 18, 0)), '2026-11-06', 'dayStartHour 4: 03:00 still belongs to the day before');
});

test('cost: last week at the same hour', () => {
  const l = ledger();
  const week = shiftDay('2026-11-06', -7);
  assert.equal(week, '2026-10-30');
  l.add(use(at(week, 1), 'w1', 100)); // before the hour: counted
  l.add(use(at(week, 3, 30), 'w2', 10)); // inside the same hour: counted
  l.add(use(at(week, 5), 'w3', 1000)); // later that day: not part of the comparison
  l.add(use(at('2026-11-06', 2), 't1', 55));
  const t = l.today(at('2026-11-06', 3, 15));
  assert.equal(t.tokens, 55);
  assert.deepEqual(t.lastWeek, { day: week, tokensSameHour: 110, partial: false });
});

test('cost: no record of last week gives null', () => {
  const l = ledger();
  l.add(use(at('2026-11-06', 2), 't1', 55));
  l.add(use(at('2026-11-05', 2), 'y1', 55)); // yesterday is not last week
  assert.equal(l.today(at('2026-11-06', 3)).lastWeek, null);
});

test('cost: a floor that has left keeps its tokens in today', () => {
  // The ledger knows nothing of floors coming and going (Office does): what was counted stays counted.
  const l = ledger();
  l.add(use(at('2026-11-06', 9), 'm1', 30, { sessionId: 'gone' }));
  l.add(use(at('2026-11-06', 9), 'm2', 12, { sessionId: 'here' }));
  const t = l.today(at('2026-11-06', 23));
  assert.equal(t.tokens, 42);
  assert.deepEqual(t.floors.map((f) => f.sessionId), ['gone', 'here']);
});

test('cost: days older than keepDays are left out when saved, and the saved file holds no text but day keys', () => {
  const l = ledger({ keepDays: 15 });
  const now = at('2026-11-06', 12);
  l.add(use(at('2026-10-21', 9), 'old', 1)); // 16 days back: dropped
  l.add(use(at('2026-10-22', 9), 'edge', 2)); // 15 days back: kept
  l.add(use(now, 'now', 4, { sessionId: 'a-private-looking-id', agentKey: 'some-agent' }));
  l.markScanned('2026-11-06', false);
  l.markScanned('2026-10-21', false);
  const json = JSON.parse(JSON.stringify(l.toJSON(now)));
  assert.deepEqual(Object.keys(json.days), ['2026-10-22', '2026-11-06']);
  assert.deepEqual(json.scannedDays, ['2026-11-06']);
  assert.deepEqual(Object.keys(json).sort(), ['days', 'scannedDays', 'seenUntil', 'version']);
  const strings = [];
  (function walk(v) {
    if (typeof v === 'string') strings.push(v);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  })(json);
  assert.deepEqual(strings, json.scannedDays, 'the only text in the file is the scannedDays list (the day keys are object keys)');
  const back = CostLedger.fromJSON(json, { clock, keepDays: 15, dedupePerFile: 4096, topCount: 5 });
  assert.equal(back.today(now).tokens, 4);
  assert.equal(back.isScanned('2026-11-06'), true);
  assert.equal(CostLedger.fromJSON({ days: { nonsense: { tokens: 1 }, '2026-11-06': { tokens: 'x', byHour: 'y' } }, scannedDays: [3, 'no'] }, { clock, keepDays: 15, dedupePerFile: 4096, topCount: 5 }).today(now).tokens, 0, 'a damaged file is read leniently');
});

test('cost: cache reads never enter tokens', () => {
  const l = ledger();
  l.add(use(at('2026-11-06', 9), 'm1', 10, { cacheRead: 5000 }));
  l.add(use(at('2026-11-06', 10), 'm2', 0, { cacheRead: 7000 }));
  const t = l.today(at('2026-11-06', 12));
  assert.equal(t.tokens, 10);
  assert.equal(t.cacheRead, 12000);
  assert.equal(t.byHour.reduce((a, b) => a + b, 0), 10);
  assert.equal(t.floors[0].tokens, 10);
  assert.equal(t.top[0].tokens, 10);
  assert.equal(l.toJSON(at('2026-11-06', 12)).days['2026-11-06'].tokens, 10);
});

// ---- beyond the eight named cases ----

test('cost: a restart and a start-up scan never count a line twice', () => {
  const first = ledger();
  first.add(use(at('2026-11-06', 9, 0), 'm1', 10));
  first.add(use(at('2026-11-06', 9, 5), 'm2', 20));
  const opts = { clock, keepDays: 15, dedupePerFile: 4096, topCount: 5 };
  const second = CostLedger.fromJSON(JSON.parse(JSON.stringify(first.toJSON(at('2026-11-06', 10)))), opts);
  assert.equal(second.add(use(at('2026-11-06', 9, 5), 'm2', 20)), false, 'the tail window re-reads a line already counted before the restart');
  assert.equal(second.add(use(at('2026-11-06', 9, 6), 'm3', 5)), true, 'a line written after it is new');

  // a scan drops what a live run counted for its days, and a long file still finds the lines a live tail counted first
  const l = new CostLedger({ ...opts, dedupePerFile: 3 });
  const day = '2026-11-06';
  l.add(use(at(day, 12), 'm9', 9));
  l.beginScan([day]);
  assert.equal(l.today(at(day, 13)).tokens, 0);
  for (let i = 1; i <= 9; i++) l.add(use(at(day, 12, i), `m${i}`, i), { scan: true }); // more ids than the limit
  l.endFile({ provider: 'claude', sessionId: 's1', agentKey: null });
  assert.equal(l.today(at(day, 13)).tokens, 45);
  assert.equal(l.add(use(at(day, 12, 9), 'm9', 9)), false, 'the newest ids are remembered');
  assert.equal(l.add(use(at(day, 12, 1), 'm1', 1)), true, 'only the newest dedupePerFile are');
});

test('cost: cost.mjs reads no clock and no file', () => {
  const src = readFileSync(fileURLToPath(new URL('../server/cost.mjs', import.meta.url)), 'utf8');
  assert.doesNotMatch(src, /Date\.now|new Date\(\)|\bfs\b|node:fs|setTimeout|setInterval/);
});

test('cost: the poller counts lead, agent, workflow agent and codex transcripts, and Office never sees a usage event', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cost-poller-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cfg = loadConfig({ agentScanEveryTicks: 1 });
  cfg.claudeHome = join(dir, 'claude');
  cfg.codexHome = join(dir, 'codex');
  const put = (rel, text) => {
    const file = join(dir, rel);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, text);
  };
  const now = Date.now();
  const iso = new Date(now).toISOString();
  const claude = (id) => JSON.stringify({ type: 'assistant', timestamp: iso, message: { id, model: 'claude-opus-5-5', content: [{ type: 'text', text: 'x' }], usage: { input_tokens: 1, cache_creation_input_tokens: 2, cache_read_input_tokens: 300, output_tokens: 4 } } }) + '\n';
  const codexMeta = (id, parent) => JSON.stringify({ type: 'session_meta', timestamp: iso, payload: { id, cwd: 'C:\\fixture\\repo-alpha', originator: 'codex_cli', ...(parent ? { source: { subagent: { thread_spawn: { parent_thread_id: parent, agent_role: 'worker' } } } } : {}) } }) + '\n';
  const codexUse = (id) => JSON.stringify({ type: 'token_usage_record', timestamp: iso, payload: { response_id: id, usage: { input_tokens: 50, cached_input_tokens: 10, cache_write_input_tokens: 0, output_tokens: 5 } } }) + '\n';
  put('claude/sessions/live.json', JSON.stringify({ pid: process.pid, sessionId: 's1', cwd: 'C:\\Project\\app', status: 'busy', name: '', startedAt: now - 1000 }));
  put('claude/projects/P/s1.jsonl', claude('m1') + claude('m1'));
  put('claude/projects/P/s1/subagents/agent-a1.meta.json', JSON.stringify({ agentType: 'worker', description: 'd' }));
  put('claude/projects/P/s1/subagents/agent-a1.jsonl', claude('ma1'));
  const wf = 'claude/projects/P/s1/subagents/workflows/wf_r1';
  put(`${wf}/agent-w1.meta.json`, JSON.stringify({ agentType: 'worker', description: 'verify:1', workflowPhase: 'Verify' }));
  put(`${wf}/agent-w1.jsonl`, claude('mw1'));
  put(`${wf}/journal.jsonl`, '{"type":"started","agentId":"w1","label":"verify:1","phase":"Verify"}\n');
  const d = new Date(now);
  const pad = (n) => String(n).padStart(2, '0');
  const day = `codex/sessions/${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
  put(`${day}/rollout-2026-11-06T09-00-00-cx1.jsonl`, codexMeta('cx1') + codexUse('r1'));
  put(`${day}/rollout-2026-11-06T09-01-00-cx2.jsonl`, codexMeta('cx2', 'cx1') + codexUse('r2'));

  const office = new Office(cfg, { hidden: [], names: {} });
  const kinds = new Set();
  for (const name of ['applySessionEvents', 'applyAgentEvents']) {
    const orig = office[name].bind(office);
    office[name] = (...args) => (args.find(Array.isArray).forEach((e) => kinds.add(e.kind)), orig(...args));
  }
  const ledger = ledger0();
  const poller = new Poller(cfg, office, ledger);
  await poller.tick(now);
  await poller.tick(now + 1500);

  const owners = ledger.today(now).top.map((p) => `${p.sessionId}/${p.agentKey ?? '-'}/${p.tokens}`).sort();
  assert.deepEqual(owners, ['cx1/-/45', 'cx1/cx2/45', 's1/-/7', 's1/a1/7', 's1/w1/7']);
  assert.equal(ledger.today(now).cacheRead, 3 * 300 + 2 * 10);
  assert.ok(kinds.size > 0 && !kinds.has('usage'), 'Office got other events, but no usage');
  await new Poller(cfg, new Office(cfg, { hidden: [], names: {} })).tick(now); // without a ledger nothing breaks
});

const ledger0 = () => new CostLedger({ clock: localClock(0), keepDays: 15, dedupePerFile: 4096, topCount: 20 });
