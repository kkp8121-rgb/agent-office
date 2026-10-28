import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../server/config.mjs';
import { Office } from '../server/office.mjs';

const cfg = loadConfig();
const EMPTY = { hidden: [], names: {} };
const MIN = 60000;

const S = (id, o = {}) => ({
  provider: 'claude', pid: 100, sessionId: id, cwd: 'C:\\Project', status: 'busy', name: '', startedAt: 1000, ...o,
});
const M = (id, o = {}) => ({
  agentId: id, agentType: 'worker', description: '기록 구조 조사', finished: false, transcriptPath: '', mtimeMs: 0, workflow: null, ...o,
});
const tool = (ts, text, name = 'Bash') => ({ kind: 'tool', ts, toolUseId: `t${ts}`, name, text });
const floorOf = (o, id) => o.snapshot().floors.find((f) => f.sessionId === id);
const setup = (live = [S('s1')], now = 1000, c = cfg) => {
  const o = new Office(c, EMPTY);
  o.syncSessions(live, now);
  return o;
};

// F3 / F5
test('office: a restored hide record survives one missed listing after a restart', () => {
  const o = setup();
  o.hide('s1');
  const saved = JSON.parse(JSON.stringify(o.saved()));
  const o2 = new Office(cfg, saved);
  o2.syncSessions([], 5000); // first listing misses the session
  o2.syncSessions([S('s1')], 6500);
  assert.equal(o2.saved().hidden.length, 1);
  assert.equal(o2.snapshot().floors.length, 0, 'still hidden');
  assert.equal(o2.savedVersion, 0, 'nothing to persist');
});

test('office: a hide record goes after floor.missTicks consecutive misses, a sighting resets the count', () => {
  const o = setup();
  o.hide('s1');
  const n = cfg.floor.missTicks;
  for (let i = 0; i < n - 1; i++) o.syncSessions([], 2000 + i);
  o.syncSessions([S('s1')], 3000); // seen again: counter restarts
  for (let i = 0; i < n - 1; i++) o.syncSessions([], 4000 + i);
  assert.equal(o.saved().hidden.length, 1);
  o.syncSessions([], 5000);
  assert.deepEqual(o.saved().hidden, []);
  assert.equal(o.logSince('s1', 5001), 5000);
});

test('office: a re-run still unhides at once', () => {
  const o = setup();
  o.hide('s1');
  o.syncSessions([S('s1', { pid: 200 })], 2000);
  assert.equal(o.snapshot().floors.length, 1);
  assert.deepEqual(o.saved().hidden, []);
});

// F4 / F24
test('office: a resumed session does not log the backfill window again', () => {
  const now = 100 * MIN;
  const o = setup([S('s1')], now);
  const replay = (t) => {
    o.applySessionEvents('s1', [tool(now - 5 * MIN, '빌드'), tool(now - 2 * MIN, '테스트')], t, { logSince: o.logSince('s1', t) });
  };
  replay(now);
  assert.equal(o.queryLog({}).length, 2);
  o.syncSessions([], now + 1000); // exit
  o.syncSessions([], now + 2500);
  o.tick(now + 10000); // floor removed
  o.syncSessions([S('s1', { startedAt: 5000 })], now + 30000); // --resume
  replay(now + 30000);
  assert.deepEqual(o.queryLog({}).map((e) => e.text), ['테스트', '빌드']);
  o.applySessionEvents('s1', [tool(now + 31000, '새 작업')], now + 31000, { logSince: o.logSince('s1', now + 31000) });
  assert.equal(o.queryLog({}).length, 3, 'newer events still log');
});

test('office: an agent discovered at server start logs its start row with its own time', () => {
  const now = 100 * MIN;
  const o = setup([S('s1')], now);
  o.syncAgents('s1', [M('a1', { mtimeMs: now - 10 * MIN }), M('old', { mtimeMs: now - 40 * MIN }), M('new')], now);
  const rows = o.queryLog({});
  assert.deepEqual(rows.map((e) => [e.text, e.ts]), [['시작', now], ['시작', now - 10 * MIN]]);
});

