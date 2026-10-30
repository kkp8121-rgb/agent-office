// Whiteboard to-dos, workflow phase signals and failure signals (server side of the fun2 features).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { loadConfig } from '../server/config.mjs';
import { Office } from '../server/office.mjs';
import { createServer } from '../server/http.mjs';
import { parseLine } from '../server/parse.mjs';
import { parseCodexLine } from '../server/codex.mjs';

const cfg = loadConfig();
const EMPTY = { hidden: [], names: {} };
const fixture = (name) => readFileSync(new URL(`./fixtures/fun2/${name}`, import.meta.url), 'utf8').split('\n').filter(Boolean);

const S = (id, o = {}) => ({
  provider: 'claude', pid: 100, sessionId: id, cwd: 'C:\\Project', status: 'busy', name: '', startedAt: 1000, ...o,
});
const M = (id) => ({ agentId: id, agentType: 'worker', description: '조사', finished: false, transcriptPath: '', mtimeMs: 0, workflow: null });
const todoWrite = (ts, todos) => ({ kind: 'tool', ts, toolUseId: `t${ts}`, name: 'TodoWrite', text: '할 일 정리', todos });
const fail = (ts) => ({ kind: 'toolDone', ts, toolUseId: `d${ts}`, error: true });
const ok = (ts) => ({ kind: 'toolDone', ts, toolUseId: `d${ts}` });
const T = (n, status = 'pending') => ({ text: `할 일 ${n}`, status });
const floorOf = (o, id) => o.snapshot().floors.find((f) => f.sessionId === id);

/** Office whose floor was created at `at` (events stamped earlier are backfill). */
function setup(provider = 'claude', at = 100000) {
  const o = new Office(cfg, EMPTY);
  o.syncSessions([S('s1', { provider })], at);
  return o;
}

// ---- parse: Claude ---------------------------------------------------------------------------

test('fun2 parse: TodoWrite keeps clipped one-line texts and statuses, nothing else', () => {
  const [write] = parseLine(fixture('claude-todos.jsonl')[0]);
  assert.equal(write.name, 'TodoWrite');
  assert.deepEqual(write.todos.map((t) => t.status), ['completed', 'in_progress', 'pending']);
  assert.equal(write.todos[0].text, '기획서 읽기');
  assert.equal(Array.from(write.todos[1].text).length, 20);
  assert.ok(write.todos[1].text.endsWith('…'));
  assert.equal(write.todos[2].text, '줄 바꿈 포함');
  assert.ok(!/activeForm|읽는 중/.test(JSON.stringify(write)));
});

test('fun2 parse: only the is_error flag of a tool_result is read', () => {
  const lines = fixture('claude-todos.jsonl');
  const [bad] = parseLine(lines[1]);
  const [good] = parseLine(lines[2]);
  assert.deepEqual(bad, { kind: 'toolDone', ts: Date.parse('2026-10-28T10:00:01.000Z'), toolUseId: 'tu1', error: true });
  assert.equal('error' in good, false);
  assert.ok(!JSON.stringify([bad, good]).includes('SECRET'));
});

test('fun2 parse: TaskCreate / TaskUpdate and bad TodoWrite input', () => {
  const use = (name, input) => JSON.stringify({ type: 'assistant', timestamp: '2026-10-28T10:00:00.000Z', message: { content: [{ type: 'tool_use', id: 'x', name, input }] } });
  assert.equal(parseLine(use('TaskCreate', { subject: '문서\n쓰기', description: 'SECRET' }))[0].taskCreate, '문서 쓰기');
  assert.deepEqual(parseLine(use('TaskUpdate', { taskId: '2', status: 'completed', subject: 'x' }))[0].taskUpdate, { id: 2, status: 'completed' });
  assert.equal('todos' in parseLine(use('TodoWrite', { todos: 'nope' }))[0], false);
  assert.deepEqual(parseLine(use('TodoWrite', { todos: [] }))[0].todos, []);
  assert.deepEqual(parseLine(use('TodoWrite', { todos: [null, 3, { content: 5 }, { content: ' ', status: 'pending' }, { content: 'ok', status: 'weird' }] }))[0].todos, [{ text: 'ok', status: 'pending' }]);
});

// ---- parse: Codex ----------------------------------------------------------------------------

