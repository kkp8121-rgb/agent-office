'use strict';
// Browser view (an ES module). All server strings are inserted with textContent only. No frame loop, no canvas:
// movement is CSS transform transitions, gestures are CSS keyframes (see style.css).
import { resolveScene, trayPoint } from './scene.mjs';
import { createNav } from './nav.mjs';
import { charZ, objectNodes, splitWalk } from './depth.mjs';
import { fitZoom } from './pip.mjs';
import { orderFloors, nextFloor, fallbackFloor, fitBox } from './view.mjs';
import { dropPoint, restSpotNear, shouldLift } from './grab.mjs';
import { daypart, nextPoke, openBox, pickLine, playPartner, throwPath, throwVelocity } from './play.mjs';
import { between, chooseFidget, chooseSpot, createFloorClock, rngFor, tripRange } from './ambient.mjs';
import { chooseCatAct, openPoint, otherFloor } from './cat.mjs';
import { legVars } from './walk.mjs';
import { boardCapacity, boardFrame, itemWindow, todoKey } from './board.mjs';
import { assignSpots, clipPhase, moodKind, patDue } from './meeting.mjs';
import { lightAt, msToNextChange, placeSeason, seasonOn } from './season.mjs';
import { pickAt, snackOutcome } from './snack.mjs';

// Visual constants (how things look/move, not planning numbers; those come from /api/ui).
const WALK_PX_PER_SEC = 150;
const WALK_MIN_MS = 350;
const RECONNECT_MS = 3000;
const DONE_STALE_MS = 4000; // a done agent older than this is not walked to the tray again after a reload
const HELD_Z = 7900; // a held character draws above every object and character of its floor (the name tags sit at 8000)
const HELD_FOLLOW_MS = 80; // a held character trails the pointer by this much, which also softens the lift
const SINGLE_MAX_ZOOM = 3; // a single floor (or the stack with the panel hidden) is scaled up to fit, at most this much
const PANEL_KEY = 'agent-office.panelOff'; // localStorage: the session panel was hidden by the person
const LIFT_PX = 28; // the held character's height above its shadow (--lift in style.css)
const BOARD_LINE_PX = 9; // line height of the text on the wall board (.wboard in style.css)
const BOARD_PAD_PX = 2; // padding of the wall board (the same)
const BOARD_MIN_ITEMS = 3; // the wall board always shows at least this many items
const BIG_WIDTH_PX = 250; // width of the enlarged to-do list (.wbig)
const BIG_GAP_PX = 6; // its distance from the floor edge and from the board
const TODO_MARK = { in_progress: '▶', completed: '✓', pending: '☐' };
const NO_TODOS = { items: [], done: 0, total: 0 };
const FX_URL = '/assets/fx/'; // the failure faces (sweat-drop, rain-cloud-1/2) and the snack sparkle (sparkle-1/2)
const SNACK_URL = '/assets/snacks/snack-'; // + coffee|donut|cookie|fish + .png
const ITEMS_URL = '/assets/seasonal/items.json'; // size and anchor of every decoration
const SKY_Z = 1; // the window glass tint: above the room picture, below every object
const WALL_Z_BELOW = 2; // wall decorations draw this far under the lowest floor object (zBase), above the glass tint
const SPARKLE_SPOTS = [[-14, -10], [12, -26], [-6, -40]]; // where the three sparkles hover, from the character's feet (the tag layer origin)
const SNACK_PIP_TIP = '작은 창에서는 간식을 줄 수 없습니다 (창 사이로는 끌 수 없어요)';

const QUERY = new URLSearchParams(location.search);
const DEBUG = QUERY.get('debug');
let seasonQuery = ['halloween', 'christmas', 'lunar', 'none'].includes(QUERY.get('season')) ? QUERY.get('season') : null; // ?season= overrides the date (for checking)
let lightQuery = ['day', 'sunset', 'night'].includes(QUERY.get('time')) ? QUERY.get('time') : null; // ?time= overrides the hour
const DEBUG_NAV = DEBUG === 'nav'; // ?debug=nav draws the walking grid and every scene point over each scene floor
const DEBUG_AMBIENT = DEBUG === 'ambient'; // ?debug=ambient makes the office life 10x faster and exposes window.__ambient
const SVG_NS = 'http://www.w3.org/2000/svg';

const $ = (id) => document.getElementById(id);
const appEl = $('app');
const floorsEl = $('floors');
const panelEl = $('panel');
const topbarEl = $('topbar');
const sessionsEl = $('sessions');
const logEl = $('log');
const emptyEl = $('empty');
const connEl = $('conn');
const holdEl = $('pip-hold');
const pipBtn = $('pip');

const STATUS_TEXT = { busy: '작업 중', waiting: '입력 대기', leaving: '퇴근 중' };
const PROVIDER_TEXT = { claude: 'Claude', codex: 'Codex' };

let ui = null; // /api/ui
let es = null; // EventSource (kept after close() so readyState stays inspectable)
let retryTimer = 0;
let lastNow = Date.now(); // server clock of the latest state
let pipWin = null; // the Document Picture-in-Picture window while the floors live there

const floorRecs = new Map(); // sessionId -> {el, stage, refs..., agents: Map(key -> rec)}
const rowRecs = new Map(); // sessionId -> {el, ...}
const logRows = new Map(); // log id -> element
const forcedHidden = new Map(); // sessionId -> {absent:boolean}; see render()
const recOf = new WeakMap(); // character element -> rec

// ---------- small helpers ----------

/** Scales the floors (CSS zoom) to the room: the widest one down to fit beside the panel (or above it in a narrow window); the single floor shown, or the stack once the panel is hidden, up or down. */
function fitFloors() {
  const doc = floorsEl.ownerDocument; // the small window's document while the floors are there
  const mini = doc.body.classList.contains('pip-mini');
  let availW;
  let availH;
  if (mini) {
    // mini layout: floors only, the whole window minus the body padding
    const cs = doc.defaultView.getComputedStyle(doc.body);
    availW = doc.body.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight); // the body, not the root: the root's width ignores the reserved scrollbar gutter
    availH = doc.documentElement.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  } else {
    const cs = getComputedStyle(appEl);
    const sideBySide = cs.flexDirection === 'row';
    availW = appEl.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
      - (sideBySide && panelEl.offsetWidth ? panelEl.offsetWidth + parseFloat(cs.columnGap) : 0);
    availH = window.innerHeight - topbarEl.offsetHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  }
  const shown = shownId === null ? null : floorRecs.get(shownId);
  if (shown) {
    floorsEl.style.zoom = String(fitBox(availW, availH, ...shown.scene.r.size, SINGLE_MAX_ZOOM));
    return;
  }
  const widest = Math.max(0, ...[...floorRecs.values()].map((r) => r.scene.r.size[0]));
  floorsEl.style.zoom = !mini && widest > 0 && !panelEl.offsetWidth ? String(fitBox(availW, Infinity, widest, 0, SINGLE_MAX_ZOOM)) : fitZoom(availW, widest);
}

function showConn(text) {
  connEl.textContent = text;
  connEl.hidden = false;
}

// ---------- scenes (layered rooms) ----------

const scenes = new Map(); // design -> {r: resolved scene, raw, url, nodes: object draw nodes}
let nav = null; // createNav over every scene
let amb = null; // ui.ui.ambient (scaled down under ?debug=ambient)
let catC = null; // ui.ui.cat (scaled down under ?debug=ambient)
let cat = null; // the office cat: {rec, frec, timer, leaveAt, spotId, poke, force}; see "office cat"
let sitSet = new Set(); // sprite keys that have a seated picture
const liveTimers = new Map(); // token -> {win, id, fire, at}: pending timers (the ?debug=ambient counter reads this)
let timerToken = 0;
// While the small window is open its timers are used: a hidden opener tab gets its timers throttled (once a second, later once a minute).
const clockTimers = {
  setTimeout: (fn, ms) => {
    const win = pipWin ?? window;
    const token = ++timerToken;
    const fire = () => {
      liveTimers.delete(token);
      fn();
    };
    liveTimers.set(token, { win, id: win.setTimeout(fire, ms), fire, at: Date.now() + ms });
    return token;
  },
  clearTimeout: (token) => {
    const t = liveTimers.get(token);
    if (!t) return;
    liveTimers.delete(token);
    t.win.clearTimeout(t.id);
  },
};

const sceneOf = (design) => scenes.get(design) ?? null;
const sitUrl = (key) => `/assets/sprites/${encodeURIComponent(key)}-sit.png`;
const same = (a, b) => a[0] === b[0] && a[1] === b[1];

/** Every range of the ambient block times `k`: ?debug=ambient makes the life visible within seconds. */
function scaleAmbient(a, k) {
  const range = (v) => v.map((n) => n * k);
  return {
    ...a,
    tickMinMs: a.tickMinMs * k,
    firstDelayMs: range(a.firstDelayMs),
    fidgetEveryMs: range(a.fidgetEveryMs),
    tripEveryMs: Object.fromEntries(Object.entries(a.tripEveryMs).map(([s, v]) => [s, range(v)])),
    leadTourEveryMs: range(a.leadTourEveryMs),
    stayMs: range(a.stayMs),
  };
}

/** The cat's time ranges times `k`, like scaleAmbient. */
function scaleCat(c, k) {
  const range = (v) => v.map((n) => n * k);
  return { ...c, firstDelayMs: range(c.firstDelayMs), moveEveryMs: range(c.moveEveryMs), pauseMs: range(c.pauseMs), sitMs: range(c.sitMs), sleepMs: range(c.sleepMs), deskMs: range(c.deskMs) };
}

function setupScenes() {
  for (const [design, raw] of Object.entries(ui.scenes ?? {})) {
    const r = resolveScene(raw);
    scenes.set(design, { r, raw, url: raw.url, nodes: objectNodes(r, ui.depth) });
  }
  nav = createNav(new Map([...scenes].map(([design, s]) => [design, s.r])), ui.nav);
  sitSet = new Set(ui.sitSprites ?? []);
  amb = DEBUG_AMBIENT ? scaleAmbient(ui.ui.ambient, 0.1) : ui.ui.ambient;
  catC = DEBUG_AMBIENT ? scaleCat(ui.ui.cat, 0.1) : ui.ui.cat;
  document.documentElement.style.setProperty('--sit-h', `${ui.sitHeight}px`);
  if (DEBUG_AMBIENT) {
    window.__ambient = {
      timers: () => liveTimers.size,
      away: () => [...floorRecs.values()].reduce((n, f) => n + [...f.agents.values()].filter((a) => a.away).length, 0),
      held: () => [...floorRecs.values()].reduce((n, f) => n + [...f.agents.values()].filter((a) => a.press || a.grab).length, 0),
      busy: () => [...floorRecs.values()].reduce((n, f) => n + [...f.agents.values()].filter((a) => a.press || a.grab || a.play || a.say || a.steam || a.mood).length, 0),
      cat: () => (cat ? { sid: cat.frec.sid, x: cat.rec.x, y: cat.rec.y, walking: !!cat.rec.walk, timer: cat.timer, cls: cat.rec.el.className } : null),
      signal: (type, data) => (type === 'phase' ? onPhase : onFail)(data), // the SSE handlers, without the stream
      sky: (s, l) => { seasonQuery = s; lightQuery = l; applyTime(); }, // switches the season and the light like a date or hour change would
      meetings: () => [...floorRecs.values()].filter((f) => f.meeting).length,
      catDo: (act) => { // makes the cat start `act` (sleep, spot, desk, stroll, leave) now
        if (!cat || cat.rec.grab) return;
        if (cat.timer) clockTimers.clearTimeout(cat.timer);
        cat.timer = 0;
        cat.force = act;
        catNext();
      },
    };
  }
}

// ---------- characters ----------

function makeSitSprite(rec, key) {
  const img = document.createElement('img');
  img.className = 'sit';
  img.alt = '';
  img.decoding = 'async';
  img.addEventListener('error', () => {
    // no seated picture after all: this character keeps standing
    img.remove();
    if (rec.sitImg === img) {
      rec.sitImg = null;
      setPose(rec, false, false);
    }
  });
  img.src = sitUrl(key);
  return img;
}

/** Two extra copies of the picture, clipped to the legs (left and right of the split): they swap sides while the character walks. */
function makeLegs(spr, key) {
  const legs = ['l', 'r'].map((side) => {
    const leg = makeSprite(key);
    leg.className = `leg ${side}`;
    spr.append(leg);
    return leg;
  });
  setLegVars(spr, key);
  return legs;
}

function setLegVars(spr, key) {
  const v = legVars(ui.ui.walk, key);
  spr.style.setProperty('--hip', v.hip);
  spr.style.setProperty('--sp', v.sp);
}

