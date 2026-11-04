// Tests of the pure parts of web/fx-weather.mjs: seeded tiles, pixel-art clouds, layers per weather, light plan and cross-fade timing, lightning schedule bounds, face light mode and timing,
// and of the way the weather sits in the scene (outside the glass: under the room picture, clouds in the sky mask only, one sky per floor).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { litSources, litOf, decodePng, encodePng, SPRITES, litDir } from '../scripts/make-lit-sprites.mjs';
import { seeded, tileSvg, motion, layerBox, layersFor, lightTarget, fadePlan, planBurst, flashFrames, litMode, litTiming, litAt, bakeLit, resolveNightLight, litUrlOf, getNightLight, setNightLight, onNightLight, cloudRuns, cloudSvg, resolveSpec, skyMaskFile, TONE } from '../web/fx-weather.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8')).ui.fx.weather;
const read = (...p) => readFileSync(join(ROOT, ...p), 'utf8');
const DESIGNS = ['studio2', 'lounge', 'library', 'greenhouse'];

test('seeded: same seed, same numbers, in [0,1)', () => {
  const a = seeded(5); const b = seeded(5);
  for (let i = 0; i < 20; i++) { const v = a(); assert.equal(v, b()); assert.ok(v >= 0 && v < 1); }
});

test('layers per weather: rain 3 sheets, snow 2-3 sheets, storm has clouds and rain, clear none', () => {
  assert.equal(layersFor('rain', cfg).p.length, 3);
  assert.ok(layersFor('snow', cfg).p.length >= 2);
  assert.ok(layersFor('storm', cfg).c.length >= 1 && layersFor('storm', cfg).p.length >= 2);
  assert.ok(layersFor('cloudy', cfg).c.length >= 1);
  assert.ok(layersFor('fog', cfg).c.length >= 1);
  for (const k of ['clear', 'none', 'nope']) assert.deepEqual(layersFor(k, cfg), { c: [], p: [] });
  const ms = (k) => layersFor(k, cfg).p.map((s) => s.ms);
  assert.ok(ms('rain')[0] > ms('rain')[2], 'the near sheet is faster');
});

test('tiles: deterministic svg, motion is one tile period (seamless loop), box covers the view', () => {
  const spec = layersFor('rain', cfg).p[0];
  assert.equal(tileSvg(spec), tileSvg(spec));
  assert.match(tileSvg(spec), /^<svg /);
  const view = { width: 100, height: 60 };
  for (const design of [...DESIGNS, 'unknown']) {
    for (const kind of ['rain', 'snow', 'storm', 'fog', 'cloudy']) {
      const { c, p } = layersFor(kind, cfg);
      for (const raw of [...c, ...p]) {
        const s = resolveSpec(raw, cfg, design);
        const m = motion(s);
        const b = layerBox(s, view);
        if (s.type === 'rain' || s.type === 'snow') {
          assert.equal(Math.abs(m.dy), s.tile[1]);
          assert.ok(b.top + m.dy <= 0 && b.top + b.height + m.dy >= view.height, `${kind} sheet covers the view at the end of the slide`);
        } else {
          assert.equal(m.dx, s.tile[0]);
          assert.ok(b.left + m.dx <= 0 && b.left + b.width + m.dx >= view.width, `${design}/${kind}: the bank covers the view at the end of the slide`);
        }
      }
    }
  }
});

const runsOf = (seed, w, h) => cloudRuns(seeded(seed), w, h);
const cellsOf = (runs, w, h) => {
  const g = Array.from({ length: h }, () => new Array(w).fill(-1));
  for (const r of runs) for (let x = r.x0; x < r.x1; x++) g[r.y][x] = r.tone;
  return g;
};

