// Whiteboard progress display (pure model): markers, count and bar fraction, the window when the list does not fit, phases as progress.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../server/config.mjs';
import { Office } from '../server/office.mjs';
import { parseLine } from '../server/parse.mjs';
import { parseCodexLine } from '../server/codex.mjs';
import { boardCapacity, boardRows, boardSheet, progressFrac, rowKind, sheetKey } from '../web/board.mjs';

const cfg = loadConfig();
const L = cfg.ui.board;
const it = (status, text = status) => ({ text, status });
const texts = (xs) => xs.map((x) => x.text);

test('board progress: a status becomes a done, now or next marker; anything else is next', () => {
  assert.deepEqual(['completed', 'in_progress', 'pending', 'weird'].map(rowKind), ['done', 'now', 'next', 'next']);
});

test('board progress: the bar fraction is done over total, between 0 and 1', () => {
  assert.equal(progressFrac(3, 7), 3 / 7);
  assert.equal(progressFrac(0, 7), 0);
  assert.equal(progressFrac(7, 7), 1);
  assert.equal(progressFrac(9, 7), 1);
  assert.equal(progressFrac(0, 0), 0);
  assert.equal(progressFrac(-1, 5), 0);
});

test('board progress: a to-do list gives the count heading and the bar numbers', () => {
  const items = [it('completed'), it('completed'), it('completed'), it('in_progress'), it('pending'), it('pending'), it('pending')];
  const b = boardSheet({ todos: { items, done: 3, total: 7 }, sheet: null }, L);
  assert.equal(b.head, '할 일 3/7');
  assert.deepEqual(b.progress, { done: 3, total: 7, frac: 3 / 7 });
  assert.equal(b.more, 0);
});

test('board progress: phases count the finished ones; the current phase is in progress, not done', () => {
  const items = [it('completed', '조사'), it('completed', '설계'), it('in_progress', '구현'), it('pending', '검증'), it('pending', '정리')];
  const b = boardSheet({ sheet: { kind: 'phases', n: 3, total: 5, items, more: 0 } }, L);
  assert.equal(b.head, '단계 2/5');
  assert.deepEqual(b.progress, { done: 2, total: 5, frac: 0.4 });
  const first = boardSheet({ sheet: { kind: 'phases', n: 1, total: 5, items, more: 0 } }, L);
  assert.deepEqual(first.progress, { done: 0, total: 5, frac: 0 });
  const over = boardSheet({ sheet: { kind: 'phases', n: 9, total: 5, items, more: 0 } }, L);
  assert.equal(over.progress.done, 5);
});

test('board progress: phases without a script list, sub-agents and the title have no bar', () => {
  const items = [it('in_progress', '가')];
  assert.equal(boardSheet({ sheet: { kind: 'phases', n: 2, total: 0, items, more: 0 } }, L).progress, null);
  assert.equal(boardSheet({ sheet: { kind: 'agents', total: 1, items, more: 0 } }, L).progress, null);
  assert.equal(boardSheet({ sheet: { kind: 'title', text: '제목' } }, L).progress, null);
});

test('board progress: the key changes when the count changes', () => {
  const mk = (done) => boardSheet({ todos: { items: [it('pending', 'a')], done, total: 7 }, sheet: null }, L);
  assert.notEqual(sheetKey(mk(2)), sheetKey(mk(3)));
});

test('board rows: a list that fits is drawn whole, with no "more" line', () => {
  const items = [it('completed', 'a'), it('in_progress', 'b'), it('pending', 'c')];
  assert.deepEqual(boardRows(items, 0, 3), { rows: items, hidden: 0 });
  assert.deepEqual(boardRows(items, 0, 5), { rows: items, hidden: 0 });
});

test('board rows: when it does not fit, one line is left for the "more" line and the in-progress item stays in view', () => {
  const items = [it('completed', 'a'), it('completed', 'b'), it('completed', 'c'), it('completed', 'd'), it('completed', 'e'), it('in_progress', 'f'),
    it('pending', 'g'), it('pending', 'h'), it('pending', 'i'), it('pending', 'j'), it('pending', 'k'), it('pending', 'l')];
  const r = boardRows(items, 0, 5);
  assert.deepEqual(texts(r.rows), ['e', 'f', 'g', 'h']); // the last finished item, the current one, the next ones
  assert.equal(r.hidden, 8);
  assert.equal(r.rows.length + 1, 5); // rows plus the "more" line fill the capacity exactly
});

