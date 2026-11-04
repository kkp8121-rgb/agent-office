// Tests of the pure parts of web/fx-weather.mjs: seeded tiles, layers per weather, light plan and cross-fade timing, lightning schedule bounds, face light mode and timing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { litSources, litOf, decodePng, encodePng, SPRITES, LIT } from '../scripts/make-lit-sprites.mjs';
import { seeded, tileSvg, motion, layerBox, layersFor, lightTarget, fadePlan, planBurst, flashFrames, litMode, litTiming, litAt, bakeLit } from '../web/fx-weather.mjs';

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
  assert.ok(Math.abs(at(0.36) - cfg.glow.strength) < 1e-9);
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

test('face light css: the lit picture is an image laid over the figure (no mask, clip-path, blend, box shadow or radius), opacity only, off without a seated figure', () => {
  const css = readFileSync(join(ROOT, 'web/fx-weather.css'), 'utf8');
  const lit = css.slice(css.indexOf('.fxw-lit {'), css.indexOf('@media (prefers-reduced-motion'));
  assert.doesNotMatch(lit.replace(/\/\*[\s\S]*?\*\//g, ''), /mask|clip-path|box-shadow|border-radius|mix-blend-mode|filter/);
  assert.match(lit, /\.ag:not\(\.sitting\) \.fxw-lit \{ display: none/);
  assert.match(css, /prefers-reduced-motion[\s\S]*\.fxw-lit-i \{ animation: none/);
  assert.equal(cfg.glow.holes, undefined, 'the old box and its holes are gone');
});

test('lit pictures: every seated picture has its lit copy on disk, equal to what bakeLit makes now (run scripts/make-lit-sprites.mjs when this fails)', () => {
  const names = litSources();
  assert.ok(names.length >= 30, `found ${names.length} seated pictures`);
  for (const name of names) {
    const lit = litOf(name, cfg);
    const file = decodePng(readFileSync(join(LIT, name)));
    assert.deepEqual([file.w, file.h], [lit.w, lit.h], `${name}: size`);
    assert.ok(Buffer.from(file.rgba).equals(Buffer.from(lit.rgba)), `${name}: the lit copy is out of date`);
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
