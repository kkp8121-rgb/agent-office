'use strict';
// Browser view. All server strings are inserted with textContent only. No frame loop, no canvas:
// movement is CSS transform transitions, gestures are CSS keyframes (see style.css).

// Visual constants (how things look/move, not planning numbers; those come from /api/ui).
const WALK_PX_PER_SEC = 150;
const WALK_MIN_MS = 350;
const TRAY_SPREAD_PX = 16;
const RECONNECT_MS = 3000;
const DONE_STALE_MS = 4000; // a done agent older than this is not walked to the tray again after a reload

const $ = (id) => document.getElementById(id);
const floorsEl = $('floors');
const sessionsEl = $('sessions');
const logEl = $('log');
const emptyEl = $('empty');
const connEl = $('conn');

const STATUS_TEXT = { busy: '작업 중', waiting: '입력 대기', leaving: '퇴근 중' };
const PROVIDER_TEXT = { claude: 'Claude', codex: 'Codex' };

let ui = null; // /api/ui
let es = null; // EventSource (kept after close() so readyState stays inspectable)
let retryTimer = 0;
let lastNow = Date.now(); // server clock of the latest state

const floorRecs = new Map(); // sessionId -> {el, stage, refs..., agents: Map(key -> rec)}
const rowRecs = new Map(); // sessionId -> {el, ...}
const logRows = new Map(); // log id -> element
const forcedHidden = new Map(); // sessionId -> {absent:boolean}; see render()
const recOf = new WeakMap(); // character element -> rec

// ---------- small helpers ----------

function layoutOf(design) {
  return ui.layouts[design] ?? ui.layouts[Object.keys(ui.layouts)[0]];
}

function showConn(text) {
  connEl.textContent = text;
  connEl.hidden = false;
}

// ---------- characters ----------

function createChar(av, stage, startAt) {
  const root = el('div', 'ag');
  const bubTxt = el('div', 'bub txt empty');
  const bubDot = el('div', 'bub dot empty', '…');
  const body = el('div', 'body');
  const flip = el('div', 'flip');
  const spr = el('div', 'spr');
  const tag = el('div', 'tag');
  const zz = el('div', 'zz', 'zZ');
  const img = makeSprite(av.sprite);
  spr.append(img);
  flip.append(spr);
  body.append(flip);
  root.append(bubTxt, bubDot, body, tag, zz);
  root.style.zIndex = String(Math.round(startAt.y));
  root.style.transform = `translate(${startAt.x}px, ${startAt.y}px)`;
  const rec = { el: root, bubTxt, bubDot, flip, tag, img, sprite: av.sprite, x: startAt.x, y: startAt.y, state: '', bubKey: null, arrived: false };
  recOf.set(root, rec);
  const settle = (e) => {
    if (e.target !== root || e.propertyName !== 'transform') return;
    // A cancel caused by a retarget leaves a newer walk running: only the latest walk's end (or a cancel with no
    // walk left, as when pause() switches transitions off) settles.
    if (e.type === 'transitioncancel' && root.getAnimations().some((a) => a.transitionProperty === 'transform' && a.playState === 'running')) return;
    root.classList.remove('walking');
    flip.classList.remove('left');
    rec.arrived = true;
    if (rec.state === 'done') root.classList.add('arrived');
  };
  root.addEventListener('transitionend', settle);
  root.addEventListener('transitioncancel', settle);
  stage.append(root);
  return rec;
}

/** Moves a character in a straight line; the duration follows the distance. */
function walkTo(elm, x, y) {
  const rec = recOf.get(elm);
  const dx = x - rec.x;
  const dy = y - rec.y;
  const dist = Math.hypot(dx, dy);
  rec.x = x;
  rec.y = y;
  elm.style.zIndex = String(Math.round(y));
  if (dist < 1) return;
  rec.arrived = false;
  elm.style.transitionDuration = `${Math.max(WALK_MIN_MS, (dist / WALK_PX_PER_SEC) * 1000)}ms`;
  rec.flip.classList.toggle('left', dx < 0);
  elm.classList.add('walking');
  elm.style.transform = `translate(${x}px, ${y}px)`;
}

function setBubble(rec, bubble, since) {
  const key = `${bubble}|${since}`;
  if (key === rec.bubKey) return;
  rec.bubKey = key;
  const empty = bubble === '';
  rec.bubTxt.classList.toggle('empty', empty);
  rec.bubDot.classList.toggle('empty', empty);
  if (empty) return;
  const chars = Array.from(bubble);
  const max = ui.ui.bubbleMaxChars;
  const text = chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : bubble;
  setText(rec.bubTxt, text);
  const remain = Math.max(0, ui.bubbleShowMs - (lastNow - since));
  for (const b of [rec.bubTxt, rec.bubDot]) {
    b.classList.remove('fresh'); // restart the CSS collapse timer
    b.style.setProperty('--show', `${remain}ms`);
  }
  void rec.el.offsetWidth;
  rec.bubTxt.classList.add('fresh');
  rec.bubDot.classList.add('fresh');
}

