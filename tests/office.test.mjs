import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../server/config.mjs';
import { Office } from '../server/office.mjs';

const cfg = loadConfig();
const EMPTY = { hidden: [], names: {} };

const S = (id, o = {}) => ({
  provider: 'claude', pid: 100, sessionId: id, cwd: 'C:\\Project', status: 'busy', name: '', startedAt: 1000, ...o,
});
const M = (id, o = {}) => ({
  agentId: id, agentType: 'worker', description: '기록 구조 조사', finished: false, transcriptPath: '', mtimeMs: 0, workflow: null, ...o,
});
const tool = (ts, text, name = 'Bash') => ({ kind: 'tool', ts, toolUseId: `t${ts}`, name, text });
const floorOf = (o, id) => o.snapshot().floors.find((f) => f.sessionId === id);

function setup(live = [S('s1')], now = 1000) {
  const o = new Office(cfg, EMPTY);
  o.syncSessions(live, now);
  return o;
}

test('office: new session becomes a floor with lead 유나·팀장', () => {
  const o = setup([S('s1', { cwd: 'C:\\Project\\app' })]);
  const f = floorOf(o, 's1');
  assert.equal(f.floorNo, 1);
  assert.equal(f.provider, 'claude');
  assert.equal(f.status, 'busy');
  assert.equal(f.folder, 'app');
  assert.equal(f.title, 'app');
  assert.equal(f.autoTitle, 'app');
  assert.deepEqual(f.board, { title: 'app', line: '' });
  assert.equal(f.lead.name, '유나');
  assert.equal(f.lead.role, '팀장');
  assert.equal(f.lead.sprite, 'lead');
  assert.deepEqual(f.agents, []);
  assert.equal(f.reports, 0);
});

test('office: floors ordered newest first with stable floorNo', () => {
  const o = setup([S('a', { startedAt: 3000 }), S('b', { startedAt: 1000 }), S('c', { startedAt: 2000 })]);
  assert.deepEqual(o.snapshot().floors.map((f) => [f.sessionId, f.floorNo]), [['a', 3], ['c', 2], ['b', 1]]);
  o.syncSessions([S('a', { startedAt: 3000 }), S('b', { startedAt: 1000 }), S('c', { startedAt: 2000 }), S('d', { startedAt: 4000 })], 2000);
  assert.deepEqual(o.snapshot().floors.map((f) => [f.sessionId, f.floorNo]), [['d', 4], ['a', 3], ['c', 2], ['b', 1]]);
});

test('office: floor leaves then disappears', () => {
  const o = setup([S('s1'), S('s2', { startedAt: 2000 })]);
  o.syncSessions([S('s2', { startedAt: 2000 })], 5000);
  assert.equal(floorOf(o, 's1').status, 'leaving');
  assert.equal(o.tick(5000 + cfg.floor.leaveMs - 1), false);
  assert.ok(floorOf(o, 's1'));
  assert.equal(o.tick(5000 + cfg.floor.leaveMs), true);
  assert.equal(floorOf(o, 's1'), undefined);
  assert.equal(o.snapshot().floors[0].floorNo, 1);
});

test('office: status busy stays busy, anything else is waiting', () => {
  const o = setup([S('s1', { status: 'busy' }), S('s2', { status: 'idle' })]);
  assert.equal(floorOf(o, 's1').status, 'busy');
  assert.equal(floorOf(o, 's2').status, 'waiting');
});

test('office: hidden record is dropped when its session ends', () => {
  const o = setup();
  assert.equal(o.hide('s1'), true);
  assert.equal(o.saved().hidden.length, 1);
  o.syncSessions([], 2000);
  assert.deepEqual(o.saved().hidden, []);
  assert.equal(o.snapshot().floors.length, 0, 'leaving floor of a hidden session stays hidden');
  assert.equal(o.hide('nope'), false);
});

test('office: worker gets 서진, second worker 서진+1, freed number reused', () => {
  const o = setup();
  o.syncAgents('s1', [M('a1'), M('a2'), M('a3')], 1000);
  const names = () => floorOf(o, 's1').agents.map((a) => a.name);
  assert.deepEqual(names(), ['서진', '서진+1', '서진+2']);
  const a1 = floorOf(o, 's1').agents[0];
  assert.equal(a1.role, '개발');
  assert.equal(a1.sprite, 'worker');
  // a2 (서진+1) finishes and is removed -> its number is free again
  o.syncAgents('s1', [M('a1'), M('a2', { finished: true }), M('a3')], 2000);
  o.tick(2000 + cfg.agent.doneLingerMs);
  assert.deepEqual(names(), ['서진', '서진+2']);
  o.syncAgents('s1', [M('a1'), M('a3'), M('a4')], 20000);
  assert.deepEqual(names(), ['서진', '서진+2', '서진+1']);
});

