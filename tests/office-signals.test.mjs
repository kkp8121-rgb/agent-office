// Office signals of the 1.1 features: the call (bell) of a floor, work handed over between people, compaction and the usage-limit
// lunch break. All events are synthetic; floors are created at now = 1000, so an event stamped before that is backfill.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../server/config.mjs';
import { Office } from '../server/office.mjs';

const cfg = loadConfig();
const EMPTY = { hidden: [], names: {} };

const S = (id, o = {}) => ({
  provider: 'claude', pid: 100, sessionId: id, cwd: 'C:\\Project', status: 'busy', waitingPermission: false, name: '', startedAt: 1000, ...o,
});
const M = (id, o = {}) => ({
  agentId: id, agentType: 'worker', description: '기록 구조 조사', finished: false, transcriptPath: '', mtimeMs: 0, toolUseId: '', workflow: null, ...o,
});
const WF = (runId, phase) => ({ runId, phase, label: 'step' });
const tool = (ts, name, id, extra = {}) => ({ kind: 'tool', ts, toolUseId: id, name, text: name, ...extra });
const done = (ts, id) => ({ kind: 'toolDone', ts, toolUseId: id });
const think = (ts) => ({ kind: 'think', ts });
const limit = (ts, until, limitKind = 'five_hour') => ({ kind: 'limit', ts, until, limitKind });
const compact = (ts) => ({ kind: 'compact', ts, trigger: 'auto', durationMs: 5 });
const floorOf = (o, id) => o.snapshot().floors.find((f) => f.sessionId === id);
const keys = (o) => Object.keys(o).sort();
const ofType = (sigs, type) => sigs.filter((s) => s.type === type);
const GRACE = cfg.incident.rest.graceMs;
const MAX_REST = cfg.incident.rest.maxMs;

function setup(live = [S('s1')], now = 1000) {
  const o = new Office(cfg, EMPTY);
  o.syncSessions(live, now);
  return o;
}

// ---- bell --------------------------------------------------------------------------------------

test('sessions waiting gives call input', () => {
  const o = setup([S('s1', { status: 'waiting' })], 1000);
  const f = floorOf(o, 's1');
  assert.equal(f.status, 'waiting');
  assert.equal(f.call, 'input');
  assert.equal(f.callSince, 1000);
  assert.equal(floorOf(setup([S('s2', { status: 'busy', waitingPermission: true })]), 's2').call, null, 'busy is not a wait, whatever waitingFor said');
});

test('waitingPermission gives call permission', () => {
  const o = setup([S('s1', { status: 'waiting', waitingPermission: true })]);
  assert.equal(floorOf(o, 's1').call, 'permission');
  o.syncSessions([S('s1', { status: 'waiting', waitingPermission: false })], 2000); // the prompt went away, the session still waits
  const f = floorOf(o, 's1');
  assert.equal(f.call, 'input');
  assert.equal(f.callSince, 1000, 'the call goes on: its start is not reset by a change of kind');
});

test('idle gives call null and status waiting', () => {
  const f = floorOf(setup([S('s1', { status: 'idle' })]), 's1');
  assert.equal(f.status, 'waiting');
  assert.equal(f.call, null);
  assert.equal(f.callSince, null);
});

test('an open AskUserQuestion gives call ask', () => {
  const o = setup();
  o.applySessionEvents('s1', [tool(2000, 'AskUserQuestion', 'q1')], 2000);
  const f = floorOf(o, 's1');
  assert.equal(f.call, 'ask');
  assert.equal(f.callSince, 2000);
  o.applySessionEvents('s1', [tool(2100, 'Read', 'r1')], 2100); // a later event of the person means it was answered
  assert.equal(floorOf(o, 's1').call, null);
});

test('its toolDone clears the call', () => {
  const o = setup([S('s1', { status: 'waiting' })]);
  o.applySessionEvents('s1', [tool(2000, 'AskUserQuestion', 'q1')], 2000);
  assert.equal(floorOf(o, 's1').call, 'ask', 'ask outranks input');
  o.syncSessions([S('s1', { status: 'busy' })], 2050);
  assert.equal(floorOf(o, 's1').call, 'ask', 'a busy session file alone does not close a question that has no answer yet');
  o.applySessionEvents('s1', [done(2100, 'q1')], 2100);
  const f = floorOf(o, 's1');
  assert.equal(f.call, null);
  assert.equal(f.callSince, null);
});

