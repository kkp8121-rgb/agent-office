import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../server/config.mjs';
import { Office } from '../server/office.mjs';
import { FIXTURE_SCENES } from './helpers/fixture.mjs';

// The studio2 fixture floor has 4 seats, then 6 idle spots, then overflow points.
const cfg = loadConfig({ scenesDir: FIXTURE_SCENES, designOrder: ['studio2'] });
const EMPTY = { hidden: [], names: {} };
const S = (id, o = {}) => ({ provider: 'claude', pid: 100, sessionId: id, cwd: 'C:\\Project', status: 'busy', name: '', startedAt: 1000, ...o });
const M = (id, o = {}) => ({ agentId: id, agentType: 'worker', description: 'x', finished: false, transcriptPath: '', mtimeMs: 0, workflow: null, ...o });
const tool = (ts, text) => ({ kind: 'tool', ts, toolUseId: `t${ts}`, name: 'Bash', text });

const metas = (n) => Array.from({ length: n }, (_, i) => M(`a${i}`));
const agentsOf = (o) => o.snapshot().floors.find((f) => f.sessionId === 's1').agents;
const slotOf = (o, id) => agentsOf(o).find((a) => a.agentId === id).slot;
const used = (o) => o.floors.get('s1').usedSlots;

function setup(n) {
  const o = new Office(cfg, EMPTY);
  o.syncSessions([S('s1')], 1000);
  o.syncAgents('s1', metas(n), 1000);
  return o;
}
/** `ids` report done at `now` and leave their slots once the linger is over. */
function finish(o, all, ids, now) {
  o.syncAgents('s1', all.map((m) => (ids.includes(m.agentId) ? { ...m, finished: true } : m)), now);
  o.tick(now + cfg.agent.doneLingerMs);
}
function assertSlotsConsistent(o) {
  const idx = agentsOf(o).map((a) => a.slot.i);
  assert.equal(new Set(idx).size, idx.length, 'no two agents share a slot index');
  assert.deepEqual([...used(o)].sort((a, b) => a - b), [...idx].sort((a, b) => a - b), 'usedSlots matches the live agents exactly');
}

test('reseat: a freed desk goes to the longest-waiting agent and its old index is released', () => {
  const o = setup(6); // a0-a3 seated, a4 on idle 0, a5 on idle 1
  assert.equal(slotOf(o, 'a4').kind, 'idle');
  const before = Object.keys(slotOf(o, 'a4')).sort();
  finish(o, metas(6), ['a1'], 2000);
  const s = slotOf(o, 'a4');
  assert.deepEqual([s.kind, s.i, s.ref], ['seat', 1, '1']);
  assert.deepEqual(Object.keys(s).sort(), before, 'slot object keeps its shape');
  assert.ok(s.approach && s.sit, 'a seat slot carries approach and sit');
  assert.equal(slotOf(o, 'a5').i, 5, 'later waiter stays put');
  assert.equal(used(o).has(4), false, 'old idle index is free again');
  assertSlotsConsistent(o);
  o.syncAgents('s1', [...metas(6).filter((m) => m.agentId !== 'a1'), M('late')], 30000);
  assert.equal(slotOf(o, 'late').i, 4, 'the released index is reused by the next newcomer');
  assertSlotsConsistent(o);
});

test('reseat: a waiter that is done is never reseated', () => {
  const o = setup(6);
  const all = metas(6);
  o.syncAgents('s1', all.map((m) => (m.agentId === 'a4' ? { ...m, finished: true } : m)), 1500); // a4 done while standing, still lingering
  o.syncAgents('s1', all.map((m) => ({ ...m, finished: m.agentId === 'a4' || m.agentId === 'a0' })), 1600);
  o.tick(1500 + cfg.agent.doneLingerMs - 1); // nobody has lingered long enough yet
  assert.equal(slotOf(o, 'a4').kind, 'idle', 'a4 is done: it keeps its standing slot');
  o.tick(1600 + cfg.agent.doneLingerMs); // a0 and a4 both leave now: done a4 must not take a0's desk
  assert.equal(agentsOf(o).some((a) => a.agentId === 'a4'), false);
  assert.deepEqual([slotOf(o, 'a5').kind, slotOf(o, 'a5').i], ['seat', 0], 'the working waiter takes the desk of a0');
  assertSlotsConsistent(o);
});

test('reseat: a done agent that lingers on a desk frees nothing until it leaves', () => {
  const o = setup(5);
  const all = metas(5);
  o.syncAgents('s1', all.map((m) => (m.agentId === 'a0' ? { ...m, finished: true } : m)), 2000);
  assert.equal(slotOf(o, 'a4').kind, 'idle', 'the desk is still taken while a0 walks to the tray');
  o.tick(2000 + cfg.agent.doneLingerMs);
  assert.deepEqual([slotOf(o, 'a4').kind, slotOf(o, 'a4').i], ['seat', 0]);
});

