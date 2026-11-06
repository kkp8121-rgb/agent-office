// The whiteboard detail panel: a click on the wall board of a floor opens a dialog (card style: role dialog, focus kept inside, Esc / close button /
// click outside close it, focus goes back to the board) with everything the browser already knows about that floor.
// Pure model first (panelModel: what the panel shows), then the DOM. Nothing is invented: every field comes from the floor view of the snapshot.
// The panel redraws when the office calls refresh() after a state update (no timers). Opening and closing animate opacity and transform only,
// and only while the effects switch is on and the viewer does not ask for reduced motion; otherwise it appears and disappears at once.
import { fmtDuration, live as office, onLive } from './lobby.mjs';
import { progressFrac, rowKind } from './board.mjs';
import { floorCost } from './cost-view.mjs';

const COST_PEOPLE = 3; // the floor's people listed under its cost
const fill = (template, vars) => template.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''));

/** The count line and bar numbers of a list: {head, done, total, frac}. `template` = ui.board.todos / phases. */
function counted(template, done, total) {
  return { head: fill(template, { done, total }), done, total, frac: progressFrac(done, total) };
}

/**
 * What the panel shows for a floor view `fv` at time `now` (ms). `L` = ui.boardPanel, `board` = ui.board, `lobby` = ui.lobby (state words, duration units),
 * `cost` = {frame, cfg} (the latest cost frame and ui.cost) or null.
 * {title, folder, lead: {name, role, state, doing}, runFor, cost, todos, phases, staff}; todos / phases are null when the floor has none; cost is null without `cost`:
 * {title, total, people, cache} (see floorCost): the floor's new tokens today, its top people, and the cache reads, which are never part of the total.
 * todos: {head, done, total, frac, rows: [{text, kind}], more}; phases: the same plus {summary} (done, now, next); no bar when the script lists no total.
 * The lists are what the server sent: a long list is a window, `more` counts the items it left out.
 */
export function panelModel(fv, now, L, board, lobby, cost = null) {
  const rowsOf = (items) => items.map((i) => ({ text: i.text, kind: rowKind(i.status) }));
  let todos = null;
  if (fv.todos && fv.todos.total > 0) todos = { ...counted(board.todos, fv.todos.done, fv.todos.total), rows: rowsOf(fv.todos.items), more: fv.todos.total - fv.todos.items.length };
  let phases = null;
  const p = fv.phases;
  if (p) {
    const done = Math.min(Math.max(0, p.n - 1), p.total || p.n - 1);
    const current = p.items.find((i) => i.status === 'in_progress');
    const next = p.items.find((i) => i.status === 'pending');
    const summary = [fill(L.phaseDone, { n: done }), current ? fill(L.phaseNow, { name: current.text }) : '', next ? fill(L.phaseNext, { name: next.text }) : L.phaseNoNext]
      .filter(Boolean).join(' · ');
    const head = p.total > 0 ? counted(board.phases, done, p.total) : { head: fill(board.phasesOpen, { n: p.n }), done, total: 0, frac: 0 };
    phases = { ...head, rows: rowsOf(p.items), more: p.more, summary };
  }
  const stateWord = (s) => lobby.state[s] ?? s;
  const staff = fv.agents.map((a) => ({
    key: a.key,
    name: a.name,
    role: a.role,
    state: stateWord(a.state),
    doing: a.bubble || '',
    since: a.since > 0 ? fmtDuration(Math.max(0, now - a.since), lobby) : '',
  }));
  return {
    title: fv.title,
    folder: fv.folder,
    lead: { name: fv.lead.name, role: fv.lead.role, state: stateWord(fv.lead.state), doing: fv.lead.bubble || '' },
    runFor: fv.startedAt > 0 ? fmtDuration(Math.max(0, now - fv.startedAt), lobby) : '',
    cost: cost && floorCost(cost.frame, cost.cfg, fv.sessionId, { floor: fill(lobby.floorLabel, { n: fv.floorNo }), cacheRead: costCacheLabel(lobby, cost.cfg) }, COST_PEOPLE),
    todos,
    phases,
    staff,
  };
}

