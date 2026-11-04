// Lobby life: nothing slides into place when the lobby opens, and the strolls (who, when, where, how many at once).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../server/config.mjs';
import { createFloorClock, rngFor } from '../web/ambient.mjs';
import { canStroll, nextStrollAt, scaleLife, strollRange, strollTarget } from '../web/lobbylife.mjs';
import { bakeGrid, isOpen, snapOpen } from '../web/nav.mjs';
import { resolveScene } from '../web/scene.mjs';
import { ROOT } from './helpers/fixture.mjs';

const cfg = loadConfig();
const life = cfg.ui.lobby.life;
const appSrc = readFileSync(join(ROOT, 'web', 'app.mjs'), 'utf8');
const css = readFileSync(join(ROOT, 'web', 'style.css'), 'utf8');

// ---- 1. entering the lobby: every figure is placed, none is on its way ----

/** A DOM element that only remembers what the code does to it. */
function fakeEl(cls = '') {
  const classes = new Set(cls.split(' ').filter(Boolean));
  return {
    style: { setProperty() {} },
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)), contains: (c) => classes.has(c) },
    append() {},
    addEventListener() {},
  };
}

function createCharIn() {
  const ctx = vm.createContext({
    el: (tag, cls) => fakeEl(cls), makeSprite: () => fakeEl(), makeLegs: () => [], makeSitSprite: () => fakeEl(), bindGrab() {}, charZ: () => 1000,
    sitSet: new Set(), recOf: new WeakMap(), ui: { depth: {} }, amb: { fidgetMs: 1200 },
  });
  vm.runInContext(appSrc.match(/function createChar\(.*?\n}\n/s)[0], ctx);
  vm.runInContext('globalThis.make = createChar', ctx);
  return ctx.make;
}

test('lobby entry: a figure is created with its transition off, so a change of the fit zoom cannot slide it into place', () => {
  const make = createCharIn();
  const rec = make({ sprite: 'worker', slot: null }, fakeEl(), { x: 296, y: 332 }, null, false, true);
  assert.equal(rec.el.style.transitionDuration, '0ms', 'the figure');
  assert.equal(rec.tagRoot.style.transitionDuration, '0ms', 'and its name tag layer');
  assert.equal(rec.el.style.transform, 'translate(296px, 332px)', 'it starts at its place');
  assert.equal(rec.legs.length, 0, 'no legs until its first stroll');
});

test('lobby entry: the CSS default transition is what animated them (a computed-transform change, e.g. the zoom, slides everything without an inline duration)', () => {
  assert.match(css, /\.ag, \.agt \{[^}]*transition: transform var\(--walk-ms\) linear;/s);
  assert.match(css, /--walk-ms: 1200ms;/);
});

// ---- 2. who strolls, when ----

test('lobby life: sleepers, finished agents and figures of a leaving floor do not stroll; the others by their state', () => {
  assert.equal(canStroll('stale', 'busy'), false);
  assert.equal(canStroll('done', 'busy'), false);
  assert.equal(canStroll('idle', 'leaving'), false);
  assert.equal(strollRange(life, { state: 'stale', floorStatus: 'busy' }), null);
  assert.equal(strollRange(life, { state: 'done', floorStatus: 'busy' }), null);
  assert.equal(strollRange(life, { state: 'idle', floorStatus: 'leaving' }), null);
  assert.deepEqual(strollRange(life, { state: 'enter', floorStatus: 'busy' }), life.strollEveryMs.idle, 'a newcomer rests like an idle one');
  assert.ok(life.strollEveryMs.working[0] > life.strollEveryMs.thinking[1], 'a working figure strolls much more rarely than a thinking one');
  assert.ok(life.strollEveryMs.thinking[0] > life.strollEveryMs.idle[0]);
  const rng = rngFor('x');
  assert.equal(nextStrollAt(rng, life, { state: 'stale', floorStatus: 'busy' }, 1000, false), Infinity);
});

test('lobby life: the first stroll of a freshly opened lobby is spread over the first wait, never before firstDelayMs[0], and differs from figure to figure', () => {
  const who = { state: 'idle', floorStatus: 'busy' };
  const at = Array.from({ length: 40 }, (_, i) => nextStrollAt(rngFor(`k${i}`), life, who, 0, true));
  assert.ok(at.every((t) => t >= life.firstDelayMs[0] && t <= life.strollEveryMs.idle[1]));
  assert.ok(new Set(at.map((t) => Math.round(t / 1000))).size > 20, 'staggered');
  const later = Array.from({ length: 40 }, (_, i) => nextStrollAt(rngFor(`k${i}`), life, who, 0, false));
  assert.ok(later.every((t) => t >= life.strollEveryMs.idle[0] && t < life.strollEveryMs.idle[1]), 'after a stroll the full wait applies');
});