test('fun2 codex: update_plan copies step texts and statuses; command end gives only the exit flag', () => {
  const lines = fixture('codex-plan.jsonl');
  const [plan] = parseCodexLine(lines[0]);
  assert.equal(plan.name, 'update_plan');
  assert.deepEqual(plan.todos, [
    { text: '설계 확인', status: 'completed' }, { text: '구현하기', status: 'in_progress' }, { text: '시험 돌리기', status: 'pending' },
  ]);
  assert.ok(!JSON.stringify(plan).includes('SECRET'));
  const bad = parseCodexLine(lines[1]);
  assert.deepEqual(bad.map(({ kind, error }) => ({ kind, error })), [{ kind: 'toolResult', error: true }]);
  assert.deepEqual(parseCodexLine(lines[2]).map(({ kind, error }) => ({ kind, error })), [{ kind: 'toolResult', error: false }]);
  assert.ok(!JSON.stringify(bad).includes('SECRET'));
  const broken = '{"timestamp":"2026-10-28T10:00:00.000Z","type":"response_item","payload":{"type":"function_call","name":"update_plan","call_id":"c","arguments":"{bad"}}';
  assert.deepEqual(parseCodexLine(broken).map((e) => e.todos), [undefined]);
});

// ---- office: todos ---------------------------------------------------------------------------

test('fun2 office: floor starts with an empty todo list', () => {
  assert.deepEqual(floorOf(setup(), 's1').todos, { items: [], done: 0, total: 0 });
});

test('fun2 office: TodoWrite replaces the list; counts and statuses', () => {
  const o = setup();
  o.applySessionEvents('s1', [todoWrite(100001, [T(1, 'completed'), T(2, 'in_progress'), T(3)])], 100001);
  assert.deepEqual(floorOf(o, 's1').todos, { items: [T(1, 'completed'), T(2, 'in_progress'), T(3)], done: 1, total: 3 });
  o.applySessionEvents('s1', [todoWrite(100002, [T(1, 'completed'), T(2, 'completed'), T(3, 'in_progress')])], 100002);
  assert.deepEqual(floorOf(o, 's1').todos.items.map((t) => t.status), ['completed', 'completed', 'in_progress']);
  assert.equal(floorOf(o, 's1').todos.done, 2);
  o.applySessionEvents('s1', [todoWrite(100003, [])], 100003);
  assert.deepEqual(floorOf(o, 's1').todos, { items: [], done: 0, total: 0 });
});

test('fun2 office: at most 12 items, the in-progress one is among them', () => {
  const o = setup();
  const list = Array.from({ length: 30 }, (_, i) => T(i + 1, i < 20 ? 'completed' : i === 20 ? 'in_progress' : 'pending'));
  o.applySessionEvents('s1', [todoWrite(100001, list)], 100001);
  const v = floorOf(o, 's1').todos;
  assert.equal(v.items.length, 12);
  assert.equal(v.total, 30);
  assert.equal(v.done, 20);
  assert.ok(v.items.some((t) => t.status === 'in_progress'));
  list[0].status = 'in_progress'; // current item at the very start
  o.applySessionEvents('s1', [todoWrite(100002, list)], 100002);
  assert.equal(floorOf(o, 's1').todos.items[0].text, '할 일 1');
});

test('fun2 office: TaskCreate / TaskUpdate build a list by creation order', () => {
  const o = setup();
  const ev = (extra) => ({ kind: 'tool', ts: 100001, toolUseId: 'x', name: 'TaskCreate', text: '할 일 정리', ...extra });
  o.applySessionEvents('s1', [
    ev({ taskCreate: '하나' }), ev({ taskCreate: '둘' }),
    ev({ name: 'TaskUpdate', taskUpdate: { id: 1, status: 'completed' } }),
    ev({ name: 'TaskUpdate', taskUpdate: { id: 2, status: 'in_progress' } }),
    ev({ name: 'TaskUpdate', taskUpdate: { id: 9, status: 'completed' } }),
    ev({ name: 'TaskUpdate', taskUpdate: { id: 2, status: 'bogus' } }),
  ], 100001);
  assert.deepEqual(floorOf(o, 's1').todos, { items: [{ text: '하나', status: 'completed' }, { text: '둘', status: 'in_progress' }], done: 1, total: 2 });
  o.applySessionEvents('s1', [ev({ name: 'TaskUpdate', taskUpdate: { id: 1, status: 'deleted' } })], 100002);
  assert.equal(floorOf(o, 's1').todos.total, 1);
});