// F9
test('office: a waiting session idles a working or thinking lead', () => {
  const o = setup();
  o.applySessionEvents('s1', [tool(1100, 'node 실행', 'Bash')], 1100);
  assert.equal(floorOf(o, 's1').lead.state, 'working');
  o.syncSessions([S('s1', { status: 'busy' })], 1200);
  assert.equal(floorOf(o, 's1').lead.state, 'working', 'busy keeps it');
  o.syncSessions([S('s1', { status: 'idle' })], 1300);
  const lead = floorOf(o, 's1').lead;
  assert.equal(lead.state, 'idle');
  assert.equal(lead.bubble, '');
  o.applySessionEvents('s1', [{ kind: 'think', ts: 1400 }], 1400);
  o.syncSessions([S('s1', { status: 'idle' })], 1500);
  assert.equal(floorOf(o, 's1').lead.state, 'idle');
});

// F14 / F18
test('office: queryLog is newest first by ts and the limit applies after sorting', () => {
  const now = 100 * MIN;
  const o = setup([S('s1')], now);
  o.syncAgents('s1', [], now);
  o.applySessionEvents('s1', [tool(now - 25 * MIN, 'lead-old'), tool(now - 3 * MIN, 'lead-new')], now);
  o.syncAgents('s1', [M('a1', { mtimeMs: now - 20 * MIN })], now);
  o.applyAgentEvents('s1', 'a1', [tool(now - 10 * MIN, 'agent-10'), tool(now - 1 * MIN, 'agent-1')], now);
  const ts = o.queryLog({}).map((e) => e.ts);
  assert.deepEqual(ts, [...ts].sort((a, b) => b - a));
  assert.deepEqual(o.queryLog({ limit: 2 }).map((e) => e.text), ['agent-1', 'lead-new']);
  assert.deepEqual(o.queryLog({ limit: 2 }).reverse().map((e) => e.text), ['lead-new', 'agent-1'], 'SSE initial order is oldest first');
});

test('office: a merged read row moves up with its new ts', () => {
  const o = setup([S('s1')], 1000);
  o.syncAgents('s1', [M('a1')], 1000);
  o.applySessionEvents('s1', [tool(2000, 'a.cs', 'Read')], 2000);
  o.applyAgentEvents('s1', 'a1', [tool(3000, 'ls')], 3000);
  o.applySessionEvents('s1', [tool(4000, 'b.cs', 'Read')], 4000); // merges into the first read row, which sits below the agent row
  const rows = o.queryLog({});
  assert.deepEqual(rows.map((e) => e.text).slice(0, 2), ['파일 2개 살펴봄', 'ls']);
});

// F21
test('office: rename strips bidi controls and zero-width characters', () => {
  const o = setup();
  o.rename('s1', '‮abc​⁦x﻿');
  assert.equal(floorOf(o, 's1').title, 'abcx');
  const o2 = new Office(cfg, { hidden: [], names: { s1: '‮y​z' } });
  o2.syncSessions([S('s1')], 1000);
  assert.equal(floorOf(o2, 's1').title, 'yz');
});

// F23
test('office: an abandoned agent is released silently', () => {
  const o = setup();
  o.syncAgents('s1', [M('a1'), M('a2')], 1000);
  o.drainLog();
  o.syncAgents('s1', [M('a1', { finished: false, abandoned: true }), M('a2')], 2000);
  const f = floorOf(o, 's1');
  assert.deepEqual(f.agents.map((a) => a.agentId), ['a2']);
  assert.equal(f.reports, 0);
  assert.deepEqual(o.drainLog().map((e) => e.text), ['응답 없이 종료']);
  o.syncAgents('s1', [M('a1', { abandoned: true }), M('a2')], 2500); // repeated sync adds nothing
  assert.equal(floorOf(o, 's1').agents.length, 1);
  assert.deepEqual(o.drainLog(), []);
});

test('office: an abandoned agent seen first is not created', () => {
  const o = setup();
  o.syncAgents('s1', [M('a1', { abandoned: true })], 1000);
  assert.deepEqual(floorOf(o, 's1').agents, []);
  assert.deepEqual(o.queryLog({}), []);
});

