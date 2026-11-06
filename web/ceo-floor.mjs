// Effects area "ceo" (package O): the boss room and what the boss and the leads do in the building. Classes: ceo-*, looks in web/ceo.css, rules in web/ceo-view.mjs.
//   always (information): the chalkboard on the boss room's wall (labour cost, redrawn only when a cost frame arrives), the 「사장실에 보고하러 감」 / 「옥상에서 쉬는 중」 sign on a
//     floor whose lead is away, the 「대기 n」 sign at the boss room's door, the 「n층 회의 중」 sign at the boss's desk, the bell on every floor.
//   a floor calls (call null -> value): its lead takes the lift up and stands at a visit spot with the paper (more than ui.ceo's visit spots: the rest wait).
//   a floor is on its lunch break (rest): its lead takes the lift up to a roof bench (at most ui.building.roofSpots) and lies there until the break is over.
//   the bell of a floor is pressed: the boss comes down by lift and chairs the bell meeting (one boss: a second bell meeting at the same time is chaired by its lead).
// Only in the building view do leads leave their floors; in the single-floor view they stay at their desks. With the effects off or reduced motion nobody walks and the lift does not run:
// the visitors are placed at once, the signs stay. A still or hidden boss room has no visitor records at all; they stand there again when it wakes.
import { quadFrame } from './board.mjs';
import { ringDecision, planBell } from './bellmeeting.mjs';
import { between, chooseFidget, chooseSpot, createFloorClock, rngFor } from './ambient.mjs';
import { CEO_ID, LOBBY_ID } from './view.mjs';
import {
  assignRoof, bellChair, bellTimeline, boardLines, callers, createBossLock, createVisitBoard, fill, linesKey, nearestSpot, presence, resters,
} from './ceo-view.mjs';

const PROPS = '/assets/props/';
const ROOF_SID = 'roof';

