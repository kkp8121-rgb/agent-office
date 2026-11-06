// Whiteboard detail panel: the pure model (what the dialog shows), the Korean strings in config.json, and the server's phases field.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../server/config.mjs';
import { Office } from '../server/office.mjs';
import { panelModel } from '../web/board-panel.mjs';

const cfg = loadConfig();
const L = cfg.ui.boardPanel;
const B = cfg.ui.board;
const LB = cfg.ui.lobby;
const it = (status, text = status) => ({ text, status });
const NOW = 10_000_000;

const floor = (extra = {}) => ({
  title: '결제 화면 점검', folder: 'teazr-frontend', startedAt: NOW - 95 * 60000,
  lead: { name: '한팀장', role: '팀장', state: 'working', bubble: '' },
  agents: [
    { key: 'a1', name: '민수', role: 'worker', state: 'working', bubble: '시험 실행', since: NOW - 3 * 60000 },
    { key: 'a2', name: '지은', role: 'scout', state: 'done', bubble: '', since: 0 },
  ],
  todos: { items: [], done: 0, total: 0 }, sheet: null, phases: null, ...extra,
});

test('panel model: session, folder, lead and how long the session has run', () => {
  const m = panelModel(floor(), NOW, L, B, LB);
  assert.equal(m.title, '결제 화면 점검');
  assert.equal(m.folder, 'teazr-frontend');
  assert.deepEqual(m.lead, { name: '한팀장', role: '팀장', state: '근무 중', doing: '' });
  assert.equal(m.runFor, '1시간 35분');
  assert.equal(panelModel(floor({ startedAt: 0 }), NOW, L, B, LB).runFor, '');
});

test('panel model: the to-do list has the count, the bar fraction, the markers and what the server left out', () => {
  const items = [it('completed'), it('completed'), it('completed'), it('in_progress'), it('pending')];
  const m = panelModel(floor({ todos: { items, done: 3, total: 9 } }), NOW, L, B, LB);
  assert.equal(m.todos.head, '할 일 3/9');
  assert.equal(m.todos.frac, 3 / 9);
  assert.deepEqual(m.todos.rows.map((r) => r.kind), ['done', 'done', 'done', 'now', 'next']);
  assert.equal(m.todos.more, 4);
  assert.equal(panelModel(floor(), NOW, L, B, LB).todos, null);
});

test('panel model: phases keep done, current and next, next to a to-do list', () => {
  const items = [it('completed', '조사'), it('completed', '설계'), it('in_progress', '구현'), it('pending', '검증'), it('pending', '정리')];
  const todos = { items: [it('in_progress', 'a')], done: 0, total: 1 };
  const m = panelModel(floor({ todos, phases: { n: 3, total: 5, items, more: 0 } }), NOW, L, B, LB);
  assert.ok(m.todos && m.phases, 'both lists are shown');
  assert.equal(m.phases.head, '단계 2/5');
  assert.equal(m.phases.frac, 0.4);
  assert.equal(m.phases.summary, '끝난 단계 2개 · 지금 「구현」 · 다음 「검증」');
  assert.deepEqual(m.phases.rows.map((r) => r.kind), ['done', 'done', 'now', 'next', 'next']);
});

test('panel model: the last phase has no next one; a script without a phase list has no bar', () => {
  const last = panelModel(floor({ phases: { n: 2, total: 2, items: [it('completed', '가'), it('in_progress', '나')], more: 0 } }), NOW, L, B, LB);
  assert.equal(last.phases.summary, '끝난 단계 1개 · 지금 「나」 · 남은 단계 없음');
  const open = panelModel(floor({ phases: { n: 2, total: 0, items: [it('completed', '가'), it('in_progress', '나')], more: 0 } }), NOW, L, B, LB);
  assert.equal(open.phases.head, '단계 2');
  assert.equal(open.phases.total, 0);
  assert.equal(open.phases.frac, 0);
});

test('panel model: the staff has state, what they say and since when; nothing is made up for a quiet one', () => {
  const m = panelModel(floor(), NOW, L, B, LB);
  assert.deepEqual(m.staff.map((s) => [s.name, s.state, s.doing, s.since]), [['민수', '근무 중', '시험 실행', '3분'], ['지은', '보고 완료', '', '']]);
});

test('panel model: it follows the clock (live updates are a new model for a later now)', () => {
  const at = (now) => panelModel(floor(), now, L, B, LB);
  assert.equal(at(NOW).staff[0].since, '3분');
  assert.equal(at(NOW + 2 * 60000).staff[0].since, '5분');
  assert.equal(at(NOW - 999999999).runFor, '0분'); // a clock that runs behind never shows a negative time
});

test('panel config: every string is Korean text and the numbers are positive', () => {
  for (const k of ['tagLabel', 'title', 'close', 'closeLabel', 'gone', 'session', 'folder', 'lead', 'runFor', 'phaseDone', 'phaseNow', 'phaseNext', 'phaseNoNext', 'staff', 'leadTag', 'since', 'more', 'noLists']) {
    assert.match(L[k], /[가-힣]/, k);
  }
  assert.ok(L.widthPx > 0 && L.motion.openMs > 0 && L.motion.closeMs > 0 && L.motion.risePx > 0);
});

test('server: the floor view carries the workflow phases next to the to-do list', () => {
  const o = new Office(cfg, { hidden: [], names: {} });
  o.syncSessions([{ provider: 'claude', pid: 100, sessionId: 's1', cwd: 'C:\\Project\\x', status: 'busy', name: '', startedAt: 1000 }], 100000);
  const f0 = o.snapshot().floors.find((x) => x.sessionId === 's1');
  assert.equal(f0.phases, null);
  const f = [...o.floors.values()].find((x) => x.sessionId === 's1');
  f.boardPhases = { list: ['조사', '설계', '구현'], at: 1, known: true };
  f.todoItems = [{ text: '할 일', status: 'in_progress', gone: false }];
  const v = o.snapshot().floors.find((x) => x.sessionId === 's1');
  assert.deepEqual(v.phases, { n: 2, total: 3, items: [it('completed', '조사'), it('in_progress', '설계'), it('pending', '구현')], more: 0 });
  assert.equal(v.todos.total, 1);
  assert.equal(v.sheet, null, 'the board itself still shows the to-do list');
  f.todoItems = [];
  assert.deepEqual(o.snapshot().floors.find((x) => x.sessionId === 's1').sheet, { kind: 'phases', ...v.phases });
});

test('panel model: the cost block shows this floor\'s cache reads under a floor label, never the office figure', () => {
  const frame = { day: '2026-11-06', tokens: 500, cacheRead: 9_000_000, lastWeek: null, floors: [{ sessionId: 'sx', tokens: 300, cacheRead: 2_500_000 }, { sessionId: 'sy', tokens: 200, cacheRead: 6_500_000 }], top: [], scanning: false, partial: false };
  const m = panelModel(floor({ sessionId: 'sx', floorNo: 3 }), NOW, L, B, LB, { frame, cfg: cfg.ui.cost });
  assert.deepEqual(m.cost.cache, { label: '3층 캐시 읽기', text: '2.5M' });
  assert.deepEqual(m.cost.total, { label: '3층', text: '300' });
});