test('lobby life: ?debug=ambient shrinks every range, nothing else changes', () => {
  const k = scaleLife(life, 0.1);
  assert.equal(k.tickMinMs, life.tickMinMs * 0.1);
  assert.deepEqual(k.stayMs, life.stayMs.map((n) => n * 0.1));
  assert.deepEqual(k.strollEveryMs.idle, life.strollEveryMs.idle.map((n) => n * 0.1));
  assert.deepEqual(k.strollPx, life.strollPx);
  assert.equal(k.maxAway, life.maxAway);
});

// ---- 3. where a stroll goes: the real lobby room ----

const raw = JSON.parse(readFileSync(join(ROOT, 'assets', 'scenes', 'lobby', 'scene.json'), 'utf8'));
const room = resolveScene(raw);
const grid = bakeGrid(room, cfg.nav);

test('lobby stroll target: from every seat the aisle in front of its row gives an open, in-range, sideways target', () => {
  const rng = rngFor('seats');
  for (const s of room.seats) {
    const from = isOpen(grid, s.approach) ? s.approach : snapOpen(grid, s.approach, cfg.nav.snapRadiusCells);
    assert.ok(from, `seat ${s.i} has an aisle point`);
    let found = 0;
    for (let k = 0; k < 20; k++) {
      const p = strollTarget(rng, grid, from, life, { keepClear: [], busyLanes: [], aisle: true });
      if (!p) continue;
      found++;
      assert.ok(isOpen(grid, p), `seat ${s.i}: open`);
      assert.equal(p[1], from[1], `seat ${s.i}: along the aisle`);
      const d = Math.abs(p[0] - from[0]);
      assert.ok(d >= life.strollPx[0] - 1 && d <= life.strollPx[1] + 1, `seat ${s.i}: ${d}px is a short walk`);
    }
    assert.ok(found > 10, `seat ${s.i}: most tries find a place`);
  }
});

test('lobby stroll target: keeps clear of standing figures and of other walkers, and of the walk itself', () => {
  const from = snapOpen(grid, room.seats[10].approach, cfg.nav.snapRadiusCells);
  const open = (rng) => strollTarget(rng, grid, from, { ...life, strollTries: 200 }, { keepClear: [], busyLanes: [], aisle: true });
  const free = open(rngFor('a'));
  assert.ok(free);
  // a figure standing right on the only side the rng picks: the other side must be chosen, or none
  const blocker = [free[0], free[1]];
  let checked = 0;
  for (let i = 0; i < 30; i++) {
    const p = strollTarget(rngFor(`b${i}`), grid, from, life, { keepClear: [blocker], busyLanes: [], aisle: true });
    if (p) {
      assert.ok(Math.hypot(p[0] - blocker[0], p[1] - blocker[1]) >= life.strollGapPx, 'not on the blocker');
      const reach = Math.max(0, Math.min(1, (blocker[0] - from[0]) / (p[0] - from[0] || 1))); // where along the walk the blocker is closest (the walk is horizontal)
      const nearest = Math.hypot(blocker[0] - (from[0] + reach * (p[0] - from[0])), blocker[1] - from[1]);
      assert.ok(nearest >= life.strollGapPx / 2, 'the walk does not pass through the blocker');
      checked++;
    }
  }
  assert.ok(checked > 0, 'some tries still find the other side');
});

test('lobby stroll target: one walker per aisle, and none when no place is open', () => {
  const from = snapOpen(grid, room.seats[10].approach, cfg.nav.snapRadiusCells);
  assert.equal(strollTarget(rngFor('lane'), grid, from, life, { keepClear: [], busyLanes: [from[1] + 3], aisle: true }), null, 'someone already walks in this aisle');
  assert.ok(strollTarget(rngFor('lane'), grid, from, life, { keepClear: [], busyLanes: [from[1] + 200], aisle: true }), 'another aisle does not matter');
  const walled = { ...grid, open: new Uint8Array(grid.open.length) };
  assert.equal(strollTarget(rngFor('x'), walled, from, life, { keepClear: [], busyLanes: [], aisle: false }), null);
  const closedFrom = [10, 10];
  assert.equal(strollTarget(rngFor('x'), grid, closedFrom, life, { keepClear: [], busyLanes: [], aisle: false }), null, 'a start that is not walkable');
});