/** @param {import('./fx.mjs').FxCtx} ctx */
export function init(ctx) {
  const C = ctx.ui.ceo;
  if (!C) return;
  const { fx, timers } = ctx;
  const doc = globalThis.document;
  const reduced = () => globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const moves = () => fx.fxOn() && !reduced();
  const mk = (tag, cls, text) => {
    const e = doc.createElement(tag);
    e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const prop = (name, cls) => {
    const img = mk('img', cls);
    img.src = `${PROPS}${name}.png`;
    img.alt = '';
    img.draggable = false;
    return img;
  };
  const ceoF = () => ctx.floor(CEO_ID);
  const ceoActive = () => {
    const f = ceoF();
    return Boolean(f) && ctx.floorActive(f);
  };
  const buildingOn = () => ctx.building.active();
  const sessionFloors = () => [...ctx.floors()].filter((f) => f.sid !== CEO_ID && f.sid !== LOBBY_ID);
  const leadOf = (sid) => ctx.floor(sid)?.agents.get('lead') ?? null;
  const setHidden = (rec, on) => {
    rec.el.classList.toggle('gone', on);
    rec.tagRoot.classList.toggle('cm-gone', on);
  };

  const lock = createBossLock();
  let board = null; // the visit board of the boss room (made when its scene is there)
  let visits = []; // scene `visits`
  let roofAssigned = new Map(); // sid -> roof bench
  let lastCalls = null; // the sids that called in the last frame (null before the first frame: nothing walks for what was already there)
  let lastFrame = null; // the latest cost frame
  let figBroken = false; // the boss's picture is missing: no boss
  let fig = null; // the boss in his room (a visitor record of the boss room)
  let figLeaving = false; // the boss is walking to the door to go down: still seen until he is there
  let ceoMark = null; // 「n층 회의 중」 at the boss's desk
  let queueMark = null; // 「대기 n」 at the door of the boss room
  let boardEl = null;
  let boardKey = '';
  let boardRows = [];
  let roof = null; // {frec, stage, spots: []}
  const visitors = new Map(); // sid -> the visitor record of a calling floor's lead in the boss room
  const roofRecs = new Map(); // sid -> the lead on the roof
  const aways = new Map(); // sid -> {reason: 'visit'|'roof', mark}
  const tripFlows = new Map(); // sid -> a lead going up or coming down (visit)
  const roofFlows = new Map(); // sid -> a lead going to or coming from the roof
  const bellFlows = new Map(); // sid -> a bell meeting (with the boss' way there and back)
  const lastRing = new Map(); // sid -> when the bell was pressed
  const bells = new Map(); // floor record -> {btn, img, sign, signTimer, design}

  // ---------- one run of timed steps (every timer is the office's, with the floor id; stopping it drops them all) ----------

  function makeFlow(floorId) {
    const flow = { dead: false, ids: new Set(), cleanups: [], aside: false, chair: null };
    flow.at = (ms, fn) => {
      const t = timers.setTimeout(() => {
        flow.ids.delete(t);
        if (!flow.dead) fn();
      }, ms, floorId);
      flow.ids.add(t);
    };
    flow.clearTimers = () => {
      for (const t of flow.ids) timers.clearTimeout(t);
      flow.ids.clear();
    };
    flow.stop = () => {
      flow.dead = true;
      flow.clearTimers();
      for (const fn of flow.cleanups.splice(0)) fn();
    };
    /** A promise that never settles once the flow is stopped. */
    flow.wait = (promise) => new Promise((res) => promise.then((v) => { if (!flow.dead) res(v); }));
    flow.later = (ms) => new Promise((res) => flow.at(ms, res));
    return flow;
  }

  /** Walks `rec` to `target`; {ms, done}: done settles when it arrived (or when its walk should have, a replaced walk never calls back). */
  function walk(flow, rec, frec, target) {
    let end = () => {};
    const done = new Promise((res) => {
      let over = false;
      end = () => {
        if (over) return;
        over = true;
        if (!flow.dead) res();
      };
    });
    const ms = ctx.goTo(rec, frec, target, () => end());
    flow.at(ms + ctx.ui.commute.doorOpenMs, () => end());
    return { ms, done };
  }

  const standAt = (at, face) => ({ x: at[0], y: at[1], face, seated: false, seat: null });
  const doorTarget = (frec) => standAt(frec.scene.r.door.at, frec.scene.r.door.face);
  /** Where the lift opens on a floor of the building view (else the floor's door). */
  const entryOf = (id) => (buildingOn() ? ctx.building.entryOf(id) : null) ?? ctx.floor(id).scene.r.door.at;

  // ---------- the boss ----------

  const deskTarget = () => {
    const l = ceoF().scene.raw.lead;
    return { x: l.sitAt[0], y: l.sitAt[1], face: l.face, seated: true, seat: { at: l.at, sit: l.sitAt, approach: l.approach, legs: 0 } };
  };

  function seatFig() {
    const t = deskTarget();
    fig.target = t;
    ctx.freeze(fig);
    ctx.placeAt(fig, [t.x, t.y]);
    ctx.arriveAt(fig, t, false);
  }

  function dropFig() {
    if (!fig) return;
    clock.stop();
    ctx.room.removeVisitor(fig);
    fig = null;
  }

  function ensureFig() {
    const f = ceoF();
    if (!f || !ceoActive() || figBroken || !f.scene.raw.lead) return dropFig();
    if (!fig) {
      fig = ctx.room.createVisitor(f, { sprite: C.sprite, name: C.name, role: C.role });
      for (const n of [fig.el, fig.tagRoot]) n.classList.add('ceo-boss');
      fig.img.addEventListener('error', () => { // no picture (ceo.png): there is no boss
        figBroken = true;
        dropFig();
        paintMarks();
      });
      seatFig();
    }
    setHidden(fig, lock.holder() !== null && !figLeaving);
    startLife();
  }

  /** The boss walks out of his room (hidden, the sign says where he is) or comes back to his desk (placed, or walking from the door). */
  function paintMarks() {
    const f = ceoF();
    if (!f) return;
    const holder = lock.holder();
    if (holder !== null && !figLeaving && ceoActive() && !figBroken) {
      const l = f.scene.raw.lead;
      ceoMark ??= mk('div', 'ceo-mark ceo-mark-desk');
      ceoMark.style.left = `${l.sitAt[0]}px`;
      ceoMark.style.top = `${l.sitAt[1]}px`;
      const text = fill(C.meetingAway, { n: ctx.view(holder)?.floorNo ?? '' });
      if (ceoMark.textContent !== text) ceoMark.textContent = text;
      if (!ceoMark.isConnected) (f.layer ?? f.stage).append(ceoMark);
    } else ceoMark?.remove();
    const n = board && ceoActive() ? board.queueCount() : 0;
    if (n > 0) {
      queueMark ??= mk('div', 'ceo-mark ceo-mark-door');
      const door = f.scene.r.door.at;
      queueMark.style.left = `${door[0]}px`;
      queueMark.style.top = `${door[1]}px`;
      const text = fill(C.queueText, { n });
      if (queueMark.textContent !== text) queueMark.textContent = text;
      if (!queueMark.isConnected) (f.layer ?? f.stage).append(queueMark);
    } else queueMark?.remove();
  }

  // ---------- the boss's own life: now and then a walk to the sofa, the window, the trophy (the office's ambient rules) ----------

  const amb = () => ctx.life.ambient ?? ctx.ui.ambient;
  const rng = rngFor(CEO_ID);
  const life = { id: CEO_ID, nextFidgetAt: Infinity, nextTripAt: Infinity, returnAt: 0 };
  let tripBusy = false;
  const clock = createFloorClock({
    get amb() { return amb(); },
    now: ctx.now,
    timers: { setTimeout: (fn, ms) => timers.setTimeout(fn, ms, CEO_ID), clearTimeout: (t) => timers.clearTimeout(t) },
    members: () => (fig && lock.holder() === null && ceoActive() && moves() ? [life] : []),
    awayCount: () => 0,
    act: {
      fidget(m) {
        const a = amb();
        m.nextFidgetAt = ctx.now() + between(rng, a.fidgetEveryMs);
        if (!fig || fig.walk || tripBusy) return;
        const name = chooseFidget(rng, fig.seated, a);
        const el = name === 'look' ? fig.flip : fig.body;
        el.style.setProperty('--fid-delay', `${Math.round(between(rng, a.fidgetJitterMs))}ms`);
        el.classList.add(`fid-${name}`);
      },
      trip(m) {
        const a = amb();
        const pick = fig && !fig.walk ? chooseSpot(rng, ceoF().scene.raw.spots ?? [], new Map(), a.chatChance) : null;
        m.nextTripAt = ctx.now() + between(rng, a.tripEveryMs.idle);
        if (!pick) return;
        const at = pick.slot === 'pair' ? pick.spot.pair : pick.spot.at;
        tripBusy = true;
        m.returnAt = Infinity; // set when it is there
        ctx.goTo(fig, ceoF(), standAt(at, pick.spot.face), () => {
          if (!fig) return;
          m.returnAt = ctx.now() + between(rng, a.stayMs);
          if (rng() < a.chatChance) ctx.sayFor(fig, ctx.line('ceoIdle', undefined, fig), ctx.ui.play.greetMs);
          clock.kick();
        });
      },
      tripEnd(m) {
        if (!fig) return;
        m.returnAt = Infinity;
        ctx.goTo(fig, ceoF(), deskTarget(), () => {
          tripBusy = false;
          m.returnAt = 0;
          clock.kick();
        });
      },
    },
  });

  function startLife() {
    if (!fig || !moves() || !ceoActive()) return clock.stop();
    if (life.nextFidgetAt === Infinity) {
      const a = amb();
      life.nextFidgetAt = ctx.now() + between(rng, a.firstDelayMs);
      life.nextTripAt = ctx.now() + between(rng, a.tripEveryMs.idle);
    }
    clock.start();
  }

  // ---------- visitors of the boss room ----------

  function ensureVisitor(sid, spot) {
    let rec = visitors.get(sid);
    if (rec) return rec;
    const f = ceoF();
    const lead = ctx.view(sid)?.lead;
    if (!lead || !visits[spot]) return null;
    rec = ctx.room.createVisitor(f, { sprite: lead.sprite, name: lead.name, role: lead.role });
    for (const n of [rec.el, rec.tagRoot]) n.classList.add('ceo-visitor');
    rec.tagRoot.append(prop('paper', 'ceo-paper'));
    visitors.set(sid, rec);
    placeVisitor(rec, spot);
    return rec;
  }

  function placeVisitor(rec, spot) {
    ctx.freeze(rec);
    ctx.placeAt(rec, visits[spot].at);
    ctx.setFacing(rec, visits[spot].face);
  }

  function dropVisitor(sid) {
    const rec = visitors.get(sid);
    if (!rec) return;
    visitors.delete(sid);
    ctx.room.removeVisitor(rec);
  }

  // ---------- a lead that is away: hidden at home, a sign over its desk ----------

  function markOf(frec, lead, text) {
    const a = aways.get(frec.sid);
    const m = a?.mark ?? mk('div', 'ceo-mark ceo-mark-away');
    const t = lead.target ?? { x: lead.x, y: lead.y };
    m.style.left = `${t.x}px`;
    m.style.top = `${t.y}px`;
    if (m.textContent !== text) m.textContent = text;
    if (!m.isConnected) (frec.layer ?? frec.stage).append(m);
    return m;
  }

  /** The lead of floor `sid` is away for `reason` ('visit' | 'roof'): hidden, with the sign. Idempotent. */
  function setAway(sid, reason) {
    const frec = ctx.floor(sid);
    const lead = frec?.agents.get('lead');
    if (!lead) return;
    const cur = aways.get(sid);
    if (cur?.reason === reason) return;
    setHidden(lead, true);
    const mark = markOf(frec, lead, reason === 'roof' ? C.roofText : C.awayText);
    aways.set(sid, { reason, mark });
    holdLead(sid);
  }

  const gestureTokens = new Map(); // sid -> the 'bellwave' token that keeps the away lead from starting anything (the wave of the bell, the office life)
  function holdLead(sid) {
    const lead = leadOf(sid);
    if (!lead || gestureTokens.has(sid)) return;
    const token = ctx.gesture.acquire(lead, 'bellwave');
    if (token) gestureTokens.set(sid, token);
  }

  function releaseLead(sid) {
    const token = gestureTokens.get(sid);
    if (token) ctx.gesture.release(token);
    gestureTokens.delete(sid);
  }

  /** The lead is back: shown at its desk (or, with `from`, walking from the lift to it). Returns the walk ms. */
  function setHome(sid, from = null) {
    const frec = ctx.floor(sid);
    const lead = frec?.agents.get('lead');
    const cur = aways.get(sid);
    if (cur) {
      cur.mark.remove();
      aways.delete(sid);
    }
    releaseLead(sid);
    if (!lead || !cur || frec.status === 'leaving') return 0; // a floor that is leaving walks out by itself
    setHidden(lead, false);
    const t = lead.target;
    if (!t) return 0;
    ctx.freeze(lead);
    if (!from) {
      ctx.placeAt(lead, [t.x, t.y]);
      ctx.arriveAt(lead, t, false);
      return 0;
    }
    ctx.placeAt(lead, from);
    lead.seat = null;
    ctx.setPose(lead, false, false);
    ctx.setFacing(lead, frec.scene.r.door.face);
    return ctx.goTo(lead, frec, t);
  }

  // ---------- the lift trips ----------

  /** The trip may be walked now: the building on show, the effects on, the floors alive (the boss room too when `needCeo`). */
  const canRide = (sid, needCeo) => {
    const home = ctx.floor(sid);
    const f = ceoF();
    return moves() && buildingOn() && !ctx.paused() && Boolean(home && f) && ctx.floorActive(home) && (!needCeo || ctx.floorActive(f));
  };
  /** The lead is free to leave its desk: not in a scene, not held, not already away. */
  const leadFree = (sid) => {
    const lead = leadOf(sid);
    return Boolean(lead && lead.target) && !lead.play && !lead.grab && !lead.press && !lead.el.classList.contains('gone');
  };

  /** The lead walks to the lift of its floor, the car takes it to the boss room (the top stop). `arrive(ok)` runs when the car is there. */
  async function liftUp(flow, sid, reason, arrive) {
    const home = ctx.floor(sid);
    const lead = leadOf(sid);
    holdLead(sid);
    const out = standAt(entryOf(sid), home.scene.r.door.face);
    const w = walk(flow, lead, home, out);
    const ride = ctx.building.elevator(sid, CEO_ID, { holdMs: w.ms });
    await w.done;
    setAway(sid, reason);
    const ok = await flow.wait(ride);
    await arrive(ok);
  }

  /** The visitor of floor `sid` stands at its spot with the paper: the wave once (effects on), its line, and the boss's answer. */
  function greet(sid, rec) {
    const cfg = ctx.ui.bell;
    if (moves()) {
      rec.body.style.setProperty('--ceo-wave-ms', `${cfg.waveMs}ms`);
      rec.body.classList.add('ceo-wave');
      rec.body.addEventListener('animationend', () => rec.body.classList.remove('ceo-wave'), { once: true });
    }
    ctx.sayFor(rec, ctx.line('ceoVisit', undefined, rec), ctx.ui.play.greetMs);
    if (fig && lock.holder() === null) ctx.sayFor(fig, ctx.line('ceoGreet', undefined, fig), ctx.ui.play.greetMs);
  }

  async function goUp(sid, spot) {
    const flow = makeFlow(sid);
    tripFlows.set(sid, flow);
    flow.cleanups.push(() => { if (tripFlows.get(sid) === flow) tripFlows.delete(sid); });
    await liftUp(flow, sid, 'visit', async (ok) => {
      if (flow.dead) return;
      const f = ceoF();
      const rec = ensureVisitor(sid, spot);
      if (rec && ok) {
        ctx.placeAt(rec, entryOf(CEO_ID));
        ctx.setFacing(rec, f.scene.r.door.face);
        const w = walk(flow, rec, f, standAt(visits[spot].at, visits[spot].face));
        await w.done;
        if (rec === visitors.get(sid)) greet(sid, rec);
      }
      flow.stop();
      reconcile();
    });
  }

  async function goDown(sid) {
    const flow = makeFlow(sid);
    tripFlows.set(sid, flow);
    flow.cleanups.push(() => { if (tripFlows.get(sid) === flow) tripFlows.delete(sid); });
    const f = ceoF();
    const rec = visitors.get(sid);
    const w = rec ? walk(flow, rec, f, doorTarget(f)) : { ms: 0, done: Promise.resolve() };
    const ride = ctx.building.elevator(CEO_ID, sid, { holdMs: w.ms });
    await w.done;
    dropVisitor(sid);
    const ok = await flow.wait(ride);
    const ms = setHome(sid, ok ? entryOf(sid) : null);
    if (ms > 0) await flow.later(ms);
    flow.stop();
    reconcile();
  }

  function stopTrip(sid) {
    tripFlows.get(sid)?.stop();
    tripFlows.delete(sid);
  }

  // ---------- the roof ----------

  function roofOf() {
    const host = doc.querySelector('.b-roof');
    if (!host) return null;
    if (roof?.host === host) return roof;
    const stage = mk('div', 'ceo-roof-stage');
    const spots = [];
    for (let i = 0; i < ctx.ui.building.roofSpots; i++) {
      const s = mk('div', `ceo-roof-spot ceo-roof-spot-${i}`);
      stage.append(s);
      spots.push(s);
    }
    host.append(stage);
    const frec = { stage, scene: ceoF().scene, sid: ROOF_SID, design: ceoF().design, off: false, still: false, agents: new Map(), chars: new Map() };
    roof = { host, stage, spots, frec };
    return roof;
  }

  function ensureRoofRec(sid, idx) {
    let rec = roofRecs.get(sid);
    if (rec) return rec;
    const r = roofOf();
    const lead = ctx.view(sid)?.lead;
    if (!r || !lead) return null;
    rec = ctx.room.createVisitor(r.frec, { sprite: lead.sprite, name: lead.name, role: lead.role });
    for (const n of [rec.el, rec.tagRoot]) n.classList.add('ceo-roofer');
    r.spots[idx].append(rec.el, rec.tagRoot);
    ctx.placeAt(rec, [0, 0]);
    ctx.setFacing(rec, idx % 2 === 0 ? 'right' : 'left');
    rec.body.classList.toggle('ceo-nap', fx.fxOn());
    roofRecs.set(sid, rec);
    return rec;
  }

  function dropRoofRec(sid) {
    const rec = roofRecs.get(sid);
    if (!rec) return;
    roofRecs.delete(sid);
    ctx.room.removeVisitor(rec);
  }

  async function goRoof(sid, idx) {
    const flow = makeFlow(sid);
    roofFlows.set(sid, flow);
    flow.cleanups.push(() => { if (roofFlows.get(sid) === flow) roofFlows.delete(sid); });
    await liftUp(flow, sid, 'roof', async () => {
      if (flow.dead) return;
      const rec = ensureRoofRec(sid, idx);
      if (rec) ctx.sayFor(rec, ctx.line('roofRest', undefined, rec), ctx.ui.play.greetMs);
      flow.stop();
      reconcile();
    });
  }

  async function comeDown(sid) {
    const flow = makeFlow(sid);
    roofFlows.set(sid, flow);
    flow.cleanups.push(() => { if (roofFlows.get(sid) === flow) roofFlows.delete(sid); });
    dropRoofRec(sid);
    const ok = await flow.wait(ctx.building.elevator(CEO_ID, sid));
    const ms = setHome(sid, ok ? entryOf(sid) : null);
    if (ms > 0) await flow.later(ms);
    flow.stop();
    reconcile();
  }

  function stopRoof(sid) {
    roofFlows.get(sid)?.stop();
    roofFlows.delete(sid);
  }

  // ---------- the chalkboard ----------

  function attachBoard() {
    const f = ceoF();
    const quad = f?.scene.raw.costBoard?.quad;
    if (!f || !quad || boardEl?.isConnected) return;
    const frame = quadFrame(quad);
    boardEl = mk('div', 'ceo-board');
    Object.assign(boardEl.style, { left: `${frame.x}px`, top: `${frame.y}px`, width: `${frame.w}px`, height: `${frame.h}px`, transform: frame.matrix3d });
    boardEl.style.setProperty('--ceo-rows', String(C.board.rows + 2));
    boardRows = [];
    for (let i = 0; i < C.board.rows + 2; i++) {
      const row = mk('div', 'ceo-bl');
      row.append(mk('span', 'ceo-bl-l'), mk('span', 'ceo-bl-m'), mk('span', 'ceo-bl-r'));
      boardRows.push(row);
      boardEl.append(row);
    }
    f.stage.append(boardEl);
    boardKey = '';
    paintBoard();
  }

  /** Redraws the board when what it says changed (called when a cost frame arrives, and once when the board is built). */
  function paintBoard() {
    if (!boardEl) return;
    const floorLabel = (p) => {
      const n = ctx.view(p.sessionId)?.floorNo;
      return n ? fill(ctx.ui.lobby.floorLabel, { n }) : p.floorName;
    };
    const lines = boardLines(lastFrame, C.board, ctx.ui.cost, floorLabel);
    const key = linesKey(lines);
    if (key === boardKey) return;
    boardKey = key;
    lines.forEach((l, i) => {
      const [a, b, c] = boardRows[i].children;
      boardRows[i].dataset.kind = l.kind;
      a.textContent = l.left;
      b.textContent = l.mid ?? '';
      c.textContent = l.right;
    });
  }

  // ---------- the bell of each floor and the bell meeting ----------

  const bubbleOf = (rec) => (rec.bubTxt && !rec.bubTxt.classList.contains('empty') ? rec.bubTxt.textContent : '');

  function flashSign(frec, text) {
    const b = bells.get(frec);
    if (!b) return;
    b.sign.textContent = text;
    b.sign.hidden = false;
    timers.clearTimeout(b.signTimer);
    b.signTimer = timers.setTimeout(() => { b.sign.hidden = true; }, ctx.ui.bellMeeting.sayMs, frec.sid);
  }

  function syncBells() {
    const bm = ctx.ui.bellMeeting;
    const floors = sessionFloors();
    for (const f of floors) {
      const at = bm.at?.[f.design] ?? null;
      let b = bells.get(f);
      if (!at) {
        if (b) {
          b.btn.remove();
          bells.delete(f);
        }
        continue;
      }
      if (!b) {
        const btn = mk('button', 'ceo-bell');
        btn.type = 'button';
        const img = prop('bell-desk', 'ceo-bell-img');
        const sign = mk('div', 'ceo-bell-sign');
        sign.hidden = true;
        btn.append(img, sign);
        btn.style.left = `${at[0]}px`;
        btn.style.top = `${at[1]}px`;
        btn.addEventListener('click', () => onBell(f));
        f.stage.append(btn);
        b = { btn, img, sign, signTimer: 0 };
        bells.set(f, b);
      }
      const view = ctx.view(f.sid);
      const shown = ctx.floorActive(f) && f.status !== 'leaving';
      if (b.btn.hidden === shown) b.btn.hidden = !shown;
      b.btn.classList.toggle('ceo-bell-rest', Boolean(view?.rest));
      const label = `${bm.label} ${view?.floorNo ?? ''}`.trim();
      if (b.btn.getAttribute('aria-label') !== label) b.btn.setAttribute('aria-label', label);
    }
    for (const [f, b] of [...bells]) if (!floors.includes(f)) {
      b.btn.remove();
      bells.delete(f);
    }
  }

  const ringPicture = (frec, ringing) => {
    const b = bells.get(frec);
    if (b) b.img.src = `${PROPS}${ringing ? 'bell-desk-ring' : 'bell-desk'}.png`;
  };

  function onBell(frec) {
    const sid = frec.sid;
    const bm = ctx.ui.bellMeeting;
    const running = ctx.meeting.active(frec);
    const d = ringDecision({
      phaseActive: running === 'phase', bellActive: running === 'bell' || bellFlows.has(sid), lunch: Boolean(ctx.view(sid)?.rest),
      offFloor: !ctx.floorActive(frec) || frec.status === 'leaving', now: ctx.now(), lastRingAt: lastRing.get(sid) ?? null,
    }, bm);
    if (!d.ok) {
      if (d.sign) flashSign(frec, d.sign);
      return;
    }
    lastRing.set(sid, ctx.now());
    startBell(frec);
  }

  /** The boss leaves his desk for floor `sid`: out of his room by lift in the building view, else just there. Returns his record on the floor. */
  async function bringBoss(flow, frec) {
    const sid = frec.sid;
    const f = ceoF();
    const live = Boolean(fig) && ceoActive() && buildingOn() && ctx.floorActive(frec);
    if (live) {
      figLeaving = true;
      const w = walk(flow, fig, f, doorTarget(f));
      const ride = ctx.building.elevator(CEO_ID, sid, { holdMs: w.ms });
      await w.done;
      figLeaving = false;
      ensureFig();
      paintMarks();
      await flow.wait(ride);
    } else {
      ensureFig();
      paintMarks();
    }
    const rec = ctx.room.createVisitor(frec, { sprite: C.sprite, name: C.name, role: C.role });
    for (const n of [rec.el, rec.tagRoot]) n.classList.add('ceo-boss');
    const door = frec.scene.r.door;
    rec.target = standAt(door.at, door.face); // where the meeting machine sends him when it ends
    ctx.placeAt(rec, entryOf(sid));
    ctx.setFacing(rec, door.face);
    flow.chair = rec;
    return rec;
  }

  /** The boss goes home: out of the floor's door, up by lift, to his desk (placed at once when nothing may move). */
  async function bossHome(flow, frec) {
    const sid = frec.sid;
    const rec = flow.chair;
    flow.chair = null;
    const f = ceoF();
    const live = Boolean(rec) && moves() && ceoActive() && buildingOn() && ctx.floorActive(frec) && !ctx.paused();
    if (live) {
      const w = walk(flow, rec, frec, standAt(entryOf(sid), frec.scene.r.door.face));
      const ride = ctx.building.elevator(sid, CEO_ID, { holdMs: w.ms });
      await w.done;
      ctx.room.removeVisitor(rec);
      const ok = await flow.wait(ride);
      lock.release(sid);
      ensureFig();
      paintMarks();
      if (ok && fig) {
        setHidden(fig, false);
        ctx.freeze(fig);
        ctx.placeAt(fig, entryOf(CEO_ID));
        ctx.setPose(fig, false, false);
        ctx.setFacing(fig, f.scene.r.door.face);
        const back = walk(flow, fig, f, deskTarget());
        await back.done;
        seatFig();
      }
    } else {
      if (rec) ctx.room.removeVisitor(rec);
      lock.release(sid);
      ensureFig();
      if (fig) seatFig();
      paintMarks();
    }
    flow.stop();
    bellFlows.delete(sid);
    ringPicture(frec, false);
  }

  function abortBell(sid) {
    const flow = bellFlows.get(sid);
    if (!flow) return;
    const frec = ctx.floor(sid);
    flow.stop();
    bellFlows.delete(sid);
    if (flow.chair) ctx.room.removeVisitor(flow.chair);
    lock.release(sid);
    if (frec) ringPicture(frec, false);
    ensureFig();
    if (fig) seatFig();
    paintMarks();
  }

  async function startBell(frec) {
    const sid = frec.sid;
    const bm = ctx.ui.bellMeeting;
    const flow = makeFlow(sid);
    bellFlows.set(sid, flow);
    ringPicture(frec, true);
    const heard = new Map([...frec.agents.values()].map((r) => [r, bubbleOf(r)])); // what each says is what the bubble shows now
    const kind = bellChair({ moves: moves() && !figBroken && Boolean(ceoF()), lock, sid }); // no boss room (the building is off): no boss
    let chair = null;
    if (kind === 'ceo') {
      chair = await bringBoss(flow, frec);
      if (flow.dead) return;
    }
    const mt = ctx.meeting.start(frec, {
      kind: 'bell',
      ...(chair ? { chair } : {}),
      onHold(m) {
        const spots = frec.scene.raw.meeting.spots;
        const people = [...m.members].filter((r) => r !== chair).map((r) => ({ id: r, isLead: r.isLead, spot: nearestSpot(spots, r.x, r.y), bubble: heard.get(r) ?? '' }));
        const plan = planBell(people, {
          bm, effects: Boolean(chair), reducedMotion: false,
          lines: { idle: ctx.line('bellMeetingIdle'), open: ctx.line('bellMeetingOpen'), close: ctx.line('bellMeetingClose') },
        });
        const { events, totalMs } = bellTimeline(plan, bm);
        const bossRec = chair ?? [...m.members].find((r) => r.isLead) ?? null;
        for (const e of events) {
          flow.at(e.at, () => {
            const rec = e.who === 'chair' ? bossRec : e.who;
            if (rec && m.members.has(rec)) ctx.sayFor(rec, e.text, bm.sayMs);
          });
        }
        flow.at(totalMs, () => ctx.meeting.end(frec));
      },
      onEnd() {
        flow.clearTimers();
        ringPicture(frec, false);
        if (flow.chair) flow.at(0, () => bossHome(flow, frec)); // after the machine sent everybody back
        else {
          flow.stop();
          bellFlows.delete(sid);
        }
      },
      onSwitch() { // a workflow phase took the meeting over: the lead chairs, the boss steps aside by the door and goes up when it is over
        flow.clearTimers();
        flow.aside = true;
        ringPicture(frec, false);
        if (flow.chair) ctx.goTo(flow.chair, frec, standAt(entryOf(sid), frec.scene.r.door.face));
      },
    });
    if (!mt) { // nobody to hold a meeting with (no spots, an empty floor): the boss goes back
      if (flow.chair) bossHome(flow, frec);
      else {
        flow.stop();
        bellFlows.delete(sid);
        lock.release(sid);
        ringPicture(frec, false);
      }
    }
  }

  // ---------- keeping the picture in step with the state ----------

  /** Makes every visitor, away lead and roof figure what the state says, except for floors that are in the middle of a trip. */
  function reconcile() {
    syncBells();
    const f = ceoF();
    if (!f || !board) return;
    attachBoard();
    ensureFig();
    const pres = presence(board, { ceoActive: ceoActive(), buildingActive: buildingOn() });
    const want = new Map(pres.visitors.map((v) => [v.sid, v.spot]));
    for (const [sid, spot] of want) if (!tripFlows.has(sid)) ensureVisitor(sid, spot);
    for (const sid of [...visitors.keys()]) if (!want.has(sid) && !tripFlows.has(sid)) dropVisitor(sid);
    const roofWant = buildingOn() ? roofAssigned : new Map();
    for (const [sid, idx] of roofWant) if (!roofFlows.has(sid)) ensureRoofRec(sid, idx);
    for (const sid of [...roofRecs.keys()]) if (!roofWant.has(sid) && !roofFlows.has(sid)) dropRoofRec(sid);
    const away = new Map(pres.away.map((sid) => [sid, 'visit']));
    for (const sid of roofWant.keys()) away.set(sid, 'roof');
    for (const [sid, reason] of away) if (!tripFlows.has(sid) && !roofFlows.has(sid) && ctx.floor(sid)) setAway(sid, reason);
    for (const sid of [...aways.keys()]) if (!away.has(sid) && !tripFlows.has(sid) && !roofFlows.has(sid)) setHome(sid);
    for (const sid of [...gestureTokens.keys()]) if (!away.has(sid) && !tripFlows.has(sid) && !roofFlows.has(sid)) releaseLead(sid);
    paintMarks();
  }

  /** One state frame: who calls and who rests now. Changes after the first frame walk when they may (the building on show, the effects on), else the state is just set. */
  function onState(list, { hidden }) {
    if (!hidden) syncBells();
    if (!board) return;
    const calls = callers(list);
    const { started, released } = board.sync(calls);
    const rests = resters(list);
    const before = roofAssigned;
    roofAssigned = assignRoof(rests, ctx.ui.building.roofSpots, roofAssigned);
    const first = lastCalls === null;
    lastCalls = new Set(calls.map((c) => c.sid));
    if (!hidden) {
      for (const sid of [...tripFlows.keys()]) if (!ctx.floor(sid)) stopTrip(sid);
      for (const { sid, spot } of started) {
        stopTrip(sid);
        if (!first && canRide(sid, true) && leadFree(sid)) goUp(sid, spot);
      }
      for (const { sid } of released) {
        const had = tripFlows.has(sid);
        stopTrip(sid);
        if (!first && !had && visitors.has(sid) && canRide(sid, true) && aways.get(sid)?.reason === 'visit') goDown(sid);
      }
      for (const [sid, idx] of roofAssigned) {
        if (before.has(sid)) continue;
        stopRoof(sid);
        if (!first && canRide(sid, false) && leadFree(sid)) goRoof(sid, idx);
      }
      for (const sid of before.keys()) {
        if (roofAssigned.has(sid)) continue;
        const had = roofFlows.has(sid);
        stopRoof(sid);
        if (!first && !had && roofRecs.has(sid) && canRide(sid, false) && aways.get(sid)?.reason === 'roof') comeDown(sid);
      }
      reconcile();
    }
  }

  function onFloorEvent({ floor, removed }) {
    const sid = floor.sid;
    if (sid === CEO_ID) {
      for (const s of [...tripFlows.keys()]) stopTrip(s);
    } else if (sid !== LOBBY_ID) {
      stopTrip(sid);
      stopRoof(sid);
      if (removed || !ctx.floorActive(floor)) abortBell(sid);
      if (removed) {
        dropVisitor(sid);
        dropRoofRec(sid);
        const a = aways.get(sid);
        a?.mark.remove();
        aways.delete(sid);
        gestureTokens.delete(sid);
        bells.get(floor)?.btn.remove();
        bells.delete(floor);
        lastRing.delete(sid);
      }
    }
    reconcile();
  }

  // ---------- wiring ----------

  function attach() {
    const f = ceoF();
    if (!f || board) return;
    visits = f.scene.raw.visits ?? [];
    board = createVisitBoard(visits.length);
  }

  ctx.onServer('cost', (frame) => {
    lastFrame = frame;
    paintBoard();
  });
  ctx.onState(onState);
  attach();
  for (const name of ['floor-shown', 'floor-hidden']) fx.onFx(name, (d) => {
    attach();
    if (name === 'floor-hidden') onFloorEvent(d);
    else reconcile();
  }, { always: true });
  fx.onFx('meeting-end', ({ floor }) => {
    const flow = bellFlows.get(floor.sid);
    if (flow?.aside && flow.chair) flow.at(0, () => bossHome(flow, floor)); // the phase meeting is over: the boss goes up
  }, { always: true });
  fx.onFxChange(() => reconcile());
  ctx.building.onLayout(() => reconcile());
  ctx.onPauseChange((paused) => {
    if (!paused) return;
    for (const sid of [...tripFlows.keys()]) stopTrip(sid);
    for (const sid of [...roofFlows.keys()]) stopRoof(sid);
    reconcile();
  });
  reconcile();
}
