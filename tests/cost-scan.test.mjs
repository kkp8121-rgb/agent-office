import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../server/config.mjs';
import { CostLedger, localClock } from '../server/cost.mjs';
import { CostScan, planTargets } from '../server/cost-scan.mjs';

const clock = localClock(0, () => 540);
const HOUR = 3600 * 1000;
const TODAY = '2026-11-06';
const LAST_WEEK = '2026-10-30';
const at = (day, hour, minute = 0) => clock.dayStart(day) + hour * HOUR + minute * 60 * 1000;
const NOW = at(TODAY, 21);
const CFG = loadConfig();
const backfill = { ...CFG.cost.backfill, yieldEveryLines: 1000000 };

const iso = (ms) => new Date(ms).toISOString();
const claudeLine = (ms, id, o = {}) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: iso(ms),
    message: { id, model: 'claude-opus-5-5', role: 'assistant', content: [{ type: 'text', text: 'synthetic words' }], usage: { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 1000, output_tokens: 7, ...o } },
  }) + '\n';
const plainLine = (ms, text = 'nothing to count here') => JSON.stringify({ type: 'user', timestamp: iso(ms), message: { role: 'user', content: text } }) + '\n';
const codexLine = (ms, id, o = {}) =>
  JSON.stringify({ type: 'token_usage_record', timestamp: iso(ms), payload: { response_id: id, usage: { input_tokens: 100, cached_input_tokens: 60, cache_write_input_tokens: 0, output_tokens: 8, ...o } } }) + '\n';
const codexMeta = (id, parent) =>
  JSON.stringify({
    type: 'session_meta',
    timestamp: iso(NOW),
    payload: { id, cwd: 'C:\\fixture\\repo-alpha', originator: 'codex_cli', ...(parent ? { source: { subagent: { thread_spawn: { parent_thread_id: parent, agent_role: 'worker' } } } } : {}) },
  }) + '\n';

/** A fake home with the folders the scan reads; removed when the test ends. */
function home(t) {
  const dir = mkdtempSync(join(tmpdir(), 'cost-scan-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const put = (rel, text, mtimeMs) => {
    const file = join(dir, rel);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, text);
    if (mtimeMs !== undefined) utimesSync(file, new Date(mtimeMs), new Date(mtimeMs));
    return file;
  };
  return { dir, claude: join(dir, 'claude'), codex: join(dir, 'codex'), put };
}

const newLedger = () => new CostLedger({ clock, keepDays: 15, dedupePerFile: 4096, topCount: 20 });

function scanner(h, ledger, { cfg = {}, parse = JSON.parse, yieldFn } = {}) {
  const opened = [];
  const openFile = async (path, flags) => {
    opened.push(path);
    return open(path, flags);
  };
  const scan = new CostScan({
    ledger, claudeHome: h.claude, codexHome: h.codex, parse, openFile, yieldFn,
    cfg: { backfill, tail: CFG.tail, codex: CFG.codex, ...cfg },
  });
  return { scan, opened };
}

const todayTarget = () => planTargets({ ledger: newLedger(), clock, nowTs: NOW, backfill: CFG.cost.backfill }).find((t) => t.day === TODAY);
const weekTarget = () => planTargets({ ledger: newLedger(), clock, nowTs: NOW, backfill: CFG.cost.backfill }).find((t) => t.day === LAST_WEEK);

