// One poll round: live sessions (Claude + Codex) -> transcript tails -> subagent scan -> workflow journals -> Office.
// Idle rounds cost a directory listing, a few small reads and one stat per open transcript.
import { open, stat } from 'node:fs/promises';
import { isAbsolute, join, sep } from 'node:path';
import { FileTail } from './tail.mjs';
import { parseLine } from './parse.mjs';
import { listLiveSessions, findSessionPaths } from './sessions.mjs';
import { listAgents, markSettled } from './agents.mjs';
import { WorkflowJournal, phasesFromScript } from './workflows.mjs';
import { CodexSource } from './codex.mjs';

const SAFE_RUN_ID = /^[\w-]+$/; // runId becomes a folder name

/** scriptPath comes from the transcript: only absolute local .js/.mjs paths are opened (a UNC path would open an SMB connection). */
export function isLocalScriptPath(p) {
  return typeof p === 'string' && isAbsolute(p) && !/^[\\/]{2}/.test(p) && /\.m?js$/i.test(p);
}

async function readScriptPhases(scriptPath, headBytes) {
  if (!isLocalScriptPath(scriptPath)) return [];
  let fh;
  try {
    if (!(await stat(scriptPath)).isFile()) return [];
    fh = await open(scriptPath, 'r');
    const buf = Buffer.alloc(headBytes);
    const { bytesRead } = await fh.read(buf, 0, headBytes, 0);
    return phasesFromScript(buf.toString('utf8', 0, bytesRead));
  } catch {
    return []; // missing or unreadable script: progress is shown without a step count
  } finally {
    await fh?.close();
  }
}

export class Poller {
  /** Total transcript bytes read so far (lets tests prove that an idle tick reads nothing). */
  bytesRead = 0;
  #cfg;
  #office;
  #codex;
  #tickNo = 0;
  #lastSeen = new Map(); // sessionId -> {session, missed}: absence is debounced per session
  #metaCache = new Map();
  #states = new Map(); // sessionId -> per-session tail state

  constructor(cfg, office) {
    this.#cfg = cfg;
    this.#office = office;
    this.#codex = cfg.codex?.enabled ? new CodexSource(cfg) : null;
  }

