// Lists subagents of a session from their *.meta.json files (background and workflow agents).
import { readdir, readFile as fsReadFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

/** @typedef {{agentId:string, agentType:string, description:string, finished:boolean, transcriptPath:string, mtimeMs:number,
 *             workflow: null | {runId:string, phase:string, label:string}}} AgentMeta */

const str = (v) => (typeof v === 'string' ? v : '');
const META_RE = /^agent-(.+)\.meta\.json$/;

async function names(dir) {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

async function readMeta(dir, name, runId, cache, readFile) {
  const file = join(dir, name);
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
  cache.set(file, { mtimeMs, value });
  return value;
}

/** @returns {Promise<AgentMeta[]>} `readFile` is injectable for tests. */
export async function listAgents(sessionDir, cache, readFile = fsReadFile) {
  const root = join(sessionDir, 'subagents');
  const targets = [];
  for (const n of await names(root)) {
    if (META_RE.test(n)) targets.push([root, n, null]);
  }
  const wfRoot = join(root, 'workflows');
  for (const run of await names(wfRoot)) {
    if (!run.startsWith('wf_')) continue;
    for (const n of await names(join(wfRoot, run))) {
      if (META_RE.test(n)) targets.push([join(wfRoot, run), n, run]);
    }
  }
  const out = [];
  for (const [dir, n, runId] of targets) {
    const m = await readMeta(dir, n, runId, cache, readFile);
    if (m) out.push(m);
  }
  return out;
}
