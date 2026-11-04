// Whiteboard fallback chain: to-do list, else workflow phases, else sub-agents, else the session title.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { loadConfig } from '../server/config.mjs';
import { Office } from '../server/office.mjs';
import { createServer } from '../server/http.mjs';
import { phasesFromScript } from '../server/workflows.mjs';
import { boardSheet, sheetKey } from '../web/board.mjs';

const cfg = loadConfig();
const L = cfg.ui.board;
const EMPTY = { hidden: [], names: {} };
const S = (id, o = {}) => ({ provider: 'claude', pid: 100, sessionId: id, cwd: 'C:\\Project\\내 프로젝트', status: 'busy', name: '', startedAt: 1000, ...o });
const AG = (id, o = {}) => ({ agentId: id, agentType: 'worker', description: '조사', finished: false, transcriptPath: '', mtimeMs: 0, workflow: null, ...o });
const todoWrite = (ts, todos) => ({ kind: 'tool', ts, toolUseId: `t${ts}`, name: 'TodoWrite', text: '할 일 정리', todos });
const launch = (ts, runId = 'r1') => ({ kind: 'workflowLaunch', ts, runId, workflowName: 'wf', scriptPath: 'C:/w.mjs' });
const floor = (o) => o.snapshot().floors.find((f) => f.sessionId === 's1');
const sheet = (o) => floor(o).sheet;
const lines = (sh) => sh.items.map((i) => `${i.status[0]}:${i.text}`);

function setup(provider = 'claude', opts = {}) {
  const o = new Office(cfg, EMPTY);
  o.syncSessions([S('s1', { provider, ...opts })], 100000);
  return o;
}

// ---- phase list from the run script ---------------------------------------------------------

test('board phases: titles come from meta.phases, read as a literal', () => {
  const s = "export const meta = { name:'x', phases: [{ title: 'Review' }, { title: 'Verify', detail: 'd' }] }\nawait agent()";
  assert.deepEqual(phasesFromScript(s), ['Review', 'Verify']);
  assert.deepEqual(phasesFromScript('const a = 1;'), [], 'no meta');
  assert.deepEqual(phasesFromScript("export const meta = { name: 'x' }\nconst phases = [{ title: 'nope' }]"), [], 'meta without phases');
});

test('board phases: brackets, quotes and comments inside the literal do not end or mislead the scan', () => {
  const s = [
    'export const meta = {',
    "  // phases: [ { title: 'in a comment' } ]",
    "  name: 'a]', description: 'x [1], y',",
    '  phases: [',
    "    { detail: 'z], {', title: \"Q\\\"uote\" },",
    "    'Plain',",
    '    { title: `T` /* { title: "no" } */ },',
    "    { title: 'Last' },",
    '  ],',
    "  other: [{ title: 'not a phase' }],",
    '}',
  ].join('\n');
  assert.deepEqual(phasesFromScript(s), ['Q"uote', 'Plain', 'T', 'Last']);
});

test('board phases: code in the meta is never evaluated, a title that is not a literal is skipped, a cut-off script is read as far as it goes', () => {
  globalThis.__boardEvil = 0;
  const s = "export const meta = { phases: [{ title: (globalThis.__boardEvil = 1, 'x') }, { title: `a${globalThis.__boardEvil = 2}` }, { title: 'ok' }] }";
  assert.deepEqual(phasesFromScript(s), ['ok']);
  assert.equal(globalThis.__boardEvil, 0);
  delete globalThis.__boardEvil;
  assert.deepEqual(phasesFromScript('export const meta = { phases: [{ title: "cut" }, { title: "off'), ['cut', 'off']);
});

// ---- the chain, server side ------------------------------------------------------------------

test('board chain: no list, no run, no agents -> the session title; a hidden title or nothing -> no sheet', () => {
  const o = setup();
  assert.deepEqual(sheet(o), { kind: 'title', text: '내 프로젝트' });
  o.applySessionEvents('s1', [{ kind: 'title', ts: 0, title: '아주 아주 아주 긴 세션 제목이 여기에 들어갑니다 정말로' }], 100001);
  const t = sheet(o);
  assert.equal(t.kind, 'title');
  assert.equal(Array.from(t.text).length, 20);
  assert.ok(t.text.endsWith('…'));
  const bare = setup('claude', { cwd: '' });
  assert.equal(sheet(bare), null);
});

test('board chain: the title is cleaned like a to-do item (control and bidi characters, line breaks)', () => {
  const o = setup();
  o.applySessionEvents('s1', [{ kind: 'title', ts: 0, title: 'a\u202Eb\u0007c\nd\u200Be' }], 100001);
  assert.equal(sheet(o).text, 'a b c d e');
});