test('cloud shape: deterministic, inside its box, a lit top, a grey belly, lumpy, one piece (over many seeds and sizes)', () => {
  assert.deepEqual(runsOf(5, 40, 14), runsOf(5, 40, 14));
  assert.notDeepEqual(runsOf(5, 40, 14), runsOf(6, 40, 14));
  for (const [w, h] of [[18, 6], [27, 9], [44, 15], [60, 18], [90, 30]]) {
    for (let seed = 1; seed <= 40; seed++) {
      const runs = runsOf(seed, w, h);
      assert.ok(runs.length > 0);
      for (const r of runs) assert.ok(r.y >= 0 && r.y < h && r.x0 >= 0 && r.x1 <= w && r.x0 < r.x1, `box ${w}x${h} seed ${seed}`);
      const g = cellsOf(runs, w, h);
      const tops = [];
      let filled = 0;
      for (let x = 0; x < w; x++) {
        let top = -1;
        let bottom = -1;
        for (let y = 0; y < h; y++) {
          if (g[y][x] < 0) continue;
          if (top < 0) top = y;
          bottom = y;
          filled++;
        }
        if (top < 0) continue;
        tops.push(top);
        assert.equal(g[top][x], TONE.hi, 'the top cell of a column is lit');
        if (bottom > top) assert.equal(g[bottom][x], TONE.deep, 'the lowest cell of a column is the darkest belly');
        if (bottom - top >= 3) assert.equal(g[bottom - 1][x], TONE.low, 'the cell above it is the soft belly');
      }
      assert.ok(new Set(tops).size >= (h < 8 ? 2 : 3), `lumpy: ${w}x${h} seed ${seed} has different column heights`);
      assert.ok(filled >= w * h * 0.25, `not a thin wisp: ${w}x${h} seed ${seed}`);
      // one piece: every filled cell is reached from the first one through filled neighbours
      const seen = new Set();
      const stack = [[runs[0].x0, runs[0].y]];
      while (stack.length) {
        const [x, y] = stack.pop();
        if (x < 0 || y < 0 || x >= w || y >= h || g[y][x] < 0 || seen.has(y * w + x)) continue;
        seen.add(y * w + x);
        stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
      }
      assert.equal(seen.size, filled, `${w}x${h} seed ${seed} is one piece`);
    }
  }
});

test('cloud banks: sized to the picture, inside the tile, wrap at its edge, slow; night is dimmer by opacity, not by another tile', () => {
  for (const design of DESIGNS) {
    const sky = cfg.sky[design];
    for (const kind of ['cloudy', 'rain', 'snow', 'storm']) {
      for (const raw of layersFor(kind, cfg).c) {
        const s = resolveSpec(raw, cfg, design);
        const [tw, th] = s.tile;
        assert.equal(tw % cfg.cell, 0);
        assert.equal(th % cfg.cell, 0);
        assert.equal(s.clouds.length, raw.n);
        for (const c of s.clouds) {
          assert.ok(c.h * cfg.cell >= sky.h[0] * (raw.size ?? 1) * 0.7 && c.h * cfg.cell <= sky.h[1] * (raw.size ?? 1) * 1.3, `${design}/${kind}: cloud height follows the picture's scale`);
          assert.ok(c.y >= 0 && c.y + c.h <= th / cfg.cell, 'inside the tile vertically');
          assert.ok(c.w <= tw / cfg.cell, 'a cloud is narrower than the tile');
        }
        assert.ok(s.top >= sky.band[0] - cfg.cell && s.top <= sky.band[1], `${design}/${kind}: the bank starts in the sky rows`);
        const svg = cloudSvg(s);
        assert.equal(svg, cloudSvg(resolveSpec(raw, cfg, design)), 'deterministic');
        const rects = [...svg.matchAll(/<rect x="(\d+)" y="(\d+)" width="(\d+)" height="(\d+)"\/>/g)].map((m) => m.slice(1).map(Number));
        assert.ok(rects.length >= raw.n * 6, 'every cloud is drawn');
        for (const [x, y, w, h] of rects) assert.ok(x >= 0 && x + w <= tw && y >= 0 && y + h <= th, 'every rectangle is inside the tile');
        // the loop is seamless: what leaves on the right comes back on the left (the tile is drawn with the wrapped copies)
        for (const c of s.clouds) {
          if ((c.x + c.w) * cfg.cell > tw) assert.ok(rects.some(([x]) => x === 0), 'a cloud over the right edge also starts at the left edge');
        }
        // slow drift: pxPerSec is the speed of the slide, between 0.2 and 3 px/s
        assert.ok(Math.abs(tw / (s.ms / 1000) - raw.pxPerSec) < 0.01 && raw.pxPerSec >= 0.2 && raw.pxPerSec <= 3, `${design}/${kind}: drifts slowly`);
        assert.equal(s.colors.length, 4);
      }
    }
  }
  assert.ok(cfg.skyDim.night < cfg.skyDim.sunset && cfg.skyDim.sunset <= cfg.skyDim.day, 'dimmer at night');
});