test('office: unknown agentType uses 나래·지원', () => {
  const o = setup();
  o.syncAgents('s1', [M('a1', { agentType: 'mystery' }), M('a2', { agentType: '__lead' })], 1000);
  const [a, b] = floorOf(o, 's1').agents;
  assert.deepEqual([a.name, a.role, a.sprite], ['나래', '지원', 'default']);
  assert.equal(b.name, '나래+1');
});

test('office: desks fill first, then aisle, then overflow index', () => {
  const L = cfg.layouts.studio;
  const total = L.desks.length + L.aisle.length;
  const o = setup();
  const metas = Array.from({ length: total + 2 }, (_, i) => M(`a${i}`));
  o.syncAgents('s1', metas, 1000);
  const slots = floorOf(o, 's1').agents.map((a) => a.slot);
  L.desks.forEach((d, i) => assert.deepEqual(slots[i], { x: d[0], y: d[1], i }));
  L.aisle.forEach((p, k) => assert.deepEqual(slots[L.desks.length + k], { x: p[0], y: p[1], i: L.desks.length + k }));
  const last = L.aisle.at(-1);
  assert.deepEqual(slots[total], { x: last[0], y: last[1], i: total });
  assert.deepEqual(slots[total + 1], { x: last[0], y: last[1], i: total + 1 });
  // freed desk 0 is reused by the next newcomer
  o.syncAgents('s1', metas.map((m, i) => (i === 0 ? { ...m, finished: true } : m)), 2000);
  o.tick(2000 + cfg.agent.doneLingerMs);
  o.syncAgents('s1', [{ ...metas[0], finished: true }, ...metas.slice(1), M('late')], 30000);
  const late = floorOf(o, 's1').agents.find((a) => a.agentId === 'late');
  assert.equal(late.slot.i, 0);
});

test('office: floors get designs in rotation and keep them', () => {
  const layout = (image) => ({ ...cfg.layouts.studio, image });
  const c2 = loadConfig({ designOrder: ['a', 'b'], layouts: { a: layout('a.png'), b: layout('b.png') } });
  const o = new Office(c2, EMPTY);
  o.syncSessions([S('s1', { startedAt: 1 }), S('s2', { startedAt: 2 }), S('s3', { startedAt: 3 })], 1000);
  const designs = () => Object.fromEntries(o.snapshot().floors.map((f) => [f.sessionId, f.design]));
  assert.deepEqual(designs(), { s1: 'a', s2: 'b', s3: 'a' });
  o.syncSessions([S('s2', { startedAt: 2 }), S('s3', { startedAt: 3 })], 2000);
  o.tick(2000 + c2.floor.leaveMs);
  assert.deepEqual(designs(), { s2: 'b', s3: 'a' });
  o.syncSessions([S('s2', { startedAt: 2 }), S('s3', { startedAt: 3 }), S('s4', { startedAt: 4 })], 9000);
  assert.deepEqual(designs(), { s2: 'b', s3: 'a', s4: 'b' });
});

test('office: tool event sets working with sanitized bubble; toolDone sets thinking', () => {
  const o = setup();
  o.syncAgents('s1', [M('a1')], 1000);
  assert.equal(floorOf(o, 's1').agents[0].state, 'enter');
  o.applyAgentEvents('s1', 'a1', [tool(1100, 'app.js 고치는 중', 'Edit')], 1100);
  let a = floorOf(o, 's1').agents[0];
  assert.equal(a.state, 'working');
  assert.equal(a.bubble, 'app.js 고치는 중');
  assert.equal(a.since, 1100);
  o.applyAgentEvents('s1', 'a1', [{ kind: 'toolDone', ts: 1200, toolUseId: 't1100' }], 1200);
  a = floorOf(o, 's1').agents[0];
  assert.equal(a.state, 'thinking');
  assert.equal(a.bubble, '생각 중…');
  o.applyAgentEvents('s1', 'a1', [{ kind: 'think', ts: 1300 }, tool(1400, '검색 중', 'Grep'), { kind: 'end', ts: 1500 }], 1500);
  assert.equal(floorOf(o, 's1').agents[0].state, 'working', 'end changes nothing');
  o.applyAgentEvents('s1', 'nobody', [tool(1600, 'x')], 1600); // unknown agent: ignored
  o.applySessionEvents('s1', [tool(1700, 'node 실행')], 1700);
  assert.deepEqual([floorOf(o, 's1').lead.state, floorOf(o, 's1').lead.bubble], ['working', 'node 실행']);
});