test('board chain: sub-agents when there is no list and no run: description, role label when empty, count', () => {
  const o = setup();
  o.syncAgents('s1', [AG('a1', { description: '로그인 화면' }), AG('a2', { description: '결제 검토' }), AG('a3', { description: '' })], 100000);
  const sh = sheet(o);
  assert.equal(sh.kind, 'agents');
  assert.equal(sh.total, 3);
  assert.deepEqual(lines(sh), ['p:로그인 화면', 'p:결제 검토', 'p:개발']);
  assert.equal(sh.more, 0);
});

test('board chain: a working or thinking agent is highlighted, a finished one is checked off until it leaves', () => {
  const o = setup();
  const metas = (finished) => [AG('a1', { description: '하나' }), AG('a2', { description: '둘' }), AG('a3', { description: '셋', finished })];
  o.syncAgents('s1', metas(false), 100000);
  o.applyAgentEvents('s1', 'a1', [{ kind: 'tool', ts: 100100, toolUseId: 'x', name: 'Read', text: 'Read a.js' }], 100100);
  o.applyAgentEvents('s1', 'a2', [{ kind: 'think', ts: 100100 }], 100100);
  assert.deepEqual(sheet(o).items.map((i) => i.status), ['in_progress', 'in_progress', 'pending']);
  o.syncAgents('s1', metas(true), 100200);
  assert.deepEqual(sheet(o).items.map((i) => i.status), ['in_progress', 'in_progress', 'completed']);
});

test('board chain: agent descriptions are clipped to 20 characters and cleaned', () => {
  const o = setup();
  o.syncAgents('s1', [AG('a1', { description: '가'.repeat(50) }), AG('a2', { description: 'x\u202Ey\u0000z\nw' })], 100000);
  const [a, b] = sheet(o).items;
  assert.equal(Array.from(a.text).length, 20);
  assert.ok(a.text.endsWith('…'));
  assert.equal(b.text, 'x y z w');
});

test('board chain: a workflow with a phase list beats agents; the list shows done / current / upcoming', () => {
  const o = setup();
  o.syncAgents('s1', [AG('a1', { description: '조사' })], 100000);
  o.applySessionEvents('s1', [launch(100500)], 100500);
  o.setWorkflowProgress('s1', 'r1', { name: 'wf', phases: ['기획', '개발', '검증', '배포'], current: '' });
  let sh = sheet(o);
  assert.equal(sh.kind, 'phases');
  assert.deepEqual([sh.n, sh.total], [0, 4], 'no phase started yet');
  assert.deepEqual(lines(sh), ['p:기획', 'p:개발', 'p:검증', 'p:배포']);
  o.setWorkflowProgress('s1', 'r1', { name: 'wf', phases: ['기획', '개발', '검증', '배포'], current: '개발' });
  sh = sheet(o);
  assert.deepEqual([sh.n, sh.total], [2, 4]);
  assert.deepEqual(lines(sh), ['c:기획', 'i:개발', 'p:검증', 'p:배포']);
  assert.equal(sh.more, 0);
});

test('board chain: the current phase is the same one the phase signal and the board line report', () => {
  const o = setup();
  o.applySessionEvents('s1', [launch(100500)], 100500);
  o.setWorkflowProgress('s1', 'r1', { name: 'wf', phases: ['가', '나', '다'], current: '가' });
  o.setWorkflowProgress('s1', 'r1', { name: 'wf', phases: ['가', '나', '다'], current: '나' });
  assert.deepEqual(o.drainSignals().filter((s) => s.type === 'phase').map((s) => s.phase), ['가', '나']);
  assert.equal(floor(o).board.line, 'wf · 나 2/3');
  const sh = sheet(o);
  assert.deepEqual(lines(sh), ['c:가', 'i:나', 'p:다']);
  assert.equal(sh.n, 2);
});

test('board chain: a workflow without a script phase list shows the phases seen so far, the current one highlighted', () => {
  const o = setup();
  o.applySessionEvents('s1', [launch(100500)], 100500);
  o.setWorkflowProgress('s1', 'r1', { name: 'wf', phases: [], current: '조사' });
  let sh = sheet(o);
  assert.deepEqual([sh.kind, sh.n, sh.total], ['phases', 1, 0], 'total 0: the length is not known');
  assert.deepEqual(lines(sh), ['i:조사']);
  o.setWorkflowProgress('s1', 'r1', { name: 'wf', phases: [], current: '조사' }); // same phase again: still one line
  o.setWorkflowProgress('s1', 'r1', { name: 'wf', phases: [], current: '구현' });
  sh = sheet(o);
  assert.deepEqual(lines(sh), ['c:조사', 'i:구현']);
  assert.equal(sh.n, 2);
});

