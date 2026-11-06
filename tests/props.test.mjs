// Tests of the prop pictures (art/props/build.py): assets/props/*.png and the size table in assets/props/README.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePng } from '../scripts/make-lit-sprites.mjs';

const DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'props');
const files = () => readdirSync(DIR).filter((n) => n.endsWith('.png')).sort();
const load = (n) => decodePng(readFileSync(join(DIR, n)));
const luma = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;

test('every prop is RGBA with transparent corners', () => {
  assert.equal(files().length, 13);
  for (const n of files()) {
    const { w, h, rgba } = load(n);
    for (const [x, y] of [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1]]) {
      assert.equal(rgba[(y * w + x) * 4 + 3], 0, `${n} corner ${x},${y}`);
    }
  }
});

test('every opaque pixel next to a transparent one is dark (luma ≤ 90)', () => {
  for (const n of files()) {
    const { w, h, rgba } = load(n);
    const a = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : rgba[(y * w + x) * 4 + 3]);
    let edge = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (a(x, y) === 0) continue;
        if (a(x - 1, y) && a(x + 1, y) && a(x, y - 1) && a(x, y + 1)) continue;
        edge++;
        const i = (y * w + x) * 4;
        assert.ok(luma(rgba[i], rgba[i + 1], rgba[i + 2]) <= 90, `${n} ${x},${y} is light on the edge`);
      }
    }
    assert.ok(edge > 0, `${n} has no outline`);
  }
});

test('sizes match the table in assets/props/README.md', () => {
  const readme = readFileSync(join(DIR, 'README.md'), 'utf8');
  const table = new Map();
  for (const m of readme.matchAll(/^\| (\S+\.png) \| (\d+)x(\d+) \|/gm)) table.set(m[1], [Number(m[2]), Number(m[3])]);
  assert.deepEqual([...table.keys()].sort(), files());
  for (const n of files()) {
    const { w, h } = load(n);
    assert.deepEqual([w, h], table.get(n), n);
  }
});