test('office: finished agent goes done, reports+1, removed after doneLingerMs', () => {
  const o = setup();
  o.syncAgents('s1', [M('a1')], 1000);
  o.syncAgents('s1', [M('a1', { finished: true })], 2000);
  let f = floorOf(o, 's1');
  assert.equal(f.agents[0].state, 'done');
  assert.equal(f.reports, 1);
  o.syncAgents('s1', [M('a1', { finished: true })], 2500); // repeated sync does not double count
  assert.equal(floorOf(o, 's1').reports, 1);
  assert.equal(o.tick(2000 + cfg.agent.doneLingerMs - 1), false);
  assert.equal(o.tick(2000 + cfg.agent.doneLingerMs), true);
  f = floorOf(o, 's1');
  assert.deepEqual(f.agents, []);
  assert.equal(f.reports, 1);
  o.syncAgents('s1', [M('a1', { finished: true })], 40000); // finished + gone: not shown again
  assert.deepEqual(floorOf(o, 's1').agents, []);
});

test('office: already-finished agents on first sync are not shown', () => {
  const o = setup();
  o.syncAgents('s1', [M('old', { finished: true }), M('live')], 1000);
  const f = floorOf(o, 's1');
  assert.deepEqual(f.agents.map((a) => a.agentId), ['live']);
  assert.equal(f.reports, 0);
  assert.deepEqual(o.queryLog({}).map((e) => e.head), ['기록 구조 조사']);
});

test('office: stale after staleMs without events', () => {
  const o = setup();
  o.syncAgents('s1', [M('a1')], 1000);
  o.applyAgentEvents('s1', 'a1', [tool(5000, 'node 실행')], 5000);
  assert.equal(o.tick(5000 + cfg.agent.staleMs - 1), false);
  assert.equal(floorOf(o, 's1').agents[0].state, 'working');
  assert.equal(o.tick(5000 + cfg.agent.staleMs), true);
  const a = floorOf(o, 's1').agents[0];
  assert.deepEqual([a.state, a.bubble], ['stale', '응답 없음']);
  assert.equal(o.tick(5000 + cfg.agent.staleMs + 1), false);
  o.applyAgentEvents('s1', 'a1', [tool(9e5, 'node 실행')], 9e5);
  assert.equal(floorOf(o, 's1').agents[0].state, 'working', 'new event wakes a stale agent');
});

test('office: hidden session is absent from snapshot and log', () => {
  const o = setup([S('s1', { startedAt: 1 }), S('s2', { startedAt: 2 }), S('s3', { startedAt: 3 })]);
  o.syncAgents('s1', [M('before')], 1000);
  o.syncAgents('s2', [M('x')], 1000);
  assert.equal(o.hide('s1'), true);
  assert.deepEqual(o.snapshot().floors.map((f) => [f.sessionId, f.floorNo]), [['s3', 2], ['s2', 1]]);
  o.syncAgents('s1', [M('before'), M('after')], 2000);
  o.applySessionEvents('s1', [tool(2100, 'secret-lead-action')], 2100);
  o.applyAgentEvents('s1', 'after', [tool(2200, 'secret-agent-action')], 2200);
  const drained = o.drainLog();
  assert.ok(drained.length > 0 && drained.every((e) => e.sessionId !== 's1'));
  assert.ok(o.queryLog({}).every((e) => e.sessionId !== 's1'));
  assert.deepEqual(o.queryLog({ sessionId: 's1' }), []);
  assert.ok(!JSON.stringify(o.snapshot()).includes('secret-'));
  // a later drain never replays what happened while hidden
  o.syncAgents('s2', [M('x'), M('y')], 3000);
  assert.ok(o.drainLog().every((e) => e.sessionId === 's2'));
});

test('office: hidden session reappears when re-run', () => {
  const o = setup();
  o.hide('s1');
  o.syncSessions([S('s1')], 2000);
  assert.equal(o.snapshot().floors.length, 0, 'same pid keeps it hidden');
  o.syncSessions([S('s1', { pid: 200 })], 3000);
  assert.equal(o.snapshot().floors.length, 1);
  assert.deepEqual(o.saved().hidden, []);
  o.hide('s1');
  o.syncSessions([S('s1', { pid: 200, startedAt: 9999 })], 4000);
  assert.equal(o.snapshot().floors.length, 1, 'different startedAt also reappears');
});

