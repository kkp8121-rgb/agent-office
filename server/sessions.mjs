// Discovers live Claude Code sessions (~/.claude/sessions/*.json) and their transcript folders.
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

/** @typedef {{provider:'claude'|'codex', pid:number, sessionId:string, cwd:string, status:string, name:string, startedAt:number}} Session */

export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === 'EPERM';
  }
}

// Ids become path segments, so only plain names are accepted.
export const isSafeId = (id) => typeof id === 'string' && /^[\w.-]+$/.test(id) && id !== '.' && !id.includes('..');

const str = (v) => (typeof v === 'string' ? v : '');

/** @returns {Promise<Session[]>} */
export async function listLiveSessions(claudeHome) {
  let names;
  try {
    names = await readdir(join(claudeHome, 'sessions'));
  } catch {
    return [];
  }
  const out = [];
  for (const n of names) {
    if (!n.endsWith('.json')) continue; // never open *.key or anything else (privacy)
    let j;
    try {
      j = JSON.parse(await readFile(join(claudeHome, 'sessions', n), 'utf8'));
    } catch {
      continue;
    }
    if (!j || typeof j !== 'object') continue;
    if (!Number.isInteger(j.pid) || !isSafeId(j.sessionId)) continue;
    if (typeof j.startedAt !== 'number' || !Number.isFinite(j.startedAt)) continue; // no usable start time: skip
    if (!isPidAlive(j.pid)) continue;
    out.push({
      provider: 'claude',
      pid: j.pid,
      sessionId: j.sessionId,
      cwd: str(j.cwd),
      status: str(j.status),
      name: str(j.name),
      startedAt: j.startedAt,
    });
  }
  return out;
}

const pathCache = new Map();

/** Finds projects/<any>/<sessionId>.jsonl; hits are remembered, misses are searched again next call. */
export async function findSessionPaths(claudeHome, sessionId) {
  if (!isSafeId(sessionId)) return null;
  const key = `${claudeHome}|${sessionId}`;
  if (pathCache.has(key)) return pathCache.get(key);
  let projects;
  try {
    projects = await readdir(join(claudeHome, 'projects'), { withFileTypes: true });
  } catch {
    return null;
  }
  for (const p of projects) {
    if (!p.isDirectory()) continue;
    const transcript = join(claudeHome, 'projects', p.name, `${sessionId}.jsonl`);
    try {
      await stat(transcript);
    } catch {
      continue;
    }
    const found = { transcript, sessionDir: join(claudeHome, 'projects', p.name, sessionId) };
    pathCache.set(key, found);
    return found;
  }
  return null;
}
