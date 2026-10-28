'use strict';
// Browser view (an ES module). All server strings are inserted with textContent only. No frame loop, no canvas:
// movement is CSS transform transitions, gestures are CSS keyframes (see style.css).
import { resolveScene, trayPoint } from './scene.mjs';
import { createNav } from './nav.mjs';
import { charZ, objectNodes, splitWalk } from './depth.mjs';
import { between, chooseFidget, chooseSpot, createFloorClock, rngFor, tripRange } from './ambient.mjs';

// Visual constants (how things look/move, not planning numbers; those come from /api/ui).
const WALK_PX_PER_SEC = 150;
const WALK_MIN_MS = 350;
const RECONNECT_MS = 3000;
const DONE_STALE_MS = 4000; // a done agent older than this is not walked to the tray again after a reload

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

/** Scales the floors down (CSS zoom) so the widest one fits beside the panel, or above it in a narrow window. */
function fitFloors() {
  const cs = getComputedStyle(appEl);
  const sideBySide = cs.flexDirection === 'row';
  const avail = appEl.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)
    - (sideBySide ? panelEl.offsetWidth + parseFloat(cs.columnGap) : 0);
  const widest = Math.max(0, ...[...floorRecs.values()].map((r) => r.layout.size[0]));
  floorsEl.style.zoom = widest > avail ? String(Math.max(avail, 0) / widest) : '';
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
const liveTimers = new Set(); // pending floor-clock timers (the ?debug=ambient counter reads this)
const clockTimers = {
  setTimeout: (fn, ms) => {
    const id = window.setTimeout(() => {
      liveTimers.delete(id);
      fn();
    }, ms);
    liveTimers.add(id);
    return id;
  },
  clearTimeout: (id) => {
    liveTimers.delete(id);
    window.clearTimeout(id);
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
  root.style.zIndex = String(sc ? charZ(startAt.y, ui.depth) : Math.round(startAt.y));
  root.style.transform = `translate(${startAt.x}px, ${startAt.y}px)`;
  root.style.setProperty('--fid-ms', `${amb.fidgetMs}ms`);
  tagRoot.style.transform = root.style.transform;
  const rec = {
    el: root, tagRoot, body, bubTxt, bubDot, flip, tag, img, sitImg: null, sprite: av.sprite, x: startAt.x, y: startAt.y, state: '', bubKey: null, arrived: false,
    scene: sc, walk: null, seated: false, seat: null, away: false, trip: null, target: null, targetKey: '', slot: av.slot, isLead: false, frec: null, m: null, rng: null,
  };
  if (sc && sitSet.has(av.sprite)) {
    rec.sitImg = makeSitSprite(rec, av.sprite);
    spr.append(rec.sitImg);
  }
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
  // old layouts: one straight transition per walk. Scenes: a chain of pieces; only a piece's own end moves it on.
  root.addEventListener('transitionend', (e) => {
    if (e.target !== root || e.propertyName !== 'transform') return;
    if (rec.walk) walkEnded(rec, e);
    else if (!rec.scene) settle(e);
  });
  root.addEventListener('transitioncancel', (e) => {
    if (!rec.walk && !rec.scene) settle(e);
  });
  const gestureEnd = (e) => {
    if ((e.target === body || e.target === flip) && (e.animationName === 'squash' || e.animationName.startsWith('fid-'))) e.target.classList.remove(e.animationName);
  };
  body.addEventListener('animationend', gestureEnd);
  flip.addEventListener('animationend', gestureEnd);
  stage.append(root, tagRoot);
  return rec;
}

/** Moves a character in a straight line; the duration follows the distance. */
function walkTo(elm, x, y) {
  const rec = recOf.get(elm);
  const { tagRoot } = rec;
  const dx = x - rec.x;
  const dy = y - rec.y;
  const dist = Math.hypot(dx, dy);
  rec.x = x;
  rec.y = y;
  elm.style.zIndex = String(Math.round(y));
  if (dist < 1) return;
  rec.arrived = false;
  elm.style.transitionDuration = tagRoot.style.transitionDuration = `${Math.max(WALK_MIN_MS, (dist / WALK_PX_PER_SEC) * 1000)}ms`;
  rec.flip.classList.toggle('left', dx < 0);
  elm.classList.add('walking');
  elm.style.transform = tagRoot.style.transform = `translate(${x}px, ${y}px)`;
}

// ---------- scene walking ----------

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
  const m = new DOMMatrixReadOnly(getComputedStyle(rec.el).transform);
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
  rec.body.classList.remove('squash', 'fid-lean', 'fid-stretch', 'fid-hop');
  rec.flip.classList.remove('fid-look');
}

