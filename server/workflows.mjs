// Workflow run progress: journal.jsonl tail and phase titles from the run script (never executed).
import { join } from 'node:path';
import { FileTail } from './tail.mjs';

/** One journal line -> {type, agentId, label, phase}. A line clipped at the byte limit is not valid JSON: its head is matched instead. */
function parseEntry(line) {
  try {
    return JSON.parse(line);
  } catch {
    // clipped line (type, key and agentId come first, the result payload last) or noise
  }
  const type = /"type"\s*:\s*"(\w+)"/.exec(line)?.[1];
  const agentId = /"agentId"\s*:\s*"([^"\\]+)"/.exec(line)?.[1];
  if (!type || !agentId) return null;
  const quoted = (key) => {
    const m = new RegExp(`"${key}"\\s*:\\s*("(?:[^"\\\\]|\\\\.)*")`).exec(line);
    try {
      return m ? JSON.parse(m[1]) : '';
    } catch {
      return '';
    }
  };
  return { type, agentId, label: quoted('label'), phase: quoted('phase') };
}

export class WorkflowJournal {
  /** @type {Map<string,{label:string, phase:string}>} keyed by agentId */
  started = new Map();
  /** @type {Set<string>} agentIds that returned a result */
  finished = new Set();
  #path;
  #opts;
  #tail = null; // created by the first poll, dropped by release()
  #resume = 0; // where the next tail continues after a release
  #mtimeMs = 0;

  /** The journal is read from its first byte (result lines may be anywhere in it); lines are clipped at tailOpts.maxLineBytes. */
  constructor(runDir, tailOpts) {
    this.#path = join(runDir, 'journal.jsonl');
    this.#opts = { ...tailOpts, startBytes: 0, clipLines: true };
  }

  /** Modification time of the journal file as of the last poll that found it. */
  get mtimeMs() {
    return this.#mtimeMs;
  }

  async poll() {
    this.#tail ??= new FileTail(this.#path, { ...this.#opts, offset: this.#resume });
    let lines;
    try {
      lines = await this.#tail.poll();
    } catch (e) {
      if (e?.code === 'ENOENT') return; // journal not written yet
      throw e;
    }
    this.#mtimeMs = this.#tail.mtimeMs;
    for (const line of lines) {
      const j = parseEntry(line);
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

  /** Drops the file tail and its buffer, keeping the position for a later poll. False if the position is mid-line. */
  release() {
    if (!this.#tail) return true;
    if (!this.#tail.resumable) return false;
    this.#resume = this.#tail.lineStart;
    this.#tail = null;
    return true;
  }
}

export function phasesFromScript(scriptText) {
  const m = /export\s+const\s+meta\s*=\s*\{[\s\S]*?\bphases\s*:\s*\[([\s\S]*?)\]\s*[,}]/.exec(String(scriptText));
  if (!m) return [];
  return [...m[1].matchAll(/\btitle\s*:\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g)].map((t) => t[2]);
}
