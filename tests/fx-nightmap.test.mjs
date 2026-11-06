import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNightmap, monitorSpot, facePoint, poolPlan, poolKey, deskIdOf, holeAt, fillGradient, tintGradient, tintBox, lampPlans, veilSvg, veilUrl } from '../web/fx-nightmap.mjs';
import { atlasOf, loadConfig, loadData, monDrawing, rimDrawing, sceneOf, DIR } from '../scripts/make-nightmap.mjs';
import { decodePng, encodePng } from '../scripts/make-lit-sprites.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const cfg = loadConfig();
const data = loadData();
const DESIGNS = ['library', 'studio2', 'lounge', 'greenhouse', 'lobby'];

test('pool: centred between the monitor and the face (nearer the monitor), in whole pixels, keyed by desk and place; a design may have its own size', () => {
  const obj = { rect: [0, 0, 83, 57], at: [322, 250], anchor: [41, 56], flipX: false };
  const mon = monitorSpot(obj, { screen: [24, 0, 50, 15] });
  assert.deepEqual(mon, [281 + 37, 194 + 7.5]);
  const face = facePoint({ x: 322, y: 212 }, 50, cfg);
  assert.deepEqual(face, [322, 212 - 0.64 * 50]);
  const p = poolPlan(face, mon, 'desk-1', cfg);
  const { rx, ry, mix } = cfg.pool;
  assert.ok(mix < 0.5, 'the pool lies nearer the monitor than the face: the wall behind the figure falls off fast');
  assert.equal(p.cx, Math.round(318 + 4 * mix));
  assert.equal(p.cy, Math.round(201.5 + (180 - 201.5) * mix));
  assert.deepEqual([p.x, p.y, p.w, p.h], [p.cx - rx, p.cy - ry, 2 * rx, 2 * ry]);
  assert.notEqual(poolKey(p), poolKey({ ...p, cy: p.cy + 1 }));
  const flipped = monitorSpot({ ...obj, flipX: true }, { screen: [24, 0, 50, 15] });
  assert.equal(flipped[0], 322 - (83 - 41) + (83 - 37)); // mirrored inside the picture
  const lobby = poolPlan(face, mon, 'desk-1', cfg, 'lobby');
  assert.equal(lobby.rx, cfg.pool.designs.lobby.rx);
  assert.equal(lobby.ry, cfg.pool.designs.lobby.ry);
  assert.equal(poolPlan(face, mon, 'desk-1', cfg, 'library').rx, rx, 'a design without its own size keeps the common one');
});

test('desk of a seat: the lead has the lead desk, others the desk of their seat slot, a lobby figure the desk of the seat it stands at', () => {
  const r = { lead: { deskId: 'lead-desk' }, seats: [{ deskId: 'desk-1', at: [10, 20] }, { deskId: 'desk-2', at: [30, 40] }] };
  assert.equal(deskIdOf({ isLead: true }, r), 'lead-desk');
  assert.equal(deskIdOf({ slot: { kind: 'seat', i: 1 } }, r), 'desk-2');
  assert.equal(deskIdOf({ slot: { kind: 'spot' } }, r), null);
  assert.equal(deskIdOf({}, r), null);
  assert.equal(deskIdOf({ slot: null, home: { at: [30, 40] } }, r), 'desk-2');
  assert.equal(deskIdOf({ slot: null, home: { at: [31, 40] } }, r), null);
});

