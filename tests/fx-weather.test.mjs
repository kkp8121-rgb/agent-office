// Tests of the pure parts of web/fx-weather.mjs: seeded tiles, pixel-art clouds, layers per weather, light plan and cross-fade timing, lightning schedule bounds, glow spots,
// and of the way the weather sits in the scene (outside the glass: under the room picture, clouds in the sky mask only, one sky per floor).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { seeded, tileSvg, motion, layerBox, layersFor, lightTarget, fadePlan, planBurst, flashFrames, glowSpots, glowClip, cloudRuns, cloudSvg, resolveSpec, skyMaskFile, TONE } from '../web/fx-weather.mjs';

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

test('glow spots: only seated, present, working or thinking characters', () => {
  const recs = [
    { seated: true, state: 'working', x: 100, y: 50 },
    { seated: true, state: 'idle', x: 1, y: 1 },
    { seated: false, state: 'working', x: 2, y: 2 },
    { seated: true, away: true, state: 'thinking', x: 3, y: 3 },
    { seated: true, state: 'thinking', x: 200, y: 80 },
  ];
  const spots = glowSpots(recs, cfg);
  assert.equal(spots.length, 2);
  assert.deepEqual([spots[0].x, spots[0].y], [100 + cfg.glow.offset[0], 50 + cfg.glow.offset[1]]);
});

test('glow clip: the box minus the monitor back, per design and desk kind; unknown design or no holes: no clip', () => {
  const { size, holes } = cfg.glow;
  for (const design of ['studio2', 'lounge', 'library', 'greenhouse']) {
    for (const [kind, lead] of [['desk', false], ['lead', true]]) {
      const pts = holes[design][kind];
      assert.ok(pts.length >= 3, `${design}/${kind} is a polygon`);
      const clip = glowClip(size, holes, design, lead);
      assert.ok(clip.startsWith(`path(evenodd, "M0 0H${size[0]}V${size[1]}H0Z M`), clip);
      assert.equal((clip.match(/ L/g) ?? []).length, pts.length - 1);
    }
  }
  assert.equal(glowClip(size, holes, 'lobby', false), '');
  assert.equal(glowClip(size, undefined, 'studio2', false), '');
  assert.deepEqual(glowSpots([{ seated: true, state: 'working', x: 1, y: 1, isLead: true }, { seated: true, state: 'working', x: 2, y: 2 }], cfg).map((w) => w.lead), [true, false]);
});

test('glow position: the centre is up on the face and chest, so the light reaches the character and the monitor ornaments stay outside it', () => {
  assert.ok(cfg.glow.offset[1] <= -20, 'above the monitor top, not on the monitor');
});