function createChar(av, stage, startAt, sc, isCat = false) {
  const root = el('div', 'ag');
  const bubTxt = el('div', 'bub txt empty');
  const bubDot = el('div', 'bub dot empty', '…');
  const body = el('div', 'body');
  const flip = el('div', 'flip');
  const spr = el('div', 'spr');
  const tagRoot = el('div', 'agt'); // name tags and bubbles live in their own layer above every character and object
  const tag = el('div', 'tag');
  tagRoot.append(tag, bubTxt, bubDot);
  const zz = el('div', 'zz', 'zZ');
  const img = makeSprite(av.sprite);
  img.classList.add('stand');
  spr.append(img);
  const legs = isCat ? [] : makeLegs(spr, av.sprite);
  if (isCat) {
    // the cat is five pictures, a class on its root picks the one that shows (style.css "office cat")
    root.classList.add('cat');
    tagRoot.classList.add('cat');
    for (const [cls, key] of [['cw2', 'cat-walk-2'], ['csit', 'cat-sit'], ['cslp', 'cat-sleep'], ['chld', 'cat-held']]) {
      const pic = makeSprite(key);
      pic.className = cls;
      spr.append(pic);
    }
  }
  flip.append(spr);
  body.append(flip);
  root.append(body, zz);
  root.style.zIndex = String(charZ(startAt.y, ui.depth));
  root.style.transform = `translate(${startAt.x}px, ${startAt.y}px)`;
  root.style.setProperty('--fid-ms', `${amb.fidgetMs}ms`);
  tagRoot.style.transform = root.style.transform;
  const rec = {
    el: root, tagRoot, body, bubTxt, bubDot, flip, tag, img, legs, spr, sitImg: null, sprite: av.sprite, x: startAt.x, y: startAt.y, state: '', bubKey: null, arrived: false,
    scene: sc, walk: null, seated: false, seat: null, away: false, trip: null, target: null, targetKey: '', slot: av.slot, isLead: false, frec: null, m: null, rng: null,
  };
  if (sitSet.has(av.sprite)) {
    rec.sitImg = makeSitSprite(rec, av.sprite);
    spr.append(rec.sitImg);
  }
  recOf.set(root, rec);
  bindGrab(rec);
  // A walk is a chain of pieces; only a piece's own end moves it on.
  root.addEventListener('transitionend', (e) => {
    if (e.target !== root || e.propertyName !== 'transform') return;
    if (rec.walk) walkEnded(rec, e);
  });
  const gestureEnd = (e) => {
    if ((e.target === body || e.target === flip) && (e.animationName === 'squash' || e.animationName === 'thump' || e.animationName.startsWith('fid-'))) e.target.classList.remove(e.animationName);
  };
  body.addEventListener('animationend', gestureEnd);
  flip.addEventListener('animationend', gestureEnd);
  stage.append(root, tagRoot);
  return rec;
}

// ---------- walking ----------

const setFacing = (rec, face) => rec.flip.classList.toggle('left', face === 'left');

/** Puts the character at `p` at once (no transition). `commit` forces layout so a walk started next begins from here. */
function placeAt(rec, p, commit = true) {
  rec.x = p[0];
  rec.y = p[1];
  rec.el.style.transitionDuration = rec.tagRoot.style.transitionDuration = '0ms';
  rec.el.style.zIndex = String(charZ(p[1], ui.depth));
  rec.el.style.transform = rec.tagRoot.style.transform = `translate(${p[0]}px, ${p[1]}px)`;
  if (commit) void rec.el.offsetWidth;
}

/** Stops a walk where the character is right now (the one place the live position is read). */
function freeze(rec) {
  if (!rec.walk) return;
  const m = new DOMMatrixReadOnly(rec.el.ownerDocument.defaultView.getComputedStyle(rec.el).transform);
  rec.walk = null;
  rec.el.classList.remove('walking');
  placeAt(rec, [m.m41, m.m42]);
}

function stepWalk(rec) {
  const w = rec.walk;
  const piece = w.pieces[w.i];
  if (!piece) {
    rec.walk = null;
    rec.el.classList.remove('walking');
    w.onArrive?.();
    return;
  }
  const ms = w.ms[w.i++];
  w.cur = ms;
  const dx = piece.to[0] - piece.from[0];
  if (dx < -1) setFacing(rec, 'left');
  else if (dx > 1) setFacing(rec, 'right');
  rec.el.style.zIndex = String(piece.z);
  rec.el.style.transitionDuration = rec.tagRoot.style.transitionDuration = `${ms}ms`;
  rec.el.classList.add('walking');
  rec.el.style.transform = rec.tagRoot.style.transform = `translate(${piece.to[0]}px, ${piece.to[1]}px)`;
}

/** transitionend of a piece. An event whose duration is not the current piece's belongs to a walk that was replaced. */
function walkEnded(rec, e) {
  if (e.type !== 'transitionend' || Math.abs(e.elapsedTime * 1000 - rec.walk.cur) > 25) return;
  stepWalk(rec);
}

/** Walks the polyline `points` as pieces cut at depth lines. Returns the walk's duration in ms (0 when it is under 1px). */
function walkPath(rec, frec, points, onArrive) {
  const pieces = splitWalk(points, frec.scene.nodes, ui.depth);
  const last = points[points.length - 1];
  frec.dbg?.path(rec, points);
  rec.x = last[0];
  rec.y = last[1];
  if (pieces.length === 0 || frec.off) { // a floor that is not shown has no transitions to wait for
    placeAt(rec, last);
    onArrive?.();
    return 0;
  }
  const ms = pieces.map((p) => (Math.hypot(p.to[0] - p.from[0], p.to[1] - p.from[1]) / WALK_PX_PER_SEC) * 1000);
  const total = ms.reduce((a, b) => a + b, 0);
  if (total < WALK_MIN_MS) ms[ms.length - 1] += WALK_MIN_MS - total;
  rec.arrived = false;
  rec.walk = { pieces, ms, i: 0, cur: 0, onArrive };
  stepWalk(rec);
  return Math.max(total, WALK_MIN_MS);
}

/** Stand up or sit down: the picture swaps by class, a short squash covers the change. A character without a seated picture never sits. */
function setPose(rec, seated, animate) {
  const sit = seated && rec.sitImg !== null;
  if (rec.seated === sit) return;
  rec.seated = sit;
  rec.el.classList.toggle('sitting', sit);
  rec.tagRoot.classList.toggle('sitting', sit);
  if (animate) {
    clearGestures(rec);
    void rec.body.offsetWidth;
    rec.body.classList.add('squash');
  }
}

function clearGestures(rec) {
  rec.body.classList.remove('squash', 'thump', 'fid-lean', 'fid-stretch', 'fid-hop');
  rec.flip.classList.remove('fid-look');
}

function arriveAt(rec, target, animate = true) {
  rec.seat = target.seat;
  rec.arrived = true;
  setFacing(rec, target.face);
  setPose(rec, target.seated, animate);
  if (rec.state === 'done') rec.el.classList.add('arrived');
  if (rec.greet) {
    rec.greet = false; // a newcomer says hello once, at its desk
    chatter(rec, line(`greeting${daypart(new Date().getHours())}`), ui.ui.play.greetMs, true);
  }
}

/** Where a character belongs on a scene floor, from its server slot. `seat` is set when it sits at a desk. */
function sceneTarget(av, frec, done) {
  const { r } = frec.scene;
  const s = av.slot;
  if (done) {
    const raw = trayPoint(r, s.i, ui.nav.trayRowPx);
    const p = nav.snap(frec.design, raw) ?? raw;
    return { x: p[0], y: p[1], face: 'right', seated: false, seat: null };
  }
  if (s.kind === 'seat') {
    const canSit = sitSet.has(av.sprite);
    const p = canSit ? s.sit : [s.x, s.y];
    return { x: p[0], y: p[1], face: s.face, seated: canSit, seat: { at: [s.x, s.y], sit: canSit ? s.sit : null, approach: s.approach } };
  }
  const raw = [s.x, s.y];
  const p = nav.snap(frec.design, raw) ?? raw;
  return { x: p[0], y: p[1], face: s.face, seated: false, seat: null };
}

/** The polyline from where the character is to its target: out of a desk (sit, at, approach), a route, into a desk. Null when no route. */
function routeFor(rec, frec, target) {
  const pts = [[rec.x, rec.y]];
  if (rec.seat) {
    if (!same(rec.seat.at, pts[0])) pts.push(rec.seat.at);
    pts.push(rec.seat.approach);
  }
  const goal = target.seat ? target.seat.approach : [target.x, target.y];
  const path = nav.path(frec.design, pts[pts.length - 1], goal);
  if (!path) return null;
  pts.pop();
  pts.push(...path);
  if (target.seat) {
    pts.push(target.seat.at);
    if (target.seat.sit) pts.push(target.seat.sit);
  }
  return pts.filter((p, i) => i === 0 || !same(p, pts[i - 1]));
}

/** No route: fade in at the target instead of walking (a safety net; the validator keeps shipped scenes from needing it). */
function teleport(rec, frec, target) {
  if (!frec.warned) {
    frec.warned = true;
    console.warn(`길을 찾지 못해 바로 옮깁니다: ${frec.design}`);
  }
  frec.dbg?.teleport([target.x, target.y]);
  for (const e of [rec.el, rec.tagRoot]) {
    e.classList.remove('enter-in');
    void e.offsetWidth;
    e.classList.add('enter-in');
  }
  placeAt(rec, [target.x, target.y]);
  arriveAt(rec, target);
}

/** Walks to `target` from wherever the character is, standing up first when it sat. Returns the walk's ms. */
function goTo(rec, frec, target, onArrive) {
  freeze(rec);
  setPose(rec, false, true);
  const pts = routeFor(rec, frec, target);
  rec.seat = null;
  if (!pts) {
    teleport(rec, frec, target);
    onArrive?.();
    return 0;
  }
  return walkPath(rec, frec, pts, () => {
    arriveAt(rec, target);
    onArrive?.();
  });
}

/** A new server target for a scene character: the walk restarts from its current spot along a fresh route. */
function retarget(rec, frec, target) {
  abortTrip(rec);
  rec.target = target;
  goTo(rec, frec, target);
}

/** Puts the character at its target at once and cuts any walk or trip (hidden tab, first draw). */
function settleNow(rec, animate = false) {
  if (rec.play) endPlay(rec.play, rec, false); // nobody walks: everyone is placed at the server's spot
  cancelGrab(rec); // a hidden tab drops whatever is held
  if (!rec.target) return;
  abortTrip(rec);
  rec.walk = null;
  rec.el.classList.remove('walking');
  clearGestures(rec);
  placeAt(rec, [rec.target.x, rec.target.y], false);
  arriveAt(rec, rec.target, animate);
}

// ---------- life: gestures and trips ----------

const whoOf = (frec, rec) => ({ isLead: rec.isLead, state: rec.state, floorStatus: frec.status });

/** Sets the next trip time from the character's state range; no range (a lead off tour, a finished agent) = never until the state changes. */
function scheduleTrip(frec, rec, extra = 0) {
  const range = tripRange(amb, whoOf(frec, rec));
  rec.m.nextTripAt = range ? Date.now() + extra + between(rec.rng, range) : Infinity;
}

function initAmbient(rec, frec, av) {
  rec.rng = rngFor(rec.isLead ? `${frec.sid}:lead` : av.key);
  rec.m = { id: av.key, rec, nextFidgetAt: Date.now() + between(rec.rng, amb.firstDelayMs), nextTripAt: Infinity, returnAt: 0, fresh: true };
}

function freshTimes(frec, rec) {
  const t = Date.now();
  rec.m.nextFidgetAt = t + between(rec.rng, amb.firstDelayMs);
  rec.m.returnAt = 0;
  scheduleTrip(frec, rec, between(rec.rng, amb.firstDelayMs));
}

function playFidget(rec, name) {
  clearGestures(rec);
  // Members woken by the same floor tick start a few hundred ms apart, so a crowd does not move in step.
  const el = name === 'look' ? rec.flip : rec.body;
  el.style.setProperty('--fid-delay', `${Math.round(between(rec.rng, amb.fidgetJitterMs))}ms`);
  el.classList.add(`fid-${name}`);
}

function doFidget(frec, rec) {
  rec.m.nextFidgetAt = Date.now() + between(rec.rng, amb.fidgetEveryMs);
  if (rec.walk || rec.away || rec.grab || rec.play || rec.state === 'done' || rec.el.classList.contains('walking')) return;
  playFidget(rec, chooseFidget(rec.rng, rec.seated, amb));
}