function arriveAt(rec, target, animate = true) {
  rec.seat = target.seat;
  rec.arrived = true;
  setFacing(rec, target.face);
  setPose(rec, target.seated, animate);
  if (rec.state === 'done') rec.el.classList.add('arrived');
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
  if (!rec.target) return;
  abortTrip(rec);
  rec.walk = null;
  rec.el.classList.remove('walking');
  clearGestures(rec);
  placeAt(rec, [rec.target.x, rec.target.y], false);
  arriveAt(rec, rec.target, animate);
}

// ---------- life: gestures and trips (scenes only for trips) ----------

const whoOf = (frec, rec) => ({ isLead: rec.isLead, state: rec.state, floorStatus: frec.status });

/** Sets the next trip time from the character's state range; no range (a lead off tour, a finished agent) = never until the state changes. */
function scheduleTrip(frec, rec, extra = 0) {
  const range = frec.scene ? tripRange(amb, whoOf(frec, rec)) : null;
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
  (name === 'look' ? rec.flip : rec.body).classList.add(`fid-${name}`);
}

function doFidget(frec, rec) {
  rec.m.nextFidgetAt = Date.now() + between(rec.rng, amb.fidgetEveryMs);
  if (rec.walk || rec.away || rec.state === 'done' || rec.el.classList.contains('walking')) return;
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
  const mate = [...frec.agents.values()].find((a) => a !== rec && a.away && !a.walk && a.trip?.cur?.spotId === leg.spotId);
  if (!mate) return;
  setFacing(rec, rec.x < mate.x ? 'right' : 'left');
  setFacing(mate, mate.x < rec.x ? 'right' : 'left');
}

function startLeg(frec, rec) {
  const leg = rec.trip.legs[rec.trip.i];
  rec.trip.cur = leg;
  const target = { x: leg.x, y: leg.y, face: leg.face, seated: false, seat: null };
  const walkMs = goTo(rec, frec, target, () => chat(frec, rec, leg));
  rec.m.returnAt = Date.now() + walkMs + between(rec.rng, amb.stayMs);
}