test('board rows: items the server left out count as hidden too', () => {
  const items = [it('completed', 'a'), it('in_progress', 'b'), it('pending', 'c')];
  const r = boardRows(items, 4, 5);
  assert.deepEqual(texts(r.rows), ['a', 'b', 'c']);
  assert.equal(r.hidden, 4);
});

test('board rows: the in-progress item is never cut, wherever it is in the list', () => {
  for (let at = 0; at < 12; at++) {
    const items = Array.from({ length: 12 }, (_, i) => it(i < at ? 'completed' : i === at ? 'in_progress' : 'pending', `t${i}`));
    for (const cap of [3, 4, 5, 6]) {
      const r = boardRows(items, 0, cap);
      assert.ok(r.rows.some((x) => x.status === 'in_progress'), `at ${at} cap ${cap}`);
      assert.ok(r.rows.length + (r.hidden ? 1 : 0) <= cap, `at ${at} cap ${cap}`);
    }
  }
});

test('board rows: a list with nothing in progress shows the first open items', () => {
  const items = [it('completed', 'a'), it('completed', 'b'), it('pending', 'c'), it('pending', 'd'), it('pending', 'e'), it('pending', 'f')];
  assert.deepEqual(texts(boardRows(items, 0, 4).rows), ['b', 'c', 'd']);
});

test('board capacity: the bar takes room from the item lines', () => {
  const bar = L.barPx + L.barGapPx;
  assert.equal(boardCapacity(62, 9, 2, 3), 5);
  assert.equal(boardCapacity(58, 9, 2, 3), 5);
  assert.equal(boardCapacity(58, 9, 2, 3, bar), 4);
  assert.equal(boardCapacity(53, 9, 2, 3, bar), 4);
  assert.equal(boardCapacity(40, 9, 2, 3, bar), 3);
});

test('board config: the progress strings are Korean and the sizes are positive whole pixels', () => {
  assert.equal(L.phases, '단계 {done}/{total}');
  assert.match(L.more, /\{n\}/);
  for (const k of ['barPx', 'barGapPx', 'markPx']) assert.ok(Number.isInteger(L[k]) && L[k] > 0, k);
});

test('board status: Claude and Codex lists reach the snapshot with every status and the done count', () => {
  const todos = [...['a', 'b', 'c'].map((content) => ({ content, status: 'completed' })), { content: 'd', status: 'in_progress' }, ...['e', 'f', 'g'].map((content) => ({ content, status: 'pending' }))];
  const claude = parseLine(JSON.stringify({ type: 'assistant', timestamp: '2026-10-28T10:00:00.000Z', message: { content: [{ type: 'tool_use', id: 'u1', name: 'TodoWrite', input: { todos } }] } }))[0];
  const plan = [{ step: 'a', status: 'completed' }, { step: 'b', status: 'in_progress' }, { step: 'c', status: 'pending' }];
  const codex = parseCodexLine(JSON.stringify({ timestamp: '2026-10-28T10:00:00.000Z', type: 'response_item', payload: { type: 'function_call', name: 'update_plan', call_id: 'c1', arguments: JSON.stringify({ plan }) } }))[0];
  for (const [provider, ev, done, total, statuses] of [['claude', claude, 3, 7, 'cccippp'], ['codex', codex, 1, 3, 'cip']]) {
    const o = new Office(cfg, { hidden: [], names: {} });
    o.syncSessions([{ provider, pid: 100, sessionId: 's1', cwd: 'C:\\Project\\x', status: 'busy', name: '', startedAt: 1000 }], 100000);
    o.applySessionEvents('s1', [{ ...ev, ts: 100500 }], 100500);
    const f = o.snapshot().floors.find((x) => x.sessionId === 's1');
    assert.equal(f.todos.done, done, provider);
    assert.equal(f.todos.total, total, provider);
    assert.equal(f.todos.items.map((x) => x.status[0]).join(''), statuses, provider);
    assert.equal(f.sheet, null, provider);
  }
});
