// The building cross-section (DOM side of web/building.mjs): the world box that holds every floor, the roof with its crane, the facade windows,
// the lift shaft with its one car, the basement server room, which floors are alive and which stand still, the slide between floors.
// The floors themselves are made by app.mjs and stay children of #floors in every view; while the whole building is shown (#floors.b-on)
// they are laid out absolutely (and scaled to the inner width), the other pieces of the building (roof, shaft, car, ...) are children of #floors too.
// Every number comes from ui.building (and ui.commute for the door and the walk-in); the rules are the pure functions of building.mjs / commute.mjs.
// No setInterval, no frame loop, no canvas: layout and the live set are redone when something happens (a state frame, a scroll, a resize).
import { BASEMENT_ID, ROOF_ID, blinkMs, buildingOrder, fitBuilding, idleDim, layoutBuilding, pickLive, racksOn, slideDir, touchesView, windowPic } from './building.mjs';
import { planCar } from './commute.mjs';
import { CEO_ID, LOBBY_ID } from './view.mjs';

const ASSET = '/assets/building/';
const LIVE_DEBOUNCE_MS = 60;

/** @typedef {{id: string, slot: HTMLElement, w: number, h: number, floorNo?: number, status?: string, design: string}} Room */

/**
 * @param {object} deps
 * @param {HTMLElement} deps.host         #floors
 * @param {object} deps.cfg               ui.building
 * @param {object} deps.commute           ui.commute
 * @param {string} deps.sysText           ui.lobby.sysText
 * @param {{setTimeout: Function, clearTimeout: Function}} deps.timers
 * @param {() => Room[]} deps.rooms       every room floor: the CEO room, the session floors, the lobby (any order)
 * @param {() => boolean} deps.isNight
 * @param {() => boolean} deps.fxOn
 * @param {() => boolean} deps.reduced    the viewer asks for less motion
 * @param {() => boolean} deps.paused
 * @param {(id: string, still: boolean) => void} deps.setStill
 * @param {() => object|null} deps.ctx    the effects context (set once the areas start)
 * @param {() => object|null} deps.roomRec  (id) => the floor record
 */