test('lobby stroll target: a standing spot (no aisle) walks in any direction, still open and in sight', () => {
  const o = room.overflow[0].at;
  const rng = rngFor('spot');
  const dirs = new Set();
  for (let i = 0; i < 60; i++) {
    const p = strollTarget(rng, grid, o, life, { keepClear: [], busyLanes: [], aisle: false });
    if (!p) continue;
    assert.ok(isOpen(grid, p));
    dirs.add(Math.sign(p[1] - o[1]));
  }
  assert.ok(dirs.size > 1, 'not only sideways');
});

// ---- 4. the clock: few at once, staggered, one timer ----

test('lobby life clock: 45 figures, at most maxAway out at once, strolls spread over time, one timer, idle ones go out more than working ones', () => {
  let t = 1_000_000;
  const timers = new Map();
  let seq = 0;
  const clockTimers = { setTimeout: (fn, ms) => { timers.set(++seq, { fn, at: t + ms }); return seq; }, clearTimeout: (id) => { timers.delete(id); } };
  const states = ['working', 'thinking', 'idle', 'working', 'thinking', 'stale', 'idle', 'done', 'enter'];
  const members = Array.from({ length: 45 }, (_, i) => {
    const who = { state: states[i % states.length], floorStatus: 'busy' };
    const rng = rngFor(`f${i}`);
    const m = { id: `f${i}`, who, rng, nextFidgetAt: t + 2000 + i * 500, nextTripAt: nextStrollAt(rng, life, who, t, true), returnAt: 0, away: false, trips: 0 };
    return m;
  });
  const starts = [];
  let maxAway = 0;
  const clock = createFloorClock({
    amb: life,
    now: () => t,
    timers: clockTimers,
    members: () => members.filter((m) => m.who.state !== 'done'),
    awayCount: () => members.filter((m) => m.away).length,
    act: {
      fidget: (m) => { m.nextFidgetAt = t + life.fidgetEveryMs[0]; },
      trip: (m) => {
        m.away = true;
        m.trips++;
        starts.push(t);
        m.returnAt = t + 1500 + life.stayMs[0];
        m.nextTripAt = Infinity;
      },
      tripEnd: (m) => {
        m.away = false;
        m.returnAt = 0;
        m.nextTripAt = nextStrollAt(m.rng, life, m.who, t, false);
      },
    },
  });
  clock.start();
  const end = t + 20 * 60 * 1000;
  let wakes = 0;
  while (t < end && timers.size) {
    assert.equal(timers.size, 1, 'one timer');
    const [[id, tm]] = [...timers];
    timers.delete(id);
    t = Math.max(t, tm.at);
    tm.fn();
    wakes++;
    maxAway = Math.max(maxAway, members.filter((m) => m.away).length);
  }
  assert.ok(maxAway <= life.maxAway, `at most ${life.maxAway} out at once (saw ${maxAway})`);
  assert.ok(maxAway >= 2, 'but the lobby does have a few out at times');
  assert.ok(starts.length > 20, `strolls happen (${starts.length})`);
  assert.ok(new Set(starts.map((s) => Math.round(s / 1000))).size > starts.length * 0.8, 'staggered, not all at one moment');
  const sum = (state) => members.filter((m) => m.who.state === state).reduce((n, m) => n + m.trips, 0) / members.filter((m) => m.who.state === state).length;
  assert.ok(sum('idle') > sum('working'), 'idle figures stroll more than working ones');
  assert.equal(members.filter((m) => m.who.state === 'stale').reduce((n, m) => n + m.trips, 0), 0, 'sleepers never');
  assert.ok(wakes < 20 * 60 * 1000 / life.tickMinMs, 'the timer wakes less than once per tickMinMs');
});

// ---- 5. wired into the page ----

