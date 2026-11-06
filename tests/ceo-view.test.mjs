// The boss room as plain rules (web/ceo-view.mjs): visit spots and the queue, the one boss, the roof, the bell meeting schedule, the chalkboard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../server/config.mjs';
import { planBell } from '../web/bellmeeting.mjs';
import {
  assignRoof, bellChair, bellTimeline, boardLines, callers, createBossLock, createVisitBoard, linesKey, nearestSpot, presence, resters,
} from '../web/ceo-view.mjs';
import { ROOT } from './helpers/fixture.mjs';

const UI = loadConfig().ui;
const COST = UI.cost;
const BOARD = UI.ceo.board;
const BM = UI.bellMeeting;

const call = (sid, since) => ({ sid, since });
const sids = (list) => list.map((x) => x.sid);

test('visit spots go to the floor that called first and a spot is never shared', () => {
  const board = createVisitBoard(6);
  const r = board.sync([call('late', 300), call('first', 100), call('mid', 200)]);
  assert.deepEqual(r.started.map((x) => [x.sid, x.spot]), [['first', 0], ['mid', 1], ['late', 2]]);
  assert.equal(new Set(r.started.map((x) => x.spot)).size, 3);
  assert.deepEqual(board.assigned().map((a) => a.sid), ['first', 'mid', 'late']);
  const again = board.sync([call('late', 300), call('first', 100), call('mid', 200)]);
  assert.deepEqual(again, { started: [], released: [] }, 'the same calls change nothing');
  assert.equal(board.spotOf('mid'), 1);
  assert.equal(board.spotOf('nobody'), null);
});

test('the floors past the last spot wait, and the queue count is exact', () => {
  const board = createVisitBoard(6);
  const calling = Array.from({ length: 9 }, (_, i) => call(`f${i}`, i));
  const r = board.sync(calling);
  assert.equal(r.started.length, 6);
  assert.equal(board.queueCount(), 3);
  assert.deepEqual(board.queued(), ['f6', 'f7', 'f8']);
  assert.equal(board.spotOf('f7'), null, 'a waiting floor has no spot (its lead stays at the desk)');
});

test('a call that ends frees its spot and the first floor in the queue takes it', () => {
  const board = createVisitBoard(2);
  board.sync([call('a', 1), call('b', 2), call('c', 3), call('d', 4)]);
  assert.deepEqual(board.queued(), ['c', 'd']);
  const r = board.sync([call('b', 2), call('c', 3), call('d', 4)]); // a hangs up
  assert.deepEqual(r.released, [{ sid: 'a', spot: 0 }]);
  assert.deepEqual(r.started, [{ sid: 'c', spot: 0 }], 'c called first of the waiting two and gets the freed spot');
  assert.equal(board.spotOf('b'), 1, 'the others keep theirs');
  assert.equal(board.queueCount(), 1);
  const r2 = board.sync([]); // everybody hangs up
  assert.equal(r2.released.length, 2);
  assert.equal(board.queueCount(), 0);
  assert.deepEqual(board.assigned(), []);
});

test('only one boss: a second bell meeting at the same time is chaired by its floor\'s lead', () => {
  const lock = createBossLock();
  assert.equal(bellChair({ moves: true, lock, sid: 'A' }), 'ceo');
  assert.equal(lock.holder(), 'A');
  assert.equal(bellChair({ moves: true, lock, sid: 'B' }), 'lead', 'the boss is with floor A');
  assert.equal(lock.holder(), 'A', 'floor B did not take him');
  lock.release('B'); // B finishing does not free A's boss
  assert.equal(lock.holder(), 'A');
  lock.release('A');
  assert.equal(bellChair({ moves: true, lock, sid: 'B' }), 'ceo', 'free again');
  const idle = createBossLock();
  assert.equal(bellChair({ moves: false, lock: idle, sid: 'A' }), 'lead', 'effects off or reduced motion: the lead chairs');
  assert.equal(idle.holder(), null, 'and the boss was not taken');
});