function renderAgent(av, floorEl) {
  const frec = floorRecs.get(floorEl.dataset.sid);
  const layout = frec.layout;
  const isLead = av.key === 'lead';
  let rec = frec.agents.get(av.key);
  const done = av.state === 'done';
  const target = done
    ? { x: layout.tray[0] + ((av.slot.i % 3) - 1) * TRAY_SPREAD_PX, y: layout.tray[1] }
    : { x: av.slot.x, y: av.slot.y };

  if (!rec) {
    // The first render of a floor places everyone directly; later newcomers walk in from the entrance.
    const startAt = frec.populated && !isLead && !done ? { x: layout.entrance[0], y: layout.entrance[1] } : target;
    rec = createChar(av, frec.stage, startAt);
    frec.agents.set(av.key, rec);
    if (frec.populated && !isLead) rec.el.classList.add('enter-in');
    if (frec.populated && !isLead && !done) void rec.el.offsetWidth; // commit the start point before the walk
  }

  if (rec.sprite !== av.sprite) {
    rec.sprite = av.sprite;
    rec.img.src = spriteUrl(av.sprite);
  }
  setText(rec.tag, av.name);
  rec.tag.title = av.role;
  rec.el.classList.toggle('odd', !isLead && av.slot.i % 2 === 1);

  const stateChanged = rec.state !== av.state;
  if (stateChanged) {
    if (rec.state) rec.el.classList.remove(`st-${rec.state}`);
    rec.state = av.state;
    rec.el.classList.add(`st-${av.state}`);
  }
  if (done && !frec.populated && lastNow - av.since > DONE_STALE_MS) rec.el.classList.add('gone'); // already reported before this page loaded

  setBubble(rec, av.bubble, av.since);

  if (rec.x !== target.x || rec.y !== target.y) {
    walkTo(rec.el, target.x, target.y);
  } else if (done && !rec.el.classList.contains('walking')) {
    rec.arrived = true;
    rec.el.classList.add('arrived');
  }
}

// ---------- floors ----------

function createFloor(fv) {
  const layout = layoutOf(fv.design);
  const root = el('section', 'floor');
  root.dataset.sid = fv.sessionId;
  root.style.setProperty('--c', colorOf(fv.sessionId));
  root.style.width = `${layout.size[0]}px`;
  root.style.height = `${layout.size[1]}px`;
  const stage = el('div', 'stage');
  stage.style.backgroundImage = `url(/assets/floors/${encodeURIComponent(layout.image)})`;
  stage.style.backgroundSize = `${layout.size[0]}px ${layout.size[1]}px`;

  const board = el('div', 'board');
  const [bx, by, bw, bh] = layout.board;
  Object.assign(board.style, { left: `${bx}px`, top: `${by}px`, width: `${bw}px`, maxHeight: `${bh}px` });
  const bt = el('b');
  const bl = el('p');
  board.append(bt, bl);

  const sign = el('div', 'sign');
  sign.title = '더블클릭하면 이름을 바꿉니다';
  const fno = el('span', 'fno');
  const ft = el('span', 'ft');
  const ff = el('span', 'ff');
  const fs = el('span', 'fs');
  const prov = el('span', 'badge');
  sign.append(fno, ft, ff, prov, fs);
  sign.addEventListener('dblclick', () => startRename(fv.sessionId, sign, ft));

  const reports = el('div', 'reports');
  reports.style.left = `${layout.tray[0] + 30}px`;
  reports.style.top = `${layout.tray[1] - 22}px`;
  reports.hidden = true;

  stage.append(board, sign, reports);
  root.append(stage);
  const rec = { el: root, stage, layout, bt, bl, fno, ft, ff, fs, prov, reports, agents: new Map(), populated: false };
  floorRecs.set(fv.sessionId, rec);
  return rec;
}

