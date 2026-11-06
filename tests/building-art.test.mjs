import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cfg, ROOT } from './helpers/fixture.mjs';
import { readPng } from './helpers/png-read.mjs';

const DIR = join(ROOT, 'assets', 'building');
const B = cfg.ui.building;
const NAMES = ['facade-window-day', 'facade-window-night-off', 'facade-window-night-on', 'roof', 'basement', 'rack-off', 'rack-on',
  'crane-arm', 'crane-hook', 'elev-car', 'elev-shaft-door', 'sign-stand', 'exterior-day', 'exterior-night'];
const BIG = new Set(['roof', 'basement', 'exterior-day', 'exterior-night']);
const SMALL = NAMES.filter((n) => !BIG.has(n));
const png = (n) => readPng(join(DIR, `${n}.png`));
const alphaAt = (p, x, y) => p.data[(y * p.w + x) * 4 + 3];
const luma = (p, x, y) => {
  const i = (y * p.w + x) * 4;
  return 0.299 * p.data[i] + 0.587 * p.data[i + 1] + 0.114 * p.data[i + 2];
};

test('building art: all 14 pictures exist and are RGBA', () => {
  assert.equal(NAMES.length, 14);
  for (const n of NAMES) {
    assert.ok(existsSync(join(DIR, `${n}.png`)), `${n}.png is missing`);
    assert.equal(png(n).ch, 4, `${n} must be RGBA`);
  }
});

test('building art: roof and basement are as wide as building.innerW and as tall as roofPx / basementPx', () => {
  for (const [n, h] of [['roof', B.roofPx], ['basement', B.basementPx]]) {
    const p = png(n);
    assert.equal(p.w, B.innerW, `${n} width`);
    assert.equal(p.h, h, `${n} height`);
  }
});

test('building art: facade windows are exactly facadePx wide', () => {
  for (const n of NAMES.filter((x) => x.startsWith('facade-window-'))) assert.equal(png(n).w, B.facadePx, n);
});

test('building art: elevator pieces fit into the shaft (width <= shaftPx)', () => {
  for (const n of ['elev-car', 'elev-shaft-door']) assert.ok(png(n).w <= B.shaftPx, `${n} is ${png(n).w}px wide, shaftPx is ${B.shaftPx}`);
});

test('building art: every small piece has transparent corners', () => {
  for (const n of SMALL) {
    const p = png(n);
    for (const [x, y] of [[0, 0], [p.w - 1, 0], [0, p.h - 1], [p.w - 1, p.h - 1]]) assert.equal(alphaAt(p, x, y), 0, `${n} corner ${x},${y}`);
  }
});

test('building art: every opaque pixel next to a transparent one in a small piece is dark (luma <= 90)', () => {
  for (const n of SMALL) {
    const p = png(n);
    for (let y = 0; y < p.h; y++) {
      for (let x = 0; x < p.w; x++) {
        const a = alphaAt(p, x, y);
        assert.ok(a === 0 || a === 255, `${n} has a half-transparent pixel at ${x},${y}`);
        if (a === 0) continue;
        const edge = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => {
          const nx = x + dx;
          const ny = y + dy;
          return nx < 0 || ny < 0 || nx >= p.w || ny >= p.h || alphaAt(p, nx, ny) === 0;
        });
        if (edge) assert.ok(luma(p, x, y) <= 90, `${n} pixel ${x},${y} is on an edge but bright (${Math.round(luma(p, x, y))})`);
      }
    }
  }
});

test('building art: sizes match the table in assets/building/README.md', () => {
  const readme = readFileSync(join(DIR, 'README.md'), 'utf8');
  const rows = [...readme.matchAll(/^\| ([\w-]+)\.png \| (\d+)x(\d+) \|/gm)];
  assert.deepEqual(rows.map((r) => r[1]).sort(), [...NAMES].sort());
  for (const [, n, w, h] of rows) {
    const p = png(n);
    assert.deepEqual([p.w, p.h], [Number(w), Number(h)], n);
  }
});

test('building art: the exteriors are opaque and share one size; the roof sky is transparent', () => {
  const day = png('exterior-day');
  const night = png('exterior-night');
  assert.deepEqual([night.w, night.h], [day.w, day.h]);
  for (const p of [day, night]) for (let i = 3; i < p.data.length; i += 4) assert.equal(p.data[i], 255);
  const roof = png('roof');
  assert.equal(alphaAt(roof, 0, 0), 0);
  assert.equal(alphaAt(roof, roof.w - 1, 0), 0);
});

test('building art: lit pictures differ from unlit ones (rack-on has lit LEDs, night-on is brighter than night-off)', () => {
  const on = png('rack-on');
  const off = png('rack-off');
  assert.notDeepEqual(on.data, off.data);
  const avg = (p) => {
    let s = 0;
    let n = 0;
    for (let y = 0; y < p.h; y++) for (let x = 0; x < p.w; x++) if (alphaAt(p, x, y)) { s += luma(p, x, y); n++; }
    return s / n;
  };
  assert.ok(avg(png('facade-window-night-on')) > avg(png('facade-window-night-off')) + 40);
  assert.ok(avg(png('exterior-day')) > avg(png('exterior-night')) + 20);
});
