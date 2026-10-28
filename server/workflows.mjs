// Workflow run progress: journal.jsonl tail and phase titles from the run script (never executed).
import { join } from 'node:path';
import { FileTail } from './tail.mjs';

export class WorkflowJournal {
  /** @type {Map<string,{label:string, phase:string}>} keyed by agentId */
  started = new Map();
  /** @type {Set<string>} agentIds that returned a result */
  finished = new Set();
  #tail;

  constructor(runDir, tailOpts) {
    this.#tail = new FileTail(join(runDir, 'journal.jsonl'), tailOpts);
  }

  async poll() {
    let lines;
    try {
      lines = await this.#tail.poll();
    } catch (e) {
      if (e?.code === 'ENOENT') return; // journal not written yet
      throw e;
    }
    for (const line of lines) {
      let j;
      try {
        j = JSON.parse(line);
      } catch {
        continue;
      }
      if (!j || typeof j.agentId !== 'string') continue;
      // Only ids, label and phase are read; the result payload is never kept.
      if (j.type === 'started') {
        this.started.set(j.agentId, {
          label: typeof j.label === 'string' ? j.label : '',
          phase: typeof j.phase === 'string' ? j.phase : '',
        });
      } else if (j.type === 'result') {
        this.finished.add(j.agentId);
      }
    }
  }
}

export function phasesFromScript(scriptText) {
  const m = /export\s+const\s+meta\s*=\s*\{[\s\S]*?\bphases\s*:\s*\[([\s\S]*?)\]\s*[,}]/.exec(String(scriptText));
  if (!m) return [];
  return [...m[1].matchAll(/\btitle\s*:\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g)].map((t) => t[2]);
}
