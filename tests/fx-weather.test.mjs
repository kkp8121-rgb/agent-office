// Tests of the pure parts of web/fx-weather.mjs: seeded tiles, layers per weather, light plan and cross-fade timing, lightning schedule bounds, glow spots.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { seeded, tileSvg, motion, layerBox, layersFor, lightTarget, fadePlan, planBurst, flashFrames, glowSpots, glowClip } from '../web/fx-weather.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8')).ui.fx.weather;

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

test('tiles: deterministic svg, motion is one tile period (seamless loop), box covers the window', () => {
  const spec = layersFor('rain', cfg).p[0];
  assert.equal(tileSvg(spec), tileSvg(spec));
  assert.match(tileSvg(spec), /^<svg /);
  for (const kind of ['rain', 'snow', 'storm', 'fog', 'cloudy']) {
    const { c, p } = layersFor(kind, cfg);
    for (const s of [...c, ...p]) {
      const m = motion(s);
      const win = { width: 100, height: 60 };
      const b = layerBox(s, win);
      if (s.type === 'rain' || s.type === 'snow') {
        assert.equal(Math.abs(m.dy), s.tile[1]);
        assert.ok(b.top + m.dy <= 0 && b.top + b.height + m.dy >= win.height, `${kind} sheet covers the window at the end of the slide`);
      } else {
        assert.equal(m.dx, s.tile[0]);
        assert.ok(b.left + m.dx <= 0 && b.left + b.width + m.dx >= win.width);
      }
    }
  }
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
