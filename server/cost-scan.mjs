// Start-up count of the labour cost: reads the Claude and Codex records of today and of the same weekday last week once,
// so "today" does not start from zero when the server is switched on. The lines are read with claudeUsage / codexUsage
// (server/parse.mjs, server/codex.mjs), the same readers the live tail uses.
// Cost control: only files written within the target day are opened (a file whose last write is older holds no line of that day),
// a line is cut out as bytes and only decoded and parsed when it holds the usage marker, one file is open at a time, and the
// scan hands the thread back every `yieldEveryLines` lines. Nothing is kept from a line except its numbers and ids.
import { lstat, open, readdir, rename, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { claudeUsage } from './parse.mjs';
import { codexUsage, parseCodexMeta } from './codex.mjs';
import { isSafeId } from './sessions.mjs';
import { shiftDay } from './cost.mjs';

const NL = 0x0a;
const MARKERS = { claude: Buffer.from('"usage"'), codex: Buffer.from('"token_usage_record"') };
const SESSION_FILE = /^(.+)\.jsonl$/;
const AGENT_FILE = /^agent-(.+)\.jsonl$/;
const ROLLOUT_NAME = /^rollout-[\w.-]+\.jsonl$/;
const DIGITS = /^\d+$/;

const yieldThread = () => new Promise((resolve) => setImmediate(resolve));

async function entries(dir) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return []; // not there (yet), or not readable: nothing to count
  }
}

/** projects/<folder>/<session>.jsonl (the lead), <session>/subagents/agent-<id>.jsonl and <session>/subagents/workflows/<run>/agent-<id>.jsonl */
async function listClaude(claudeHome) {
  const out = [];
  const root = join(claudeHome, 'projects');
  const agentFiles = async (dir, sessionId) => {
    for (const e of await entries(dir)) {
      const id = e.isFile() ? AGENT_FILE.exec(e.name)?.[1] : null;
      if (id && isSafeId(id)) out.push({ path: join(dir, e.name), provider: 'claude', sessionId, agentKey: id });
    }
  };
  for (const folder of await entries(root)) {
    if (!folder.isDirectory()) continue;
    const dir = join(root, folder.name);
    for (const e of await entries(dir)) {
      if (e.isFile()) {
        const id = SESSION_FILE.exec(e.name)?.[1];
        if (id && isSafeId(id)) out.push({ path: join(dir, e.name), provider: 'claude', sessionId: id, agentKey: null });
      } else if (e.isDirectory() && isSafeId(e.name)) {
        const subs = join(dir, e.name, 'subagents');
        await agentFiles(subs, e.name);
        for (const run of await entries(join(subs, 'workflows'))) {
          if (run.isDirectory() && isSafeId(run.name)) await agentFiles(join(subs, 'workflows', run.name), e.name);
        }
      }
    }
  }
  return out;
}

/** sessions/YYYY/MM/DD/rollout-*.jsonl; whose floor each belongs to is settled later, from the first line of the file. */
async function listCodex(codexHome) {
  const out = [];
  const walk = async (dir, depth) => {
    for (const e of await entries(dir)) {
      if (depth < 3) {
        if (e.isDirectory() && DIGITS.test(e.name)) await walk(join(dir, e.name), depth + 1);
      } else if (e.isFile() && ROLLOUT_NAME.test(e.name)) {
        out.push({ path: join(dir, e.name), provider: 'codex', sessionId: '', agentKey: null });
      }
    }
  };
  await walk(join(codexHome, 'sessions'), 0);
  return out;
}

/** Which days a start-up scan should count: today and the same weekday last week, each only if no earlier run has. */
export function planTargets({ ledger, clock, nowTs, backfill }) {
  const today = clock.dayKey(nowTs);
  const target = (day, bounded) => {
    const fromMs = clock.dayStart(day);
    const toMs = clock.dayStart(shiftDay(day, 1));
    // today: any file written since the day began; last week's day: only files whose last write fell inside that day
    return { day, fromMs, toMs, mtimeMaxMs: bounded ? toMs : null };
  };
  const out = [];
  if (backfill.today && !ledger.isScanned(today)) out.push(target(today, false));
  const week = shiftDay(today, -7);
  if (backfill.lastWeek && !ledger.isScanned(week)) out.push(target(week, true));
  return out;
}