test('a resting floor has no call', () => {
  const o = setup([S('s1', { status: 'waiting' })]);
  assert.equal(floorOf(o, 's1').call, 'input');
  o.applySessionEvents('s1', [limit(2000, 2000 + 3600000)], 2000);
  const f = floorOf(o, 's1');
  assert.deepEqual(f.rest, { until: 3602000, limitKind: 'five_hour' });
  assert.equal(f.call, null);
  assert.equal(f.callSince, null);
});

test('a hidden floor has no call', () => {
  const o = new Office(cfg, { hidden: [{ sessionId: 's1', pid: 100, startedAt: 1000 }], names: {} });
  o.syncSessions([S('s1', { status: 'waiting', waitingPermission: true })], 1000);
  o.applySessionEvents('s1', [tool(2000, 'AskUserQuestion', 'q1')], 2000);
  o.syncSessions([S('s1', { status: 'waiting', waitingPermission: true })], 3000);
  assert.deepEqual(o.snapshot().floors, []);
  assert.deepEqual(ofType(o.drainSignals(), 'bell'), []);
  // hiding a floor that is calling takes the call away without a signal
  const p = setup([S('p1', { status: 'idle' })]);
  p.syncSessions([S('p1', { status: 'waiting' })], 2000);
  assert.equal(ofType(p.drainSignals(), 'bell').length, 1);
  p.hide('p1');
  p.syncSessions([S('p1', { status: 'idle' })], 3000);
  p.syncSessions([S('p1', { status: 'waiting' })], 4000);
  assert.deepEqual(ofType(p.drainSignals(), 'bell'), []);
});

test('backfill gives no bell signal, live gives one', () => {
  const live = (s3) => [S('s1'), S('s2', { status: 'waiting' }), S('s4'), S('s3', { startedAt: 1500, ...s3 })];
  const o = setup([S('s1'), S('s2', { status: 'waiting' }), S('s4')], 1000);
  assert.deepEqual(o.drainSignals(), [], 'a floor met already waiting is shown, not announced');
  o.applySessionEvents('s1', [tool(500, 'AskUserQuestion', 'q0')], 1000); // stamped before the floor was found: backfill
  assert.equal(floorOf(o, 's1').call, 'ask');
  assert.deepEqual(o.drainSignals(), []);
  o.applySessionEvents('s4', [tool(2000, 'AskUserQuestion', 'q4')], 2000); // live
  o.syncSessions(live({}), 2500);
  o.syncSessions(live({ status: 'waiting', waitingPermission: true }), 3000);
  const bells = ofType(o.drainSignals(), 'bell');
  assert.deepEqual(bells.map((b) => [b.sessionId, b.callKind, b.at]), [['s4', 'ask', 2000], ['s3', 'permission', 3000]]);
  assert.deepEqual(keys(bells[0]), ['at', 'callKind', 'sessionId', 'type']);
});

// ---- handing work over -------------------------------------------------------------------------

test('a new agent arriving live gives one call handoff from the lead', () => {
  const o = setup();
  o.applySessionEvents('s1', [tool(1500, 'Agent', 'tu1')], 1500);
  o.syncAgents('s1', [M('a1', { toolUseId: 'tu1', mtimeMs: 2000 })], 2000);
  const sigs = ofType(o.drainSignals(), 'handoff');
  assert.equal(sigs.length, 1);
  assert.deepEqual(sigs[0], { type: 'handoff', sessionId: 's1', handoffKind: 'call', from: 'lead', to: 's1:a1', at: 2000 });
  o.syncAgents('s1', [M('a1', { toolUseId: 'tu1', mtimeMs: 2000 })], 2100); // already there: nothing again
  assert.deepEqual(o.drainSignals(), []);
});

test('an Agent tool_use made inside a sub-agent hands over from that agent', () => {
  const o = setup();
  o.syncAgents('s1', [M('a1', { toolUseId: 'tu1', mtimeMs: 2000 })], 2000);
  o.drainSignals();
  o.applyAgentEvents('s1', 'a1', [tool(2100, 'Agent', 'tu2')], 2100);
  o.syncAgents('s1', [M('a1', { toolUseId: 'tu1', mtimeMs: 2000 }), M('a2', { toolUseId: 'tu2', mtimeMs: 2200 }), M('a3', { toolUseId: 'tu-unknown', mtimeMs: 2200 })], 2200);
  const sigs = ofType(o.drainSignals(), 'handoff');
  assert.deepEqual(sigs.map((s) => [s.handoffKind, s.from, s.to]), [['call', 's1:a1', 's1:a2'], ['call', 'lead', 's1:a3']]);
});