test('fun2 office: sub-agents have no list', () => {
  const o = setup();
  o.syncAgents('s1', [M('a1')], 100000);
  o.applyAgentEvents('s1', 'a1', [todoWrite(100001, [T(1)])], 100001);
  assert.equal(floorOf(o, 's1').todos.total, 0);
});

test('fun2 office: todos from a transcript reach the snapshot without leaking other text', () => {
  const o = setup();
  o.applySessionEvents('s1', fixture('claude-todos.jsonl').flatMap(parseLine), 100000);
  assert.equal(floorOf(o, 's1').todos.total, 3);
  assert.ok(!JSON.stringify(o.snapshot()).includes('SECRET'));
});

// ---- office: workflow phase signals ----------------------------------------------------------

const prog = (current) => ({ name: 'wf', phases: ['가', '나', '다'], current });
const launch = (ts, runId = 'r1') => ({ kind: 'workflowLaunch', ts, runId, workflowName: 'wf', scriptPath: 'C:/w.mjs' });
const phases = (o) => o.drainSignals().filter((s) => s.type === 'phase').map(({ sessionId, phase }) => ({ sessionId, phase }));

test('fun2 phase: a run found already under way raises nothing for the phase it is in or the ones past', () => {
  const o = setup();
  o.applySessionEvents('s1', [launch(50000)], 100000); // launched before the office saw this session: backfill
  o.setWorkflowProgress('s1', 'r1', prog('')); // journal not read yet
  o.setWorkflowProgress('s1', 'r1', prog('나')); // first phase seen: baseline
  o.setWorkflowProgress('s1', 'r1', prog('나'));
  assert.deepEqual(o.drainSignals(), []);
  o.setWorkflowProgress('s1', 'r1', prog('다')); // a real change from here on
  assert.deepEqual(phases(o), [{ sessionId: 's1', phase: '다' }]);
});

test('fun2 phase: a run launched live signals each phase change once', () => {
  const o = setup();
  o.applySessionEvents('s1', [launch(100500)], 100500);
  o.setWorkflowProgress('s1', 'r1', prog(''));
  assert.deepEqual(o.drainSignals(), []);
  o.setWorkflowProgress('s1', 'r1', prog('가'));
  o.setWorkflowProgress('s1', 'r1', prog('가')); // progress report without a phase change
  o.setWorkflowProgress('s1', 'r1', prog('나'));
  o.setWorkflowProgress('s1', 'r1', prog('나'));
  assert.deepEqual(phases(o).map((s) => s.phase), ['가', '나']);
  assert.deepEqual(o.drainSignals(), []);
  o.setWorkflowProgress('s1', 'r1', { ...prog('나'), done: true });
  assert.deepEqual(o.drainSignals(), []);
});

test('fun2 phase: the phase title is clipped and a hidden floor signals nothing', () => {
  const o = setup();
  o.applySessionEvents('s1', [launch(100500)], 100500);
  o.setWorkflowProgress('s1', 'r1', prog('긴'.repeat(200)));
  const [sig] = o.drainSignals();
  assert.ok(Array.from(sig.phase).length <= cfg.log.headMaxChars);
  o.hide('s1');
  o.setWorkflowProgress('s1', 'r1', prog('나'));
  assert.deepEqual(o.drainSignals(), []);
});

// ---- office: failure signals -----------------------------------------------------------------

const fails = (o) => o.drainSignals().filter((s) => s.type === 'fail').map(({ sessionId, agent, streak }) => ({ sessionId, agent, streak }));

test('fun2 fail: streak counts failures and a success resets it (Claude)', () => {
  const o = setup();
  o.applySessionEvents('s1', [fail(101000), fail(101001), ok(101002), fail(101003)], 101003);
  assert.deepEqual(fails(o), [
    { sessionId: 's1', agent: 'lead', streak: 1 }, { sessionId: 's1', agent: 'lead', streak: 2 }, { sessionId: 's1', agent: 'lead', streak: 1 },
  ]);
});

