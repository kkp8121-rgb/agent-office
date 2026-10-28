import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../server/config.mjs';
import { Office } from '../server/office.mjs';
import { FIXTURE_DIR, FIXTURE_SCENES, fixtureRaw } from './helpers/fixture.mjs';

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
  const base = slots[4 + 6];
  assert.ok(Math.hypot(slots.at(-2).x - 512, slots.at(-2).y - 256) > Math.hypot(base.x - 512, base.y - 256), 'lap 2 stands farther from the room centre');
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
  const metas = Array.from({ length: 6 }, (_, i) => M(`a${i}`));
  o.syncAgents('s1', metas, 1000);
  o.syncAgents('s1', metas.map((m, i) => (i === 1 ? { ...m, finished: true } : m)), 2000);
  o.tick(2000 + o.cfg.agent.doneLingerMs);
  o.syncAgents('s1', [metas[0], { ...metas[1], finished: true }, ...metas.slice(2), M('late')], 30000);
  const late = agentsOf(o).find((a) => a.agentId === 'late');
  assert.equal(late.slot.i, 1);
  assert.equal(late.slot.kind, 'seat');
});

test('office-scene: design without scene keeps legacy slot shape', () => {
  const o = setup(loadConfig({ scenesDir: FIXTURE_SCENES, designOrder: ['lounge'] }));
  o.syncAgents('s1', [M('a0')], 1000);
  assert.deepEqual(Object.keys(agentsOf(o)[0].slot).sort(), ['i', 'x', 'y']);
});

test('office-scene: broken scene with legacy layout falls back, without layout refuses start', (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'scenes-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const broken = (name) => {
    cpSync(FIXTURE_DIR, join(tmp, name), { recursive: true });
    const raw = fixtureRaw();
    raw.design = name;
    delete raw.seats;
    writeFileSync(join(tmp, name, 'scene.json'), JSON.stringify(raw));
  };
  broken('studio2');
  const warn = mock.method(console, 'warn', () => {});
  const cfg = loadConfig({ scenesDir: tmp, designOrder: ['studio2'] });
  assert.equal(cfg.scenes.studio2, undefined);
  assert.equal(warn.mock.callCount(), 1);
  warn.mock.restore();
  broken('noroom');
  assert.throws(() => loadConfig({ scenesDir: tmp, designOrder: ['noroom'] }), /장면 검사 실패/);
});

test('office-scene: a scene whose design differs from its folder is refused', (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'scenes-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  cpSync(FIXTURE_DIR, join(tmp, 'other'), { recursive: true });
  assert.throws(() => loadConfig({ scenesDir: tmp, designOrder: ['other'] }), /design/);
});
