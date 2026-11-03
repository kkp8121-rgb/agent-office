// Tests for the "chars" effects area (web/fx-chars.mjs): the pure timing and frame rules, the per-character motion driven by a fake
// element (fake Animation objects the test steps by hand), the area's wiring on the effects bus, and the config numbers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { alignDelay, bobFrames, createMotion, init, iterationsToFinish, settleFrames, sitFrames, standFrames, stepMs } from '../web/fx-chars.mjs';
import { createFx } from '../web/fx.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8'));
const cfg = config.ui.fx.chars;

/** An element whose .animate() returns hand-steppable animations. */
function fakeEl() {
  const el = {
    anims: [],
    animate(frames, timing) {
      const a = {
        frames,
        timing,
        currentTime: 0,
        state: 'running',
        timings: [],
        effect: { updateTiming: (t) => a.timings.push(t) },
        cancel: () => {
          if (a.state === 'idle') return;
          a.state = 'idle';
          queueMicrotask(() => a.oncancel?.());
        },
        pause: () => (a.state = 'paused'),
        play: () => (a.state = 'running'),
        finish: () => {
          a.state = 'finished';
          a.onfinish?.();
        },
      };
      el.anims.push(a);
      return a;
    },
  };
  return el;
}
const live = (el) => el.anims.filter((a) => a.state !== 'idle' && a.state !== 'finished');

test('config: the numbers live in ui.fx.chars and make one bob per step of the legs', () => {
  assert.equal(stepMs(cfg), 200); // legs swap every 200 ms (style.css: leg-l/leg-r .4s steps(1), two steps)
  assert.ok(cfg.bob.upPx > 0 && cfg.sit.ms > 0 && cfg.stand.ms > 0);
  const css = readFileSync(join(ROOT, 'web', 'style.css'), 'utf8');
  assert.ok(css.includes(`leg-l ${cfg.legCycleMs / 1000}s steps(1)`.replace('0.', '.')), 'legCycleMs mirrors the legs animation in style.css');
});

test('stepMs: the legs cycle divided by its steps', () => {
  assert.equal(stepMs({ legCycleMs: 400, stepsPerCycle: 2 }), 200);
  assert.equal(stepMs({ legCycleMs: 600, stepsPerCycle: 4 }), 150);
});

test('alignDelay: a bob waits for the end of a dip, rounded up to the step grid', () => {
  assert.equal(alignDelay(0, 200), 0);
  assert.equal(alignDelay(-30, 200), 0);
  assert.equal(alignDelay(1, 200), 200);
  assert.equal(alignDelay(200, 200), 200);
  assert.equal(alignDelay(201, 200), 400);
});

test('iterationsToFinish: runs on to the end of the step it is in, at least one', () => {
  assert.equal(iterationsToFinish(0.5, 200), 1);
  assert.equal(iterationsToFinish(200, 200), 1);
  assert.equal(iterationsToFinish(201, 200), 2);
  assert.equal(iterationsToFinish(1000, 200), 5);
  assert.equal(iterationsToFinish(1150, 200), 6);
});

test('frames: transform only, loop without a seam, start from the config poses', () => {
  for (const frames of [bobFrames(cfg.bob), sitFrames(cfg.sit), standFrames(cfg.stand)]) {
    for (const f of frames) assert.deepEqual(Object.keys(f).filter((k) => !['offset', 'easing', 'transform'].includes(k)), []);
    assert.equal(frames[0].offset, 0);
    assert.equal(frames.at(-1).offset, 1);
  }
  const bob = bobFrames(cfg.bob);
  assert.equal(bob[0].transform, bob[2].transform, 'a bob ends where it began');
  assert.match(bob[1].transform, /translateY\(-2px\)/);
  assert.match(sitFrames(cfg.sit)[0].transform, /translateY\(-5px\)/);
  assert.equal(sitFrames(cfg.sit).at(-1).transform, 'translateY(0px) scale(1, 1)');
  assert.equal(standFrames(cfg.stand).at(-1).transform, 'translateY(0px) scale(1, 1)');
});

