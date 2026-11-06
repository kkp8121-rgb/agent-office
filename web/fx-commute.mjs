// Effects area "commute" (single-floor view): the lead comes to work through the lift door of the room, and a floor that ends goes dark and walks out.
//   arrival (a new floor, effects on): the panel over the door blinks, the door opens, the lead walks in from the door to the desk, the door closes.
//   departure (floor status 'leaving'): the room goes dark at once (the veil is an information sign: it also shows with the effects off, without the fade);
//   with the effects on the staff and then the lead walk to the door one after another and vanish there.
// The door cover and the panel are decoration: built only while the effects are on and only for a design that has ui.commute.door[design].
// The order and the timing are the pure rules of commute.mjs; this file only draws them. Every walk goes through ctx.goTo and holds the
// character with ctx.gesture ('life', the lowest kind): a stronger gesture is never overridden, and no ambient motion starts meanwhile.
// Timers are ctx.timers with the floor id, started only on a floor that is shown.
import { arrivalSteps, cutWalk, diffFloors, doorBox, leaveSteps } from './commute.mjs';
import { charZ } from './depth.mjs';

const PROP_URL = '/assets/props/elev-door-';
const ARROW_UP = '▲';
const ARROW_DOWN = '▼';

/** @param {import('./fx.mjs').FxCtx} ctx */
export function init(ctx) {
  const cfg = ctx.ui.commute;
  const { fx, timers } = ctx;
  const doc = globalThis.document;
  const parts = new WeakMap(); // floor -> {door, panel, veil} (each an element or null)
  const runs = new Map(); // sessionId -> {frec, ids: timer tokens, tokens: gesture tokens, restore: fn|null}
  const vanished = new Map(); // character -> its floor, for a floor that comes back from 'leaving'
  let seen = null; // sessionId -> status of the last frame (commute.mjs diffFloors)

  const partsOf = (frec) => {
    let p = parts.get(frec);
    if (!p) parts.set(frec, (p = { door: null, panel: null, veil: null }));
    return p;
  };
  const doorCfg = (frec) => cfg.door?.[frec.design] ?? null;
  /** Where people appear and vanish at the door: the scene's `door.at`, or the design's own `at` when the drawn door is not on the floor the staff walk on. */
  const doorAt = (frec) => doorCfg(frec)?.at ?? frec.scene.r.door.at;
  const isNight = () => Number.parseFloat(globalThis.getComputedStyle(doc.documentElement).getPropertyValue('--room-dim')) > 0;
  const tagged = (rec, cls, on) => {
    for (const n of [rec.el, rec.tagRoot]) n.classList.toggle(cls, on);
  };

  // ---- the door cover and its panel (decoration) ----

  /** Builds or removes the closed door cover of a floor: present only while the effects are on and the design has a placement. */
  function syncDoor(frec) {
    const p = partsOf(frec);
    const d = doorCfg(frec);
    if (!fx.fxOn() || !d) {
      p.door?.remove();
      p.door = null;
      return;
    }
    if (p.door) return;
    const at = frec.scene.r.door.at;
    const img = doc.createElement('img');
    img.className = 'cm-door';
    img.alt = '';
    img.draggable = false;
    img.src = `${PROP_URL}closed.png`;
    img.style.left = `${at[0] + d.dx}px`;
    img.style.top = `${at[1] + d.dy}px`;
    img.style.setProperty('--cm-sx', String(d.scale));
    img.style.setProperty('--cm-sy', String(d.scaleY ?? d.scale));
    img.style.setProperty('--cm-k', `${d.skew ?? 0}deg`);
    img.style.zIndex = String(charZ(doorAt(frec)[1] - ctx.server.spriteHeight, ctx.server.depth) - 1); // an object nearer than the door's foot stays in front of it, and a figure that comes out of the door is in front of the cover for as long as it overlaps it
    frec.stage.append(img);
    p.door = img;
  }

  const setDoor = (frec, open) => {
    const img = partsOf(frec).door;
    if (img) img.src = `${PROP_URL}${open ? 'open' : 'closed'}.png`;
  };

  function showPanel(frec, up) {
    const p = partsOf(frec);
    const d = doorCfg(frec);
    if (!p.door || !d) return;
    p.panel?.remove();
    const img = p.door;
    const panel = doc.createElement('div');
    panel.className = 'cm-panel';
    panel.textContent = `${cfg.panelText.replace('{n}', String(ctx.view(frec.sid)?.floorNo ?? ''))} ${up ? ARROW_UP : ARROW_DOWN}`;
    const place = () => { // the panel hangs on the top of the cover, which needs the picture's size: a cover that has just been made may not have it yet
      const box = doorBox(frec.scene.r.door.at, { w: img.naturalWidth, h: img.naturalHeight }, d);
      panel.style.left = `${box.foot[0]}px`;
      panel.style.top = `${box.top}px`;
      panel.hidden = false;
    };
    if (img.naturalHeight) place();
    else {
      panel.hidden = true;
      img.decode().then(place, () => {});
    }
    frec.stage.append(panel);
    p.panel = panel;
  }

  const hidePanel = (frec) => {
    const p = partsOf(frec);
    p.panel?.remove();
    p.panel = null;
  };

  // ---- the veil (information: drawn with the effects off too) ----

  function setVeil(frec, on, plan) {
    const p = partsOf(frec);
    if (!on) {
      p.veil?.remove();
      p.veil = null;
      return;
    }
    if (p.veil) return;
    const veil = doc.createElement('div');
    veil.className = 'cm-veil';
    veil.style.setProperty('--cm-fade', `${plan.fadeMs}ms`);
    frec.stage.append(veil);
    p.veil = veil;
    void veil.offsetWidth; // commit opacity 0 so the fade starts from it
    veil.style.opacity = String(plan.dim);
  }

  // ---- runs: the timed parts of one floor's arrival or departure ----

  function startRun(frec) {
    stopRun(frec.sid);
    const run = { frec, ids: new Set(), tokens: new Set(), restore: null };
    runs.set(frec.sid, run);
    return run;
  }

  const later = (run, fn, ms) => {
    const token = timers.setTimeout(() => {
      run.ids.delete(token);
      fn();
    }, ms, run.frec.sid);
    run.ids.add(token);
  };

  /** Ends a run now: pending timers are dropped, held characters let go, a lead that was taken to the door is put back at its desk. */
  function stopRun(sid) {
    const run = runs.get(sid);
    if (!run) return;
    runs.delete(sid);
    for (const t of run.ids) timers.clearTimeout(t);
    for (const t of run.tokens) ctx.gesture.release(t);
    run.restore?.();
    hidePanel(run.frec);
    setDoor(run.frec, false);
  }

  /** A character that took part and is still there, staff first and the lead last. */
  const present = (frec) => [...frec.agents.values()].filter((r) => !r.el.classList.contains('gone')).sort((a, b) => Number(a.isLead) - Number(b.isLead));

  function arrive(frec) {
    const lead = frec.agents.get('lead');
    const target = lead?.target;
    if (!lead || !target || !fx.fxOn() || !ctx.floorActive(frec)) return;
    const token = ctx.gesture.acquire(lead, 'life');
    if (!token) return;
    const { door } = frec.scene.r;
    const hasDoor = partsOf(frec).door !== null;
    const run = startRun(frec);
    run.tokens.add(token);
    ctx.gesture.onPreempt(token, () => stopRun(frec.sid));
    const release = () => {
      run.restore = null;
      ctx.gesture.release(token);
      run.tokens.delete(token);
    };
    ctx.freeze(lead);
    ctx.placeAt(lead, doorAt(frec));
    lead.seat = null;
    ctx.setPose(lead, false, false);
    ctx.setFacing(lead, door.face);
    run.restore = () => {
      tagged(lead, 'cm-wait', false);
      ctx.freeze(lead);
      ctx.placeAt(lead, [target.x, target.y]);
      ctx.arriveAt(lead, target, false);
    };
    if (hasDoor) tagged(lead, 'cm-wait', true); // the lead is not seen until the door has opened
    for (const { step, atMs } of arrivalSteps(cfg, hasDoor)) {
      later(run, () => {
        if (step === 'panel') showPanel(frec, true);
        else if (step === 'open') setDoor(frec, true);
        else if (step === 'close') {
          hidePanel(frec);
          setDoor(frec, false);
        } else {
          tagged(lead, 'cm-wait', false);
          ctx.sayFor(lead, ctx.line('commuteIn', undefined, lead), ctx.ui.play.greetMs);
          const walkMs = ctx.goTo(lead, frec, target, release);
          if (walkMs > 0) later(run, release, walkMs + cfg.doorOpenMs); // a walk that is replaced never calls back: the hold ends with the walk anyway
        }
      }, atMs);
    }
  }

  function leave(frec) {
    const active = fx.fxOn() && ctx.floorActive(frec);
    const people = active ? present(frec) : [];
    const plan = leaveSteps(people.length, cfg, { fx: active, night: isNight() });
    setVeil(frec, true, plan.veil);
    if (!people.length) return;
    const run = startRun(frec);
    const { door } = frec.scene.r;
    const at = doorAt(frec);
    const toDoor = { x: at[0], y: at[1], face: door.face, seated: false, seat: null };
    let closeTimer = 0;
    const opened = () => { // the door is open while somebody goes through, and closes a moment after the last one
      setDoor(frec, true);
      timers.clearTimeout(closeTimer);
      closeTimer = timers.setTimeout(() => setDoor(frec, false), cfg.doorOpenMs, frec.sid);
      run.ids.add(closeTimer);
    };
    for (const { index, startMs, maxWalkMs } of plan.people) {
      const rec = people[index];
      later(run, () => {
        if (rec.el.classList.contains('gone')) return;
        const token = ctx.gesture.acquire(rec, 'life');
        let over = false;
        const finish = () => {
          if (over) return;
          over = true;
          if (token) ctx.gesture.release(token);
          rec.el.classList.add('gone');
          rec.tagRoot.classList.add('cm-gone');
          vanished.set(rec, frec);
          opened();
        };
        if (!token || maxWalkMs <= 0) return finish();
        run.tokens.add(token);
        if (rec.isLead) ctx.sayFor(rec, ctx.line('commuteOut', undefined, rec), ctx.ui.play.greetMs);
        const walkMs = ctx.goTo(rec, frec, toDoor, finish);
        if (!over) later(run, finish, cutWalk(walkMs, maxWalkMs));
      }, startMs);
    }
  }

  /** A floor that came back from 'leaving': whoever vanished is at the desk again. */
  function relight(frec) {
    stopRun(frec.sid);
    setVeil(frec, false);
    for (const [rec, floor] of [...vanished]) {
      if (floor !== frec) continue;
      vanished.delete(rec);
      rec.el.classList.remove('gone');
      rec.tagRoot.classList.remove('cm-gone');
      if (rec.target) {
        ctx.freeze(rec);
        ctx.placeAt(rec, [rec.target.x, rec.target.y]);
        ctx.arriveAt(rec, rec.target, false);
      }
    }
  }

  // ---- wiring ----

  function onState(list, { hidden }) {
    const diff = diffFloors(seen, list);
    seen = diff.next;
    for (const fv of list) {
      const frec = ctx.floor(fv.sessionId);
      if (!frec) continue;
      if (!hidden) syncDoor(frec);
      if (hidden) continue;
      const id = fv.sessionId;
      if (diff.arrivals.includes(id)) arrive(frec);
      if (diff.leavings.includes(id)) leave(frec);
      else if (fv.status === 'leaving' && !partsOf(frec).veil) setVeil(frec, true, { dim: isNight() ? cfg.offDimNight : cfg.offDim, fadeMs: 0 });
      else if (fv.status !== 'leaving' && partsOf(frec).veil) relight(frec);
    }
    for (const sid of [...runs.keys()]) if (!diff.next.has(sid)) stopRun(sid);
  }

  ctx.onState(onState);
  fx.onFxChange(() => {
    for (const frec of ctx.floors()) {
      if (frec === ctx.lobby()) continue;
      if (!fx.fxOn()) stopRun(frec.sid);
      syncDoor(frec);
    }
  });
  fx.onFx('floor-hidden', ({ floor, removed }) => {
    stopRun(floor.sid);
    if (removed) for (const [rec, f] of [...vanished]) if (f === floor) vanished.delete(rec);
  }, { always: true });
  ctx.onPauseChange((on) => {
    if (on) for (const sid of [...runs.keys()]) stopRun(sid);
  });
}