function shuffled(rng, list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Spots already claimed by someone on a trip (still walking there counts). */
function takenSpots(frec, except) {
  const taken = new Map();
  for (const a of frec.agents.values()) {
    const id = a !== except && a.away ? a.trip?.cur?.spotId : undefined;
    if (id) taken.set(id, (taken.get(id) ?? 0) + 1);
  }
  if (cat?.spotId && cat.frec === frec) taken.set(cat.spotId, (taken.get(cat.spotId) ?? 0) + 1); // the cat's own spot
  return taken;
}

/** The stops of one trip: the lead tours seated colleagues' desks (or the whiteboard), everyone else visits one spot. */
function pickLegs(frec, rec) {
  const { r } = frec.scene;
  if (rec.isLead) {
    const desks = [];
    for (const a of frec.agents.values()) {
      const seat = !a.isLead && a.slot?.kind === 'seat' && a.state !== 'done' ? r.seats[a.slot.i] : null; // the lead's own slot is a seat index too (0), not a colleague
      if (seat?.visit) desks.push({ x: seat.visit[0], y: seat.visit[1], face: seat.at[0] < seat.visit[0] ? 'left' : 'right' });
    }
    if (desks.length) return shuffled(rec.rng, desks).slice(0, amb.leadTourDesks);
    const board = r.spots.find((s) => s.kind === 'whiteboard');
    return board ? [{ x: board.at[0], y: board.at[1], face: board.face, spotId: board.id, slot: 'at' }] : null;
  }
  const pick = chooseSpot(rec.rng, r.spots, takenSpots(frec, rec), amb.chatChance);
  if (!pick) return null;
  const { spot, slot } = pick;
  if (slot === 'pair') return [{ x: spot.pair[0], y: spot.pair[1], face: spot.at[0] < spot.pair[0] ? 'left' : 'right', spotId: spot.id, slot }];
  return [{ x: spot.at[0], y: spot.at[1], face: spot.face, spotId: spot.id, slot }];
}

/** Two on one spot turn to face each other. */
function chat(frec, rec, leg) {
  if (!leg.spotId) return;
  const P = ui.ui.play;
  const mate = [...frec.agents.values()].find((a) => a !== rec && a.away && !a.walk && a.trip?.cur?.spotId === leg.spotId);
  if (!mate) {
    if (Math.random() < P.mutterChance) chatter(rec, line('idleMutter'), P.talkMs);
    return;
  }
  setFacing(rec, rec.x < mate.x ? 'right' : 'left');
  setFacing(mate, mate.x < rec.x ? 'right' : 'left');
  chatter(rec, talkLine(), P.talkMs);
  chatter(mate, talkLine(), P.talkMs);
}

function startLeg(frec, rec) {
  const leg = rec.trip.legs[rec.trip.i];
  rec.trip.cur = leg;
  const target = { x: leg.x, y: leg.y, face: leg.face, seated: false, seat: null };
  const walkMs = goTo(rec, frec, target, () => chat(frec, rec, leg));
  rec.m.returnAt = Date.now() + walkMs + between(rec.rng, amb.stayMs);
}

function doTrip(frec, rec) {
  const range = tripRange(amb, whoOf(frec, rec));
  const legs = range && !rec.walk && !rec.away && !rec.grab && !rec.play && rec.arrived && rec.state !== 'done' ? pickLegs(frec, rec) : null;
  if (!legs?.length) return scheduleTrip(frec, rec);
  rec.away = true;
  rec.trip = { legs, i: 0, cur: null };
  startLeg(frec, rec);
}

/** The stay at a stop is over: on to the next stop, or home to the seat. */
function advanceTrip(frec, rec) {
  const tr = rec.trip;
  rec.m.returnAt = 0;
  if (!tr) return;
  if (++tr.i < tr.legs.length) return startLeg(frec, rec);
  rec.trip = null;
  rec.m.nextTripAt = Infinity;
  goTo(rec, frec, rec.target, () => {
    rec.away = false;
    scheduleTrip(frec, rec);
    frec.clock.kick();
  });
}

/** A server move (or a hidden tab) cancels the trip: no trip left, the next one is scheduled. */
function abortTrip(rec) {
  if (!rec.away) return;
  rec.away = false;
  rec.trip = null;
  rec.m.returnAt = 0;
  scheduleTrip(rec.frec, rec);
}

function makeClock(frec) {
  return createFloorClock({
    amb,
    now: Date.now,
    timers: clockTimers,
    members: () => [...frec.agents.values()].filter((r) => r.m && r.state !== 'done' && !r.el.classList.contains('gone')).map((r) => r.m),
    act: { fidget: (m) => doFidget(frec, m.rec), trip: (m) => doTrip(frec, m.rec), tripEnd: (m) => advanceTrip(frec, m.rec) },
    awayCount: () => [...frec.agents.values()].filter((r) => r.away).length,
  });
}

function startAmbient(frec, fresh = false) {
  if (frec.off || document.body.classList.contains('paused')) return;
  if (fresh) for (const r of frec.agents.values()) if (r.m) freshTimes(frec, r);
  frec.clockOn = true;
  frec.clock.start();
}

function stopAmbient(frec) {
  frec.clockOn = false;
  frec.clock.stop();
}

// ---------- grabbing: pick a character up and drop it (screen play only: nothing is sent or saved) ----------

/** Floor-space point under a pointer event. The scale comes from the stage's own box, so the fit zoom and the small window need no special case. */
function floorPoint(rec, cx, cy) {
  const box = rec.frec.stage.getBoundingClientRect();
  const k = box.width / rec.frec.scene.r.size[0];
  return [(cx - box.left) / k, (cy - box.top) / k];
}

/** Pointer handling lives on the character's own element (pointer capture), so it works in whichever window the floor is in. */
function bindGrab(rec) {
  const { body } = rec;
  body.addEventListener('dragstart', (e) => e.preventDefault());
  body.addEventListener('pointerdown', (e) => {
    if (!e.isPrimary || e.button !== 0 || rec.press || rec.grab || rec.state === 'done' || rec.el.classList.contains('gone')) return;
    e.preventDefault();
    body.setPointerCapture(e.pointerId);
    // a press is a click until it moves or is held long enough (shouldLift); the hold timer exists only during the press
    rec.press = { id: e.pointerId, x: e.clientX, y: e.clientY, cx: e.clientX, cy: e.clientY, t: performance.now(), timer: 0 };
    rec.press.timer = clockTimers.setTimeout(() => {
      rec.press.timer = 0;
      liftUp(rec);
    }, ui.ui.grab.holdMs);
  });
  body.addEventListener('pointermove', (e) => {
    const p = rec.press;
    if (p && p.id === e.pointerId) {
      p.cx = e.clientX;
      p.cy = e.clientY;
      if (shouldLift(e.clientX - p.x, e.clientY - p.y, performance.now() - p.t, ui.ui.grab)) liftUp(rec);
    } else if (rec.grab?.phase === 'held' && rec.grab.id === e.pointerId) {
      const at = floorPoint(rec, e.clientX, e.clientY);
      sample(rec, at);
      holdAt(rec, at);
    }
  });
  const end = (e) => {
    if (rec.press?.id === e.pointerId) {
      clearPress(rec); // a plain click is a poke
      if (e.type === 'pointerup') pokeChar(rec);
    } else if (rec.grab?.phase === 'held' && rec.grab.id === e.pointerId) {
      let fling = null;
      if (e.type === 'pointerup') {
        sample(rec, floorPoint(rec, e.clientX, e.clientY));
        fling = throwVelocity(rec.grab.samples, performance.now(), ui.ui.throw);
      }
      dropChar(rec, true, fling);
    }
  };
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) body.addEventListener(type, end);
}

function releaseCapture(rec, id) {
  if (rec.body.hasPointerCapture(id)) rec.body.releasePointerCapture(id);
}

function clearPress(rec) {
  const p = rec.press;
  if (!p) return;
  rec.press = null;
  if (p.timer) clockTimers.clearTimeout(p.timer);
  releaseCapture(rec, p.id);
}

/** Moves a held character: the feet (and the shadow) follow the pointer, kept inside the floor. */
function holdAt(rec, [x, y]) {
  const [w, h] = rec.frec.scene.r.size;
  rec.x = Math.min(Math.max(x, 0), w);
  rec.y = Math.min(Math.max(y, 0), h);
  rec.el.style.transitionDuration = rec.tagRoot.style.transitionDuration = `${HELD_FOLLOW_MS}ms`;
  rec.el.style.zIndex = String(HELD_Z);
  rec.el.style.transform = rec.tagRoot.style.transform = `translate(${rec.x}px, ${rec.y}px)`;
}

/** The bubble text changes with the time held: one timer per held character, one step at a time. */
function armSay(rec) {
  const g = rec.grab;
  const after = ui.ui.grab.bubbleAfterMs;
  if (g.step >= after.length) return;
  g.timer = clockTimers.setTimeout(() => {
    g.timer = 0;
    g.step++;
    setText(g.say, line(rec.isCat ? 'catHeldLong' : 'heldLong'));
    armSay(rec);
  }, after[g.step] - (after[g.step - 1] ?? 0));
}

function liftUp(rec) {
  const p = rec.press;
  if (!p) return;
  if (rec.state === 'done') return clearPress(rec);
  rec.press = null;
  if (p.timer) clockTimers.clearTimeout(p.timer);
  if (rec.play) endPlay(rec.play, rec);
  clearSay(rec);
  clearSteam(rec);
  clearSnack(rec);
  abortTrip(rec);
  freeze(rec); // a walking character stops where it is
  clearGestures(rec);
  setPose(rec, false, false);
  if (rec.isCat) catHold();
  rec.seat = null; // it left its desk: the way back must not start through the desk
  rec.arrived = false;
  const shadow = el('div', 'gshadow');
  const say = el('div', 'bub grab', line(rec.isCat ? 'catLift' : rec.isLead ? 'liftLead' : 'lift'));
  rec.el.prepend(shadow);
  rec.tagRoot.append(say);
  rec.grab = { phase: 'held', id: p.id, step: 0, timer: 0, shadow, say, stars: null, samples: [], anims: null };
  rec.el.classList.add('held');
  rec.tagRoot.classList.add('held');
  const at = floorPoint(rec, p.cx, p.cy);
  sample(rec, at);
  holdAt(rec, at);
  armSay(rec);
}

/** Lets go. A fast release throws; otherwise it lands on the nearest walkable point with a squash-and-bounce, and with `stars` a
 * short dizzy spell follows before the walk back (a worker dropped near the boss or another worker joins a little scene instead). */
function dropChar(rec, stars, fling = null) {
  const g = rec.grab;
  if (g.timer) clockTimers.clearTimeout(g.timer);
  g.timer = 0;
  releaseCapture(rec, g.id);
  if (stars && fling && throwChar(rec, fling)) return;
  const { frec } = rec;
  placeAt(rec, dropPoint(nav.grid(frec.design), [rec.x, rec.y], frec.scene.r.size) ?? [rec.x, rec.y]);
  if (rec.isCat) return landChar(rec, catLanding()); // a cat lands on its feet: no scene, no stars
  const hit = stars ? partnerAt(rec) : null;
  if (hit && hit.kind !== 'bossLine') {
    landChar(rec, null, false);
    return startScene(rec, hit);
  }
  landChar(rec, stars ? { dizzyMs: ui.ui.grab.dizzyMs, text: line(hit ? 'bossDrop' : rec.isLead ? 'grumbleLead' : 'grumble') } : null, !stars);
}

/** The landing: held look off, squash-and-bounce, then the dizzy spell (`dizzy`: its length and line) or, without one, the walk back. */
function landChar(rec, dizzy, walk = false) {
  const g = rec.grab;
  rec.el.classList.remove('held');
  rec.tagRoot.classList.replace('held', 'dizzy');
  g.shadow.remove();
  void rec.body.offsetWidth;
  rec.body.classList.add('thump');
  if (!dizzy) return finishDrop(rec, walk);
  g.phase = 'dizzy';
  setText(g.say, dizzy.text);
  if (!rec.isCat) {
    g.stars = el('div', 'stars');
    for (let k = 0; k < 3; k++) {
      const star = el('i', '', '★');
      star.style.setProperty('--k', String(k));
      g.stars.append(star);
    }
    rec.el.append(g.stars);
  }
  g.timer = clockTimers.setTimeout(() => {
    g.timer = 0;
    finishDrop(rec);
  }, dizzy.dizzyMs);
}

/**
 * A fast release: the character flies along the pointer's direction and bounces off the walls of its floor's walkable area.
 * The path is computed once and played by the browser (element.animate), nothing runs per frame. False when the floor has no walkable cell.
 */
function throwChar(rec, fling) {
  const { frec } = rec;
  const box = openBox(nav.grid(frec.design));
  if (!box) return false;
  const T = ui.ui.throw;
  const g = rec.grab;
  const path = throwPath([rec.x, rec.y], fling, box, T);
  g.phase = 'flying';
  g.flight = path.pts.at(-1);
  setText(g.say, line(rec.isCat ? 'catLift' : 'thrown'));
  const move = path.pts.map((p, i) => ({ offset: path.offsets[i], transform: `translate(${p[0]}px, ${p[1]}px)` }));
  // the body rises on each leg and comes down at the walls (the wall height is lower than the hand)
  const arc = [{ offset: 0, translate: `0 -${LIFT_PX}px`, easing: 'ease-out' }];
  for (let i = 1; i < path.pts.length; i++) {
    const last = i === path.pts.length - 1;
    arc.push({ offset: (path.offsets[i - 1] + path.offsets[i]) / 2, translate: `0 -${LIFT_PX + T.arcPx}px`, easing: 'ease-in' });
    arc.push({ offset: path.offsets[i], translate: `0 -${last ? LIFT_PX : T.wallLiftPx}px`, easing: 'ease-out' });
  }
  const opts = { duration: path.ms, fill: 'forwards' };
  g.anims = [rec.el.animate(move, { ...opts, easing: 'linear' }), rec.tagRoot.animate(move, { ...opts, easing: 'linear' }), rec.body.animate(arc, opts)];
  g.anims[0].onfinish = () => landThrown(rec);
  return true;
}

function cancelFlight(g) {
  if (!g.anims) return;
  for (const a of g.anims) {
    a.onfinish = null;
    a.cancel();
  }
  g.anims = null;
}

