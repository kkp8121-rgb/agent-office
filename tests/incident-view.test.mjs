// Tests of the lunch break and faint rules (web/incident-view.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { restDim, restSignText, faintPlan, faintTotalMs, FAINT_LIE_SHARE } from '../web/incident-view.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ui = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8')).ui;

test('the lunch veil picks the light, dark and night opacity', () => {
  assert.equal(restDim(ui.rest, { dark: false, night: false }), ui.rest.dimLight);
  assert.equal(restDim(ui.rest, { dark: true, night: false }), ui.rest.dimDark);
  assert.equal(restDim(ui.rest, { dark: false, night: true }), ui.rest.dimNight);
  assert.equal(restDim(ui.rest, { dark: true, night: true }), ui.rest.dimNight, 'the night picture is already dark: the small value wins');
});

test('effects off: the faint is one speech line and no fall', () => {
  const base = { rest: false, lastAt: undefined, now: 5000, cooldownMs: ui.faint.cooldownMs };
  assert.equal(faintPlan({ ...base, fxOn: false }), 'say');
  assert.equal(faintPlan({ ...base, fxOn: true }), 'full');
});

test('no faint and no line on a floor on lunch break', () => {
  const base = { lastAt: undefined, now: 5000, cooldownMs: ui.faint.cooldownMs };
  assert.equal(faintPlan({ ...base, fxOn: true, rest: true }), 'skip');
  assert.equal(faintPlan({ ...base, fxOn: false, rest: true }), 'skip');
});

test('a second faint of the same character inside the cooldown stays silent', () => {
  const cooldownMs = ui.faint.cooldownMs;
  assert.equal(faintPlan({ fxOn: true, rest: false, lastAt: 1000, now: 1000 + cooldownMs - 1, cooldownMs }), 'skip');
  assert.equal(faintPlan({ fxOn: false, rest: false, lastAt: 1000, now: 1000 + cooldownMs - 1, cooldownMs }), 'skip');
  assert.equal(faintPlan({ fxOn: true, rest: false, lastAt: 1000, now: 1000 + cooldownMs, cooldownMs }), 'full');
  assert.ok(Math.abs(faintTotalMs(ui.faint.downMs) * FAINT_LIE_SHARE - ui.faint.downMs) <= 1, 'the lying part of the fall is the configured time');
});

test('the lunch sign shows the return time only when there is an end', () => {
  assert.equal(restSignText(ui.rest, null), '');
  assert.equal(restSignText(ui.rest, { until: null, limitKind: 'other' }), ui.rest.signText);
  const at = new Date(2026, 10, 6, 7, 5).getTime();
  assert.equal(restSignText(ui.rest, { until: at, limitKind: 'five_hour' }), `${ui.rest.signText} · 07:05 복귀`);
});
