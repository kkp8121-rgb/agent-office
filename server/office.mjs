// Pure office state: floors (sessions), characters (lead + subagents), desk slots and the activity log.
// No I/O and no Date.now(): the server feeds every call with `now`. Only strings that already went
// through sanitize.mjs (Ev.text) or local JSON clipped here (descriptions, workflow labels) are kept.
import { clip } from './sanitize.mjs';
import { overflowPoint, resolveScene } from '../web/scene.mjs';
import { bakeGrid, isOpen } from '../web/nav.mjs';

/** @typedef {import('./parse.mjs').Ev} Ev */

const BUBBLE_THINKING = '생각 중…';
const BUBBLE_STALE = '응답 없음';
const LOG_START = '시작';
const LOG_DONE = '완료 · 보고함에 제출';
const LOG_ABANDONED = '응답 없이 종료';

const READ_TOOLS = new Set(['Read', 'Grep', 'Glob']);
const LOGGED_TOOLS = new Set(['Bash', 'Edit', 'MultiEdit', 'NotebookEdit', 'Write', 'Agent', 'Skill', 'Workflow']);
const isLogged = (name) => LOGGED_TOOLS.has(name) || name.startsWith('mcp__');

// Control characters plus Unicode format characters (bidi overrides, zero-width): none may reach the screen.
const UNSAFE_NAME_CHARS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

