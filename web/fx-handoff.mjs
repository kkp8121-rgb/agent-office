// Effects area "handoff" (web/handoff.mjs holds the rules): the lead hands a folder to the worker it calls and the worker carries it to the desk;
// a workflow phase passes a folder from one worker to the next in an arc; a message flies as a paper plane. All of it is decoration, so it
// exists only while the effects are on and only on a floor that is shown, and never on a lunch-break floor. Nothing is queued: what cannot
// start now is dropped (a phase paper waits for the running meeting, at most ui.handoff.pendingMs).
// The folder in a hand is a gesture ('folder' in ui.gesture.priority): a stronger one (lunch, faint, bell wave, tug) takes the hands, a
// weaker one (office life) waits. Flights run on the floor's .fx-layer with transform animations only.
import { flightFrames, planHandoff } from './handoff.mjs';

const FOLDER = '/assets/props/folder.png';
const PLANE = '/assets/props/plane.png';
const CHEST = 24; // px above the feet where a flying paper starts and lands

/**
 * @param {import('./fx.mjs').FxCtx} ctx
 * @param {{make?: (tag: string) => Element, animate?: Function, reduced?: () => boolean}} [deps]  the page's own by default; tests pass fakes
 */
export function init(ctx, deps = {}) {
  const cfg = ctx.ui.handoff;
  if (!cfg) return;
  const make = deps.make ?? ((tag) => document.createElement(tag));
  const animate = deps.animate ?? ((el, frames, timing) => el.animate(frames, timing));
  const reduced = deps.reduced ?? (() => Boolean(globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches));
  const holds = new Set(); // {rec, frec, token, el, role: 'give'|'carry', desk, timers}
  const flights = new Set(); // {el, frec, plane}
  const waiting = new Map(); // sig -> {frec, timer}: phase papers waiting for the meeting to end
  const coming = new Map(); // `${sessionId}|${key}` -> {timer}: a folder for a newcomer that is not on the page yet

  const keyOf = (frec, rec) => [...frec.agents].find(([, r]) => r === rec)?.[0] ?? null;
  const present = (frec, key) => {
    const rec = key == null ? null : frec.agents.get(key);
    return rec && !rec.el.classList.contains('gone') ? rec : null;
  };
  const pointOf = (rec) => (rec ? [rec.x, rec.y - CHEST] : null);
  const picture = (src, cls) => {
    const img = make('img');
    img.className = `ho-prop ${cls}`;
    img.src = src;
    img.alt = '';
    img.draggable = false;
    return img;
  };

  function drop(h) {
    for (const t of h.timers) ctx.timers.clearTimeout(t);
    ctx.gesture.release(h.token);
    h.el.remove();
    holds.delete(h);
  }

  /** A folder in the hands of `rec`; null when a stronger gesture holds the character (then it simply carries nothing). */
  function hold(rec, frec, role) {
    const token = ctx.gesture.acquire(rec, 'folder');
    if (!token) return null;
    const h = { rec, frec, token, el: picture(FOLDER, 'ho-carry'), role, desk: false, timers: [] };
    rec.tagRoot.append(h.el);
    holds.add(h);
    ctx.gesture.onPreempt(token, () => drop(h));
    return h;
  }

  /** The newcomer sat down (or the walk is over): the folder goes onto the desk for a while, then away. */
  function arrive(h) {
    if (h.desk || !holds.has(h)) return;
    h.desk = true;
    for (const t of h.timers) ctx.timers.clearTimeout(t);
    h.el.classList.add('ho-desk');
    h.timers = [ctx.timers.setTimeout(() => drop(h), cfg.deskKeepMs, h.frec.sid)];
  }

  function carry(rec, frec) {
    const h = hold(rec, frec, 'carry');
    if (h) h.timers.push(ctx.timers.setTimeout(() => arrive(h), cfg.pendingMs, frec.sid)); // a walk that never reports its end
  }

  function give(frec, sig) {
    const giver = present(frec, sig.from);
    if (giver) {
      const h = hold(giver, frec, 'give');
      if (h) {
        h.timers.push(ctx.timers.setTimeout(() => drop(h), cfg.giveMs, frec.sid));
        ctx.sayFor(giver, ctx.line('handoffGive', undefined, giver), cfg.giveMs);
      }
    }
    const rec = present(frec, sig.to);
    if (rec) return carry(rec, frec);
    const id = `${sig.sessionId}|${sig.to}`;
    coming.set(id, { timer: ctx.timers.setTimeout(() => coming.delete(id), cfg.pendingMs, frec.sid) });
  }

  function endFlight(f) {
    f.el.remove();
    flights.delete(f);
  }

  function fly(frec, sig, plan) {
    if (reduced() || !frec.layer) return;
    const plane = sig.handoffKind === 'message';
    const el = picture(plane ? PLANE : FOLDER, plane ? 'ho-fly ho-plane' : 'ho-fly');
    const frames = flightFrames(plan, plane && plan.to[0] < plan.from[0]);
    el.style.transform = frames[0].transform;
    frec.layer.append(el);
    const f = { el, frec, plane };
    flights.add(f);
    const anim = animate(el, frames, { duration: plan.ms, fill: 'both' });
    anim.onfinish = anim.oncancel = () => endFlight(f);
  }

  function route(sig) {
    const frec = ctx.floor(sig.sessionId);
    if (!frec || !ctx.floorActive(frec)) return;
    const plan = planHandoff({
      kind: sig.handoffKind,
      fxOn: ctx.fx.fxOn(),
      rest: Boolean(ctx.view(sig.sessionId)?.rest),
      meeting: Boolean(frec.meeting),
      planesInFlight: [...flights].filter((f) => f.frec === frec && f.plane).length,
      cfg,
      from: pointOf(present(frec, sig.from)),
      to: pointOf(present(frec, sig.to)),
      door: frec.scene.r.door.at,
    });
    if (plan.action === 'give') give(frec, sig);
    else if (plan.action === 'fly') fly(frec, sig, plan);
    else if (plan.action === 'wait') waiting.set(sig, { frec, timer: ctx.timers.setTimeout(() => waiting.delete(sig), cfg.pendingMs, frec.sid) });
  }

  /** Everything of one floor (or of all) is taken down at once: the floor went off screen, the page is hidden, the effects went off. */
  function tidy(frec) {
    for (const h of [...holds]) if (!frec || h.frec === frec) drop(h);
    for (const f of [...flights]) if (!frec || f.frec === frec) endFlight(f);
    for (const [sig, w] of [...waiting]) {
      if (frec && w.frec !== frec) continue;
      ctx.timers.clearTimeout(w.timer);
      waiting.delete(sig);
    }
    if (!frec) {
      for (const c of coming.values()) ctx.timers.clearTimeout(c.timer);
      coming.clear();
    }
  }

  ctx.onServer('handoff', (sig) => {
    const frec = ctx.floor(sig.sessionId);
    if (!frec || !ctx.floorActive(frec)) return;
    // the phase signal and the meeting it starts arrive together: look at the meeting one tick later
    if (sig.handoffKind === 'phase') ctx.timers.setTimeout(() => route(sig), 0, frec.sid);
    else route(sig);
  });
  ctx.fx.onFx('state', ({ rec, from }) => { // a newcomer's first draw: the folder that was waiting for it
    if (from !== '' || !rec.frec) return;
    const id = `${rec.frec.sid}|${keyOf(rec.frec, rec)}`;
    const c = coming.get(id);
    if (!c) return;
    ctx.timers.clearTimeout(c.timer);
    coming.delete(id);
    carry(rec, rec.frec);
  });
  ctx.fx.onFx('walk-end', ({ rec }) => {
    for (const h of holds) if (h.rec === rec && h.role === 'carry') arrive(h);
  });
  ctx.fx.onFx('meeting-end', ({ floor }) => {
    for (const [sig, w] of [...waiting]) {
      if (w.frec !== floor) continue;
      ctx.timers.clearTimeout(w.timer);
      waiting.delete(sig);
      route(sig);
    }
  });
  ctx.fx.onFx('floor-hidden', ({ floor }) => tidy(floor));
  ctx.onPauseChange((paused) => paused && tidy());
  ctx.fx.onFxChange(({ fx }) => !fx && tidy());
}
