// Tests of the meeting bell area (web/bell-floor.mjs) on a stand-in page and stand-in context: the button on a floor, a press that starts a bell
// meeting on the shared machine (the lead chairs, speakers in order, the lead closes), a refused press, and a floor that goes away.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { init } from '../web/bell-floor.mjs';
import { cfg } from './helpers/fixture.mjs';

class Node {
  constructor(tag) {
    Object.assign(this, { tag, children: [], style: {}, attrs: {}, listeners: {}, hidden: false, className: '', textContent: '', src: '' });
    this.classes = new Set();
  }
  get classList() { return { toggle: (c, on) => (on ? this.classes.add(c) : this.classes.delete(c)), contains: (c) => this.classes.has(c) }; }
  get firstChild() { return this.children[0]; }
  get lastChild() { return this.children.at(-1); }
  append(...kids) { this.children.push(...kids); }
  remove() { this.removed = true; }
  setAttribute(k, v) { this.attrs[k] = v; }
  getAttribute(k) { return this.attrs[k] ?? null; }
  addEventListener(type, fn) { this.listeners[type] = fn; }
  getAttr(k) { return k === 'src' ? this.src : undefined; }
}

const BM = { ...cfg.ui.bellMeeting, sayMs: 100, gapMs: 10, maxSpeakers: 7, cooldownMs: 1000 };

function setup({ rest = null, meeting = null, withStaff = true } = {}) {
  globalThis.document = { createElement: (tag) => new Node(tag) };
  let now = 1000;
  let nextTimer = 1;
  const timers = new Map();
  const said = [];
  const calls = { start: [], end: [] };
  const lead = { isLead: true, x: 0, y: 0, bubTxt: null };
  const staff = { isLead: false, x: 10, y: 0, bubTxt: { classList: { contains: () => false }, textContent: 'working on it' } };
  const frec = { sid: 's1', design: 'studio2', stage: new Node('div'), status: 'busy', off: false, agents: new Map(withStaff ? [['lead', lead], ['a1', staff]] : [['lead', lead]]), scene: { raw: { meeting: { spots: [{ at: [0, 0] }, { at: [10, 0] }] } } } };
  const hooks = { fx: {}, state: [] };
  let running = meeting;
  const ctx = {
    ui: { ...cfg.ui, bellMeeting: { ...BM, at: { studio2: [100, 50, 20] } } },
    fx: { onFx: (name, fn) => { hooks.fx[name] = fn; }, onFxChange: () => {} },
    timers: { setTimeout: (fn, ms) => { const t = nextTimer++; timers.set(t, { fn, at: now + ms }); return t; }, clearTimeout: (t) => timers.delete(t) },
    floors: () => [frec],
    floor: (id) => (id === 's1' ? frec : null),
    view: () => ({ floorNo: 3, rest }),
    floorActive: () => true,
    now: () => now,
    line: (key) => key.toUpperCase(),
    sayFor: (rec, text) => said.push([rec === lead ? 'lead' : 'a1', text]),
    onState: (fn) => hooks.state.push(fn),
    life: { members: () => (withStaff ? [lead, staff] : [lead]) },
    meeting: {
      active: () => running,
      start: (f, opts) => { calls.start.push(opts); running = 'bell'; return { members: new Set([lead, staff]), opts }; },
      end: () => { calls.end.push(1); running = null; opts().onEnd?.(); },
    },
  };
  const opts = () => calls.start.at(-1);
  const run = (ms) => { // moves the clock and fires the timers that fall due, in order
    const until = now + ms;
    for (;;) {
      const due = [...timers].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = Math.max(now, due[1].at);
      due[1].fn();
    }
    now = until;
  };
  init(ctx);
  const btn = frec.stage.children[0];
  return { ctx, frec, btn, said, calls, run, opts, hooks, lead, staff };
}