function renderFloor(fv, elm) {
  const rec = floorRecs.get(fv.sessionId);
  setText(rec.fno, `${fv.floorNo}F`);
  setText(rec.ft, fv.title);
  setText(rec.ff, fv.folder);
  setText(rec.prov, PROVIDER_TEXT[fv.provider] ?? fv.provider);
  setText(rec.fs, STATUS_TEXT[fv.status] ?? fv.status);
  rec.fs.className = `fs ${fv.status}`;
  setText(rec.bt, fv.board.title);
  setText(rec.bl, fv.board.line);
  rec.bl.hidden = fv.board.line === '';
  elm.classList.toggle('leaving', fv.status === 'leaving');
  rec.reports.hidden = fv.reports <= 0;
  if (fv.reports > 0) setText(rec.reports, `보고 ${fv.reports}`);

  const leadView = {
    key: 'lead',
    name: fv.lead.name,
    role: fv.lead.role,
    sprite: fv.lead.sprite,
    slot: { x: rec.layout.lead[0], y: rec.layout.lead[1], i: 0 },
    state: fv.lead.state,
    bubble: fv.lead.bubble,
    since: fv.lead.bubble === (rec.leadBubble ?? null) ? rec.leadSince : lastNow,
  };
  rec.leadBubble = fv.lead.bubble;
  rec.leadSince = leadView.since;
  const keys = new Set(['lead']);
  renderAgent(leadView, elm);
  for (const av of fv.agents) {
    keys.add(av.key);
    renderAgent(av, elm);
  }
  for (const [key, a] of [...rec.agents]) {
    if (!keys.has(key)) {
      a.el.remove();
      rec.agents.delete(key);
    }
  }
  rec.populated = true;
}

// ---------- session list ----------

function createRow(fv) {
  const root = el('div', 'srow');
  root.dataset.sid = fv.sessionId;
  root.style.setProperty('--c', colorOf(fv.sessionId));
  const nm = el('div', 'nm');
  const title = el('b');
  const meta = el('span');
  nm.append(title, meta);
  const edit = el('button', 'mini', '✎');
  edit.type = 'button';
  edit.title = '이름 바꾸기';
  edit.setAttribute('aria-label', '이름 바꾸기');
  edit.addEventListener('click', () => startRename(fv.sessionId, nm, title));
  const eye = el('button', 'eye', '숨김');
  eye.type = 'button';
  eye.addEventListener('click', () => {
    if (window.confirm('이 세션을 다시 실행할 때까지 안 보입니다')) setHidden(fv.sessionId, true);
  });
  root.append(el('i', 'dot'), nm, edit, eye);
  const rec = { el: root, nm, title, meta };
  rowRecs.set(fv.sessionId, rec);
  return rec;
}

function renderRow(fv, rec) {
  setText(rec.title, fv.title);
  rec.title.title = fv.autoTitle;
  const subs = fv.agents.filter((a) => a.state !== 'done').length;
  setText(rec.meta, `${fv.floorNo}F · ${PROVIDER_TEXT[fv.provider] ?? fv.provider} · 서브 ${subs}${fv.workflows > 0 ? ` · 워크플로 ${fv.workflows}` : ''}`);
}

// ---------- rename ----------

function startRename(sessionId, host, titleEl) {
  if (host.querySelector('input.rename')) return;
  const fv = lastFloors.get(sessionId);
  if (!fv) return;
  const input = el('input', 'rename');
  input.type = 'text';
  input.maxLength = ui.nameMaxChars;
  input.value = fv.title === fv.autoTitle ? '' : fv.title;
  input.placeholder = fv.autoTitle;
  input.setAttribute('aria-label', '세션 이름');
  const err = el('span', 'err');
  let busy = false;
  let closed = false;
  const close = () => {
    if (closed) return; // removing a focused input fires blur, which calls close again
    closed = true;
    input.remove();
    err.remove();
    titleEl.hidden = false;
  };
  input.addEventListener('keydown', async (e) => {
    if (e.isComposing) return;
    if (e.key === 'Escape') return close();
    if (e.key !== 'Enter' || busy) return;
    e.preventDefault();
    busy = true;
    const res = await post('/api/rename', { sessionId, name: input.value.trim() });
    busy = false;
    if (res && res.status === 204) {
      close();
      refreshState();
    } else if (res && res.status === 404) {
      close();
      removeSession(sessionId);
    } else {
      err.textContent = '저장하지 못했습니다';
    }
  });
  input.addEventListener('blur', () => {
    if (!busy) close();
  });
  titleEl.hidden = true;
  titleEl.after(input, err);
  input.focus();
}

// ---------- state ----------

let lastFloors = new Map();

function removeSession(sessionId, withLog = true) {
  const f = floorRecs.get(sessionId);
  if (f) {
    f.el.remove();
    floorRecs.delete(sessionId);
  }
  const r = rowRecs.get(sessionId);
  if (r) {
    r.el.remove();
    rowRecs.delete(sessionId);
  }
  if (withLog) {
    for (const [id, row] of [...logRows]) {
      if (row.dataset.sid === sessionId) {
        row.remove();
        logRows.delete(id);
      }
    }
  }
  lastFloors.delete(sessionId);
  emptyEl.hidden = floorRecs.size > 0;
}