test('reseat: a stale waiter is skipped and takes a desk only after it works again', () => {
  const o = setup(6);
  const t = 1000 + cfg.agent.staleMs;
  o.applyAgentEvents('s1', 'a5', [tool(t - 1, 'x')], t - 1);
  o.tick(t); // a4 has been silent for staleMs, a5 just spoke
  assert.equal(agentsOf(o).find((a) => a.agentId === 'a4').state, 'stale');
  finish(o, metas(6), ['a0'], t + 1);
  assert.equal(slotOf(o, 'a5').kind, 'seat', 'the working waiter gets the desk over the earlier but stale one');
  assert.equal(slotOf(o, 'a4').kind, 'idle');
  finish(o, metas(6), ['a0', 'a1'], t + 10000);
  assert.equal(slotOf(o, 'a4').kind, 'idle', 'still stale: still no desk');
  o.applyAgentEvents('s1', 'a4', [tool(t + 20000, 'back')], t + 20000); // it works again while a desk is free
  assert.deepEqual([slotOf(o, 'a4').kind, slotOf(o, 'a4').i], ['seat', 1]);
  assertSlotsConsistent(o);
});

test('reseat: two freed desks go to the two longest-waiting agents, lowest desk first', () => {
  const o = setup(8); // a0-a3 seated; a4..a7 standing on indices 4..7
  finish(o, metas(8), ['a0', 'a2'], 2000);
  assert.deepEqual([slotOf(o, 'a4').kind, slotOf(o, 'a4').i], ['seat', 0]);
  assert.deepEqual([slotOf(o, 'a5').kind, slotOf(o, 'a5').i], ['seat', 2]);
  assert.equal(slotOf(o, 'a6').i, 6);
  assert.equal(slotOf(o, 'a7').i, 7);
  assert.deepEqual([...used(o)].sort((a, b) => a - b), [0, 1, 2, 3, 6, 7]);
  assertSlotsConsistent(o);
});

test('reseat: more freed desks than waiters leaves the rest of the desks free for newcomers', () => {
  const o = setup(5);
  finish(o, metas(5), ['a0', 'a1', 'a2'], 2000);
  assert.deepEqual([slotOf(o, 'a4').kind, slotOf(o, 'a4').i], ['seat', 0]);
  o.syncAgents('s1', [...metas(5).slice(3), M('late')], 30000);
  assert.deepEqual([slotOf(o, 'late').kind, slotOf(o, 'late').i], ['seat', 1]);
});

for (const lateFirst of [false, true]) {
  test(`reseat: a desk freed in the same sync as a newcomer goes to the waiter (newcomer ${lateFirst ? 'before' : 'after'} in the list)`, () => {
    const o = setup(5); // a4 waits on index 4
    const all = metas(5).map((m) => (m.agentId === 'a0' ? { ...m, abandoned: true } : m));
    o.syncAgents('s1', lateFirst ? [M('late'), ...all] : [...all, M('late')], 2000);
    assert.deepEqual([slotOf(o, 'a4').kind, slotOf(o, 'a4').i], ['seat', 0], 'the waiter gets the desk');
    assert.deepEqual([slotOf(o, 'late').kind, slotOf(o, 'late').i], ['idle', 4], 'the newcomer gets the next free slot');
    assertSlotsConsistent(o);
  });
}

test('reseat: a floor with no waiting agents is untouched when a desk frees', () => {
  const o = setup(3);
  const before = slotOf(o, 'a1');
  finish(o, metas(3), ['a0'], 2000);
  assert.deepEqual(slotOf(o, 'a1'), before);
  assertSlotsConsistent(o);
});

for (const abandonedFirst of [true, false]) {
  test(`reseat: a waiter that finishes in the same sync as a desk is freed never takes it (abandoned ${abandonedFirst ? 'before' : 'after'} the finisher in the list)`, () => {
    const o = setup(6); // a0-a3 seated, a4 on idle 0, a5 on idle 1
    const gone = { ...M('a0'), abandoned: true };
    const done = { ...M('a4'), finished: true };
    const rest = [M('a1'), M('a2'), M('a3'), M('a5')];
    o.syncAgents('s1', abandonedFirst ? [gone, done, ...rest] : [done, gone, ...rest], 2000);
    assert.equal(agentsOf(o).find((a) => a.agentId === 'a4').state, 'done');
    assert.equal(slotOf(o, 'a4').kind, 'idle', 'the done agent keeps its standing slot');
    assert.deepEqual([slotOf(o, 'a5').kind, slotOf(o, 'a5').i], ['seat', 0], 'the agent that still waits gets the desk');
    assertSlotsConsistent(o);
  });
}