export class CostScan {
  /** True from the start of `run` until it ends. */
  scanning = false;
  /** Work done so far (lets tests, and the start-up measurement, see what a scan cost). */
  stats = { filesOpened: 0, bytesRead: 0, linesParsed: 0 };
  #ledger;
  #claudeHome;
  #codexHome;
  #cfg;
  #parse;
  #openFile;
  #yield;
  #lines = 0;
  #buf = null; // one chunk buffer for every file

  /**
   * `cfg` = {backfill: cost.backfill, tail, codex}. `parse`, `openFile` and `yieldFn` are injectable for tests.
   */
  constructor({ ledger, claudeHome, codexHome, cfg, parse = JSON.parse, openFile = open, yieldFn = yieldThread }) {
    this.#ledger = ledger;
    this.#claudeHome = claudeHome;
    this.#codexHome = codexHome;
    this.#cfg = cfg;
    this.#parse = parse;
    this.#openFile = openFile;
    this.#yield = yieldFn;
  }

  /**
   * Counts `targets` (see planTargets). Days that were not read to the end because `backfill.maxBytes` ran out are marked partial.
   * @returns {Promise<{partialDays:string[], filesOpened:number, bytesRead:number, linesParsed:number}>}
   */
  async run(targets) {
    if (targets.length === 0) return { partialDays: [], ...this.stats };
    this.scanning = true;
    this.#ledger.setScanning(true);
    try {
      this.#ledger.beginScan(targets.map((t) => t.day));
      const files = await this.#select(targets);
      const partial = new Set();
      let exhausted = false;
      for (const f of files) {
        if (!exhausted && !(await this.#readFile(f))) exhausted = true;
        if (exhausted) partial.add(f.target.day);
      }
      for (const t of targets) this.#ledger.markScanned(t.day, partial.has(t.day));
      return { partialDays: [...partial], ...this.stats };
    } finally {
      this.scanning = false;
      this.#ledger.setScanning(false);
    }
  }

  /** Files whose last write puts them in a target's window, today's first and the newest first. */
  async #select(targets) {
    const listed = [...(await listClaude(this.#claudeHome)), ...(this.#codexHome ? await listCodex(this.#codexHome) : [])];
    const chosen = [];
    for (const f of listed) {
      let st;
      try {
        st = await lstat(f.path);
      } catch {
        continue; // gone since the listing
      }
      const index = st.isFile() ? targets.findIndex((t) => st.mtimeMs >= t.fromMs && (t.mtimeMaxMs === null || st.mtimeMs < t.mtimeMaxMs)) : -1;
      if (index !== -1) chosen.push({ ...f, target: targets[index], index, mtimeMs: st.mtimeMs });
    }
    await this.#settleCodex(chosen);
    chosen.sort((a, b) => a.index - b.index || b.mtimeMs - a.mtimeMs);
    return chosen.filter((f) => f.sessionId);
  }

  /** A Codex rollout names its own id, and a sub-agent the rollout of its parent: the first line says which. */
  async #settleCodex(chosen) {
    const metas = new Map();
    for (const f of chosen) {
      if (f.provider !== 'codex') continue;
      f.meta = await this.#readMeta(f.path);
      if (f.meta) metas.set(f.meta.id, f.meta);
    }
    for (const f of chosen) {
      if (!f.meta) continue;
      if (f.meta.kind !== 'subagent') {
        f.sessionId = f.meta.id;
        continue;
      }
      let root = f.meta;
      const seen = new Set();
      while (root.kind === 'subagent' && root.parentId && metas.has(root.parentId) && !seen.has(root.id)) {
        seen.add(root.id);
        root = metas.get(root.parentId);
      }
      f.sessionId = root.kind === 'subagent' ? (root.parentId ?? '') : root.id; // a parent that is not among the files: its own id
      f.agentKey = f.meta.id;
    }
  }

  async #readMeta(path) {
    let fh;
    try {
      fh = await this.#openFile(path, 'r');
      const buf = Buffer.alloc(this.#cfg.codex.headBytes);
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      const nl = buf.subarray(0, bytesRead).indexOf(NL);
      return nl === -1 ? null : parseCodexMeta(buf.toString('utf8', 0, nl).replace(/\r$/, ''), this.#cfg.codex.cwdMaxChars);
    } catch {
      return null; // unreadable: not counted
    } finally {
      await fh?.close();
    }
  }

  /** Reads one file to its end. @returns false when `maxBytes` stopped it first. */
  async #readFile(f) {
    const { maxBytes, yieldEveryLines } = this.#cfg.backfill;
    const lineMax = this.#cfg.tail.maxLineBytes;
    let fh;
    try {
      fh = await this.#openFile(f.path, 'r');
    } catch {
      return true; // vanished or locked since the listing: skipped
    }
    this.stats.filesOpened++;
    const buf = (this.#buf ??= Buffer.allocUnsafe(lineMax)); // a chunk as long as the longest line that is read
    let pos = 0;
    let carry = []; // the start of a line that continues in the next chunk
    let carryLen = 0;
    let skipping = false; // inside a line longer than lineMax
    const line = async (bytes) => {
      this.#count(bytes, f);
      if (++this.#lines % yieldEveryLines === 0) await this.#yield();
    };
    try {
      const { size } = await fh.stat(); // what is there now; lines written after this are the live tail's
      while (pos < size) {
        if (this.stats.bytesRead >= maxBytes) return false;
        const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, size - pos), pos);
        if (bytesRead === 0) break;
        pos += bytesRead;
        this.stats.bytesRead += bytesRead;
        const view = buf.subarray(0, bytesRead);
        let start = 0;
        while (start < bytesRead) {
          const nl = view.indexOf(NL, start);
          const end = nl === -1 ? bytesRead : nl;
          if (!skipping) {
            if (carryLen + (end - start) > lineMax) {
              carry = [];
              carryLen = 0;
              skipping = true;
            } else if (nl === -1) {
              carry.push(Buffer.from(view.subarray(start, end))); // copy: the chunk buffer is reused
              carryLen += end - start;
            } else {
              await line(carry.length ? Buffer.concat([...carry, view.subarray(start, end)]) : view.subarray(start, end));
              carry = [];
              carryLen = 0;
            }
          }
          if (nl !== -1) skipping = false;
          start = end + 1;
        }
      }
      if (carryLen > 0) await line(Buffer.concat(carry));
      return true;
    } catch {
      return true; // read failed part-way: what was counted stays, the rest of this file is skipped
    } finally {
      await fh.close();
      this.#ledger.endFile({ provider: f.provider, sessionId: f.sessionId, agentKey: f.agentKey });
    }
  }

  /** One line, as bytes: parsed only when it holds the marker. */
  #count(bytes, f) {
    if (bytes.indexOf(MARKERS[f.provider]) === -1) return;
    this.stats.linesParsed++;
    let o;
    try {
      o = this.#parse(bytes.toString('utf8'));
    } catch {
      return; // a cut or damaged line
    }
    const u = f.provider === 'codex' ? codexUsage(o) : claudeUsage(o);
    if (!u || u.ts < f.target.fromMs || u.ts >= f.target.toMs) return; // the line belongs to another day
    this.#ledger.add(
      { ts: u.ts, sessionId: f.sessionId, agentKey: f.agentKey, provider: f.provider, msgId: u.msgId, tokens: u.tokens, cacheRead: u.cacheRead },
      { scan: true },
    );
  }
}

// ---- cost.json -------------------------------------------------------------------------------------------------

/** The saved ledger, or null when there is none or it cannot be read (the next save writes a fresh one). */
export function loadCostFile(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export async function saveCostFile(file, json) {
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(json), 'utf8');
  await rename(tmp, file);
}
