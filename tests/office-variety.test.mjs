// Varied characters: unknown agent kinds are spread over the cast, bosses rotate per floor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { loadConfig } from '../server/config.mjs';
import { Office } from '../server/office.mjs';
import { createServer } from '../server/http.mjs';

const cfg = loadConfig();
const EMPTY = { hidden: [], names: {} };

const S = (id, o = {}) => ({
  provider: 'claude', pid: 100, sessionId: id, cwd: 'C:\\Project', status: 'busy', name: '', startedAt: 1000, ...o,
});
const M = (id, o = {}) => ({
  agentId: id, agentType: 'general-purpose', description: '조사', finished: false, transcriptPath: '', mtimeMs: 0, workflow: null, ...o,
});
const floorOf = (o, id) => o.snapshot().floors.find((f) => f.sessionId === id);
const baseName = (n) => n.replace(/\+\d+$/, '');
const many = (n, o = {}) => Array.from({ length: n }, (_, i) => M(`a${i}`, o));

function setup(live = [S('s1')], now = 1000) {
  const o = new Office(cfg, EMPTY);
  o.syncSessions(live, now);
  return o;
}

// Name a sprite key has on a floor of the given provider: the codex: entry first, then the Claude one.
function nameOf(key, codex) {
  const entries = Object.entries(cfg.roles);
  const claude = entries.find(([k, r]) => !k.startsWith('codex:') && r.key === key)[1].name;
  const cx = entries.find(([k, r]) => k.startsWith('codex:') && r.key === key)?.[1].name;
  return codex ? (cx ?? claude) : claude;
}

test('variety: 5 general-purpose agents on one Claude floor get 5 different sprites and names', () => {
  const o = setup();
  o.syncAgents('s1', many(5), 1000);
  const agents = floorOf(o, 's1').agents;
  assert.equal(agents.length, 5);
  assert.equal(new Set(agents.map((a) => a.sprite)).size, 5);
  assert.equal(new Set(agents.map((a) => a.name)).size, 5);
  for (const a of agents) {
    assert.notEqual(a.sprite, 'lead');
    assert.equal(a.name, nameOf(a.sprite, false));
    assert.equal(a.role, 'general-purpose');
  }
});

test('variety: all 17 pool characters are used before any repeats, then the least used again', () => {
  const o = setup();
  o.syncAgents('s1', many(17), 1000);
  const agents = floorOf(o, 's1').agents;
  assert.equal(new Set(agents.map((a) => a.sprite)).size, 17);
  o.syncAgents('s1', many(18), 1000);
  const counts = new Map();
  for (const a of floorOf(o, 's1').agents) counts.set(a.sprite, (counts.get(a.sprite) ?? 0) + 1);
  assert.deepEqual([...counts.values()].sort(), [...Array(16).fill(1), 2]);
});

test('variety: known kinds keep their fixed character and count toward the spread', () => {
  const o = setup();
  o.syncAgents('s1', [
    M('k1', { agentType: 'worker' }), M('k2', { agentType: 'scout' }), M('k3', { agentType: 'Explore' }),
    ...many(3).map((m, i) => ({ ...m, agentId: `u${i}` })),
  ], 1000);
  const by = Object.fromEntries(floorOf(o, 's1').agents.map((a) => [a.agentId, a]));
  assert.deepEqual([by.k1.name, by.k1.role, by.k1.sprite], ['서진', '개발', 'worker']);
  assert.deepEqual([by.k2.name, by.k2.role, by.k2.sprite], ['다온', '정찰', 'scout']);
  assert.deepEqual([by.k3.name, by.k3.role, by.k3.sprite], ['루아', '탐색', 'explore']);
  const taken = new Set(['worker', 'scout', 'explore']);
  const unknown = [by.u0, by.u1, by.u2].map((a) => a.sprite);
  assert.equal(new Set(unknown).size, 3);
  for (const s of unknown) assert.equal(taken.has(s), false, 'the least used character is picked, not one already seated');
});

test('variety: Codex floor unknown kinds use codex: names where they exist, Claude names otherwise', () => {
  const o = setup([S('cx', { provider: 'codex' })]);
  o.syncAgents('cx', [
    ...many(15, { agentType: 'codex:__default' }),
    M('e1', { agentType: 'codex:explorer' }), M('e2', { agentType: 'codex:explorer' }),
  ], 1000);
  const agents = floorOf(o, 'cx').agents;
  assert.equal(new Set(agents.map((a) => a.sprite)).size, 17);
  for (const a of agents) assert.equal(a.name, nameOf(a.sprite, true));
  assert.ok(agents.some((a) => a.sprite === 'worker' && a.name === '도담'));
  assert.ok(agents.some((a) => a.sprite === 'default' && a.name === '누리'));
  assert.ok(agents.some((a) => a.sprite === 'explore' && a.name === '루아'), 'no codex: entry: the Claude name');
  assert.deepEqual([...new Set(agents.map((a) => a.role))].sort(), ['explorer', '지원']);
});

test('variety: Codex known role keeps its fixed character', () => {
  const o = setup([S('cx', { provider: 'codex' })]);
  o.syncAgents('cx', [M('a1', { agentType: 'codex:worker' }), M('a2', { agentType: 'codex:architect_high' })], 1000);
  const [a, b] = floorOf(o, 'cx').agents;
  assert.deepEqual([a.name, a.role, a.sprite], ['도담', '개발', 'worker']);
  assert.deepEqual([b.name, b.role, b.sprite], ['새봄', '수석', 'architect-high']);
});