test('hole: 1 in the middle of a pool, 0 at its edge, falling in between', () => {
  assert.equal(holeAt(0, cfg), 1);
  assert.equal(holeAt(1, cfg), 0);
  assert.equal(holeAt(0.55, cfg), 0.72);
  assert.ok(holeAt(0.66, cfg) < 0.72 && holeAt(0.66, cfg) > 0.28);
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

test('tint: cool light, plain alpha (no blend), strongest in the middle, its box is the pool scaled about its centre', () => {
  const g = tintGradient(cfg);
  assert.ok(g.startsWith(`radial-gradient(closest-side, rgba(${cfg.tint.color.join(', ')}, ${cfg.tint.alpha}) 0%`));
  assert.ok(g.endsWith('0) 100%)'));
  assert.ok(cfg.tint.color[2] > cfg.tint.color[0] + 80, 'the screen light is blue-white');
  const t = tintBox({ cx: 100, cy: 100, rx: 58, ry: 44 }, cfg);
  assert.equal(t.w, 2 * Math.round(58 * cfg.tint.scale));
  assert.equal(t.x + t.w / 2, 100);
  assert.equal(t.y + t.h / 2, 100);
});

test('config: the night block holds every number, darker than the plain veil, falloff from 1 at the middle to 0 at the edge, no blend mode, no flicker', () => {
  const all = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8'));
  assert.ok(cfg.outside.opacity > all.ui.dark.roomDim);
  assert.equal(cfg.pool.falloff[0][1], 1);
  assert.deepEqual(cfg.pool.falloff.at(-1), [1, 0]);
  for (let i = 1; i < cfg.pool.falloff.length; i++) assert.ok(cfg.pool.falloff[i][0] > cfg.pool.falloff[i - 1][0] && cfg.pool.falloff[i][1] <= cfg.pool.falloff[i - 1][1]);
  assert.equal(cfg.dataUrl, '/assets/nightmap/nightmap.json');
  assert.ok(cfg.lamps.hole < 1, 'a lamp warms the room, it does not light it like a screen');
  assert.ok(cfg.lamps.color[0] > cfg.lamps.color[2], 'lamps are warm');
  assert.equal(JSON.stringify(cfg).includes('blend'), false);
  assert.equal(cfg.flicker, undefined);
});

test('data file: every design has monitors for its desks, a seed that is a monitor pixel, a screen inside the box; the lobby has desk and desk-b', () => {
  for (const design of DESIGNS) {
    const sc = sceneOf(design);
    const kinds = design === 'lobby' ? ['desk', 'desk-b'] : ['desk', 'lead-desk'];
    for (const kind of kinds) {
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
    assert.ok(Object.values(mon.masks).every((m) => m.size > 100), `${design}: a monitor is more than a few pixels`);
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

test('monitor copy: near-black with only a slight cool cast', () => {
  const [r, g, b] = cfg.monitor.color;
  assert.ok(Math.max(r, g, b) < 30 && b - r < 16 && cfg.monitor.opacity > 0.9);
});

test('png encoder round-trips (the generator uses it)', () => {
  const rgba = new Uint8ClampedArray([1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual([...decodePng(encodePng(2, 1, rgba)).rgba], [...rgba]);
});

test('lamps: boxes from the data file and the kinds of the config; every lamp of every design is inside the room picture', () => {
  const plans = lampPlans([{ kind: 'sconce', at: [60, 165] }, { kind: 'nope', at: [1, 1] }], cfg);
  assert.equal(plans.length, 1);
  const k = cfg.lamps.kinds.sconce;
  assert.deepEqual([plans[0].x, plans[0].y, plans[0].w, plans[0].h, plans[0].rx, plans[0].ry], [60 - k.rx, 165 - k.ry, 2 * k.rx, 2 * k.ry, k.rx, k.ry]);
  assert.deepEqual(lampPlans(undefined, cfg), []);
  for (const design of DESIGNS) {
    const [W, H] = sceneOf(design).size;
    const list = data.lamps[design];
    assert.ok(list?.length >= 3, `${design} has lamps`);
    for (const l of list) {
      assert.ok(cfg.lamps.kinds[l.kind], `${design}: kind ${l.kind}`);
      assert.ok(l.at[0] > 0 && l.at[0] < W && l.at[1] > 0 && l.at[1] < H, `${design}: ${l.at} inside ${W}x${H}`);
    }
  }
});

test('veil picture: the veil colour through a mask with one hole per pool and lamp, warm light at the lamps, a hole for the plaque; no blend mode, no tint in it', () => {
  const pools = [poolPlan([100, 100], [100, 130], 'desk-1', cfg), poolPlan([300, 100], [300, 130], 'desk-2', cfg)];
  const lamps = lampPlans([{ kind: 'sconce', at: [60, 165] }], cfg);
  const svg = veilSvg({ size: [1024, 576], pools, lamps, sign: [700, 7, 296, 33] }, cfg);
  assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="576" viewBox="0 0 1024 576"'));
  const mask = svg.slice(svg.indexOf('<mask'), svg.indexOf('</mask>'));
  assert.equal(mask.split('<ellipse').length - 1, 3, 'two pools and a lamp');
  assert.ok(mask.includes('<rect width="1024" height="576" fill="#fff"/>'));
  assert.ok(svg.includes(`fill="rgb(${cfg.outside.color.join(', ')})" fill-opacity="${cfg.outside.opacity}" mask="url(#m)"`));
  assert.equal(svg.split('fill="url(#l)"').length - 1, 1, 'one warm glow per lamp');
  assert.ok(svg.includes('<clipPath id="c"><path clip-rule="evenodd" d="M0 0H1024V576H0ZM700 7h296v33h-296Z"/></clipPath>'));
  assert.ok(svg.includes('<g clip-path="url(#c)">'));
  assert.doesNotMatch(svg, /blend|filter|<image|http:\/\/(?!www\.w3\.org)/);
  assert.equal(svg.includes('id="t"'), false, 'the cool light is not in the picture (it lies under the monitor copy)');
  const noSign = veilSvg({ size: [1024, 576], pools: [], lamps: [], sign: null }, cfg);
  assert.equal(noSign.includes('clipPath'), false);
  assert.ok(veilUrl(noSign).startsWith('url("data:image/svg+xml,%3Csvg'));
  assert.equal(veilSvg({ size: [1024, 576], pools, lamps, sign: null }, cfg), veilSvg({ size: [1024, 576], pools, lamps, sign: null }, cfg), 'the same plan gives the same picture (no rebuild for nothing)');
});

// ---- the DOM part, with a small fake document ----

function fakeEl(tag = 'div') {
  const el = {
    tag, style: Object.assign(new Map(), {}), dataset: {}, children: [], className: '', parent: null, removed: false, offsetWidth: 0, offsetLeft: 0, offsetTop: 0, offsetHeight: 0,
    classes: new Set(),
    classList: { add: (c) => el.classes.add(c), remove: (...c) => c.forEach((x) => el.classes.delete(x)), contains: (c) => el.classes.has(c) },
    append(...k) { for (const c of k) { c.parent = el; el.children.push(c); } },
    remove() { el.removed = true; if (el.parent) el.parent.children = el.parent.children.filter((c) => c !== el); },
    querySelector: () => null,
    decode: () => Promise.resolve(),
  };
  const props = {};
  el.style = new Proxy(props, { get: (t, k) => (k === 'setProperty' ? (n, v) => { t[n] = v; } : k === 'removeProperty' ? (n) => { delete t[n]; } : k === 'getPropertyValue' ? (n) => t[n] : t[k]), set: (t, k, v) => { t[k] = v; return true; } });
  return el;
}

test('disabled (the other night lights, day mode, effects off, an unknown room): nothing is built or read', () => {
  const boom = new Proxy({}, { get(_, k) { throw new Error(`touched the stage: ${String(k)}`); } });
  const ctx = { fx: { fxOn: () => true }, chars: () => { throw new Error('read the characters'); }, timers: {}, server: { sitHeight: 50 }, floors: () => [] };
  const night = createNightmap({ ctx, cfg, doc: { documentElement: {} }, modeOf: () => 'work', resync: () => {} });
  assert.equal(night.enabled(), false);
  night.sync({ stage: boom, off: false, design: 'library', scene: {} });
  night.tidy();
  night.drop({});
  assert.equal(globalThis.__fxNight, undefined, 'no debug handle is left in the shipped code');
  assert.doesNotMatch(readFileSync(join(ROOT, 'web', 'fx-nightmap.mjs'), 'utf8') + readFileSync(join(ROOT, 'web', 'fx-weather.mjs'), 'utf8'), /__fxNight|debug=nightmap/);
});

test('enabled: a working seat gets a fill, a cool light, a monitor copy and an edge light, the veil picture is set once decoded, and everything goes when the choice is switched off', async () => {
  const realFetch = globalThis.fetch;
  const realGcs = globalThis.getComputedStyle;
  globalThis.fetch = async () => ({ json: async () => data });
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => '0.5' });
  try {
    const stage = fakeEl();
    const sign = fakeEl();
    Object.assign(sign, { offsetWidth: 296, offsetHeight: 33, offsetLeft: 700, offsetTop: 7 });
    stage.querySelector = (q) => (q === '.sign' ? sign : null);
    const obj = { id: 'desk-1', kind: 'desk', rect: [0, 0, 83, 57], at: [322, 250], anchor: [41, 56], flipX: false };
    const floor = { stage, off: false, design: 'library', scene: { r: { size: [1024, 576], objects: [obj], lead: { deskId: 'lead-desk' }, seats: [{ deskId: 'desk-1', at: [1, 1] }] }, nodes: [{ id: 'desk-1', objId: 'desk-1', x: 281, y: 194, w: 83, h: 57, bgX: 0, bgY: 0, z: 1500, flipX: false }] } };
    const rec = { x: 322, y: 212, slot: { kind: 'seat', i: 0 } };
    let resyncs = 0;
    const doc = { documentElement: {}, createElement: (t) => { const e = fakeEl(t); if (t === 'img') e.decode = () => Promise.resolve(); return e; } };
    const ctx = { fx: { fxOn: () => true }, chars: () => [rec], timers: { setTimeout: (fn) => { fn.__t = true; return 1; }, clearTimeout: () => {} }, server: { sitHeight: 50 } };
    const night = createNightmap({ ctx, cfg, doc, modeOf: () => 'work', resync: () => { resyncs++; } });
    night.setEnabled(true);
    await new Promise((r) => setTimeout(r, 10));
    assert.ok(resyncs >= 2, 'the data file arrived and asked for a sync');
    night.sync(floor);
    assert.equal(stage.children.some((c) => c.className === 'fxn-p'), false, 'the plain veil under the plaque comes with the picture, in the same frame');
    await new Promise((r) => setTimeout(r, 10));
    const kinds = stage.children.map((c) => c.className);
    assert.ok(['fxn-f', 'fxn-t', 'fxn-m', 'fxn-r', 'fxn-p'].every((k) => kinds.includes(k)), kinds.join(' '));
    assert.equal(stage.children.find((c) => c.className === 'fxn-p').style.width, '298px', 'the plain veil under the plaque is a pixel wider all round');
    assert.ok(stage.classes.has('fxn-on'));
    assert.match(stage.style['--fxn-img'], /^url\("data:image\/svg\+xml,/);
    assert.ok(stage.children.filter((c) => c.className !== 'fxn-p').every((c) => c.dataset.on === '1'), 'the pool fades in once the picture is there');
    const fill = stage.children.find((c) => c.className === 'fxn-f');
    const tint = stage.children.find((c) => c.className === 'fxn-t');
    const mon = stage.children.find((c) => c.className === 'fxn-m');
    assert.ok(Number(tint.style.zIndex) < Number(mon.style.zIndex), 'the cool light lies under the monitor copy');
    assert.equal(fill.style.zIndex, '7500');
    night.setEnabled(false);
    assert.equal(stage.children.length, 0, 'everything is taken away');
    assert.equal(stage.classes.has('fxn-on'), false);
    assert.equal(stage.style['--fxn-img'], undefined);
  } finally {
    globalThis.fetch = realFetch;
    globalThis.getComputedStyle = realGcs;
  }
});

test('a newer picture built for another reason (the plaque grows) does not leave a pool dark, and the plaque follows its size at once', async () => {
  const realFetch = globalThis.fetch;
  const realGcs = globalThis.getComputedStyle;
  const realRo = globalThis.ResizeObserver;
  globalThis.fetch = async () => ({ json: async () => data });
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => '0.5' });
  let roCallback = null;
  let roSeen = 0;
  globalThis.ResizeObserver = class { constructor(cb) { roCallback = cb; } observe() { roSeen++; } disconnect() { roCallback = null; } };
  try {
    const stage = fakeEl();
    const sign = fakeEl();
    Object.assign(sign, { offsetWidth: 296, offsetHeight: 33, offsetLeft: 700, offsetTop: 7 });
    stage.querySelector = (q) => (q === '.sign' ? sign : null);
    const obj = { id: 'desk-1', kind: 'desk', rect: [0, 0, 83, 57], at: [322, 250], anchor: [41, 56], flipX: false };
    const floor = { stage, off: false, design: 'library', scene: { r: { size: [1024, 576], objects: [obj], lead: { deskId: 'lead-desk' }, seats: [{ deskId: 'desk-1', at: [1, 1] }] }, nodes: [{ id: 'desk-1', objId: 'desk-1', x: 281, y: 194, w: 83, h: 57, bgX: 0, bgY: 0, z: 1500, flipX: false }] } };
    const rec = { x: 322, y: 212, slot: { kind: 'seat', i: 0 } };
    const decodes = [];
    const doc = { documentElement: {}, createElement: (t) => { const e = fakeEl(t); if (t === 'img') e.decode = () => new Promise((res) => decodes.push(res)); return e; } };
    const ctx = { fx: { fxOn: () => true }, chars: () => [rec], timers: { setTimeout: () => 1, clearTimeout: () => {} }, server: { sitHeight: 50 } };
    const night = createNightmap({ ctx, cfg, doc, modeOf: () => 'work', resync: () => {} });
    night.setEnabled(true);
    await new Promise((r) => setTimeout(r, 10));
    night.sync(floor); // picture A (with the new pool) starts decoding
    assert.equal(roSeen, 1, 'the plaque is watched');
    sign.offsetWidth = 316; // the plaque grows while A decodes
    roCallback(); // picture B, built for the new plaque only (no new pool)
    assert.equal(decodes.length, 2);
    decodes[0](); // A lands late and is out of date: it shows nothing
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(stage.classes.has('fxn-on'), false);
    decodes[1]();
    await new Promise((r) => setTimeout(r, 5));
    assert.ok(stage.classes.has('fxn-on'));
    assert.ok(stage.children.filter((c) => c.className !== 'fxn-p').every((c) => c.dataset.on === '1'), 'the pool is lit by the picture that did land');
    assert.equal(stage.children.find((c) => c.className === 'fxn-p').style.width, '318px', 'the plain veil under the plaque has the new size');
    night.setEnabled(false);
    assert.equal(roCallback, null, 'the watcher goes with the stage');
  } finally {
    globalThis.fetch = realFetch;
    globalThis.getComputedStyle = realGcs;
    globalThis.ResizeObserver = realRo;
  }
});

test('effects off with the real night chosen: the weather area asks for no sync (no timer, no layer)', () => {
  const src = readFileSync(join(ROOT, 'web', 'fx-weather.mjs'), 'utf8');
  assert.match(src, /resync: \(\) => \{ if \(fx\.fxOn\(\)\) later\(false\); \}/);
});

test('css: the module prefix, plain alpha (no blend, no mask, no contain), opacity fades only, the veil one layer under the fills, no motion under reduced motion', () => {
  const css = readFileSync(join(ROOT, 'web', 'fx-weather.css'), 'utf8');
  const block = css.slice(css.indexOf('/* The real night')).replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(block, /mix-blend-mode|background-blend-mode|mask|clip-path|filter|contain:/);
  assert.match(block, /\.fx-on \.stage\.fxn-on::after \{ z-index: 7499; background: var\(--fxn-img\)/);
  assert.match(block, /\.fxn-f, \.fxn-t, \.fxn-m, \.fxn-r \{ position: absolute; pointer-events: none;/);
  assert.match(block, /\.fxn-p \{[^}]*background: rgb\(6, 9, 28\); opacity: var\(--room-dim\)/);
  assert.match(css.slice(css.lastIndexOf('@media (prefers-reduced-motion: reduce)')), /\.fxn-f, \.fxn-t, \.fxn-m, \.fxn-r \{ animation: none !important; transition: none !important; \}/);
  assert.doesNotMatch(block, /@keyframes|animation: fxn/);
  const style = readFileSync(join(ROOT, 'web', 'style.css'), 'utf8');
  assert.match(style, /\.stage::after \{ content: ""; position: absolute; inset: 0; z-index: 7500; pointer-events: none; background: rgb\(6, 9, 28\); opacity: var\(--room-dim\); \}/, 'today\'s veil is untouched');
});

// ---- the lead (and any seated figure that is waiting) keeps its pool: the pool follows the face light's own decision, working and idle alike ----

test('the real night: a seated lead and a seated staff member get the same pool in every state the face light lights (working, thinking, idle), none when standing, away or in a state without light', async () => {
  const { litMode } = await import('../web/fx-weather.mjs');
  const wcfg = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8')).ui.fx.weather;
  const realFetch = globalThis.fetch;
  const realGcs = globalThis.getComputedStyle;
  globalThis.fetch = async () => ({ json: async () => data });
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => '0.5' });
  try {
    const deskObj = { id: 'desk-1', kind: 'desk', rect: [0, 0, 83, 57], at: [322, 250], anchor: [41, 56], flipX: false };
    const leadObj = { id: 'lead-desk', kind: 'lead-desk', rect: [0, 0, 83, 57], at: [622, 250], anchor: [41, 56], flipX: false };
    const nodes = [
      { id: 'desk-1', objId: 'desk-1', x: 281, y: 194, w: 83, h: 57, bgX: 0, bgY: 0, z: 1500, flipX: false },
      { id: 'lead-desk', objId: 'lead-desk', x: 581, y: 194, w: 83, h: 57, bgX: 0, bgY: 0, z: 1500, flipX: false },
    ];
    const fills = async (rec) => {
      const stage = fakeEl();
      stage.querySelector = () => null;
      const floor = { stage, off: false, design: 'library', scene: { r: { size: [1024, 576], objects: [deskObj, leadObj], lead: { deskId: 'lead-desk' }, seats: [{ deskId: 'desk-1', at: [1, 1] }] }, nodes } };
      const doc = { documentElement: {}, createElement: (t) => { const e = fakeEl(t); if (t === 'img') e.decode = () => Promise.resolve(); return e; } };
      const ctx = { fx: { fxOn: () => true }, chars: () => [rec], timers: { setTimeout: () => 1, clearTimeout: () => {} }, server: { sitHeight: 50 } };
      const night = createNightmap({ ctx, cfg, doc, modeOf: (r) => litMode(r, wcfg), resync: () => {} });
      night.setEnabled(true);
      await new Promise((r) => setTimeout(r, 10));
      night.sync(floor);
      await new Promise((r) => setTimeout(r, 10));
      const n = stage.children.filter((c) => c.className === 'fxn-f').length;
      night.setEnabled(false);
      return n;
    };
    const lead = (o) => ({ isLead: true, seated: true, x: 622, y: 212, state: 'working', ...o });
    const staff = (o) => ({ isLead: false, seated: true, x: 322, y: 212, slot: { kind: 'seat', i: 0 }, state: 'working', ...o });
    for (const [state, want] of [['working', 1], ['thinking', 1], ['idle', 1], ['enter', 0], ['stale', 0], ['done', 0]]) {
      assert.equal(await fills(staff({ state })), want, `staff ${state}`);
      assert.equal(await fills(lead({ state })), want, `lead ${state}`);
    }
    assert.equal(await fills(lead({ seated: false, state: 'idle' })), 0, 'a standing lead has no pool');
    assert.equal(await fills(staff({ seated: false })), 0, 'a standing staff member has no pool');
    assert.equal(await fills(lead({ away: true, state: 'idle' })), 0, 'a lead away on a trip has no pool');
  } finally {
    globalThis.fetch = realFetch;
    globalThis.getComputedStyle = realGcs;
  }
});