test('every floor with a bell place gets a button there, named after the floor, with the hanging bell picture on its cord', () => {
  const { btn } = setup();
  const { art } = BM;
  assert.equal(btn.className, 'mb-bell');
  assert.deepEqual([btn.style.left, btn.style.top], [`${100 - art.attachX * art.scale}px`, '50px'], 'the cord x is the bell attach column');
  assert.equal(btn.getAttribute('aria-label'), `${BM.label} 3`);
  assert.equal(btn.hidden, false);
  const [cord, img] = btn.children;
  assert.equal(img.src, '/assets/props/bell-hang.png');
  assert.equal(cord.className, 'mb-bell-cord');
  assert.equal(cord.style.height, '30px', 'the cord runs from the bell top (50) up to the ceiling (20)');
  assert.match(cord.style.backgroundImage, /bell-hang-cord\.png/);
});

test('a press starts a bell meeting on the shared machine and the bell rings', () => {
  const { btn, calls, opts } = setup();
  btn.listeners.click();
  assert.equal(calls.start.length, 1);
  assert.equal(opts().kind, 'bell');
  assert.equal('chair' in opts(), false, 'no boss comes down: the machine puts the lead in the chair itself');
  assert.equal(btn.children[1].src, '/assets/props/bell-hang-ring.png');
});

test('onHold plans one line per speaker (the lead first, an empty bubble says the idle line) and the lead closes', () => {
  const { btn, calls, said, run, lead, staff } = setup();
  btn.listeners.click();
  calls.start[0].onHold({ members: new Set([lead, staff]) });
  run(BM.sayMs * 5);
  assert.deepEqual(said, [['lead', 'BELLMEETINGIDLE'], ['a1', 'working on it'], ['lead', 'BELLMEETINGCLOSE']]);
  assert.equal(calls.end.length, 1, 'the area ends the meeting when the plan is over');
  assert.equal(btn.children[1].src, '/assets/props/bell-hang.png');
});

test('a press while the floor is at lunch only shows the rest sign', () => {
  const { btn, calls, run } = setup({ rest: { until: 1, limitKind: 'five_hour' } });
  btn.listeners.click();
  assert.equal(calls.start.length, 0);
  assert.equal(btn.lastChild.hidden, false);
  assert.equal(btn.lastChild.textContent, BM.restText);
  run(BM.sayMs + 1);
  assert.equal(btn.lastChild.hidden, true, 'the sign goes by itself');
});

test('a lead alone on the floor: the press starts nothing, shows the alone sign, and the bell is dimmed', () => {
  const { btn, calls, run } = setup({ withStaff: false });
  assert.equal(btn.classList.contains('mb-bell-alone'), true);
  btn.listeners.click();
  assert.equal(calls.start.length, 0);
  assert.equal(btn.children.at(-1).hidden, false);
  assert.equal(btn.children.at(-1).textContent, BM.aloneText);
  run(BM.sayMs + 1);
  assert.equal(btn.children.at(-1).hidden, true, 'the sign goes by itself');
  const withStaff = setup();
  assert.equal(withStaff.btn.classList.contains('mb-bell-alone'), false);
});

test('a press during a workflow phase meeting shows the busy sign, and a second press inside the cooldown is ignored', () => {
  const busy = setup({ meeting: 'phase' });
  busy.btn.listeners.click();
  assert.equal(busy.calls.start.length, 0);
  assert.equal(busy.btn.lastChild.textContent, BM.busyText);
  const { ctx, btn, calls, run } = setup();
  btn.listeners.click();
  ctx.meeting.end();
  btn.listeners.click();
  assert.equal(calls.start.length, 1, 'inside cooldownMs');
  run(BM.cooldownMs);
  btn.listeners.click();
  assert.equal(calls.start.length, 2);
});

test('a workflow phase taking the meeting over, or the floor going away, drops the timers and the ringing picture', () => {
  const { btn, calls, said, run, lead, staff, hooks, frec } = setup();
  btn.listeners.click();
  calls.start[0].onHold({ members: new Set([lead, staff]) });
  calls.start[0].onSwitch();
  run(BM.sayMs * 5);
  assert.deepEqual(said, [], 'nothing is said after the takeover');
  assert.equal(btn.children[1].src, '/assets/props/bell-hang.png');
  hooks.fx['floor-hidden']({ floor: frec, removed: true });
  assert.equal(btn.removed, true);
});