function doTrip(frec, rec) {
  const range = frec.scene ? tripRange(amb, whoOf(frec, rec)) : null;
  const legs = range && !rec.walk && !rec.away && rec.arrived && rec.state !== 'done' ? pickLegs(frec, rec) : null;
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
  const sc = frec.scene;
  const layout = frec.layout;
  const isLead = av.key === 'lead';
  let rec = frec.agents.get(av.key);
  const done = av.state === 'done';
  // Finished agents line up at the tray. Old layouts: leftwards from it, the lead to its right, every other row shifted half a step.
  let target;
  let key;
  if (sc) {
    target = sceneTarget(av, frec, done);
    key = `${target.x},${target.y},${target.seated}`;
  } else {
    target = done ? trayPos(av.slot.i, layout.tray, ui.ui.traySpreadPx, ui.ui.trayRowPx) : { x: av.slot.x, y: av.slot.y };
  }

  if (!rec) {
    // The first render of a floor places everyone directly; later newcomers walk in from the entrance.
    const walksIn = frec.populated && !isLead && !done;
    const door = sc ? sc.r.door : null;
    const entrance = sc ? door.at : layout.entrance;
    const startAt = walksIn ? { x: entrance[0], y: entrance[1] } : target;
    rec = createChar(av, frec.stage, startAt, sc);
    rec.frec = frec;
    rec.isLead = isLead;
    frec.agents.set(av.key, rec);
    if (frec.populated && !isLead) {
      rec.el.classList.add('enter-in');
      rec.tagRoot.classList.add('enter-in');
    }
    initAmbient(rec, frec, av);
    if (sc) {
      setFacing(rec, walksIn ? door.face : target.face);
      if (!walksIn) {
        rec.target = target;
        rec.targetKey = key;
        settleNow(rec);
      } else void rec.el.offsetWidth; // commit the start point before the walk
    } else if (walksIn) void rec.el.offsetWidth;
  }
  rec.slot = av.slot;

  if (rec.sprite !== av.sprite) {
    rec.sprite = av.sprite;
    rec.img.src = spriteUrl(av.sprite);
    if (sc && sitSet.has(av.sprite)) {
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
  if (sc && rec.m.nextTripAt === Infinity && !rec.away && rec.m.returnAt === 0) {
    scheduleTrip(frec, rec, rec.m.fresh ? between(rec.rng, amb.firstDelayMs) : 0);
    rec.m.fresh = false;
  }

  setBubble(rec, av.bubble, av.since);

  if (sc) {
    rec.target = target;
    if (rec.targetKey !== key) {
      rec.targetKey = key;
      retarget(rec, frec, target);
    } else if (rec.away && av.state === 'working') {
      retarget(rec, frec, target); // back to work: the server's place wins over the trip
    } else if (done && !rec.walk) {
      rec.arrived = true;
      rec.el.classList.add('arrived');
    }
    return;
  }
  if (rec.x !== target.x || rec.y !== target.y) {
    walkTo(rec.el, target.x, target.y);
  } else if (done && !rec.el.classList.contains('walking')) {
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
  const layout = sc ? { size: sc.r.size } : layoutOf(fv.design);
  const root = el('section', 'floor');
  root.dataset.sid = fv.sessionId;
  root.style.setProperty('--c', colorOf(fv.sessionId));
  root.style.width = `${layout.size[0]}px`;
  root.style.height = `${layout.size[1]}px`;
  const stage = el('div', 'stage');
  let boardBox;
  let reportsAt;
  let signAt = null;
  if (sc) {
    const { r } = sc;
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
    boardBox = r.board;
    reportsAt = [r.tray.at[0] + r.reports[0], r.tray.at[1] + r.reports[1]];
    signAt = r.sign;
  } else {
    stage.style.backgroundImage = `url(/assets/floors/${encodeURIComponent(layout.image)})`;
    boardBox = layout.board;
    reportsAt = [layout.tray[0] + 30, layout.tray[1] - 22];
  }
  stage.style.backgroundSize = `${layout.size[0]}px ${layout.size[1]}px`;

  const board = el('div', 'board');
  const [bx, by, bw, bh] = boardBox;
  Object.assign(board.style, { left: `${bx}px`, top: `${by}px`, width: `${bw}px`, maxHeight: `${bh}px` });
  const bt = el('b');
  const bl = el('p');
  board.append(bt, bl);

  const sign = el('div', 'sign');
  sign.title = '더블클릭하면 이름을 바꿉니다';
  if (signAt) Object.assign(sign.style, { left: `${signAt[0]}px`, top: `${signAt[1]}px`, right: 'auto' });
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
    el: root, stage, layout, bt, bl, fno, ft, ff, fs, prov, reports, agents: new Map(), populated: false,
    sid: fv.sessionId, design: fv.design, scene: sc, status: fv.status, dbg: null, clock: null, clockOn: false, warned: false,
  };
  rec.clock = makeClock(rec);
  if (sc && DEBUG_NAV) {
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

  const lead = rec.scene?.r.lead;
  const leadView = {
    key: 'lead',
    name: fv.lead.name,
    role: fv.lead.role,
    sprite: fv.lead.sprite,
    slot: lead
      ? { kind: 'seat', i: 0, x: lead.at[0], y: lead.at[1], approach: lead.approach, sit: lead.sitAt, face: lead.face, ring: 0 }
      : { x: rec.layout.lead[0], y: rec.layout.lead[1], i: 0 },
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
