import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function isPlain(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function merge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over ?? {})) {
    out[k] = isPlain(v) && isPlain(out[k]) ? merge(out[k], v) : v;
  }
  return out;
}

/** Delay before the next poll round: the slow idle rate while no browser is connected. */
export function pollDelayMs(cfg, sseClients) {
  return sseClients > 0 ? cfg.pollMs : cfg.idlePollMs;
}

export function loadConfig(overrides = {}) {
  const file = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  const cfg = merge(file, overrides);
  cfg.root = ROOT;
  cfg.claudeHome = process.env.AGENT_OFFICE_CLAUDE_HOME || path.join(os.homedir(), '.claude');
  cfg.codexHome = process.env.AGENT_OFFICE_CODEX_HOME || path.join(os.homedir(), '.codex');
  cfg.dataDir = process.env.AGENT_OFFICE_DATA_DIR || path.join(ROOT, 'data');
  if (process.env.AGENT_OFFICE_PORT) cfg.port = Number(process.env.AGENT_OFFICE_PORT);
  return cfg;
}
