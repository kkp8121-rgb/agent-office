// Tests of the bell rules (web/call-view.mjs): the sign text, the title count, the call-alert switch and the Windows notification trigger.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bellOf, callingFloors, titleWith, createAlertSwitch, createNotifier } from '../web/call-view.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8')).ui.bell;

const floor = (sessionId, extra = {}) => ({ sessionId, floorNo: 2, title: 'Floor', status: 'waiting', call: null, rest: null, ...extra });

test('the bell sign follows the call kind and an unknown kind has none', () => {
  for (const kind of ['ask', 'permission', 'input']) assert.deepEqual(bellOf(floor('a', { call: kind }), cfg), { kind, text: cfg.text[kind] });
  assert.equal(bellOf(floor('a', { call: 'weird' }), cfg), null);
  assert.equal(bellOf(floor('a', { call: 'constructor' }), cfg), null);
  assert.equal(bellOf(floor('a'), cfg), null);
});

test('a floor on its lunch break shows no bell', () => {
  assert.equal(bellOf(floor('a', { call: 'ask', rest: { until: null, limitKind: 'five_hour' } }), cfg), null);
});

test('the title prefix counts the calling floors and is plain at zero', () => {
  const list = [floor('a', { call: 'ask' }), floor('b', { call: 'input' }), floor('c')];
  assert.equal(callingFloors(list, cfg).length, 2);
  assert.equal(titleWith('Office', 2, cfg.titlePrefix), '(호출 2) Office');
  assert.equal(titleWith('Office', 0, cfg.titlePrefix), 'Office');
});

test('a floor that finished its turn and waits for input is not a call', () => {
  const idle = floor('a', { status: 'waiting', call: null });
  assert.equal(bellOf(idle, cfg), null);
  assert.equal(callingFloors([idle], cfg).length, 0);
});

function fakeAlerts(permission, answer = permission) {
  const calls = { keep: [], asked: 0, saved: {} };
  const sw = createAlertSwitch({
    storage: { getItem: (k) => calls.saved[k] ?? null, setItem: (k, v) => { calls.saved[k] = v; } },
    key: cfg.notifyStorageKey,
    keepAlive: { set: (on) => calls.keep.push(on), on: () => calls.keep.at(-1) === true },
    permission: () => (calls.asked ? answer : permission),
    request: async () => { calls.asked += 1; return answer; },
  });
  return { sw, calls };
}

test('alerts switch off stops both notifications and keep-alive', async () => {
  const { sw, calls } = fakeAlerts('default', 'granted');
  assert.equal(sw.isOn(), false, 'starts off');
  assert.equal(calls.asked, 0, 'nothing is asked before the click');
  assert.equal(await sw.turnOn(), true);
  assert.equal(calls.asked, 1);
  assert.equal(calls.keep.at(-1), true, 'turning on keeps the hidden tab connected');
  assert.equal(calls.saved[cfg.notifyStorageKey], '1');

  const sent = [];
  let t = 0;
  const notifier = createNotifier({ cfg, isOn: sw.isOn, now: () => t, notify: (n) => sent.push(n) });
  notifier.update([floor('a')]);
  notifier.update([floor('a', { call: 'ask' })]);
  assert.equal(sent.length, 1);

  sw.turnOff();
  assert.equal(calls.keep.at(-1), false, 'turning off lets the hidden tab disconnect');
  assert.equal(calls.saved[cfg.notifyStorageKey], '0');
  t += cfg.notifyMinGapMs; // the gap is over: only the switch can hold the notification back
  notifier.update([floor('a')]);
  notifier.update([floor('a', { call: 'ask' })]);
  assert.equal(sent.length, 1, 'no notification while the switch is off');

  const denied = fakeAlerts('default', 'denied');
  assert.equal(await denied.sw.turnOn(), false);
  assert.equal(denied.sw.isOn(), false);
  assert.deepEqual(denied.calls.keep, [], 'a refused permission never keeps the connection');
});

test('a notification fires on call null->value even while hidden', () => {
  let t = 1000;
  const sent = [];
  const notifier = createNotifier({ cfg, isOn: () => true, now: () => t, notify: (n) => sent.push(n) });
  notifier.update([floor('a', { call: 'input' }), floor('b')]); // page start: a call that was already there is not news
  assert.equal(sent.length, 0);
  notifier.update([floor('a', { call: 'input' }), floor('b', { call: 'ask', title: 'Second' })]); // a hidden tab hands over the same state frames
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], { sessionId: 'b', title: cfg.notifyTitle, body: `Second ${cfg.text.ask}` });
  notifier.update([floor('a', { call: 'input' }), floor('b', { call: 'permission' })]); // a kind change is not a new call
  assert.equal(sent.length, 1);
  t += 1;
  notifier.update([floor('a', { call: 'input' }), floor('b')]);
  notifier.update([floor('a', { call: 'input' }), floor('b', { call: 'ask' })]);
  assert.equal(sent.length, 1, 'inside the minimum gap the same floor is not notified again');
  t += cfg.notifyMinGapMs;
  notifier.update([floor('a', { call: 'input' }), floor('b')]);
  notifier.update([floor('a', { call: 'input' }), floor('b', { call: 'ask' })]);
  assert.equal(sent.length, 2);
});