test('weather kinds: a storm is darker, bigger and lower than plain clouds; the overcast darkens cloudy, rain, storm; one sky per floor (no per-window values)', () => {
  const sum = (css) => css.match(/\d+/g).slice(0, 3).reduce((total, v) => total + Number(v), 0);
  const cloudy = layersFor('cloudy', cfg).c;
  const storm = layersFor('storm', cfg).c;
  assert.ok(storm.every((s) => s.tone === 'dark') && cloudy.every((s) => s.tone === 'light'));
  assert.ok(Math.max(...storm.map((s) => s.to)) > Math.max(...cloudy.map((s) => s.to)), 'a storm reaches lower');
  assert.ok(Math.max(...storm.map((s) => s.size ?? 1)) > Math.max(...cloudy.map((s) => s.size ?? 1)), 'storm clouds are bigger');
  assert.ok(sum(cfg.kinds.storm.overcast) < sum(cfg.kinds.rain.overcast) && sum(cfg.kinds.rain.overcast) < sum(cfg.kinds.cloudy.overcast), 'the overcast darkens: cloudy, rain, storm');
  const src = read('web', 'fx-weather.mjs');
  const css = read('web', 'fx-weather.css');
  assert.doesNotMatch(src + css, /--fxw-p\b|fxw-p\)/, 'no per-window cloud phase');
  assert.doesNotMatch(css, /animation-delay/, 'no layer starts out of step');
});

