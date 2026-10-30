import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { checkScene } from '../server/scene-check.mjs';
import { readPngSize } from '../server/scenes.mjs';
import { ROOT, cfg } from './helpers/fixture.mjs';

const SHIPPED = join(ROOT, 'assets', 'scenes');
const DESIGNS = readdirSync(SHIPPED, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
const load = (d) => JSON.parse(readFileSync(join(SHIPPED, d, 'scene.json'), 'utf8'));
const check = (d, raw) => checkScene(raw, { atlasSize: readPngSize(join(SHIPPED, d, raw.atlas)), cfg });
const stage10 = (res) => res.errors.filter((e) => e.startsWith('10단계'));

test('fun2 scene: all four rooms carry whiteboard, windows, meeting and seasonal anchors and pass', () => {
  assert.deepEqual([...DESIGNS].sort(), ['greenhouse', 'library', 'lounge', 'studio2']);
  for (const d of DESIGNS) {
    const raw = load(d);
    const res = check(d, raw);
    assert.deepEqual(res.errors, [], d);
    assert.equal(raw.whiteboard.quad.length, 4, d);
    assert.ok(raw.windows.length >= 2 && raw.windows.every((p) => p.length >= 3), d);
    assert.ok(raw.meeting.spots.length >= 6 && raw.meeting.spots.length <= 8, d);
    assert.ok(['left', 'right'].includes(raw.meeting.boss.face), d);
    for (const kind of ['floor', 'wall', 'desk']) assert.ok(raw.seasonal.some((a) => a.kind === kind), `${d} ${kind}`);
  }
});

test('fun2 scene: meeting spots and floor anchors honor the grid', () => {
  for (const d of DESIGNS) {
    const raw = load(d);
    const res = check(d, raw);
    const open = (p) => res.grid && res.errors.length === 0 && Boolean(res.grid.open[Math.floor(p[1] / res.grid.cellPx) * res.grid.cols + Math.floor(p[0] / res.grid.cellPx)]);
    for (const s of [raw.meeting.boss, ...raw.meeting.spots]) assert.ok(open(s.at), `${d} meeting ${s.at}`);
    for (const a of raw.seasonal.filter((x) => x.kind === 'floor')) assert.ok(!open(a.at), `${d} ${a.id} must not be walkable`);
  }
});

test('fun2 scene: validator catches a flat whiteboard, a meeting spot on a wall and a walkable floor anchor', () => {
  const raw = load('studio2');
  raw.whiteboard.quad = raw.whiteboard.quad.map(([x, y]) => [x, y < 150 ? 100 : 160]);
  assert.ok(stage10(check('studio2', raw)).some((e) => /whiteboard/.test(e)));

  const m = load('studio2');
  m.meeting.spots[0].at = [10, 10];
  assert.ok(stage10(check('studio2', m)).some((e) => /meeting\.spots\[0\]/.test(e)));

  const f = load('studio2');
  f.seasonal.find((a) => a.kind === 'floor').at = [510, 300];
  assert.ok(stage10(check('studio2', f)).some((e) => /걸을 수 있는/.test(e)));
});

test('fun2 scene: validator catches crowded meeting spots, a missing spot count and a desk anchor off the desks', () => {
  const a = load('library');
  a.meeting.spots[1].at = [a.meeting.spots[0].at[0] + 10, a.meeting.spots[0].at[1]];
  assert.ok(stage10(check('library', a)).some((e) => /가깝습니다/.test(e)));

  const b = load('library');
  b.meeting.spots = b.meeting.spots.slice(0, 4);
  assert.ok(stage10(check('library', b)).some((e) => /6~8곳/.test(e)));

  const c = load('library');
  c.seasonal.find((x) => x.kind === 'desk').at = [20, 20];
  assert.ok(stage10(check('library', c)).some((e) => /책상/.test(e)));
});

test('fun2 scene: a scene without the new keys still passes (they are optional)', () => {
  const raw = load('lounge');
  for (const k of ['whiteboard', 'windows', 'meeting', 'seasonal']) delete raw[k];
  assert.deepEqual(check('lounge', raw).errors, []);
});

test('fun2 scene: check-scenes --json lists the decor anchors', () => {
  const out = spawnSync(process.execPath, [join(ROOT, 'scripts', 'check-scenes.mjs'), '--json', 'greenhouse'], { encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  const j = JSON.parse(out.stdout);
  assert.equal(j.decor.meeting.spots.length >= 6, true);
  assert.equal(j.decor.whiteboard.quad.length, 4);
});
