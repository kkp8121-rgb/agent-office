import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../server/config.mjs';
import { Office } from '../server/office.mjs';
import { FIXTURE_DIR, FIXTURE_SCENES, ROOT, fixtureRaw } from './helpers/fixture.mjs';
import { resolveScene } from '../web/scene.mjs';
import { bakeGrid, isOpen } from '../web/nav.mjs';

const EMPTY = { hidden: [], names: {} };
const S = (id, o = {}) => ({ provider: 'claude', pid: 100, sessionId: id, cwd: 'C:\\Project', status: 'busy', name: '', startedAt: 1000, ...o });
const M = (id, o = {}) => ({ agentId: id, agentType: 'worker', description: 'x', finished: false, transcriptPath: '', mtimeMs: 0, workflow: null, ...o });

const sceneCfg = () => loadConfig({ scenesDir: FIXTURE_SCENES, designOrder: ['studio2'] });
function setup(cfg = sceneCfg()) {
  const o = new Office(cfg, EMPTY);
  o.syncSessions([S('s1')], 1000);
  return o;
}
const agentsOf = (o) => o.snapshot().floors.find((f) => f.sessionId === 's1').agents;

test('office-scene: seats, then idle, then overflow', () => {
  const o = setup();
  o.syncAgents('s1', Array.from({ length: 4 + 6 + 8 + 2 }, (_, i) => M(`a${i}`)), 1000);
  const slots = agentsOf(o).map((a) => a.slot);
  const kinds = slots.map((s) => s.kind);
  assert.deepEqual(kinds, [...Array(4).fill('seat'), ...Array(6).fill('idle'), ...Array(8).fill('overflow'), 'overflow', 'overflow']);
  assert.deepEqual(slots.map((s) => s.i), slots.map((_, i) => i));
  assert.deepEqual(slots.slice(-2).map((s) => s.ring), [1, 1]);
  assert.ok(slots.slice(0, -2).every((s) => s.ring === 0));
  assert.equal(new Set(slots.map((s) => `${s.x},${s.y}`)).size, slots.length, 'no two characters share a point');
});

test('office-scene: seat slot carries approach, sit and face', () => {
  const raw = fixtureRaw();
  const o = setup();
  o.syncAgents('s1', [M('a0')], 1000);
  const slot = agentsOf(o)[0].slot;
  const desk = raw.objects.find((x) => x.id === 'desk-1');
  const seat = raw.kinds.desk.seat;
  assert.equal(slot.kind, 'seat');
  assert.equal(slot.ref, '0', 'the seat number, never a desk id ("desk-1" contains "sk-", which the privacy guard bans from /api/state)');
  assert.deepEqual([slot.x, slot.y], [desk.at[0] + seat.at[0], desk.at[1] + seat.at[1]]);
  assert.deepEqual(slot.sit, [desk.at[0] + seat.sitAt[0], desk.at[1] + seat.sitAt[1]]);
  assert.deepEqual(slot.approach, [desk.at[0] + seat.approach[0], desk.at[1] + seat.approach[1]]);
  assert.equal(slot.face, 'right');
});

test('office-scene: freed seat is reused', () => {
  const o = setup();
  const metas = Array.from({ length: 4 }, (_, i) => M(`a${i}`)); // nobody waits, so the freed desk stays open for the newcomer
  o.syncAgents('s1', metas, 1000);
  o.syncAgents('s1', metas.map((m, i) => (i === 1 ? { ...m, finished: true } : m)), 2000);
  o.tick(2000 + o.cfg.agent.doneLingerMs);
  o.syncAgents('s1', [metas[0], { ...metas[1], finished: true }, ...metas.slice(2), M('late')], 30000);
  const late = agentsOf(o).find((a) => a.agentId === 'late');
  assert.equal(late.slot.i, 1);
  assert.equal(late.slot.kind, 'seat');
});

test('office-scene: a design without a scene, or with a broken one, refuses to start', (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'scenes-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  cpSync(FIXTURE_DIR, join(tmp, 'noroom'), { recursive: true });
  const raw = fixtureRaw();
  raw.design = 'noroom';
  delete raw.seats;
  writeFileSync(join(tmp, 'noroom', 'scene.json'), JSON.stringify(raw));
  assert.throws(() => loadConfig({ scenesDir: tmp, designOrder: ['noroom'] }), /장면 검사 실패/);
  assert.throws(() => loadConfig({ scenesDir: tmp, designOrder: ['absent'] }), /장면 검사 실패/);
});

test('office-scene: a scene whose design differs from its folder is refused', (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'scenes-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  cpSync(FIXTURE_DIR, join(tmp, 'other'), { recursive: true });
  assert.throws(() => loadConfig({ scenesDir: tmp, designOrder: ['other'] }), /design/);
});

// Sprite boxes of the 30 characters on one floor, as the screen draws them (open floor is never moved by the snap).
function overflowOverlap(cfg, design) {
  const o = new Office(cfg, EMPTY);
  o.syncSessions([S('s1')], 1000);
  o.syncAgents('s1', Array.from({ length: 30 }, (_, i) => M(`a${i}`)), 1000);
  const slots = agentsOf(o).map((a) => a.slot);
  const g = bakeGrid(resolveScene(cfg.scenes[design].raw), cfg.nav);
  const [bw, bh] = [cfg.nav.spriteWidthPx, cfg.spriteHeight];
  const area = (p, q) => Math.max(0, bw - Math.abs(p.x - q.x)) * Math.max(0, bh - Math.abs(p.y - q.y)) / (bw * bh);
  let worst = 0;
  slots.forEach((p, i) => slots.slice(i + 1).forEach((q) => { worst = Math.max(worst, area(p, q)); }));
  const [w, h] = cfg.scenes[design].raw.size;
  for (const s of slots) assert.ok(s.x >= 0 && s.x <= w && s.y >= 0 && s.y <= h, `${design}: ${s.x},${s.y}`);
  for (const s of slots.filter((x) => x.kind === 'overflow' && x.ring > 0)) assert.ok(isOpen(g, [s.x, s.y]), `${design}: lap spot ${s.x},${s.y} is closed floor`);
  return worst;
}

test('office-scene: 30 characters on the fixture overlap by at most half', () => {
  const worst = overflowOverlap(sceneCfg(), 'studio2');
  assert.ok(worst <= 0.5, `worst overlap ${worst}`);
});

test('office-scene: 30 characters on every shipped scene overlap by at most half', (t) => {
  const dir = join(ROOT, 'assets', 'scenes');
  const designs = existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && existsSync(join(dir, d.name, 'scene.json'))).map((d) => d.name) : [];
  for (const d of designs) {
    const worst = overflowOverlap(loadConfig({ scenesDir: dir, designOrder: [d] }), d);
    assert.ok(worst <= 0.5, `${d}: worst overlap ${worst}`);
  }
  t.diagnostic(`${designs.length} shipped scene(s) checked`);
});
