import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFx } from '../web/fx.mjs';
import { createEvents, createPools, frames, planConfetti, planFail, planGlow, planHighFive, planSparkle, planThink, planTitle } from '../web/fx-events.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8')).ui.fx.events;
const seq = () => { let i = 0; return () => ((i++ * 0.37) % 1); }; // a fixed, spread-out rng

const fakeEl = () => {
  const el = { className: '', textContent: '', parent: null, style: { cssText: '', props: {}, setProperty(k, v) { el.style.props[k] = v; } } };
  el.remove = () => { if (el.parent) el.parent.children.delete(el); el.parent = null; };
  return el;
};
const fakeLayer = () => {
  const l = { children: new Set() };
  l.append = (el) => { el.parent = l; l.children.add(el); };
  return l;
};
const cloudMood = { el: { classList: { contains: (c) => c === 'cloud' } } };
const sweatMood = { el: { classList: { contains: () => false } } };

/** A fake office: switchboard (real), two floors, an animate that records and lets the test finish animations. */
function make({ fxOn = true, ui = { fx: { events: cfg } } } = {}) {
  const fx = createFx({ getStorage: () => ({ getItem: () => null, setItem() {} }), matchMedia: () => null });
  fx.start({ enabled: fxOn, sound: false, volume: 0 }, null);
  const pauseFns = new Set();
  const state = { paused: false, now: 1000, timeouts: [] };
  const floors = [
    { layer: fakeLayer(), off: false, agents: new Map(), wb: { frame: { x: 100, y: 40, w: 60, h: 30 } }, scene: { raw: { meeting: { boss: { at: [120, 200] } } } } },
    { layer: fakeLayer(), off: false, agents: new Map(), scene: { raw: {} } },
  ];
  const rec = (floor, extra = {}) => {
    const r = { x: 50, y: 150, seated: false, state: 'working', el: { classList: { contains: () => false } }, frec: floor, ...extra };
    floor.agents.set(`k${floor.agents.size}`, r);
    return r;
  };
  const ctx = {
    ui, fx,
    floors: () => floors,
    floorActive: (f) => !f.off && !state.paused,
    onPauseChange: (fn) => (pauseFns.add(fn), () => pauseFns.delete(fn)),
    now: () => state.now,
    timers: { setTimeout: (fn) => state.timeouts.push(fn), clearTimeout() {} },
  };
  const anims = [];
  const area = createEvents(ctx, {
    makeEl: fakeEl,
    animate: (el, kf, opts, done) => {
      const a = { el, kf, opts, done, cancelled: false };
      anims.push(a);
      return () => { a.cancelled = true; };
    },
    rng: seq(),
  });
  const flush = () => { for (const fn of state.timeouts.splice(0)) fn(); };
  return { fx, ctx, area, floors, rec, anims, state, flush, pauseFns, finish: (a) => a.done() };
}

test('keyframes animate only transform and opacity (plus timing keys)', () => {
  const specs = [
    ...planSparkle(cfg, seq()), ...planConfetti(cfg, seq()), ...planTitle(cfg, 'title'), ...planHighFive(cfg, seq()),
    ...planFail(cfg, 'cloud', false), ...planFail(cfg, 'sweat', true), ...planGlow(cfg, seq()), ...planThink(cfg),
  ];
  const motions = new Set();
  for (const s of specs) {
    motions.add(s.motion);
    for (const kf of frames(s)) for (const k of Object.keys(kf)) assert.ok(['transform', 'opacity', 'offset', 'easing'].includes(k), `${s.motion}: ${k}`);
  }
  assert.deepEqual([...motions].sort(), ['arc', 'burst', 'drift', 'flick', 'glow', 'loop', 'pop']);
});

test('plans follow the configured counts; the title is clipped and empty titles give nothing', () => {
  assert.equal(planSparkle(cfg, seq()).length, cfg.sparkle.count);
  assert.equal(planConfetti(cfg, seq()).length, cfg.confetti.count);
  assert.equal(planConfetti(cfg, seq(), 3).length, 3);
  assert.equal(planHighFive(cfg, seq()).length, cfg.highFive.count);
  assert.equal(planFail(cfg, 'cloud', false).length, cfg.rain.drops);
  assert.equal(planFail(cfg, 'sweat', false).length, cfg.sweat.drops);
  assert.equal(planGlow(cfg, seq()).length, 1 + cfg.glow.sparkles);
  assert.equal(planThink(cfg).length, cfg.think.dots);
  assert.equal(planTitle(cfg, 'x'.repeat(40))[0].text.length, cfg.title.maxChars);
  assert.deepEqual(planTitle(cfg, ''), []);
});