/** The flight is over (or cut short): it lands where it ended, on the nearest walkable point, with a longer dizzy spell. */
function landThrown(rec) {
  const g = rec.grab;
  const { frec } = rec;
  placeAt(rec, dropPoint(nav.grid(frec.design), g.flight, frec.scene.r.size) ?? g.flight);
  cancelFlight(g); // after the inline position is set, so the character does not blink back to the start
  g.flight = null;
  landChar(rec, rec.isCat ? catLanding() : { dizzyMs: ui.ui.throw.dizzyMs, text: line('landed') });
}

/** The drop is over: near a free rest spot it rests there for an ambient-style stay, otherwise it walks to where the server wants it. */
function finishDrop(rec, walk = true) {
  const g = rec.grab;
  if (g.timer) clockTimers.clearTimeout(g.timer);
  g.stars?.remove();
  g.say.remove();
  rec.tagRoot.classList.remove('dizzy');
  rec.grab = null;
  if (rec.isCat) return catNext(); // the cat wanders off
  if (!walk) return;
  const { frec } = rec;
  const spot = amb.enabled && rec.state !== 'done' ? restSpotNear(frec.scene.r.spots, takenSpots(frec, rec), [rec.x, rec.y], ui.ui.grab.restRadiusPx) : null;
  if (!spot) return void goTo(rec, frec, rec.target);
  rec.away = true;
  rec.trip = { legs: [{ x: spot.at[0], y: spot.at[1], face: spot.face, spotId: spot.id, slot: 'at' }], i: 0, cur: null };
  startLeg(frec, rec); // sets the stay; the floor clock ends the trip and walks it home
  frec.clock.kick();
}

/** Its agent finished while it was held (or flying, or dizzy): it slips out of the hand and leaves normally. */
function slipOut(rec) {
  if (rec.grab.phase === 'held') dropChar(rec, false);
  else {
    if (rec.grab.phase === 'flying') landThrown(rec);
    finishDrop(rec);
  }
}

/** The small window opened or closed: moving the floors cancels running animations, so flights end where they were going. */
function landFlights() {
  for (const f of floorRecs.values()) for (const a of f.agents.values()) if (a.grab?.phase === 'flying') landThrown(a);
  if (cat?.rec.grab?.phase === 'flying') landThrown(cat.rec);
}

/** Forgets a press, hold, scene or speech at once (floor gone, tab hidden): no animation, no leftover timer, listener state or node. */
function cancelGrab(rec) {
  clearPress(rec);
  if (rec.play) endPlay(rec.play, rec);
  clearSay(rec);
  clearSteam(rec);
  clearMood(rec);
  clearSnack(rec);
  const g = rec.grab;
  if (!g) return;
  if (g.timer) clockTimers.clearTimeout(g.timer);
  cancelFlight(g);
  releaseCapture(rec, g.id);
  g.shadow.remove();
  g.say.remove();
  g.stars?.remove();
  rec.el.classList.remove('held');
  rec.tagRoot.classList.remove('held', 'dizzy');
  rec.grab = null;
}

// ---------- play: poke, report to the boss, high-five, small talk (screen play only: nothing is sent or saved) ----------

const lastLine = new Map(); // situation -> the line said last, so the same line never comes twice in a row

/** A canned line of a situation (config ui.lines), never the one before it; `{task}` is filled with `fill`. */
function line(situation, fill) {
  const text = pickLine(Math.random, ui.ui.lines[situation], lastLine.get(situation));
  lastLine.set(situation, text);
  return fill === undefined ? text : text.replace('{task}', fill).replace('{phase}', fill);
}

const talkLine = () => line(daypart(new Date().getHours()) === 'Night' && Math.random() < ui.ui.play.nightTalkChance ? 'smallTalkNight' : 'smallTalk');

/** A short canned line over a character's head. While it shows it hides the character's own bubble, so keep `ms` short. One per character. */
function sayFor(rec, text, ms, shiftPx = 0) {
  clearSay(rec);
  const b = el('div', 'bub say', text);
  if (shiftPx) b.style.setProperty('--sx', `${shiftPx}px`); // two speakers side by side lean apart so their bubbles do not overlap
  rec.tagRoot.append(b);
  rec.tagRoot.classList.add('talk');
  rec.say = { el: b, timer: clockTimers.setTimeout(() => clearSay(rec), ms) };
}

function clearSay(rec) {
  const s = rec.say;
  if (!s) return;
  rec.say = null;
  clockTimers.clearTimeout(s.timer);
  s.el.remove();
  rec.tagRoot.classList.remove('talk');
}

/** Small talk and greetings: skipped while the character's real bubble is fresh (its task text wins), unless `force`. */
function chatter(rec, text, ms, force = false) {
  if (rec.grab || rec.play || rec.say || rec.state === 'done' || rec.el.classList.contains('gone')) return;
  if (!force && rec.hasBubble && lastNow - rec.since < ui.bubbleShowMs) return;
  sayFor(rec, text, ms);
}

function clearSteam(rec) {
  const s = rec.steam;
  if (!s) return;
  rec.steam = null;
  clockTimers.clearTimeout(s.timer);
  s.el.remove();
}

/** A plain click: the reaction grows with quick repeated clicks (ui.poke), at the top level steam comes off the head. */
function pokeChar(rec) {
  if (rec.isCat) return petCat(rec);
  if (rec.state === 'done' || rec.grab || rec.play || rec.el.classList.contains('gone')) return;
  const P = ui.ui.poke;
  rec.poke = nextPoke(rec.poke ?? null, performance.now(), P);
  const lv = rec.poke.level;
  sayFor(rec, line(`${rec.isLead ? 'pokeLead' : 'poke'}${lv}`), P.sayMs);
  clearGestures(rec);
  rec.body.style.removeProperty('--fid-delay');
  void rec.body.offsetWidth;
  rec.body.classList.add(lv >= P.maxLevel ? 'fid-hop' : 'squash');
  if (lv < P.maxLevel) return;
  clearSteam(rec);
  const steam = el('div', 'steam');
  for (let k = 0; k < 3; k++) {
    const puff = el('i');
    puff.style.setProperty('--k', String(k));
    steam.append(puff);
  }
  rec.tagRoot.append(steam);
  rec.steam = { el: steam, timer: clockTimers.setTimeout(() => clearSteam(rec), P.steamMs) };
}

/** Records the pointer for the throw: the last few floor points with their time (only while held). */
function sample(rec, [x, y]) {
  const s = rec.grab.samples;
  s.push({ t: performance.now(), x, y });
  if (s.length > ui.ui.throw.maxSamples) s.shift();
}

/** Characters that can join a little scene: standing or sitting still, not held, not in another scene, not finished or asleep. */
const playable = (a) => a.arrived && !a.walk && !a.grab && !a.press && !a.play && a.state !== 'done' && a.state !== 'stale' && !a.el.classList.contains('gone');

/** Who the character just dropped at its feet is near (see playPartner), or null. */
function partnerAt(rec) {
  const P = ui.ui.play;
  const others = [...rec.frec.agents.values()].filter((a) => a !== rec && playable(a)).map((a) => ({ id: a, isLead: a.isLead, x: a.x, y: a.y }));
  return playPartner({ id: rec, isLead: rec.isLead }, [rec.x, rec.y], others, { report: P.reportRadiusPx, highFive: P.highFiveRadiusPx });
}

/** Where a visitor stands to face `host`: at its desk's visiting spot when it sits, else beside it on the visitor's side. */
function standPoint(frec, host, from) {
  const { r } = frec.scene;
  if (host.seat) return host.isLead ? host.seat.approach : (r.seats[host.slot.i]?.visit ?? host.seat.approach);
  const side = from.x < host.x ? -1 : 1;
  return dropPoint(nav.grid(frec.design), [host.x + side * ui.nav.arrivalGapPx, host.y], r.size) ?? [host.x, host.y];
}

/** The worker walks up to the other character; `sc` is the scene both belong to while it lasts (rec.play). */
function startScene(guest, hit) {
  const { frec } = guest;
  const host = hit.other.id;
  const sc = { kind: hit.kind, guest, host, timer: 0, spark: null, hostAway: host.away };
  guest.play = host.play = sc;
  abortTrip(host); // a host out on a trip stays where it stands and walks home afterwards
  clearSay(host);
  clearSteam(host);
  const at = standPoint(frec, host, guest);
  goTo(guest, frec, { x: at[0], y: at[1], face: host.x < at[0] ? 'left' : 'right', seated: false, seat: null }, () => sceneAct(sc));
}

const hopOnce = (rec) => {
  clearGestures(rec);
  rec.body.style.removeProperty('--fid-delay');
  void rec.body.offsetWidth;
  rec.body.classList.add('fid-hop');
};

const isStatusText = (t) => ui.ui.play.statusBubbles.includes(t.replace(/[….\s]+$/, ''));

/** The visitor has arrived: the report (what it really does now, then the boss answers) or the high-five. */
function sceneAct(sc) {
  const { guest, host } = sc;
  if (guest.play !== sc) return;
  const P = ui.ui.play;
  const away = host.x < guest.x ? 1 : -1; // the guest's bubble leans away from the host and the host's the other way
  if (sc.kind === 'report' || sc.kind === 'pat') {
    const pat = sc.kind === 'pat'; // the boss comforts the one who failed, who answers
    const task = isStatusText(guest.bubbleText) ? '' : guest.bubbleText; // a status word ("생각 중…") is not a task
    if (pat && !host.seated) setFacing(host, guest.x < host.x ? 'left' : 'right');
    sayFor(guest, pat ? line('patBoss') : task ? line('report', task) : line('reportRest'), P.reportSayMs, away * P.bubbleLeanPx);
    sc.timer = clockTimers.setTimeout(() => {
      if (pat) clearMood(host);
      sayFor(host, line(pat ? 'patReply' : 'bossReply'), P.replyMs, -away * P.bubbleLeanPx);
      sc.timer = clockTimers.setTimeout(() => endPlay(sc, null), P.replyMs + P.endPauseMs);
    }, P.replyDelayMs);
    return;
  }
  if (!host.seated) setFacing(host, guest.x < host.x ? 'left' : 'right');
  hopOnce(guest);
  hopOnce(host);
  sc.spark = el('div', 'spark', '짝!');
  sc.spark.style.left = `${(guest.x + host.x) / 2}px`;
  sc.spark.style.top = `${(guest.y + host.y) / 2}px`;
  guest.frec.stage.append(sc.spark); // its own layer above the name tags (the tag layers stack by character)
  sayFor(guest, line('highFive'), P.highFiveMs, away * P.bubbleLeanPx);
  sayFor(host, line('highFive'), P.highFiveMs, -away * P.bubbleLeanPx);
  sc.timer = clockTimers.setTimeout(() => endPlay(sc, null), P.highFiveMs + P.endPauseMs);
}

/**
 * Ends a scene: bubbles and sparks go, the visitor (and a host that left its trip stop) walk back to where the server wants them.
 * `except` is the one the caller deals with itself (it was picked up, finished, or moved by the server); `home` false walks nobody.
 */
function endPlay(sc, except, home = true) {
  if (sc.kind === 'meeting') return leaveMeeting(sc, except);
  const { guest, host } = sc;
  if (guest.play !== sc) return;
  if (sc.timer) clockTimers.clearTimeout(sc.timer);
  sc.spark?.remove();
  for (const r of [guest, host]) {
    r.play = null;
    clearSay(r);
    r.body.classList.remove('fid-hop');
  }
  if (!home) return;
  if (guest !== except) goTo(guest, guest.frec, guest.target);
  if (host === except) return;
  if (sc.hostAway) goTo(host, host.frec, host.target);
  else if (!host.seated && sc.kind === 'highFive') setFacing(host, host.target.face);
}

// ---------- whiteboard to-dos, workflow meetings, failure faces (screen play only: nothing is sent or saved) ----------

/** The wall board of a floor: a box laid on scene.whiteboard.quad with one shear, showing the session's real to-do list. */
function makeBoard(frec) {
  const quad = frec.scene.raw.whiteboard?.quad;
  if (!quad) return;
  const f = boardFrame(quad);
  const box = el('div', 'wboard empty');
  Object.assign(box.style, { left: `${f.x}px`, top: `${f.y}px`, width: `${f.w}px`, height: `${f.h}px`, transform: `matrix(1, ${f.slope}, 0, 1, 0, 0)` });
  box.tabIndex = 0;
  box.setAttribute('role', 'button');
  const title = el('b');
  const list = el('ul');
  box.append(title, list);
  box.addEventListener('click', () => toggleBig(frec));
  box.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    toggleBig(frec);
  });
  frec.stage.append(box);
  frec.wb = { el: box, title, list, cap: boardCapacity(f.h, BOARD_LINE_PX, BOARD_PAD_PX, BOARD_MIN_ITEMS), key: '', frame: f };
}

/** One line of a to-do list: a mark and the (server-clipped) text; the status is a class. */
function todoLine(item) {
  const li = el('li', item.status);
  li.append(el('span', 'mk', TODO_MARK[item.status] ?? TODO_MARK.pending), el('span', 'tx', item.text));
  return li;
}

