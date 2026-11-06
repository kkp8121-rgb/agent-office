// The labour cost view (feature 2): units, difference, scanning / partial honesty, and the pure model the lobby wall, the detail window, the card and the boss-room chalkboard share.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../server/config.mjs';
import { costView, diffPercent, diffText, floorCost, floorTokens, floorTop, fmtTokens, personCostLine, personOf, personTokens } from '../web/cost-view.mjs';

const C = loadConfig().ui.cost;

const person = (sessionId, agentKey, name, tokens, floorName = 'F') => ({ sessionId, agentKey, name, floorName, tokens });
const frame = (o = {}) => ({
  day: '2026-11-06', tokens: 12_300_000, cacheRead: 4_200_000_000, lastWeek: { day: '2026-10-30', tokensSameHour: 10_000_000, partial: false },
  floors: [{ sessionId: 's1', tokens: 9_000_000 }, { sessionId: 's2', tokens: 3_300_000 }],
  top: [person('s1', null, '하나', 6_000_000), person('s1', 'a1', '둘', 3_000_000), person('s2', null, '셋', 2_000_000), person('s2', 'a2', '', 900_000), person('s1', 'a3', '다섯', 400_000), person('s2', 'a4', '여섯', 300_000)],
  scanning: false, partial: false, ...o,
});

test('cost-view: units count in B, M and k with one decimal and plain integers below 1k', () => {
  assert.equal(fmtTokens(0, C.units, C.decimals), '0');
  assert.equal(fmtTokens(999, C.units, C.decimals), '999');
  assert.equal(fmtTokens(1000, C.units, C.decimals), '1.0k');
  assert.equal(fmtTokens(12_300, C.units, C.decimals), '12.3k');
  assert.equal(fmtTokens(12_300_000, C.units, C.decimals), '12.3M');
  assert.equal(fmtTokens(4_200_000_000, C.units, C.decimals), '4.2B');
  assert.equal(fmtTokens(-5, C.units, C.decimals), '0', 'a negative or broken number is 0');
  assert.equal(fmtTokens(Number.NaN, C.units, C.decimals), '0');
});

test('cost-view: a value that rounds up to the next unit is written in that unit', () => {
  assert.equal(fmtTokens(999_960, C.units, C.decimals), '1.0M');
  assert.equal(fmtTokens(999_940, C.units, C.decimals), '999.9k');
  assert.equal(fmtTokens(999_960_000, C.units, C.decimals), '1.0B');
});

test('cost-view: the difference to last week has a sign, is whole percent and never divides by zero', () => {
  assert.equal(diffPercent(112, 100), 12);
  assert.equal(diffPercent(95, 100), -5);
  assert.equal(diffPercent(100, 100), 0);
  assert.equal(diffPercent(1, 3), -67);
  assert.equal(diffPercent(50, 0), null, 'last week 0: no difference');
  assert.equal(diffPercent(50, null), null);
  assert.deepEqual([12, -5, 0].map(diffText), ['+12%', '-5%', '0%']);
});

test('cost-view: the news line has the total, last week same hour and the difference', () => {
  const v = costView(frame(), C);
  assert.equal(v.state, 'ready');
  assert.equal(v.total, '12.3M');
  assert.equal(v.lastWeek.text, '10.0M');
  assert.equal(v.diff, '+23%');
  assert.equal(v.news, '오늘 합계 12.3M · 지난주 같은 시각 10.0M (+23%)');
  assert.equal(v.cacheRead, '4.2B', 'cache reads are their own figure, not part of the total');
});

test('cost-view: no last week shows the no-record words, and a last week of 0 leaves the brackets out', () => {
  const none = costView(frame({ lastWeek: null }), C);
  assert.equal(none.lastWeek, null);
  assert.equal(none.diff, null);
  assert.equal(none.news, `오늘 합계 12.3M · ${C.noLastWeek}`);
  const zero = costView(frame({ lastWeek: { day: 'd', tokensSameHour: 0, partial: false } }), C);
  assert.equal(zero.diff, null);
  assert.equal(zero.news, '오늘 합계 12.3M · 지난주 같은 시각 0');
});

test('cost-view: while the old logs are still being counted no number is shown, only the scanning word', () => {
  const v = costView(frame({ scanning: true }), C);
  assert.equal(v.state, 'scanning');
  assert.equal(v.total, C.scanning);
  assert.equal(v.cacheRead, C.scanning);
  assert.equal(v.news, `${C.title} ${C.scanning}`);
  assert.equal(v.diff, null);
  assert.ok(v.top.every((p) => p.text === C.scanning), 'no row carries a half-counted figure');
  assert.equal(v.text(5), C.scanning);
});