test('cost-scan: a line without "usage" is never parsed (call count)', async (t) => {
  const h = home(t);
  const day = at(TODAY, 9);
  // one chunk is only 4 KiB here, so lines run over chunk ends and are joined again
  const filler = 'x'.repeat(700);
  let lead = '';
  for (let i = 0; i < 12; i++) lead += plainLine(day + i, filler) + claudeLine(day + i, `m${i}`);
  lead += JSON.stringify({ type: 'system', timestamp: iso(day), usage: { note: 'holds the marker but no tokens: parsed, then ignored' } }) + '\n';
  h.put('claude/projects/P/s1.jsonl', lead, NOW);
  h.put('claude/projects/P/s1/subagents/agent-a1.jsonl', plainLine(day) + claudeLine(day, 'ma1'), NOW);
  h.put('claude/projects/P/s1/subagents/workflows/run1/agent-w1.jsonl', claudeLine(day, 'mw1') + claudeLine(day, 'mw1'), NOW);
  h.put('claude/projects/P/s1/subagents/workflows/run1/journal.jsonl', claudeLine(day, 'not-counted'), NOW); // not an agent transcript
  h.put('codex/sessions/2026/11/06/rollout-2026-11-06T09-00-00-cx1.jsonl', codexMeta('cx1') + plainLine(day) + codexLine(day, 'r1'), NOW);
  h.put('codex/sessions/2026/11/06/rollout-2026-11-06T09-01-00-cx2.jsonl', codexMeta('cx2', 'cx1') + codexLine(day, 'r2') + codexLine(day, 'r2'), NOW);

  let calls = 0;
  const ledger = newLedger();
  const { scan } = scanner(h, ledger, { parse: (s) => (calls++, JSON.parse(s)), cfg: { tail: { ...CFG.tail, maxLineBytes: 4096 } } });
  await scan.run([todayTarget()]);

  // lines holding the marker: 12 + 1 (lead, the system line that has a usage key), 1 (a1), 2 (w1), 1 + 2 (codex) ... and not one more
  assert.equal(calls, 12 + 1 + 1 + 2 + 1 + 2);
  assert.equal(scan.stats.linesParsed, calls);
  const tdy = ledger.today(NOW);
  const tokens = (o) => tdy.top.find((p) => p.sessionId === o.sessionId && p.agentKey === o.agentKey)?.tokens;
  assert.equal(tokens({ sessionId: 's1', agentKey: null }), 12 * 22, 'the lead: ten input + five cache write + seven output, twelve messages');
  assert.equal(tokens({ sessionId: 's1', agentKey: 'a1' }), 22);
  assert.equal(tokens({ sessionId: 's1', agentKey: 'w1' }), 22, 'two lines of one message count once');
  assert.equal(tokens({ sessionId: 'cx1', agentKey: null }), 48, 'codex: input 100 - cached 60 + output 8');
  assert.equal(tokens({ sessionId: 'cx1', agentKey: 'cx2' }), 48, 'a codex sub-agent counts for the floor of its parent');
  assert.equal(tdy.cacheRead, 12 * 1000 + 1000 + 1000 + 60 + 60, 'cache reads are kept apart');
  assert.equal(tdy.tokens, 12 * 22 + 22 + 22 + 48 + 48);
  assert.deepEqual(tdy.floors.map((f) => f.sessionId).sort(), ['cx1', 's1']);
});

test('cost-scan: a file older than the target day is not opened', async (t) => {
  const h = home(t);
  const day = at(TODAY, 9);
  h.put('claude/projects/P/old.jsonl', claudeLine(day, 'o1'), at(TODAY, 0) - 1); // last written before the day began
  h.put('claude/projects/P/new.jsonl', claudeLine(day, 'n1'), at(TODAY, 0));
  const ledger = newLedger();
  const { scan, opened } = scanner(h, ledger);
  await scan.run([todayTarget()]);
  assert.deepEqual(opened.map((p) => p.split(/[\\/]/).pop()), ['new.jsonl']);
  assert.equal(ledger.today(NOW).tokens, 22);
});

test('cost-scan: a last-week file written after that day is not opened', async (t) => {
  const h = home(t);
  const ts = at(LAST_WEEK, 9);
  h.put('claude/projects/P/before.jsonl', claudeLine(ts, 'b1'), at(LAST_WEEK, 0) - 1);
  h.put('claude/projects/P/inside.jsonl', claudeLine(ts, 'i1'), at(LAST_WEEK, 23));
  h.put('claude/projects/P/after.jsonl', claudeLine(ts, 'a1'), at('2026-10-31', 0)); // the next day began
  h.put('claude/projects/P/today.jsonl', claudeLine(ts, 't1'), NOW);
  const ledger = newLedger();
  const { scan, opened } = scanner(h, ledger);
  await scan.run([weekTarget()]);
  assert.deepEqual(opened.map((p) => p.split(/[\\/]/).pop()), ['inside.jsonl']);
  assert.equal(ledger.today(at(TODAY, 21)).lastWeek.tokensSameHour, 22);
});

