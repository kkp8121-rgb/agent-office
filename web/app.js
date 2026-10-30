'use strict';
// Browser view (an ES module). All server strings are inserted with textContent only. No frame loop, no canvas:
// movement is CSS transform transitions, gestures are CSS keyframes (see style.css).
import { resolveScene, trayPoint } from './scene.mjs';
import { createNav } from './nav.mjs';
import { charZ, objectNodes, splitWalk } from './depth.mjs';
import { fitZoom } from './pip.mjs';
import { dropPoint, restSpotNear, shouldLift } from './grab.mjs';
import { daypart, nextPoke, openBox, pickLine, playPartner, throwPath, throwVelocity } from './play.mjs';
import { between, chooseFidget, chooseSpot, createFloorClock, rngFor, tripRange } from './ambient.mjs';

// Visual constants (how things look/move, not planning numbers; those come from /api/ui).
const WALK_PX_PER_SEC = 150;
const WALK_MIN_MS = 350;
const RECONNECT_MS = 3000;
const DONE_STALE_MS = 4000; // a done agent older than this is not walked to the tray again after a reload
const HELD_Z = 7900; // a held character draws above every object and character of its floor (the name tags sit at 8000)
const HELD_FOLLOW_MS = 80; // a held character trails the pointer by this much, which also softens the lift
const LIFT_PX = 28; // the held character's height above its shadow (--lift in style.css)

const DEBUG = new URLSearchParams(location.search).get('debug');
const DEBUG_NAV = DEBUG === 'nav'; // ?debug=nav draws the walking grid and every scene point over each scene floor
const DEBUG_AMBIENT = DEBUG === 'ambient'; // ?debug=ambient makes the office life 10x faster and exposes window.__ambient
const SVG_NS = 'http://www.w3.org/2000/svg';

const $ = (id) => document.getElementById(id);
const appEl = $('app');
const floorsEl = $('floors');
const panelEl = $('panel');
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

/** Scales the floors down (CSS zoom) so the widest one fits beside the panel, or above it in a narrow window. */
function fitFloors() {
  const doc = floorsEl.ownerDocument; // the small window's document while the floors are there
  let avail;
  if (doc.body.classList.contains('pip-mini')) {
    // mini layout: floors only, the whole window width minus the body padding
    const cs = doc.defaultView.getComputedStyle(doc.body);
    avail = doc.documentElement.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  } else {
    const cs = getComputedStyle(appEl);
    const sideBySide = cs.flexDirection === 'row';
    avail = appEl.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
      - (sideBySide ? panelEl.offsetWidth + parseFloat(cs.columnGap) : 0);
  }
  const widest = Math.max(0, ...[...floorRecs.values()].map((r) => r.scene.r.size[0]));
  floorsEl.style.zoom = fitZoom(avail, widest);
}

function showConn(text) {
  connEl.textContent = text;
  connEl.hidden = false;
}

// ---------- scenes (layered rooms) ----------

const scenes = new Map(); // design -> {r: resolved scene, raw, url, nodes: object draw nodes}
let nav = null; // createNav over every scene
let amb = null; // ui.ui.ambient (scaled down under ?debug=ambient)
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