test('fun2 fail: sub-agents carry their own streak under their snapshot key', () => {
  const o = setup();
  o.syncAgents('s1', [M('a1'), M('a2')], 100000);
  const key = (id) => floorOf(o, 's1').agents.find((a) => a.agentId === id).key;
  o.applyAgentEvents('s1', 'a1', [fail(101000), fail(101001)], 101001);
  o.applyAgentEvents('s1', 'a2', [fail(101002)], 101002);
  o.applySessionEvents('s1', [fail(101003)], 101003);
  assert.deepEqual(fails(o), [
    { sessionId: 's1', agent: key('a1'), streak: 1 }, { sessionId: 's1', agent: key('a1'), streak: 2 },
    { sessionId: 's1', agent: key('a2'), streak: 1 }, { sessionId: 's1', agent: 'lead', streak: 1 },
  ]);
});

test('fun2 fail: Codex counts command ends, and the output event after a failure does not reset it', () => {
  const o = setup('codex');
  const res = (ts, error) => ({ kind: 'toolResult', ts, error });
  o.applySessionEvents('s1', [res(101000, true), ok(101001), res(101002, true), res(101003, false), res(101004, true)], 101004);
  assert.deepEqual(fails(o).map((f) => f.streak), [1, 2, 1]);
});

test('fun2 fail: nothing from backfill, but a live failure after it still counts the streak', () => {
  const o = setup('claude', 100000);
  o.applySessionEvents('s1', [fail(90000), fail(90001), fail(0)], 100000); // older than the floor, or no timestamp
  assert.deepEqual(o.drainSignals(), []);
  o.applySessionEvents('s1', [fail(100100)], 100100);
  assert.deepEqual(fails(o), [{ sessionId: 's1', agent: 'lead', streak: 4 }]);
});

test('fun2 fail: a hidden floor signals nothing; the signal queue is capped', () => {
  const o = setup();
  o.hide('s1');
  o.applySessionEvents('s1', [fail(101000)], 101000);
  assert.deepEqual(o.drainSignals(), []);
  const o2 = setup();
  o2.applySessionEvents('s1', Array.from({ length: 150 }, (_, i) => fail(101000 + i)), 102000);
  const all = o2.drainSignals();
  assert.equal(all.length, 100);
  assert.equal(all.at(-1).streak, 150);
});

// ---- SSE -------------------------------------------------------------------------------------

test('fun2 sse: phase and fail go out as their own events once, and never replay to a later client', async (t) => {
  const o = setup();
  const server = createServer(cfg, o, {});
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeSse(); server.close(); server.closeAllConnections(); });
  const port = server.address().port;
  const connect = (until) => new Promise((resolve) => {
    let text = '';
    const req = http.get({ host: '127.0.0.1', port, path: '/api/events', headers: { Host: `127.0.0.1:${port}` } }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (d) => { text += d; if (until(text)) { req.destroy(); resolve(text); } });
    });
    t.after(() => req.destroy());
  });
  const first = connect((x) => x.includes('event: fail') && x.includes('event: phase'));
  await new Promise((r) => setTimeout(r, 30));
  o.applySessionEvents('s1', [launch(100500), fail(100600)], 100600);
  o.setWorkflowProgress('s1', 'r1', prog('가'));
  server.broadcast();
  const text = await first;
  const frames = [...text.matchAll(/event: (\w+)\ndata: (.*)\n/g)].map((m) => [m[1], JSON.parse(m[2])]);
  const phase = frames.find((f) => f[0] === 'phase')[1];
  const failed = frames.find((f) => f[0] === 'fail')[1];
  assert.deepEqual({ type: phase.type, sessionId: phase.sessionId, phase: phase.phase }, { type: 'phase', sessionId: 's1', phase: '가' });
  assert.deepEqual({ type: failed.type, sessionId: failed.sessionId, agent: failed.agent, streak: failed.streak }, { type: 'fail', sessionId: 's1', agent: 'lead', streak: 1 });
  assert.equal(frames.filter((f) => f[0] === 'phase' || f[0] === 'fail').length, 2);
  // a client that connects later sees state (with the todo board) but no past signal
  const late = await connect((x) => x.includes('event: log'));
  assert.ok(!/event: (phase|fail)/.test(late));
  assert.ok(late.includes('"todos"'));
});
