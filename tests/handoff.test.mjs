// Tests for handing work over (web/handoff.mjs rules, web/fx-handoff.mjs wiring with a fake context).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { flightFrames, planHandoff } from '../web/handoff.mjs';
import { init } from '../web/fx-handoff.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8'));
const cfg = config.ui.handoff;
const door = [500, 400];
const base = { kind: 'phase', fxOn: true, rest: false, meeting: false, planesInFlight: 0, cfg, from: [100, 200], to: [300, 250], door };

test('a meeting in progress delays the phase paper until it ends', () => {
  assert.equal(planHandoff({ ...base, meeting: true }).action, 'wait');
  const go = planHandoff(base);
  assert.equal(go.action, 'fly');
  assert.equal(go.ms, cfg.flyMs);
  assert.deepEqual([go.from, go.to], [base.from, base.to]);
  assert.equal(planHandoff({ ...base, kind: 'message', meeting: true }).action, 'fly', 'a message does not wait for a meeting');
});

test('a lunch-break floor gets no folder, no paper and no plane', () => {
  for (const kind of ['call', 'phase', 'message']) assert.equal(planHandoff({ ...base, kind, rest: true }).action, 'skip', kind);
});

test('at most planeMaxConcurrent planes fly on a floor, the rest are dropped', () => {
  const msg = { ...base, kind: 'message' };
  for (let n = 0; n < cfg.planeMaxConcurrent; n++) assert.equal(planHandoff({ ...msg, planesInFlight: n }).action, 'fly', `${n} in the air`);
  const over = planHandoff({ ...msg, planesInFlight: cfg.planeMaxConcurrent });
  assert.deepEqual([over.action, over.reason], ['skip', 'cap']);
  assert.equal(planHandoff({ ...msg, planesInFlight: 0 }).ms, cfg.planeMs);
});

test('a side that is not on screen uses the door position', () => {
  assert.deepEqual(planHandoff({ ...base, from: null }).from, door);
  assert.deepEqual(planHandoff({ ...base, kind: 'message', to: null }).to, door);
  assert.equal(planHandoff({ ...base, from: null, to: null }).action, 'skip');
  const frames = flightFrames(planHandoff({ ...base, from: null }));
  assert.equal(frames.length, 3);
  assert.ok(frames[0].transform.includes('500.0px, 400.0px'));
});

test('with the effects off nothing is planned', () => {
  for (const kind of ['call', 'phase', 'message']) assert.deepEqual(planHandoff({ ...base, kind, fxOn: false }), { action: 'skip', reason: 'fx' }, kind);
});

// ---- the area on a fake context ----

function fakeRec(x, y) {
  const classes = new Set();
  return { x, y, el: { classList: { contains: (c) => classes.has(c) } }, tagRoot: { children: [], append(e) { this.children.push(e); e.remove = () => { this.children.splice(this.children.indexOf(e), 1); }; } } };
}
function setup({ fxOn = true, rest = false, meeting = null } = {}) {
  const lead = fakeRec(100, 200);
  const worker = fakeRec(300, 250);
  const frec = { sid: 's1', agents: new Map([['lead', lead], ['w1', worker]]), layer: { children: [], append(e) { this.children.push(e); e.remove = () => { this.children.splice(this.children.indexOf(e), 1); }; } }, scene: { r: { door: { at: door } } }, meeting };
  let timerId = 0;
  const timers = new Map();
  const fxFns = new Map();
  const held = new Map();
  const state = { fxOn, rest, said: [], paused: false, changeFns: [] };
  const ctx = {
    ui: config.ui,
    fx: { fxOn: () => state.fxOn, onFx: (n, fn) => fxFns.set(n, fn), onFxChange: (fn) => state.changeFns.push(fn) },
    floor: (id) => (id === 's1' ? frec : null),
    floorActive: () => !state.paused,
    view: () => ({ rest: state.rest ? { until: null } : null }),
    onPauseChange: (fn) => (state.pauseFn = fn),
    onServer: (_t, fn) => (state.signal = fn),
    timers: { setTimeout: (fn, ms, floorId) => { timers.set(++timerId, { fn, ms, floorId }); return timerId; }, clearTimeout: (t) => timers.delete(t) },
    gesture: {
      acquire: (rec, kind) => (held.has(rec) ? null : (held.set(rec, kind), { rec, kind })),
      release: (tok) => tok && held.delete(tok.rec),
      onPreempt: () => {},
    },
    sayFor: (rec, text, ms) => state.said.push([rec, text, ms]),
    line: (sit) => `line:${sit}`,
  };
  const anims = [];
  const make = () => {
    const el = { className: '', style: {}, remove() {} };
    el.classList = { add: (c) => (el.className += ` ${c}`) };
    return el;
  };
  init(ctx, { make, animate: (el, frames, timing) => { const a = { el, frames, timing }; anims.push(a); return a; }, reduced: () => false });
  return { ctx, frec, lead, worker, timers, fxFns, held, state, anims };
}
const run = (t) => [...t.timers.entries()].forEach(([id, x]) => { t.timers.delete(id); x.fn(); });