test('a phase change gives a phase handoff, sent once at the arrival when its agent is not there yet', () => {
  const o = setup();
  const progress = (current) => o.setWorkflowProgress('s1', 'r1', { name: 'flow', phases: ['p1', 'p2', 'p3'], current });
  progress('p1');
  o.syncAgents('s1', [M('w1', { workflow: WF('r1', 'p1'), mtimeMs: 2000 })], 2000);
  o.syncAgents('s1', [M('w1', { workflow: WF('r1', 'p1'), mtimeMs: 2000, finished: true })], 2100); // w1 reports: the last one of phase p1
  assert.deepEqual(ofType(o.drainSignals(), 'handoff'), [], 'workflow agents arrive through phases, not as a call');
  progress('p2'); // nobody of p2 is on the floor yet
  assert.equal(ofType(o.drainSignals(), 'phase').length, 1);
  o.syncAgents('s1', [M('w1', { workflow: WF('r1', 'p1'), mtimeMs: 2000, finished: true }), M('w2', { workflow: WF('r1', 'p2'), mtimeMs: 2200 })], 2200);
  const sigs = ofType(o.drainSignals(), 'handoff');
  assert.deepEqual(sigs, [{ type: 'handoff', sessionId: 's1', handoffKind: 'phase', from: 's1:w1', to: 's1:w2', at: 2200 }]);
  o.syncAgents('s1', [M('w2', { workflow: WF('r1', 'p2'), mtimeMs: 2200 }), M('w3', { workflow: WF('r1', 'p2'), mtimeMs: 2300 })], 2300);
  assert.deepEqual(o.drainSignals(), [], 'only the first agent of the phase carries the handoff');
  o.syncAgents('s1', [M('w4', { workflow: WF('r1', 'p3'), mtimeMs: 2400 })], 2400);
  assert.deepEqual(o.drainSignals(), []);
  progress('p3'); // the agent of the new phase is already on the floor: the handoff goes at once
  const p3 = ofType(o.drainSignals(), 'handoff');
  assert.deepEqual(p3.map((s) => [s.handoffKind, s.from, s.to]), [['phase', 's1:w1', 's1:w4']]);
});

test('SendMessage to an agent of the floor names it, an unknown recipient gives null', () => {
  const o = setup();
  o.syncAgents('s1', [M('a1', { mtimeMs: 2000 }), M('a2', { mtimeMs: 2000 })], 2000);
  o.drainSignals();
  o.applySessionEvents('s1', [tool(2100, 'SendMessage', 'm1', { sendTo: 'a1' }), tool(2200, 'SendMessage', 'm2', { sendTo: 'stranger' })], 2200);
  o.applyAgentEvents('s1', 'a1', [tool(2300, 'SendMessage', 'm3', { sendTo: floorOf(o, 's1').agents[1].name })], 2300); // by name
  const sigs = ofType(o.drainSignals(), 'handoff');
  assert.deepEqual(sigs.map((s) => [s.handoffKind, s.from, s.to]), [['message', 'lead', 's1:a1'], ['message', 'lead', null], ['message', 's1:a1', 's1:a2']]);
  assert.deepEqual(keys(sigs[0]), ['at', 'from', 'handoffKind', 'sessionId', 'to', 'type']);
});

test('backfill gives no handoff', () => {
  const o = setup([S('s1')], 5000);
  o.applySessionEvents('s1', [tool(1000, 'Agent', 'tu1')], 5000);
  o.syncAgents('s1', [M('a1', { toolUseId: 'tu1', mtimeMs: 2000 })], 5000); // started before the floor was found
  o.applySessionEvents('s1', [tool(2500, 'SendMessage', 'm1', { sendTo: 'a1' })], 5000);
  assert.deepEqual(o.drainSignals(), []);
  assert.equal(floorOf(o, 's1').agents.length, 1);
});

test('a hidden floor gives no handoff', () => {
  const o = new Office(cfg, { hidden: [{ sessionId: 's1', pid: 100, startedAt: 1000 }], names: {} });
  o.syncSessions([S('s1')], 1000);
  o.syncAgents('s1', [M('a1', { mtimeMs: 2000 })], 2000);
  o.applySessionEvents('s1', [tool(2100, 'SendMessage', 'm1', { sendTo: 'a1' })], 2100);
  assert.deepEqual(o.drainSignals(), []);
});

// ---- compaction and the lunch break ------------------------------------------------------------

