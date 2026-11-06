// The lobby (1F): roster, team seating, every wall formula, the view order, the server fields and the scene checks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../server/config.mjs';
import { Office } from '../server/office.mjs';
import { checkScene } from '../server/scene-check.mjs';
import { readPngSize } from '../server/scenes.mjs';
import {
  assignLobbySeats, backRowSeats, changeOf, changeText, clip, clockParts, employeeRows, fmtDuration, headline, indexRows, lobbyRoster, msToNextMinute,
  newsText, officeScore, pageCount, pageRows, pushSample, stateLabel, tableCapacity, costPageRows, costPageStep, floorFigure, initCost, live,
} from '../web/lobby.mjs';
import { costView } from '../web/cost-view.mjs';
import { quadFrame } from '../web/board.mjs';
import { LOBBY_ID, busiestFloor, chooseFollow, fallbackFloor, nextFloor, viewOrder } from '../web/view.mjs';
import { ROOT, cfg as rawCfg } from './helpers/fixture.mjs';

const cfg = loadConfig();
const L = cfg.ui.lobby;
const EMPTY = { hidden: [], names: {} };

const agent = (key, o = {}) => ({ key, name: key, role: '개발', sprite: 'worker', state: 'working', bubble: '', since: 0, enteredAt: 0, wf: false, ...o });
const floor = (sid, floorNo, agents = [], o = {}) => ({
  sessionId: sid, floorNo, colorIndex: floorNo, title: `층 ${floorNo}`, status: 'busy', startedAt: 1000, reports: 0, workflows: 0, failAt: [],
  lead: { name: `팀장${floorNo}`, role: '팀장', sprite: 'lead', state: 'idle', bubble: '' }, agents, ...o,
});

// ---- roster ----

test('lobby roster: floor order, 팀장 first, then 직원 by arrival; Workflow agents are 프로젝트 직원', () => {
  const f2 = floor('b', 3, [agent('b:2', { enteredAt: 20 }), agent('b:1', { enteredAt: 10, wf: true })]);
  const f1 = floor('a', 2, [agent('a:1', { enteredAt: 5, state: 'done' })], { reports: 4 });
  const roster = lobbyRoster([f2, f1], new Map([['a', 777]]));
  assert.deepEqual(roster.map((e) => [e.key, e.rank]), [['a:lead', 'lead'], ['a:1', 'staff'], ['b:lead', 'lead'], ['b:1', 'project'], ['b:2', 'staff']]);
  assert.equal(roster[0].since, 777);
  assert.equal(roster[0].reports, 4, '팀장 reports = its floor reports');
  assert.equal(roster[1].reports, 1, 'a done 직원 has reported once');
  assert.equal(roster[3].reports, 0);
  assert.equal(roster[0].sid, 'a');
  assert.equal(lobbyRoster([]).length, 0);
});

test('lobby roster: a leaving floor is carried on every entry', () => {
  const r = lobbyRoster([floor('a', 2, [agent('a:1')], { status: 'leaving' })]);
  assert.ok(r.every((e) => e.floorStatus === 'leaving'));
});

// ---- seats ----

const R = (sid, n) => Array.from({ length: n }, (_, i) => ({ key: `${sid}:${i}`, sid }));
const seatIdx = (m, key) => m.get(key)?.i;

test('lobby seats: newcomers of one floor sit together and keep their seat when others come and go', () => {
  const a = R('a', 4);
  let m = assignLobbySeats(new Map(), a, 40, 12);
  assert.deepEqual(a.map((e) => seatIdx(m, e.key)), [0, 1, 2, 3]);
  const b = R('b', 3);
  m = assignLobbySeats(m, [...a, ...b], 40, 12);
  assert.deepEqual(b.map((e) => seatIdx(m, e.key)), [4, 5, 6], 'a new floor starts at the longest free run');
  const before = new Map(m);
  m = assignLobbySeats(m, [...a.slice(0, 2), ...b], 40, 12); // two of a leave
  for (const e of [...a.slice(0, 2), ...b]) assert.deepEqual(m.get(e.key), before.get(e.key), 'nobody is reshuffled');
  m = assignLobbySeats(m, [...a.slice(0, 2), { key: 'a:new', sid: 'a' }, ...b], 40, 12);
  assert.equal(seatIdx(m, 'a:new'), 2, 'a newcomer takes the free seat nearest its own floor');
});

test('lobby seats: a second floor starts at the longest free run, ties at the lowest index', () => {
  const a = R('a', 2);
  let m = assignLobbySeats(new Map(), a, 10, 2);
  // a holds 0 and 1; seats 2.. are one free run of 8
  m = assignLobbySeats(m, [...a, ...R('b', 1)], 10, 2);
  assert.equal(seatIdx(m, 'b:0'), 2);
  // free the middle: a at 0, c at 5 -> the longest run is 6..9 (4) vs 1..4 (4): lowest index wins
  const prev = new Map([['a:0', { kind: 'seat', i: 0 }], ['c:0', { kind: 'seat', i: 5 }]]);
  const m2 = assignLobbySeats(prev, [{ key: 'a:0', sid: 'a' }, { key: 'c:0', sid: 'c' }, { key: 'd:0', sid: 'd' }], 10, 2);
  assert.equal(seatIdx(m2, 'd:0'), 1);
});

test('lobby seats: full seats overflow to standing spots, then nothing; an overflow member is promoted when a seat frees up', () => {
  const all = [...R('a', 3), ...R('b', 3), ...R('c', 2)];
  let m = assignLobbySeats(new Map(), all, 4, 2);
  const kinds = all.map((e) => m.get(e.key)?.kind ?? null);
  assert.equal(kinds.filter((k) => k === 'seat').length, 4);
  assert.equal(kinds.filter((k) => k === 'overflow').length, 2);
  assert.equal(kinds.filter((k) => k === null).length, 2, 'beyond the capacity: listed on the wall only');
  const standing = all.filter((e) => m.get(e.key)?.kind === 'overflow').map((e) => e.key);
  const seated = all.filter((e) => m.get(e.key)?.kind === 'seat');
  m = assignLobbySeats(m, all.filter((e) => e !== seated[0]), 4, 2); // one seated agent leaves
  assert.equal(m.get(standing[0]).kind, 'seat', 'the first one standing takes the free seat');
  assert.equal([...m.values()].filter((v) => v === null).length, 1, '8 - 1 left = 7 for 6 places');
});

