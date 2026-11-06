// What Office knows about each person and floor in 1.1: same-file conflicts, model badges, paper pile, hourglass.
// All events are synthetic; floors are created at now = 1000, so an event stamped before that is backfill.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadConfig } from '../server/config.mjs';
import { Office } from '../server/office.mjs';

const cfg = loadConfig();
const EMPTY = { hidden: [], names: {} };

const S = (id, o = {}) => ({
  provider: 'claude', pid: 100, sessionId: id, cwd: 'C:\\Project', status: 'busy', name: '', startedAt: 1000, ...o,
});
const M = (id, o = {}) => ({
  agentId: id, agentType: 'worker', description: '기록 구조 조사', finished: false, transcriptPath: '', mtimeMs: 0, toolUseId: '', workflow: null, ...o,
});
const tool = (ts, name, id, extra = {}) => ({ kind: 'tool', ts, toolUseId: id, name, text: name, ...extra });
const edit = (ts, fileKey) => tool(ts, 'Edit', `e${ts}`, { fileKey });
const done = (ts, id) => ({ kind: 'toolDone', ts, toolUseId: id });
const ctx = (ts, ctxTokens, model = 'opus', window = null) => ({ kind: 'ctx', ts, ctxTokens, window, model });
const floorOf = (o, id) => o.snapshot().floors.find((f) => f.sessionId === id);
const frame = (o) => JSON.stringify(o.snapshot().floors); // what a state frame carries (its `now` moves with every tick)
const ofType = (sigs, type) => sigs.filter((s) => s.type === type);
const AFTER = cfg.hourglass.afterMs;
const MAX = cfg.hourglass.maxMs;

function setup(live = [S('s1')], now = 1000) {
  const o = new Office(cfg, EMPTY);
  o.syncSessions(live, now);
  return o;
}

// ---- conflict ----------------------------------------------------------------------------------

const KEY_A = 'f00dfacefeedbeefdeadbabe';

test('two floors in the window: both views carry the same conflict id', () => {
  const o = setup([S('s1'), S('s2')]);
  o.syncAgents('s2', [M('a1', { mtimeMs: 1500 })], 1500);
  o.drainSignals();
  o.applySessionEvents('s1', [edit(2000, KEY_A)], 2000);
  o.applyAgentEvents('s2', 'a1', [edit(2100, KEY_A)], 2100);
  o.tick(2200);
  const f1 = floorOf(o, 's1');
  const f2 = floorOf(o, 's2');
  assert.deepEqual(f1.conflicts, [{ id: 'c1', with: ['s2'], since: 2100 }]);
  assert.deepEqual(f2.conflicts, [{ id: 'c1', with: ['s1'], since: 2100 }]);
  assert.equal(f1.lead.conflict, 'c1');
  assert.equal(f2.lead.conflict, null, 'only the person who made the last edit of the file on that floor');
  assert.equal(f2.agents[0].conflict, 'c1');
  const sigs = o.drainSignals();
  assert.deepEqual(sigs, [{ type: 'conflict', id: 'c1', sessionIds: ['s1', 's2'], at: 2200 }]);
  assert.ok(!JSON.stringify([o.snapshot(), sigs]).includes(KEY_A), 'the file key never leaves the office');
});

test('a hidden floor is left out', () => {
  const o = setup([S('s1'), S('s2'), S('s3')]);
  assert.equal(o.hide('s3'), true);
  o.applySessionEvents('s1', [edit(2000, KEY_A)], 2000);
  o.applySessionEvents('s3', [edit(2050, KEY_A)], 2050); // a hidden floor takes no part
  o.tick(2060);
  assert.deepEqual(floorOf(o, 's1').conflicts, []);
  o.applySessionEvents('s2', [edit(2100, KEY_A)], 2100);
  o.tick(2200);
  assert.deepEqual(floorOf(o, 's1').conflicts[0].with, ['s2']);
  assert.equal(floorOf(o, 's3'), undefined);
  assert.deepEqual(ofType(o.drainSignals(), 'conflict').map((s) => s.sessionIds), [['s1', 's2']]);
  o.hide('s2'); // hiding a floor takes its edits away at once
  o.tick(2300);
  assert.deepEqual(floorOf(o, 's1').conflicts, []);
});