test('motion: a walk starts a bob of one step and runs on to the end of the step when the walk ends', () => {
  const el = fakeEl();
  const m = createMotion(cfg, el);
  m.walking(true);
  assert.equal(el.anims.length, 1);
  assert.equal(el.anims[0].timing.duration, 200);
  assert.equal(el.anims[0].timing.iterations, Infinity);
  m.walking(true); // another piece of the same walk: no second animation
  assert.equal(el.anims.length, 1);
  el.anims[0].currentTime = 1150; // 5.75 steps in
  m.walking(false);
  assert.deepEqual(el.anims[0].timings, [{ iterations: 6 }]);
  assert.equal(m.running(), true);
  el.anims[0].finish();
  assert.equal(m.running(), true, 'the settle out of the squash runs');
  assert.equal(el.anims[1].timing.duration, cfg.settleMs);
  el.anims[1].finish();
  assert.equal(m.running(), false);
});

test('settle: the walk ends easing from the landing squash to the identity pose, never a snap', () => {
  const bob = bobFrames(cfg.bob);
  const settle = settleFrames(cfg.bob);
  assert.equal(settle[0].transform, bob.at(-1).transform, 'starts where the last bob step ends');
  assert.equal(settle.at(-1).transform, 'translateY(0px) scale(1, 1)');
  assert.ok(cfg.settleMs > 0);
});

test('motion: a walk that starts during the settle replaces it (both begin on the landing squash)', () => {
  const el = fakeEl();
  const m = createMotion(cfg, el);
  m.walking(true);
  el.anims[0].currentTime = 100;
  m.walking(false);
  el.anims[0].finish();
  m.walking(true);
  assert.equal(el.anims[1].state, 'idle', 'the settle was cancelled');
  assert.equal(el.anims[2].timing.delay, 0);
  assert.equal(live(el).length, 1);
});

test('motion: cancel (lift, floor hidden) also drops the settle at once', () => {
  const el = fakeEl();
  const m = createMotion(cfg, el);
  m.walking(true);
  el.anims[0].currentTime = 100;
  m.walking(false);
  el.anims[0].finish();
  m.cancel();
  assert.equal(live(el).length, 0);
  assert.equal(m.running(), false);
});

test('motion: a new walk before the old bob finished carries on without a seam', () => {
  const el = fakeEl();
  const m = createMotion(cfg, el);
  m.walking(true);
  el.anims[0].currentTime = 530;
  m.walking(false);
  m.walking(true);
  assert.equal(el.anims.length, 1);
  assert.deepEqual(el.anims[0].timings, [{ iterations: 3 }, { iterations: Infinity }]);
});

test('motion: a walk that ends before its first frame cancels the bob', () => {
  const el = fakeEl();
  const m = createMotion(cfg, el);
  m.walking(true);
  m.walking(false);
  assert.equal(live(el).length, 0);
});

test('motion: sit and stand play one dip; a stand-up followed by a walk starts the bob on the step grid after the dip', () => {
  const el = fakeEl();
  const m = createMotion(cfg, el);
  m.pose(true);
  assert.equal(el.anims[0].timing.duration, cfg.sit.ms);
  m.pose(false);
  assert.equal(live(el).length, 1, 'the sit dip was replaced');
  assert.equal(el.anims[1].timing.duration, cfg.stand.ms);
  el.anims[1].currentTime = 50; // 190 ms of the 240 ms dip left
  m.walking(true);
  assert.equal(el.anims[2].timing.delay, 200);
  el.anims[1].finish();
  assert.equal(m.running(), true, 'the bob still runs');
  m.cancel();
  assert.equal(live(el).length, 0);
});

test('motion: onIdle fires when the last animation is gone, pause stops and resumes what runs', async () => {
  const el = fakeEl();
  let idle = 0;
  const m = createMotion(cfg, el, () => idle++);
  m.pose(true);
  m.pause(true);
  assert.equal(el.anims[0].state, 'paused');
  m.pause(false);
  assert.equal(el.anims[0].state, 'running');
  el.anims[0].finish();
  assert.equal(idle, 1);
  m.walking(true);
  m.cancel();
  await Promise.resolve();
  assert.equal(idle, 2);
});