test('sky mask file names and the way the weather sits in the scene: under the room picture, clouds in the mask, nothing blurred', () => {
  assert.equal(skyMaskFile('view-day.png'), 'sky-day.png');
  assert.equal(skyMaskFile('view-night.png'), 'sky-night.png');
  assert.equal(skyMaskFile('dawn.png'), 'sky-dawn.png');
  const css = read('web', 'fx-weather.css');
  const src = read('web', 'fx-weather.mjs');
  const rule = (sel) => new RegExp(`${sel.replace(/[.[\]]/g, '\\$&')} \\{([^}]*)\\}`).exec(css)?.[1] ?? '';
  assert.match(rule('.fxw-shell'), /z-index: 2;/, 'the room picture copy is above the weather (z 1) and below every object');
  assert.match(rule('.fxw-shell'), /background-size: 100% 100%/);
  assert.match(src, /root\.style\.zIndex = '1'/);
  assert.match(src, /shell\.style\.backgroundImage = `url\(\$\{sc\.url\}\$\{encodeURIComponent\(sc\.r\.shell\)\}\)`/, 'the copy is the shell picture of the scene');
  assert.match(rule('.fxw-sky'), /mask-image: var\(--fxw-sky-day\)/);
  assert.match(rule('.fxw-sky'), /mask-size: 100% 100%/);
  assert.match(rule('.stage[data-light="night"] .fxw-sky'), /mask-image: var\(--fxw-sky-night\)/);
  assert.match(src, /file\(view\.day\)/);
  assert.match(src, /file\(view\.night\)/);
  assert.match(css, /\.fx-on \.stage:has\(> \.fxw\) \.wx \{ display: none !important; \}/, 'the plain window weather (a polygon wash over the frames) gives way');
  assert.doesNotMatch(css.replace(/\/\*[^]*?\*\//g, ''), /filter|blur|backdrop|mix-blend|box-shadow|text-shadow/, 'no animated blur, filter or shadow');
  assert.doesNotMatch(css.match(/@keyframes[^{]+\{[^}]*\}/)?.[0] ?? '', /left|top|width|height|margin/, 'the slide moves transform only');
  // the weather is a child of the view box, which is the scene's view box
  assert.match(src, /const box = view \? \{ left: view\.origin\[0\], top: view\.origin\[1\], width: view\.size\[0\], height: view\.size\[1\] \}/);
});

test('light: cross-fade only on a change, none at the very start', () => {
  assert.equal(fadePlan(null, 'night', cfg).ms, 0);
  assert.equal(fadePlan('night', 'night', cfg).ms, 0);
  assert.equal(fadePlan('day', 'sunset', cfg).ms, cfg.fadeMs);
  assert.equal(fadePlan('day', 'sunset', cfg).dusk, 1);
  assert.equal(lightTarget('night', cfg).night, 1);
  assert.equal(lightTarget('day', cfg).glow, 0);
  assert.ok(lightTarget('night', cfg).glow > 0);
  assert.deepEqual(lightTarget('bogus', cfg), lightTarget('day', cfg));
  assert.ok(lightTarget('night', cfg).dim < lightTarget('day', cfg).dim);
  assert.equal(lightTarget('day', cfg).sdim, 1);
  assert.ok(lightTarget('night', cfg).sdim < lightTarget('sunset', cfg).sdim, 'the sky weather is dimmer by night');
  assert.equal(fadePlan('day', 'night', cfg).sdim, cfg.skyDim.night);
});

test('lightning: gaps at least minGapMs, at most maxPerBurst flashes, soft peaks, over many seeds', () => {
  const L = cfg.lightning;
  assert.ok(L.minGapMs >= 4000 && L.maxPerBurst <= 2);
  for (let s = 1; s <= 300; s++) {
    const plan = planBurst(seeded(s), cfg);
    assert.ok(plan.delayMs >= L.minGapMs && plan.delayMs <= L.maxGapMs);
    assert.ok(plan.flashes.length >= 1 && plan.flashes.length <= L.maxPerBurst);
    plan.flashes.forEach((f, i) => {
      assert.ok(f.peak >= L.peak[0] && f.peak <= L.peak[1] && f.peak <= 0.5);
      if (i > 0) assert.ok(f.atMs - plan.flashes[i - 1].atMs >= L.minGapMs);
    });
  }
  const f = flashFrames(0.3);
  assert.equal(f[0].opacity, 0);
  assert.equal(f.at(-1).opacity, 0);
  assert.ok(f.every((k) => k.opacity <= 0.3));
});

test('face light mode: seated and present only; working and thinking ripple, idle is steady, the rest is dark', () => {
  const rec = (o) => ({ seated: true, state: 'working', ...o });
  assert.equal(litMode(rec({}), cfg), 'work');
  assert.equal(litMode(rec({ state: 'thinking' }), cfg), 'work');
  assert.equal(litMode(rec({ state: 'idle' }), cfg), 'rest');
  for (const state of ['stale', 'done', 'enter', 'cat', '']) assert.equal(litMode(rec({ state }), cfg), '', state);
  assert.equal(litMode(rec({ seated: false }), cfg), '', 'standing');
  assert.equal(litMode(rec({ away: true }), cfg), '', 'away on a trip');
  assert.equal(litMode(rec({ isCat: true }), cfg), '', 'the cat');
});

test('face light ripple: a cycle inside the configured 1-3 s, characters out of step, same index same timing', () => {
  const [lo, hi] = cfg.glow.rippleMs;
  assert.ok(lo >= 1000 && hi <= 3000 && lo < hi, 'one to three seconds');
  const starts = new Set();
  for (let n = 0; n < 12; n++) {
    const t = litTiming(n, cfg);
    assert.ok(t.ms >= lo && t.ms <= hi, `cycle ${t.ms}`);
    assert.ok(t.delayMs <= 0 && t.delayMs > -t.ms, 'a negative delay: it starts part way through its cycle');
    assert.deepEqual(t, litTiming(n, cfg));
    starts.add(`${t.ms}/${t.delayMs}`);
  }
  assert.equal(starts.size, 12, 'no two of the first twelve share a phase');
});

test('face light fall-off: brightest at the face, weaker down the chest, none below the desk line', () => {
  const at = (t) => litAt(t, cfg);
  assert.ok(at(0.36) > at(0.1), 'the face is brighter than the top of the hair');
  assert.ok(at(0.36) > at(0.52) && at(0.52) > at(0.68) && at(0.68) > at(0.86), 'weaker and weaker going down');
  assert.equal(at(0.86), 0);
  assert.equal(at(1), 0);
  assert.ok(Math.abs(at(0.36) - cfg.glow.gain) < 1e-9);
});

test('baked lit picture: only covered pixels change, the alpha never, the face row gets lighter, the feet row stays, the source stays', () => {
  const w = 4; const h = 20;
  const src = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const covered = x !== 0; // column 0 is transparent
      src.set([40, 30, 60, covered ? 255 : 0], i);
    }
  }
  const copy = Uint8ClampedArray.from(src);
  const out = bakeLit(src, w, h, cfg);
  assert.deepEqual([...src], [...copy], 'the source is not modified');
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      assert.equal(out[i + 3], src[i + 3], 'alpha untouched');
      if (!src[i + 3]) assert.deepEqual([...out.slice(i, i + 3)], [...src.slice(i, i + 3)], 'a transparent pixel is left as it was');
    }
  }
  const px = (y) => [...out.slice((y * w + 1) * 4, (y * w + 1) * 4 + 3)];
  const face = px(Math.floor(h * 0.36));
  assert.ok(face.every((v, k) => v >= [40, 30, 60][k]) && face[2] > 60 && face[0] > 40, 'the face row is lighter and bluish');
  assert.deepEqual(px(h - 1), [40, 30, 60], 'the feet row is not lit');
  assert.ok(face[2] > px(Math.floor(h * 0.6))[2], 'the face is lit more than the chest');
});