test('lobby seats: a newcomer that is already done reserves no seat and is not counted as unseated; one that had a place keeps it', () => {
  const a = [...R('a', 2), { key: 'a:d', sid: 'a', state: 'done' }, { key: 'a:w', sid: 'a', state: 'working' }];
  let m = assignLobbySeats(new Map(), a, 10, 2);
  assert.equal(m.has('a:d'), false, 'no entry at all (undefined), so the page draws nothing and counts nobody');
  assert.equal(seatIdx(m, 'a:w'), 2, 'the next worker takes the seat the done one would have blocked');
  assert.equal(new Set([...m.values()].map((v) => v.i)).size, 3);
  const prev = new Map([['a:d', { kind: 'seat', i: 7 }]]);
  m = assignLobbySeats(prev, [{ key: 'a:d', sid: 'a', state: 'done' }], 10, 2);
  assert.deepEqual(m.get('a:d'), { kind: 'seat', i: 7 }, 'it was drawn before: it keeps its place until it leaves');
  m = assignLobbySeats(new Map(), [{ key: 'x', sid: 'x', state: 'done' }], 0, 0);
  assert.equal(m.size, 0, 'a full lobby: a done newcomer is not "unseated" either');
});

test('lobby seats: 60 agents fill 40 seats + 12 spots, the other 8 are null, and no slot is used twice', () => {
  const roster = [...R('a', 25), ...R('b', 20), ...R('c', 15)];
  const m = assignLobbySeats(new Map(), roster, 40, 12);
  const used = [...m.values()].filter(Boolean).map((v) => `${v.kind}${v.i}`);
  assert.equal(used.length, 52);
  assert.equal(new Set(used).size, 52);
  assert.equal([...m.values()].filter((v) => v === null).length, 8);
  assert.equal(m.size, 60);
});

// ---- headline numbers ----

const NOW = 1_000_000;
const WIN = 10 * 60000;

test('lobby headline: 근무 중 / 대기 / 졸음 from states, 보고 / 프로젝트 / 실패 summed over floors; done counts nowhere', () => {
  const roster = lobbyRoster([
    floor('a', 2, [agent('a:1', { state: 'working' }), agent('a:2', { state: 'thinking' }), agent('a:3', { state: 'stale' }), agent('a:4', { state: 'done' }), agent('a:5', { state: 'enter' })], { reports: 2, workflows: 1 }),
    floor('b', 3, [], { reports: 5, workflows: 2, lead: { name: 'x', role: '팀장', sprite: 'lead', state: 'working', bubble: '' } }),
  ]);
  const floors = [{ reports: 2, workflows: 1, failAt: [NOW - 1000, NOW - 2000, NOW - 3000] }, { reports: 5, workflows: 2, failAt: [] }];
  assert.deepEqual(headline(roster, floors, NOW, WIN), { working: 3, waiting: 3, sleepy: 1, reports: 7, projects: 3, fails: 3 });
  assert.deepEqual(headline([], [], NOW, WIN), { working: 0, waiting: 0, sleepy: 0, reports: 0, projects: 0, fails: 0 });
});

test('lobby headline: 실패 counts the failures of the last window over all floors and ages out (no unbounded growth)', () => {
  const floors = [{ failAt: [NOW - 11 * 60000, NOW - 9 * 60000, NOW - 1000] }, { failAt: [NOW - 5 * 60000, NOW - WIN - 1] }, {}];
  assert.equal(headline([], floors, NOW, WIN).fails, 3, 'the two older than 10 minutes are gone');
  assert.equal(headline([], floors, NOW + 6 * 60000, WIN).fails, 1, '6 minutes later only the newest is left');
  assert.equal(headline([], floors, NOW + 11 * 60000, WIN).fails, 0, 'a quiet window is 0');
  assert.equal(headline([], [{ failAt: [NOW - WIN] }], NOW, WIN).fails, 0, 'exactly a window old is out');
  assert.equal(headline([], [{ failAt: [NOW + 60000] }], NOW, WIN).fails, 0, 'a time from the future (clock skew) is not counted');
});