test('office: hidden survives restart via saved()', () => {
  const o = setup();
  o.hide('s1');
  o.rename('s1', '내 이름');
  const saved = JSON.parse(JSON.stringify(o.saved()));
  const o2 = new Office(cfg, saved);
  o2.syncSessions([S('s1')], 5000);
  assert.equal(o2.snapshot().floors.length, 0);
  const o3 = new Office(cfg, saved);
  o3.syncSessions([S('s1', { pid: 777 })], 5000);
  assert.equal(floorOf(o3, 's1').title, '내 이름');
});

test('office: saved() is a copy and savedVersion counts changes', () => {
  const o = setup();
  const v0 = o.savedVersion;
  o.hide('s1');
  assert.equal(o.savedVersion, v0 + 1);
  o.hide('s1');
  assert.equal(o.savedVersion, v0 + 1, 'no change, no bump');
  o.rename('s1', 'a');
  assert.equal(o.savedVersion, v0 + 2);
  o.rename('s1', 'a');
  assert.equal(o.savedVersion, v0 + 2);
  const s = o.saved();
  s.hidden.push({ sessionId: 'z', pid: 1, startedAt: 1 });
  s.names.z = 'z';
  assert.equal(o.saved().hidden.length, 1);
  assert.deepEqual(o.saved().names, { s1: 'a' });
  o.syncSessions([], 2000);
  assert.equal(o.savedVersion, v0 + 3, 'dropping a hidden record bumps too');
});

test('office: rename sets title everywhere and empty restores auto title', () => {
  const o = setup();
  o.applySessionEvents('s1', [{ kind: 'title', ts: 0, title: '자동 제목' }], 1000);
  assert.deepEqual([floorOf(o, 's1').title, floorOf(o, 's1').autoTitle], ['자동 제목', '자동 제목']);
  o.rename('s1', '  결제 리뷰 \u0007 ');
  let f = floorOf(o, 's1');
  assert.equal(f.title, '결제 리뷰');
  assert.equal(f.autoTitle, '자동 제목');
  assert.equal(f.board.title, '결제 리뷰');
  o.rename('s1', '가'.repeat(31));
  assert.equal(Array.from(floorOf(o, 's1').title).length, 30);
  o.rename('s1', '');
  f = floorOf(o, 's1');
  assert.equal(f.title, f.autoTitle);
  o.rename('s1', '이름');
  o.rename('s1', null);
  assert.equal(floorOf(o, 's1').title, '자동 제목');
  assert.deepEqual(o.saved().names, {});
});

test('office: title falls back to folder name for both slash styles', () => {
  const o = setup([S('s1', { cwd: '/home/me/proj/' }), S('s2', { cwd: 'C:\\Project', startedAt: 2000 })]);
  assert.equal(floorOf(o, 's1').title, 'proj');
  assert.equal(floorOf(o, 's2').title, 'Project');
});

test('office: consecutive reads merge into one log entry', () => {
  const o = setup();
  o.syncAgents('s1', [M('a1')], 1000);
  o.drainLog();
  const read = (t) => o.applyAgentEvents('s1', 'a1', [tool(t, 'x.cs 읽는 중', 'Read')], t);
  read(10_000); read(20_000); read(30_000);
  let d = o.drainLog();
  assert.equal(d.length, 1);
  assert.equal(d[0].text, '파일 3개 살펴봄');
  const id = d[0].id;
  read(30_000 + cfg.log.mergeWindowMs + 1);
  d = o.drainLog();
  assert.equal(d.length, 1);
  assert.notEqual(d[0].id, id);
  assert.equal(d[0].text, '파일 1개 살펴봄');
  assert.equal(o.queryLog({}).filter((e) => e.text.startsWith('파일')).length, 2);
});

