import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNightmap, VARIANTS, isVariant, monitorSpot, facePoint, poolPlan, poolKey, deskIdOf, maskParts, maskGradient, fillGradient, tintBox, stageVars, hazePlan, lampPlans, lampMaskGradient, lampGlowGradient } from '../web/fx-nightmap.mjs';
import { atlasOf, loadConfig, loadData, monDrawing, rimDrawing, sceneOf, DIR } from '../scripts/make-nightmap.mjs';
import { decodePng, encodePng } from '../scripts/make-lit-sprites.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const cfg = loadConfig();
const data = loadData();

test('variants: v0 is the page as it was, v1 and v2 add features, v3 adds the haze and v4 the lamps on top of v2', () => {
  assert.deepEqual(Object.keys(VARIANTS), ['v0', 'v1', 'v2', 'v3', 'v4']);
  assert.deepEqual({ ...VARIANTS.v0 }, {});
  assert.ok(VARIANTS.v1.veil && VARIANTS.v1.pool && !VARIANTS.v1.rim && !VARIANTS.v1.flicker);
  assert.ok(VARIANTS.v2.veil && VARIANTS.v2.pool && VARIANTS.v2.rim && VARIANTS.v2.flicker);
  assert.ok(VARIANTS.v3.haze && !VARIANTS.v3.lamps && VARIANTS.v4.lamps && !VARIANTS.v4.haze);
  for (const v of ['v3', 'v4']) assert.ok(VARIANTS[v].veil && VARIANTS[v].pool && VARIANTS[v].rim && VARIANTS[v].flicker, `${v} = v2 plus one feature`);
  assert.ok(isVariant('v4') && !isVariant('v9') && !isVariant(undefined));
});

test('pool: centred between the monitor and the face, in whole pixels, keyed by desk and place', () => {
  const obj = { rect: [0, 0, 83, 57], at: [322, 250], anchor: [41, 56], flipX: false };
  const mon = monitorSpot(obj, { screen: [24, 0, 50, 15] });
  assert.deepEqual(mon, [281 + 37, 194 + 7.5]);
  const face = facePoint({ x: 322, y: 212 }, 50, cfg);
  assert.deepEqual(face, [322, 212 - 0.64 * 50]);
  const p = poolPlan(face, mon, 'desk-1', cfg);
  assert.equal(p.cx, Math.round(318 + 4 * 0.5));
  assert.equal(p.cy, Math.round(201.5 + (180 - 201.5) * 0.5));
  assert.deepEqual([p.x, p.y, p.w, p.h], [p.cx - cfg.pool.rx, p.cy - cfg.pool.ry, 2 * cfg.pool.rx, 2 * cfg.pool.ry]);
  assert.notEqual(poolKey(p), poolKey({ ...p, cy: p.cy + 1 }));
  const flipped = monitorSpot({ ...obj, flipX: true }, { screen: [24, 0, 50, 15] });
  assert.equal(flipped[0], 322 - (83 - 41) + (83 - 37)); // mirrored inside the picture
});

test('desk of a seat: the lead has the lead desk, others the desk of their seat slot', () => {
  const r = { lead: { deskId: 'lead-desk' }, seats: [{ deskId: 'desk-1' }, { deskId: 'desk-2' }] };
  assert.equal(deskIdOf({ isLead: true }, r), 'lead-desk');
  assert.equal(deskIdOf({ slot: { kind: 'seat', i: 1 } }, r), 'desk-2');
  assert.equal(deskIdOf({ slot: { kind: 'spot' } }, r), null);
  assert.equal(deskIdOf({}, r), null);
});

test('mask: the whole veil minus the holes of every pool, one layer per pool', () => {
  assert.equal(maskParts([], cfg).mi, 'none');
  const pools = [{ x: 10, y: 20, w: 116, h: 88 }, { x: 200, y: 20, w: 116, h: 88 }];
  const m = maskParts(pools, cfg);
  assert.equal(m.mi.split('radial-gradient').length - 1, 2);
  assert.equal(m.mc, 'subtract, add, add');
  assert.equal(m.ms, '100% 100%, 116px 88px, 116px 88px');
  assert.equal(m.mp, '0 0, 10px 20px, 200px 20px');
  assert.match(maskGradient(cfg), /^radial-gradient\(closest-side, rgba\(0, 0, 0, 1\) 0%/);
  assert.match(maskGradient(cfg), /rgba\(0, 0, 0, 0\) 100%\)$/);
});