/** Redraws the wall board when this floor's list really changed. A floor that is not shown draws it when it comes back (setOff). */
function renderBoard(frec) {
  const wb = frec.wb;
  if (!wb || frec.off) return;
  const key = todoKey(frec.todos);
  if (key === wb.key) return;
  wb.key = key;
  const t = frec.todos;
  wb.el.classList.toggle('empty', t.total === 0);
  setText(wb.title, t.total === 0 ? '' : `할 일 ${t.done}/${t.total}`);
  wb.list.replaceChildren(...itemWindow(t.items, wb.cap).map(todoLine));
  if (bigBoard?.frec === frec) fillBig();
}

let bigBoard = null; // the one enlarged list: {frec, el, title, list, close}

function fillBig() {
  const { frec, title, list } = bigBoard;
  const t = frec.todos;
  setText(title, `할 일 ${t.done}/${t.total}`);
  const rows = t.items.map(todoLine);
  if (t.total > t.items.length) rows.push(el('li', 'more', `…외 ${t.total - t.items.length}개`));
  list.replaceChildren(...rows);
}

function closeBig() {
  if (!bigBoard) return;
  bigBoard.close();
  bigBoard = null;
}

/** The board was clicked: the whole list in a readable size next to it. Closes on Esc, a click elsewhere, or the board again. */
function toggleBig(frec) {
  const again = bigBoard?.frec === frec;
  closeBig();
  if (again || !frec.wb || frec.todos.total === 0) return;
  const doc = frec.stage.ownerDocument;
  const pop = el('div', 'wbig');
  pop.setAttribute('role', 'dialog');
  const title = el('b');
  const list = el('ul');
  pop.append(title, list);
  frec.stage.append(pop);
  const onKey = (e) => e.key === 'Escape' && closeBig();
  const onDown = (e) => {
    if (!pop.contains(e.target) && !frec.wb.el.contains(e.target)) closeBig();
  };
  doc.addEventListener('keydown', onKey);
  doc.addEventListener('pointerdown', onDown, true);
  bigBoard = {
    frec, el: pop, title, list,
    close: () => {
      doc.removeEventListener('keydown', onKey);
      doc.removeEventListener('pointerdown', onDown, true);
      pop.remove();
    },
  };
  fillBig();
  const [W, H] = frec.scene.r.size;
  const f = frec.wb.frame;
  pop.style.width = `${BIG_WIDTH_PX}px`;
  pop.style.left = `${Math.min(Math.max(f.x + f.w / 2 - BIG_WIDTH_PX / 2, BIG_GAP_PX), W - BIG_WIDTH_PX - BIG_GAP_PX)}px`;
  pop.style.top = `${Math.max(BIG_GAP_PX, Math.min(f.y + f.h + f.slope * f.w + BIG_GAP_PX, H - pop.offsetHeight - BIG_GAP_PX))}px`;
}

/** Characters that can be called to a meeting: present (seated or idle), not held, not in a scene, not finished or gone. */
const meetable = (a) => !a.grab && !a.press && !a.play && a.state !== 'done' && a.target && !a.el.classList.contains('gone');

const paused = () => document.body.classList.contains('paused');

/**
 * A workflow went on to its next phase (SSE "phase"): the floor's characters walk to the meeting spots in front of the board, the boss
 * announces the phase, and after ui.meeting.seconds they walk back. Only a floor on show meets; there is no queue for the others.
 */
function onPhase(sig) {
  const frec = floorRecs.get(sig.sessionId);
  const spots = frec?.scene.raw.meeting;
  if (!spots || frec.off || paused() || frec.status === 'leaving') return;
  const M = ui.ui.meeting;
  const mt = frec.meeting;
  const phase = clipPhase(sig.phase, M.phaseMaxChars);
  if (mt) { // a new phase during a meeting: the boss says the new one and the time starts again
    mt.phase = phase;
    if (mt.hold) holdMeeting(mt);
    return;
  }
  const crew = [...frec.agents.values()].filter(meetable);
  const boss = crew.find((a) => a.isLead) ?? null;
  const place = assignSpots(crew.filter((a) => !a.isLead).map((a) => ({ id: a, x: a.x, y: a.y })), spots.spots);
  if (place.size === 0) return;
  if (boss) place.set(boss, spots.boss);
  const next = { kind: 'meeting', frec, members: new Set(), boss, phase, hold: false, timer: 0 };
  frec.meeting = next;
  let walkMs = 0;
  for (const [rec, spot] of place) {
    abortTrip(rec);
    clearSay(rec);
    clearSteam(rec);
    rec.play = next;
    rec.tagRoot.classList.add('talk'); // their own task bubbles step aside so the boss's line is readable
    next.members.add(rec);
    walkMs = Math.max(walkMs, goTo(rec, frec, { x: spot.at[0], y: spot.at[1], face: spot.face, seated: false, seat: null }));
  }
  next.timer = clockTimers.setTimeout(() => holdMeeting(next), walkMs + M.gatherPauseMs);
}

/** Everyone stands in place: the boss says the phase, and the meeting ends ui.meeting.seconds from now. */
function holdMeeting(mt) {
  const ms = ui.ui.meeting.seconds * 1000;
  mt.hold = true;
  clockTimers.clearTimeout(mt.timer);
  if (mt.boss && mt.members.has(mt.boss)) sayFor(mt.boss, line('meetingBoss', mt.phase), ms);
  mt.timer = clockTimers.setTimeout(() => endMeeting(mt), ms);
}

function endMeeting(mt) {
  const crew = [...mt.members];
  mt.members.clear();
  finishMeeting(mt);
  for (const rec of crew) {
    rec.play = null;
    clearSay(rec);
    rec.tagRoot.classList.remove('talk');
    goTo(rec, mt.frec, rec.target);
  }
}

function finishMeeting(mt) {
  clockTimers.clearTimeout(mt.timer);
  if (mt.frec.meeting === mt) mt.frec.meeting = null;
}

/** One character leaves the meeting for its own reasons (picked up, finished, moved by the server, floor hidden); the caller deals with it from there. */
function leaveMeeting(mt, rec) {
  mt.members.delete(rec);
  rec.play = null;
  clearSay(rec);
  rec.tagRoot.classList.remove('talk');
  if (mt.members.size === 0) finishMeeting(mt);
}

function clearMood(rec) {
  const m = rec.mood;
  if (!m) return;
  rec.mood = null;
  clockTimers.clearTimeout(m.timer);
  m.el.remove();
}

/** A sweat drop or rain cloud above the head for ui.fail.seconds; another failure in the meantime starts the time again. */
function showMood(rec, streak) {
  clearMood(rec);
  const kind = moodKind(streak);
  const m = el('div', `mood ${kind}`);
  const frames = kind === 'cloud' ? ['rain-cloud-1', 'rain-cloud-2'] : ['sweat-drop'];
  for (const name of frames) {
    const pic = el('i');
    pic.style.backgroundImage = `url(${FX_URL}${name}.png)`;
    m.append(pic);
  }
  rec.tagRoot.append(m);
  rec.mood = { el: m, timer: clockTimers.setTimeout(() => clearMood(rec), ui.ui.fail.seconds * 1000) };
}

/** A command or test failed (SSE "fail"): the mood shows; from ui.fail.patStreak in a row the boss comes to comfort (not for the boss itself). */
function onFail(sig) {
  const frec = floorRecs.get(sig.sessionId);
  const rec = frec?.agents.get(sig.agent);
  if (!rec || frec.off || paused() || rec.state === 'done' || rec.el.classList.contains('gone')) return;
  showMood(rec, sig.streak);
  const boss = frec.agents.get('lead');
  if (rec.isLead || !boss || !patDue(sig.streak, frec.patAt ?? -Infinity, Date.now(), ui.ui.fail) || !playable(boss) || !playable(rec)) return;
  frec.patAt = Date.now();
  abortTrip(boss);
  startScene(boss, { kind: 'pat', other: { id: rec } });
}

// ---------- seasons, day and night windows, snacks (screen play only: nothing is sent or saved) ----------

let decorItems = []; // assets/seasonal/items.json
let season = 'none'; // halloween | christmas | lunar | none
let light = 'day'; // day | sunset | night
let skyTimer = 0; // clockTimers token: the one timer to the next hour or date boundary

/** The window glass of a floor: one svg of polygons, filled by the stage's data-light (nothing is drawn by day). */
function makeSky(frec) {
  const windows = frec.scene.raw.windows;
  if (!windows?.length) return;
  const [w, h] = frec.scene.r.size;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'sky');
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.setAttribute('width', String(w));
  svg.setAttribute('height', String(h));
  for (const poly of windows) {
    const p = document.createElementNS(SVG_NS, 'polygon');
    p.setAttribute('points', poly.map((pt) => pt.join(',')).join(' '));
    svg.append(p);
  }
  frec.stage.prepend(svg);
}

/** z of a decoration: floor ones by their foot line like a character, desk ones just above the desk they stand on, wall ones under every object. */
function decorZ(frec, anchor) {
  const { zBase } = ui.depth;
  if (anchor.kind === 'wall') return zBase - WALL_Z_BELOW;
  if (anchor.kind === 'floor') return zBase + 2 * Math.round(anchor.at[1]);
  const [ax, ay] = anchor.at;
  const desks = new Set(frec.scene.r.objects.filter((o) => /desk/.test(o.kind)).map((o) => o.id));
  let z = zBase;
  for (const n of frec.scene.nodes) if (desks.has(n.objId) && ax >= n.x && ax <= n.x + n.w && ay >= n.y && ay <= n.y + n.h) z = Math.max(z, n.z + 1);
  return z;
}

/** Brings one floor in step with the season and the light. A floor that is not shown is left as it is and catches up when it is shown. */
function syncDecor(frec) {
  if (frec.off) return;
  setAttr(frec.stage, 'data-light', light);
  if (frec.decorSeason === season) return;
  frec.decorSeason = season;
  frec.decor?.remove();
  frec.decor = null;
  const placed = season === 'none' ? [] : placeSeason(decorItems, frec.scene.raw.seasonal ?? [], season, frec.design);
  if (!placed.length) return;
  const box = el('div', 'decor');
  for (const { anchor, item } of placed) {
    const img = el('img');
    img.src = `/assets/${item.file}`;
    img.alt = '';
    img.draggable = false;
    Object.assign(img.style, {
      left: `${anchor.at[0] - item.anchor[0]}px`, top: `${anchor.at[1] - item.anchor[1]}px`, width: `${item.size[0]}px`, height: `${item.size[1]}px`, zIndex: String(decorZ(frec, anchor)),
    });
    box.append(img);
  }
  frec.stage.append(box);
  frec.decor = box;
}

/** Reads the date and the hour (or the query), updates every shown floor, and sets the one timer for the next change. */
function applyTime() {
  if (skyTimer) clockTimers.clearTimeout(skyTimer);
  skyTimer = 0;
  const now = new Date();
  season = seasonQuery ?? seasonOn(now, ui.ui.season);
  light = lightQuery ?? lightAt(now.getHours(), ui.ui.daylight);
  for (const f of floorRecs.values()) syncDecor(f);
  if (!paused()) skyTimer = clockTimers.setTimeout(applyTime, msToNextChange(now, ui.ui.daylight));
}

// -- snacks: drag one from the top bar onto a character --

const snacksEl = $('snacks');
let snackDrag = null; // {id, kind, ghost}: the one drag in progress

/** In the small window the floors are another window: a drag cannot cross, so the snacks wait with a tooltip. */
function syncSnacks() {
  const off = pipWin !== null;
  for (const b of snacksEl.querySelectorAll('button')) {
    b.dataset.tip ??= b.title;
    setAttr(b, 'aria-disabled', String(off));
    setAttr(b, 'title', off ? SNACK_PIP_TIP : b.dataset.tip);
  }
}

function clearSnack(rec) {
  const s = rec.snack;
  if (!s) return;
  rec.snack = null;
  clockTimers.clearTimeout(s.timer);
  s.hand?.remove();
  s.spark?.remove();
}

/** The shown character under a point, or null. A held, finished or leaving one does not take a snack. */
function snackTargetAt(cx, cy) {
  const rects = [];
  const add = (rec) => {
    if (rec.grab || rec.state === 'done' || rec.el.classList.contains('gone')) return;
    const r = rec.body.getBoundingClientRect();
    if (r.width) rects.push({ id: rec, left: r.left, top: r.top, right: r.right, bottom: r.bottom });
  };
  for (const f of floorRecs.values()) if (!f.off) for (const a of f.agents.values()) add(a);
  if (cat && !cat.frec.off) add(cat.rec);
  return pickAt(rects, cx, cy, ui.ui.snack.dropMarginPx);
}