test('office: log entries for start, actions and end; actions break read merging', () => {
  const o = setup();
  o.syncAgents('s1', [M('a1'), M('w1', { agentType: 'Explore', workflow: { runId: 'r', phase: 'Review', label: 'ctx' } })], 1000);
  o.applyAgentEvents('s1', 'a1', [tool(2000, 'a.js 읽는 중', 'Read'), tool(2100, 'a.js 고치는 중', 'Edit'), tool(2200, 'b.js 읽는 중', 'Read')], 2200);
  o.applyAgentEvents('s1', 'a1', [{ kind: 'end', ts: 2300 }], 2300);
  o.syncAgents('s1', [M('a1', { finished: true }), M('w1')], 2400); // no duplicate completion entry
  const log = o.queryLog({ sessionId: 's1', name: '서진' }).reverse().map((e) => [e.head, e.text]);
  assert.deepEqual(log, [
    ['기록 구조 조사', '시작'],
    ['기록 구조 조사', '파일 1개 살펴봄'],
    ['기록 구조 조사', 'a.js 고치는 중'],
    ['기록 구조 조사', '파일 1개 살펴봄'],
    ['기록 구조 조사', '완료 · 보고함에 제출'],
  ]);
  const wf = o.queryLog({ name: '루아' });
  assert.deepEqual([wf[0].head, wf[0].text, wf[0].role, wf[0].sprite], ['Review · ctx', '시작', '탐색', 'explore']);
  assert.equal(o.queryLog({ limit: 2 }).length, 2);
  o.applySessionEvents('s1', [tool(3000, '위임 · 조사', 'Agent')], 3000);
  assert.deepEqual(o.queryLog({ name: '유나' }).map((e) => [e.text, e.role, e.sprite]), [['위임 · 조사', '팀장', 'lead']]);
});

test('office: log is a ring capped at cfg.log.cap and heads are clipped', () => {
  const c = loadConfig({ log: { cap: 5 } });
  const o = new Office(c, EMPTY);
  o.syncSessions([S('s1')], 1000);
  o.syncAgents('s1', [M('a1', { description: 'd'.repeat(500) })], 1000);
  for (let i = 0; i < 20; i++) o.applyAgentEvents('s1', 'a1', [tool(2000 + i, `cmd${i} 실행`)], 2000 + i);
  const q = o.queryLog({ limit: 100 });
  assert.equal(q.length, 5);
  assert.equal(q[0].text, 'cmd19 실행');
  assert.ok(Array.from(q[0].head).length <= c.log.headMaxChars);
  assert.equal(o.drainLog().length, 5);
});

test('office: workflow board line', () => {
  const o = setup();
  o.applySessionEvents('s1', [
    { kind: 'workflowLaunch', ts: 1000, runId: '', workflowName: 'ignored', scriptPath: 'x' },
    { kind: 'workflowLaunch', ts: 1000, runId: 'r1', workflowName: 'review-changes', scriptPath: 'C:/w/review.mjs' },
  ], 1000);
  assert.deepEqual(o.workflowRuns('s1'), [{ runId: 'r1', name: 'review-changes', scriptPath: 'C:/w/review.mjs' }]);
  o.setWorkflowProgress('s1', 'r1', { name: 'review-changes', phases: ['Review', 'Verify'], current: 'Verify' });
  assert.equal(floorOf(o, 's1').board.line, 'review-changes · Verify 2/2');
  o.setWorkflowProgress('s1', 'r1', { name: 'review-changes', phases: [], current: 'Review' });
  assert.equal(floorOf(o, 's1').board.line, 'review-changes · Review');
  o.setWorkflowProgress('s1', 'r1', { name: 'review-changes', phases: ['Review', 'Verify'], current: 'Gone' });
  assert.equal(floorOf(o, 's1').board.line, 'review-changes · Gone');
});

test('office: removing a floor releases its per-floor state', () => {
  const o = setup();
  o.syncAgents('s1', [M('a1')], 1000);
  o.syncSessions([], 2000);
  o.tick(2000 + cfg.floor.leaveMs);
  assert.equal(o.snapshot().floors.length, 0);
  o.applyAgentEvents('s1', 'a1', [tool(3000, 'x')], 3000); // no throw, no resurrection
  o.syncAgents('s1', [M('a1')], 3000);
  assert.equal(o.snapshot().floors.length, 0);
  assert.deepEqual(o.workflowRuns('s1'), []);
});

test('office: nothing logged while hidden resurfaces after the session is re-run', () => {
  const o = setup();
  o.syncAgents('s1', [M('a1')], 1000);
  o.hide('s1');
  o.applyAgentEvents('s1', 'a1', [tool(2000, 'secret-action')], 2000);
  o.applySessionEvents('s1', [tool(2100, 'secret-lead')], 2100);
  o.syncSessions([S('s1', { pid: 555 })], 3000);
  assert.ok(o.snapshot().floors.length === 1);
  assert.ok(!JSON.stringify([o.drainLog(), o.queryLog({})]).includes('secret-'));
});
