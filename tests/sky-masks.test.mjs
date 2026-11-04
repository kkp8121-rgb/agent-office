// Data test of the sky masks (assets/scenes/<room>/sky-day.png, sky-night.png, made by art/skymask.py): the weather overlay shows clouds and the lightning glow only where
// these say "sky", so they must have the view picture's size, hold only sky / not sky, start at the top of the picture, agree with the picture and lie where the config puts clouds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './helpers/fixture.mjs';
import { alphaOf, readPng } from './helpers/png-read.mjs';
import { skyMaskFile } from '../web/fx-weather.mjs';

const SCENES = join(ROOT, 'assets', 'scenes');
const DESIGNS = ['studio2', 'lounge', 'library', 'greenhouse'];
const cfg = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8')).ui.fx.weather;
const scene = (d) => JSON.parse(readFileSync(join(SCENES, d, 'scene.json'), 'utf8'));
const luma = (px, i) => px.data[i * px.ch] * 0.299 + px.data[i * px.ch + 1] * 0.587 + px.data[i * px.ch + 2] * 0.114;

const masks = {};
for (const d of DESIGNS) {
  const { view } = scene(d);
  for (const mode of ['day', 'night']) {
    const png = readPng(join(SCENES, d, skyMaskFile(view[mode])));
    masks[`${d}/${mode}`] = { png, a: alphaOf(png), view, d, mode };
  }
}
const each = (fn) => { for (const m of Object.values(masks)) fn(m, `${m.d}/${m.mode}`); };

test('sky masks: one per view picture, as big as the picture, grey + alpha, only sky (255) or not sky (0)', () => {
  assert.equal(Object.keys(masks).length, 8);
  each(({ png, a, view }, name) => {
    assert.deepEqual([png.w, png.h], view.size, `${name}: size`);
    assert.equal(png.ch, 2, `${name}: grey + alpha`);
    for (const v of a) if (v !== 0 && v !== 255) assert.fail(`${name}: alpha ${v} (a mask pixel is sky or not)`);
  });
});

test('sky masks: the sky starts at the top of the picture and ends before the bottom, in a believable share', () => {
  each(({ png, a }, name) => {
    const { w, h } = png;
    const row = (y) => a.slice(y * w, (y + 1) * w).filter((v) => v === 255).length / w;
    assert.ok(row(0) >= 0.99, `${name}: the top row is sky (${row(0)})`);
    assert.equal(row(h - 1), 0, `${name}: the bottom row is not sky`);
    const share = a.filter((v) => v === 255).length / a.length;
    assert.ok(share >= 0.15 && share <= 0.45, `${name}: sky share ${share.toFixed(3)} (the pictures show 20-40 % sky)`);
    // everything the mask calls sky hangs together with the top row (no floating patches of ground colour)
    const seen = new Uint8Array(a.length);
    const stack = [];
    for (let x = 0; x < w; x++) if (a[x] === 255) stack.push(x);
    let reached = 0;
    while (stack.length) {
      const i = stack.pop();
      if (seen[i] || a[i] !== 255) continue;
      seen[i] = 1;
      reached++;
      const x = i % w;
      if (x > 0) stack.push(i - 1);
      if (x < w - 1) stack.push(i + 1);
      if (i >= w) stack.push(i - w);
      if (i + w < a.length) stack.push(i + w);
    }
    assert.ok(reached >= a.filter((v) => v === 255).length * 0.995, `${name}: sky is connected to the top`);
  });
});

test('sky masks: the night picture is the same composition as the day one, so the masks agree', () => {
  for (const d of DESIGNS) {
    const day = masks[`${d}/day`].a;
    const night = masks[`${d}/night`].a;
    let both = 0;
    let either = 0;
    for (let i = 0; i < day.length; i++) {
      if (day[i] && night[i]) both++;
      if (day[i] || night[i]) either++;
    }
    assert.ok(both / either >= 0.97, `${d}: day and night masks overlap ${(both / either).toFixed(3)}`);
  }
});

test('sky masks: they agree with the pictures (sky is the lighter, bluer part of the day picture; the night sky is navy)', () => {
  each(({ png, a, view, d, mode }, name) => {
    const pic = readPng(join(SCENES, d, view[mode]));
    assert.deepEqual([pic.w, pic.h], [png.w, png.h]);
    let n = 0;
    let blue = 0;
    let lumaSky = 0;
    let lumaGround = 0;
    for (let i = 0; i < a.length; i++) {
      if (a[i] === 255) {
        n++;
        lumaSky += luma(pic, i);
        if (pic.data[i * 3 + 2] >= pic.data[i * 3]) blue++;
      } else lumaGround += luma(pic, i);
    }
    assert.ok(blue / n >= 0.95, `${name}: ${(100 * blue / n).toFixed(1)} % of the sky pixels are blue-dominant`);
    if (mode === 'day') assert.ok(lumaSky / n > lumaGround / (a.length - n) + 15, `${name}: the sky is lighter than the rest`);
    else assert.ok(lumaSky / n < 90, `${name}: the night sky is dark (${(lumaSky / n).toFixed(0)})`);
  });
});

test('sky masks: the glass shows sky in every room, and the config puts the cloud band on rows where it does', () => {
  for (const d of DESIGNS) {
    const { view } = scene(d);
    const [vx, vy] = view.origin;
    const shell = readPng(join(SCENES, d, 'shell.png'));
    const sky = masks[`${d}/day`];
    const rows = new Array(view.size[1]).fill(0);
    let visible = 0;
    for (let y = 0; y < view.size[1]; y++) {
      for (let x = 0; x < view.size[0]; x++) {
        const hole = shell.data[((vy + y) * shell.w + vx + x) * 4 + 3] === 0;
        if (hole && sky.a[y * view.size[0] + x] === 255) { rows[y]++; visible++; }
      }
    }
    assert.ok(visible >= 1000, `${d}: ${visible} sky pixels show through the glass`);
    const { band, h } = cfg.sky[d];
    assert.ok(band[0] >= 0 && band[1] <= view.size[1] && band[0] < band[1], `${d}: the band is inside the view picture`);
    let lit = 0;
    for (let y = band[0]; y <= band[1]; y++) if (rows[y] > 0) lit++;
    assert.ok(lit / (band[1] - band[0] + 1) >= 0.9, `${d}: ${lit} of the band's ${band[1] - band[0] + 1} rows show sky through the glass`);
    assert.ok(h[0] > 0 && h[0] <= h[1] && h[1] <= band[1] - band[0] + 1, `${d}: cloud heights fit the band`);
  }
  assert.ok(cfg.sky.default.band[1] > cfg.sky.default.band[0] && cfg.sky.default.h[0] > 0, 'a room without an entry gets the default band');
});