/** A tiny office: floors with characters, the real effects bus (createFx) and the ctx pieces fx-chars uses. */
function office({ fxOn = true, active = true } = {}) {
  const fx = createFx({ getStorage: () => ({ getItem: () => (fxOn ? '1' : '0'), setItem() {} }), matchMedia: () => null });
  fx.start({ enabled: true });
  const mk = (extra = {}) => ({ fxMove: fakeEl(), walk: null, seated: false, ...extra });
  const floor = { agents: new Map(), off: false };
  const lobby = { chars: new Map(), off: false };
  const a = mk();
  const cat = mk({ isCat: true });
  const lobbyFig = mk();
  floor.agents.set('a', a);
  floor.agents.set('cat', cat);
  lobby.chars.set('l', lobbyFig);
  const state = { active, paused: [] };
  const ctx = {
    ui: config.ui,
    fx,
    floors: () => [floor, lobby],
    floorActive: (f) => state.active && !f.off,
    onPauseChange: (fn) => state.paused.push(fn),
  };
  init(ctx);
  return { fx, floor, lobby, a, cat, lobbyFig, state };
}

test('area: walk-start bobs a character of a shown floor (the lobby too), not the cat, not a floor that is not shown', () => {
  const o = office();
  o.fx.emitFx('walk-start', { rec: o.a });
  o.fx.emitFx('walk-start', { rec: o.lobbyFig });
  o.fx.emitFx('walk-start', { rec: o.cat });
  assert.equal(live(o.a.fxMove).length, 1);
  assert.equal(live(o.lobbyFig.fxMove).length, 1);
  assert.equal(o.cat.fxMove.anims.length, 0);
  const hidden = office({ active: false });
  hidden.fx.emitFx('walk-start', { rec: hidden.a });
  assert.equal(hidden.a.fxMove.anims.length, 0);
});

test('area: a pose change plays only when animated; the effects off means nothing happens', () => {
  const o = office();
  o.fx.emitFx('pose', { rec: o.a, seated: true, animate: false });
  assert.equal(o.a.fxMove.anims.length, 0);
  o.fx.emitFx('pose', { rec: o.a, seated: true, animate: true });
  assert.equal(o.a.fxMove.anims.length, 1);
  const off = office({ fxOn: false });
  off.fx.emitFx('pose', { rec: off.a, seated: true, animate: true });
  off.fx.emitFx('walk-start', { rec: off.a });
  assert.equal(off.a.fxMove.anims.length, 0);
});

test('area: lift, a floor going off screen, the small window crop and the effects switch stop the motion', () => {
  const o = office();
  const start = () => o.fx.emitFx('walk-start', { rec: o.a });
  start();
  o.fx.emitFx('lift', { rec: o.a });
  assert.equal(live(o.a.fxMove).length, 0);
  start();
  o.fx.emitFx('floor-hidden', { floor: o.floor, removed: false });
  assert.equal(live(o.a.fxMove).length, 0);
  o.a.walk = { pieces: [] };
  o.fx.emitFx('floor-shown', { floor: o.floor });
  assert.equal(live(o.a.fxMove).length, 1, 'a walker of a floor that came back gets its bob');
  o.fx.emitFx('crop', { cropped: true, floor: o.floor });
  assert.equal(live(o.a.fxMove).length, 0);
  o.fx.emitFx('crop', { cropped: false, floor: o.floor });
  assert.equal(live(o.a.fxMove).length, 1);
  o.fx.setFx(false);
  assert.equal(live(o.a.fxMove).length, 0);
  o.fx.setFx(true);
  assert.equal(live(o.a.fxMove).length, 1, 'switched back on: the one that is walking bobs again');
});

test('area: hiding the page pauses the animations, showing it resumes them', () => {
  const o = office();
  o.fx.emitFx('walk-start', { rec: o.a });
  o.state.paused[0](true);
  assert.equal(o.a.fxMove.anims[0].state, 'paused');
  o.state.paused[0](false);
  assert.equal(o.a.fxMove.anims[0].state, 'running');
});

test('area: disabled in the config, it adds nothing', () => {
  const fx = createFx({ getStorage: () => ({ getItem: () => '1', setItem() {} }), matchMedia: () => null });
  fx.start({ enabled: true });
  const rec = { fxMove: fakeEl() };
  init({ ui: { fx: { chars: { enabled: false } } }, fx, floors: () => [{ agents: new Map([['a', rec]]) }], floorActive: () => true, onPauseChange() {} });
  fx.emitFx('walk-start', { rec });
  assert.equal(rec.fxMove.anims.length, 0);
});

test('the pose event carries animate (app.mjs setPose)', () => {
  const src = readFileSync(join(ROOT, 'web', 'app.mjs'), 'utf8');
  assert.match(src, /emitFx\('pose', \{ rec, seated: sit, animate \}\)/);
});