/** Puts `elms` into `parent` in this order, touching only the elements that are out of place. */
function syncOrder(parent, elms) {
  elms.forEach((e, i) => {
    if (parent.children[i] !== e) parent.insertBefore(e, parent.children[i] ?? null);
  });
}

function render(state) {
  lastNow = state.now;
  // Forced hide: a hidden id stays out until a snapshot has lacked it and then has it again (a re-run).
  const present = new Set(state.floors.map((f) => f.sessionId));
  for (const [id, rec] of [...forcedHidden]) {
    if (!present.has(id)) rec.absent = true;
    else if (rec.absent) forcedHidden.delete(id);
  }
  const list = state.floors.filter((f) => !forcedHidden.has(f.sessionId));
  const ids = new Set(list.map((f) => f.sessionId));
  for (const id of [...floorRecs.keys()]) if (!ids.has(id)) removeSession(id, false);

  lastFloors = new Map(list.map((f) => [f.sessionId, f]));
  const floorEls = [];
  const rowEls = [];
  for (const fv of list) {
    const frec = floorRecs.get(fv.sessionId) ?? createFloor(fv);
    renderFloor(fv, frec.el);
    floorEls.push(frec.el);
    const rrec = rowRecs.get(fv.sessionId) ?? createRow(fv);
    renderRow(fv, rrec);
    rowEls.push(rrec.el);
  }
  syncOrder(floorsEl, floorEls);
  syncOrder(sessionsEl, rowEls);
  emptyEl.hidden = list.length > 0;
}

async function refreshState() {
  if (!ui) return;
  try {
    const r = await fetch('/api/state');
    if (r.ok) render(await r.json());
  } catch {
    // the event stream reports connection problems
  }
}

async function post(path, body) {
  try {
    return await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch {
    return null;
  }
}

/** hidden=true: POST the hide and remove the session from the page at once; false: forget the local hide. */
async function setHidden(sessionId, hidden) {
  if (!hidden) {
    forcedHidden.delete(sessionId);
    return true;
  }
  const res = await post('/api/hide', { sessionId });
  if (!res || (res.status !== 204 && res.status !== 404)) {
    showConn('숨기지 못했습니다');
    setTimeout(() => { connEl.hidden = true; }, RECONNECT_MS);
    return false;
  }
  forcedHidden.set(sessionId, { absent: false });
  removeSession(sessionId);
  return true;
}

// ---------- log ----------

/** Entries arrive oldest-first in a batch; the newest row sits on top. A repeated id updates its row in place. */
function appendLog(entries) {
  for (const e of entries) {
    if (forcedHidden.has(e.sessionId)) continue;
    let row = logRows.get(e.id);
    if (!row) {
      row = createLogRow(e);
      logRows.set(e.id, row);
      let before = logEl.firstElementChild;
      while (before && Number(before.dataset.ts) > e.ts) before = before.nextElementSibling;
      logEl.insertBefore(row, before);
    }
    fillLogRow(row, e);
  }
  while (logEl.childElementCount > ui.ui.logDomCap) {
    const last = logEl.lastElementChild;
    logRows.delete(last.dataset.id);
    last.remove();
  }
}

// ---------- connection ----------

function connect() {
  if (!ui || (es && es.readyState !== 2)) return;
  clearTimeout(retryTimer);
  es = new EventSource('/api/events');
  es.addEventListener('open', () => { connEl.hidden = true; });
  es.addEventListener('state', (ev) => render(JSON.parse(ev.data)));
  es.addEventListener('log', (ev) => appendLog(JSON.parse(ev.data)));
  es.addEventListener('error', () => {
    showConn('연결이 끊겼습니다. 다시 연결하는 중…');
    // The browser retries by itself unless the server refused the stream (then the state is CLOSED).
    if (es.readyState === 2 && !document.body.classList.contains('paused')) retryTimer = setTimeout(connect, RECONNECT_MS);
  });
}

function pause() {
  clearTimeout(retryTimer);
  if (es) es.close();
  document.body.classList.add('paused');
}

async function resume() {
  document.body.classList.remove('paused');
  connEl.hidden = true;
  await refreshState();
  if (document.hidden) return; // hidden again while the state was loading: stay paused
  connect();
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) pause();
  else resume();
});

$('quit').addEventListener('click', async () => {
  if (!window.confirm('사무실 서버를 끕니다. 계속할까요?')) return;
  await post('/api/shutdown', {});
  pause();
  showConn('서버를 껐습니다. 이 창은 닫아도 됩니다.');
});

(async function init() {
  try {
    ui = await (await fetch('/api/ui')).json();
  } catch {
    showConn('서버에 연결하지 못했습니다');
    return;
  }
  if (document.hidden) document.body.classList.add('paused');
  else connect();
})();
