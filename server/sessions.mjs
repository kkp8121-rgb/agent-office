// Discovers live Claude Code sessions (~/.claude/sessions/*.json) and their transcript folders.
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { uptime } from 'node:os';

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

const BOOT_MS = Date.now() - uptime() * 1000; // read once: the boot time does not change

/**
 * A session file written before the last boot belongs to a process that no longer exists; the pid may have been given to an
 * unrelated process since, which the pid check alone would take for the session. `bootMs` is injectable for tests.
 * @returns {Promise<Session[]>}
 */
export async function listLiveSessions(claudeHome, bootMs = BOOT_MS) {
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
    if (j.startedAt < bootMs) {
      try {
        if ((await stat(join(claudeHome, 'sessions', n))).mtimeMs < bootMs) continue;
      } catch {
        continue;
      }
    }
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
const missUntil = new Map(); // key -> time before which the full folder scan is not repeated

/**
 * Finds projects/<any>/<sessionId>.jsonl; hits are remembered. A miss costs one stat of the folder Claude names after `cwd`
 * and, at most every `retryMs` (needs `now`), a scan of every project folder; without them each call scans.
 */
export async function findSessionPaths(claudeHome, sessionId, { cwd = '', now, retryMs = 0 } = {}) {
  if (!isSafeId(sessionId)) return null;
  const key = `${claudeHome}|${sessionId}`;
  if (pathCache.has(key)) return pathCache.get(key);
  const remember = (folder) => {
    const dir = join(claudeHome, 'projects', folder);
    const found = { transcript: join(dir, `${sessionId}.jsonl`), sessionDir: join(dir, sessionId) };
    pathCache.set(key, found);
    missUntil.delete(key);
    return found;
  };
  const guess = cwd.replace(/[^A-Za-z0-9]/g, '-'); // e.g. C:, Project, app -> C--Project-app
  if (guess) {
    try {
      await stat(join(claudeHome, 'projects', guess, `${sessionId}.jsonl`));
      return remember(guess);
    } catch {
      // not in the expected folder: fall through to the scan
    }
  }
  if (now !== undefined && now < (missUntil.get(key) ?? 0)) return null;
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
    return remember(p.name);
  }
  if (now !== undefined && retryMs > 0) missUntil.set(key, now + retryMs);
  return null;
}