/** A snack dropped on `rec`: it eats (hands, "냠냠", then sparkles and a cheer), is full, or refuses. Only one of these at a time per character. */
function giveSnack(rec, kind) {
  const S = ui.ui.snack;
  const out = snackOutcome(kind, !!rec.isCat, rec.snackAt, Date.now(), S.cooldownSeconds);
  if (out !== 'eat') return sayFor(rec, line(out === 'full' ? 'snackFull' : rec.isCat ? 'snackNoCat' : 'snackNoFish'), S.refuseMs);
  clearSnack(rec);
  rec.snackAt = Date.now();
  const hand = el('img', 'snackhand');
  hand.src = `${SNACK_URL}${kind}.png`;
  hand.alt = '';
  rec.tagRoot.append(hand);
  sayFor(rec, line('snackEat'), S.eatMs);
  if (rec.isCat) {
    if (rec.walk) freeze(rec);
    if (rec.el.classList.contains('cat-sleep')) setCatPose('sit');
    catAt(S.eatMs + S.sparkleMs + catC.pet.pauseMs, catNext); // it enjoys it first, then goes on with its day
  }
  const s = { hand, spark: null, timer: 0 };
  rec.snack = s;
  s.timer = clockTimers.setTimeout(() => {
    hand.remove();
    s.hand = null;
    s.spark = el('div', 'sparkle');
    SPARKLE_SPOTS.forEach(([x, y], k) => {
      const i = el('i');
      Object.assign(i.style, { left: `${x}px`, top: `${y}px`, backgroundImage: `url(${FX_URL}sparkle-${(k % 2) + 1}.png)` });
      i.style.setProperty('--k', String(k));
      s.spark.append(i);
    });
    rec.tagRoot.append(s.spark);
    sayFor(rec, line(rec.isCat ? 'catSnackDone' : 'snackDone'), S.sparkleMs);
    if (rec.isCat) burstHearts(rec, catC.pet.hearts[2]);
    s.timer = clockTimers.setTimeout(() => clearSnack(rec), S.sparkleMs);
  }, S.eatMs);
}

for (const b of snacksEl.querySelectorAll('button')) {
  const move = (e) => snackDrag.ghost.style.setProperty('transform', `translate(${e.clientX}px, ${e.clientY}px) translate(-50%, -50%)`);
  b.addEventListener('pointerdown', (e) => {
    if (!e.isPrimary || e.button !== 0 || !ui || pipWin || snackDrag) return;
    e.preventDefault();
    b.setPointerCapture(e.pointerId);
    const ghost = el('img', 'snack-ghost');
    ghost.src = `${SNACK_URL}${b.dataset.snack}.png`;
    ghost.alt = '';
    document.body.append(ghost);
    snackDrag = { id: e.pointerId, kind: b.dataset.snack, ghost };
    move(e);
  });
  b.addEventListener('pointermove', (e) => {
    if (snackDrag?.id === e.pointerId) move(e);
  });
  const end = (e) => {
    if (snackDrag?.id !== e.pointerId) return;
    const d = snackDrag;
    snackDrag = null;
    d.ghost.remove();
    if (b.hasPointerCapture(e.pointerId)) b.releasePointerCapture(e.pointerId);
    const rec = e.type === 'pointerup' ? snackTargetAt(e.clientX, e.clientY) : null; // anywhere else: nothing happens
    if (rec) giveSnack(rec, d.kind);
  };
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) b.addEventListener(type, end);
}

// ---------- office cat: one cat for the whole office (screen play only: nothing is sent or saved) ----------

/** The cat's one timer (at most one is pending; a walk is a CSS transition and needs none). */
function catAt(ms, fn) {
  if (cat.timer) clockTimers.clearTimeout(cat.timer);
  cat.timer = clockTimers.setTimeout(() => {
    cat.timer = 0;
    fn();
  }, ms);
}

function catEnter(rec) {
  for (const e of [rec.el, rec.tagRoot]) {
    e.classList.remove('enter-in');
    void e.offsetWidth;
    e.classList.add('enter-in');
    e.addEventListener('animationend', (ev) => ev.target === e && e.classList.remove('enter-in'), { once: true });
  }
}

/** The cat shows up at the door of `frec`, and starts its day a few seconds later. */
function catSpawn(frec) {
  const { door } = frec.scene.r;
  const rec = createChar({ sprite: 'cat-walk-1', slot: null }, frec.stage, { x: door.at[0], y: door.at[1] }, frec.scene, true);
  rec.frec = frec;
  rec.isCat = true;
  rec.state = 'cat';
  setText(rec.tag, catC.name);
  setFacing(rec, door.face);
  cat = { rec, frec, timer: 0, leaveAt: Date.now() + between(Math.random, catC.moveEveryMs), spotId: '', poke: null, force: '' };
  catEnter(rec);
  catAt(between(Math.random, catC.firstDelayMs), catNext);
}

/** The cat is gone (its floor went away, or the last floor did); the next render brings it back on another floor. */
function catRemove() {
  const { rec } = cat;
  if (cat.timer) clockTimers.clearTimeout(cat.timer);
  cancelGrab(rec);
  rec.el.remove();
  rec.tagRoot.remove();
  cat = null;
}

/** Keeps the cat in step with the floors: none without floors, one on some floor, a pending timer unless it is busy. */
function catSync() {
  if (!catC || document.body.classList.contains('paused')) return;
  if (cat && !floorRecs.has(cat.frec.sid)) catRemove();
  if (!floorRecs.size) return;
  const shown = [...floorRecs.values()].filter((f) => !f.off);
  if (!cat) return catSpawn(shown[Math.floor(Math.random() * shown.length)]);
  if (cat.frec.off) { // its floor is not shown: it stops where it is and comes out of another floor's door
    catSettle();
    if (cat.frec.off) catRelocate();
    return;
  }
  const { rec } = cat;
  if (!cat.timer && !rec.walk && !rec.grab && !rec.press) catAt(between(Math.random, catC.firstDelayMs), catNext);
}

/** The hidden tab: the cat stops where it is, nothing of it keeps running. */
function catSettle() {
  if (!cat) return;
  const { rec } = cat;
  if (cat.timer) clockTimers.clearTimeout(cat.timer);
  cat.timer = 0;
  cancelGrab(rec);
  rec.tagRoot.querySelectorAll('.hearts').forEach((h) => h.remove());
  if (rec.walk) {
    rec.walk = null;
    rec.el.classList.remove('walking');
    placeAt(rec, [rec.x, rec.y], false);
  }
  if (rec.el.classList.contains('gone')) catRelocate();
}

function setCatPose(pose) {
  for (const e of [cat.rec.el, cat.rec.tagRoot]) {
    e.classList.toggle('cat-sit', pose === 'sit');
    e.classList.toggle('cat-sleep', pose === 'sleep');
  }
}

/** Picked up: it stops what it was doing. */
function catHold() {
  if (cat.timer) clockTimers.clearTimeout(cat.timer);
  cat.timer = 0;
  cat.spotId = '';
  setCatPose('stand');
}

const catLanding = () => ({ dizzyMs: catC.landMs, text: line('catLanded') });

/** The cat's next act: walk to a spot, a colleague's desk or a random point and stay a while, or leave for another floor. */
function catNext() {
  const { rec, frec } = cat;
  if (rec.grab) return;
  const { r } = frec.scene;
  setCatPose('stand');
  cat.spotId = '';
  const desks = [];
  for (const a of frec.agents.values()) {
    const seat = !a.isLead && a.slot?.kind === 'seat' && a.arrived && !a.walk && (a.state === 'working' || a.state === 'thinking') ? r.seats[a.slot.i] : null;
    if (seat?.visit) desks.push({ x: seat.visit[0], y: seat.visit[1], face: seat.at[0] < seat.visit[0] ? 'left' : 'right', agent: a });
  }
  const grid = nav.grid(frec.design);
  const pick = chooseCatAct(Math.random, {
    cat: catC, spots: r.spots, taken: takenSpots(frec, null), desks, point: () => openPoint(Math.random, grid),
    leaveDue: floorRecs.size > 1 && Date.now() >= cat.leaveAt, force: cat.force,
  });
  cat.force = '';
  if (!pick) return catAt(between(Math.random, catC.pauseMs), catNext);
  if (pick.act === 'leave') {
    const { door } = r;
    goTo(rec, frec, { x: door.at[0], y: door.at[1], face: door.face, seated: false, seat: null }, () => {
      rec.el.classList.add('gone'); // fades out at the door
      rec.tagRoot.hidden = true;
      catAt(400, catRelocate);
    });
    return;
  }
  cat.spotId = pick.spotId ?? '';
  goTo(rec, frec, { x: pick.x, y: pick.y, face: pick.face, seated: false, seat: null }, () => {
    setCatPose(pick.pose);
    if (pick.desk && Math.random() < catC.reactChance) chatter(pick.desk.agent, line('catNear'), catC.reactMs);
    catAt(pick.ms, catNext);
  });
}

/** The cat comes out of the door of another floor (the same floor when there is no other). */
function catRelocate() {
  const { rec } = cat;
  const id = otherFloor(Math.random, [...floorRecs.values()].filter((f) => !f.off).map((f) => f.sid), cat.frec.sid) ?? cat.frec.sid;
  const frec = floorRecs.get(id);
  const { door } = frec.scene.r;
  frec.stage.append(rec.el, rec.tagRoot);
  rec.frec = frec;
  rec.scene = frec.scene;
  cat.frec = frec;
  cat.leaveAt = Date.now() + between(Math.random, catC.moveEveryMs);
  placeAt(rec, door.at);
  setFacing(rec, door.face);
  rec.el.classList.remove('gone');
  rec.tagRoot.hidden = false;
  catEnter(rec);
  if (!document.body.classList.contains('paused')) catAt(between(Math.random, catC.firstDelayMs), catNext);
}

/** `n` hearts float up from the cat; each removes itself when its animation ends. */
function burstHearts(rec, n) {
  const hearts = el('div', 'hearts');
  for (let k = 0; k < n; k++) {
    const h = el('i', '', '♥');
    h.style.setProperty('--k', String(k));
    h.style.setProperty('--hx', String(((k * 7) % 5 - 2) * 7)); // a little spread, the same every time
    hearts.append(h);
  }
  hearts.addEventListener('animationend', (e) => {
    e.target.remove();
    if (!hearts.firstChild) hearts.remove();
  });
  rec.tagRoot.append(hearts);
}

/** A plain click on the cat: hearts and a purr, and a bigger one for each quick click after it (ui.cat.pet). */
function petCat(rec) {
  if (rec.grab) return;
  const P = catC.pet;
  if (rec.walk) freeze(rec);
  cat.poke = nextPoke(cat.poke, performance.now(), P);
  const lv = cat.poke.level;
  if (rec.el.classList.contains('cat-sleep')) setCatPose('sit'); // a sleeper wakes up
  sayFor(rec, line(`catPet${lv}`), P.sayMs);
  burstHearts(rec, P.hearts[lv - 1]);
  clearGestures(rec);
  void rec.body.offsetWidth;
  rec.body.classList.add(lv >= P.maxLevel ? 'fid-hop' : 'squash');
  catAt(P.sayMs + P.pauseMs, catNext); // after a pet it goes on with its day
}

// ---------- character view ----------

function setBubble(rec, bubble, since) {
  const key = `${bubble}|${since}`;
  if (key === rec.bubKey) return;
  rec.bubKey = key;
  const empty = bubble === '';
  rec.since = since;
  rec.hasBubble = !empty;
  rec.bubTxt.classList.toggle('empty', empty);
  rec.bubDot.classList.toggle('empty', empty);
  rec.bubbleText = '';
  if (empty) return;
  const chars = Array.from(bubble);
  const max = ui.ui.bubbleMaxChars;
  const text = chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : bubble;
  rec.bubbleText = text; // the report to the boss says the same words
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
  const sc = frec.scene;
  const isLead = av.key === 'lead';
  let rec = frec.agents.get(av.key);
  const done = av.state === 'done';
  const target = sceneTarget(av, frec, done);
  const key = `${target.x},${target.y},${target.seated}`;

  if (!rec) {
    // The first render of a floor places everyone directly; later newcomers walk in from the entrance.
    const walksIn = frec.populated && !isLead && !done;
    const { door } = sc.r;
    const startAt = walksIn ? { x: door.at[0], y: door.at[1] } : target;
    rec = createChar(av, frec.stage, startAt, sc);
    rec.frec = frec;
    rec.isLead = isLead;
    frec.agents.set(av.key, rec);
    if (frec.populated && !isLead) {
      rec.el.classList.add('enter-in');
      rec.tagRoot.classList.add('enter-in');
      rec.greet = !done;
    }
    initAmbient(rec, frec, av);
    setFacing(rec, walksIn ? door.face : target.face);
    if (!walksIn) {
      rec.target = target;
      rec.targetKey = key;
      settleNow(rec);
    } else void rec.el.offsetWidth; // commit the start point before the walk
  }
  rec.slot = av.slot;

  if (rec.sprite !== av.sprite) {
    rec.sprite = av.sprite;
    rec.img.src = spriteUrl(av.sprite);
    for (const leg of rec.legs) leg.src = rec.img.src;
    setLegVars(rec.spr, av.sprite);
    if (sitSet.has(av.sprite)) {
      if (rec.sitImg) rec.sitImg.src = sitUrl(av.sprite);
      else {
        rec.sitImg = makeSitSprite(rec, av.sprite);
        rec.img.parentElement.append(rec.sitImg);
      }
    } else if (rec.sitImg) {
      rec.sitImg.remove();
      rec.sitImg = null;
      setPose(rec, false, false);
    }
  }
  setText(rec.tag, av.name);
  rec.tag.title = av.role;
  const odd = !isLead && av.slot.i % 2 === 1;
  rec.el.classList.toggle('odd', odd);
  rec.tagRoot.classList.toggle('odd', odd);

  const stateChanged = rec.state !== av.state;
  if (stateChanged) {
    if (rec.state) {
      rec.el.classList.remove(`st-${rec.state}`);
      rec.tagRoot.classList.remove(`st-${rec.state}`);
    }
    rec.state = av.state;
    rec.el.classList.add(`st-${av.state}`);
    rec.tagRoot.classList.add(`st-${av.state}`);
    rec.tagRoot.classList.toggle('done', done); // finished agents stand together on the tray: their tags would pile up
    if (done) clearMood(rec);
  }
  if (done && !frec.populated && lastNow - av.since > DONE_STALE_MS) rec.el.classList.add('gone'); // already reported before this page loaded
  if (rec.m.nextTripAt === Infinity && !rec.away && rec.m.returnAt === 0) {
    scheduleTrip(frec, rec, rec.m.fresh ? between(rec.rng, amb.firstDelayMs) : 0);
    rec.m.fresh = false;
  }

  setBubble(rec, av.bubble, av.since);

  rec.target = target;
  if (rec.play && (done || rec.targetKey !== key)) endPlay(rec.play, rec); // the server moved it: its scene is over
  if (rec.grab) {
    rec.targetKey = key; // held or dizzy: remember the place, apply it after the drop
    if (done) slipOut(rec);
  } else if (rec.targetKey !== key) {
    rec.targetKey = key;
    retarget(rec, frec, target);
  } else if (rec.away && av.state === 'working') {
    retarget(rec, frec, target); // back to work: the server's place wins over the trip
  } else if (done && !rec.walk) {
    rec.arrived = true;
    rec.el.classList.add('arrived');
  }
}

