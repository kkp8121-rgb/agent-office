// Codex CLI support: turns rollout files into sessions, sub-agents and privacy-safe events.
// Only today's and yesterday's `sessions/YYYY/MM/DD/rollout-*.jsonl` under the codex home are ever opened;
// nothing else there (auth.json, config.toml, history, logs ...) is listed, stat-ed or read. Rollout lines are
// untrusted and full of private text, so the parsers below are whitelists: they copy only the named fields.
import { lstat, open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { FileTail } from './tail.mjs';
import { clip, firstWord, MAX_LEN } from './sanitize.mjs';
import { isSafeId } from './sessions.mjs';

/** @typedef {import('./parse.mjs').Ev} Ev */
/** @typedef {import('./sessions.mjs').Session} Session */
/** @typedef {import('./agents.mjs').AgentMeta} AgentMeta */

const ROLLOUT_NAME = /^rollout-[\w.-]+\.jsonl$/; // also excludes the old .jsonl.zst files

const isObj = (v) => typeof v === 'object' && v !== null;
const timeOf = (v) => (typeof v === 'string' ? Date.parse(v) || 0 : 0);
const folderOf = (cwd) => String(cwd ?? '').split(/[\\/]/).filter(Boolean).pop() ?? '';

// ---- meta ------------------------------------------------------------------------------------

/**
 * First line of a rollout. Returns only the fields below: the line also carries account ids and the full
 * instructions, which must never be kept.
 * @returns {null | {id:string, cwd:string, kind:'exec'|'interactive'|'subagent', parentId:string|null, agentRole:string|null, taskName:string, startedAt:number}}
 */
export function parseCodexMeta(text, cwdMax) {
  if (!Number.isInteger(cwdMax) || cwdMax <= 0) throw new TypeError('parseCodexMeta needs cwdMax (codex.cwdMaxChars)');
  let o;
  try {
    o = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObj(o) || o.type !== 'session_meta' || !isObj(o.payload)) return null;
  const p = o.payload;
  if (!isSafeId(p.id)) return null;

  const sub = isObj(p.source) && isObj(p.source.subagent) ? p.source.subagent : null;
  const spawn = sub && isObj(sub.thread_spawn) ? sub.thread_spawn : {};
  const exec = p.originator === 'codex_exec' || p.source === 'exec';
  const path = typeof spawn.agent_path === 'string' ? spawn.agent_path.split('/').filter(Boolean).pop() ?? '' : '';
  return {
    id: p.id,
    cwd: typeof p.cwd === 'string' ? clip(p.cwd, cwdMax) : '',
    kind: sub ? 'subagent' : exec ? 'exec' : 'interactive',
    parentId: isSafeId(spawn.parent_thread_id) ? spawn.parent_thread_id : null,
    agentRole: typeof spawn.agent_role === 'string' && spawn.agent_role ? clip(spawn.agent_role, MAX_LEN) : null,
    taskName: clip(path.replace(/_/g, ' '), MAX_LEN),
    startedAt: timeOf(p.timestamp) || timeOf(o.timestamp),
  };
}

// ---- lines -----------------------------------------------------------------------------------

const EXEC_CALL = /tools\s*\.\s*exec_command\s*\(/y;
const CMD_KEY = /\s*\{\s*(?:cmd|"cmd"|'cmd')\s*:\s*(?=["'`])/y;
const JS_ESCAPES = { n: '\n', t: '\t', r: '\r' };

/** The string literal starting at `src[i]` -> {value, end}, or null if unterminated, `\u`/`\x`-escaped or a template with `${`. */
function readLiteral(src, i) {
  const q = src[i];
  let value = '';
  for (let j = i + 1; j < src.length; j++) {
    const c = src[j];
    if (c === q) return { value, end: j + 1 };
    if (q === '`' && c === '$' && src[j + 1] === '{') return null;
    if (c === '\\') {
      j++;
      if (j >= src.length || src[j] === 'u' || src[j] === 'x') return null;
      value += JS_ESCAPES[src[j]] ?? src[j];
    } else {
      value += c;
    }
  }
  return null;
}

/**
 * `input` of an exec call is JS source like `const r = await tools.exec_command({cmd:"git status"})`. The source is
 * walked as code: comments and string literals are skipped, so a `cmd:` or a call written inside them is never
 * picked up. The FIRST `tools.exec_command(` call in code decides: its argument must open with a `cmd` key whose value
 * is a string literal, and that literal is returned. Anything else (a variable, an array, another first key, a
 * `/` that may start a regex literal before the call, unterminated text): ''.
 */
function cmdFromInput(input) {
  if (typeof input !== 'string') return '';
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (c === '"' || c === "'" || c === '`') {
      const lit = readLiteral(input, i);
      if (!lit) return '';
      i = lit.end - 1;
    } else if (c === '/') {
      if (input[i + 1] === '/') i = input.indexOf('\n', i) === -1 ? input.length : input.indexOf('\n', i);
      else if (input[i + 1] === '*') {
        const close = input.indexOf('*/', i + 2);
        if (close === -1) return '';
        i = close + 1;
      } else return ''; // division or regex literal: cannot tell them apart, so do not guess where code resumes
    } else if (input.startsWith('<!--', i) || input.startsWith('-->', i)) {
      return ''; // Annex B HTML-like comment: the engine may skip the rest of the line, so do not guess
    } else if (c === 't' && !/[\w$.]|[^\x00-\x7f]/.test(input[i - 1] ?? '')) {
      EXEC_CALL.lastIndex = i;
      if (!EXEC_CALL.test(input)) continue;
      CMD_KEY.lastIndex = EXEC_CALL.lastIndex;
      if (!CMD_KEY.test(input)) return '';
      return readLiteral(input, CMD_KEY.lastIndex)?.value ?? '';
    }
  }
  return '';
}

/** Label from a command string through the one shared first-word filter (sanitize.mjs, same as Claude's Bash label). */
const execLabel = (cmd) => {
  const word = firstWord(cmd);
  return word ? clip(`${word} 실행`, MAX_LEN) : '명령 실행';
};
const plainName = (v) => (typeof v === 'string' && /^[\w.-]+$/.test(v) ? clip(v, MAX_LEN) : '');
const tool = (ts, id, name, text) => ({ kind: 'tool', ts, toolUseId: id, name, text: clip(text, MAX_LEN) });
const done = (ts, id) => ({ kind: 'toolDone', ts, toolUseId: id });
const callId = (p) => (typeof p.call_id === 'string' ? p.call_id : '');

const COLLAB_WAIT = 'wait_agent';
const COLLAB = new Set(['list_agents', 'send_message', 'followup_task']);

function functionCall(p, ts) {
  const name = typeof p.name === 'string' ? p.name : '';
  const id = callId(p);
  if (name === 'spawn_agent') {
    let taskName = '';
    try {
      const a = JSON.parse(p.arguments);
      if (isObj(a) && typeof a.task_name === 'string') taskName = a.task_name;
    } catch {
      // arguments is not JSON: label without a task name
    }
    return tool(ts, id, 'Agent', taskName ? `위임 · ${taskName}` : '위임');
  }
  if (name === COLLAB_WAIT) return tool(ts, id, COLLAB_WAIT, '동료 기다리는 중');
  if (COLLAB.has(name)) return tool(ts, id, name, '동료와 협업');
  if (name.startsWith('mcp__')) {
    const server = plainName(name.split('__')[1]) || 'mcp';
    return tool(ts, id, `mcp__${server}`, `${server} 도구 사용`);
  }
  const plain = plainName(name);
  return tool(ts, id, plain || 'tool', plain ? `${plain} 사용 중` : '도구 사용 중');
}

function customToolCall(p, ts) {
  const name = typeof p.name === 'string' ? p.name : '';
  if (name === 'exec') return tool(ts, callId(p), 'Bash', execLabel(cmdFromInput(p.input)));
  const plain = plainName(name);
  return tool(ts, callId(p), plain || 'tool', plain ? `${plain} 사용 중` : '도구 사용 중');
}

function itemCompleted(p, ts) {
  const item = isObj(p.item) ? p.item : {};
  const id = String(item.call_id ?? p.call_id ?? item.id ?? '');
  switch (item.type) {
    case 'CommandExecution': {
      const first = Array.isArray(item.parsed_cmd) && isObj(item.parsed_cmd[0]) ? item.parsed_cmd[0].cmd : '';
      // `exec_result` is not a logged tool name: the start of the call already wrote the log line.
      return [tool(ts, id, 'exec_result', execLabel(first)), done(ts, id)];
    }
    case 'Extension':
      if (item.kind === 'image_gen.generation') return [tool(ts, id, 'image_gen', '그림 그리는 중'), done(ts, id)];
      if (item.kind === 'web.search') return [tool(ts, id, 'WebSearch', '웹 조사 중'), done(ts, id)];
      return [done(ts, id)];
    case 'McpToolCall': {
      const server = plainName(item.server) || 'mcp';
      return [tool(ts, id, `mcp__${server}`, `${server} 도구 사용`), done(ts, id)];
    }
    default:
      return [];
  }
}

/** One line -> {ts, turn, evs}. `turn` is 'start'/'end' for turn boundaries (the source needs them, Office does not). */
function parseEntry(text) {
  let o;
  try {
    o = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObj(o)) return null;
  const ts = timeOf(o.timestamp);
  const p = isObj(o.payload) ? o.payload : {};
  const out = { ts, turn: null, evs: [] };

  if (o.type === 'response_item') {
    switch (p.type) {
      case 'custom_tool_call':
        out.evs.push(customToolCall(p, ts));
        break;
      case 'function_call':
        out.evs.push(functionCall(p, ts));
        break;
      case 'custom_tool_call_output':
      case 'function_call_output':
        out.evs.push(done(ts, callId(p)));
        break;
      case 'reasoning':
      case 'message':
        out.evs.push({ kind: 'think', ts });
        break;
      default:
    }
  } else if (o.type === 'event_msg') {
    if (p.type === 'task_started') {
      out.turn = 'start';
      out.evs.push({ kind: 'think', ts });
    } else if (p.type === 'task_complete' || p.type === 'turn_aborted') {
      out.turn = 'end';
      out.evs.push({ kind: 'end', ts });
    } else if (p.type === 'item_completed') {
      out.evs.push(...itemCompleted(p, ts));
    }
  }
  return out;
}

/** @returns {Ev[]} */
export function parseCodexLine(text) {
  return parseEntry(text)?.evs ?? [];
}

// ---- source ----------------------------------------------------------------------------------

async function isRegularFile(path) {
  try {
    return (await lstat(path)).isFile();
  } catch {
    return false;
  }
}

const pad2 = (n) => String(n).padStart(2, '0');

/** `sessions/YYYY/MM/DD` for the local date `daysAgo` days before `now`. */
function dayDir(home, now, daysAgo) {
  const t = new Date(now);
  const d = new Date(t.getFullYear(), t.getMonth(), t.getDate() - daysAgo); // calendar days, so DST changes cannot skew it
  return join(home, 'sessions', String(d.getFullYear()), pad2(d.getMonth() + 1), pad2(d.getDate()));
}

export class CodexSource {
  /** Total rollout bytes read so far (lets tests prove that an idle poll reads nothing). */
  bytesRead = 0;

  /** Rollout size checks so far (lets tests prove that a quiet rollout is not stat-ed between scan ticks). */
  statCount = 0;

  /** Number of open FileTails (finished, unlisted rollouts hold none). */
  get tailCount() {
    let n = 0;
    for (const rec of this.#recs.values()) if (rec.tail) n++;
    return n;
  }

  #cfg;
  #tickNo = 0;
  #recs = new Map(); // path -> rollout record

  constructor(cfg) {
    this.#cfg = cfg;
  }

  /**
   * @returns {Promise<{sessions: Session[], sessionEvents: Map<string, Ev[]>, agents: Map<string, AgentMeta[]>, agentEvents: Map<string, Ev[]>}>}
   */
  async poll(now) {
    const { codex, agentScanEveryTicks } = this.#cfg;
    if (!codex?.enabled || !this.#cfg.codexHome) return this.#empty();
    // Directory listings only on scan ticks. Every other tick is one stat per listed rollout: a quiet one (not listed
    // at the last poll) is size-checked on scan ticks only.
    const scan = this.#tickNo++ % agentScanEveryTicks === 0;
    if (scan) await this.#scan(now);
    for (const rec of this.#recs.values()) {
      if (!scan && !rec.hot) continue;
      try {
        await this.#read(rec, now);
      } catch {
        // half-written or locked file: retried on a later tick
      }
    }
    return this.#assemble(now);
  }

  #empty() {
    return { sessions: [], sessionEvents: new Map(), agents: new Map(), agentEvents: new Map() };
  }

  async #scan(now) {
    const found = new Set();
    for (const daysAgo of [0, 1]) {
      const dir = dayDir(this.#cfg.codexHome, now, daysAgo);
      let names;
      try {
        names = await readdir(dir);
      } catch (e) {
        if (e?.code === 'ENOENT' || e?.code === 'ENOTDIR') continue; // no such day yet
        return; // transient error: keep the current watch list
      }
      for (const n of names) {
        const path = join(dir, n);
        // Only regular files are watched: a symlink or folder named rollout-*.jsonl is never opened.
        if (ROLLOUT_NAME.test(n) && (this.#recs.has(path) || (await isRegularFile(path)))) found.add(path);
      }
    }
    for (const path of found) {
      if (!this.#recs.has(path)) {
        this.#recs.set(path, {
          path, size: -1, meta: null, ignored: false, tail: null, resumeAt: 0,
          turn: 'none', lastTs: 0, activeFrom: null, batchFrom: null, titleSent: false, pending: [], hot: false, runs: null, busy: null,
        });
      }
    }
    for (const path of [...this.#recs.keys()]) if (!found.has(path)) this.#recs.delete(path); // tail released with it
  }

  async #read(rec, now) {
    if (rec.ignored) return;
    this.statCount++;
    const st = await lstat(rec.path);
    if (!st.isFile()) return;
    const { size } = st;
    if (size === rec.size) return;
    rec.meta ??= await this.#readMeta(rec, size);
    if (!rec.meta) return;

    rec.tail ??= new FileTail(rec.path, { ...this.#cfg.tail, offset: rec.resumeAt });
    const lines = await rec.tail.poll();
    this.bytesRead += rec.tail.lastRead;
    rec.size = size;
    // On the first batch (server start) the period began after the last silence longer than the keep time during
    // which the floor would have been unlisted, exactly where it would have begun had the server been running all
    // along. Whether the rest of the family kept it listed is only known once every rollout is read, so the runs of
    // lines (`runs`, no two further apart than the shortest keep time) and the spans in which this rollout counted
    // as unfinished (`busy`) are kept for #assemble to settle.
    const { idleKeepMs, execKeepMs } = this.#cfg.codex;
    const runGap = Math.min(idleKeepMs, execKeepMs);
    const { abandonMs } = this.#cfg.agent;
    const first = rec.lastTs === 0;
    // A window that starts mid-file cannot see where the period began: default to the session start, so the value
    // does not depend on how big the file is (a hidden floor's record must still match after a restart).
    if (first && rec.meta.startedAt > 0) rec.activeFrom = rec.meta.startedAt;
    const runs = [];
    const busy = [];
    let openFrom = null;
    let prev = 0;
    for (const text of lines) {
      const e = parseEntry(text);
      if (!e) continue;
      const ts = e.ts > 0 ? e.ts : now;
      if (first && rec.activeFrom === null) rec.activeFrom = ts;
      rec.batchFrom = Math.min(rec.batchFrom ?? ts, ts);
      if (e.turn) rec.turn = e.turn;
      if (first) {
        if (prev > 0 && ts - prev <= runGap) runs.at(-1)[1] = Math.max(runs.at(-1)[1], ts);
        else runs.push([ts, ts]);
        if (openFrom !== null && ts - prev > abandonMs) {
          busy.push([openFrom, prev + abandonMs]); // counted as abandoned in between
          openFrom = null;
        }
        if (rec.turn !== 'end') openFrom ??= ts;
        else if (openFrom !== null) {
          busy.push([openFrom, ts]);
          openFrom = null;
        }
      }
      prev = ts;
      rec.lastTs = Math.max(rec.lastTs, ts);
      rec.pending.push(...e.evs);
    }
    if (first) {
      if (openFrom !== null) busy.push([openFrom, prev + abandonMs]);
      rec.runs = runs;
      rec.busy = busy;
    }
  }

  /** First line only (up to codex.headBytes). A complete first line that is not a session_meta marks the file as ignored. */
  async #readMeta(rec, size) {
    const want = Math.min(size, this.#cfg.codex.headBytes);
    if (want <= 0) return null;
    const fh = await open(rec.path, 'r');
    try {
      const buf = Buffer.alloc(want);
      const { bytesRead } = await fh.read(buf, 0, want, 0);
      this.bytesRead += bytesRead;
      const nl = buf.subarray(0, bytesRead).indexOf(0x0a);
      if (nl === -1) {
        if (bytesRead >= this.#cfg.codex.headBytes) rec.ignored = true; // first line too long
        return null; // otherwise: still being written
      }
      const meta = parseCodexMeta(buf.toString('utf8', 0, nl).replace(/\r$/, ''), this.#cfg.codex.cwdMaxChars);
      if (!meta) rec.ignored = true;
      return meta;
    } finally {
      await fh.close();
    }
  }

  #keepMs(rec) {
    return rec.meta.kind === 'exec' ? this.#cfg.codex.execKeepMs : this.#cfg.codex.idleKeepMs;
  }

  // ---- listing -----------------------------------------------------------------------------

  #assemble(now) {
    const out = this.#empty();
    const abandonedBefore = now - this.#cfg.agent.abandonMs;
    const byId = new Map();
    for (const rec of this.#recs.values()) if (rec.meta) byId.set(rec.meta.id, rec);

    // A sub-agent belongs to the floor of its top-level ancestor; one whose chain is unknown is ignored.
    const rootOf = (rec) => {
      const seen = new Set();
      let cur = rec;
      while (cur && cur.meta.kind === 'subagent') {
        if (seen.has(cur)) return null;
        seen.add(cur);
        cur = cur.meta.parentId ? byId.get(cur.meta.parentId) : undefined;
      }
      return cur ?? null;
    };
    const kids = new Map(); // root rec -> sub-agent recs
    for (const rec of byId.values()) {
      if (rec.meta.kind !== 'subagent') continue;
      const root = rootOf(rec);
      if (root) kids.set(root, [...(kids.get(root) ?? []), rec]);
    }
    const finished = (rec) => rec.turn === 'end' || rec.lastTs < abandonedBefore;

    // First batch of a top-level rollout: the floor is listed while any rollout of its family (the top-level one and
    // its sub-agents) wrote a line within the keep time or is unfinished. A period begins where that coverage restarts
    // after a hole, the same rule the live listing below applies, so a restarted server and a running one agree.
    for (const rec of byId.values()) {
      if (rec.meta.kind === 'subagent' || !rec.runs) continue;
      const keepMs = this.#keepMs(rec);
      const covered = [rec, ...(kids.get(rec) ?? [])]
        .flatMap((m) => [...(m.runs ?? []).map(([from, to]) => [from, to + keepMs]), ...(m.busy ?? [])])
        .sort((a, b) => a[0] - b[0]);
      let reach = -Infinity;
      for (const [from, to] of covered) {
        if (reach > -Infinity && from > reach) rec.activeFrom = from;
        reach = Math.max(reach, to);
      }
    }

    const listedRecs = new Set();
    for (const rec of byId.values()) {
      if (rec.meta.kind === 'subagent') continue;
      const own = !finished(rec);
      const keepMs = this.#keepMs(rec);
      const mine = kids.get(rec) ?? [];
      const lastTs = Math.max(rec.lastTs, ...mine.map((k) => k.lastTs));
      const listed = own || now - lastTs <= keepMs || mine.some((k) => !finished(k));
      if (!listed) {
        rec.activeFrom = null; // the next activity starts a new period (and a new startedAt)
        rec.titleSent = false;
        continue;
      }
      // A period opened from silence began with the earliest line any rollout of the family wrote in this batch (the
      // coverage rule above, applied to what was just read), whichever of them wrote it.
      rec.activeFrom ??= Math.min(rec.batchFrom ?? Infinity, ...mine.map((k) => k.batchFrom ?? Infinity), now);
      listedRecs.add(rec);
      for (const k of mine) listedRecs.add(k);
      const id = rec.meta.id;
      out.sessions.push({ provider: 'codex', pid: 0, sessionId: id, cwd: rec.meta.cwd, status: own ? 'busy' : 'waiting', name: '', startedAt: rec.activeFrom });

      const evs = [];
      if (!rec.titleSent) {
        rec.titleSent = true;
        const folder = clip(folderOf(rec.meta.cwd), MAX_LEN);
        const title = rec.meta.kind === 'exec' ? (folder ? `codex exec · ${folder}` : 'codex exec') : folder;
        if (title) evs.push({ kind: 'title', ts: 0, title });
      }
      evs.push(...rec.pending);
      if (evs.length) out.sessionEvents.set(id, evs);

      if (mine.length) {
        out.agents.set(id, mine.map((k) => ({
          agentId: k.meta.id,
          agentType: `codex:${k.meta.agentRole ?? '__default'}`,
          description: k.meta.taskName,
          finished: finished(k),
          transcriptPath: k.path,
          mtimeMs: k.lastTs || now,
          workflow: null,
        })));
        for (const k of mine) if (k.pending.length) out.agentEvents.set(`${id}/${k.meta.id}`, [...k.pending]);
      }
    }
    // Events are delivered once: whatever was read for unlisted files is dropped, as a Claude tail would drop it.
    for (const rec of this.#recs.values()) {
      rec.pending = [];
      rec.batchFrom = null;
      rec.runs = rec.busy = null;
      rec.hot = listedRecs.has(rec) || (!rec.meta && !rec.ignored); // a first line still being written stays watched
      // A finished rollout that is not listed holds no FileTail (64 KB buffer); it resumes from its line offset.
      if (rec.tail?.resumable && rec.meta && !listedRecs.has(rec) && finished(rec)) {
        rec.resumeAt = rec.tail.lineStart;
        rec.tail = null;
      }
    }
    return out;
  }
}