export function createBuildingView(deps) {
  const { host, cfg, commute, timers } = deps;
  const doc = host.ownerDocument;
  const mk = (cls, tag = 'div') => {
    const e = doc.createElement(tag);
    e.className = `b-piece ${cls}`;
    return e;
  };
  const pic = (cls, name) => {
    const i = mk(cls, 'img');
    i.src = `${ASSET}${name}.png`;
    i.alt = '';
    i.draggable = false;
    return i;
  };

  const world = host; // the pieces of the building are children of #floors beside the floors themselves (class b-piece)
  // ---- the fixed pieces: roof, crane, shaft, car, basement ----
  const roof = mk('b-roof');
  roof.append(pic('b-roof-img', 'roof'));
  for (const side of ['b-lamp-l', 'b-lamp-r']) roof.append(mk(`b-roof-lamp ${side}`)); // two warm lights on the roof terrace, drawn at night only (static)
  const arm = pic('b-crane-arm', 'crane-arm');
  const cable = mk('b-cable');
  cable.append(pic('b-hook', 'crane-hook'));
  roof.append(arm, cable);
  const shaft = mk('b-shaft');
  const car = pic('b-car', 'elev-car');
  const base = mk('b-base');
  base.append(pic('b-base-img', 'basement'));
  const sys = mk('b-sys');
  const sysText = mk('b-sys-text', 'span');
  const sysBar = mk('b-sys-bar');
  sysBar.append(mk('b-sys-fill'));
  sys.append(sysText, sysBar);
  const racks = [];
  base.style.setProperty('--b-racks', String(cfg.basement.racks)); // building.css puts rack i into alcove i of basement.png
  for (let i = 0; i < cfg.basement.racks; i++) {
    const r = mk('b-rack');
    r.style.setProperty('--b-i', String(i));
    r.append(pic('b-rack-off', 'rack-off'), pic('b-rack-on', 'rack-on'));
    racks.push(r);
  }
  base.append(sys, ...racks);
  world.append(roof, shaft, car, base);

  const parts = new Map(); // room id -> {win, door, slab}
  const prevStatus = new Map(); // room id -> status of the last sync
  const arriving = new Set(); // floors whose crane drop or lift ride is still on: they stay still
  const ghosts = new Set(); // slots that are folding away
  let active = false;
  let populated = false;
  let layout = null;
  let z = 1;
  let scrolls = false;
  let availH = 0;
  let lastW = 0;
  let moveToken = 0;
  const known = new Set(); // room ids seen by sync()
  let liveTimer = 0;
  let sysSample = null;
  let carAt = LOBBY_ID; // the floor the car stands at
  let moving = false;
  const pending = [];
  const layoutFns = new Set();
  const stillNow = new Map(); // room id -> the still flag last handed to deps.setStill

  const ordered = () => {
    const rooms = deps.rooms();
    const byId = new Map(rooms.map((r) => [r.id, r]));
    const sessions = rooms.filter((r) => r.id !== CEO_ID && r.id !== LOBBY_ID);
    const order = buildingOrder(sessions.map((r) => ({ sessionId: r.id, floorNo: r.floorNo ?? 0 })), { ceo: byId.has(CEO_ID), lobby: byId.has(LOBBY_ID) });
    return order.filter((id) => byId.has(id)).map((id) => byId.get(id));
  };

  /** Where the car stands at floor `id`: the bottom of the floor (the car and the shaft doors hang up from there, see building.css). */
  const doorY = (id) => {
    const row = layout?.rows.find((r) => r.id === id);
    return row ? row.top + row.h : 0;
  };

  function partsOf(id) {
    let p = parts.get(id);
    if (!p) {
      p = { win: mk('b-win'), door: pic('b-sdoor', 'elev-shaft-door'), slab: mk('b-slab') };
      world.append(p.slab, p.win, p.door);
      parts.set(id, p);
    }
    return p;
  }

  // ---- layout ----

  function place(rooms) {
    layout = layoutBuilding(rooms.map((r) => ({ id: r.id, w: r.w, h: r.h })), cfg);
    const Wb = layout.outerW;
    world.style.setProperty('--b-w', `${Wb}px`);
    world.style.setProperty('--b-facade', `${cfg.facadePx}px`);
    world.style.setProperty('--b-inner', `${cfg.innerW}px`);
    world.style.setProperty('--b-shaftw', `${cfg.shaftPx}px`);
    world.style.setProperty('--b-slab', `${cfg.slabPx}px`);
    world.style.setProperty('--b-h', `${layout.totalH}px`);
    roof.style.height = `${layout.roof.h}px`;
    for (const row of layout.rows) {
      const room = rooms.find((r) => r.id === row.id);
      const p = partsOf(row.id);
      const slot = room.slot;
      slot.style.setProperty('--b-s', String(row.s));
      slot.style.top = `${row.top}px`;
      p.slab.style.top = `${row.top + row.h}px`;
      p.win.style.top = `${row.top}px`;
      p.win.style.height = `${row.h}px`;
      p.door.style.top = `${row.top + row.h}px`;
    }
    for (const [id, p] of [...parts]) {
      if (ghosts.has(id) || layout.rows.some((r) => r.id === id)) continue;
      for (const n of [p.slab, p.win, p.door]) n.remove();
      parts.delete(id);
    }
    base.style.top = `${layout.basement.top}px`;
    base.style.height = `${layout.basement.h}px`;
    shaft.style.top = `${layout.roof.h}px`;
    shaft.style.height = `${layout.basement.top - layout.roof.h}px`;
    car.style.top = `${doorY(carAt)}px`;
  }

  function paint() {
    const rooms = ordered();
    const night = deps.isNight();
    host.classList.toggle('b-night', night);
    for (const room of rooms) {
      const p = partsOf(room.id);
      const w = windowPic({ id: room.id, status: room.status }, night);
      if (p.win.dataset.pic !== w) {
        p.win.dataset.pic = w;
        p.win.className = `b-piece b-win b-win-${w}`;
      }
      const dim = idleDim({ id: room.id, status: room.status }, night, cfg);
      room.slot.style.setProperty('--b-dim', String(dim));
    }
    drawSys(sysSample);
  }

  function drawSys(s) {
    sysSample = s;
    const on = racksOn(s?.cpu, cfg.basement.racks);
    racks.forEach((r, i) => r.classList.toggle('on', i < on));
    base.style.setProperty('--b-blink', `${blinkMs(s?.cpu ?? 0, cfg.basement)}ms`);
    sysText.textContent = s ? deps.sysText.replace('{cpu}', String(s.cpu)).replace('{mem}', String(s.mem)) : cfg.basement.none;
    sysBar.firstChild.style.width = s ? `${Math.max(0, Math.min(100, s.mem))}%` : '0%';
  }

  /**
   * Lays the building out for the room (availW x availH, in screen px) and returns the zoom. `syncing` marks the call that follows a state frame:
   * new floors are lowered by the crane, floors that went dark get the car, floors that left are gone from the list.
   */
  function fit(availW, availH0, syncing = false) {
    const rooms = ordered();
    availH = availH0;
    lastW = availW;
    const plan = syncing ? beforeLayout(rooms) : null;
    place(rooms);
    const f = fitBuilding(availW, availH0, layout.outerW, layout.totalH, cfg);
    z = f.z;
    scrolls = f.scroll;
    host.style.zoom = String(z);
    host.style.width = `${layout.outerW}px`;
    host.style.height = `${scrolls ? availH0 / z : layout.totalH}px`;
    host.classList.toggle('b-scroll', scrolls);
    paint();
    scheduleLive(0);
    if (plan) afterLayout(rooms, plan);
    for (const fn of [...layoutFns]) fn(layout);
    return z;
  }

  // ---- alive or still ----

  /** The part of the building in view, in building px (under CSS zoom the scroll box reports its own unzoomed units). */
  function viewBox() {
    return { viewTop: host.scrollTop, viewH: host.clientHeight };
  }

  function scheduleLive(ms = LIVE_DEBOUNCE_MS) {
    if (liveTimer) timers.clearTimeout(liveTimer);
    liveTimer = timers.setTimeout(() => {
      liveTimer = 0;
      updateLive();
    }, ms);
  }

  function updateLive() {
    if (!active || !layout) return;
    const v = viewBox();
    const view = { ...v, z, marginPx: cfg.liveMarginPx, maxLive: cfg.maxLiveFloors };
    const set = pickLive(layout.rows.filter((r) => !ghosts.has(r.id)), view);
    for (const row of layout.rows) {
      const still = !set.has(row.id) || arriving.has(row.id);
      if (stillNow.get(row.id) === still) continue;
      stillNow.set(row.id, still);
      deps.setStill(row.id, still);
    }
    base.classList.toggle('still', !touchesView(layout.basement.top, layout.basement.h, view));
    roof.classList.toggle('still', !touchesView(layout.roof.top, layout.roof.h, view));
  }

  function setActive(on) {
    if (active === on) return;
    active = on;
    host.classList.toggle('b-on', on);
    stillNow.clear();
    if (!on) {
      if (liveTimer) timers.clearTimeout(liveTimer);
      liveTimer = 0;
      host.classList.remove('b-scroll');
      host.style.width = '';
      host.style.height = '';
      host.scrollTop = 0;
      for (const r of deps.rooms()) deps.setStill(r.id, false);
    } else {
      host.scrollTop = 0;
      for (const r of deps.rooms()) {
        known.add(r.id);
        prevStatus.set(r.id, r.status);
      }
    }
  }

  // ---- state frames: new floors (crane), leaving floors (lift), folding ----

  /** Sets --b-move (the time floors take to move to their new place) for `ms`, then back to 0 (a resize never animates). */
  function moveFor(ms) {
    const token = ++moveToken;
    world.style.setProperty('--b-move', `${ms}ms`);
    timers.setTimeout(() => {
      if (token === moveToken) world.style.setProperty('--b-move', '0ms');
    }, ms + LIVE_DEBOUNCE_MS);
  }

  /** Before the layout of a state frame: the floors that are new start behind the CEO room (so the layout lowers them into place). */
  function beforeLayout(rooms) {
    const animate = active && populated && deps.fxOn() && !deps.reduced() && !deps.paused();
    const fresh = populated ? rooms.filter((r) => !known.has(r.id) && r.id !== CEO_ID && r.id !== LOBBY_ID) : [];
    const dropped = animate ? fresh : [];
    for (const r of rooms) known.add(r.id);
    for (const r of dropped) {
      arriving.add(r.id);
      stillNow.set(r.id, true);
      deps.setStill(r.id, true);
      const ceoRow = layout?.rows.find((x) => x.id === CEO_ID);
      const start = ceoRow ? ceoRow.top + ceoRow.h - r.h * (cfg.innerW / r.w) : 0;
      r.slot.style.transition = 'none';
      r.slot.style.top = `${start}px`;
      r.slot.classList.add('b-drop');
      const lead = deps.roomRec(r.id)?.agents.get('lead');
      if (lead) for (const n of [lead.el, lead.tagRoot]) n.classList.add('b-wait'); // not seen until the lift door opens
      void r.slot.offsetWidth;
      r.slot.style.transition = '';
    }
    if (dropped.length) moveFor(cfg.craneMs);
    else if (animate && ghosts.size) moveFor(cfg.collapseMs);
    return { dropped };
  }

  /** After the layout: the crane, the cars for floors that went dark, the arrivals. */
  function afterLayout(rooms, { dropped }) {
    if (dropped.length) crane(dropped);
    for (const r of rooms) {
      if (r.id === CEO_ID || r.id === LOBBY_ID) continue;
      const was = prevStatus.get(r.id);
      if (was !== undefined && was !== 'leaving' && r.status === 'leaving') leaveRide(r.id);
      prevStatus.set(r.id, r.status);
    }
    for (const id of [...prevStatus.keys()]) if (!rooms.some((r) => r.id === id)) prevStatus.delete(id);
    populated = true;
    for (const r of dropped) arrive(r.id);
  }

  function crane(dropped) {
    cable.style.setProperty('--b-drop', `${layout.rows.find((x) => x.id === dropped[0].id)?.top ?? cfg.roofPx}px`); // the cable reaches the top of the new floor's place
    cable.style.setProperty('--b-crane-ms', `${cfg.craneMs}ms`);
    cable.classList.remove('run');
    void cable.offsetWidth;
    cable.classList.add('run');
    timers.setTimeout(() => {
      cable.classList.remove('run');
      for (const r of dropped) r.slot.classList.remove('b-drop');
    }, cfg.craneMs);
  }

  const later = (ms) => new Promise((res) => timers.setTimeout(res, ms));

  async function arrive(id) {
    try {
      await later(cfg.craneMs);
      const ride = await elevator(LOBBY_ID, id);
      if (ride) await openDoor(id);
      arriving.delete(id);
      updateLive();
      walkIn(id, ride);
    } finally {
      arriving.delete(id);
    }
  }

  async function openDoor(id) {
    const p = parts.get(id);
    if (!p) return;
    p.door.classList.add('open');
    await later(commute.doorOpenMs);
    timers.setTimeout(() => p.door.classList.remove('open'), commute.doorOpenMs);
  }

  /** The lead comes out of the lift at the floor's entry and walks to the desk (the floor must be alive; else it already sits there). */
  function walkIn(id, ride) {
    const ctx = deps.ctx();
    const frec = deps.roomRec(id);
    const lead = frec?.agents?.get('lead');
    if (!lead) return;
    for (const n of [lead.el, lead.tagRoot]) n.classList.remove('b-wait');
    if (!ctx) return;
    const target = lead.target;
    if (!ride || !target || frec.off || frec.still || !ctx.fx.fxOn()) return;
    const token = ctx.gesture.acquire(lead, 'life');
    if (!token) return;
    ctx.freeze(lead);
    ctx.placeAt(lead, entryOf(id));
    lead.seat = null;
    ctx.setPose(lead, false, false);
    ctx.setFacing(lead, frec.scene.r.door.face);
    ctx.sayFor(lead, ctx.line('commuteIn', undefined, lead), ctx.ui.play.greetMs);
    const done = () => ctx.gesture.release(token);
    ctx.gesture.onPreempt(token, () => ctx.arriveAt(lead, target, false));
    const walkMs = ctx.goTo(lead, frec, target, done);
    if (walkMs > 0) timers.setTimeout(done, walkMs + commute.doorOpenMs);
  }

  /** The floor went dark (퇴근): the car comes, waits for the leave walk, and takes the lead down to the lobby. */
  function leaveRide(id) {
    if (!active || !deps.fxOn() || deps.reduced()) return;
    elevator(id, LOBBY_ID, { holdMs: commute.leaveBudgetMs });
  }

  /** The floor is going away: its slot folds to height 0 (the floors below move up), then it is removed. */
  function collapse(id, slot, done) {
    const p = parts.get(id);
    if (!active || !deps.fxOn() || deps.reduced() || !p || !layout) {
      slot.remove();
      done?.();
      return;
    }
    ghosts.add(id);
    slot.classList.add('b-fold');
    moveFor(cfg.collapseMs);
    p.win.style.height = '0px';
    p.slab.style.opacity = '0';
    p.door.style.opacity = '0';
    timers.setTimeout(() => {
      ghosts.delete(id);
      parts.delete(id);
      known.delete(id);
      for (const n of [slot, p.slab, p.win, p.door]) n.remove();
      done?.();
    }, cfg.collapseMs);
  }

  // ---- the lift car ----

  function entryOf(id) {
    const room = deps.rooms().find((r) => r.id === id);
    const rec = deps.roomRec(id);
    return cfg.entryAt[room?.design] ?? rec?.scene.r.door.at ?? [0, 0];
  }

  /** Drives the car to floor `id`; resolves when it stands there. */
  function drive(id, ms) {
    return new Promise((res) => {
      car.style.transitionDuration = `${ms}ms`;
      car.style.top = `${doorY(id)}px`;
      carAt = id;
      timers.setTimeout(() => {
        car.style.transitionDuration = '';
        res();
      }, ms);
    });
  }

  async function pump() {
    moving = true;
    try {
      while (pending.length) {
        const reqs = pending.map((p, i) => ({ id: String(i), y: doorY(p.from) }));
        const plan = planCar({ y: doorY(carAt) }, reqs, cfg);
        const chosen = pending[Number(plan.move.id)];
        for (const sid of plan.skipped) pending[Number(sid)].res(false);
        pending.length = 0;
        if (carAt !== chosen.from) await drive(chosen.from, plan.move.ms);
        await later(chosen.holdMs);
        const leg = planCar({ y: doorY(carAt) }, [{ id: chosen.to, y: doorY(chosen.to) }], cfg);
        if (leg.move) await drive(chosen.to, leg.move.ms);
        chosen.res(true);
      }
    } finally {
      moving = false;
    }
  }

  /**
   * One ride: the car goes to `fromId`, waits `holdMs`, takes the passenger to `toId`. Resolves true when it arrived there, false when the ride was
   * skipped (effects off, both floors still, or another request was nearer: requests are merged, not queued, see planCar).
   */
  function elevator(fromId, toId, { holdMs = 0 } = {}) {
    if (!active || !layout || !deps.fxOn() || deps.reduced() || deps.paused()) return Promise.resolve(false);
    const stillOf = (id) => id !== LOBBY_ID && !arriving.has(id) && deps.roomRec(id)?.still === true;
    if (stillOf(fromId) && stillOf(toId)) return Promise.resolve(false);
    return new Promise((res) => {
      pending.push({ from: fromId, to: toId, holdMs, res });
      if (!moving) pump();
    });
  }

  // ---- slide ----

  /** Slides the building so that `id` comes to the middle of the view over ui.building.slideMs, then calls `done`. Instant without the effects. */
  function slideTo(id, done) {
    const row = layout?.rows.find((r) => r.id === id);
    if (!active || !row || !deps.fxOn() || deps.reduced()) return done();
    const v = viewBox();
    const dy = row.top + row.h / 2 - (v.viewTop + v.viewH / 2);
    host.style.setProperty('--b-slide-ms', `${cfg.slideMs}ms`);
    host.style.setProperty('--b-dy', '0px');
    host.classList.add('b-slide');
    void host.offsetWidth; // commit the start before the target
    host.style.setProperty('--b-dy', `${-dy}px`);
    timers.setTimeout(() => {
      host.classList.remove('b-slide');
      host.style.removeProperty('--b-dy');
      done();
    }, cfg.slideMs);
  }

  /** Floor-to-floor slide inside the single view: the old floor leaves, the new one comes in from the side the building puts it on. */
  function slidePair(fromEl, toEl, dir, done) {
    if (!dir || !deps.fxOn() || deps.reduced()) return done();
    host.classList.add('b-sliding');
    host.style.setProperty('--b-slide', `${cfg.slideMs}ms`);
    fromEl.classList.add('b-out', dir === 'down' ? 'b-to-bottom' : 'b-to-top');
    toEl.classList.add('b-in', dir === 'down' ? 'b-from-top' : 'b-from-bottom');
    timers.setTimeout(() => {
      host.classList.remove('b-sliding');
      for (const n of [fromEl, toEl]) n.classList.remove('b-out', 'b-in', 'b-to-bottom', 'b-to-top', 'b-from-top', 'b-from-bottom');
      done();
    }, cfg.slideMs);
  }

  return {
    world,
    active: () => active,
    setActive,
    fit,
    sync: () => fit(lastW, availH, true),
    paint,
    drawSys,
    updateLive,
    scheduleLive,
    elevator,
    entryOf,
    collapse,
    slideTo,
    slidePair,
    slideDir: (fromId, toId) => slideDir(ordered().map((r) => r.id), fromId, toId),
    orderIds: () => ordered().map((r) => r.id),
    floorBox: (id) => {
      const row = layout?.rows.find((r) => r.id === id);
      return row ? { left: cfg.facadePx, top: row.top, w: cfg.innerW, h: row.h, scale: row.s } : null;
    },
    zoom: () => z,
    scrolls: () => scrolls,
    onLayout: (fn) => {
      layoutFns.add(fn);
      return () => layoutFns.delete(fn);
    },
    markArriving: (id) => arriving.add(id),
    isArriving: (id) => arriving.has(id),
    relayout: () => scheduleLive(0),
    ROOF_ID,
    BASEMENT_ID,
  };
}