test('lobby headline: the window is a planning number in config.json and the label says it; the cell is red only above 0', () => {
  assert.equal(L.failMinutes, 10);
  assert.equal(L.head.fails.replace('{m}', L.failMinutes), '실패 (10분)');
  const app = readFileSync(join(ROOT, 'web', 'app.mjs'), 'utf8');
  assert.match(app, /headline\(lb\.roster, lb\.floors, now, L\.failMinutes \* 60000\)/);
  assert.match(app, /data-alarm', hc\.fails > 0 \? 'on' : 'off'/);
  const css = readFileSync(join(ROOT, 'web', 'style.css'), 'utf8');
  assert.match(css, /\.led-cells \.val\[data-alarm="on"\] \{ color: var\(--led-up\); \}/);
});

// ---- 사무실 지수 ----

test('lobby index: the office score is the sum of the floor scores', () => {
  assert.equal(officeScore(new Map([['a', 12], ['b', 30], ['c', 0]])), 42);
  assert.equal(officeScore(new Map()), 0);
});

test('lobby index: change against the sample at least a window old, else the oldest; direction, percent, prev 0', () => {
  const W = 60000;
  const s = [];
  pushSample(s, 0, 40, W);
  assert.deepEqual(changeOf(s, W), { delta: 0, pct: 0, dir: 'flat' }, 'a lone sample has no change');
  pushSample(s, 20000, 50, W);
  assert.deepEqual(changeOf(s, W), { delta: 10, pct: 25, dir: 'up' }, 'younger than the window: against the oldest');
  pushSample(s, 61000, 30, W);
  assert.deepEqual(changeOf(s, W), { delta: -10, pct: -25, dir: 'down' }, 'against the newest sample at least a window old (t=0)');
  pushSample(s, 90000, 30, W); // base moves on to t=20000 (v 50)
  assert.equal(changeOf(s, W).delta, -20);
  assert.ok(s.length <= 4);
  const z = [];
  pushSample(z, 0, 0, W);
  pushSample(z, 70000, 5, W);
  assert.deepEqual(changeOf(z, W), { delta: 5, pct: 500, dir: 'up' }, 'a base of 0 counts as 1');
  const flat = [];
  pushSample(flat, 0, 7, W);
  pushSample(flat, 61000, 7, W);
  assert.equal(changeOf(flat, W).dir, 'flat');
});

test('lobby index: the sample list is pruned to one base sample plus the window', () => {
  const s = [];
  for (let t = 0; t <= 300000; t += 1500) pushSample(s, t, t / 1500, 60000);
  assert.ok(s.length <= 60000 / 1500 + 2, `kept ${s.length}`);
  assert.ok(s[0].t <= 300000 - 60000, 'the oldest kept sample is the base');
});

test('lobby index: change text with and without percent', () => {
  assert.equal(changeText({ delta: 3, pct: 12.5, dir: 'up' }), '▲ 3 (12.5%)');
  assert.equal(changeText({ delta: -2, pct: -4, dir: 'down' }), '▼ 2 (4.0%)');
  assert.equal(changeText({ delta: 0, pct: 0, dir: 'flat' }), '-');
  assert.equal(changeText({ delta: 3, pct: 12.5, dir: 'up' }, false), '▲3');
});

test('lobby index rows: floor order, clipped title, capped rows and the rest counted', () => {
  const floors = [floor('c', 4), floor('a', 2, [], { title: '아주아주아주아주 긴 층 이름입니다' }), floor('b', 3)];
  const scores = new Map([['a', 9], ['b', 0], ['c', 4]]);
  const changes = new Map([['a', { delta: 2, pct: 28.6, dir: 'up' }]]);
  const { rows, more } = indexRows(floors, scores, changes, L, 2);
  assert.deepEqual(rows.map((r) => [r.floor, r.score, r.changeText]), [['2층', 9, '▲2'], ['3층', 0, '-']]);
  assert.equal(Array.from(rows[0].title).length, L.titleMax);
  assert.ok(rows[0].title.endsWith('…'));
  assert.equal(more, 1);
  assert.equal(rows[0].lead, '팀장2');
});

// ---- employee board ----

test('lobby board: duration under an hour in minutes, over an hour with hours', () => {
  assert.equal(fmtDuration(0, L), '0분');
  assert.equal(fmtDuration(59000, L), '0분');
  assert.equal(fmtDuration(59 * 60000, L), '59분');
  assert.equal(fmtDuration(65 * 60000, L), '1시간 5분');
  assert.equal(fmtDuration(120 * 60000, L), '2시간 0분');
  assert.equal(fmtDuration(-5000, L), '0분');
});

test('lobby board: state words, with the leaving floor overriding every state', () => {
  const e = { state: 'working', floorStatus: 'busy' };
  assert.equal(stateLabel(e, L), '근무 중');
  assert.equal(stateLabel({ ...e, state: 'thinking' }, L), '생각 중');
  assert.equal(stateLabel({ ...e, state: 'idle' }, L), '대기');
  assert.equal(stateLabel({ ...e, state: 'enter' }, L), '대기');
  assert.equal(stateLabel({ ...e, state: 'stale' }, L), '졸음');
  assert.equal(stateLabel({ ...e, state: 'done' }, L), '보고 완료');
  assert.equal(stateLabel({ ...e, floorStatus: 'leaving' }, L), '퇴근 중');
});

test('lobby board: one row per roster entry with every column; the task is the bubble clipped like the bubble', () => {
  const now = 10 * 60000 + 5000;
  const roster = lobbyRoster([floor('a', 2, [agent('a:1', { name: '서진', bubble: '아주아주 긴 말풍선 내용을 적어 봅니다 열여섯자넘음', enteredAt: 60000, wf: true, state: 'done' })], { reports: 3, startedAt: 5000 })]);
  const rows = employeeRows(roster, now, L, cfg.ui.bubbleMaxChars);
  assert.deepEqual(rows[0].cells, ['팀장2', '2층', '팀장', '대기', '-', '10분', '3']);
  assert.equal(rows[1].cells[0], '서진');
  assert.equal(rows[1].cells[2], '프로젝트 직원');
  assert.equal(rows[1].cells[3], '보고 완료');
  assert.equal(Array.from(rows[1].cells[4]).length, cfg.ui.bubbleMaxChars);
  assert.equal(rows[1].cells[5], '9분');
  assert.equal(rows[1].cells[6], '1');
  assert.equal(rows[1].sid, 'a');
  assert.equal(employeeRows([{ ...roster[0], startedAt: 0 }], now, L, 16)[0].cells[5], '-');
});

test('lobby board: no column repeats another (생각 중 / 생각 중… in 상태 and 지금 하는 일 is shown once)', () => {
  const now = 10 * 60000;
  const words = cfg.ui.play.statusBubbles;
  const e = (state, bubble, o = {}) => lobbyRoster([floor('a', 2, [agent('a:1', { name: '서진', state, bubble, enteredAt: 1000, ...o })])])[1];
  const task = (state, bubble) => employeeRows([e(state, bubble)], now, L, 16, words)[0].cells[4];
  assert.equal(task('thinking', '생각 중…'), '-', 'the bubble that says what 상태 says');
  assert.equal(task('thinking', '생각 중'), '-');
  assert.equal(task('thinking', '생각 중...'), '-');
  assert.equal(task('working', '근무 중'), '-', 'equal to the 상태 word');
  assert.equal(task('stale', '응답 없음'), '-', 'a stock phrase of a quiet 직원 only restates 상태');
  assert.equal(task('idle', '입력 대기'), '-');
  assert.equal(task('working', '작업 중'), '-');
  assert.equal(task('working', '서진'), '-', 'equal to the name');
  assert.equal(task('working', '2층'), '-', 'equal to the 층 cell');
  assert.equal(task('working', 'npm test 실행'), 'npm test 실행', 'real work is kept');
  assert.equal(task('thinking', '생각 중 입니다'), '생각 중 입니다', 'only a whole repeat is cut, not a text that contains the word');
  assert.equal(task('working', ''), '-');
  for (const [state, bubble] of [['thinking', '생각 중…'], ['working', '근무 중'], ['stale', '응답 없음'], ['working', 'npm test 실행'], ['idle', '']]) {
    const cells = employeeRows([e(state, bubble)], now, L, 16, words)[0].cells;
    const named = [0, 1, 2, 3, 4].map((i) => cells[i]).filter((c) => c !== '-');
    assert.equal(new Set(named.map((c) => c.replace(/[\s.…]+$/u, ''))).size, named.length, `${state}/${bubble}: ${cells.join('|')}`);
  }
});

test('lobby board: every wall string says N층, never NF (the plaque 「1F 로비」 keeps its style)', () => {
  const walls = JSON.stringify({ ...L, sign: '', tab: '' });
  assert.doesNotMatch(walls, /\d\s*F\b|\{n\}F/);
  assert.equal(L.floorLabel, '{n}층');
  assert.equal(L.sign, '1F 로비');
  const rows = employeeRows(lobbyRoster([floor('a', 6, [agent('a:1', { name: '서진' })])]), 10 * 60000, L, 16, []);
  assert.ok(rows.every((r) => r.cells[1] === '6층'));
  assert.equal(newsText({ ts: 0, name: '서진', text: '일했다' }, 6, L).includes('6층'), true);
});

test('lobby board: capacity and pages', () => {
  assert.equal(tableCapacity(102, 10, 2), 8);
  assert.equal(tableCapacity(5, 10, 2), 1, 'at least one row');
  assert.equal(pageCount(0, 7), 1);
  assert.equal(pageCount(7, 7), 1);
  assert.equal(pageCount(8, 7), 2);
  assert.equal(pageCount(40, 7), 6);
  const rows = Array.from({ length: 16 }, (_, i) => i);
  assert.deepEqual(pageRows(rows, 7, 0), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual(pageRows(rows, 7, 2), [14, 15]);
  assert.deepEqual(pageRows(rows, 7, 3), [0, 1, 2, 3, 4, 5, 6], 'a page past the end wraps');
  assert.deepEqual(pageRows([], 7, 4), []);
});

// ---- news line, clock, clipping ----

test('lobby news: HH:MM, floor, name and the log text clipped to newsMax; no floor part when the floor is gone', () => {
  const ts = new Date(2026, 9, 29, 14, 5, 9).getTime();
  const e = { ts, name: '서진', text: '파일 4개 살펴봄' };
  assert.equal(newsText(e, 3, L), '14:05 3층 서진 · 파일 4개 살펴봄');
  assert.equal(newsText(e, undefined, L), '14:05 서진 · 파일 4개 살펴봄');
  assert.equal(newsText({ ...e, head: '검토 · ctx' }, 3, L), '14:05 3층 서진 · 검토 · ctx · 파일 4개 살펴봄');
  const long = newsText({ ...e, text: 'x'.repeat(80) }, 3, L);
  assert.equal(Array.from(long.split(' · ')[1]).length, L.newsMax);
});

test('lobby clock: date with weekday and HH:MM; the timer targets the next minute', () => {
  const d = new Date(2026, 10, 2, 9, 7, 30); // 2026-11-02 is a Monday
  assert.deepEqual(clockParts(d.getTime(), L.days), { date: '11.02 (월)', time: '09:07' });
  assert.equal(msToNextMinute(60000 * 5 + 10000), 50000);
  assert.equal(msToNextMinute(60000 * 5), 60000);
  assert.equal(msToNextMinute(60000 * 5 - 200), 1000, 'never sooner than a second');
});

test('lobby clip: by characters, with an ellipsis', () => {
  assert.equal(clip('abc', 5), 'abc');
  assert.equal(clip('abcdef', 4), 'abc…');
  assert.equal(clip('한글입니다', 3), '한글…');
  assert.equal(clip(undefined, 3), '');
});

// ---- view ----

test('lobby view: rotation walks 1F, then each floor, then back to 1F; without a lobby it is the floors only', () => {
  const order = viewOrder(['a', 'b'], true);
  assert.deepEqual(order, [LOBBY_ID, 'a', 'b']);
  assert.equal(nextFloor(order, LOBBY_ID), 'a');
  assert.equal(nextFloor(order, 'b'), LOBBY_ID);
  assert.deepEqual(viewOrder(['a', 'b'], false), ['a', 'b']);
  assert.equal(nextFloor(viewOrder([], true), LOBBY_ID), LOBBY_ID, 'a lobby alone stays');
});

test('lobby view: follow never picks the lobby (the follow ids are the floors)', () => {
  const ids = ['a', 'b'];
  const scores = new Map([['a', 3], ['b', 9]]);
  assert.equal(busiestFloor(ids, scores, LOBBY_ID, 2), 'b');
  const pick = chooseFollow({ ids, scores, current: LOBBY_ID, now: 0, shownSince: 0 }, cfg.ui.follow);
  assert.equal(pick.id, 'b');
  assert.equal(chooseFollow({ ids: [], scores: new Map(), current: LOBBY_ID, now: 0, shownSince: 0 }, cfg.ui.follow).id, null);
  assert.notEqual(pick.id, LOBBY_ID);
});

test('lobby view: session ids never equal the lobby id, and the lobby survives any floor change by design (reconcile skips it)', () => {
  assert.equal(LOBBY_ID, 'lobby');
  assert.equal(fallbackFloor(['a'], 'a', []), null, 'a session view with nothing left falls back to the stack');
  const app = readFileSync(join(ROOT, 'web', 'app.mjs'), 'utf8');
  assert.match(app, /if \(shownId !== null && shownId !== LOBBY_ID\) \{/, 'reconcileView leaves the lobby alone');
});

// ---- server ----

const S = (id, o = {}) => ({ provider: 'claude', pid: 100, sessionId: id, cwd: 'C:\\Project', status: 'busy', name: '', startedAt: 1000, ...o });
const M = (id, o = {}) => ({ agentId: id, agentType: 'worker', description: '조사', finished: false, transcriptPath: '', mtimeMs: 0, workflow: null, ...o });
const floorOf = (o, id) => o.snapshot().floors.find((f) => f.sessionId === id);

test('lobby server: floors are numbered from 2 while the lobby is on, from 1 when it is off', () => {
  const on = new Office(cfg, EMPTY);
  on.syncSessions([S('a', { startedAt: 1 }), S('b', { startedAt: 2 })], 1000);
  assert.deepEqual(on.snapshot().floors.map((f) => f.floorNo), [3, 2]);
  const off = new Office(loadConfig({ lobby: { enabled: false } }), EMPTY);
  off.syncSessions([S('a', { startedAt: 1 }), S('b', { startedAt: 2 })], 1000);
  assert.deepEqual(off.snapshot().floors.map((f) => f.floorNo), [2, 1]);
  assert.equal(loadConfig({ lobby: { enabled: false } }).scenes.lobby, undefined);
  assert.ok(cfg.scenes.lobby, 'the lobby scene is loaded when it is on');
});

test('lobby server: the lobby is never a session room', () => {
  const o = new Office(cfg, EMPTY);
  for (let i = 0; i < 12; i++) o.syncSessions(Array.from({ length: i + 1 }, (_, k) => S(`s${k}`, { startedAt: k + 1 })), 1000 + i);
  assert.ok(o.snapshot().floors.every((f) => f.design !== 'lobby'));
});

test('lobby server: startedAt, fails, enteredAt and wf are numbers and booleans only', () => {
  const o = new Office(cfg, EMPTY);
  o.syncSessions([S('s1', { startedAt: 4242 })], 100000);
  o.syncAgents('s1', [M('a1', { mtimeMs: 7777 }), M('w1', { workflow: { runId: 'r', phase: 'Review', label: 'ctx' } })], 100000);
  const f = floorOf(o, 's1');
  assert.equal(f.startedAt, 4242);
  assert.deepEqual(f.failAt, []);
  const a1 = f.agents.find((a) => a.agentId === 'a1');
  const w1 = f.agents.find((a) => a.agentId === 'w1');
  assert.equal(a1.enteredAt, 7777);
  assert.equal(a1.wf, false);
  assert.equal(w1.wf, true);
  assert.equal(w1.enteredAt, 100000, 'no meta time: when it was found');
  for (const v of [f.startedAt, ...f.failAt, a1.enteredAt, w1.enteredAt]) assert.equal(typeof v, 'number');
});

test('lobby server: fails counts live failed tool results only, never a hidden floor or backfill', () => {
  const o = new Office(cfg, EMPTY);
  o.syncSessions([S('s1')], 100000);
  const fail = (ts) => ({ kind: 'toolDone', ts, toolUseId: `d${ts}`, error: true });
  o.applySessionEvents('s1', [fail(50000)], 100001); // before the floor existed: backfill
  assert.deepEqual(floorOf(o, 's1').failAt, []);
  o.applySessionEvents('s1', [fail(100100), fail(100200), { kind: 'toolDone', ts: 100300, toolUseId: 'ok' }], 100300);
  assert.deepEqual(floorOf(o, 's1').failAt, [100100, 100200]);
  o.syncSessions([S('s2')], 100000);
  assert.equal(o.hide('s2'), true);
  o.applySessionEvents('s2', [fail(100400)], 100400);
  o.syncSessions([S('s2')], 100500); // visible again only after a re-run; nothing was counted while hidden
  assert.deepEqual(floorOf(o, 's2')?.failAt ?? [], []);
});

test('lobby server: failure times older than the window are dropped, at most 500 are kept, and the window is config', () => {
  const win = cfg.ui.lobby.failMinutes * 60000;
  const o = new Office(cfg, EMPTY);
  o.syncSessions([S('s1')], 100000);
  const fail = (ts) => ({ kind: 'toolDone', ts, toolUseId: `d${ts}`, error: true });
  o.applySessionEvents('s1', [fail(100100)], 100100);
  const later = 100100 + win + 5000;
  o.applySessionEvents('s1', [fail(later)], later); // pruned on the next failure
  assert.deepEqual(floorOf(o, 's1').failAt, [later]);
  o.applySessionEvents('s1', [fail(later + 1000)], later + 1000);
  o.tick(later + 1000 + win + 1); // and by the clock tick
  assert.deepEqual(floorOf(o, 's1').failAt, []);
  const burst = Array.from({ length: 600 }, (_, i) => fail(later + 2000 + i));
  o.applySessionEvents('s1', burst, later + 3000);
  assert.equal(floorOf(o, 's1').failAt.length, 500);
});

test('lobby server: the snapshot adds no text field (privacy list unchanged)', () => {
  const o = new Office(cfg, EMPTY);
  o.syncSessions([S('s1')], 100000);
  o.syncAgents('s1', [M('a1')], 100000);
  const f = floorOf(o, 's1');
  // 'phases' carries the same cleaned phase names the board's sheet already sends (the detail panel shows them next to the to-do list)
  assert.deepEqual(Object.keys(f).sort(), ['agents', 'autoTitle', 'board', 'call', 'callSince', 'colorIndex', 'conflicts', 'design', 'failAt', 'floorNo', 'folder', 'lead', 'origin', 'phases', 'provider', 'reports', 'rest', 'sessionId', 'sheet', 'startedAt', 'status', 'title', 'todos', 'workflows']);
  assert.deepEqual(Object.keys(f.agents[0]).sort(), ['agentId', 'bubble', 'conflict', 'enteredAt', 'key', 'model', 'name', 'phase', 'pile', 'role', 'since', 'slot', 'slowKind', 'slowSince', 'sprite', 'state', 'wf']);
});

// ---- scene ----

const SHIPPED = join(ROOT, 'assets', 'scenes', 'lobby');
const lobbyRaw = () => JSON.parse(readFileSync(join(SHIPPED, 'scene.json'), 'utf8'));
const check = (raw) => checkScene(raw, { atlasSize: readPngSize(join(SHIPPED, raw.atlas)), cfg: rawCfg });
const stage10 = (res) => res.errors.filter((e) => e.includes('ledWall'));

test('lobby scene: the shipped scene passes, has 40 seats, 12 overflow spots and six screens with vertical sides', () => {
  const raw = lobbyRaw();
  const res = check(raw);
  assert.deepEqual(res.errors, []);
  assert.equal(raw.seats.length, 40);
  assert.equal(raw.overflow.length, 12);
  assert.deepEqual(raw.ledWall.panels.map((p) => p.id).sort(), ['center', 'left', 'right', 'tickerCenter', 'tickerLeft', 'tickerRight']);
  assert.equal(raw.whiteboard, undefined);
  assert.equal(raw.windows, undefined);
});

test('lobby scene: a slanted screen side and a seat under a screen are rejected', () => {
  const slanted = lobbyRaw();
  slanted.ledWall.panels[0].quad[1] = [slanted.ledWall.panels[0].quad[1][0] + 6, slanted.ledWall.panels[0].quad[1][1]];
  assert.ok(stage10(check(slanted)).some((e) => /수직/.test(e)), 'slanted side');
  const under = lobbyRaw();
  const q = under.ledWall.panels.find((p) => p.id === 'center').quad;
  q[2] = [q[2][0], 330]; // the centre screen reaches down over the first desk row's heads
  q[3] = [q[3][0], 330];
  assert.ok(stage10(check(under)).some((e) => /가려집니다/.test(e)), 'a head under the screen');
  const dup = lobbyRaw();
  dup.ledWall.panels[1].id = dup.ledWall.panels[0].id;
  assert.ok(stage10(check(dup)).some((e) => /겹칩니다/.test(e)), 'duplicate id');
});

// ---- concave wings: the homography of the screens and the straight front-facing desks ----

/** Applies a matrix3d(...) string to the point (x, y) of the box: the projected point. */
function project(matrix3d, [x, y]) {
  const m = matrix3d.slice('matrix3d('.length, -1).split(',').map(Number); // column-major 4x4
  const w = m[3] * x + m[7] * y + m[15];
  return [(m[0] * x + m[4] * y + m[12]) / w, (m[1] * x + m[5] * y + m[13]) / w];
}
const WINGS = () => Object.fromEntries(lobbyRaw().ledWall.panels.map((p) => [p.id, p.quad]));

test('quadFrame: the four corners of the box land on the quad corners (real wing quads, both sides)', () => {
  for (const id of ['left', 'right', 'tickerLeft', 'tickerRight', 'center']) {
    const quad = WINGS()[id];
    const f = quadFrame(quad);
    const [tl, tr, br, bl] = quad;
    assert.equal(f.x, tl[0]);
    assert.equal(f.y, tl[1]);
    assert.equal(f.w, Math.max(tr[0] - tl[0], br[0] - bl[0]));
    assert.equal(f.h, Math.min(bl[1] - tl[1], br[1] - tr[1]), 'the shorter vertical edge');
    const want = quad.map(([x, y]) => [x - tl[0], y - tl[1]]);
    [[0, 0], [f.w, 0], [f.w, f.h], [0, f.h]].forEach((corner, i) => {
      const got = project(f.matrix3d, corner);
      assert.ok(Math.abs(got[0] - want[i][0]) < 0.01 && Math.abs(got[1] - want[i][1]) < 0.01, `${id} corner ${i}: ${got} vs ${want[i]}`);
    });
  }
});

test('quadFrame: a rectangle is a pure translation-free identity, a parallelogram stays affine, a wing is projective', () => {
  const rect = quadFrame([[10, 20], [110, 20], [110, 60], [10, 60]]);
  assert.equal(rect.matrix3d, 'matrix3d(1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1)');
  const shear = project(quadFrame([[0, 0], [100, 20], [100, 60], [0, 40]]).matrix3d, [100, 0]);
  assert.ok(Math.abs(shear[0] - 100) < 1e-6 && Math.abs(shear[1] - 20) < 1e-6);
  const m = quadFrame(WINGS().left).matrix3d.slice(9, -1).split(',').map(Number);
  assert.ok(Math.abs(m[3]) > 1e-5 || Math.abs(m[7]) > 1e-5, 'perspective terms g/h are not zero for the wing');
});

test('quadFrame: the text grows toward the taller end (concave) and an inverse mapping round-trips', () => {
  const f = quadFrame(WINGS().left);
  const mid = (x) => { const a = project(f.matrix3d, [x, 0]); const b = project(f.matrix3d, [x, f.h]); return b[1] - a[1]; }; // drawn height of a box column
  assert.ok(mid(0) > mid(f.w) * 1.1, 'left wing: outer (x=0) end drawn at least 10 % taller than the inner end');
  const g = quadFrame(WINGS().right);
  const col = (x) => { const a = project(g.matrix3d, [x, 0]); const b = project(g.matrix3d, [x, g.h]); return b[1] - a[1]; };
  assert.ok(col(g.w) > col(0) * 1.1, 'right wing mirrors it');
  // inverse sanity: the quad centre maps back to the box centre under the inverse of the 3x3
  const m = f.matrix3d.slice(9, -1).split(',').map(Number);
  const H = [[m[0], m[4], m[12]], [m[1], m[5], m[13]], [m[3], m[7], m[15]]];
  const det = H[0][0] * (H[1][1] * H[2][2] - H[1][2] * H[2][1]) - H[0][1] * (H[1][0] * H[2][2] - H[1][2] * H[2][0]) + H[0][2] * (H[1][0] * H[2][1] - H[1][1] * H[2][0]);
  const inv = [
    [H[1][1] * H[2][2] - H[1][2] * H[2][1], H[0][2] * H[2][1] - H[0][1] * H[2][2], H[0][1] * H[1][2] - H[0][2] * H[1][1]],
    [H[1][2] * H[2][0] - H[1][0] * H[2][2], H[0][0] * H[2][2] - H[0][2] * H[2][0], H[0][2] * H[1][0] - H[0][0] * H[1][2]],
    [H[1][0] * H[2][1] - H[1][1] * H[2][0], H[0][1] * H[2][0] - H[0][0] * H[2][1], H[0][0] * H[1][1] - H[0][1] * H[1][0]],
  ].map((row) => row.map((v) => v / det));
  const p = project(f.matrix3d, [f.w / 3, f.h / 4]);
  const w = inv[2][0] * p[0] + inv[2][1] * p[1] + inv[2][2];
  const back = [(inv[0][0] * p[0] + inv[0][1] * p[1] + inv[0][2]) / w, (inv[1][0] * p[0] + inv[1][1] * p[1] + inv[1][2]) / w];
  assert.ok(Math.abs(back[0] - f.w / 3) < 1e-6 && Math.abs(back[1] - f.h / 4) < 1e-6, `round trip ${back}`);
});

test('quadFrame: a quad without area is refused', () => {
  assert.throws(() => quadFrame([[5, 5], [5, 5], [5, 5], [5, 5]]));
  assert.throws(() => quadFrame([[0, 0], [10, 0], [10, 0], [0, 0]]));
});

test('lobby scene: the wings are taller at the outer end (concave), every screen is a convex quad, the ledBox uses quadFrame', () => {
  const q = WINGS();
  const hAt = (quad, side) => (side === 'l' ? quad[3][1] - quad[0][1] : quad[2][1] - quad[1][1]);
  assert.ok(hAt(q.left, 'l') >= 1.1 * hAt(q.left, 'r'), 'left: outer = left edge');
  assert.ok(hAt(q.right, 'r') >= 1.1 * hAt(q.right, 'l'), 'right: outer = right edge');
  for (const [id, [tl, tr, br, bl]] of Object.entries(q)) {
    const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    assert.ok([cr(tl, tr, br), cr(tr, br, bl), cr(br, bl, tl), cr(bl, tl, tr)].every((c) => c > 0), `${id} convex with area`);
  }
  const app = readFileSync(join(ROOT, 'web', 'app.mjs'), 'utf8');
  const fn = app.slice(app.indexOf('function ledBox('), app.indexOf('/** A row of plain cells'));
  assert.match(fn, /quadFrame\(p\.quad\)/);
  assert.match(fn, /transform: f\.matrix3d/);
  assert.doesNotMatch(fn, /boardFrame/);
});

test('lobby scene: 40 straight desks, every seat sits behind its desk facing the viewer (sitAt 2px below at like the floors, face right, its chair behind)', () => {
  const raw = lobbyRaw();
  assert.equal(raw.seats.length, 40);
  const objs = new Map(raw.objects.map((o) => [o.id, o]));
  const res = check(raw);
  const seats = res.resolved.seats;
  assert.equal(seats.length, 40);
  for (const s of seats) {
    assert.deepEqual([s.sitAt[0], s.sitAt[1] - 2], s.at, `${s.i}: the seated picture sits 2px below the standing point, as on the floors`);
    const chair = res.resolved.objects.find((o) => o.id === `chair-${s.deskId.split('-')[1]}`);
    assert.ok(chair && chair.at[0] === s.at[0] && chair.footprint.every((q) => q[1] <= s.at[1] - 2), `${s.i}: a chair behind the seated figure`);
    assert.equal(s.face, 'right');
    assert.ok(['desk', 'desk-b'].includes(objs.get(s.deskId)?.kind), `${s.i}: a straight desk kind`);
  }
  for (const [kind, k] of Object.entries(raw.kinds)) {
    if (kind !== 'desk' && kind !== 'desk-b') continue;
    const xs = k.footprint.map((p) => p[0]);
    const ys = k.footprint.map((p) => p[1]);
    assert.ok(Math.max(...xs) > 3 * (Math.max(...ys) - Math.min(...ys)), `${kind}: long side horizontal (footprint is a flat rectangle)`);
    assert.deepEqual([k.seat.sitAt[0], k.seat.sitAt[1] - 2], k.seat.at);
  }
});

test('lobby figure: a figure of a seat sits (the seated picture at sitAt), one on a standing spot stands', () => {
  const app = readFileSync(join(ROOT, 'web', 'app.mjs'), 'utf8');
  const fn = app.slice(app.indexOf('function lobbyFigure('), app.indexOf('/** Roster -> seats -> figures'));
  assert.match(fn, /p = sitSet\.has\(e\.sprite\) \? s\.sitAt : s\.at;/);
  assert.match(fn, /setPose\(rec, rec\.home\.sits, false\)/);
  assert.match(fn, /sits: at !== null && rec\.sitImg !== null/);
  const o = fn.slice(fn.indexOf('} else {'), fn.indexOf('let rec = lb.chars.get'));
  assert.match(o, /p = o\.at;/, 'a standing spot is a standing place');
  assert.doesNotMatch(o, /sitAt|setPose/);
});

// ---- name tags: floor number chip and lead marker ----

test('lobby tags: the floor number rides a chip in the team colour, a 팀장 gets a small ★, the title is written only on change', () => {
  const app = readFileSync(join(ROOT, 'web', 'app.mjs'), 'utf8');
  const css = readFileSync(join(ROOT, 'web', 'style.css'), 'utf8');
  const fn = app.slice(app.indexOf('function lobbyFigure('), app.indexOf('/** Roster -> seats -> figures'));
  assert.match(fn, /rec\.tagFl = el\('i', 'fl'\)/);
  assert.match(fn, /setText\(rec\.tagFl, String\(e\.floorNo\)\)/);
  assert.match(fn, /el\('i', 'lead', '★'\)/);
  assert.match(fn, /rec\.tagLead\.hidden !== \(e\.rank !== 'lead'\)/);
  assert.match(fn, /setAttr\(rec\.tag, 'title'/);
  assert.doesNotMatch(fn, /rec\.tag\.title =/, 'no unconditional write per frame');
  assert.match(css, /\.floor\.lobby \.tag \.fl \{[^}]*background: var\(--c\)/);
  assert.match(css, /\.floor\.lobby \.tag \.lead \{[^}]*color: var\(--c\)/);
  assert.doesNotMatch(css, /\.floor\.lobby \.tag::before/, 'the plain dot is gone');
  assert.doesNotMatch(css, /@media[^{]*dark[^{]*\{[^}]*\.tag \.lead/, 'same marker in light and dark');
});

test('lobby bubbles: only the back row (smallest y) of the shipped scene keeps a text bubble', () => {
  const seats = check(lobbyRaw()).resolved.seats;
  const back = backRowSeats(seats);
  const ys = new Set([...back].map((i) => seats[i].at[1]));
  assert.equal(back.size, 8);
  assert.equal(ys.size, 1);
  assert.equal([...ys][0], Math.min(...seats.map((s) => s.at[1])));
  assert.deepEqual([...backRowSeats([{ at: [1, 50] }, { at: [2, 30] }, { at: [3, 33] }, { at: [4, 90] }])].sort(), [1, 2]);
});

// ---- labour cost on the wall ----

const costFrame = (o = {}) => ({
  day: '2026-11-06', tokens: 5_000_000, cacheRead: 9_000_000, lastWeek: null, floors: [{ sessionId: 's1', tokens: 4_000_000 }],
  top: [
    { sessionId: 's1', agentKey: null, name: '하나', floorName: '제목 하나', tokens: 3_000_000 },
    { sessionId: 'gone', agentKey: 'x', name: '', floorName: '', tokens: 2_000_000 },
  ],
  scanning: false, partial: false, ...o,
});

test('lobby cost: the cost page lists the top people with their floor, and a person whose floor left has none and no click target', () => {
  const rows = costPageRows(costView(costFrame(), cfg.ui.cost), [floor('s1', 3)], L, 5);
  assert.deepEqual(rows.map((r) => r.cells), [['하나', '3층', '제목 하나', '', '', '3.0M', ''], [cfg.ui.cost.goneName, '', '', '', '', '2.0M', '']]);
  assert.deepEqual(rows.map((r) => r.sid), ['s1', '']);
  assert.equal(costPageRows(costView(costFrame(), cfg.ui.cost), [floor('s1', 3)], L, 1).length, 1, 'at most as many rows as the table has');
  assert.deepEqual(costPageRows(costView(costFrame({ scanning: true }), cfg.ui.cost), [floor('s1', 3)], L, 5), [], 'counting: no half-counted rows');
  assert.deepEqual(costPageRows(costView(null, cfg.ui.cost), [], L, 5), []);
});

test('lobby cost: a floor line of the index panel starts with its tokens, an unlisted floor with the empty mark, counting with the scanning word', () => {
  const C = cfg.ui.cost;
  const v = costView(costFrame(), C);
  assert.equal(floorFigure(v, costFrame(), 's1', C), '4.0M');
  assert.equal(floorFigure(v, costFrame(), 's9', C), C.empty);
  assert.equal(floorFigure(costView(costFrame({ scanning: true }), C), costFrame({ scanning: true }), 's1', C), C.scanning);
  assert.equal(floorFigure(costView(null, C), null, 's1', C), C.empty);
});

test('lobby cost: the cost page comes after the last page of the table, which is held back one flip; a one-page table alternates', () => {
  // three pages: it comes up when the table has wrapped to page 0 and puts the table back to its last page
  assert.deepEqual(costPageStep(false, 3, 1), { show: false, rewind: null });
  assert.deepEqual(costPageStep(false, 3, 2), { show: false, rewind: null });
  assert.deepEqual(costPageStep(false, 3, 0), { show: true, rewind: 2 });
  assert.deepEqual(costPageStep(true, 3, 0), { show: false, rewind: null }, 'the next tick hands the wall back to the table');
  assert.deepEqual(costPageStep(false, 1, 0), { show: true, rewind: null });
  assert.deepEqual(costPageStep(true, 1, 0), { show: false, rewind: null });
  // walk a whole round: every table page is on the wall once, the cost page once, in order
  let page = 0;
  let shown = false;
  const pages = 3;
  const seen = [];
  for (let flip = 0; flip < 8; flip++) {
    seen.push(shown ? 'cost' : page);
    page = (page + 1) % pages; // the table flips by itself
    const step = costPageStep(shown, pages, page);
    if (step.rewind !== null) page = step.rewind;
    shown = step.show;
  }
  assert.deepEqual(seen, [0, 1, 2, 'cost', 0, 1, 2, 'cost']);
});

// ---- initCost on a stand-in page (review nits: the table's title row, no ic- class, a hidden tab paints nothing) ----

class Node {
  constructor(doc, tag) { Object.assign(this, { tag, ownerDocument: doc, children: [], dataset: {}, style: {}, hidden: false, className: '', textContent: '' }); }
  get classList() { return { contains: (c) => this.className.split(' ').includes(c) }; }
  append(...kids) { this.children.push(...kids); }
  setAttribute() {}
}
const standIn = () => {
  const doc = { createElement: (tag) => new Node(doc, tag) };
  const el = new Node(doc, 'div');
  const title = new Node(doc, 'div');
  title.className = 'led-hd';
  const cols = new Node(doc, 'div');
  el.append(title, cols);
  const lb = { sid: 'lobby', page: 0, pages: 1, pageAt: 0, wall: { boxes: new Map([['center', { el }]]), rows: [new Node(doc, 'div'), new Node(doc, 'div')], idxRows: [], tickers: [] } };
  const hooks = { state: [], server: {}, fx: {}, timers: [] };
  const ctx = {
    ui: cfg.ui, lobby: () => lb, floorActive: () => true, now: () => 0,
    timers: { setTimeout: (fn) => hooks.timers.push(fn), clearTimeout: () => {} },
    onServer: (name, fn) => { hooks.server[name] = fn; },
    onState: (fn) => hooks.state.push(fn),
    onPauseChange: () => {},
    fx: { onFx: (name, fn) => { hooks.fx[name] = fn; } },
  };
  return { ctx, lb, el, title, cols, hooks };
};

test('lobby cost page: its box is marked by a data attribute, and the whole table (title row too) steps aside while it shows', () => {
  const was = globalThis.MutationObserver;
  globalThis.MutationObserver = class { observe() {} };
  try {
    const { ctx, el, title, cols, hooks } = standIn();
    initCost(ctx);
    const box = el.children.at(-1);
    assert.equal(box.className, '', 'no class of another package');
    assert.ok('costPage' in box.dataset);
    assert.equal(box.hidden, true);
    hooks.timers.shift()(); // the rotation's first look: a one-page table alternates to the cost page
    assert.equal(box.hidden, false);
    assert.equal(title.style.display, 'none');
    assert.equal(cols.style.display, 'none');
    hooks.timers.shift()(); // and back
    assert.equal(box.hidden, true);
    assert.equal(title.style.display, '');
  } finally {
    globalThis.MutationObserver = was;
  }
});

test('lobby cost page: a state frame of a hidden tab does not paint the wall, a visible one does', () => {
  const was = globalThis.MutationObserver;
  globalThis.MutationObserver = class { observe() {} };
  try {
    const { ctx, el, hooks } = standIn();
    initCost(ctx);
    const box = el.children.at(-1);
    hooks.server.cost(costFrame());
    hooks.timers.shift()(); // the cost page is on the wall
    const firstRow = () => box.children[1];
    assert.equal(firstRow().children[1].textContent, '', 'no floors known yet: no floor number');
    hooks.state[0]([floor('s1', 3)], { hidden: true });
    assert.equal(live.floors.length, 1, 'the data is kept current');
    assert.equal(firstRow().children[1].textContent, '', 'but nothing is drawn');
    hooks.state[0]([floor('s1', 3)], { hidden: false });
    assert.equal(firstRow().children[1].textContent, '3층');
  } finally {
    globalThis.MutationObserver = was;
  }
});
