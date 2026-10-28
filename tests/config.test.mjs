import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../server/config.mjs';

// A developer shell may export these (the demo instructions do): every test starts without them and restores them after.
const ENV_KEYS = ['AGENT_OFFICE_PORT', 'AGENT_OFFICE_CLAUDE_HOME', 'AGENT_OFFICE_CODEX_HOME', 'AGENT_OFFICE_DATA_DIR'];
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
beforeEach(() => { for (const k of ENV_KEYS) delete process.env[k]; });
afterEach(() => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

test('config: defaults from config.json', () => {
  const cfg = loadConfig();
  assert.equal(cfg.port, 47800);
  assert.equal(cfg.roles.worker.name, '서진');
  assert.equal(cfg.layouts.studio.desks.length, 8);
  for (const d of cfg.designOrder) assert.ok(cfg.layouts[d], d);
});
test('config: AGENT_OFFICE_CLAUDE_HOME sets claudeHome', () => {
  const prev = process.env.AGENT_OFFICE_CLAUDE_HOME;
  process.env.AGENT_OFFICE_CLAUDE_HOME = 'X:/fake-claude';
  try { assert.equal(loadConfig().claudeHome, 'X:/fake-claude'); }
  finally { if (prev === undefined) delete process.env.AGENT_OFFICE_CLAUDE_HOME; else process.env.AGENT_OFFICE_CLAUDE_HOME = prev; }
});
test('config: overrides deep-merge, root is absolute', () => {
  const cfg = loadConfig({ log: { cap: 5 } });
  assert.equal(cfg.log.cap, 5);
  assert.equal(cfg.log.sendCap, 200);
  assert.ok(cfg.root.length > 3);
});
test('config: AGENT_OFFICE_CODEX_HOME sets codexHome, codex block from config.json', () => {
  const prev = process.env.AGENT_OFFICE_CODEX_HOME;
  process.env.AGENT_OFFICE_CODEX_HOME = 'X:/fake-codex';
  try {
    const cfg = loadConfig();
    assert.equal(cfg.codexHome, 'X:/fake-codex');
    assert.equal(cfg.codex.enabled, true);
    assert.equal(cfg.roles['codex:__lead'].name, '하나');
  } finally { if (prev === undefined) delete process.env.AGENT_OFFICE_CODEX_HOME; else process.env.AGENT_OFFICE_CODEX_HOME = prev; }
});