// F6 / F19
test('office: the board line clears when the owning run is done', () => {
  const o = setup();
  o.applySessionEvents('s1', [
    { kind: 'workflowLaunch', ts: 1000, runId: 'r1', workflowName: 'one', scriptPath: 'x' },
    { kind: 'workflowLaunch', ts: 1000, runId: 'r2', workflowName: 'two', scriptPath: 'y' },
  ], 1000);
  assert.equal(floorOf(o, 's1').workflows, 2);
  o.setWorkflowProgress('s1', 'r1', { name: 'one', phases: ['A', 'B'], current: 'A' });
  o.setWorkflowProgress('s1', 'r2', { name: 'two', phases: ['A'], current: 'A' });
  o.setWorkflowProgress('s1', 'r1', { name: 'one', phases: ['A', 'B'], current: 'B', done: true });
  assert.equal(floorOf(o, 's1').board.line, 'two · A 1/1', 'a run that does not own the line leaves it alone');
  assert.equal(floorOf(o, 's1').workflows, 1);
  o.setWorkflowProgress('s1', 'r2', { name: 'two', phases: ['A'], current: 'A', done: true });
  assert.equal(floorOf(o, 's1').board.line, '');
  assert.equal(floorOf(o, 's1').workflows, 0);
  assert.equal(o.workflowRuns('s1').length, 2, 'the poller still learns every run');
  o.setWorkflowProgress('s1', 'r2', { name: 'two', phases: ['A'], current: 'A' }); // a later phase wakes it again
  assert.equal(floorOf(o, 's1').board.line, 'two · A 1/1');
  assert.equal(floorOf(o, 's1').workflows, 1);
});

test('office: a run with no phase yet shows just its name', () => {
  const o = setup();
  o.setWorkflowProgress('s1', 'r1', { name: '새 워크플로', phases: ['a', 'b'], current: '' });
  assert.equal(floorOf(o, 's1').board.line, '새 워크플로');
});

test('office: a progress report without current never shows the string undefined', () => {
  const o = setup();
  o.setWorkflowProgress('s1', 'r1', { name: '새 워크플로', phases: ['a'] });
  assert.equal(floorOf(o, 's1').board.line, '새 워크플로');
});

// F22 / F33
test('office: logTitles gives live titles, remembers departed ones and never lists hidden sessions', () => {
  const o = setup([S('s1', { cwd: 'C:\\Project\\app' }), S('s2', { startedAt: 2000 }), S('s3', { startedAt: 3000 })]);
  for (const id of ['s1', 's2', 's3']) o.applySessionEvents(id, [tool(1100, '작업')], 1100);
  o.rename('s1', '결제 리뷰');
  o.hide('s3');
  assert.deepEqual(o.logTitles(['s1', 's2', 's3', 'zz']), { s1: '결제 리뷰', s2: 'Project' });
  assert.equal(o.logTitles(['s1']).s1, floorOf(o, 's1').title, 'exactly the snapshot title');
  o.syncSessions([S('s2', { startedAt: 2000 })], 2000);
  o.tick(2000 + cfg.floor.leaveMs);
  assert.equal(floorOf(o, 's1'), undefined);
  assert.deepEqual(o.logTitles(['s1']), { s1: '결제 리뷰' }, 'departed floor keeps its title');
  assert.equal(o.logTitles(['s3']).s3, undefined);
});

test('office: departed titles are forgotten once the log no longer references them', () => {
  const o = setup([S('s1'), S('s2', { startedAt: 2000 })]);
  o.applySessionEvents('s1', [tool(1100, '작업')], 1100);
  o.syncSessions([S('s2', { startedAt: 2000 })], 2000);
  o.tick(2000 + cfg.floor.leaveMs);
  assert.equal(o.departedTitles.has('s1'), true);
  o.ring.length = 0; // the log rolled over
  o.syncSessions([], 9000);
  o.tick(9000 + cfg.floor.leaveMs); // the next floor to leave prunes
  assert.equal(o.departedTitles.has('s1'), false);
});

// T8B
test('office: a new floor gets the least used design, existing floors keep theirs', () => {
  const layout = (image) => ({ ...cfg.layouts.studio, image });
  const c3 = loadConfig({ designOrder: ['a', 'b', 'c'], layouts: { a: layout('a.png'), b: layout('b.png'), c: layout('c.png') } });
  const o = new Office(c3, EMPTY);
  const live = (...ids) => ids.map((id) => S(id, { startedAt: Number(id.slice(1)) }));
  const designs = () => Object.fromEntries(o.snapshot().floors.map((f) => [f.sessionId, f.design]));
  o.syncSessions(live('s1', 's2', 's3'), 1000);
  assert.deepEqual(designs(), { s1: 'a', s2: 'b', s3: 'c' });
  o.syncSessions(live('s1', 's3'), 2000);
  o.tick(2000 + c3.floor.leaveMs); // b is free now
  o.syncSessions(live('s1', 's3', 's4'), 9000);
  assert.deepEqual(designs(), { s1: 'a', s3: 'c', s4: 'b' }, 'rotation alone would give a');
});
