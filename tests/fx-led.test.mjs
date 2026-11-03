// Tests of the LED wall effect rules (web/fx-led.mjs): load threshold -> colour step, overflow -> marquee decision, change detection.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { blinkFrames, loadStep, marqueePlan, overflowPx, textChanged } from '../web/fx-led.mjs';
import { loadConfig } from '../server/config.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8')).ui.fx.led;

test('loadStep: thresholds in config give steps 0, 1, 2', () => {
  assert.deepEqual(cfg.load.steps, [80, 90]);
  const s = cfg.load.steps;
  assert.equal(loadStep(0, s), 0);
  assert.equal(loadStep(79, s), 0);
  assert.equal(loadStep(80, s), 1);
  assert.equal(loadStep(89, s), 1);
  assert.equal(loadStep(90, s), 2);
  assert.equal(loadStep(100, s), 2);
});

test('loadStep: a missing or broken value stays at step 0', () => {
  assert.equal(loadStep(undefined, [80, 90]), 0);
  assert.equal(loadStep(NaN, [80, 90]), 0);
  assert.equal(loadStep(95, []), 0);
});

test('overflowPx: a line that fits (or only rounds over) does not overflow', () => {
  assert.equal(overflowPx(100, 100, 2), 0);
  assert.equal(overflowPx(102, 100, 2), 0);
  assert.equal(overflowPx(0, 0, 2), 0);
  assert.equal(overflowPx(103, 100, 2), 3);
  assert.equal(overflowPx(150.2, 100, 2), 51);
});

test('marqueePlan: none when it fits, else a scroll of exactly the overflow with a rest at each end', () => {
  assert.equal(marqueePlan(0, cfg.marquee), null);
  const p = marqueePlan(70, { speed: 14, holdMs: 1000 });
  assert.equal(p.durationMs, 7000); // 70 px at 14 px/s = 5 s, plus two 1 s rests
  assert.deepEqual(p.keyframes.map((k) => k.offset), [0, 1000 / 7000, 1 - 1000 / 7000, 1]);
  assert.equal(p.keyframes[0].transform, 'translateX(0)');
  assert.equal(p.keyframes[2].transform, 'translateX(-70px)');
  assert.equal(p.keyframes[3].transform, 'translateX(-70px)');
});

test('marqueePlan: only transform is animated', () => {
  const p = marqueePlan(30, cfg.marquee);
  for (const k of p.keyframes) assert.deepEqual(Object.keys(k).sort(), ['offset', 'transform']);
});

test('textChanged: the first fill and the same text do not blink, a different text does', () => {
  assert.equal(textChanged(undefined, '5'), false);
  assert.equal(textChanged('', '5'), false);
  assert.equal(textChanged('5', '5'), false);
  assert.equal(textChanged('5', '6'), true);
  assert.equal(textChanged('5', ''), true);
});

test('blinkFrames: full, then count dips to min and back, opacity only', () => {
  const f = blinkFrames(2, 0.3);
  assert.deepEqual(f.map((k) => k.opacity), [1, 0.3, 1, 0.3, 1]);
  assert.deepEqual(blinkFrames(0, 0.3), [{ opacity: 1 }]);
});

test('config: ui.fx.led carries every number the effect uses', () => {
  const c = loadConfig().ui.fx.led;
  assert.equal(c.enabled, true);
  for (const k of ['ms', 'count', 'min']) assert.equal(typeof c.blink[k], 'number');
  for (const k of ['speed', 'holdMs', 'minOverflow']) assert.equal(typeof c.marquee[k], 'number');
});
