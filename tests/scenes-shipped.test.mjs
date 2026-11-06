import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkScene } from '../server/scene-check.mjs';
import { readPngSize } from '../server/scenes.mjs';
import { FIXTURE_DIR, FIXTURE_SCENES, ROOT, atlasSize, cfg, fixtureRaw } from './helpers/fixture.mjs';

const check = (raw, size = atlasSize) => checkScene(raw, { atlasSize: size, cfg });
const SHIPPED = join(ROOT, 'assets', 'scenes');

test('scenes: fixture passes stages 1-9', () => {
  const res = check(fixtureRaw());
  assert.deepEqual(res.errors, []);
  assert.ok(res.grid.cols > 0 && res.resolved.seats.length === 4);
});

test('scenes: every shipped scene passes', (t) => {
  const designs = existsSync(SHIPPED) ? readdirSync(SHIPPED, { withFileTypes: true }).filter((d) => d.isDirectory() && existsSync(join(SHIPPED, d.name, 'scene.json'))) : [];
  for (const d of designs) {
    const raw = JSON.parse(readFileSync(join(SHIPPED, d.name, 'scene.json'), 'utf8'));
    assert.equal(raw.minSeats, undefined, `${d.name}: a shipped scene must not lower the seat minimum`);
    assert.equal(raw.design, d.name);
    const res = check(raw, readPngSize(join(SHIPPED, d.name, raw.atlas)));
    assert.deepEqual(res.errors, [], d.name);
    for (const w of res.warnings) t.diagnostic(`${d.name}: ${w}`);
  }
  t.diagnostic(`${designs.length} shipped scene(s) checked`);
});

test('scenes: validator catches an unreachable seat', () => {
  const raw = fixtureRaw();
  raw.blocked.push([[270, 236], [330, 236], [330, 276], [270, 276]]); // sits on desk-3's approach
  const res = check(raw);
  assert.ok(res.errors.some((e) => /도달|reach/.test(e) && e.includes('desk-3')), res.errors.join('\n'));
});

test('scenes: validator catches a walled-in seat', () => {
  const raw = fixtureRaw();
  const [x, y] = [300, 256]; // desk-3's approach, closed in by four blocked strips
  raw.blocked.push([[x - 40, y - 40], [x + 40, y - 30], [x + 40, y - 20], [x - 40, y - 30]]);
  raw.blocked.push([[x - 40, y + 20], [x + 40, y + 20], [x + 40, y + 30], [x - 40, y + 30]]);
  raw.blocked.push([[x - 40, y - 40], [x - 28, y - 40], [x - 28, y + 30], [x - 40, y + 30]]);
  raw.blocked.push([[x + 28, y - 40], [x + 40, y - 40], [x + 40, y + 30], [x + 28, y + 30]]);
  const res = check(raw);
  assert.ok(res.errors.some((e) => /reach/.test(e) && e.includes('desk-3')), res.errors.join('\n'));
});

test('scenes: validator catches a hidden seated head', () => {
  const raw = fixtureRaw();
  raw.kinds.desk.seat.sitAt = [0, -24]; // 20px nearer the desk
  const res = check(raw);
  assert.ok(res.errors.some((e) => /^9단계/.test(e)), res.errors.join('\n'));
});

test('scenes: validator catches a chair in front of the seat and overlapping furniture', () => {
  const raw = fixtureRaw();
  raw.objects.find((o) => o.id === 'chair-1').at[1] += 12; // chair front now past at.y - 2
  assert.ok(check(raw).errors.some((e) => /^5단계/.test(e)));
  const raw2 = fixtureRaw();
  raw2.objects.push({ id: 'plant-2', kind: 'plant', at: [640, 305] });
  assert.ok(check(raw2).errors.some((e) => /^5단계.*plant-1.*plant-2|^5단계.*plant-2.*plant-1/.test(e)));
});

test('scenes: validator catches a front overlay over the door and a crowded arrival point', () => {
  const raw = fixtureRaw();
  raw.frontMask.push([[900, 380], [1020, 380], [1020, 460], [900, 460]]);
  assert.ok(check(raw).errors.some((e) => /^7단계/.test(e)));
  const raw2 = fixtureRaw();
  raw2.idle[1].at = [raw2.idle[0].at[0] + 10, raw2.idle[0].at[1]];
  assert.ok(check(raw2).errors.some((e) => /^4단계/.test(e)));
  const raw3 = fixtureRaw();
  raw3.spots[0].at = [raw3.idle[0].at[0] + 5, raw3.idle[0].at[1]];
  assert.ok(check(raw3).errors.some((e) => /^8단계/.test(e)));
});

test('scenes: CLI exits 0 on the fixture and 1 on failure', (t) => {
  const run = (...args) => spawnSync(process.execPath, [join(ROOT, 'scripts', 'check-scenes.mjs'), ...args], { encoding: 'utf8' });
  const ok = run('--dir', FIXTURE_SCENES);
  assert.equal(ok.status, 0);
  assert.match(ok.stdout, /^OK studio2/m);
  const tmp = mkdtempSync(join(tmpdir(), 'scenes-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  cpSync(FIXTURE_DIR, join(tmp, 'studio2'), { recursive: true });
  const raw = fixtureRaw();
  raw.blocked.push([[270, 236], [330, 236], [330, 276], [270, 276]]);
  writeFileSync(join(tmp, 'studio2', 'scene.json'), JSON.stringify(raw));
  const bad = run('--dir', tmp);
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /^FAIL studio2/m);
  const json = JSON.parse(run('--dir', FIXTURE_SCENES, '--json', 'studio2').stdout);
  assert.equal(json.grid.open.length, json.grid.cols * json.grid.rows);
  assert.ok(json.nodes.length > 10 && json.resolved.seats.length === 4);
  assert.equal(cfg.nav.cellPx, json.grid.cellPx);
});