test('lobby life: wired: CSS keyframes per state, reduced motion switches both the motion and the strolls off, a hidden lobby or tab sends everyone home', () => {
  assert.match(css, /\.floor\.lobby \.st-thinking \.spr \{ animation: lobby-think/);
  assert.match(css, /\.floor\.lobby \.st-working \.spr \{ animation: lobby-type/);
  assert.match(css, /\.floor\.lobby \.st-stale \.spr \{ animation: lobby-doze/);
  assert.match(css, /\.floor\.lobby \.st-idle \.spr, \.floor\.lobby \.st-enter \.spr \{ animation: breathe/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.floor\.lobby \.spr, \.floor\.lobby \.zz \{ animation: none !important; \}/);
  assert.match(appSrc, /prefers-reduced-motion: reduce/);
  const start = appSrc.slice(appSrc.indexOf('function startLobbyLife('), appSrc.indexOf('/** Stops the clock'));
  assert.match(start, /prefersLessMotion\(\)/);
  assert.match(start, /!lb\.life\.enabled/);
  assert.match(start, /paused\(\)/);
  const off = appSrc.slice(appSrc.indexOf('function setLobbyOff('), appSrc.indexOf('// ---------- lobby life'));
  assert.match(off, /stopLobbyLife\(\)/);
  const pause = appSrc.slice(appSrc.indexOf('function pause()'), appSrc.indexOf('async function resume()'));
  assert.match(pause, /stopLobbyLife\(\)/);
  assert.match(appSrc.slice(appSrc.indexOf('async function resume()')), /startLobbyLife\(\);/);
  assert.doesNotMatch(css, /\.floor\.lobby \.st-working \.spr[^}]*animation: none/, 'the old "nothing moves" rule is gone');
});

test('lobby life: nothing runs per frame', () => {
  const life = appSrc.slice(appSrc.indexOf('// ---------- lobby life'), appSrc.indexOf('// ---------- session list'));
  assert.doesNotMatch(life, /requestAnimationFrame|setInterval/);
});

// ---- 6. review fixes: arrival resets the transition, the crop stops the life, the bubble pass skips empty floors ----

/** Runs one top-level function of web/app.mjs in a vm with the given globals. */
function fnIn(name, globals, ...more) {
  const ctx = vm.createContext(globals);
  for (const f of [...more, name]) vm.runInContext(appSrc.match(new RegExp(String.raw`function ${f}\(.*?\n}\n`, 's'))[0], ctx);
  return ctx[name] ?? vm.runInContext(name, ctx);
}

test('stroll back: at the desk the transition time of the last piece is reset to 0ms (a zoom change must not slide the figure again)', () => {
  const rec = { m: { returnAt: 5, nextTripAt: 0 }, home: { at: [10, 20], face: 'left' }, away: true, x: 1, y: 1, el: fakeEl(), tagRoot: fakeEl() };
  rec.el.style.transitionDuration = rec.tagRoot.style.transitionDuration = '86.6667ms'; // what stepWalk leaves behind
  const strollBack = fnIn('strollBack', {
    strollRoute: () => [[1, 1], [10, 20]],
    walkPath: (r, f, pts, onArrive) => onArrive(),
    abortStroll: () => assert.fail('a route exists'),
    lobby: { clock: { kick() {} } }, ui: { depth: {} }, charZ: () => 1000, setFacing() {}, scheduleStroll() {},
  }, 'noSlide');
  strollBack(rec);
  assert.equal(rec.away, false);
  assert.equal(rec.el.style.transitionDuration, '0ms', 'the figure');
  assert.equal(rec.tagRoot.style.transitionDuration, '0ms', 'and its name tag layer');
});

test('small window: the lobby is shown whole (no crop to the wall), scaled like any floor, and its life is never held back by a crop', () => {
  assert.doesNotMatch(appSrc, /function lobbyBox|lb\.cropped|lobby\.cropped|lb\.crop/, 'no crop mode is left in the lobby code');
  const fit = appSrc.slice(appSrc.indexOf('function fitFloors('), appSrc.indexOf('function showConn('));
  assert.match(fit, /fitBox\(availW, availH, \.\.\.shown\.scene\.r\.size, SINGLE_MAX_ZOOM\)/, 'the lobby and the floors are fitted by the size of their scene');
  const css = readFileSync(new URL('../web/style.css', import.meta.url), 'utf8');
  assert.doesNotMatch(css, /\.floor\.lobby\.crop/);
});

test('bubble pass: a floor with fewer than two shown bubbles costs no style or layout read (a lone one is reset), the others are still measured', () => {
  let reads = 0;
  const LOBBY = appSrc.match(/const LOBBY_BUBBLES = '(.*?)';/)[1];
  const asked = [];
  const makeFloor = (bubs, lobby = false) => ({
    hidden: false, classList: { contains: (c) => lobby && c === 'lobby' },
    querySelectorAll: (sel) => (asked.push(sel), bubs),
  });
  const mk = () => ({ lift: null, shy: null, offsetWidth: 10, getBoundingClientRect: () => ({ x: 0, y: 0, width: 10, height: 10 }), classList: { contains: () => false, toggle() {}, remove(c) { this.removed = c; } }, style: { getPropertyValue: () => '', setProperty(k, v) { this.lift = v; } } });
  const lone = mk();
  const floors = [makeFloor([]), makeFloor([lone]), makeFloor([mk(), mk()]), makeFloor([mk()], true)];
  const win = { getComputedStyle: () => (reads++, { display: 'block', visibility: 'visible' }) };
  const run = fnIn('clearBubbleOverlap', {
    ui: { ui: { bubbleClear: { checkMs: 120, lobbyRecheckMs: 2000 } } }, lobbyBubbleMemo: { key: '', at: 0 }, paused: () => false, floorsEl: { children: floors, ownerDocument: { defaultView: win } },
    clockTimers: { setTimeout() {} }, Number, LOBBY_BUBBLES: LOBBY, clearBubbles: (items) => new Map(items.map((i) => [i.id, { lift: 0, hide: false }])),
  });
  run();
  assert.equal(reads, 2, 'only the floor with two bubbles reads styles');
  assert.doesNotMatch(appSrc.slice(appSrc.indexOf('function clearBubbleOverlap('), appSrc.indexOf('function renderFloor(')), /floor\.offsetParent/, 'the visibility of a floor is read from its hidden attribute');
  assert.equal(lone.style.lift, '0px', 'a lone bubble is put back to no lift');
  assert.equal(lone.classList.removed, 'shy', 'and shown');
  assert.deepEqual(asked, ['.bub:not(.empty)', '.bub:not(.empty)', '.bub:not(.empty)', LOBBY], 'the lobby asks only for what its CSS can show');
  assert.equal(LOBBY, '.agt.back .bub:not(.dot):not(.empty)');
  assert.ok(css.includes('.floor.lobby .agt .bub.dot, .floor.lobby .agt:not(.back) .bub { display: none; }'), 'the CSS rule the lobby selector mirrors');
});

test('stroll out: a figure standing in the aisle (the stay) also has 0ms, so a window resize cannot slide it', () => {
  const stroll = appSrc.slice(appSrc.indexOf('function lobbyStroll('), appSrc.indexOf('/** A walk leaves the time'));
  assert.match(stroll, /walkPath\(rec, lb, pts, \(\) => noSlide\(rec\)\)/);
  const rec = { el: fakeEl(), tagRoot: fakeEl() };
  rec.el.style.transitionDuration = rec.tagRoot.style.transitionDuration = '1220ms';
  fnIn('noSlide', {})(rec);
  assert.equal(rec.el.style.transitionDuration, '0ms');
  assert.equal(rec.tagRoot.style.transitionDuration, '0ms');
});

test('bubble pass in the lobby: with the same bubbles in the same places and no walker the layout is not read again until lobbyRecheckMs; a change or a walker reads at once', () => {
  assert.ok(life && cfg.ui.bubbleClear.lobbyRecheckMs >= cfg.ui.bubbleClear.checkMs, 'the recheck is a config value, not shorter than a check');
  let reads = 0;
  const mk = (tr) => ({
    className: 'bub txt fresh', textContent: 'x', parentElement: { className: 'agt back', style: { transform: tr, transitionDuration: '0ms' } }, offsetWidth: 10,
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 10, height: 10 }), classList: { contains: () => false, toggle() {}, remove() {} }, style: { getPropertyValue: () => '', setProperty() {} },
  });
  const bubs = [mk('a'), mk('b')];
  const lobby = { hidden: false, className: 'floor lobby', classList: { contains: (c) => c === 'lobby' }, querySelectorAll: () => bubs };
  const win = { getComputedStyle: () => (reads++, { display: 'block', visibility: 'visible' }) };
  const C = { checkMs: 120, lobbyRecheckMs: 2000 };
  const run = fnIn('clearBubbleOverlap', {
    ui: { ui: { bubbleClear: C } }, paused: () => false, floorsEl: { style: { zoom: '1' }, children: [lobby], ownerDocument: { defaultView: win } },
    clockTimers: { setTimeout() {} }, Number, LOBBY_BUBBLES: 'x', lobbyBubbleMemo: { key: '', at: 0 }, clearBubbles: (items) => new Map(items.map((i) => [i.id, { lift: 0, hide: false }])),
  });
  run();
  assert.equal(reads, 2, 'the first pass reads both');
  run();
  run();
  assert.equal(reads, 2, 'nothing changed: no read');
  bubs[0].parentElement.style.transform = 'c';
  run();
  assert.equal(reads, 4, 'a moved figure: read');
  bubs[0].parentElement.style.transitionDuration = '500ms'; // on a walk
  run();
  run();
  assert.equal(reads, 8, 'one of them is walking: read every pass');
  bubs[0].parentElement.style.transitionDuration = '0ms'; // arrived
  run();
  run();
  assert.equal(reads, 10, 'the arrival is a change of the key once, then it is quiet again');
});
