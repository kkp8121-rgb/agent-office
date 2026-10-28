// Persistence for forced-hide records and renamed floor titles (<dir>/hidden.json, <dir>/names.json).
// Only session id, pid, start time and the user's own names are written - nothing from transcripts.
import { mkdirSync, readFileSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const isFiniteNum = (v) => typeof v === 'number' && Number.isFinite(v);

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null; // missing or broken: start empty
  }
}

export function loadSaved(dir) {
  const h = readJson(join(dir, 'hidden.json'));
  const n = readJson(join(dir, 'names.json'));
  const hidden = (Array.isArray(h) ? h : [])
    .filter((r) => r && typeof r.sessionId === 'string' && isFiniteNum(r.pid) && isFiniteNum(r.startedAt))
    .map((r) => ({ sessionId: r.sessionId, pid: r.pid, startedAt: r.startedAt }));
  const names = {};
  if (n && typeof n === 'object' && !Array.isArray(n)) {
    for (const [id, v] of Object.entries(n)) if (typeof v === 'string') names[id] = v;
  }
  return { hidden, names };
}

async function writeAtomic(file, value) {
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  await rename(tmp, file);
}

export async function saveSaved(dir, saved) {
  mkdirSync(dir, { recursive: true });
  const hidden = saved.hidden.map((r) => ({ sessionId: r.sessionId, pid: r.pid, startedAt: r.startedAt }));
  await writeAtomic(join(dir, 'hidden.json'), hidden);
  await writeAtomic(join(dir, 'names.json'), { ...saved.names });
}
