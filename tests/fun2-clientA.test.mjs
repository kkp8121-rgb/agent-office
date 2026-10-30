import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { boardCapacity, boardFrame, itemWindow, todoKey } from '../web/board.mjs';
import { assignSpots, clipPhase, moodKind, patDue } from '../web/meeting.mjs';

const cfg = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
const item = (status, text = status) => ({ status, text });
const texts = (list) => list.map((t) => t.text);

test('board frame: a vertical-edged quad becomes a box plus one shear', () => {
  const f = boardFrame([[511, 64], [588, 99], [588, 153], [511, 119]]);
  assert.deepEqual({ x: f.x, y: f.y, w: f.w, h: f.h }, { x: 511, y: 64, w: 77, h: 55 });
  assert.ok(Math.abs(f.slope - 35 / 77) < 1e-9);
});

test('board capacity: the title takes one line, never fewer than the minimum', () => {
  assert.equal(boardCapacity(55, 9, 2, 3), 4);
  assert.equal(boardCapacity(20, 9, 2, 3), 3);
});

test('item window: short lists show whole; long ones keep the in-progress item with one finished item above', () => {
  const list = [item('completed', 'a'), item('completed', 'b'), item('completed', 'c'), item('in_progress', 'd'), item('pending', 'e'), item('pending', 'f'), item('pending', 'g')];
  assert.equal(itemWindow(list, 7), list);
  assert.deepEqual(texts(itemWindow(list, 4)), ['c', 'd', 'e', 'f']);
  const late = [...list.slice(0, 3), item('completed', 'd'), item('in_progress', 'e'), item('pending', 'f')];
  assert.deepEqual(texts(itemWindow(late, 3)), ['d', 'e', 'f']);
  const none = [item('completed', 'a'), item('pending', 'b'), item('pending', 'c'), item('pending', 'd')];
  assert.deepEqual(texts(itemWindow(none, 2)), ['a', 'b']);
  const allDone = [item('completed', 'a'), item('completed', 'b'), item('completed', 'c')];
  assert.deepEqual(texts(itemWindow(allDone, 2)), ['b', 'c']);
});

test('todo key changes with text, status and counts only', () => {
  const a = { items: [item('pending', 'x')], done: 0, total: 1 };
  assert.equal(todoKey(a), todoKey({ items: [item('pending', 'x')], done: 0, total: 1 }));
  assert.notEqual(todoKey(a), todoKey({ items: [item('completed', 'x')], done: 1, total: 1 }));
  assert.notEqual(todoKey(a), todoKey({ items: [item('pending', 'y')], done: 0, total: 1 }));
});

test('meeting: closest pairs first, extra characters get no spot, one spot per character', () => {
  const spots = [{ at: [0, 0] }, { at: [100, 0] }];
  const chars = [{ id: 'a', x: 90, y: 0 }, { id: 'b', x: 10, y: 0 }, { id: 'c', x: 50, y: 0 }];
  const m = assignSpots(chars, spots);
  assert.equal(m.size, 2);
  assert.equal(m.get('a'), spots[1]);
  assert.equal(m.get('b'), spots[0]);
  assert.equal(m.has('c'), false);
  assert.equal(assignSpots([], spots).size, 0);
});

test('fail mood and pat rule follow the config', () => {
  const f = cfg.ui.fail;
  assert.deepEqual([f.seconds, f.patStreak, f.patCooldownSeconds], [6, 3, 60]);
  assert.equal(moodKind(1), 'sweat');
  assert.equal(moodKind(2), 'cloud');
  assert.equal(patDue(f.patStreak - 1, -Infinity, 0, f), false);
  assert.equal(patDue(f.patStreak, -Infinity, 0, f), true);
  assert.equal(patDue(f.patStreak, 1000, 1000 + f.patCooldownSeconds * 1000 - 1, f), false);
  assert.equal(patDue(f.patStreak + 5, 1000, 1000 + f.patCooldownSeconds * 1000, f), true);
});

test('phase titles are clipped for a bubble; the meeting and pat lines exist', () => {
  assert.equal(clipPhase('검토', 12), '검토');
  assert.equal(Array.from(clipPhase('가'.repeat(30), 12)).length, 12);
  const L = cfg.ui.lines;
  for (const l of L.meetingBoss) assert.ok(l.includes('{phase}'), l);
  assert.ok(L.meetingBoss.includes('다음은 「{phase}」 단계!'));
  assert.ok(L.patBoss.length >= 8 && L.patReply.length >= 8);
  assert.equal(cfg.ui.meeting.seconds, 5);
});
