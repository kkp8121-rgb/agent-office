import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ringDecision, speakingOrder, planBell, onPhaseSignal } from '../web/bellmeeting.mjs';
import { cfg } from './helpers/fixture.mjs';

const BM = { ...cfg.ui.bellMeeting, sayMs: 2600, gapMs: 300, maxSpeakers: 7, cooldownMs: 20000 };
const LINES = { open: 'OPEN', idle: 'IDLE', close: 'CLOSE' };
const mk = (n) => [
  { id: 's3', isLead: false, spot: 3, bubble: 'c' },
  { id: 'lead', isLead: true, spot: 0, bubble: 'L' },
  { id: 's1', isLead: false, spot: 1, bubble: 'a' },
  { id: 's2', isLead: false, spot: 2, bubble: '' },
].slice(0, n);
const idle = { phaseActive: false, bellActive: false, lunch: false, offFloor: false, now: 100000, lastRingAt: null };

test('speaking order: lead first, then staff by spot number', () => {
  const { speakers } = speakingOrder(mk(4), 7);
  assert.deepEqual(speakers.map((p) => p.id), ['lead', 's1', 's2', 's3']);
});

test('maxSpeakers cut: the rest only gather', () => {
  const r = speakingOrder(mk(4), 2);
  assert.deepEqual(r.speakers.map((p) => p.id), ['lead', 's1']);
  assert.deepEqual(r.gatherOnly.map((p) => p.id), ['s2', 's3']);
});

test('empty bubble falls back to the idle line', () => {
  const p = planBell(mk(4), { bm: BM, effects: true, lines: LINES });
  assert.equal(p.slots.find((s) => s.id === 's2').text, 'IDLE');
  assert.equal(p.slots.find((s) => s.id === 's1').text, 'a');
});

test('during a phase meeting the bell is refused with a sign only, no wobble', () => {
  const r = ringDecision({ ...idle, phaseActive: true }, BM);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'phase');
  assert.equal(r.sign, BM.busyText);
  assert.equal(r.wobble, false);
});

test('phase signal during a bell meeting hands over to a phase meeting chaired by the lead', () => {
  const r = onPhaseSignal(true);
  assert.equal(r.endBell, true);
  assert.equal(r.chair, 'lead');
  assert.equal(r.ceoStepAside, true);
  assert.equal(onPhaseSignal(false).endBell, false);
});

test('lunch floor refuses with the rest sign only', () => {
  const r = ringDecision({ ...idle, lunch: true }, BM);
  assert.deepEqual([r.ok, r.reason, r.sign, r.wobble], [false, 'lunch', BM.restText, false]);
});

test('cooldown ignores a second ring inside cooldownMs', () => {
  assert.equal(ringDecision({ ...idle, lastRingAt: 100000 - BM.cooldownMs + 1 }, BM).reason, 'cooldown');
  assert.equal(ringDecision({ ...idle, lastRingAt: 100000 - BM.cooldownMs }, BM).ok, true);
});

test('schedule total = n*sayMs + (n-1)*gapMs + close', () => {
  const p = planBell(mk(4), { bm: BM, effects: true, lines: LINES });
  const n = 4;
  assert.equal(p.totalMs, n * BM.sayMs + (n - 1) * BM.gapMs + BM.gapMs + BM.sayMs);
  assert.equal(p.slots[n - 1].atMs + BM.sayMs + BM.gapMs, p.close.atMs);
});

test('effects off means no boss', () => {
  const off = planBell(mk(4), { bm: BM, effects: false, lines: LINES });
  assert.equal(off.chair, 'lead');
  assert.equal(off.open, null);
  const on = planBell(mk(4), { bm: BM, effects: true, lines: LINES });
  assert.equal(on.chair, 'ceo');
  assert.equal(on.open.text, 'OPEN');
});
