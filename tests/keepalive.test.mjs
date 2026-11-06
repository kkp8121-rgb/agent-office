import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keepOpen, takeWhilePaused } from '../web/keepalive.mjs';

test('hidden tab with alerts on keeps the stream open', () => {
  assert.equal(keepOpen({ hidden: true, pip: false, alerts: true }), true);
});

test('alerts off closes it', () => {
  assert.equal(keepOpen({ hidden: true, pip: false, alerts: false }), false);
  assert.equal(keepOpen({ hidden: false, pip: false, alerts: false }), false);
});

test("an open small window keeps today's behaviour", () => {
  // the opener tab never pauses while the small window shows the office, so the new rule must not claim that case
  assert.equal(keepOpen({ hidden: true, pip: true, alerts: true }), false);
  assert.equal(keepOpen({ hidden: true, pip: true, alerts: false }), false);
  assert.equal(keepOpen({ hidden: false, pip: false, alerts: true }), false); // a visible tab is not paused at all
});

test('only state frames are taken while paused', () => {
  assert.equal(takeWhilePaused('state'), true);
  for (const type of ['log', 'phase', 'fail', 'weather', 'sysload', 'bell', 'compact', 'handoff', 'conflict', 'cost']) assert.equal(takeWhilePaused(type), false, type);
});
