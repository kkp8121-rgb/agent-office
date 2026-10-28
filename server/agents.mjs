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

/**
 * @returns {Promise<AgentMeta[]>} `readFile` is injectable for tests; `dirTrustMs` is the directory-listing trust window (see names).
 * A workflow run whose agents have all ended and whose folder and meta files have been quiet for `runSettleMs` is remembered whole: later
 * scans neither stat nor list it, so scan cost follows the active runs, not the session's whole workflow history.
 */
export async function listAgents(sessionDir, cache, readFile = fsReadFile, dirTrustMs = 0, runSettleMs = dirTrustMs) {
  const root = join(sessionDir, 'subagents');
  const isMeta = (n) => META_RE.test(n);
  const out = [];
  for (const n of await names(root, isMeta, cache, dirTrustMs)) {
    const m = await readMeta(root, n, null, cache, readFile);
    if (m) out.push(m);
  }
  const wfRoot = join(root, 'workflows');
  for (const run of await names(wfRoot, (n) => n.startsWith('wf_'), cache, dirTrustMs)) {
    const dir = join(wfRoot, run);
    const frozen = cache.get(`run:${dir}`);
    if (frozen) {
      out.push(...frozen);
      continue;
    }
    const files = await names(dir, isMeta, cache, dirTrustMs);
    const metas = [];
    for (const n of files) {
      const m = await readMeta(dir, n, run, cache, readFile);
      if (m) metas.push(m);
    }
    out.push(...metas);
    const listing = cache.get(dir);
    // The folder mtime only moves when an agent file appears; finishing an agent rewrites its meta, so quiet counts both.
    const lastActive = Math.max(listing?.mtimeMs ?? 0, ...metas.map((m) => m.mtimeMs));
    const quiet = listing?.trusted && Date.now() - lastActive >= runSettleMs;
    if (quiet && metas.length === files.length && files.length > 0 && files.every((n) => cache.get(join(dir, n))?.settled)) {
      cache.set(`run:${dir}`, metas);
    }
  }
  return out;
}