test('board chain: a run found half-way lists the phases its journal has started, in order', () => {
  const o = setup();
  o.applySessionEvents('s1', [launch(100500)], 100500);
  o.setWorkflowProgress('s1', 'r1', { name: 'wf', phases: [], seen: ['조사', '구현'], current: '구현' });
  const sh = sheet(o);
  assert.deepEqual(lines(sh), ['c:조사', 'i:구현']);
  assert.deepEqual([sh.n, sh.total], [2, 0]);
});

test('board chain: a journal phase the script does not list is added as the current line', () => {
  const o = setup();
  o.applySessionEvents('s1', [launch(100500)], 100500);
  o.setWorkflowProgress('s1', 'r1', { name: 'wf', phases: ['가', '나'], current: '다른 것' });
  const sh = sheet(o);
  assert.deepEqual(lines(sh), ['c:가', 'c:나', 'i:다른 것']);
  assert.equal(sh.total, 3);
});

test('board chain: phase names are cleaned and clipped like to-do items', () => {
  const o = setup();
  o.applySessionEvents('s1', [launch(100500)], 100500);
  const evil = 'a\u202Eb\u0007c\nd';
  o.setWorkflowProgress('s1', 'r1', { name: 'wf', phases: [evil, '긴'.repeat(60), '\u200B', 'ok'], current: evil });
  const sh = sheet(o);
  assert.deepEqual(sh.items.map((i) => i.text), ['a b c d', `${'긴'.repeat(19)}…`, 'ok'], 'an empty name is dropped');
  assert.equal(sh.items[0].status, 'in_progress');
  assert.ok(sh.items.every((i) => !/[\u202E\u0007\u200B\n]/.test(i.text)));
});

test('board chain: a long phase or agent list is windowed around the current item, `more` counts the rest', () => {
  const o = setup();
  o.applySessionEvents('s1', [launch(100500)], 100500);
  const phases = Array.from({ length: 30 }, (_, i) => `단계${i + 1}`);
  o.setWorkflowProgress('s1', 'r1', { name: 'wf', phases, current: '단계20' });
  const sh = sheet(o);
  assert.equal(sh.items.length, 12);
  assert.equal(sh.more, 18);
  assert.equal(sh.n, 20);
  assert.equal(sh.total, 30);
  assert.ok(sh.items.some((i) => i.status === 'in_progress'));
});

test('board chain: a finished run drops its phases, the next fallback (agents, then the title) takes over', () => {
  const o = setup();
  o.applySessionEvents('s1', [launch(100500)], 100500);
  o.setWorkflowProgress('s1', 'r1', { name: 'wf', phases: ['가', '나'], current: '가' });
  assert.equal(sheet(o).kind, 'phases');
  o.setWorkflowProgress('s1', 'r1', { name: 'wf', phases: ['가', '나'], current: '나', done: true });
  assert.equal(sheet(o).kind, 'title');
  o.syncAgents('s1', [AG('a1')], 100600);
  assert.equal(sheet(o).kind, 'agents');
});

test('board chain: the to-do list beats everything and the board looks as before (no sheet is sent)', () => {
  const o = setup();
  o.syncAgents('s1', [AG('a1')], 100000);
  o.applySessionEvents('s1', [launch(100500)], 100500);
  o.setWorkflowProgress('s1', 'r1', { name: 'wf', phases: ['가', '나'], current: '가' });
  assert.equal(sheet(o).kind, 'phases');
  o.applySessionEvents('s1', [todoWrite(100600, [{ text: '하나', status: 'completed' }, { text: '둘', status: 'in_progress' }])], 100600);
  const f = floor(o);
  assert.equal(f.sheet, null);
  assert.deepEqual(f.todos, { items: [{ text: '하나', status: 'completed' }, { text: '둘', status: 'in_progress' }], done: 1, total: 2 });
  // an emptied list gives the board back to the fallbacks
  o.applySessionEvents('s1', [todoWrite(100700, [])], 100700);
  assert.equal(sheet(o).kind, 'phases');
});

test('board chain: a run that is still going keeps its phases even with agents present, and a second floor is independent', () => {
  const o = new Office(cfg, EMPTY);
  o.syncSessions([S('s1'), S('s2', { startedAt: 2000, cwd: 'C:\\x\\다른 곳' })], 100000);
  o.applySessionEvents('s1', [launch(100500)], 100500);
  o.setWorkflowProgress('s1', 'r1', { name: 'wf', phases: ['가'], current: '가' });
  const by = (id) => o.snapshot().floors.find((f) => f.sessionId === id).sheet;
  assert.equal(by('s1').kind, 'phases');
  assert.deepEqual(by('s2'), { kind: 'title', text: '다른 곳' });
});

test('board chain: Codex floors go update_plan, then agents, then the title', () => {
  const o = setup('codex');
  assert.equal(sheet(o).kind, 'title');
  o.syncAgents('s1', [AG('a1', { agentType: 'codex:worker', description: '개발' })], 100000);
  assert.equal(sheet(o).kind, 'agents');
  o.applySessionEvents('s1', [todoWrite(100600, [{ text: '계획 1', status: 'in_progress' }])], 100600);
  assert.equal(floor(o).sheet, null);
  assert.equal(floor(o).todos.total, 1);
});