test('cost-scan: a last-week file written within that day is read and cut by timestamp', async (t) => {
  const h = home(t);
  const text =
    claudeLine(at('2026-10-29', 23, 59), 'early') + // the day before
    claudeLine(at(LAST_WEEK, 0, 0), 'first') + // the first minute of the day
    claudeLine(at(LAST_WEEK, 12), 'noon', { output_tokens: 70 }) +
    claudeLine(at('2026-10-31', 0, 0), 'late'); // the day after
  h.put('claude/projects/P/s1.jsonl', text, at(LAST_WEEK, 20));
  const ledger = newLedger();
  const { scan, opened } = scanner(h, ledger);
  await scan.run([weekTarget()]);
  assert.equal(opened.length, 1);
  assert.deepEqual(Object.keys(ledger.toJSON(NOW).days), [LAST_WEEK], 'nothing landed on another day');
  assert.equal(ledger.toJSON(NOW).days[LAST_WEEK].tokens, 22 + 85);
});

test('cost-scan: maxBytes gives partial true', async (t) => {
  const h = home(t);
  const ts = at(TODAY, 9);
  let big = '';
  for (let i = 0; i < 60; i++) big += claudeLine(ts + i, `m${i}`);
  h.put('claude/projects/P/big.jsonl', big, NOW);
  h.put('claude/projects/P/other.jsonl', claudeLine(ts, 'o1'), NOW - 1);
  const ledger = newLedger();
  const { scan } = scanner(h, ledger, { cfg: { backfill: { ...backfill, maxBytes: 4096 }, tail: { ...CFG.tail, maxLineBytes: 4096 } } });
  const result = await scan.run([todayTarget()]);
  assert.deepEqual(result.partialDays, [TODAY]);
  assert.equal(ledger.today(NOW).partial, true);
  assert.equal(ledger.isScanned(TODAY), true, 'a cut-short day is not scanned again either');
  assert.ok(result.bytesRead < Buffer.byteLength(big), 'it stopped reading');

  const whole = newLedger();
  const full = await scanner(h, whole).scan.run([todayTarget()]);
  assert.deepEqual(full.partialDays, []);
  assert.equal(whole.today(NOW).partial, false);
});

test('cost-scan: a second start the same day scans nothing', async (t) => {
  const h = home(t);
  h.put('claude/projects/P/s1.jsonl', claudeLine(at(TODAY, 9), 'm1') + claudeLine(at(LAST_WEEK, 9), 'w1'), NOW);
  const first = newLedger();
  const targets = planTargets({ ledger: first, clock, nowTs: NOW, backfill: CFG.cost.backfill });
  assert.deepEqual(targets.map((x) => x.day), [TODAY, LAST_WEEK]);
  await scanner(h, first).scan.run(targets);
  assert.equal(first.today(NOW).tokens, 22);

  const saved = JSON.parse(JSON.stringify(first.toJSON(NOW)));
  const second = CostLedger.fromJSON(saved, { clock, keepDays: 15, dedupePerFile: 4096, topCount: 20 });
  const again = planTargets({ ledger: second, clock, nowTs: NOW + HOUR, backfill: CFG.cost.backfill });
  assert.deepEqual(again, []);
  const { scan, opened } = scanner(h, second);
  const result = await scan.run(again);
  assert.equal(opened.length, 0);
  assert.equal(result.filesOpened, 0);
  assert.equal(second.today(NOW).tokens, 22, 'the saved day totals are kept');
  assert.equal(planTargets({ ledger: second, clock, nowTs: NOW + 24 * HOUR, backfill: CFG.cost.backfill }).map((x) => x.day)[0], '2026-11-07', 'the next day is scanned');
});

test('cost-scan: scanning is true until the scan ends', async (t) => {
  const h = home(t);
  let lines = '';
  for (let i = 0; i < 5; i++) lines += claudeLine(at(TODAY, 9, i), `m${i}`);
  h.put('claude/projects/P/s1.jsonl', lines, NOW);
  const ledger = newLedger();
  const seen = [];
  let scan;
  ({ scan } = scanner(h, ledger, {
    cfg: { backfill: { ...backfill, yieldEveryLines: 1 } },
    yieldFn: async () => seen.push([scan.scanning, ledger.today(NOW).scanning]),
  }));
  assert.equal(scan.scanning, false);
  const done = scan.run([todayTarget()]);
  assert.equal(scan.scanning, true, 'on from the moment run starts');
  assert.equal(ledger.scanning, true);
  await done;
  assert.equal(scan.scanning, false);
  assert.equal(ledger.scanning, false);
  assert.ok(seen.length >= 5, 'the scan gave the thread back every line');
  assert.ok(seen.every(([a, b]) => a && b), 'still on at every one of those points');
  assert.equal(ledger.today(NOW).tokens, 5 * 22);
});