// ---------- floors ----------

/** One object (or one strip of a sliced object): a div that shows its piece of the atlas. */
function objNode(n) {
  const d = el('div', n.flipX ? 'obj flip' : 'obj');
  Object.assign(d.style, {
    left: `${n.x}px`, top: `${n.y}px`, width: `${n.w}px`, height: `${n.h}px`, backgroundPosition: `${-n.bgX}px ${-n.bgY}px`, zIndex: String(n.z),
  });
  return d;
}

/** ?debug=nav: one SVG per floor, drawn once: open/closed cells, outlines, depth lines, every point the scene defines, and each character's last path. */
function buildNavDebug(frec, sc) {
  const { r } = sc;
  const g = nav.grid(frec.design);
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'navdbg');
  svg.setAttribute('viewBox', `0 0 ${r.size[0]} ${r.size[1]}`);
  svg.setAttribute('width', String(r.size[0]));
  svg.setAttribute('height', String(r.size[1]));
  const add = (tag, attrs, text, parent = svg) => {
    const e = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
    if (text !== undefined) e.textContent = text;
    parent.append(e);
    return e;
  };
  const runs = ['', ''];
  for (let row = 0; row < g.rows; row++) {
    for (let c = 0; c < g.cols;) {
      const v = g.open[row * g.cols + c];
      let e = c;
      while (e < g.cols && g.open[row * g.cols + e] === v) e++;
      runs[v] += `M${c * g.cellPx} ${row * g.cellPx}h${(e - c) * g.cellPx}v${g.cellPx}h${-(e - c) * g.cellPx}z`;
      c = e;
    }
  }
  add('path', { d: runs[1], fill: 'rgba(40,180,70,.16)' });
  add('path', { d: runs[0], fill: 'rgba(220,40,40,.22)' });
  const poly = (pts, stroke, dash) => add('polygon', { points: pts.map((p) => p.join(',')).join(' '), fill: 'none', stroke, 'stroke-width': 1.5, 'stroke-dasharray': dash ? '4 3' : 'none' });
  r.walkable.forEach((p) => poly(p, '#1e66d0'));
  r.blocked.forEach((p) => poly(p, '#d02020'));
  r.frontMask.forEach((p) => poly(p, '#c020c0', true));
  r.objects.forEach((o) => o.footprint.length >= 3 && poly(o.footprint, '#e08a00'));
  for (const n of sc.nodes) {
    add('line', { x1: n.x, x2: n.x + n.w, y1: n.depthY, y2: n.depthY, stroke: '#333', 'stroke-width': 0.6 });
    if (n.id === n.objId || n.id.endsWith('#0')) add('text', { x: n.x + 2, y: n.depthY - 2, 'font-size': 7, fill: '#222' }, n.objId);
  }
  const label = (p, text, color = '#111', size = 8) => add('text', { x: p[0] + 4, y: p[1] - 4, 'font-size': size, fill: color }, text);
  const seatMarks = (name, at, sitAt, approach, visit) => {
    add('line', { x1: approach[0], y1: approach[1], x2: at[0], y2: at[1], stroke: '#d02020', 'stroke-width': 1 });
    add('circle', { cx: at[0], cy: at[1], r: 3, fill: '#d02020' }); // ● at
    add('circle', { cx: approach[0], cy: approach[1], r: 4, fill: 'none', stroke: '#d02020', 'stroke-width': 1.5 }); // ○ approach
    if (!same(sitAt, at)) add('polygon', { points: `${sitAt[0]},${sitAt[1] - 4} ${sitAt[0] + 4},${sitAt[1]} ${sitAt[0]},${sitAt[1] + 4} ${sitAt[0] - 4},${sitAt[1]}`, fill: '#2060d0' }); // ◆ sitAt
    if (visit) add('polygon', { points: `${visit[0]},${visit[1] - 4} ${visit[0] + 4},${visit[1] + 3} ${visit[0] - 4},${visit[1] + 3}`, fill: '#8030c0' }); // ▲ visit
    label(at, name);
  };
  r.seats.forEach((s) => seatMarks(String(s.i), s.at, s.sitAt, s.approach, s.visit));
  seatMarks('lead', r.lead.at, r.lead.sitAt, r.lead.approach, null);
  add('circle', { cx: r.door.at[0], cy: r.door.at[1], r: 5, fill: '#008040' });
  label(r.door.at, 'door', '#008040', 10);
  r.tray.queue.forEach((p, i) => label(p, `q${i}`, '#a06000'));
  r.idle.forEach((s, i) => label(s.at, `i${i}`, '#006080'));
  r.overflow.forEach((s, i) => label(s.at, `o${i}`, '#606060'));
  r.spots.forEach((s) => {
    add('rect', { x: s.at[0] - 4, y: s.at[1] - 4, width: 8, height: 8, fill: '#d0a000' });
    label(s.at, s.id, '#806000');
    if (s.pair) {
      add('rect', { x: s.pair[0] - 3, y: s.pair[1] - 3, width: 6, height: 6, fill: 'none', stroke: '#d0a000', 'stroke-width': 1.5 });
      label(s.pair, 'pair', '#806000', 7);
    }
  });
  const trails = add('g', {});
  const lines = new Map();
  return {
    svg,
    path(rec, pts) {
      let e = lines.get(rec);
      if (!e) {
        e = add('polyline', { fill: 'none', stroke: '#e000a0', 'stroke-width': 1.5, opacity: 0.85 }, undefined, trails);
        lines.set(rec, e);
      }
      e.setAttribute('points', pts.map((p) => p.join(',')).join(' '));
    },
    teleport(p) {
      add('circle', { cx: p[0], cy: p[1], r: 10, fill: 'none', stroke: '#f00', 'stroke-width': 3 }, undefined, trails);
    },
  };
}

function createFloor(fv) {
  const sc = sceneOf(fv.design);
  const { r } = sc;
  const root = el('section', 'floor');
  root.dataset.sid = fv.sessionId;
  root.hidden = shownId !== null && fv.sessionId !== shownId; // see "floor switcher"
  root.style.setProperty('--c', colorOf(fv.sessionId));
  root.style.width = `${r.size[0]}px`;
  root.style.height = `${r.size[1]}px`;
  const stage = el('div', 'stage');
  stage.classList.add('scened');
  stage.style.backgroundImage = `url(${sc.url}${encodeURIComponent(r.shell)})`;
  stage.style.setProperty('--atlas', `url(${sc.url}${encodeURIComponent(r.atlas)})`);
  for (const n of sc.nodes) stage.append(objNode(n));
  if (r.front) {
    const front = el('div', 'front');
    front.style.backgroundImage = `url(${sc.url}${encodeURIComponent(r.front)})`;
    front.style.zIndex = String(ui.depth.frontZ);
    stage.append(front);
  }
  const reportsAt = [r.tray.at[0] + r.reports[0], r.tray.at[1] + r.reports[1]];
  stage.style.backgroundSize = `${r.size[0]}px ${r.size[1]}px`;

  const board = el('div', 'board');
  const [bx, by, bw, bh] = r.board;
  Object.assign(board.style, { left: `${bx}px`, top: `${by}px`, width: `${bw}px`, maxHeight: `${bh}px` });
  const bt = el('b');
  const bl = el('p');
  board.append(bt, bl);

  const sign = el('div', 'sign');
  sign.title = '더블클릭하면 이름을 바꿉니다';
  if (r.sign) Object.assign(sign.style, { left: `${r.sign[0]}px`, top: `${r.sign[1]}px`, right: 'auto' });
  const fno = el('span', 'fno');
  const ft = el('span', 'ft');
  const ff = el('span', 'ff');
  const fs = el('span', 'fs');
  const prov = el('span', 'badge');
  sign.append(fno, ft, ff, prov, fs);
  sign.addEventListener('dblclick', () => startRename(fv.sessionId, sign, ft));

  const reports = el('div', 'reports');
  reports.style.left = `${reportsAt[0]}px`;
  reports.style.top = `${reportsAt[1]}px`;
  reports.hidden = true;

  stage.append(board, sign, reports);
  root.append(stage);
  const rec = {
    el: root, stage, bt, bl, fno, ft, ff, fs, prov, reports, agents: new Map(), populated: false,
    sid: fv.sessionId, off: root.hidden, design: fv.design, scene: sc, status: fv.status, dbg: null, clock: null, clockOn: false, warned: false,
  };
  rec.clock = makeClock(rec);
  rec.todos = NO_TODOS;
  makeBoard(rec);
  makeSky(rec);
  syncDecor(rec);
  if (DEBUG_NAV) {
    rec.dbg = buildNavDebug(rec, sc);
    stage.append(rec.dbg.svg);
  }
  floorRecs.set(fv.sessionId, rec);
  return rec;
}

/** Full speech bubbles only for the `max` characters that spoke last; the rest show the small dot, so a crowded floor stays readable. */
function limitBubbles(recs, max) {
  const speaking = [...recs].filter((a) => a.hasBubble && a.state !== 'done' && a.state !== 'stale').sort((a, b) => b.since - a.since);
  speaking.forEach((a, i) => {
    a.el.classList.toggle('quiet', i >= max);
    a.tagRoot?.classList.toggle('quiet', i >= max); // the bubbles sit in the tag layer
  });
}

function renderFloor(fv, elm) {
  const rec = floorRecs.get(fv.sessionId);
  rec.status = fv.status;
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
  rec.todos = fv.todos ?? NO_TODOS;
  renderBoard(rec);
  if (fv.reports > 0) setText(rec.reports, `보고 ${fv.reports}`);

  const { lead } = rec.scene.r;
  const leadView = {
    key: 'lead',
    name: fv.lead.name,
    role: fv.lead.role,
    sprite: fv.lead.sprite,
    slot: { kind: 'seat', i: 0, x: lead.at[0], y: lead.at[1], approach: lead.approach, sit: lead.sitAt, face: lead.face, ring: 0 },
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
      cancelGrab(a);
      a.el.remove();
      a.tagRoot.remove();
      rec.agents.delete(key);
    }
  }
  limitBubbles(rec.agents.values(), ui.ui.bubbleFullMax);
  rec.populated = true;
  if (rec.clockOn) rec.clock.kick();
  else startAmbient(rec);
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
  edit.addEventListener('click', () => startRename(fv.sessionId, nm, title));
  const eye = el('button', 'eye', '숨김');
  eye.type = 'button';
  eye.title = '이 세션 숨기기';
  eye.addEventListener('click', () => {
    if (window.confirm('이 세션을 다시 실행할 때까지 안 보입니다')) setHidden(fv.sessionId, true);
  });
  root.append(el('i', 'dot'), nm, edit, eye);
  const rec = { el: root, nm, title, meta, edit, eye };
  rowRecs.set(fv.sessionId, rec);
  return rec;
}

function renderRow(fv, rec) {
  setText(rec.title, fv.title);
  rec.title.title = fv.autoTitle;
  rec.edit.setAttribute('aria-label', `${fv.title} 이름 바꾸기`);
  rec.eye.setAttribute('aria-label', `${fv.title} 숨기기`);
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
    stopAmbient(f);
    if (bigBoard?.frec === f) closeBig();
    for (const a of f.agents.values()) cancelGrab(a);
    if (cat?.frec === f) catRemove();
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
  fitFloors();
}

/** Puts `elms` into `parent` in this order, touching only the elements that are out of place. */
function syncOrder(parent, elms) {
  elms.forEach((e, i) => {
    if (parent.children[i] !== e) parent.insertBefore(e, parent.children[i] ?? null);
  });
}