test('baked lit picture multiplies in the outline set: a dark outline pixel gains almost nothing, a bright pixel gains more, channels stop at 255', () => {
  const h = 20;
  const colours = [[10, 10, 14], [200, 160, 140], [250, 250, 250]];
  const rows = new Uint8ClampedArray(3 * h * 4);
  for (let y = 0; y < h; y++) colours.forEach((c, x) => rows.set([...c, 255], (y * 3 + x) * 4));
  const out = bakeLit(rows, 3, h, cfg, 'outline');
  const y = Math.floor(h * 0.36);
  const px = (x) => [...out.slice((y * 3 + x) * 4, (y * 3 + x) * 4 + 3)];
  const dark = px(0); const mid = px(1); const white = px(2);
  assert.ok(dark[2] - 14 <= 6, 'the dark outline stays dark');
  assert.ok(mid[2] - 140 > dark[2] - 14, 'a brighter pixel is lifted more');
  assert.equal(white[2], 255);
});

test('baked lit picture screens in the soft set: the darkest pixel is lifted most of all, and the two sets differ', () => {
  const h = 20;
  const rows = new Uint8ClampedArray(2 * h * 4);
  for (let y = 0; y < h; y++) { rows.set([10, 10, 14, 255], (y * 2) * 4); rows.set([200, 160, 140, 255], (y * 2 + 1) * 4); }
  const y = Math.floor(h * 0.36);
  const soft = bakeLit(rows, 2, h, cfg, 'soft');
  const outline = bakeLit(rows, 2, h, cfg, 'outline');
  const blue = (o, x) => o[(y * 2 + x) * 4 + 2];
  const k = litAt((y + 0.5) / h, cfg, cfg.glow.strength); // the screen weight at that row
  assert.equal(blue(soft, 0), Math.round((14 / 255 + (255 / 255) * k * (1 - 14 / 255)) * 255), 'screen formula');
  assert.ok(blue(soft, 0) - 14 > blue(soft, 1) - 140, 'screen lifts the dark pixel more than the bright one');
  assert.ok(blue(soft, 0) > blue(outline, 0), 'the soft set lifts the outline more than the outline set does');
});

