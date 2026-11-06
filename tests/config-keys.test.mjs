import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const cfg = JSON.parse(readFileSync(fileURLToPath(new URL('../config.json', import.meta.url)), 'utf8'));
const at = (path) => path.split('.').reduce((o, k) => (o !== null && typeof o === 'object' && k in o ? o[k] : undefined), cfg);
const kind = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

// every key path the 1.1 build adds, with its type (a leaf: arrays and null stand for themselves)
const KEYS = `
cost.file string
cost.keepDays number
cost.dayStartHour number
cost.sendMinMs number
cost.saveMinMs number
cost.dedupePerFile number
cost.backfill.enabled boolean
cost.backfill.delayMs number
cost.backfill.today boolean
cost.backfill.lastWeek boolean
cost.backfill.maxBytes number
cost.backfill.yieldEveryLines number
incident.rest.graceMs number
incident.rest.maxMs number
incident.limitKinds array
incident.compactTriggers array
conflict.enabled boolean
conflict.windowMs number
conflict.editTools array
conflict.maxPathChars number
conflict.maxKeys number
conflict.maxPerFloor number
conflict.hashChars number
conflict.saltBytes number
model.claude array
model.ignore array
context.windows array
context.defaultWindow number
context.largeWindow number
context.levels array
hourglass.afterMs number
hourglass.maxMs number
hourglass.maxOpen number
hourglass.ignoreTools array
hourglass.kinds.Bash string
hourglass.kinds.WebFetch string
hourglass.kinds.WebSearch string
ui.cost.title string
ui.cost.topCount number
ui.cost.units array
ui.cost.decimals number
ui.cost.news string
ui.cost.noLastWeek string
ui.cost.scanning string
ui.cost.partial string
ui.cost.goneName string
ui.cost.cacheReadLabel string
ui.cost.empty string
ui.handoff.giveMs number
ui.handoff.deskKeepMs number
ui.handoff.flyMs number
ui.handoff.planeMs number
ui.handoff.planeMaxConcurrent number
ui.handoff.pendingMs number
ui.faint.downMs number
ui.faint.notepadMs number
ui.faint.cooldownMs number
ui.rest.dimLight number
ui.rest.dimDark number
ui.rest.dimNight number
ui.rest.signText string
ui.rest.untilText string
ui.rest.lobbyStatus string
ui.rest.news string
ui.gesture.priority array
ui.signSlots array
ui.conflict.tugMs number
ui.conflict.tugEveryMs number
ui.conflict.blinkMs number
ui.conflict.tagText string
ui.conflict.lobbyLampAt array
ui.conflict.lobbyLampSize array
ui.badge.bandPx number
ui.badge.labels.opus string
ui.badge.labels.sonnet string
ui.badge.labels.haiku string
ui.badge.labels.other string
ui.badge.labels.codex string
ui.badge.colors.opus.light string
ui.badge.colors.opus.dark string
ui.badge.colors.sonnet.light string
ui.badge.colors.sonnet.dark string
ui.badge.colors.haiku.light string
ui.badge.colors.haiku.dark string
ui.badge.colors.other.light string
ui.badge.colors.other.dark string
ui.badge.colors.codex.light string
ui.badge.colors.codex.dark string
ui.badge.minLumaGap number
ui.pile.wobbleMs number
ui.pile.titles array
ui.pile.offset.studio2 array
ui.pile.offset.lounge array
ui.pile.offset.library array
ui.pile.offset.greenhouse array
ui.hourglass.tickMs number
ui.hourglass.flipMs number
ui.hourglass.text string
ui.hourglass.textHour string
ui.bellMeeting.label string
ui.bellMeeting.busyText string
ui.bellMeeting.restText string
ui.bellMeeting.sayMs number
ui.bellMeeting.gapMs number
ui.bellMeeting.maxSpeakers number
ui.bellMeeting.cooldownMs number
ui.bellMeeting.at.studio2 array
ui.bellMeeting.at.lounge array
ui.bellMeeting.at.library array
ui.bellMeeting.at.greenhouse array
ui.lines.handoffGive array
ui.lines.compactWake array
ui.lines.restStart array
ui.lines.restEnd array
ui.lines.conflictTug array
ui.lines.bellMeetingIdle array
ui.lines.bellMeetingClose array
`.trim().split('\n').map((l) => l.split(' '));

// keys of the first drafts that were dropped on purpose (the review of 2026-11-06, section 12 of the design),
// and the keys of the features taken out again before the release: the call bell and its alert, the boss room, the building view, the lift commute, the empty-office screen
const REMOVED = ['bell.hook', 'cost.count', 'ui.pile.fallMs', 'ui.hourglass.lobbyMark', 'ui.conflict.news',
  'ceo', 'ui.bell', 'ui.ceo', 'ui.building', 'ui.commute', 'ui.empty', 'ui.weather.alertGroup', 'ui.weather.alertSwitch', 'ui.weather.alertHint', 'ui.weather.alertDenied',
  'ui.lines.bellCall', 'ui.lines.commuteIn', 'ui.lines.commuteOut', 'ui.lines.bellMeetingOpen', 'ui.lines.ceoVisit', 'ui.lines.ceoGreet', 'ui.lines.ceoIdle', 'ui.lines.roofRest'];

test('every new key path exists with its type', () => {
  assert.ok(KEYS.length >= 80, `${KEYS.length} paths`);
  for (const [path, type] of KEYS) assert.equal(kind(at(path)), type, path);
});

test('removed key paths are absent', () => {
    for (const path of REMOVED) assert.equal(at(path), undefined, path);
  assert.equal(at('hourglass.kinds.exec_result'), undefined);
});

test('coordinate keys are null or the right shape', () => {
  const num = (v) => typeof v === 'number' && Number.isFinite(v);
  const pair = (v) => Array.isArray(v) && v.length === 2 && v.every(num);
  const shapes = {
    'ui.conflict.lobbyLampAt': pair,
    'ui.pile.offset.*': pair,
    'ui.bellMeeting.at.*': pair,
  };
  let seen = 0;
  for (const [pattern, ok] of Object.entries(shapes)) {
    const star = pattern.endsWith('.*');
    const parent = at(star ? pattern.slice(0, -2) : pattern);
    const values = star ? Object.entries(parent) : [[pattern, parent]];
    assert.ok(values.length > 0, pattern);
    for (const [name, v] of values) {
      seen++;
      assert.ok(v === null || ok(v), `${pattern}: ${name}`); // null = not placed yet: the picture or button is simply not drawn
    }
  }
  assert.equal(seen, 1 + 4 + 4);
});

test('gesture priority lists five known kinds', () => {
  const p = cfg.ui.gesture.priority;
  assert.deepEqual([...p].sort(), ['faint', 'folder', 'life', 'rest', 'tug']);
  assert.equal(p.length, 5);
  assert.equal(p.at(-1), 'life'); // office life is the floor every other gesture stands on
});

test('signSlots is the conflict marker only', () => {
  assert.deepEqual(cfg.ui.signSlots, ['conflict']);
});