function setupScenes() {
  for (const [design, raw] of Object.entries(ui.scenes ?? {})) {
    const r = resolveScene(raw);
    scenes.set(design, { r, raw, url: raw.url, nodes: objectNodes(r, ui.depth) });
  }
  nav = createNav(new Map([...scenes].map(([design, s]) => [design, s.r])), ui.nav);
  sitSet = new Set(ui.sitSprites ?? []);
  amb = DEBUG_AMBIENT ? scaleAmbient(ui.ui.ambient, 0.1) : ui.ui.ambient;
  document.documentElement.style.setProperty('--sit-h', `${ui.sitHeight}px`);
  if (DEBUG_AMBIENT) {
    window.__ambient = {
      timers: () => liveTimers.size,
      away: () => [...floorRecs.values()].reduce((n, f) => n + [...f.agents.values()].filter((a) => a.away).length, 0),
      held: () => [...floorRecs.values()].reduce((n, f) => n + [...f.agents.values()].filter((a) => a.press || a.grab).length, 0),
      busy: () => [...floorRecs.values()].reduce((n, f) => n + [...f.agents.values()].filter((a) => a.press || a.grab || a.play || a.say || a.steam).length, 0),
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

function createChar(av, stage, startAt, sc) {
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
  flip.append(spr);
  body.append(flip);
  root.append(body, zz);
  root.style.zIndex = String(charZ(startAt.y, ui.depth));
  root.style.transform = `translate(${startAt.x}px, ${startAt.y}px)`;
  root.style.setProperty('--fid-ms', `${amb.fidgetMs}ms`);
  tagRoot.style.transform = root.style.transform;
  const rec = {
    el: root, tagRoot, body, bubTxt, bubDot, flip, tag, img, sitImg: null, sprite: av.sprite, x: startAt.x, y: startAt.y, state: '', bubKey: null, arrived: false,
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
  if (pieces.length === 0) {
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
  if (document.body.classList.contains('paused')) return;
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
    setText(g.say, line('heldLong'));
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
  abortTrip(rec);
  freeze(rec); // a walking character stops where it is
  clearGestures(rec);
  setPose(rec, false, false);
  rec.seat = null; // it left its desk: the way back must not start through the desk
  rec.arrived = false;
  const shadow = el('div', 'gshadow');
  const say = el('div', 'bub grab', line(rec.isLead ? 'liftLead' : 'lift'));
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
  g.stars = el('div', 'stars');
  for (let k = 0; k < 3; k++) {
    const star = el('i', '', '★');
    star.style.setProperty('--k', String(k));
    g.stars.append(star);
  }
  rec.el.append(g.stars);
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
  setText(g.say, line('thrown'));
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
  landChar(rec, { dizzyMs: ui.ui.throw.dizzyMs, text: line('landed') });
}

/** The drop is over: near a free rest spot it rests there for an ambient-style stay, otherwise it walks to where the server wants it. */
function finishDrop(rec, walk = true) {
  const g = rec.grab;
  if (g.timer) clockTimers.clearTimeout(g.timer);
  g.stars?.remove();
  g.say.remove();
  rec.tagRoot.classList.remove('dizzy');
  rec.grab = null;
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
}

/** Forgets a press, hold, scene or speech at once (floor gone, tab hidden): no animation, no leftover timer, listener state or node. */
function cancelGrab(rec) {
  clearPress(rec);
  if (rec.play) endPlay(rec.play, rec);
  clearSay(rec);
  clearSteam(rec);
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
  return fill === undefined ? text : text.replace('{task}', fill);
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

/** The visitor has arrived: the report (what it really does now, then the boss answers) or the high-five. */
function sceneAct(sc) {
  const { guest, host } = sc;
  if (guest.play !== sc) return;
  const P = ui.ui.play;
  const away = host.x < guest.x ? 1 : -1; // the guest's bubble leans away from the host and the host's the other way
  if (sc.kind === 'report') {
    const task = guest.bubbleText;
    sayFor(guest, task ? line('report', task) : line('reportRest'), P.reportSayMs, away * P.bubbleLeanPx);
    sc.timer = clockTimers.setTimeout(() => {
      sayFor(host, line('bossReply'), P.replyMs, -away * P.bubbleLeanPx);
      sc.timer = clockTimers.setTimeout(() => endPlay(sc, null), P.replyMs + P.endPauseMs);
    }, P.replyDelayMs);
    return;
  }
  if (!host.seated) setFacing(host, guest.x < host.x ? 'left' : 'right');
  hopOnce(guest);
  hopOnce(host);
  sc.spark = el('div', 'spark', '짝!');
  sc.spark.style.left = `${(host.x - guest.x) / 2}px`;
  guest.tagRoot.append(sc.spark);
  sayFor(guest, line('highFive'), P.highFiveMs, away * P.bubbleLeanPx);
  sayFor(host, line('highFive'), P.highFiveMs, -away * P.bubbleLeanPx);
  sc.timer = clockTimers.setTimeout(() => endPlay(sc, null), P.highFiveMs + P.endPauseMs);
}

/**
 * Ends a scene: bubbles and sparks go, the visitor (and a host that left its trip stop) walk back to where the server wants them.
 * `except` is the one the caller deals with itself (it was picked up, finished, or moved by the server); `home` false walks nobody.
 */
function endPlay(sc, except, home = true) {
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
    sid: fv.sessionId, design: fv.design, scene: sc, status: fv.status, dbg: null, clock: null, clockOn: false, warned: false,
  };
  rec.clock = makeClock(rec);
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
    for (const a of f.agents.values()) cancelGrab(a);
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
  fitFloors();
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
  // nothing moves while hidden: every walking or away character goes to its server place now
  for (const f of floorRecs.values()) {
    stopAmbient(f);
    for (const a of f.agents.values()) settleNow(a);
  }
}

async function resume() {
  document.body.classList.remove('paused');
  connEl.hidden = true;
  if (!ui) return init(); // the first /api/ui failed while the tab was in front
  await refreshState();
  if (document.hidden) return; // hidden again while the state was loading: stay paused
  for (const f of floorRecs.values()) startAmbient(f, true);
  connect();
}

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
  pipWin = w;
  d.body.append(floorsEl);
  holdEl.hidden = false;
  w.addEventListener('resize', fitFloors);
  w.addEventListener('pagehide', pipClosed);
  for (const f of floorRecs.values()) f.clock.kick(); // move the one clock timer to the small window
  fitFloors();
}

/** Brings the floors back to this page (the small window closed, or the person asked). Safe to call twice. */
function pipClosed() {
  if (!pipWin) return;
  const gone = pipWin;
  pipWin = null;
  landFlights();
  for (const t of liveTimers.values()) {
    if (t.win !== gone) continue; // the closed window's timers died with it: they run on this page now
    t.win = window;
    t.id = window.setTimeout(t.fire, Math.max(0, t.at - Date.now()));
  }
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
  setupScenes();
  connEl.hidden = true;
  if (document.hidden) document.body.classList.add('paused');
  else connect();
}
init();