const person = (sessionId, name, tokens, floorName = 'Floor') => ({ sessionId, agentKey: null, name, floorName, tokens });
const frame = (o = {}) => ({
  day: '2026-11-06', tokens: 12_300_000, cacheRead: 4_200_000_000, lastWeek: { day: '2026-10-30', tokensSameHour: 10_000_000, partial: false },
  floors: [], top: [person('s1', '하나', 6_000_000), person('s2', '둘', 3_000_000), person('s1', '셋', 2_000_000), person('s2', '넷', 900_000), person('s1', '다섯', 400_000)],
  scanning: false, partial: false, ...o,
});
const floorLabel = (p) => (p.sessionId === 'gone' ? p.floorName : `${p.sessionId.slice(1)}층`);

test('the chalkboard has five lines: title and total, last week, and the top three people', () => {
  const lines = boardLines(frame(), BOARD, COST, floorLabel);
  assert.equal(lines.length, 2 + BOARD.rows);
  assert.equal(lines.length, 5);
  assert.deepEqual(lines[0], { kind: 'head', left: BOARD.title, right: '12.3M' });
  assert.equal(lines[1].kind, 'week');
  assert.match(lines[1].left, /10\.0M/);
  assert.match(lines[1].left, /\+23%/);
  assert.deepEqual(lines.slice(2).map((l) => [l.left, l.mid, l.right]), [['하나', '1층', '6.0M'], ['둘', '2층', '3.0M'], ['셋', '1층', '2.0M']]);
});

test('the chalkboard without a last week says so, and a person whose floor left shows the floor name', () => {
  const lines = boardLines(frame({ lastWeek: null, top: [person('gone', '여섯', 1000, '옛 층')] }), BOARD, COST, floorLabel);
  assert.equal(lines[1].left, COST.noLastWeek);
  assert.deepEqual(lines[2], { kind: 'person', left: '여섯', mid: '옛 층', right: '1.0k' });
  assert.deepEqual(lines[3], { kind: 'person', left: '', mid: '', right: '' }, 'fewer people than lines: the rest stay blank, the line count is fixed');
  assert.equal(lines.length, 5);
});

test('the chalkboard says computing while the old logs are counted and the dash before the first frame', () => {
  const counting = boardLines(frame({ scanning: true }), BOARD, COST, floorLabel);
  assert.equal(counting[0].right, COST.scanning);
  assert.equal(counting[1].left, COST.scanning);
  assert.ok(counting.slice(2).every((l) => l.right === COST.scanning || l.right === ''));
  const none = boardLines(null, BOARD, COST, floorLabel);
  assert.equal(none[0].right, COST.empty);
  assert.equal(none[1].left, COST.empty);
  assert.equal(none.length, 5);
  const partial = boardLines(frame({ partial: true }), BOARD, COST, floorLabel);
  assert.match(partial[0].right, new RegExp(COST.partial), 'a partial day is marked, never a wrong number');
  assert.notEqual(linesKey(counting), linesKey(none));
  assert.equal(linesKey(boardLines(frame(), BOARD, COST, floorLabel)), linesKey(boardLines(frame(), BOARD, COST, floorLabel)));
});

test('a still boss room has no visitor records, and a lead is away only while the whole building is on show', () => {
  const board = createVisitBoard(6);
  board.sync([call('a', 1), call('b', 2)]);
  const live = presence(board, { ceoActive: true, buildingActive: true });
  assert.deepEqual(sids(live.visitors), ['a', 'b']);
  assert.deepEqual(live.away, ['a', 'b']);
  const still = presence(board, { ceoActive: false, buildingActive: true });
  assert.deepEqual(still.visitors, [], 'no visitor record while the boss room is still or hidden');
  assert.deepEqual(still.away, ['a', 'b'], 'the leads are still away: the state is kept');
  assert.equal(still.queue, 0);
  const single = presence(board, { ceoActive: true, buildingActive: false });
  assert.deepEqual(single.away, [], 'in a single-floor view the leads stay at their desks');
  assert.deepEqual(sids(single.visitors), ['a', 'b'], 'and the boss room (looked at alone) shows who waits there');
  const full = createVisitBoard(1);
  full.sync([call('a', 1), call('b', 2), call('c', 3)]);
  assert.equal(presence(full, { ceoActive: true, buildingActive: true }).queue, 2);
});