// ---- the page's side --------------------------------------------------------------------------

test('board web: ui.board has the Korean headers', () => {
  assert.equal(L.todos, '할 일 {done}/{total}');
  for (const k of ['phases', 'phasesOpen', 'agents', 'more']) assert.match(L[k], /[가-힣]/, k);
});

test('board web: boardSheet builds the header and rows of each kind', () => {
  const todos = { items: [{ text: 'a', status: 'completed' }, { text: 'b', status: 'pending' }], done: 1, total: 5 };
  assert.deepEqual(boardSheet({ todos, sheet: null }, L), { head: '할 일 1/5', items: todos.items, more: 3, progress: { done: 1, total: 5, frac: 0.2 } });
  assert.equal(boardSheet({ todos: { items: [], done: 0, total: 0 }, sheet: null }, L), null);
  assert.equal(boardSheet({}, L), null);
  const items = [{ text: '가', status: 'completed' }, { text: '나', status: 'in_progress' }];
  assert.deepEqual(boardSheet({ sheet: { kind: 'phases', n: 2, total: 4, items, more: 2 } }, L), { head: '단계 1/4', items, more: 2, progress: { done: 1, total: 4, frac: 0.25 } });
  assert.equal(boardSheet({ sheet: { kind: 'phases', n: 2, total: 0, items, more: 0 } }, L).head, '단계 2');
  assert.equal(boardSheet({ sheet: { kind: 'agents', total: 3, items, more: 1 } }, L).head, '직원 3명');
  assert.deepEqual(boardSheet({ sheet: { kind: 'title', text: '제목' } }, L), { head: '', items: [{ text: '제목', status: 'plain' }], more: 0, progress: null });
});

test('board web: sheetKey changes exactly when the board changes', () => {
  const a = { head: '단계 1/2', items: [{ text: 'x', status: 'in_progress' }], more: 0 };
  assert.equal(sheetKey(null), '');
  assert.equal(sheetKey(a), sheetKey({ ...a, items: [{ text: 'x', status: 'in_progress' }] }));
  assert.notEqual(sheetKey(a), sheetKey({ ...a, head: '단계 2/2' }));
  assert.notEqual(sheetKey(a), sheetKey({ ...a, items: [{ text: 'x', status: 'completed' }] }));
  assert.notEqual(sheetKey(a), sheetKey({ ...a, more: 1 }));
  assert.notEqual(sheetKey(a), sheetKey(null));
});

// ---- change-only push -----------------------------------------------------------------------

test('board push: the board content rides in the state frame, which is sent only when something changed', async (t) => {
  const o = setup();
  const server = createServer(cfg, o, {});
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeSse(); server.close(); server.closeAllConnections(); });
  const port = server.address().port;
  let text = '';
  const req = http.get({ host: '127.0.0.1', port, path: '/api/events', headers: { Host: `127.0.0.1:${port}` } }, (res) => {
    res.setEncoding('utf8');
    res.on('data', (d) => { text += d; });
  });
  t.after(() => req.destroy());
  const states = () => [...text.matchAll(/event: state\ndata: (.*)\n/g)].map((m) => JSON.parse(m[1]));
  const settle = () => new Promise((r) => setTimeout(r, 60));
  while (server.sseClients < 1) await new Promise((r) => setImmediate(r));
  await settle();
  assert.equal(states().length, 1, 'the first state on connect');
  assert.deepEqual(states()[0].floors[0].sheet, { kind: 'title', text: '내 프로젝트' });

  server.broadcast();
  server.broadcast();
  await settle();
  assert.equal(states().length, 1, 'nothing changed: nothing sent');

  o.applySessionEvents('s1', [launch(100500)], 100500);
  o.setWorkflowProgress('s1', 'r1', { name: 'wf', phases: ['가', '나'], current: '가' });
  server.broadcast();
  await settle();
  assert.equal(states().length, 2);
  assert.equal(states()[1].floors[0].sheet.kind, 'phases');

  server.broadcast();
  o.setWorkflowProgress('s1', 'r1', { name: 'wf', phases: ['가', '나'], current: '가' }); // a progress report that changes nothing on the board
  server.broadcast();
  await settle();
  assert.equal(states().length, 2, 'the same board again: nothing sent');

  o.setWorkflowProgress('s1', 'r1', { name: 'wf', phases: ['가', '나'], current: '나' });
  server.broadcast();
  await settle();
  assert.equal(states().length, 3);
  assert.deepEqual(states()[2].floors[0].sheet.items.map((i) => i.status), ['completed', 'in_progress']);
});
