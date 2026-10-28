// Pure office state: floors (sessions), characters (lead + subagents), desk slots and the activity log.
// No I/O and no Date.now(): the server feeds every call with `now`. Only strings that already went
// through sanitize.mjs (Ev.text) or local JSON clipped here (descriptions, workflow labels) are kept.
import { clip } from './sanitize.mjs';

/** @typedef {import('./parse.mjs').Ev} Ev */

const BUBBLE_THINKING = '생각 중…';
const BUBBLE_STALE = '응답 없음';
const LOG_START = '시작';
const LOG_DONE = '완료 · 보고함에 제출';

const READ_TOOLS = new Set(['Read', 'Grep', 'Glob']);
const LOGGED_TOOLS = new Set(['Bash', 'Edit', 'MultiEdit', 'NotebookEdit', 'Write', 'Agent', 'Skill', 'Workflow']);
const isLogged = (name) => LOGGED_TOOLS.has(name) || name.startsWith('mcp__');

const UNSAFE_NAME_CHARS = /[\p{Cc}\p{Zl}\p{Zp}]/gu;

const isFiniteNum = (v) => typeof v === 'number' && Number.isFinite(v);

function folderOf(cwd) {
  return String(cwd ?? '').split(/[\\/]/).filter(Boolean).pop() ?? '';
}

export class Office {
  /**
   * @param {object} cfg
   * @param {{hidden?: {sessionId:string, pid:number, startedAt:number}[], names?: Record<string,string>}} [saved]
   */
  constructor(cfg, saved) {
    this.cfg = cfg;
    this.now = 0;
    /** Increments on every change to what saved() returns. */
    this.savedVersion = 0;
    this.floors = new Map(); // sessionId -> floor
    this.floorsCreated = 0; // never decremented: drives design rotation
    this.floorSeq = 0;
    this.hiddenRecs = new Map(); // sessionId -> {sessionId, pid, startedAt}
    this.names = new Map(); // sessionId -> renamed title
    this.ring = []; // LogEntry[], oldest first
    this.pending = new Set(); // entries created/updated since the last drainLog()
    this.unhiddenAt = new Map(); // sessionId -> when its hide record was dropped (memory only, pruned after backfillMinutes)
    this.evicted = new WeakSet(); // entries that left the ring (a merge must not revive them)
    this.logSeq = 0;

    for (const h of Array.isArray(saved?.hidden) ? saved.hidden : []) {
      if (h && typeof h.sessionId === 'string' && isFiniteNum(h.pid) && isFiniteNum(h.startedAt)) {
        this.hiddenRecs.set(h.sessionId, { sessionId: h.sessionId, pid: h.pid, startedAt: h.startedAt });
      }
    }
    for (const [id, n] of Object.entries(saved?.names ?? {})) {
      const clean = typeof n === 'string' ? this.#cleanName(n) : '';
      if (clean) this.names.set(id, clean);
    }
  }

  // ---- persistence -------------------------------------------------------------------------

  saved() {
    return {
      hidden: [...this.hiddenRecs.values()].map((r) => ({ ...r })),
      names: Object.fromEntries(this.names),
    };
  }