test('a live compact gives one signal naming the lead or the agent', () => {
  const o = setup();
  o.syncAgents('s1', [M('a1', { mtimeMs: 2000 })], 2000);
  o.drainSignals();
  o.applySessionEvents('s1', [compact(2100)], 2100);
  o.applyAgentEvents('s1', 'a1', [compact(2200)], 2200);
  o.applySessionEvents('s1', [compact(500)], 2300); // backfill
  const sigs = ofType(o.drainSignals(), 'compact');
  assert.deepEqual(sigs, [
    { type: 'compact', sessionId: 's1', agent: 'lead', at: 2100 },
    { type: 'compact', sessionId: 's1', agent: 's1:a1', at: 2200 },
  ]);
  assert.deepEqual(keys(sigs[0]), ['agent', 'at', 'sessionId', 'type']);
});

test('a live limit turns rest on, a later normal event turns it off', () => {
  const o = setup();
  const until = 2000 + 3600000;
  o.applySessionEvents('s1', [think(2000), limit(2000, until)], 2000); // the error line's own text is stamped the same
  assert.deepEqual(floorOf(o, 's1').rest, { until, limitKind: 'five_hour' });
  assert.deepEqual(keys(floorOf(o, 's1').rest), ['limitKind', 'until']);
  o.applySessionEvents('s1', [limit(2100, null, 'weekly-nonsense')], 2100);
  assert.deepEqual(floorOf(o, 's1').rest, { until: null, limitKind: 'other' }, 'an unknown kind folds to other');
  o.applySessionEvents('s1', [tool(2500, 'Bash', 'b1')], 2500);
  assert.equal(floorOf(o, 's1').rest, null);
});

test('rest ends at until plus graceMs on tick', () => {
  const o = setup();
  o.applySessionEvents('s1', [limit(2000, 10000)], 2000);
  assert.equal(o.tick(10000 + GRACE - 1), false);
  assert.notEqual(floorOf(o, 's1').rest, null);
  assert.equal(o.tick(10000 + GRACE), true);
  assert.equal(floorOf(o, 's1').rest, null);
});

test('rest without until ends at ts plus maxMs', () => {
  const o = setup();
  o.applySessionEvents('s1', [limit(2000, null)], 2000);
  o.tick(2000 + MAX_REST - 1);
  assert.deepEqual(floorOf(o, 's1').rest, { until: null, limitKind: 'five_hour' });
  o.tick(2000 + MAX_REST);
  assert.equal(floorOf(o, 's1').rest, null);
});

test('a limit in an agent file rests the whole floor', () => {
  const o = setup([S('s1', { status: 'waiting' })]);
  o.syncAgents('s1', [M('a1', { mtimeMs: 2000 })], 2000);
  o.applyAgentEvents('s1', 'a1', [limit(2100, 9000000, 'seven_day')], 2100);
  const f = floorOf(o, 's1');
  assert.deepEqual(f.rest, { until: 9000000, limitKind: 'seven_day' });
  assert.equal(f.call, null);
});

test('an old backfill limit is ignored', () => {
  const now = 30000000;
  const o = setup([S('s1')], now);
  o.applySessionEvents('s1', [limit(1000, null)], now); // older than rest.maxMs
  assert.equal(floorOf(o, 's1').rest, null);
  o.applySessionEvents('s1', [limit(now - 2000, now - GRACE - 1)], now); // its reset time is long past
  assert.equal(floorOf(o, 's1').rest, null);
  o.applySessionEvents('s1', [limit(now - 2000, now + 600000)], now); // a recent one found at start still counts
  assert.notEqual(floorOf(o, 's1').rest, null);
  assert.deepEqual(o.drainSignals(), [], 'rest is state, not a signal');
});

test('phase, handoff and compact signals stay quiet while resting', () => {
  const o = setup();
  const progress = (current) => o.setWorkflowProgress('s1', 'r1', { name: 'flow', phases: ['p1', 'p2'], current });
  progress('p1');
  o.syncAgents('s1', [M('w1', { workflow: WF('r1', 'p1'), mtimeMs: 2000 })], 2000);
  o.drainSignals();
  o.applySessionEvents('s1', [limit(2100, 9000000)], 2100);
  progress('p2');
  o.syncAgents('s1', [M('w1', { workflow: WF('r1', 'p1'), mtimeMs: 2000 }), M('w2', { workflow: WF('r1', 'p2'), mtimeMs: 2200 }), M('a9', { mtimeMs: 2200 })], 2200);
  o.applySessionEvents('s1', [compact(2300)], 2300);
  assert.deepEqual(o.drainSignals(), []);
});