test('a leaving floor is released', () => {
  const o = setup([S('s1'), S('s2')]);
  o.applySessionEvents('s1', [edit(2000, KEY_A)], 2000);
  o.applySessionEvents('s2', [edit(2100, KEY_A)], 2100);
  o.tick(2200);
  assert.equal(floorOf(o, 's1').conflicts.length, 1);
  o.drainSignals();
  o.syncSessions([S('s1')], 2300); // s2 ends
  assert.equal(o.tick(2400), true, 'the conflict going away is a change');
  assert.equal(floorOf(o, 's2').status, 'leaving');
  assert.deepEqual(floorOf(o, 's2').conflicts, []);
  assert.deepEqual(floorOf(o, 's1').conflicts, []);
  assert.equal(floorOf(o, 's1').lead.conflict, null);
  assert.deepEqual(o.drainSignals(), []);
});

test('live gives one conflict signal, backfill none', () => {
  const now = 100000;
  const o = setup([S('s1'), S('s2')], now);
  o.applySessionEvents('s1', [edit(90000, KEY_A)], now);
  o.applySessionEvents('s2', [edit(91000, KEY_A)], now); // both found in the log at start
  o.tick(now + 100);
  assert.equal(floorOf(o, 's1').conflicts.length, 1, 'shown');
  assert.deepEqual(o.drainSignals(), [], 'but not announced');
  o.applySessionEvents('s1', [edit(100200, 'b0b0b0b0b0b0b0b0b0b0b0b0')], now + 200);
  o.applySessionEvents('s2', [edit(100300, 'b0b0b0b0b0b0b0b0b0b0b0b0')], now + 300);
  o.tick(now + 400);
  assert.equal(floorOf(o, 's1').conflicts.length, 2);
  assert.deepEqual(o.drainSignals(), [{ type: 'conflict', id: 'c2', sessionIds: ['s1', 's2'], at: now + 400 }]);
});

// ---- model -------------------------------------------------------------------------------------

test("a worker file's model is on that worker only", () => {
  const o = setup();
  o.syncAgents('s1', [M('a1', { mtimeMs: 2000 })], 2000);
  o.applyAgentEvents('s1', 'a1', [ctx(2100, 1000, 'haiku')], 2100);
  let f = floorOf(o, 's1');
  assert.equal(f.agents[0].model, 'haiku');
  assert.equal(f.lead.model, null);
  o.applySessionEvents('s1', [ctx(2200, 1000, 'sonnet')], 2200);
  f = floorOf(o, 's1');
  assert.equal(f.lead.model, 'sonnet');
  assert.equal(f.agents[0].model, 'haiku');
  assert.deepEqual(Object.keys(f.lead).sort(), ['bubble', 'conflict', 'model', 'name', 'pile', 'role', 'slowKind', 'slowSince', 'sprite', 'state']);
  assert.deepEqual(Object.keys(f).sort(), ['agents', 'autoTitle', 'board', 'colorIndex', 'conflicts', 'design', 'failAt', 'floorNo', 'folder', 'lead', 'origin', 'phases', 'provider', 'reports', 'rest', 'sessionId', 'sheet', 'startedAt', 'status', 'title', 'todos', 'workflows']);
  assert.ok(Object.keys(f.agents[0]).includes('phase'));
});

test("every Codex person is codex", () => {
  const o = setup([S('c1', { provider: 'codex', pid: 0 })]);
  o.syncAgents('c1', [M('a1', { mtimeMs: 2000 })], 2000);
  let f = floorOf(o, 'c1');
  assert.equal(f.lead.model, 'codex', 'before any event');
  assert.equal(f.agents[0].model, 'codex');
  o.applySessionEvents('c1', [ctx(2100, 1000, null, 100000)], 2100); // Codex events name no model
  f = floorOf(o, 'c1');
  assert.equal(f.lead.model, 'codex');
  assert.equal(f.agents[0].model, 'codex');
});

test('unknown is null', () => {
  const o = setup();
  o.syncAgents('s1', [M('a1', { mtimeMs: 2000 })], 2000);
  let f = floorOf(o, 's1');
  assert.equal(f.lead.model, null);
  assert.equal(f.agents[0].model, null);
  o.applySessionEvents('s1', [ctx(2100, 1000, null), ctx(2200, 1000, 'claude-opus-5-5')], 2200); // a raw id is not a family
  assert.equal(floorOf(o, 's1').lead.model, null);
  o.applySessionEvents('s1', [ctx(2300, 1000, 'other')], 2300);
  assert.equal(floorOf(o, 's1').lead.model, 'other');
});

// ---- paper pile --------------------------------------------------------------------------------