/** The label of the cache-read row: the frame holds the whole office's cache reads, so the row says so with the first word of 「사무실 지수」 (no word of its own in the config). */
function costCacheLabel(lobby, cfg) {
  return `${lobby.officeIndex.split(' ')[0]} ${cfg.cacheReadLabel}`;
}

// ---------- DOM ----------

function mk(doc, tag, cls, text) {
  const n = doc.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function section(doc, title) {
  const s = mk(doc, 'section', 'bp-sec');
  s.append(mk(doc, 'h3', 'bp-h', title));
  return s;
}

function barEl(doc, frac) {
  const bar = mk(doc, 'div', 'bp-bar');
  const i = mk(doc, 'i');
  i.style.width = `${Math.round(frac * 100)}%`;
  bar.append(i);
  return bar;
}

function listEl(doc, rows, more, L) {
  const ul = mk(doc, 'ul', 'bp-list');
  for (const r of rows) {
    const li = mk(doc, 'li', `bp-row wb-${r.kind}`);
    li.append(mk(doc, 'span', 'wb-mk bp-mk'), mk(doc, 'span', 'bp-tx', r.text));
    ul.append(li);
  }
  if (more > 0) ul.append(mk(doc, 'li', 'bp-more', fill(L.more, { n: more })));
  return ul;
}

/** The body of the panel for a model `m`. */
function bodyOf(doc, m, L) {
  const frag = doc.createDocumentFragment();
  const info = mk(doc, 'dl', 'bp-info');
  const add = (k, v) => {
    if (v) info.append(mk(doc, 'dt', '', k), mk(doc, 'dd', '', v));
  };
  add(L.session, m.title);
  add(L.folder, m.folder);
  add(L.lead, [m.lead.name, m.lead.role].filter(Boolean).join(' · '));
  add(L.runFor, m.runFor);
  frag.append(info);
  if (m.cost) {
    const s = section(doc, m.cost.title);
    const dl = mk(doc, 'dl', 'bp-info');
    for (const r of [m.cost.total, ...m.cost.people]) dl.append(mk(doc, 'dt', '', r.label), mk(doc, 'dd', '', r.text));
    const small = mk(doc, 'small', '', m.cost.cache.text);
    dl.append(mk(doc, 'dt', '', m.cost.cache.label), mk(doc, 'dd')); // cache reads: smaller, below the new tokens, never added to them
    dl.lastChild.append(small);
    s.append(dl);
    frag.append(s);
  }
  if (m.todos) {
    const s = section(doc, m.todos.head);
    s.append(barEl(doc, m.todos.frac), listEl(doc, m.todos.rows, m.todos.more, L));
    frag.append(s);
  }
  if (m.phases) {
    const s = section(doc, m.phases.head);
    if (m.phases.total > 0) s.append(barEl(doc, m.phases.frac));
    s.append(mk(doc, 'p', 'bp-sum', m.phases.summary), listEl(doc, m.phases.rows, m.phases.more, L));
    frag.append(s);
  }
  if (!m.todos && !m.phases) frag.append(mk(doc, 'p', 'bp-none', L.noLists));
  const staff = section(doc, fill(L.staff, { n: m.staff.length + 1 }));
  const ul = mk(doc, 'ul', 'bp-staff');
  const person = (p, lead) => {
    const li = mk(doc, 'li', 'bp-person');
    li.append(mk(doc, 'b', '', p.name), mk(doc, 'span', 'bp-role', lead ? L.leadTag : p.role));
    li.append(mk(doc, 'span', 'bp-doing', [p.state, p.doing].filter(Boolean).join(' · ')));
    if (p.since) li.append(mk(doc, 'span', 'bp-since', fill(L.since, { dur: p.since })));
    return li;
  };
  ul.append(person(m.lead, true), ...m.staff.map((p) => person(p, false)));
  staff.append(ul);
  frag.append(staff);
  return frag;
}

/**
 * The panel component. deps: {L (ui.boardPanel), board (ui.board), lobby (ui.lobby), fx ({fxOn}), now () -> ms, reduced () -> boolean}.
 * Returns {open(key, boardEl, view), close(), refresh(), isOpen(), key()}. `view()` answers the floor view of the opened floor, or null once it has gone.
 */
export function createBoardPanel(deps) {
  const { L, board, lobby, fx } = deps;
  let live = null; // {key, view, boardEl, doc, back, panel, body, gone, closeBtn, stop}
  let closing = null; // {node, cancel}

  const motionOn = () => fx.fxOn() && !deps.reduced();

  function finishClosing() {
    if (!closing) return;
    const c = closing;
    closing = null;
    c.cancel();
    c.node.remove();
  }

  function paint() {
    const fv = live.view();
    live.gone.hidden = fv !== null;
    if (fv) live.body.replaceChildren(bodyOf(live.doc, panelModel(fv, deps.now(), L, board, lobby, office.cfg ? { frame: office.cost, cfg: office.cfg } : null), L));
  }

  function animate(c, opening) {
    const m = L.motion;
    const frames = [{ opacity: 0, transform: `translateY(${m.risePx}px)` }, { opacity: 1, transform: 'none' }];
    const opts = { duration: opening ? m.openMs : m.closeMs, easing: opening ? 'cubic-bezier(.2,.8,.25,1)' : 'cubic-bezier(.5,0,.8,.4)', fill: 'both' };
    return [c.panel.animate(opening ? frames : frames.reverse(), opts), c.back.animate(opening ? [{ opacity: 0 }, { opacity: 1 }] : [{ opacity: 1 }, { opacity: 0 }], opts)];
  }

  function open(key, boardEl, view) {
    finishClosing();
    if (live) {
      live.stop();
      live.boardEl.setAttribute('aria-expanded', 'false');
      live.back.remove();
      live = null;
    }
    const doc = boardEl.ownerDocument;
    const back = mk(doc, 'div', 'bp-back');
    const panel = mk(doc, 'div', 'bp-panel');
    panel.style.width = `${L.widthPx}px`;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-labelledby', 'bp-title');
    const head = mk(doc, 'header', 'bp-head');
    const title = mk(doc, 'h2', '', L.title);
    title.id = 'bp-title';
    const closeBtn = mk(doc, 'button', 'bp-close', '×');
    closeBtn.type = 'button';
    closeBtn.title = L.close;
    closeBtn.setAttribute('aria-label', L.closeLabel);
    head.append(title, closeBtn);
    const gone = mk(doc, 'p', 'bp-gone', L.gone);
    gone.hidden = true;
    const body = mk(doc, 'div', 'bp-body');
    panel.append(head, gone, body);
    back.append(panel);
    doc.body.append(back);
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      } else if (e.key === 'Tab') {
        e.preventDefault(); // the only control is the close button: focus stays in the panel
        closeBtn.focus({ preventScroll: true });
      }
    };
    doc.addEventListener('keydown', onKey, true);
    back.addEventListener('click', (e) => {
      if (!panel.contains(e.target)) close();
    });
    closeBtn.addEventListener('click', close);
    const offLive = onLive(() => live && paint()); // a new cost frame repaints the open panel
    live = { key, view, boardEl, doc, back, panel, body, gone, closeBtn, stop: () => { doc.removeEventListener('keydown', onKey, true); offLive(); } };
    boardEl.setAttribute('aria-expanded', 'true');
    paint();
    if (motionOn()) {
      const anims = animate(live, true);
      Promise.all(anims.map((a) => a.finished)).then(() => anims.forEach((a) => a.cancel()), () => {});
    }
    closeBtn.focus({ preventScroll: true });
  }

  function close() {
    if (!live) return;
    const c = live;
    live = null;
    c.stop();
    c.boardEl.setAttribute('aria-expanded', 'false');
    if (motionOn()) {
      c.back.style.pointerEvents = 'none';
      const anims = animate(c, false);
      closing = { node: c.back, cancel: () => anims.forEach((a) => a.cancel()) };
      const finish = () => {
        c.back.remove();
        if (closing?.node === c.back) closing = null;
      };
      Promise.all(anims.map((a) => a.finished)).then(finish, finish);
    } else c.back.remove();
    if (c.boardEl.isConnected) c.boardEl.focus({ preventScroll: true });
  }

  return { open, close, refresh: () => live && paint(), isOpen: () => live !== null, key: () => live?.key ?? null };
}
