import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const cfg = JSON.parse(readFileSync(fileURLToPath(new URL('../config.json', import.meta.url)), 'utf8'));
const at = (path) => path.split('.').reduce((o, k) => (o !== null && typeof o === 'object' && k in o ? o[k] : undefined), cfg);
const kind = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

// every key path the 1.1 build adds, with its type (a leaf: arrays and null stand for themselves)
const KEYS = `
ceo.enabled boolean
ceo.design string
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
ui.bell.text.ask string
ui.bell.text.permission string
ui.bell.text.input string
ui.bell.blinkMs number
ui.bell.waveMs number
ui.bell.waveEveryMs number
ui.bell.titlePrefix string
ui.bell.lobbyStatus string
ui.bell.news string
ui.bell.notifyTitle string
ui.bell.notifyMinGapMs number
ui.bell.notifyStorageKey string
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
ui.conflict.lobbyLampAt null
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
ui.pile.offset.studio2 null
ui.pile.offset.lounge null
ui.pile.offset.library null
ui.pile.offset.greenhouse null
ui.hourglass.tickMs number
ui.hourglass.flipMs number
ui.hourglass.text string
ui.hourglass.textHour string
ui.commute.doorOpenMs number
ui.commute.walkInDelayMs number
ui.commute.leaveGapMs number
ui.commute.leaveBudgetMs number
ui.commute.offDim number
ui.commute.offDimNight number
ui.commute.offFadeMs number
ui.commute.panelText string
ui.commute.door.studio2 object
ui.commute.door.lounge object
ui.commute.door.library object
ui.commute.door.greenhouse object
ui.commute.door.ceo null
ui.building.enabled boolean
ui.building.mode string
ui.building.allTitle string
ui.building.innerW number
ui.building.facadePx number
ui.building.shaftPx number
ui.building.slabPx number
ui.building.roofPx number
ui.building.basementPx number
ui.building.minZoom number
ui.building.maxZoom number
ui.building.maxLiveFloors number
ui.building.liveMarginPx number
ui.building.slideMs number
ui.building.craneMs number
ui.building.collapseMs number
ui.building.carPxPerSec number
ui.building.carMinMs number
ui.building.carMaxMs number
ui.building.lobbyFigures boolean
ui.building.idleNightDim number
ui.building.roofSpots number
ui.building.entryAt.studio2 null
ui.building.entryAt.lounge null
ui.building.entryAt.library null
ui.building.entryAt.greenhouse null
ui.building.entryAt.ceo null
ui.building.basement.racks number
ui.building.basement.blinkSlowMs number
ui.building.basement.blinkFastMs number
ui.building.basement.none string
ui.bellMeeting.label string
ui.bellMeeting.busyText string
ui.bellMeeting.restText string
ui.bellMeeting.sayMs number
ui.bellMeeting.gapMs number
ui.bellMeeting.maxSpeakers number
ui.bellMeeting.cooldownMs number
ui.bellMeeting.at.studio2 null
ui.bellMeeting.at.lounge null
ui.bellMeeting.at.library null
ui.bellMeeting.at.greenhouse null
ui.ceo.tab string
ui.ceo.name string
ui.ceo.role string
ui.ceo.sprite string
ui.ceo.awayText string
ui.ceo.roofText string
ui.ceo.meetingAway string
ui.ceo.queueText string
ui.ceo.board.title string
ui.ceo.board.rows number
ui.empty.variant string
ui.empty.text string
ui.empty.signA string
ui.empty.cardTitle string
ui.empty.cardSteps array
ui.empty.readyDesign string
ui.empty.catAt null
ui.empty.dimA number
ui.lines.bellCall array
ui.lines.handoffGive array
ui.lines.compactWake array
ui.lines.restStart array
ui.lines.restEnd array
ui.lines.conflictTug array
ui.lines.commuteIn array
ui.lines.commuteOut array
ui.lines.bellMeetingOpen array
ui.lines.bellMeetingIdle array
ui.lines.bellMeetingClose array
ui.lines.ceoVisit array
ui.lines.ceoGreet array
ui.lines.ceoIdle array
ui.lines.roofRest array
`.trim().split('\n').map((l) => l.split(' '));

// keys of the first drafts that were dropped on purpose (the review of 2026-11-06, section 12 of the design)
const REMOVED = ['bell.hook', 'cost.count', 'ui.bell.keepAliveHidden', 'ui.commute.chime', 'ui.pile.fallMs', 'ui.hourglass.lobbyMark', 'ui.conflict.news'];

test('every new key path exists with its type', () => {
  assert.ok(KEYS.length >= 80, `${KEYS.length} paths`);
  for (const [path, type] of KEYS) assert.equal(kind(at(path)), type, path);
});

test('removed key paths are absent', () => {
  assert.equal(REMOVED.length, 7);
  for (const path of REMOVED) assert.equal(at(path), undefined, path);
  assert.equal(at('hourglass.kinds.exec_result'), undefined);
});

test('leaveBudgetMs is below floor.leaveMs', () => {
  assert.ok(cfg.ui.commute.leaveBudgetMs < cfg.floor.leaveMs, `${cfg.ui.commute.leaveBudgetMs} < ${cfg.floor.leaveMs}`);
});

test('coordinate keys are null or the right shape', () => {
  const num = (v) => typeof v === 'number' && Number.isFinite(v);
  const pair = (v) => Array.isArray(v) && v.length === 2 && v.every(num);
  const shapes = {
    'ui.conflict.lobbyLampAt': pair,
    'ui.empty.catAt': pair,
    'ui.pile.offset.*': pair,
    'ui.building.entryAt.*': pair,
    'ui.bellMeeting.at.*': pair,
    'ui.commute.door.*': (v) => v !== null && typeof v === 'object' && num(v.dx) && num(v.dy) && num(v.scale),
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
  assert.equal(seen, 1 + 1 + 4 + 5 + 4 + 5);
});

test('gesture priority lists six known kinds', () => {
  const p = cfg.ui.gesture.priority;
  assert.deepEqual([...p].sort(), ['bellwave', 'faint', 'folder', 'life', 'rest', 'tug']);
  assert.equal(p.length, 6);
  assert.equal(p.at(-1), 'life'); // office life is the floor every other gesture stands on
});

test('signSlots are bell then conflict', () => {
  assert.deepEqual(cfg.ui.signSlots, ['bell', 'conflict']);
});