test('the boss opens the bell meeting himself, so the speakers start one turn later and the total grows by that turn', () => {
  const people = [{ id: 'lead', isLead: true, spot: 0, bubble: 'L' }, { id: 's1', isLead: false, spot: 1, bubble: '' }];
  const lines = { open: 'OPEN', idle: 'IDLE', close: 'CLOSE' };
  const withBoss = planBell(people, { bm: BM, effects: true, reducedMotion: false, lines });
  const t = bellTimeline(withBoss, BM);
  const turn = BM.sayMs + BM.gapMs;
  assert.deepEqual(t.events.map((e) => [e.who, e.text]), [['chair', 'OPEN'], ['lead', 'L'], ['s1', 'IDLE'], ['chair', 'CLOSE']]);
  assert.deepEqual(t.events.map((e) => e.at), [0, turn, 2 * turn, 3 * turn]);
  assert.equal(t.totalMs, withBoss.totalMs + turn);
  const noBoss = planBell(people, { bm: BM, effects: false, reducedMotion: false, lines });
  const u = bellTimeline(noBoss, BM);
  assert.deepEqual(u.events.map((e) => e.who), ['lead', 's1', 'chair'], 'the lead chairs: no opening line');
  assert.equal(u.events[0].at, 0);
  assert.equal(u.totalMs, noBoss.totalMs);
});

test('roof benches: a resting floor keeps its bench, a new one takes the lowest free one, floors past the last bench stay at their desks', () => {
  const first = assignRoof(['a', 'b'], 4);
  assert.deepEqual([...first], [['a', 0], ['b', 1]]);
  const second = assignRoof(['b', 'c', 'd', 'e', 'f'], 4, first);
  assert.deepEqual([...second], [['b', 1], ['c', 0], ['d', 2], ['e', 3]], 'b keeps bench 1; a left, so c takes the free bench 0; f has none');
  assert.equal(second.has('f'), false);
  assert.equal(new Set(second.values()).size, second.size, 'no bench is shared');
  assert.equal(assignRoof([], 4, second).size, 0);
  assert.equal(assignRoof(['a'], 0).size, 0, 'no benches: nobody goes up');
});

test('callers and resters: a floor on its lunch break does not call, a leaving floor does neither', () => {
  const views = [
    { sessionId: 'a', call: 'permission', callSince: 5, status: 'busy', rest: null },
    { sessionId: 'b', call: 'input', callSince: 3, status: 'busy', rest: { until: null, limitKind: 'other' } },
    { sessionId: 'c', call: null, callSince: null, status: 'busy', rest: { until: 1, limitKind: 'five_hour' } },
    { sessionId: 'd', call: 'ask', callSince: 1, status: 'leaving', rest: null },
    { sessionId: 'e', call: null, callSince: null, status: 'busy', rest: null },
  ];
  assert.deepEqual(callers(views), [{ sid: 'a', since: 5 }]);
  assert.deepEqual(resters(views), ['b', 'c']);
});

test('a person at the meeting spots is matched to the nearest spot', () => {
  const spots = [{ at: [100, 100] }, { at: [200, 100] }, { at: [200, 200] }];
  assert.equal(nearestSpot(spots, 198, 104), 1);
  assert.equal(nearestSpot(spots, 205, 190), 2);
  assert.equal(nearestSpot(spots, 0, 0), 0);
});

test('the area is wired the way the design says: no loop of its own, only the office timers, classes with the ceo- prefix', () => {
  const src = readFileSync(join(ROOT, 'web', 'ceo-floor.mjs'), 'utf8');
  assert.equal(/setInterval|requestAnimationFrame|<canvas|createElement\('canvas'\)/.test(src), false);
  assert.equal(/\bsetTimeout\(/.test(src.replace(/timers\.setTimeout\(/g, '')), false, 'every timer is the office\'s (ctx.timers) and carries a floor id');
  const css = readFileSync(join(ROOT, 'web', 'ceo.css'), 'utf8');
  const classes = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/\.([a-z][\w-]*)/g)].map((m) => m[1]);
  const known = new Set(['body', 'fx-on', 'agt', 'sitting', 'paused', 'b-facade']);
  assert.deepEqual([...new Set(classes)].filter((c) => !c.startsWith('ceo-') && !known.has(c)), []);
});
