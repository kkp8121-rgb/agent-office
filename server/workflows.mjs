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

// ---- meta.phases of a run script: the literal is scanned by hand, the script is never evaluated ----

const QUOTES = '\'"`';
const PHASES_MAX = 60;

/** Index of the next token: whitespace and comments skipped. */
function skipTrivia(s, i) {
  while (i < s.length) {
    if (/\s/.test(s[i])) i++;
    else if (s.startsWith('//', i)) i = s.indexOf('\n', i) < 0 ? s.length : s.indexOf('\n', i);
    else if (s.startsWith('/*', i)) i = s.indexOf('*/', i + 2) < 0 ? s.length : s.indexOf('*/', i + 2) + 2;
    else break;
  }
  return i;
}

/** The string literal starting at s[i] (a quote): {value, end} with end after the closing quote; value is null for a template with ${}. */
function readString(s, i) {
  const q = s[i];
  let value = '';
  let j = i + 1;
  while (j < s.length && s[j] !== q) {
    if (s[j] === '\\') {
      const c = s[j + 1] ?? '';
      value += c === 'n' || c === 't' ? ' ' : c;
      j += 2;
    } else value += s[j++];
  }
  return { value: q === '`' && value.includes('${') ? null : value, end: Math.min(j + 1, s.length) };
}

/** A property key (name or quoted string) at s[i]: {name, end} or null. */
function readKey(s, i) {
  if (QUOTES.includes(s[i])) {
    const r = readString(s, i);
    return { name: r.value ?? '', end: r.end };
  }
  const m = /[A-Za-z_$][\w$]*/y;
  m.lastIndex = i;
  const r = m.exec(s);
  return r ? { name: r[0], end: m.lastIndex } : null;
}

/** Index of the comma or closing bracket that ends the value starting at s[i] (not consumed). */
function skipValue(s, i) {
  let depth = 0;
  while (i < s.length) {
    const c = s[i];
    if (QUOTES.includes(c)) i = readString(s, i).end;
    else if (s.startsWith('//', i) || s.startsWith('/*', i)) i = skipTrivia(s, i);
    else if ('([{'.includes(c)) {
      depth++;
      i++;
    } else if (')]}'.includes(c)) {
      if (depth === 0) return i;
      depth--;
      i++;
    } else if (c === ',' && depth === 0) return i;
    else i++;
  }
  return s.length;
}

/** Walks the properties of the object at s[i] ('{'): onValue(key, valueStart) returns where it stopped reading (0: it did not read); returns the index after '}'. */
function eachProp(s, i, onValue) {
  i++;
  for (;;) {
    i = skipTrivia(s, i);
    if (i >= s.length) return s.length;
    if (s[i] === '}') return i + 1;
    if (s[i] === ',') {
      i++;
      continue;
    }
    const key = readKey(s, i);
    if (!key) {
      i = skipValue(s, i + 1);
      continue;
    }
    i = skipTrivia(s, key.end);
    if (s[i] !== ':') {
      i = Math.max(i + 1, skipValue(s, i));
      continue;
    }
    i = skipTrivia(s, i + 1);
    const end = onValue(key.name, i);
    i = end > i ? end : skipValue(s, i);
  }
}

/** Titles from the phases array at s[i] ('['): strings, or objects with a string `title`. */
function readPhaseTitles(s, i, out) {
  i++;
  for (;;) {
    i = skipTrivia(s, i);
    if (i >= s.length || s[i] === ']' || out.length >= PHASES_MAX) return;
    if (s[i] === ',') {
      i++;
    } else if (QUOTES.includes(s[i])) {
      const r = readString(s, i);
      if (r.value) out.push(r.value);
      i = r.end;
    } else if (s[i] === '{') {
      let title = null;
      i = eachProp(s, i, (key, at) => {
        if (key !== 'title' || !QUOTES.includes(s[at])) return 0;
        const r = readString(s, at);
        title = r.value;
        return r.end;
      });
      if (title) out.push(title);
    } else {
      i = Math.max(i + 1, skipValue(s, i));
    }
  }
}

/** The `title`s of `export const meta = { phases: [...] }` in a run script, in order ([] if there are none). */
export function phasesFromScript(scriptText) {
  const s = String(scriptText);
  const m = /export\s+const\s+meta\s*=\s*\{/.exec(s);
  const out = [];
  if (!m) return out;
  eachProp(s, m.index + m[0].length - 1, (key, at) => {
    if (key !== 'phases' || s[at] !== '[') return 0;
    readPhaseTitles(s, at, out);
    return skipValue(s, at);
  });
  return out;
}