test('variety: the role label shows the kind, "지원" when empty, clipped and cleaned like other server text', () => {
  const o = setup();
  const kinds = [
    '', null, undefined, 'codex:__default', '__lead', 'https://tok-SECRET@host/x', 'Bearer SECRET-BEARER', 'C:\\Users\\x\\SECRET',
    'a\u202Eb', 'x'.repeat(40), 'code.reviewer+2',
  ];
  o.syncAgents('s1', kinds.map((k, i) => M(`a${i}`, { agentType: k })), 1000);
  const roles = floorOf(o, 's1').agents.map((a) => a.role);
  assert.deepEqual(roles.slice(0, 8), Array(8).fill('지원'));
  assert.equal(roles[8], '지원', 'format characters are not allowed in a label');
  assert.equal(roles[9], `${'x'.repeat(cfg.agent.roleMaxChars - 1)}…`);
  assert.equal(roles[10], 'code.reviewer+2');
  assert.ok(!JSON.stringify(floorOf(o, 's1')).match(/SECRET|https:|Bearer|Users/));
});

test('variety: bosses rotate per floor among 5 characters, the 6th floor reuses the least used', () => {
  const live = Array.from({ length: 5 }, (_, i) => S(`s${i}`, { startedAt: 1000 + i, provider: i % 2 ? 'codex' : 'claude' }));
  const o = setup(live);
  const leads = [0, 1, 2, 3, 4].map((i) => floorOf(o, `s${i}`).lead);
  assert.equal(new Set(leads.map((l) => l.sprite)).size, 5);
  assert.deepEqual(leads.map((l) => l.sprite).sort(), ['lead', 'lead-2', 'lead-3', 'lead-4', 'lead-5']);
  assert.deepEqual(leads.map((l) => l.name).sort(), ['다인', '수아', '유나', '윤슬', '하나'].sort());
  assert.ok(leads.every((l) => l.role === '팀장'), 'provider does not decide the boss');
  assert.deepEqual(cfg.leads.map((l) => l.key), ['lead', 'lead-2', 'lead-3', 'lead-4', 'lead-5']);
  assert.deepEqual(cfg.leads.map((l) => l.name), ['유나', '하나', '수아', '윤슬', '다인']);

  o.syncSessions([...live, S('s5', { startedAt: 1005 })], 1100);
  const sixth = floorOf(o, 's5').lead;
  assert.ok(leads.some((l) => l.sprite === sixth.sprite));
  const counts = new Map();
  for (const f of o.snapshot().floors) counts.set(f.lead.sprite, (counts.get(f.lead.sprite) ?? 0) + 1);
  assert.deepEqual([...counts.values()].sort(), [1, 1, 1, 1, 2]);
});

test('variety: a hidden floor frees its boss at once, a floor that left frees it after floor.leaveMs', () => {
  // Rule (same as #pickDesign): a boss is taken while its floor is on screen, i.e. not hidden and not yet removed.
  const live = Array.from({ length: 5 }, (_, i) => S(`s${i}`, { startedAt: 1000 + i }));
  const o = setup(live);
  const hiddenSprite = floorOf(o, 's2').lead.sprite;
  o.hide('s2');
  o.syncSessions([...live, S('n1', { startedAt: 2000 })], 1100);
  assert.equal(floorOf(o, 'n1').lead.sprite, hiddenSprite, 'a hidden floor does not keep its boss reserved');

  const leftSprite = floorOf(o, 's3').lead.sprite;
  const rest = [...live.filter((s) => s.sessionId !== 's3'), S('n1', { startedAt: 2000 })];
  o.syncSessions(rest, 3000);
  assert.equal(floorOf(o, 's3').status, 'leaving');
  o.syncSessions(rest, 3000 + cfg.floor.leaveMs);
  o.tick(3000 + cfg.floor.leaveMs);
  assert.equal(floorOf(o, 's3'), undefined);
  o.syncSessions([...rest, S('n3', { startedAt: 4000 })], 9000);
  assert.equal(floorOf(o, 'n3').lead.sprite, leftSprite, 'the boss of the floor that left is the least used again');
});

test('variety: the boss name stays reserved so an agent cannot take it', () => {
  const o = setup([S('s1')]);
  const f = o.floors.get('s1');
  assert.ok(f.usedNames.has(f.lead.name));
});

test('variety: /api/ui lists the bosses so the page can draw lead-2..lead-5', async () => {
  const office = new Office(cfg, EMPTY);
  const server = createServer(cfg, office, {});
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const { port } = server.address();
    const body = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/api/ui', headers: { Host: `127.0.0.1:${port}` } }, (res) => {
        let b = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (b += c));
        res.on('end', () => resolve(b));
      }).on('error', reject);
    });
    const ui = JSON.parse(body);
    for (const l of cfg.leads) assert.deepEqual(ui.roles[l.key], { name: l.name, role: l.role });
    assert.deepEqual(ui.leads, cfg.leads.map((l) => l.key));
    assert.deepEqual(ui.roles.default, { name: '나래', role: '지원' });
  } finally {
    server.closeSse();
    await new Promise((r) => { server.close(r); server.closeAllConnections(); });
  }
});
