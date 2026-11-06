import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ringDecision, speakingOrder, planBell, nearestSpot, onPhaseSignal } from '../web/bellmeeting.mjs';
import { cfg } from './helpers/fixture.mjs';

const BM = { ...cfg.ui.bellMeeting, sayMs: 2600, gapMs: 300, maxSpeakers: 7, cooldownMs: 20000 };
const LINES = { idle: 'IDLE', close: 'CLOSE' };
const mk = (n) => [
  { id: 's3', isLead: false, spot: 3, bubble: 'c' },
  { id: 'lead', isLead: true, spot: 0, bubble: 'L' },
  { id: 's1', isLead: false, spot: 1, bubble: 'a' },
  { id: 's2', isLead: false, spot: 2, bubble: '' },
].slice(0, n);
const idle = { phaseActive: false, bellActive: false, lunch: false, alone: false, offFloor: false, now: 100000, lastRingAt: null };

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
  const p = planBell(mk(4), { bm: BM, lines: LINES });
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
  assert.equal(onPhaseSignal(false).endBell, false);
});

test('lunch floor refuses with the rest sign only', () => {
  const r = ringDecision({ ...idle, lunch: true }, BM);
  assert.deepEqual([r.ok, r.reason, r.sign, r.wobble], [false, 'lunch', BM.restText, false]);
});

test('a lead alone on the floor starts no meeting: refused with the alone sign only', () => {
  const r = ringDecision({ ...idle, alone: true }, BM);
  assert.deepEqual([r.ok, r.reason, r.sign, r.wobble], [false, 'alone', BM.aloneText, false]);
  assert.ok(BM.aloneText.length > 0);
  assert.equal(ringDecision({ ...idle, alone: true, phaseActive: true }, BM).reason, 'phase', 'a running phase meeting is named first');
  assert.equal(ringDecision({ ...idle, alone: true, lunch: true }, BM).reason, 'lunch');
  assert.equal(ringDecision({ ...idle, alone: true, offFloor: true }, BM).reason, 'hidden');
  assert.equal(ringDecision({ ...idle, alone: false }, BM).ok, true, 'with staff on the floor the bell rings');
});

test('cooldown ignores a second ring inside cooldownMs', () => {
  assert.equal(ringDecision({ ...idle, lastRingAt: 100000 - BM.cooldownMs + 1 }, BM).reason, 'cooldown');
  assert.equal(ringDecision({ ...idle, lastRingAt: 100000 - BM.cooldownMs }, BM).ok, true);
});

test('schedule total = n*sayMs + (n-1)*gapMs + close', () => {
  const p = planBell(mk(4), { bm: BM, lines: LINES });
  const n = 4;
  assert.equal(p.totalMs, n * BM.sayMs + (n - 1) * BM.gapMs + BM.gapMs + BM.sayMs);
  assert.equal(p.slots[n - 1].atMs + BM.sayMs + BM.gapMs, p.close.atMs);
});

test('the lead chairs: the plan has no boss line and closes after the last speaker', () => {
  const p = planBell(mk(4), { bm: BM, lines: LINES });
  assert.equal('open' in p, false);
  assert.equal(p.slots[0].atMs, 0);
  assert.equal(p.close.text, 'CLOSE');
});

test('nearestSpot: the meeting spot closest to a person', () => {
  const spots = [{ at: [100, 100] }, { at: [200, 100] }, { at: [200, 200] }];
  assert.equal(nearestSpot(spots, 198, 104), 1);
  assert.equal(nearestSpot(spots, 205, 190), 2);
  assert.equal(nearestSpot(spots, 0, 0), 0);
});