test('four threshold edges', () => {
  const o = setup();
  const levels = [[39999, 0], [40000, 1], [79999, 1], [80000, 2], [119999, 2], [120000, 3], [143999, 3], [144000, 4], [199999, 4]];
  levels.forEach(([tokens, want], i) => {
    o.applySessionEvents('s1', [ctx(2000 + i, tokens)], 2000 + i);
    assert.equal(floorOf(o, 's1').lead.pile, want, `${tokens} tokens`);
  });
});

test('an observation over the window switches to largeWindow', () => {
  const o = setup();
  o.syncAgents('s1', [M('a1', { mtimeMs: 2000 })], 2000);
  o.applySessionEvents('s1', [ctx(2100, 250000)], 2100); // more than the 200k an opus window holds
  assert.equal(floorOf(o, 's1').lead.pile, 1, '250k of a 1M window');
  o.applySessionEvents('s1', [ctx(2200, 150000)], 2200);
  assert.equal(floorOf(o, 's1').lead.pile, 0, 'it stays on the large window');
  o.applyAgentEvents('s1', 'a1', [ctx(2300, 150000)], 2300);
  assert.equal(floorOf(o, 's1').agents[0].pile, 4, 'another person is not switched');
});

test('Codex uses its own window', () => {
  const o = setup([S('c1', { provider: 'codex', pid: 0 })]);
  o.applySessionEvents('c1', [ctx(2000, 50000, null, 100000)], 2000);
  assert.equal(floorOf(o, 'c1').lead.pile, 2);
  o.applySessionEvents('c1', [ctx(2100, 80000, null, 100000)], 2100);
  assert.equal(floorOf(o, 'c1').lead.pile, 4);
  o.applySessionEvents('c1', [ctx(2200, 80000, null, null)], 2200); // no window said: the default one
  assert.equal(floorOf(o, 'c1').lead.pile, 2);
});

test('compact resets the pile to 0', () => {
  const o = setup();
  o.applySessionEvents('s1', [ctx(2000, 150000)], 2000);
  assert.equal(floorOf(o, 's1').lead.pile, 4);
  o.applySessionEvents('s1', [{ kind: 'compact', ts: 2100, trigger: 'auto', durationMs: 3 }], 2100);
  assert.equal(floorOf(o, 's1').lead.pile, 0);
  o.applySessionEvents('s1', [ctx(2200, 50000)], 2200);
  assert.equal(floorOf(o, 's1').lead.pile, 1, 'the next call fills it from the real length');
});

test('the same level leaves the snapshot string unchanged', () => {
  const o = setup();
  o.applySessionEvents('s1', [ctx(2000, 41000)], 2000);
  const a = frame(o);
  o.applySessionEvents('s1', [ctx(2100, 47000)], 2000);
  assert.equal(frame(o), a, 'tokens are not in the view, only the level');
  o.applySessionEvents('s1', [ctx(2200, 81000)], 2000);
  assert.notEqual(frame(o), a);
});

// ---- hourglass ---------------------------------------------------------------------------------

const slowOf = (o, id = 's1') => {
  const l = floorOf(o, id).lead;
  return [l.slowSince, l.slowKind];
};

test('nothing before afterMs', () => {
  const o = setup();
  o.applySessionEvents('s1', [tool(2000, 'Bash', 'b1')], 2000);
  o.tick(2000 + AFTER - 1);
  assert.deepEqual(slowOf(o), [null, null]);
});

test('after afterMs a tick gives slowSince and slowKind', () => {
  const kindOf = (name) => {
    const o = setup();
    o.applySessionEvents('s1', [tool(2000, name, 'x1')], 2000);
    o.tick(2000 + AFTER);
    return slowOf(o);
  };
  assert.deepEqual(kindOf('Bash'), [2000, 'cmd']);
  assert.deepEqual(kindOf('WebFetch'), [2000, 'web']);
  assert.deepEqual(kindOf('mcp__srv__call'), [2000, 'mcp']);
  assert.deepEqual(kindOf('Grep'), [2000, 'other']);
  assert.deepEqual(kindOf('constructor'), [2000, 'other'], 'a name from the object prototype is not a kind');
});

test('toolDone clears it', () => {
  const o = setup();
  o.applySessionEvents('s1', [tool(2000, 'Bash', 'b1')], 2000);
  o.tick(2000 + AFTER);
  assert.deepEqual(slowOf(o), [2000, 'cmd']);
  o.applySessionEvents('s1', [done(2000 + AFTER + 500, 'b1')], 2000 + AFTER + 500);
  assert.deepEqual(slowOf(o), [null, null]);
});