test('fill: veil + fill give exactly the plain veil at every stop (so a pool fades in and out without a jump)', () => {
  const o = cfg.outside.opacity;
  const stops = [...fillGradient(cfg).matchAll(/rgba\(\d+, \d+, \d+, ([\d.]+)\) ([\d.]+)%/g)];
  assert.equal(stops.length, cfg.pool.falloff.length);
  stops.forEach((s, i) => {
    const h = cfg.pool.falloff[i][1];
    const veil = o * (1 - h);
    assert.ok(Math.abs(1 - (1 - veil) * (1 - Number(s[1])) - o) < 0.002, `stop ${i}`);
  });
});

test('stage vars and tint box carry the config numbers', () => {
  const v = stageVars([], cfg);
  assert.equal(v['--fxn-o'], String(cfg.outside.opacity));
  assert.equal(v['--fxn-dim'], String(cfg.flicker.dim));
  const t = tintBox({ cx: 100, cy: 100, rx: 58, ry: 44 }, cfg);
  assert.equal(t.w, 2 * Math.round(58 * cfg.tint.scale));
  assert.equal(t.x + t.w / 2, 100);
});

test('config: the night block holds every number, darker than the plain veil, falloff from 1 at the middle to 0 at the edge', () => {
  const plain = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8')).ui.dark.roomDim;
  assert.ok(cfg.outside.opacity > plain);
  assert.equal(cfg.pool.falloff[0][1], 1);
  assert.deepEqual(cfg.pool.falloff.at(-1), [1, 0]);
  for (let i = 1; i < cfg.pool.falloff.length; i++) assert.ok(cfg.pool.falloff[i][0] > cfg.pool.falloff[i - 1][0] && cfg.pool.falloff[i][1] <= cfg.pool.falloff[i - 1][1]);
  assert.equal(cfg.dataUrl, '/assets/nightmap/nightmap.json');
});

test('data file: every design of the rooms has a monitor for the desk and the lead desk, a seed that is a monitor pixel, a screen inside the box', () => {
  for (const design of ['library', 'studio2', 'lounge', 'greenhouse']) {
    const sc = sceneOf(design);
    for (const kind of ['desk', 'lead-desk']) {
      const spec = data.monitors[design][kind];
      assert.ok(spec && sc.kinds[kind], `${design}/${kind}`);
      const [bx0, by0, bx1, by1] = spec.box;
      const [sx0, sy0, sx1, sy1] = spec.screen;
      assert.ok(sx0 >= bx0 && sy0 >= by0 - 1 && sx1 <= bx1 + 1 && sy1 <= by1, `${design}/${kind}: the screen is in the box`);
      assert.ok(bx1 <= sc.kinds[kind].rect[2] && by1 <= sc.kinds[kind].rect[3]);
    }
  }
});

test('pictures: <design>-mon.png and <design>-rim.png are what make-nightmap draws now (run node scripts/make-nightmap.mjs when this fails)', () => {
  for (const design of Object.keys(data.monitors)) {
    const mon = monDrawing(design, data, cfg);
    assert.ok(Object.values(mon.masks).every((m) => m.size > 150), `${design}: a monitor is more than a few pixels`);
    const rim = rimDrawing(mon, cfg);
    for (const [file, d] of [['mon', mon], ['rim', rim]]) {
      const got = decodePng(readFileSync(join(DIR, `${design}-${file}.png`)));
      assert.equal(got.w, d.w);
      assert.equal(got.h, d.h);
      assert.deepEqual(Buffer.from(got.rgba), Buffer.from(d.rgba), `${design}-${file}.png`);
    }
    const atlas = atlasOf(design);
    assert.equal(mon.w, atlas.w);
    for (let i = 0; i < rim.w * rim.h; i++) if (rim.rgba[i * 4 + 3]) assert.equal(atlas.rgba[i * 4 + 3], 0, 'the rim is drawn only where the room picture is transparent');
  }
});

