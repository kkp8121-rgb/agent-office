// Final fix round 2, group 2: Codex period start is a pure function of the rollout timestamps (F20) and
// CodexSource counts bytes through FileTail.lastRead (F38).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../server/config.mjs';
import { Office } from '../server/office.mjs';
import { Poller } from '../server/poller.mjs';
import { CodexSource } from '../server/codex.mjs';

const PARENT_ID = '22222222-2222-4222-8222-222222222222';
const CHILD_ID = '33333333-3333-4333-8333-333333333333';
const MIN = 60000;

const iso = (ms) => new Date(ms).toISOString();
const line = (ms, type, payload) => JSON.stringify({ timestamp: iso(ms), type, payload }) + '\n';
const ev = (ms, type, extra = {}) => line(ms, 'event_msg', { type, ...extra });
const started = (ms) => ev(ms, 'task_started', { turn_id: 't' });
const complete = (ms) => ev(ms, 'task_complete', { turn_id: 't' });
const meta = (ms, id, source = 'cli') => line(ms, 'session_meta', { id, timestamp: iso(ms), cwd: 'C:\Project\app', originator: 'codex_cli', source });
const childMeta = (ms, id, parentId) =>
  meta(ms, id, { subagent: { thread_spawn: { parent_thread_id: parentId, depth: 1, agent_path: '/root/find_files', agent_role: 'worker' } } });

function fake(t, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'codex-r2-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cfg = loadConfig({ agentScanEveryTicks: 1, ...overrides });
  cfg.codexHome = dir;
  const pad = (n) => String(n).padStart(2, '0');
  const rollout = (id, content, day = new Date()) => {
    const d = join(dir, 'sessions', String(day.getFullYear()), pad(day.getMonth() + 1), pad(day.getDate()));
    mkdirSync(d, { recursive: true });
    const file = join(d, `rollout-${id}.jsonl`);
    writeFileSync(file, content);
    return file;
  };
  return { dir, cfg, rollout };
}

/**
 * Parent speaks, delegates, stays silent while the sub-agent works (longer than idleKeepMs), the sub-agent ends at
 * `end`, the parent writes its next line `gap` ms later. Returns the files and the times.
 */
function handover(h, now, gap) {
  const keep = h.cfg.codex.idleKeepMs;
  const t0 = now - 3 * keep;
  const end = t0 + 2 * keep;
  let kid = childMeta(t0 + 3000, CHILD_ID, PARENT_ID) + started(t0 + 4000);
  for (let at = t0 + 20 * MIN; at < end; at += 20 * MIN) kid += ev(at, 'token_count');
  const parent = h.rollout(PARENT_ID, meta(t0, PARENT_ID) + started(t0 + 1000) + ev(t0 + 2000, 'token_count'));
  const child = h.rollout(CHILD_ID, kid);
  return { t0, end, parent, child, next: end + gap };
}

for (const gap of [1000, 5000]) {
  test(`F20: parent writing ${gap / 1000} s after its sub-agent ended keeps one period, live and after a restart`, async (t) => {
    const h = fake(t);
    const now = Date.now();
    const { t0, end, parent, child, next } = handover(h, now, gap);
    const running = new CodexSource(h.cfg);
    await running.poll(t0 + 5000);
    for (let at = t0 + 20 * MIN; at < end; at += 20 * MIN) await running.poll(at + 100);
    appendFileSync(child, complete(end));
    assert.equal((await running.poll(end + 100)).sessions[0].startedAt, t0, 'sub-agent just ended, parent silent');
    appendFileSync(parent, ev(next, 'token_count'));
    const live = (await running.poll(next + 100)).sessions[0];
    assert.equal(live.startedAt, t0, 'long-running server');
    const restarted = (await new CodexSource(h.cfg).poll(next + 100)).sessions[0];
    assert.equal(restarted.startedAt, t0, 'fresh server');
  });
}

test('F20: the same hand-over keeps a forced hide across a restart', async (t) => {
  for (const gap of [1000, 5000]) {
    const h = fake(t);
    const claudeHome = mkdtempSync(join(tmpdir(), 'codex-r2-claude-'));
    t.after(() => rmSync(claudeHome, { recursive: true, force: true }));
    h.cfg.claudeHome = claudeHome;
    const now = Date.now();
    const { t0, end, parent, child, next } = handover(h, now, gap);
    const office = new Office(h.cfg, { hidden: [], names: {} });
    const poller = new Poller(h.cfg, office);
    await poller.tick(t0 + 5000);
    assert.equal(office.hide(PARENT_ID), true);
    appendFileSync(child, complete(end));
    await poller.tick(end + 100);
    appendFileSync(parent, ev(next, 'token_count'));
    await poller.tick(next + 100);
    assert.equal(office.snapshot().floors.some((f) => f.provider === 'codex'), false, `live, gap ${gap}`);

    const office2 = new Office(h.cfg, office.saved());
    await new Poller(h.cfg, office2).tick(next + 100);
    assert.equal(office2.snapshot().floors.some((f) => f.provider === 'codex'), false, `restart, gap ${gap}`);
    assert.equal(office2.saved().hidden.length, 1, 'the hide record is kept');
  }
});

