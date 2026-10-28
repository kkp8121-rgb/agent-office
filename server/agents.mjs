// Lists subagents of a session from their *.meta.json files (background and workflow agents).
import { readdir, readFile as fsReadFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

/** @typedef {{agentId:string, agentType:string, description:string, finished:boolean, transcriptPath:string, mtimeMs:number,
 *             workflow: null | {runId:string, phase:string, label:string}}} AgentMeta */

const str = (v) => (typeof v === 'string' ? v : '');
const META_RE = /^agent-(.+)\.meta\.json$/;

/**
 * Names in `dir` that pass `keep`. The listing is remembered in `cache` under the directory path and reused while the
 * directory's mtime is unchanged, unless it was taken within `trustMs` of that mtime (a later change could share it).
 */
async function names(dir, keep, cache, trustMs) {
  let mtimeMs;
  try {
    mtimeMs = (await stat(dir)).mtimeMs;
  } catch {
    cache.delete(dir);
    return [];
  }
  const hit = cache.get(dir);
  if (hit?.trusted && hit.mtimeMs === mtimeMs) return hit.names;
  const listedAt = Date.now();
  let all;
  try {
    all = await readdir(dir);
  } catch {
    return [];
  }
  const kept = all.filter(keep);
  cache.set(dir, { mtimeMs, names: kept, trusted: listedAt - mtimeMs > trustMs });
  return kept;
}

async function readMeta(dir, name, runId, cache, readFile) {
  const file = join(dir, name);
  const settled = cache.get(file);
  if (settled?.settled) return settled.value; // a finished agent's meta never changes again: not even a stat
  let mtimeMs;
  try {
    mtimeMs = (await stat(file)).mtimeMs;
  } catch {
    return null;
  }
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === mtimeMs) return hit.value;
  let j;
  try {
    j = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null; // possibly mid-write; nothing is cached so the next call retries
  }
  if (!j || typeof j !== 'object') return null;
  const value = {
    agentId: META_RE.exec(name)[1],
    agentType: str(j.agentType),
    description: str(j.description),
    finished: j.finished === true,
    transcriptPath: join(dir, name.replace(/\.meta\.json$/, '.jsonl')),
    mtimeMs,
    workflow: runId ? { runId, phase: str(j.workflowPhase), label: str(j.description) } : null,
  };
  cache.set(file, { mtimeMs, value, settled: value.finished });
  return value;
}

/** Marks an agent whose end is known from elsewhere (workflow journal result): its meta is not stat-ed again. */
export function markSettled(cache, meta) {
  const hit = cache.get(meta.transcriptPath.replace(/\.jsonl$/, '.meta.json'));
  if (hit) hit.settled = true;
}

/** @returns {Promise<AgentMeta[]>} `readFile` is injectable for tests; `dirTrustMs` is the directory-listing trust window (see names). */
export async function listAgents(sessionDir, cache, readFile = fsReadFile, dirTrustMs = 0) {
  const root = join(sessionDir, 'subagents');
  const isMeta = (n) => META_RE.test(n);
  const targets = [];
  for (const n of await names(root, isMeta, cache, dirTrustMs)) targets.push([root, n, null]);
  const wfRoot = join(root, 'workflows');
  for (const run of await names(wfRoot, (n) => n.startsWith('wf_'), cache, dirTrustMs)) {
    for (const n of await names(join(wfRoot, run), isMeta, cache, dirTrustMs)) targets.push([join(wfRoot, run), n, run]);
  }
  const out = [];
  for (const [dir, n, runId] of targets) {
    const m = await readMeta(dir, n, runId, cache, readFile);
    if (m) out.push(m);
  }
  return out;
}