test('a call: the caller shows a folder and says a line, the newcomer carries it and puts it on the desk when it arrives', () => {
  const t = setup();
  const newcomer = fakeRec(500, 400);
  t.frec.agents.set('w2', newcomer);
  newcomer.frec = t.frec;
  t.state.signal({ type: 'handoff', sessionId: 's1', handoffKind: 'call', from: 'lead', to: 'w2' });
  assert.equal(t.lead.tagRoot.children.length, 1, 'the caller holds the folder');
  assert.deepEqual(t.state.said.map((s) => [s[1], s[2]]), [['line:handoffGive', cfg.giveMs]]);
  assert.equal(newcomer.tagRoot.children.length, 1, 'the newcomer carries one');
  t.fxFns.get('walk-end')({ rec: newcomer });
  assert.ok(newcomer.tagRoot.children[0].className.includes('ho-desk'), 'on the desk');
  run(t);
  assert.equal(newcomer.tagRoot.children.length, 0);
  assert.equal(t.lead.tagRoot.children.length, 0);
  assert.equal(t.held.size, 0, 'every gesture is released');
});

test('a flight on a shown floor is drawn on its layer and ends with the animation; a paper for a meeting floor waits for meeting-end', () => {
  const t = setup({ meeting: {} });
  t.state.signal({ type: 'handoff', sessionId: 's1', handoffKind: 'phase', from: 'lead', to: 'w1' });
  run(t); // the one-tick look at the meeting
  assert.equal(t.anims.length, 0, 'waiting for the meeting');
  t.frec.meeting = null;
  t.fxFns.get('meeting-end')({ floor: t.frec });
  assert.equal(t.anims.length, 1);
  assert.equal(t.frec.layer.children.length, 1);
  t.anims[0].onfinish();
  assert.equal(t.frec.layer.children.length, 0);
});

test('effects off, a hidden page or a lunch floor builds nothing; going off tidies everything', () => {
  const off = setup({ fxOn: false });
  off.state.signal({ type: 'handoff', sessionId: 's1', handoffKind: 'message', from: 'lead', to: 'w1' });
  const lunch = setup({ rest: true });
  lunch.state.signal({ type: 'handoff', sessionId: 's1', handoffKind: 'call', from: 'lead', to: 'w1' });
  for (const t of [off, lunch]) assert.deepEqual([t.anims.length, t.lead.tagRoot.children.length, t.worker.tagRoot.children.length, t.held.size], [0, 0, 0, 0]);
  const t = setup();
  t.state.signal({ type: 'handoff', sessionId: 's1', handoffKind: 'message', from: 'lead', to: 'w1' });
  t.state.signal({ type: 'handoff', sessionId: 's1', handoffKind: 'call', from: 'lead', to: 'w1' });
  assert.equal(t.frec.layer.children.length, 1);
  t.state.changeFns[0]({ fx: false });
  assert.deepEqual([t.frec.layer.children.length, t.lead.tagRoot.children.length, t.worker.tagRoot.children.length, t.held.size], [0, 0, 0, 0]);
});