function render(state) {
  lastNow = state.now;
  for (const f of state.floors) setColor(f.sessionId, f.colorIndex);
  // Forced hide: a hidden id stays out until a snapshot has lacked it and then has it again (a re-run).
  const present = new Set(state.floors.map((f) => f.sessionId));
  for (const [id, rec] of [...forcedHidden]) {
    if (!present.has(id)) rec.absent = true;
    else if (rec.absent) forcedHidden.delete(id);
  }
  const list = state.floors.filter((f) => !forcedHidden.has(f.sessionId));
  const ids = new Set(list.map((f) => f.sessionId));
  const viewMoved = reconcileView(list);
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
  syncTabs();
  if (viewMoved) applyView();
  else fitFloors();
  catSync();
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

/** Remembers a session's palette index and repaints its log rows when it changed. */
function setColor(sessionId, index) {
  if (index === undefined || sessionColorIdx.get(sessionId) === index) return;
  sessionColorIdx.set(sessionId, index);
  for (const row of logRows.values()) if (row.dataset.sid === sessionId) row.style.setProperty('--c', colorOf(sessionId));
}

const colorAsked = new Set(); // sessions whose colour was already requested from /api/log
/** Log rows of sessions that left before this page loaded have no floor: ask the log page's source once per session. */
async function learnColors(sessionIds) {
  for (const sid of sessionIds) {
    if (sessionColorIdx.has(sid) || colorAsked.has(sid)) continue;
    colorAsked.add(sid);
    try {
      const r = await fetch(`/api/log?session=${encodeURIComponent(sid)}&limit=1`);
      if (r.ok) setColor(sid, (await r.json()).colors?.[sid]);
    } catch {
      // the row keeps its neutral colour
    }
  }
}

/** Entries arrive oldest-first in a batch; the newest row sits on top, rows are kept newest-first by ts. A repeated id updates its row and moves it when its ts changed. */
function appendLog(entries) {
  for (const e of entries) {
    if (forcedHidden.has(e.sessionId)) continue;
    let row = logRows.get(e.id);
    if (!row) {
      row = createLogRow(e);
      logRows.set(e.id, row);
    } else if (Number(row.dataset.ts) !== e.ts) {
      row.remove();
    } else {
      fillLogRow(row, e);
      continue;
    }
    let before = logEl.firstElementChild;
    while (before && Number(before.dataset.ts) > e.ts) before = before.nextElementSibling;
    logEl.insertBefore(row, before);
    fillLogRow(row, e);
  }
  learnColors(new Set(entries.map((e) => e.sessionId)));
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
  es.addEventListener('phase', (ev) => onPhase(JSON.parse(ev.data)));
  es.addEventListener('fail', (ev) => onFail(JSON.parse(ev.data)));
  es.addEventListener('error', () => {
    showConn('연결이 끊겼습니다. 다시 연결하는 중…');
    // The browser retries by itself unless the server refused the stream (then the state is CLOSED).
    if (es.readyState === 2 && !document.body.classList.contains('paused')) retryTimer = setTimeout(connect, RECONNECT_MS);
  });
}

function pause() {
  clearTimeout(retryTimer);
  clearRotate();
  if (skyTimer) clockTimers.clearTimeout(skyTimer);
  skyTimer = 0;
  if (es) es.close();
  document.body.classList.add('paused');
  closeBig();
  // nothing moves while hidden: every walking or away character goes to its server place now
  for (const f of floorRecs.values()) {
    stopAmbient(f);
    for (const a of f.agents.values()) settleNow(a);
  }
  catSettle();
}

async function resume() {
  document.body.classList.remove('paused');
  connEl.hidden = true;
  if (!ui) return init(); // the first /api/ui failed while the tab was in front
  await refreshState();
  if (document.hidden) return; // hidden again while the state was loading: stay paused
  applyTime(); // the date or the hour may have changed while hidden
  for (const f of floorRecs.values()) startAmbient(f, true);
  catSync();
  armRotate();
  connect();
}

// ---------- floor switcher: top bar, single-floor view, rotation, fullscreen, session panel ----------

const tabListEl = $('tab-list');
const allBtn = $('view-all');
const rotateBtn = $('rotate');
const fsBtn = $('fullscreen');
const panelBtn = $('panel-toggle');
const tabRecs = new Map(); // sessionId -> floor button
let viewIds = []; // session ids in floor order, as of the last state
let shownId = null; // the one floor on show, or null for the whole stack
let rotating = false;
let rotateTimer = 0; // clockTimers token: one chain, only while rotating (it follows the small window like the clocks)
let panelOff = false; // the person's own choice; fullscreen hides the panel on top of it

const setAttr = (e, name, value) => {
  if (e.getAttribute(name) !== value) e.setAttribute(name, value);
};

function toast(text) {
  showConn(text);
  setTimeout(() => { connEl.hidden = true; }, RECONNECT_MS);
}

/** Follows the floors in the shown view: a shown floor that ended or was hidden gives way to the next one (none left = the whole stack). True when the shown floor changed. */
function reconcileView(list) {
  const ids = orderFloors(list);
  let moved = false;
  if (shownId !== null) {
    const keep = fallbackFloor(viewIds, shownId, ids);
    moved = keep !== shownId;
    shownId = keep;
    if (keep === null) setRotate(false);
  }
  viewIds = ids;
  return moved;
}

/** One button per floor (kept, not rebuilt), in floor-number order, with the session colour and name. */
function syncTabs() {
  const btns = [];
  const keep = new Set();
  for (const fv of viewIds.map((id) => lastFloors.get(id))) {
    keep.add(fv.sessionId);
    let b = tabRecs.get(fv.sessionId);
    if (!b) {
      b = el('button', 'tab');
      b.type = 'button';
      b.addEventListener('click', () => pickFloor(fv.sessionId));
      tabRecs.set(fv.sessionId, b);
    }
    const label = `${fv.floorNo}층 · ${fv.title}`;
    setText(b, String(fv.floorNo));
    setAttr(b, 'aria-label', label);
    setAttr(b, 'title', label);
    setAttr(b, 'aria-pressed', String(fv.sessionId === shownId));
    if (b.style.getPropertyValue('--c') !== colorOf(fv.sessionId)) b.style.setProperty('--c', colorOf(fv.sessionId));
    btns.push(b);
  }
  for (const [id, b] of [...tabRecs]) {
    if (keep.has(id)) continue;
    b.remove();
    tabRecs.delete(id);
  }
  syncOrder(tabListEl, btns);
}

/** Shows only the shown floor (the others are laid out nowhere and stand still), or the whole stack. */
function applyView() {
  document.body.classList.toggle('single', shownId !== null);
  for (const [id, f] of floorRecs) setOff(f, shownId !== null && id !== shownId);
  for (const [id, b] of tabRecs) setAttr(b, 'aria-pressed', String(id === shownId));
  setAttr(allBtn, 'aria-pressed', String(shownId === null));
  fitFloors();
  catSync();
}

/** A floor that is not shown keeps its state but stops its clock and walks (a walk needs a transition end, which an undisplayed floor never gets). */
function setOff(f, off) {
  if (f.off === off) return;
  f.off = off;
  f.el.hidden = off;
  if (off) {
    if (bigBoard?.frec === f) closeBig();
    stopAmbient(f);
    for (const a of f.agents.values()) settleNow(a);
  } else {
    renderBoard(f);
    syncDecor(f);
    startAmbient(f, true);
  }
}

function pickFloor(id) {
  setRotate(false);
  shownId = shownId === id ? null : id;
  applyView();
}

function showAll() {
  setRotate(false);
  shownId = null;
  applyView();
}

function clearRotate() {
  if (rotateTimer) clockTimers.clearTimeout(rotateTimer);
  rotateTimer = 0;
}

/** (Re)starts the one rotation timer where the clocks are now (this page, or the small window). */
function armRotate() {
  clearRotate();
  if (rotating && !document.body.classList.contains('paused')) rotateTimer = clockTimers.setTimeout(rotateStep, ui.ui.rotate.seconds * 1000);
}

function rotateStep() {
  rotateTimer = 0;
  shownId = nextFloor(viewIds, shownId);
  if (shownId === null) return setRotate(false);
  applyView();
  armRotate();
}

/** Rotation on: the single-floor view from the current floor (or the first), then the next floor every ui.rotate.seconds. */
function setRotate(on) {
  clearRotate();
  rotating = on && (shownId !== null || viewIds.length > 0);
  setAttr(rotateBtn, 'aria-pressed', String(rotating));
  if (!rotating) return;
  shownId ??= viewIds[0];
  applyView();
  armRotate();
}

function applyPanel() {
  document.body.classList.toggle('panel-off', panelOff);
  setText(panelBtn, panelOff ? '세션 창 보이기' : '세션 창 숨기기');
  setAttr(panelBtn, 'aria-expanded', String(!panelOff));
  fitFloors();
}

allBtn.addEventListener('click', showAll);
rotateBtn.addEventListener('click', () => setRotate(!rotating));
panelBtn.addEventListener('click', () => {
  panelOff = !panelOff;
  try {
    localStorage.setItem(PANEL_KEY, panelOff ? '1' : '0');
  } catch {
    // private window or blocked storage: the choice only lasts for this page
  }
  applyPanel();
});
if (document.fullscreenEnabled) {
  fsBtn.addEventListener('click', async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch {
      toast('전체 화면을 열지 못했습니다');
    }
  });
  document.addEventListener('fullscreenchange', () => {
    const on = document.fullscreenElement !== null;
    document.body.classList.toggle('fs', on); // the panel hides while fullscreen and comes back as the person left it
    setText(fsBtn, on ? '전체 화면 끝내기' : '전체 화면');
    panelBtn.disabled = on;
    fitFloors();
  });
} else {
  fsBtn.hidden = true;
}
try {
  panelOff = localStorage.getItem(PANEL_KEY) === '1';
} catch {
  // storage blocked: the panel shows
}
applyPanel();

// ---------- picture-in-picture ----------

/** Moves the live floor stack into a small always-on-top window; the page keeps updating it as before. */
async function openPip() {
  let w;
  try {
    w = await window.documentPictureInPicture.requestWindow({ width: ui.ui.pip.width, height: ui.ui.pip.height });
  } catch {
    showConn('작은 창을 열지 못했습니다');
    setTimeout(() => { connEl.hidden = true; }, RECONNECT_MS);
    return;
  }
  const d = w.document;
  d.title = '에이전트 사무실';
  // a new window has no styles and no base address: copy ours, with absolute addresses
  const base = d.createElement('base');
  base.href = location.href;
  d.head.append(base);
  for (const node of document.querySelectorAll('link[rel="stylesheet"], style')) {
    const copy = d.createElement(node.localName);
    if (node.localName === 'link') Object.assign(copy, { rel: 'stylesheet', href: node.href });
    else copy.textContent = node.textContent;
    d.head.append(copy);
  }
  d.documentElement.style.setProperty('--sit-h', `${ui.sitHeight}px`);
  d.body.classList.add('pip-mini');
  landFlights(); // moving the floors cancels running animations
  closeBig(); // its listeners belong to this page's document
  pipWin = w;
  d.body.append(floorsEl);
  holdEl.hidden = false;
  w.addEventListener('resize', fitFloors);
  w.addEventListener('pagehide', pipClosed);
  syncSnacks();
  for (const f of floorRecs.values()) f.clock.kick(); // move the one clock timer to the small window
  armRotate(); // and the rotation timer
  fitFloors();
}

/** Brings the floors back to this page (the small window closed, or the person asked). Safe to call twice. */
function pipClosed() {
  if (!pipWin) return;
  const gone = pipWin;
  pipWin = null;
  landFlights();
  closeBig();
  for (const t of liveTimers.values()) {
    if (t.win !== gone) continue; // the closed window's timers died with it: they run on this page now
    t.win = window;
    t.id = window.setTimeout(t.fire, Math.max(0, t.at - Date.now()));
  }
  syncSnacks();
  holdEl.before(floorsEl);
  holdEl.hidden = true;
  floorsEl.style.zoom = '';
  if (document.hidden) pause(); // pausing was skipped while the small window showed the office
  else for (const f of floorRecs.values()) f.clock.kick(); // its timer died with the small window
  fitFloors();
}

function togglePip() {
  if (!pipWin) return void openPip();
  const w = pipWin;
  pipClosed();
  w.close();
}

if ('documentPictureInPicture' in window) {
  pipBtn.hidden = false;
  pipBtn.addEventListener('click', togglePip);
  $('pip-back').addEventListener('click', togglePip);
}

document.addEventListener('visibilitychange', () => {
  if (pipWin) return; // the small window keeps the office live while this tab is hidden
  if (document.hidden) pause();
  else resume();
});

$('quit').addEventListener('click', async () => {
  if (!window.confirm('사무실 서버를 끕니다. 계속할까요?')) return;
  await post('/api/shutdown', {});
  pause();
  showConn('서버를 껐습니다. 이 창은 닫아도 됩니다.');
});

window.addEventListener('resize', fitFloors);

async function init() {
  try {
    ui = await (await fetch('/api/ui')).json();
  } catch {
    showConn('서버에 연결하지 못했습니다. 다시 시도하는 중…');
    if (!document.hidden) retryTimer = setTimeout(init, RECONNECT_MS);
    return;
  }
  sessionPalette = ui.ui.sessionPalette;
  try {
    decorItems = await (await fetch(ITEMS_URL)).json();
  } catch {
    decorItems = []; // no pictures list: the rooms stay plain
  }
  setupScenes();
  applyTime();
  connEl.hidden = true;
  if (document.hidden) document.body.classList.add('paused');
  else connect();
}
init();