const TODO_VIEW_MAX = 12; // to-do items on the whiteboard; the in-progress one is always among them
const SIGNAL_CAP = 100; // live events (phase, fail) waiting for the next broadcast; the oldest are dropped past this
const LEAD_KEY = 'lead'; // agent key of the main session in fail events

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
    this.resolved = new Map(); // design -> resolved scene
    this.grids = new Map(); // design -> baked walking grid (overflow spots are picked on open floor)
    this.floorsCreated = 0; // never decremented: breaks ties between equally used designs
    this.floorSeq = 0;
    this.pool = this.#buildPool();
    this.hiddenRecs = new Map(); // sessionId -> {sessionId, pid, startedAt}
    this.names = new Map(); // sessionId -> renamed title
    this.ring = []; // LogEntry[], oldest first
    this.pending = new Set(); // entries created/updated since the last drainLog()
    this.unhiddenAt = new Map(); // sessionId -> when its hide record was dropped (memory only, pruned after backfillMinutes)
    this.hiddenMiss = new Map(); // sessionId -> consecutive syncSessions calls its hide record's session was absent
    this.logMark = new Map(); // sessionId -> first ts not yet logged when its floor left (a resume must not log the window again)
    this.departedTitles = new Map(); // sessionId -> last title of a floor that left, for the log page
    this.departedColors = new Map(); // sessionId -> palette index of a floor that left, for the log page
    this.evicted = new WeakSet(); // entries that left the ring (a merge must not revive them)
    this.logSeq = 0;
    this.signals = []; // live events for the page (type 'phase' / 'fail'), emptied by drainSignals()

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
    this.departedTitles.delete(sessionId);
    this.#purgeLog(sessionId);
    return true;
  }

  /** Log cutoff for a session's events: backfill window, but never earlier than its unhide moment or what was logged before its floor left. */
  logSince(sessionId, now) {
    const floor = now - this.cfg.log.backfillMinutes * 60000;
    return Math.max(floor, this.unhiddenAt.get(sessionId) ?? floor, this.logMark.get(sessionId) ?? floor);
  }

  // ---- sessions (floors) -------------------------------------------------------------------

  syncSessions(live, now) {
    this.now = now;
    const liveIds = new Set(live.map((s) => s.sessionId));

    const backfillMs = this.cfg.log.backfillMinutes * 60000;
    for (const [id, at] of this.unhiddenAt) if (at < now - backfillMs) this.unhiddenAt.delete(id);
    for (const [id, at] of this.logMark) if (at < now - backfillMs) this.logMark.delete(id);

    // A hide record goes only after its session was absent for missTicks calls in a row: one listing hiccup
    // (also the first one after a restart) must not undo a forced hide.
    for (const id of [...this.hiddenRecs.keys()]) {
      const misses = liveIds.has(id) ? 0 : (this.hiddenMiss.get(id) ?? 0) + 1;
      if (misses >= this.cfg.floor.missTicks) {
        this.hiddenRecs.delete(id);
        this.hiddenMiss.delete(id);
        this.unhiddenAt.set(id, now);
        this.#bump();
      } else if (misses > 0) this.hiddenMiss.set(id, misses);
      else this.hiddenMiss.delete(id);
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
      f.folder = folderOf(s.cwd);
      f.status = s.status === 'busy' ? 'busy' : 'waiting';
      // The session file is the authority for waiting: a turn that ended without an end event must not leave the lead busy.
      if (f.status === 'waiting' && (f.lead.state === 'working' || f.lead.state === 'thinking')) this.#setState(f.lead, 'idle', '', now);

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
        this.#markLogged(f.sessionId);
      }
    }
  }

  #createFloor(s) {
    const lead = this.#pickLead(); // before #pickDesign: both rotate from the same creation counter
    const design = this.#pickDesign();
    const colorIndex = this.#pickColor();
    return {
      sessionId: s.sessionId,
      provider: 'claude',
      pid: s.pid,
      startedAt: s.startedAt,
      folder: '',
      status: 'waiting',
      leavingAt: null,
      hidden: false,
      seq: this.floorSeq++,
      design,
      colorIndex,
      aiTitle: '',
      lead: { name: lead.name, role: lead.role, sprite: lead.key, head: '', state: 'idle', bubble: '', lastRead: null },
      createdAt: this.now, // events stamped before this are backfill: they drive state but raise no live signal
      todoItems: [], // [{text, status, gone?}] of the main session
      liveRuns: new Set(), // runIds whose launch was seen live (not in backfill)
      runPhases: new Map(), // runId -> {phase, armed}: armed once a phase change may raise a signal
      boardLine: '',
      boardRun: '', // runId that owns boardLine
      workflows: new Map(), // runId -> {name, scriptPath}
      doneRuns: new Set(), // runIds the poller reported done
      agents: new Map(), // agentId -> agent
      usedNames: new Set([lead.name]),
      usedSlots: new Set(),
      reports: 0,
      unknownSeq: this.floorSeq * 5, // start of the pool scan for kinds without a fixed character; advances per pick, and floors start apart
    };
  }

  /** Character pool for unknown agent kinds: every sprite key of the roles table, with its Claude and Codex name. */
  #buildPool() {
    const byKey = new Map();
    for (const [k, r] of Object.entries(this.cfg.roles)) {
      const c = byKey.get(r.key) ?? byKey.set(r.key, { key: r.key, claude: null, codex: null }).get(r.key);
      if (k.startsWith('codex:')) c.codex ??= r.name;
      else c.claude ??= r.name;
    }
    return [...byKey.values()].map((c) => ({ key: c.key, claude: c.claude ?? c.codex, codex: c.codex ?? c.claude }));
  }

  /** Least used boss among the visible floors (not hidden; a leaving floor counts until it is removed); ties go to the first in rotation order from the creation counter. */
  #pickLead() {
    const { leads } = this.cfg;
    const used = new Map(leads.map((l) => [l.key, 0]));
    for (const f of this.floors.values()) if (!f.hidden && used.has(f.lead.sprite)) used.set(f.lead.sprite, used.get(f.lead.sprite) + 1);
    const start = this.floorsCreated % leads.length; // #pickDesign advances the counter right after
    let best = leads[start];
    for (let k = 1; k < leads.length; k++) {
      const l = leads[(start + k) % leads.length];
      if (used.get(l.key) < used.get(best.key)) best = l;
    }
    return best;
  }

  /** Least used design among the visible floors; ties go to the first in rotation order from the creation counter. */
  #pickDesign() {
    const { designOrder } = this.cfg;
    const used = new Map(designOrder.map((d) => [d, 0]));
    for (const f of this.floors.values()) if (!f.hidden && used.has(f.design)) used.set(f.design, used.get(f.design) + 1);
    const start = this.floorsCreated++ % designOrder.length;
    let best = designOrder[start];
    for (let k = 1; k < designOrder.length; k++) {
      const d = designOrder[(start + k) % designOrder.length];
      if (used.get(d) < used.get(best)) best = d;
    }
    return best;
  }

  /** Palette index least used among the visible floors; ties go to the lowest index. */
  #pickColor() {
    const used = new Array(this.cfg.ui.sessionPalette.length).fill(0);
    for (const f of this.floors.values()) if (!f.hidden && f.colorIndex < used.length) used[f.colorIndex]++;
    return used.indexOf(Math.min(...used));
  }

  /** Remembers the first ts of the session not yet logged, so a resumed floor does not log the same window again. */
  #markLogged(sessionId) {
    let newest = 0;
    for (const e of this.ring) if (e.sessionId === sessionId && e.ts > newest) newest = e.ts;
    if (newest > 0) this.logMark.set(sessionId, newest + 1);
  }

  /** Name/slot bookkeeping for an agent that is leaving the floor; `reseat: false` lets the caller reseat once afterwards. */
  #releaseAgent(f, a, reseat = true) {
    f.agents.delete(a.agentId);
    f.usedNames.delete(a.name);
    f.usedSlots.delete(a.slot.i);
    if (reseat) this.#reseat(f);
  }

  /**
   * A free desk goes to the agent that has waited longest (arrival order = insertion order of `f.agents`) on an idle or
   * overflow slot; its old index is released. Agents that are done or stale are not offered a desk (a stale one is
   * probably gone, and it competes again as soon as it works again).
   */
  #reseat(f) {
    const r = this.#sceneOf(f.design);
    for (const a of f.agents.values()) {
      let i = 0;
      while (i < r.seats.length && f.usedSlots.has(i)) i++;
      if (i === r.seats.length) return; // every desk is taken
      if (a.slot.kind === 'seat' || a.state === 'done' || a.state === 'stale') continue;
      f.usedSlots.delete(a.slot.i);
      f.usedSlots.add(i);
      a.slot = this.#seatSlot(r, i);
    }
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
        if (this.#isLive(f, ev)) f.liveRuns.add(ev.runId);
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
    this.#reseat(f); // a stale agent that works again may find a free desk
  }

  #setState(actor, state, bubble, now) {
    if (actor.state === state && actor.bubble === bubble) return;
    actor.state = state;
    actor.bubble = bubble;
    actor.since = now;
  }

  #isLive(f, ev) {
    return ev.ts > 0 && ev.ts >= f.createdAt;
  }

  #signal(sig) {
    this.signals.push({ ...sig, at: this.now });
    if (this.signals.length > SIGNAL_CAP) this.signals.shift();
  }

  /** Consecutive failures per actor: a success resets, a failure counts; only a live failure is announced. */
  #toolResult(f, actor, ev, isLead) {
    if (!ev.error) {
      actor.failStreak = 0;
      return;
    }
    actor.failStreak = (actor.failStreak ?? 0) + 1;
    if (!f.hidden && this.#isLive(f, ev)) this.#signal({ type: 'fail', sessionId: f.sessionId, agent: isLead ? LEAD_KEY : actor.key, streak: actor.failStreak });
  }

  #applyTodos(f, ev) {
    if (ev.todos) f.todoItems = ev.todos.map((t) => ({ ...t }));
    else if (ev.taskCreate) f.todoItems.push({ text: ev.taskCreate, status: 'pending' });
    else if (ev.taskUpdate) {
      const t = f.todoItems[ev.taskUpdate.id - 1];
      if (!t) return;
      if (ev.taskUpdate.status === 'deleted') t.gone = true;
      else if (ev.taskUpdate.status === 'pending' || ev.taskUpdate.status === 'in_progress' || ev.taskUpdate.status === 'completed') t.status = ev.taskUpdate.status;
    }
  }

  #actorEvent(f, actor, ev, now, isLead, logSince = 0) {
    if (!isLead && actor.state === 'done') return;
    const t = ev.ts > 0 ? ev.ts : now;
    if (!isLead) actor.lastAt = Math.max(actor.lastAt, t);
    const quiet = ev.ts > 0 && ev.ts < logSince;

    switch (ev.kind) {
      case 'tool':
        if (isLead) this.#applyTodos(f, ev);
        this.#setState(actor, 'working', ev.text, now);
        if (quiet) break;
        if (READ_TOOLS.has(ev.name)) this.#logRead(f, actor, t);
        else if (isLogged(ev.name)) this.#log(f, actor, t, ev.text);
        break;
      case 'toolResult': // Codex command end: counts toward the failure streak only
        this.#toolResult(f, actor, ev, isLead);
        break;
      case 'toolDone':
        if (f.provider === 'claude') this.#toolResult(f, actor, ev, isLead); // Codex counts its command ends instead
      // falls through
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
    const fresh = [];
    for (const m of metas) {
      const a = f.agents.get(m.agentId);
      if (!a) {
        if (!m.finished && !m.abandoned) fresh.push(m);
      } else if (m.abandoned && !m.finished && a.state !== 'done') {
        this.#logDone(f, a, now, LOG_ABANDONED); // gone silent: released without a report
        this.#releaseAgent(f, a, false); // reseat after the loop, once every finished agent is marked done
      } else if (m.finished && a.state !== 'done') {
        a.state = 'done';
        a.bubble = '';
        a.since = now;
        a.doneAt = now;
        f.reports++;
        this.#logDone(f, a, now);
      }
    }
    this.#reseat(f);
    for (const m of fresh) this.#enterAgent(f, m, now); // after the releases, so a freed desk goes to a waiter first
  }

  #enterAgent(f, m, now) {
    const { log } = this.cfg;
    const entry = this.#roleFor(f, m.agentType) ?? this.#spreadRole(f, m.agentType);
    const wf = m.workflow;
    const head = clip(wf ? `${wf.phase} · ${wf.label}` : m.description ?? '', log.headMaxChars);
    const slot = this.#allocSceneSlot(f, this.#sceneOf(f.design));
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
    const startTs = m.mtimeMs > 0 ? m.mtimeMs : now; // discovered at server start: when it really started
    if (startTs >= this.logSince(f.sessionId, now)) this.#log(f, a, startTs, LOG_START);
  }

  /** Claude floors know Claude role names, Codex floors the `codex:` ones; anything else is null (see #spreadRole). */
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
    return known ? roles[agentType] : null;
  }

  /** An unknown kind takes the pool character least used on the floor (ties: rotation from the floor's own counter); the role label is the kind. */
  #spreadRole(f, agentType) {
    const used = new Map();
    for (const a of f.agents.values()) used.set(a.sprite, (used.get(a.sprite) ?? 0) + 1);
    const { pool } = this;
    const start = f.unknownSeq++ % pool.length;
    let best = pool[start];
    for (let k = 1; k < pool.length; k++) {
      const c = pool[(start + k) % pool.length];
      if ((used.get(c.key) ?? 0) < (used.get(best.key) ?? 0)) best = c;
    }
    return { key: best.key, name: f.provider === 'codex' ? best.codex : best.claude, role: this.#kindLabel(agentType) };
  }

  /** Same rule as sanitize.firstWord: a plain word only (no paths, URLs, spaces); anything else shows as "지원". */
  #kindLabel(agentType) {
    const kind = String(agentType ?? '').replace(/^codex:/, '');
    if (kind.startsWith('__') || !/^[\w.+-]+$/.test(kind)) return '지원';
    return clip(kind, this.cfg.agent.roleMaxChars);
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

  #sceneOf(design) {
    if (!this.resolved.has(design)) this.resolved.set(design, resolveScene(this.cfg.scenes[design].raw));
    return this.resolved.get(design);
  }

  #seatSlot(r, i) {
    const seat = r.seats[i];
    // ref is the seat number, not the desk id: ids like "desk-1" contain "sk-" and the privacy guard bans that text in /api/state
    return { i, kind: 'seat', ref: String(seat.i), x: seat.at[0], y: seat.at[1], approach: seat.approach, sit: seat.sitAt, face: seat.face, ring: 0 };
  }

  /** Smallest free index over [...seats, ...idle, ...overflow]; past the last overflow point it laps with `ring` + 1 (the spot is searched on open floor). */
  #allocSceneSlot(f, r) {
    let i = 0;
    while (f.usedSlots.has(i)) i++;
    f.usedSlots.add(i);
    if (r.seats[i]) return this.#seatSlot(r, i);
    const k = i - r.seats.length;
    if (k < r.idle.length) {
      const p = r.idle[k];
      return { i, kind: 'idle', ref: String(k), x: p.at[0], y: p.at[1], approach: null, sit: null, face: p.face, ring: 0 };
    }
    const j = k - r.idle.length;
    const nav = this.cfg.nav;
    if (!this.grids.has(f.design)) this.grids.set(f.design, bakeGrid(r, nav));
    const g = this.grids.get(f.design);
    const { at, ring } = overflowPoint(r, j, {
      isOpen: (p) => isOpen(g, p), boxPx: [nav.spriteWidthPx, this.cfg.spriteHeight],
      stepPx: nav.cellPx, searchPx: nav.overflowSearchPx, maxOverlap: nav.overflowMaxOverlap,
    });
    return { i, kind: 'overflow', ref: String(j % r.overflow.length), x: Math.round(at[0]), y: Math.round(at[1]), approach: null, sit: null, face: r.overflow[j % r.overflow.length].face, ring };
  }

  // One board line per floor: the most recently reported run owns it, and the line clears when that run is done.
  setWorkflowProgress(sessionId, runId, p) {
    const f = this.floors.get(sessionId);
    if (!f) return;
    if (p.done) {
      f.runPhases.delete(runId);
      f.doneRuns.add(runId);
      if (f.boardRun === runId) {
        f.boardLine = '';
        f.boardRun = '';
      }
      return;
    }
    f.doneRuns.delete(runId);
    const max = this.cfg.log.headMaxChars;
    const name = clip(p.name ?? '', max);
    const current = clip(p.current ?? '', max);
    // A phase change raises a signal only for a run seen starting live, or after its first phase was seen: a run that was
    // already under way when the office found it must not call a meeting for phases that are past.
    let seen = f.runPhases.get(runId);
    if (!seen) f.runPhases.set(runId, (seen = { phase: '', armed: f.liveRuns.has(runId) }));
    if (current && current !== seen.phase) {
      if (seen.armed && !f.hidden) this.#signal({ type: 'phase', sessionId, phase: current });
      seen.phase = current;
      seen.armed = true;
    }
    const phases = Array.isArray(p.phases) ? p.phases : [];
    const idx = phases.indexOf(p.current);
    f.boardRun = runId;
    f.boardLine = !current ? name : phases.length && idx >= 0 ? `${name} · ${current} ${idx + 1}/${phases.length}` : `${name} · ${current}`;
  }

  /** Live events since the last call, oldest first: {type:'phase', sessionId, phase, at} and {type:'fail', sessionId, agent, streak, at}. */
  drainSignals() {
    const out = this.signals;
    if (out.length) this.signals = [];
    return out;
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
        if (!f.hidden) {
          this.departedTitles.set(f.sessionId, this.#titleOf(f));
          this.departedColors.set(f.sessionId, f.colorIndex);
        }
        this.#pruneTitles();
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

  #titleOf(f) {
    return this.names.get(f.sessionId) ?? (f.aiTitle || f.folder);
  }

  #pruneTitles() {
    const inLog = new Set(this.ring.map((e) => e.sessionId));
    for (const id of this.departedTitles.keys()) {
      if (inLog.has(id)) continue;
      this.departedTitles.delete(id);
      this.departedColors.delete(id);
    }
  }

  /** Title per session id for the log page: live floors as shown, departed ones as last seen; hidden sessions never appear. */
  logTitles(sessionIds) {
    const out = {};
    for (const id of sessionIds) {
      if (this.hiddenRecs.has(id)) continue;
      const f = this.floors.get(id);
      const title = f ? (f.hidden ? undefined : this.#titleOf(f)) : this.departedTitles.get(id);
      if (title !== undefined) out[id] = title;
    }
    return out;
  }

  /** Palette index per session id for the log page, the same rules as logTitles. */
  logColors(sessionIds) {
    const out = {};
    for (const id of sessionIds) {
      if (this.hiddenRecs.has(id)) continue;
      const f = this.floors.get(id);
      const index = f ? (f.hidden ? undefined : f.colorIndex) : this.departedColors.get(id);
      if (index !== undefined) out[id] = index;
    }
    return out;
  }

  /** {items:[{text,status}], done, total}: at most TODO_VIEW_MAX items, a window that keeps the in-progress (else first open) item. */
  #todoView(f) {
    const all = f.todoItems.filter((t) => !t.gone);
    let start = 0;
    if (all.length > TODO_VIEW_MAX) {
      const cur = all.findIndex((t) => t.status === 'in_progress');
      const at = cur >= 0 ? cur : Math.max(0, all.findIndex((t) => t.status === 'pending'));
      start = Math.max(0, Math.min(at - 3, all.length - TODO_VIEW_MAX));
    }
    return {
      items: all.slice(start, start + TODO_VIEW_MAX).map((t) => ({ text: t.text, status: t.status })),
      done: all.filter((t) => t.status === 'completed').length,
      total: all.length,
    };
  }

  snapshot() {
    const visible = [...this.floors.values()].filter((f) => !f.hidden);
    visible.sort((a, b) => a.startedAt - b.startedAt || a.seq - b.seq);
    const views = visible.map((f, i) => {
      const autoTitle = f.aiTitle || f.folder;
      const title = this.#titleOf(f);
      return {
        sessionId: f.sessionId,
        provider: f.provider,
        floorNo: i + 1,
        design: f.design,
        colorIndex: f.colorIndex,
        title,
        autoTitle,
        folder: f.folder,
        status: f.status,
        lead: { name: f.lead.name, role: f.lead.role, sprite: f.lead.sprite, state: f.lead.state, bubble: f.lead.bubble },
        board: { title, line: f.boardLine },
        todos: this.#todoView(f),
        reports: f.reports,
        workflows: [...f.workflows.keys()].filter((id) => !f.doneRuns.has(id)).length,
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

  #logDone(f, actor, ts, text = LOG_DONE) {
    if (actor.endLogged) return;
    actor.endLogged = true;
    this.#log(f, actor, ts, text);
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
    const out = [...this.pending].map((e) => ({ ...e })); // hide() purges, so nothing hidden is pending
    this.pending.clear();
    return out;
  }

  /** Newest first by ts (ties: later insertion first); the limit applies after sorting. */
  queryLog(f = {}) {
    const limit = f.limit ?? this.cfg.log.sendCap;
    const out = [];
    for (let i = this.ring.length - 1; i >= 0; i--) {
      const e = this.ring[i];
      if (f.sessionId !== undefined && e.sessionId !== f.sessionId) continue;
      if (f.name !== undefined && e.name !== f.name) continue;
      out.push(e);
    }
    return out.sort((a, b) => b.ts - a.ts).slice(0, limit).map((e) => ({ ...e }));
  }
}