test('pool: never more than size in use, elements are reused', () => {
  let made = 0;
  const pools = createPools(3, () => ({ id: ++made }));
  const layer = {};
  const a = pools.take(layer);
  const b = pools.take(layer);
  const c = pools.take(layer);
  assert.equal(pools.take(layer), null);
  pools.give(layer, b);
  assert.equal(pools.take(layer), b);
  pools.give(layer, a);
  pools.give(layer, c);
  assert.equal(made, 3);
  assert.deepEqual(pools.stats(layer), { made: 3, used: 1, free: 2 });
  assert.ok(pools.take({}), 'another layer has its own pool');
});

test('a burst bigger than the pool is cut at the pool size and the layer empties when the animations end', () => {
  const t = make({ ui: { fx: { events: { ...cfg, pool: 5 } } } });
  const [f] = t.floors;
  t.fx.emitFx('phase', { floor: f, title: 'a' });
  assert.equal(f.layer.children.size, 5);
  assert.equal(t.anims.length, 5);
  for (const a of [...t.anims]) t.finish(a);
  assert.equal(f.layer.children.size, 0);
  t.fx.emitFx('phase', { floor: f, title: 'b' });
  assert.equal(t.area.pools.stats(f.layer).made, 5, 'reused, not grown');
  assert.equal(f.layer.children.size, 5);
});

test('report: sparkles at the reporter and the lead', () => {
  const t = make();
  const [f] = t.floors;
  const a = t.rec(f, { x: 40, y: 100 });
  const lead = t.rec(f, { x: 90, y: 100 });
  t.fx.emitFx('report', { rec: a, lead });
  assert.equal(f.layer.children.size, cfg.sparkle.count + cfg.sparkle.leadCount);
  assert.ok([...f.layer.children].every((e) => e.className === 'fxe star'));
  assert.equal(parseFloat([...f.layer.children][0].style.top), 100 - cfg.headStandPx);
});

test('phase: a title pop and confetti at the board; meeting-start: confetti at the boss spot; none on a hidden floor', () => {
  const t = make();
  const [f, g] = t.floors;
  t.fx.emitFx('phase', { floor: f, title: 'review' });
  const kids = [...f.layer.children];
  assert.equal(kids.filter((e) => e.className === 'fxe title').length, 1);
  assert.equal(kids.filter((e) => e.className === 'fxe rect').length, cfg.confetti.count);
  assert.equal(kids.find((e) => e.className === 'fxe title').textContent, 'review');
  t.fx.emitFx('meeting-start', { floor: g, title: 'review' }); // a floor without a board or a boss spot: nothing
  assert.equal(g.layer.children.size, 0);
  const before = f.layer.children.size;
  t.fx.emitFx('meeting-start', { floor: f, title: 'review' });
  assert.equal(f.layer.children.size - before, cfg.confetti.meetingCount);
  f.off = true;
  t.fx.emitFx('phase', { floor: f, title: 'x' });
  assert.equal(f.layer.children.size - before, cfg.confetti.meetingCount, 'not shown: nothing added');
});

test('high-five: sparks between the two', () => {
  const t = make();
  const [f] = t.floors;
  t.fx.emitFx('high-five', { a: t.rec(f), b: t.rec(f, { x: 70 }) });
  assert.equal(f.layer.children.size, cfg.highFive.count);
});

test('fail: rain loops while the mood shows and stops at fail-end; a new failure restarts it without growing', () => {
  const t = make();
  const [f] = t.floors;
  const r = t.rec(f, { mood: cloudMood });
  t.fx.emitFx('fail-start', { rec: r });
  assert.equal(f.layer.children.size, cfg.rain.drops);
  assert.ok(t.anims.every((a) => a.opts.iterations === Infinity));
  t.fx.emitFx('fail-start', { rec: r });
  assert.equal(f.layer.children.size, cfg.rain.drops);
  assert.equal(t.area.pools.stats(f.layer).made, cfg.rain.drops);
  t.fx.emitFx('fail-end', { rec: r });
  assert.equal(f.layer.children.size, 0);
  assert.ok(t.anims.every((a) => a.cancelled));
  const s = t.rec(f, { mood: sweatMood });
  t.fx.emitFx('fail-start', { rec: s });
  assert.equal([...f.layer.children][0].className, 'fxe sweat');
});

test('fail follows the character: off while it walks, back where it stops', () => {
  const t = make();
  const [f] = t.floors;
  const r = t.rec(f, { mood: cloudMood });
  t.fx.emitFx('fail-start', { rec: r });
  r.walk = {};
  t.fx.emitFx('walk-start', { rec: r });
  assert.equal(f.layer.children.size, 0);
  r.walk = null;
  r.x = 200;
  t.fx.emitFx('walk-end', { rec: r });
  assert.equal(f.layer.children.size, cfg.rain.drops);
  assert.ok([...f.layer.children].every((e) => parseFloat(e.style.left) > 150));
});