test('cost-view: a partial day keeps its number but says 「일부」 and gives no difference; a partial last week too', () => {
  const v = costView(frame({ partial: true }), C);
  assert.equal(v.state, 'ready');
  assert.equal(v.partial, true);
  assert.equal(v.total, `12.3M (${C.partial})`);
  assert.equal(v.diff, null);
  assert.equal(v.news, `오늘 합계 12.3M (${C.partial}) · 지난주 같은 시각 10.0M`);
  const lw = costView(frame({ lastWeek: { day: 'd', tokensSameHour: 10_000_000, partial: true } }), C);
  assert.equal(lw.lastWeek.text, `10.0M (${C.partial})`);
  assert.equal(lw.lastWeek.partial, true);
  assert.equal(lw.diff, null);
  assert.equal(lw.partial, false, 'today itself is complete');
});

test('cost-view: before the first frame every figure is the empty mark', () => {
  const v = costView(null, C);
  assert.equal(v.state, 'none');
  assert.equal(v.total, C.empty);
  assert.equal(v.news, `${C.title} ${C.empty}`);
  assert.deepEqual(v.top, []);
  assert.equal(v.text(1), C.empty);
});

test('cost-view: the top list is cut at topN and a person who has left is named with the gone name', () => {
  const v = costView(frame(), C);
  assert.equal(v.top.length, C.topCount);
  assert.deepEqual(v.top.map((p) => p.name), ['하나', '둘', '셋', C.goneName, '다섯']);
  assert.deepEqual(v.top.map((p) => p.text), ['6.0M', '3.0M', '2.0M', '900.0k', '400.0k']);
  assert.equal(costView(frame(), C, 2).top.length, 2, 'the chalkboard asks for its own count');
});

test('cost-view: a floor window shows the floor total, its top people, and the cache reads apart', () => {
  const f = floorCost(frame(), C, 's2', { floor: '3층', cacheRead: '사무실 캐시 읽기' }, 3);
  assert.deepEqual(f.total, { label: '3층', text: '3.3M' });
  assert.deepEqual(f.people, [{ label: '셋', text: '2.0M' }, { label: C.goneName, text: '900.0k' }, { label: '여섯', text: '300.0k' }]);
  assert.deepEqual(f.cache, { label: '사무실 캐시 읽기', text: '4.2B' });
  assert.equal(floorCost(frame(), C, 's1', { floor: 'x', cacheRead: 'y' }, 2).people.length, 2, 'at most `max` people');
  assert.equal(floorCost(frame(), C, 'gone', { floor: 'x', cacheRead: 'y' }, 3).total.text, C.empty, 'a floor the frame does not list has no figure');
  assert.equal(floorCost(frame({ scanning: true }), C, 's1', { floor: 'x', cacheRead: 'y' }, 3).total.text, C.scanning);
  assert.equal(floorTokens(frame(), 's1'), 9_000_000);
  assert.equal(floorTokens(null, 's1'), null);
  assert.equal(floorTop(frame(), 's1', 9).length, 3);
});

test('cost-view: a card finds its person in the floor views and shows only a figure the frame has', () => {
  const floors = [
    { sessionId: 's1', floorNo: 2, lead: { name: '하나', sprite: 'lead1', model: 'opus', pile: 2 }, agents: [{ agentId: 'a1', key: 's1:a1', name: '둘', sprite: 'worker', model: 'sonnet', pile: 0 }] },
    { sessionId: 's2', floorNo: 3, lead: { name: '셋', sprite: 'lead2', model: null, pile: 0 }, agents: [] },
  ];
  const lead = personOf(floors, { floorNo: 2, rank: 'lead', sprite: 'lead1', name: '하나' });
  assert.deepEqual([lead.sessionId, lead.agentKey, lead.view.model], ['s1', null, 'opus']);
  const staff = personOf(floors, { floorNo: 2, rank: 'staff', sprite: 'worker', name: '둘' });
  assert.deepEqual([staff.sessionId, staff.agentKey], ['s1', 'a1']);
  assert.equal(personOf(floors, { floorNo: 9, rank: 'lead', sprite: 'x', name: 'x' }), null);
  assert.equal(personOf(floors, { floorNo: 2, rank: 'cat', sprite: 'cat', name: '냥' }), null);
  assert.equal(personTokens(frame(), 's1', 'a1'), 3_000_000);
  assert.equal(personCostLine(frame(), C, 's1', 'a1'), `${C.title} 3.0M`);
  assert.equal(personCostLine(frame(), C, 's2', 'unknown'), `${C.title} ${C.empty}`, 'not in the top list: no figure');
  assert.equal(personCostLine(frame({ scanning: true }), C, 's1', null), `${C.title} ${C.scanning}`);
  assert.equal(personCostLine(null, C, 's1', null), `${C.title} ${C.empty}`);
});