test('ignoreTools never open an hourglass', () => {
  const o = setup();
  assert.ok(['Agent', 'AskUserQuestion', 'wait'].every((n) => cfg.hourglass.ignoreTools.includes(n)));
  o.applySessionEvents('s1', cfg.hourglass.ignoreTools.map((name, i) => tool(2000, name, `i${i}`)), 2000);
  o.tick(2000 + AFTER + 1);
  assert.deepEqual(slowOf(o), [null, null]);
});

test('of two parallel tools the older counts', () => {
  const o = setup();
  o.applySessionEvents('s1', [tool(2000, 'Bash', 'b1'), tool(2500, 'WebFetch', 'b2')], 2500);
  o.tick(2500 + AFTER);
  assert.deepEqual(slowOf(o), [2000, 'cmd']);
  o.applySessionEvents('s1', [done(2500 + AFTER + 1, 'b1')], 2500 + AFTER + 1);
  o.tick(2500 + AFTER + 2);
  assert.deepEqual(slowOf(o), [2500, 'web']);
});

test('end clears it', () => {
  const o = setup();
  o.applySessionEvents('s1', [tool(2000, 'Bash', 'b1')], 2000);
  o.tick(2000 + AFTER);
  o.applySessionEvents('s1', [{ kind: 'end', ts: 2000 + AFTER + 1 }], 2000 + AFTER + 1);
  assert.deepEqual(slowOf(o), [null, null]);
  o.syncAgents('s1', [M('a1', { mtimeMs: 3000 })], 3000);
  o.applyAgentEvents('s1', 'a1', [tool(3000, 'Bash', 'ab')], 3000);
  o.tick(3000 + AFTER);
  assert.deepEqual(floorOf(o, 's1').agents[0].slowSince, 3000);
  o.syncAgents('s1', [M('a1', { mtimeMs: 3000, finished: true })], 3000 + AFTER + 1);
  assert.equal(floorOf(o, 's1').agents[0].slowSince, null, 'an agent that reported has no hourglass');
});

test('maxMs gives null', () => {
  const o = setup();
  o.applySessionEvents('s1', [tool(2000, 'Bash', 'b1')], 2000);
  o.tick(2000 + MAX);
  assert.deepEqual(slowOf(o), [2000, 'cmd']);
  o.tick(2000 + MAX + 1); // a record that was cut off
  assert.deepEqual(slowOf(o), [null, null]);
});

test('the same hourglass leaves the snapshot string unchanged', () => {
  const o = setup();
  o.applySessionEvents('s1', [tool(2000, 'Bash', 'b1')], 2000);
  o.tick(2000 + AFTER);
  const a = frame(o);
  o.tick(2000 + AFTER + 5000);
  o.tick(2000 + AFTER + 60000);
  assert.equal(frame(o), a, 'the elapsed time is not in the view, the page counts it');
});

// ---- the whole --------------------------------------------------------------------------------

test('two ticks with the same input give the same snapshot string', () => {
  const o = setup([S('s1', { status: 'waiting' }), S('s2'), S('c1', { provider: 'codex', pid: 0 })]);
  o.syncAgents('s1', [M('a1', { mtimeMs: 2000 })], 2000);
  o.applySessionEvents('s1', [edit(2000, KEY_A), done(2005, 'e2000'), ctx(2010, 150000), tool(2020, 'Bash', 'b1')], 2020);
  o.applySessionEvents('s2', [edit(2100, KEY_A), { kind: 'limit', ts: 2110, until: 9000000, limitKind: 'seven_day' }], 2110);
  o.applySessionEvents('c1', [ctx(2120, 50000, null, 100000)], 2120);
  const now = 2020 + AFTER + 1000;
  o.tick(now);
  const first = frame(o);
  o.tick(now);
  assert.equal(frame(o), first);
  assert.ok(first.includes('"slowSince":2020') && first.includes('"conflicts":[{"id":"c1"') && first.includes('"pile":4') && first.includes('"limitKind":"seven_day"'), 'the state is really in it');
  for (const name of ['office.mjs', 'conflict.mjs']) { // pure modules: no clock, file or timer
    const code = readFileSync(new URL(`../server/${name}`, import.meta.url), 'utf8').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    assert.ok(!/Date\.now|setTimeout|setInterval|node:fs|from 'fs'/.test(code), name);
  }
});