test('state: done glows once it stands (or arrives), thinking puffs dots with a cooldown, first sight is ignored', () => {
  const t = make();
  const [f] = t.floors;
  const r = t.rec(f, { state: 'done' });
  t.fx.emitFx('state', { rec: r, from: '', to: 'done' });
  t.flush();
  assert.equal(f.layer.children.size, 0);
  t.fx.emitFx('state', { rec: r, from: 'working', to: 'done' });
  assert.equal(f.layer.children.size, 0, 'looks after renderAgent is through');
  t.flush();
  assert.equal(f.layer.children.size, 1 + cfg.glow.sparkles);
  for (const a of [...t.anims]) t.finish(a);
  const w = t.rec(f, { state: 'done', walk: {} });
  t.fx.emitFx('state', { rec: w, from: 'working', to: 'done' });
  t.flush();
  assert.equal(f.layer.children.size, 0, 'walking to the tray: waits');
  w.walk = null;
  t.fx.emitFx('walk-end', { rec: w });
  assert.equal(f.layer.children.size, 1 + cfg.glow.sparkles);
  for (const a of [...t.anims]) t.finish(a);
  const th = t.rec(f, { state: 'thinking' });
  t.fx.emitFx('state', { rec: th, from: 'working', to: 'thinking' });
  assert.equal(f.layer.children.size, cfg.think.dots);
  for (const a of [...t.anims]) t.finish(a);
  t.state.now += cfg.think.cooldownMs - 1;
  t.fx.emitFx('state', { rec: th, from: 'idle', to: 'thinking' });
  assert.equal(f.layer.children.size, 0);
  t.state.now += 2;
  t.fx.emitFx('state', { rec: th, from: 'idle', to: 'thinking' });
  assert.equal(f.layer.children.size, cfg.think.dots);
});

test('no work while effects are off; turning them off tidies everything; back on restores a showing failure mood', () => {
  const off = make({ fxOn: false });
  const [fo] = off.floors;
  off.fx.emitFx('phase', { floor: fo, title: 'x' });
  off.fx.emitFx('report', { rec: off.rec(fo), lead: off.rec(fo) });
  off.fx.emitFx('state', { rec: off.rec(fo), from: 'a', to: 'done' });
  assert.equal(off.anims.length, 0);
  assert.equal(fo.layer.children.size, 0);
  assert.equal(off.state.timeouts.length, 0);

  const t = make();
  const [f] = t.floors;
  const r = t.rec(f, { mood: cloudMood });
  t.fx.emitFx('fail-start', { rec: r });
  t.fx.emitFx('phase', { floor: f, title: 'x' });
  assert.ok(f.layer.children.size > 0);
  t.fx.setFx(false);
  assert.equal(f.layer.children.size, 0);
  assert.equal(t.area.stats().active, 0);
  t.fx.setFx(true);
  assert.equal(f.layer.children.size, cfg.rain.drops);
});

test('hidden floor and a hidden page clear the effects; coming back restores the failure mood only', () => {
  const t = make();
  const [f] = t.floors;
  const r = t.rec(f, { mood: cloudMood });
  t.fx.emitFx('fail-start', { rec: r });
  t.fx.emitFx('phase', { floor: f, title: 'x' });
  f.off = true;
  t.fx.emitFx('floor-hidden', { floor: f, removed: false });
  assert.equal(f.layer.children.size, 0);
  f.off = false;
  t.fx.emitFx('floor-shown', { floor: f });
  assert.equal(f.layer.children.size, cfg.rain.drops);
  t.state.paused = true;
  for (const fn of t.pauseFns) fn(true);
  assert.equal(f.layer.children.size, 0);
  t.state.paused = false;
  for (const fn of t.pauseFns) fn(false);
  assert.equal(f.layer.children.size, cfg.rain.drops);
});

test('the area has no timers or frame loops of its own and its css animates nothing itself', () => {
  const src = readFileSync(join(ROOT, 'web', 'fx-events.mjs'), 'utf8');
  assert.doesNotMatch(src, /\bsetInterval\b|requestAnimationFrame/);
  assert.doesNotMatch(src, /(^|[^.\w])setTimeout/m);
  const css = readFileSync(join(ROOT, 'web', 'fx-events.css'), 'utf8');
  assert.doesNotMatch(css, /@keyframes|transition|animation/);
});