test('png encoder round-trips (the generator uses it)', () => {
  const rgba = new Uint8ClampedArray([1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual([...decodePng(encodePng(2, 1, rgba)).rgba], [...rgba]);
});

test('v0 (the default) touches nothing: no element, no class, no debug handle without ?debug=nightmap', () => {
  const boom = new Proxy({}, { get(_, k) { throw new Error(`v0 touched the stage: ${String(k)}`); } });
  const ctx = { fx: { fxOn: () => true }, chars: () => { throw new Error('v0 read the characters'); }, timers: {}, server: { sitHeight: 50 } };
  const night = createNightmap({ ctx, cfg, doc: { documentElement: {} }, modeOf: () => 'work', timingOf: () => null, resync: () => {}, debug: false });
  assert.equal(night.variant(), 'v0');
  night.sync({ stage: boom, off: false, design: 'library', scene: {} });
  night.tidy();
  assert.equal(globalThis.__fxNight, undefined);
  assert.equal(night.setVariant('v9'), false);
});

test('haze: a cone from the monitor towards the face, a square box round the monitor, two layers multiplied (no alpha, no mask)', () => {
  const h = hazePlan([300, 200], [300, 170], cfg); // the face straight above the monitor
  assert.equal(h.angle, 0);
  assert.equal(h.len, Math.max(cfg.haze.minLen, Math.round(30 * cfg.haze.lenMul)));
  assert.deepEqual([h.x, h.y, h.w, h.h], [300 - h.len, 200 - h.len, 2 * h.len, 2 * h.len]);
  assert.ok(h.bg.startsWith(`conic-gradient(from -${cfg.haze.halfAngle}deg at 50% 50%, #000 0deg`));
  assert.ok(h.bg.includes('radial-gradient(circle closest-side, rgb(255, 255, 255) 0%'));
  assert.doesNotMatch(h.bg, /rgba/);
  const right = hazePlan([300, 200], [330, 200], cfg); // the face to the right: 90 degrees clockwise from up
  assert.equal(right.angle, 90);
  assert.equal(hazePlan([300, 200], [301, 201], cfg).angle, 0); // a face on top of the monitor: straight up, no division by nothing
  assert.ok(cfg.haze.strength <= 0.5 && cfg.haze.halfAngle < 45, 'the haze stays faint and narrow');
});

test('lamps: boxes from the data file and the kinds of the config, a partial hole in the veil mask, warm glow', () => {
  const plans = lampPlans([{ kind: 'sconce', at: [60, 165] }, { kind: 'nope', at: [1, 1] }], cfg);
  assert.equal(plans.length, 1);
  const k = cfg.lamps.kinds.sconce;
  assert.deepEqual([plans[0].x, plans[0].y, plans[0].w, plans[0].h], [60 - k.rx, 165 - k.ry, 2 * k.rx, 2 * k.ry]);
  assert.deepEqual(lampPlans(undefined, cfg), []);
  const m = maskParts([{ x: 10, y: 20, w: 116, h: 88 }], cfg, plans);
  assert.equal(m.mc, 'subtract, add, add');
  assert.equal(m.mi.split('radial-gradient').length - 1, 2);
  assert.equal(m.mp.split(', ').length, 3);
  assert.equal(maskParts([], cfg, []).mi, 'none');
  assert.ok(maskParts([], cfg, plans).mi.startsWith('linear-gradient(#000, #000), radial-gradient'));
  assert.ok(lampMaskGradient(cfg).includes(`rgba(0, 0, 0, ${cfg.lamps.hole}) 0%`), 'the lamp hole is only cfg.lamps.hole deep');
  assert.ok(cfg.lamps.hole < 1);
  assert.ok(lampGlowGradient(cfg).startsWith('radial-gradient(closest-side, rgba(255, 170, 90, '));
  assert.ok(lampGlowGradient(cfg).endsWith('rgba(255, 170, 90, 0) 100%)'));
});

test('data file: the lamps of every design use kinds the config knows and lie inside the room picture', () => {
  for (const design of ['library', 'studio2', 'lounge', 'greenhouse']) {
    const [W, H] = sceneOf(design).size;
    const list = data.lamps[design];
    assert.ok(list?.length >= 3, `${design} has lamps`);
    for (const l of list) {
      assert.ok(cfg.lamps.kinds[l.kind], `${design}: kind ${l.kind}`);
      assert.ok(l.at[0] > 0 && l.at[0] < W && l.at[1] > 0 && l.at[1] < H, `${design}: ${l.at} inside ${W}x${H}`);
    }
  }
});

test('css: the haze and the lamps carry the module prefix, contain: paint, and no motion under reduced motion', () => {
  const css = readFileSync(join(ROOT, 'web', 'fx-weather.css'), 'utf8');
  assert.ok(css.includes('.fxn-t, .fxn-f, .fxn-m, .fxn-r, .fxn-h, .fxn-l { position: absolute; pointer-events: none; contain: paint;'));
  const reduced = css.slice(css.lastIndexOf('@media (prefers-reduced-motion: reduce)'));
  assert.ok(reduced.includes('.fxn-h, .fxn-l { animation: none !important; transition: none !important; }'));
  assert.ok(css.includes('.fxn-fl .fxn-h[data-on="1"]'));
});