test('F20: parent and sub-agent silent longer than idleKeepMs start a new period, live and after a restart', async (t) => {
  const h = fake(t);
  const now = Date.now();
  const keep = h.cfg.codex.idleKeepMs;
  const { end, parent, child } = handover(h, now, 0);
  appendFileSync(child, complete(end));
  const next = end + keep + 1000;
  const running = new CodexSource(h.cfg);
  await running.poll(end + 100);
  assert.equal((await running.poll(end + keep + 500)).sessions.length, 0, 'everything silent: the floor leaves');
  appendFileSync(parent, started(next));
  const live = (await running.poll(next + 100)).sessions[0];
  assert.equal(live.startedAt, next);
  assert.equal((await new CodexSource(h.cfg).poll(next + 100)).sessions[0].startedAt, next);
});

/** Parent and sub-agent go quiet for 80 minutes (the floor leaves), then one of them writes. */
function quietThenWrite(h, now) {
  const t0 = now - 120 * MIN;
  const parent = h.rollout(PARENT_ID, meta(t0, PARENT_ID) + started(t0 + 1000) + ev(t0 + 2000, 'token_count'));
  const child = h.rollout(CHILD_ID, childMeta(t0 + 3000, CHILD_ID, PARENT_ID) + started(t0 + 4000));
  return { t0, T: t0 + 80 * MIN, parent, child };
}

test('F20: a period opened by a sub-agent line starts at that line, live and after a restart', async (t) => {
  const h = fake(t);
  const { t0, T, parent, child } = quietThenWrite(h, Date.now());
  const running = new CodexSource(h.cfg);
  assert.equal((await running.poll(t0 + 5000)).sessions[0].startedAt, t0);
  assert.equal((await running.poll(t0 + 70 * MIN)).sessions.length, 0, 'both silent: the floor left');
  appendFileSync(child, ev(T, 'token_count'));
  assert.equal((await running.poll(T + 1500)).sessions[0].startedAt, T, 'sub-agent line opens the period');
  appendFileSync(parent, ev(T + 20000, 'token_count'));
  assert.equal((await running.poll(T + 21500)).sessions[0].startedAt, T, 'long-running server');
  assert.equal((await new CodexSource(h.cfg).poll(T + 21500)).sessions[0].startedAt, T, 'fresh server');
});

test('F20: sub-agent line before the parent line in one batch: the earlier one starts the period, live and restarted', async (t) => {
  const h = fake(t);
  const { t0, T, parent, child } = quietThenWrite(h, Date.now());
  const running = new CodexSource(h.cfg);
  await running.poll(t0 + 5000);
  assert.equal((await running.poll(t0 + 70 * MIN)).sessions.length, 0);
  appendFileSync(child, ev(T, 'token_count'));
  appendFileSync(parent, ev(T + 20000, 'token_count'));
  assert.equal((await running.poll(T + 21500)).sessions[0].startedAt, T, 'long-running server');
  assert.equal((await new CodexSource(h.cfg).poll(T + 21500)).sessions[0].startedAt, T, 'fresh server');
});

test('F20: a forced hide survives a restart when a sub-agent line opened the period', async (t) => {
  const h = fake(t);
  const claudeHome = mkdtempSync(join(tmpdir(), 'codex-r2-claude-'));
  t.after(() => rmSync(claudeHome, { recursive: true, force: true }));
  h.cfg.claudeHome = claudeHome;
  const { t0, T, parent, child } = quietThenWrite(h, Date.now());
  const office = new Office(h.cfg, { hidden: [], names: {} });
  const poller = new Poller(h.cfg, office);
  await poller.tick(t0 + 5000);
  await poller.tick(t0 + 70 * MIN);
  appendFileSync(child, ev(T, 'token_count'));
  await poller.tick(T + 1500);
  assert.equal(office.hide(PARENT_ID), true);
  appendFileSync(parent, ev(T + 20000, 'token_count'));
  await poller.tick(T + 21500);
  assert.equal(office.snapshot().floors.some((f) => f.provider === 'codex'), false, 'live');
  const office2 = new Office(h.cfg, office.saved());
  await new Poller(h.cfg, office2).tick(T + 21500);
  assert.equal(office2.snapshot().floors.some((f) => f.provider === 'codex'), false, 'restart');
  assert.equal(office2.saved().hidden.length, 1, 'the hide record is kept');
});

test('F38: CodexSource.bytesRead sums FileTail.lastRead, not the offset difference of a mid-file start', async (t) => {
  const h = fake(t, { tail: { startBytes: 2000 }, codex: { headBytes: 4096 } });
  const now = Date.now();
  let body = meta(now - 60000, PARENT_ID) + started(now - 59000);
  for (let i = 0; i < 200; i++) body += ev(now - 58000 + i * 10, 'token_count', { info: null });
  h.rollout(PARENT_ID, body);
  assert.ok(Buffer.byteLength(body) > 4096 + 2000 * 2);
  const src = new CodexSource(h.cfg);
  await src.poll(now);
  assert.equal(src.bytesRead, 4096 + 2000, 'head read plus the tail window, nothing more');
});