  async tick(now) {
    const scan = this.#tickNo++ % this.#cfg.agentScanEveryTicks === 0;
    // Provider seam: every source adds its sessions to `listed`, so Office sees one merged session list
    // (and the absence debounce covers both). Codex has already read its rollouts when the list is built;
    // its events are applied after the sync, once the floors exist.
    const codex = await this.#pollCodex(now);
    const listed = [...(await this.#listClaudeSessions()), ...(codex?.sessions ?? [])];
    const live = this.#syncSessions(listed, now);
    await this.#pollClaudeSessions(live, now, scan);
    if (codex) this.#applyCodex(codex, now);
  }

  // ---- session list ------------------------------------------------------------------------

  #listClaudeSessions() {
    return listLiveSessions(this.#cfg.claudeHome);
  }

  /**
   * A session missing from the list (half-written or unreadable file) stays in it until it has been missing for
   * floor.missTicks ticks in a row, so one failed read cannot drop a hide record. Returns the list Office sees.
   */
  #syncSessions(listed, now) {
    const seen = new Set();
    for (const s of listed) {
      seen.add(s.sessionId);
      this.#lastSeen.set(s.sessionId, { session: s, missed: 0 });
    }
    const live = [];
    for (const [id, rec] of [...this.#lastSeen]) {
      if (!seen.has(id) && ++rec.missed >= this.#cfg.floor.missTicks) {
        this.#lastSeen.delete(id);
        this.#dropState(id);
      } else {
        live.push(rec.session);
      }
    }
    this.#office.syncSessions(live, now);
    return live;
  }

  #dropState(id) {
    const st = this.#states.get(id);
    this.#states.delete(id);
    if (!st?.paths) return;
    const prefix = st.paths.sessionDir + sep;
    for (const key of [...this.#metaCache.keys()]) if (key.startsWith(prefix)) this.#metaCache.delete(key);
  }

  // ---- Codex rollouts ------------------------------------------------------------------------

  async #pollCodex(now) {
    if (!this.#codex) return null;
    try {
      return await this.#codex.poll(now);
    } catch (e) {
      console.error('Codex 확인 실패:', e?.message ?? e);
      return null; // its sessions are debounced like any other missing session
    }
  }

  #applyCodex({ sessionEvents, agents, agentEvents }, now) {
    const opts = (id) => ({ logSince: this.#office.logSince(id, now) });
    for (const [id, evs] of sessionEvents) this.#office.applySessionEvents(id, evs, now, opts(id));
    for (const [id, metas] of agents) this.#office.syncAgents(id, metas, now);
    for (const [key, evs] of agentEvents) {
      const cut = key.indexOf('/');
      const id = key.slice(0, cut);
      this.#office.applyAgentEvents(id, key.slice(cut + 1), evs, now, opts(id));
    }
  }

  // ---- Claude transcripts ------------------------------------------------------------------

  #stateFor(s) {
    // A re-run (new pid or start time) keeps its tail and offsets: nothing already read is read again.
    let st = this.#states.get(s.sessionId);
    if (!st) {
      st = { paths: null, tail: null, agents: new Map(), runs: new Map() };
      this.#states.set(s.sessionId, st);
    }
    return st;
  }

  async #pollClaudeSessions(live, now, scan) {
    for (const s of live) {
      if (s.provider !== 'claude') continue;
      try {
        await this.#pollSession(s.sessionId, this.#stateFor(s), now, scan, s.cwd);
      } catch (e) {
        console.error(`세션 ${s.sessionId} 확인 실패:`, e?.message ?? e);
      }
    }
  }

  async #pollSession(id, st, now, scan, cwd) {
    // A session without a transcript yet is searched on agent-scan ticks only; the full scan of projects/ is retried
    // at most every floor.transcriptRetryMs (the folder named after its cwd is tried every time).
    if (!st.paths && scan) {
      st.paths = await findSessionPaths(this.#cfg.claudeHome, id, { cwd, now, retryMs: this.#cfg.floor.transcriptRetryMs });
    }
    if (!st.paths) return;
    const opts = { logSince: this.#office.logSince(id, now) };

    st.tail ??= new FileTail(st.paths.transcript, this.#cfg.tail);
    const evs = (await this.#pollTail(st.tail)).flatMap(parseLine);
    if (evs.length) this.#office.applySessionEvents(id, evs, now, opts);

    this.#trackLaunchedRuns(id, st);
    if (scan) await this.#scanAgents(id, st, now);
    for (const [agentId, tail] of st.agents) {
      const aEvs = (await this.#pollTail(tail)).flatMap(parseLine);
      if (aEvs.length) this.#office.applyAgentEvents(id, agentId, aEvs, now, opts);
    }
    if (!scan) { // a scan tick already polled them
      await this.#pollRuns(st);
      await this.#reportRuns(id, st, now);
    }
  }

  /** ENOENT (file not written yet, or removed) and transient read errors just retry on a later tick. */
  async #pollTail(tail) {
    try {
      const lines = await tail.poll();
      this.bytesRead += tail.lastRead;
      return lines;
    } catch {
      return [];
    }
  }

  // ---- subagents ---------------------------------------------------------------------------

  async #scanAgents(id, st, now) {
    const metas = await listAgents(st.paths.sessionDir, this.#metaCache, undefined, this.#cfg.agent.dirTrustMs, this.#cfg.workflow.doneQuietMs);
    const abandonedBefore = now - this.#cfg.agent.abandonMs;
    const byRun = new Map(); // runId -> metas of that run
    for (const m of metas) {
      if (!m.workflow) continue;
      this.#run(st, m.workflow.runId, false);
      if (!byRun.has(m.workflow.runId)) byRun.set(m.workflow.runId, []);
      byRun.get(m.workflow.runId).push(m);
    }
    for (const run of st.runs.values()) {
      const ms = byRun.get(run.runId) ?? [];
      // A finished run comes back to life when a new agent (not in the journal yet, not long silent) shows up.
      const fresh = (m) => !m.finished && !run.journal.started.has(m.agentId) && m.mtimeMs >= abandonedBefore;
      if (run.done && ms.some(fresh)) run.done = false;
      run.metaIds = new Set();
      run.settled = new Set();
      run.metaMtimeMs = 0;
    }
    await this.#pollRuns(st, byRun);

    const synced = [];
    const running = new Set();
    for (const m of metas) {
      const run = m.workflow ? st.runs.get(m.workflow.runId) : null;
      const finished = m.finished || run?.journal.finished.has(m.agentId) === true;
      let abandoned = false;
      if (finished) {
        markSettled(this.#metaCache, m); // its meta is not stat-ed again
      } else {
        const last = Math.max(m.mtimeMs, await this.#mtime(m.transcriptPath));
        abandoned = last < abandonedBefore; // crashed subagent or stopped workflow
      }
      if (run) {
        run.metaIds.add(m.agentId);
        if (finished || abandoned) run.settled.add(m.agentId);
        run.metaMtimeMs = Math.max(run.metaMtimeMs, m.mtimeMs);
      }
      synced.push(abandoned ? { ...m, finished: false, abandoned: true } : { ...m, finished });
      if (!finished && !abandoned) running.add(m.agentId);
    }
    await this.#reportRuns(id, st, now);
    this.#office.syncAgents(id, synced, now);

    for (const agentId of [...st.agents.keys()]) if (!running.has(agentId)) st.agents.delete(agentId);
    for (const m of metas) {
      if (running.has(m.agentId) && !st.agents.has(m.agentId)) st.agents.set(m.agentId, new FileTail(m.transcriptPath, this.#cfg.tail));
    }
    for (const run of st.runs.values()) run.active = (byRun.get(run.runId) ?? []).some((m) => this.#needsJournal(run, m));
  }

  #needsJournal(run, m) {
    return !m.finished && !run.journal.finished.has(m.agentId);
  }

  async #mtime(path) {
    try {
      return (await stat(path)).mtimeMs;
    } catch {
      return 0;
    }
  }

  // ---- workflow runs -----------------------------------------------------------------------

  #run(st, runId, active) {
    if (!SAFE_RUN_ID.test(runId)) return null;
    let run = st.runs.get(runId);
    if (!run) {
      const dir = join(st.paths.sessionDir, 'subagents', 'workflows', runId);
      const tailOpts = { ...this.#cfg.tail, maxLineBytes: this.#cfg.workflow.journalLineBytes };
      run = {
        runId, journal: new WorkflowJournal(dir, tailOpts), active, name: '', scriptPath: '', phases: null, sig: '',
        done: false, metaIds: new Set(), settled: new Set(), metaMtimeMs: 0,
      };
      st.runs.set(runId, run);
    }
    return run;
  }

  /** Runs announced by the session's own Workflow tool results (their name and script path). */
  #trackLaunchedRuns(id, st) {
    for (const r of this.#office.workflowRuns(id)) {
      const run = this.#run(st, r.runId, true);
      if (run) {
        run.name = r.name;
        run.scriptPath = r.scriptPath;
      }
    }
  }

  /** `byRun` (scan ticks) also polls runs that are only known from subagent folders. A finished run's journal is not polled. */
  async #pollRuns(st, byRun) {
    for (const run of st.runs.values()) {
      if (run.done) continue;
      const wanted = run.active || (byRun?.get(run.runId) ?? []).some((m) => this.#needsJournal(run, m));
      if (wanted) await run.journal.poll().catch(() => {});
    }
  }

  /**
   * A run is done when its journal has started agents, every started agent and every agent folder of the run has ended
   * (result, finished meta, or abandoned) and nothing in the run changed for workflow.doneQuietMs: the next phase starts
   * its agents within seconds (real runs: p90 1.8 s, 2 % of gaps over 30 s), so a run quiet for minutes is over. A done run drops its journal tail.
   */
  #isDone(run, now) {
    const { started, finished } = run.journal;
    if (started.size === 0) return false;
    const ended = (agentId) => finished.has(agentId) || run.settled.has(agentId);
    for (const agentId of started.keys()) if (!ended(agentId)) return false;
    for (const agentId of run.metaIds) if (!ended(agentId)) return false;
    return now - Math.max(run.journal.mtimeMs, run.metaMtimeMs) >= this.#cfg.workflow.doneQuietMs;
  }

  async #reportRuns(id, st, now) {
    for (const run of st.runs.values()) {
      if (!run.done && this.#isDone(run, now) && run.journal.release()) run.done = true;
      if (!run.name && !run.scriptPath) continue; // not announced in the transcript: nothing to put on the board
      const { started, finished } = run.journal;
      const sig = `${started.size}|${finished.size}|${run.name}|${run.done}`;
      if (sig === run.sig) continue;
      run.sig = sig;
      run.phases ??= run.scriptPath ? await readScriptPhases(run.scriptPath, this.#cfg.workflow.scriptHeadBytes) : [];
      const current = [...started.values()].at(-1)?.phase ?? '';
      this.#office.setWorkflowProgress(id, run.runId, { name: run.name, phases: run.phases, current, done: run.done });
    }
  }
}