  #bump() {
    this.savedVersion++;
  }

  #cleanName(raw) {
    const max = this.cfg.floor.nameMaxChars;
    return Array.from(String(raw).replace(UNSAFE_NAME_CHARS, '').trim()).slice(0, max).join('').trim();
  }

  rename(sessionId, name) {
    const clean = name == null ? '' : this.#cleanName(name);
    if (!clean) {
      if (this.names.delete(sessionId)) this.#bump();
    } else if (this.names.get(sessionId) !== clean) {
      this.names.set(sessionId, clean);
      this.#bump();
    }
  }

  hide(sessionId) {
    const f = this.floors.get(sessionId);
    if (!f || f.leavingAt !== null) return false;
    const prev = this.hiddenRecs.get(sessionId);
    if (!prev || prev.pid !== f.pid || prev.startedAt !== f.startedAt) {
      this.hiddenRecs.set(sessionId, { sessionId, pid: f.pid, startedAt: f.startedAt });
      this.#bump();
    }
    f.hidden = true;
    this.#purgeLog(sessionId);
    return true;
  }

  /** Log cutoff for a session's events: backfill window, but never earlier than the moment it was unhidden. */
  logSince(sessionId, now) {
    const floor = now - this.cfg.log.backfillMinutes * 60000;
    const at = this.unhiddenAt.get(sessionId);
    return at === undefined ? floor : Math.max(floor, at);
  }

  // ---- sessions (floors) -------------------------------------------------------------------

  syncSessions(live, now) {
    this.now = now;
    const liveIds = new Set(live.map((s) => s.sessionId));

    const backfillMs = this.cfg.log.backfillMinutes * 60000;
    for (const [id, at] of this.unhiddenAt) if (at < now - backfillMs) this.unhiddenAt.delete(id);

    for (const id of [...this.hiddenRecs.keys()]) {
      if (!liveIds.has(id)) {
        this.hiddenRecs.delete(id);
        this.unhiddenAt.set(id, now);
        this.#bump();
      }
    }

    for (const s of live) {
      let f = this.floors.get(s.sessionId);
      if (!f) {
        f = this.#createFloor(s);
        this.floors.set(s.sessionId, f);
      }
      f.leavingAt = null;
      f.pid = s.pid;
      f.startedAt = s.startedAt;
      f.provider = s.provider ?? 'claude';
      f.cwd = s.cwd;
      f.folder = folderOf(s.cwd);
      f.status = s.status === 'busy' ? 'busy' : 'waiting';

      const rec = this.hiddenRecs.get(s.sessionId);
      if (rec && (rec.pid !== s.pid || rec.startedAt !== s.startedAt)) {
        this.hiddenRecs.delete(s.sessionId); // re-run: visible again
        this.unhiddenAt.set(s.sessionId, now);
        this.#bump();
        f.hidden = false;
      } else {
        f.hidden = rec !== undefined;
      }
    }

    for (const f of this.floors.values()) {
      if (!liveIds.has(f.sessionId) && f.leavingAt === null) {
        f.leavingAt = now;
        f.status = 'leaving';
      }
    }
  }

  #createFloor(s) {
    const { designOrder, roles } = this.cfg;
    const design = designOrder[this.floorsCreated++ % designOrder.length];
    const lead = (s.provider === 'codex' && roles['codex:__lead']) || roles.__lead;
    return {
      sessionId: s.sessionId,
      provider: 'claude',
      pid: s.pid,
      startedAt: s.startedAt,
      cwd: '',
      folder: '',
      status: 'waiting',
      leavingAt: null,
      hidden: false,
      seq: this.floorSeq++,
      design,
      aiTitle: '',
      lead: { name: lead.name, role: lead.role, sprite: lead.key, head: '', state: 'idle', bubble: '', lastRead: null },
      boardLine: '',
      workflows: new Map(), // runId -> {name, scriptPath}
      agents: new Map(), // agentId -> agent
      usedNames: new Set([lead.name]),
      usedSlots: new Set(),
      reports: 0,
    };
  }

  /** Name/slot bookkeeping for an agent that is leaving the floor. */
  #releaseAgent(f, a) {
    f.agents.delete(a.agentId);
    f.usedNames.delete(a.name);
    f.usedSlots.delete(a.slot.i);
  }

  // ---- events ------------------------------------------------------------------------------

  // `opts.logSince`: events stamped before it still drive state but add no log entries (backfill).
  applySessionEvents(sessionId, evs, now, opts = {}) {
    this.now = now;
    const f = this.floors.get(sessionId);
    if (!f) return;
    for (const ev of evs) {
      if (ev.kind === 'title') {
        if (ev.title) f.aiTitle = ev.title;
      } else if (ev.kind === 'workflowLaunch') {
        if (ev.runId) f.workflows.set(ev.runId, { name: ev.workflowName, scriptPath: ev.scriptPath });
      } else {
        this.#actorEvent(f, f.lead, ev, now, true, opts.logSince);
      }
    }
  }

  applyAgentEvents(sessionId, agentId, evs, now, opts = {}) {
    this.now = now;
    const f = this.floors.get(sessionId);
    const a = f?.agents.get(agentId);
    if (!a) return;
    for (const ev of evs) this.#actorEvent(f, a, ev, now, false, opts.logSince);
  }

  #setState(actor, state, bubble, now) {
    if (actor.state === state && actor.bubble === bubble) return;
    actor.state = state;
    actor.bubble = bubble;
    actor.since = now;
  }

  #actorEvent(f, actor, ev, now, isLead, logSince = 0) {
    if (!isLead && actor.state === 'done') return;
    const t = ev.ts > 0 ? ev.ts : now;
    if (!isLead) actor.lastAt = Math.max(actor.lastAt, t);
    const quiet = ev.ts > 0 && ev.ts < logSince;

    switch (ev.kind) {
      case 'tool':
        this.#setState(actor, 'working', ev.text, now);
        if (quiet) break;
        if (READ_TOOLS.has(ev.name)) this.#logRead(f, actor, t);
        else if (isLogged(ev.name)) this.#log(f, actor, t, ev.text);
        break;
      case 'toolDone':
      case 'think':
        this.#setState(actor, 'thinking', BUBBLE_THINKING, now);
        break;
      case 'end':
        if (isLead) this.#setState(actor, 'idle', '', now);
        else if (!quiet) this.#logDone(f, actor, t);
        break;
      default:
    }
  }

  // ---- agents ------------------------------------------------------------------------------

  syncAgents(sessionId, metas, now) {
    this.now = now;
    const f = this.floors.get(sessionId);
    if (!f) return;
    for (const m of metas) {
      const a = f.agents.get(m.agentId);
      if (!a) {
        if (!m.finished) this.#enterAgent(f, m, now);
      } else if (m.finished && a.state !== 'done') {
        a.state = 'done';
        a.bubble = '';
        a.since = now;
        a.doneAt = now;
        f.reports++;
        this.#logDone(f, a, now);
      }
    }
  }

  #enterAgent(f, m, now) {
    const { roles, log } = this.cfg;
    const entry = this.#roleFor(f, m.agentType);
    const wf = m.workflow;
    const head = clip(wf ? `${wf.phase} · ${wf.label}` : m.description ?? '', log.headMaxChars);
    const slot = this.#allocSlot(f);
    const a = {
      agentId: m.agentId,
      key: `${f.sessionId}:${m.agentId}`,
      name: this.#allocName(f, entry.name),
      role: entry.role,
      sprite: entry.key,
      head,
      slot,
      state: 'enter',
      bubble: '',
      since: now,
      lastAt: m.mtimeMs > 0 ? m.mtimeMs : now,
      doneAt: 0,
      endLogged: false,
      lastRead: null,
    };
    f.agents.set(m.agentId, a);
    this.#log(f, a, now, LOG_START);
  }

  /** Claude floors know Claude role names, Codex floors the `codex:` ones; anything else gets the provider's default. */
  #roleFor(f, agentType) {
    const { roles } = this.cfg;
    const codex = f.provider === 'codex';
    const prefix = codex ? 'codex:' : '';
    const known =
      typeof agentType === 'string' &&
      agentType.startsWith(prefix) &&
      !agentType.slice(prefix.length).startsWith('__') &&
      (codex || !agentType.startsWith('codex:')) &&
      Object.hasOwn(roles, agentType);
    if (known) return roles[agentType];
    return (codex && roles['codex:__default']) || roles.__default;
  }

  #allocName(f, base) {
    for (let n = 0; ; n++) {
      const candidate = n === 0 ? base : `${base}+${n}`;
      if (!f.usedNames.has(candidate)) {
        f.usedNames.add(candidate);
        return candidate;
      }
    }
  }

  /** Smallest free index over [...desks, ...aisle]; beyond that, stacked on the last aisle spot. */
  #allocSlot(f) {
    const { desks, aisle } = this.cfg.layouts[f.design];
    let i = 0;
    while (f.usedSlots.has(i)) i++;
    f.usedSlots.add(i);
    const p = i < desks.length ? desks[i] : (aisle[Math.min(i - desks.length, aisle.length - 1)] ?? desks.at(-1));
    return { x: p[0], y: p[1], i };
  }

  // One board line per floor: the most recently reported run wins, so runId is not needed here.
  setWorkflowProgress(sessionId, _runId, p) {
    const f = this.floors.get(sessionId);
    if (!f) return;
    const max = this.cfg.log.headMaxChars;
    const name = clip(p.name, max);
    const current = clip(p.current, max);
    const phases = Array.isArray(p.phases) ? p.phases : [];
    const idx = phases.indexOf(p.current);
    f.boardLine = phases.length && idx >= 0 ? `${name} · ${current} ${idx + 1}/${phases.length}` : `${name} · ${current}`;
  }

  workflowRuns(sessionId) {
    const f = this.floors.get(sessionId);
    return f ? [...f.workflows].map(([runId, w]) => ({ runId, ...w })) : [];
  }

  // ---- time --------------------------------------------------------------------------------

  tick(now) {
    this.now = now;
    const { agent, floor } = this.cfg;
    let changed = false;
    for (const f of [...this.floors.values()]) {
      if (f.leavingAt !== null && now - f.leavingAt >= floor.leaveMs) {
        this.floors.delete(f.sessionId);
        changed = true;
        continue;
      }
      for (const a of [...f.agents.values()]) {
        if (a.state === 'done') {
          if (now - a.doneAt >= agent.doneLingerMs) {
            this.#releaseAgent(f, a);
            changed = true;
          }
        } else if (a.state !== 'stale' && now - a.lastAt >= agent.staleMs) {
          this.#setState(a, 'stale', BUBBLE_STALE, now);
          changed = true;
        }
      }
    }
    return changed;
  }

  // ---- views -------------------------------------------------------------------------------

  snapshot() {
    const visible = [...this.floors.values()].filter((f) => !f.hidden);
    visible.sort((a, b) => a.startedAt - b.startedAt || a.seq - b.seq);
    const views = visible.map((f, i) => {
      const autoTitle = f.aiTitle || f.folder;
      const title = this.names.get(f.sessionId) ?? autoTitle;
      return {
        sessionId: f.sessionId,
        provider: f.provider,
        floorNo: i + 1,
        design: f.design,
        title,
        autoTitle,
        folder: f.folder,
        status: f.status,
        lead: { name: f.lead.name, role: f.lead.role, sprite: f.lead.sprite, state: f.lead.state, bubble: f.lead.bubble },
        board: { title, line: f.boardLine },
        reports: f.reports,
        agents: [...f.agents.values()].map((a) => ({
          key: a.key,
          agentId: a.agentId,
          name: a.name,
          role: a.role,
          sprite: a.sprite,
          slot: { ...a.slot },
          state: a.state,
          bubble: a.bubble,
          since: a.since,
        })),
      };
    });
    return { floors: views.reverse(), now: this.now };
  }

  // ---- activity log ------------------------------------------------------------------------

  #evict(e) {
    this.evicted.add(e);
    this.pending.delete(e);
  }

  #isHidden(sessionId) {
    return this.floors.get(sessionId)?.hidden === true;
  }

  /** Hidden floors record nothing, so nothing from the hidden period can resurface later. */
  #log(f, actor, ts, text) {
    if (f.hidden) return null;
    actor.lastRead = null;
    return this.#append(f, actor, ts, text);
  }

  #append(f, actor, ts, text) {
    const e = {
      id: `l${++this.logSeq}`,
      ts,
      sessionId: f.sessionId,
      name: actor.name,
      role: actor.role,
      sprite: actor.sprite,
      head: actor.head,
      text,
    };
    this.ring.push(e);
    this.pending.add(e);
    const over = this.ring.length - this.cfg.log.cap;
    if (over > 0) {
      for (const old of this.ring.splice(0, over)) this.#evict(old);
    }
    return e;
  }

  #logRead(f, actor, ts) {
    if (f.hidden) return;
    const r = actor.lastRead;
    if (r && !this.evicted.has(r.entry) && ts - r.ts <= this.cfg.log.mergeWindowMs) {
      r.count++;
      r.ts = ts;
      r.entry.ts = ts;
      r.entry.text = `파일 ${r.count}개 살펴봄`;
      this.pending.add(r.entry);
      return;
    }
    const entry = this.#append(f, actor, ts, '파일 1개 살펴봄');
    actor.lastRead = { entry, count: 1, ts };
  }

  #logDone(f, actor, ts) {
    if (actor.endLogged) return;
    actor.endLogged = true;
    this.#log(f, actor, ts, LOG_DONE);
  }

  #purgeLog(sessionId) {
    this.ring = this.ring.filter((e) => {
      if (e.sessionId !== sessionId) return true;
      this.#evict(e);
      return false;
    });
    const f = this.floors.get(sessionId);
    if (f) {
      f.lead.lastRead = null;
      for (const a of f.agents.values()) a.lastRead = null;
    }
  }

  drainLog() {
    const out = [...this.pending].filter((e) => !this.#isHidden(e.sessionId)).map((e) => ({ ...e }));
    this.pending.clear();
    return out;
  }

  queryLog(f = {}) {
    const limit = f.limit ?? this.cfg.log.sendCap;
    const out = [];
    for (let i = this.ring.length - 1; i >= 0 && out.length < limit; i--) {
      const e = this.ring[i];
      if (this.#isHidden(e.sessionId)) continue;
      if (f.sessionId !== undefined && e.sessionId !== f.sessionId) continue;
      if (f.name !== undefined && e.name !== f.name) continue;
      out.push({ ...e });
    }
    return out;
  }
}