test('night light choice: stored id wins, junk or nothing gives the default, a change tells the listeners and the storage, a blocked storage still works for the page', () => {
  assert.equal(cfg.glow.default, 'outline');
  assert.deepEqual(Object.keys(cfg.glow.sets), ['outline', 'soft']);
  assert.equal(resolveNightLight(null, cfg), 'outline');
  assert.equal(resolveNightLight('junk', cfg), 'outline');
  assert.equal(resolveNightLight('toString', cfg), 'outline');
  assert.equal(resolveNightLight('soft', cfg), 'soft');
  assert.equal(litUrlOf('/assets/sprites/worker-sit.png', 'outline', cfg), '/assets/sprites/lit-outline/worker-sit.png');
  assert.equal(litUrlOf('/assets/sprites/worker-sit.png', 'soft', cfg), '/assets/sprites/lit/worker-sit.png');
  const mem = new Map();
  const store = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  mem.set('agent-office.nightLight', 'soft');
  assert.equal(getNightLight(cfg, () => store), 'soft', 'the stored choice beats the default');
  const heard = [];
  const stop = onNightLight((id) => heard.push(id));
  setNightLight(cfg, 'outline', () => store);
  assert.deepEqual(heard, ['outline']);
  assert.equal(mem.get('agent-office.nightLight'), 'outline');
  assert.equal(getNightLight(cfg, () => store), 'outline');
  const blocked = () => { throw new Error('blocked'); };
  setNightLight(cfg, 'soft', blocked);
  assert.equal(getNightLight(cfg, blocked), 'soft', 'a blocked storage: this page keeps the choice');
  assert.deepEqual(heard, ['outline', 'soft']);
  stop();
});

test('face light css: the lit picture is an image laid over the figure (no mask, clip-path, blend, box shadow or radius), opacity only, off without a seated figure', () => {
  const css = readFileSync(join(ROOT, 'web/fx-weather.css'), 'utf8');
  const lit = css.slice(css.indexOf('.fxw-lit {'), css.indexOf('@media (prefers-reduced-motion'));
  assert.doesNotMatch(lit.replace(/\/\*[\s\S]*?\*\//g, ''), /mask|clip-path|box-shadow|border-radius|mix-blend-mode|filter/);
  assert.match(lit, /\.ag:not\(\.sitting\) \.fxw-lit \{ display: none/);
  assert.match(css, /prefers-reduced-motion[\s\S]*\.fxw-lit-i \{ animation: none/);
  assert.equal(cfg.glow.holes, undefined, 'the old box and its holes are gone');
});

test('lit pictures: every seated picture has its lit copy in every set on disk, equal to what bakeLit makes now (run scripts/make-lit-sprites.mjs when this fails)', () => {
  const names = litSources();
  assert.ok(names.length >= 30, `found ${names.length} seated pictures`);
  const dirs = Object.keys(cfg.glow.sets).map((set) => litDir(set, cfg));
  assert.equal(new Set(dirs).size, dirs.length, 'one folder per set');
  for (const set of Object.keys(cfg.glow.sets)) for (const name of names) {
    const lit = litOf(name, cfg, set);
    const file = decodePng(readFileSync(join(litDir(set, cfg), name)));
    assert.deepEqual([file.w, file.h], [lit.w, lit.h], `${set}/${name}: size`);
    assert.ok(Buffer.from(file.rgba).equals(Buffer.from(lit.rgba)), `${set}/${name}: the lit copy is out of date`);
    const plain = decodePng(readFileSync(join(SPRITES, name)));
    for (let i = 3; i < plain.rgba.length; i += 4) {
      if (plain.rgba[i] !== file.rgba[i]) assert.fail(`${name}: alpha differs at ${i}`);
    }
  }
});

test('png helpers: encode then decode gives the same pixels', () => {
  const rgba = new Uint8ClampedArray([1, 2, 3, 255, 9, 8, 7, 0, 100, 110, 120, 255, 200, 210, 220, 128]);
  const back = decodePng(encodePng(2, 2, rgba));
  assert.deepEqual([back.w, back.h, ...back.rgba], [2, 2, ...rgba]);
});
