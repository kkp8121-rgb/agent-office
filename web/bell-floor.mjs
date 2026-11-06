// Effects area "bell-floor": the meeting bell on every floor and the bell meeting it starts. Classes: mb-*, looks in web/bell-floor.css, rules in web/bellmeeting.mjs.
//   The bell hangs on a cord from the ceiling of the room (ui.bellMeeting.at[design] = [cord x, bell top y, ceiling y]; the picture sizes are ui.bellMeeting.art).
//   A press on the bell gathers the floor at its meeting spots (the one meeting machine, ctx.meeting); the lead chairs from the boss spot, every speaker says what
//   their bubble shows (or the idle line), the lead closes, everybody walks back, and the bell shows its ringing picture meanwhile. A refused press (a phase meeting
//   runs, the floor is at lunch, the lead is alone) only shows a sign.
// Information (the button, the sign) is drawn with the effects off too. Every timer is the office's, with the floor id.
import { ringDecision, nearestSpot, planBell } from './bellmeeting.mjs';
import { LOBBY_ID } from './view.mjs';

const PROPS = '/assets/props/';

/** @param {import('./fx.mjs').FxCtx} ctx */
export function init(ctx) {
  const { fx, timers } = ctx;
  const doc = globalThis.document;
  const mk = (tag, cls) => {
    const e = doc.createElement(tag);
    e.className = cls;
    return e;
  };
  const sessionFloors = () => [...ctx.floors()].filter((f) => f.sid !== LOBBY_ID);

  const flows = new Map(); // sid -> the running bell meeting {ids: timers}
  const lastRing = new Map(); // sid -> when the bell was pressed
  const bells = new Map(); // floor record -> {btn, img, sign, signTimer}

  // ---------- one run of timed steps (every timer is the office's, with the floor id; stopping it drops them all) ----------

  function makeFlow(floorId) {
    const flow = { ids: new Set() };
    flow.at = (ms, fn) => {
      const t = timers.setTimeout(() => {
        flow.ids.delete(t);
        fn();
      }, ms, floorId);
      flow.ids.add(t);
    };
    flow.stop = () => {
      for (const t of flow.ids) timers.clearTimeout(t);
      flow.ids.clear();
    };
    return flow;
  }

  // ---------- the bell of each floor ----------

  /** True when the lead is the only one on the floor: a bell meeting needs staff. */
  const isAlone = (frec) => !ctx.life.members(frec).some((r) => !r.isLead);

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
      const { art } = bm;
      const sc = art.scale;
      let b = bells.get(f);
      if (!at) {
        if (b) {
          b.btn.remove();
          bells.delete(f);
        }
        continue;
      }
      if (!b) {
        const btn = mk('button', 'mb-bell');
        btn.type = 'button';
        const img = mk('img', 'mb-bell-img');
        img.src = `${PROPS}bell-hang.png`;
        img.alt = '';
        img.draggable = false;
        img.style.width = `${art.w * sc}px`;
        img.style.height = `${art.h * sc}px`;
        const cord = mk('span', 'mb-bell-cord'); // the cord tile repeats from the bell up to the ceiling
        cord.style.left = `${(art.attachX - (art.cordW - 1) / 2) * sc}px`;
        cord.style.width = `${art.cordW * sc}px`;
        cord.style.height = `${at[1] - at[2]}px`;
        cord.style.backgroundImage = `url(${PROPS}bell-hang-cord.png)`;
        cord.style.backgroundSize = `${art.cordW * sc}px ${art.cordH * sc}px`;
        const sign = mk('div', 'mb-bell-sign');
        sign.hidden = true;
        btn.append(cord, img, sign);
        btn.style.left = `${at[0] - art.attachX * sc}px`;
        btn.style.top = `${at[1]}px`;
        btn.addEventListener('click', () => onBell(f));
        f.stage.append(btn);
        b = { btn, img, sign, signTimer: 0 };
        bells.set(f, b);
      }
      const view = ctx.view(f.sid);
      const shown = ctx.floorActive(f) && f.status !== 'leaving';
      if (b.btn.hidden === shown) b.btn.hidden = !shown;
      b.btn.classList.toggle('mb-bell-rest', Boolean(view?.rest));
      b.btn.classList.toggle('mb-bell-alone', isAlone(f));
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
    if (b) b.img.src = `${PROPS}${ringing ? 'bell-hang-ring' : 'bell-hang'}.png`;
  };

  // ---------- the bell meeting ----------

  function onBell(frec) {
    const sid = frec.sid;
    const d = ringDecision({
      phaseActive: ctx.meeting.active(frec) === 'phase', bellActive: ctx.meeting.active(frec) === 'bell' || flows.has(sid), lunch: Boolean(ctx.view(sid)?.rest), alone: isAlone(frec),
      offFloor: !ctx.floorActive(frec) || frec.status === 'leaving', now: ctx.now(), lastRingAt: lastRing.get(sid) ?? null,
    }, ctx.ui.bellMeeting);
    if (!d.ok) {
      if (d.sign) flashSign(frec, d.sign);
      return;
    }
    lastRing.set(sid, ctx.now());
    startBell(frec);
  }

  /** Drops the bell meeting's timers and the ringing picture of floor `sid`. */
  function endFlow(sid) {
    const flow = flows.get(sid);
    if (!flow) return;
    flow.stop();
    flows.delete(sid);
    const frec = ctx.floor(sid);
    if (frec) ringPicture(frec, false);
  }

  function startBell(frec) {
    const sid = frec.sid;
    const bm = ctx.ui.bellMeeting;
    const flow = makeFlow(sid);
    flows.set(sid, flow);
    ringPicture(frec, true);
    const heard = new Map([...frec.agents.values()].map((r) => [r, bubbleOf(r)])); // what each says is what the bubble shows now
    const mt = ctx.meeting.start(frec, {
      kind: 'bell',
      onHold(m) {
        const spots = frec.scene.raw.meeting.spots;
        const people = [...m.members].map((r) => ({ id: r, isLead: r.isLead, spot: nearestSpot(spots, r.x, r.y), bubble: heard.get(r) ?? '' }));
        const plan = planBell(people, { bm, lines: { idle: ctx.line('bellMeetingIdle'), close: ctx.line('bellMeetingClose') } });
        const lead = [...m.members].find((r) => r.isLead) ?? null;
        const say = (rec, text) => {
          if (rec && m.members.has(rec)) ctx.sayFor(rec, text, bm.sayMs);
        };
        for (const s of plan.slots) flow.at(s.atMs, () => say(s.id, s.text));
        flow.at(plan.close.atMs, () => say(lead, plan.close.text));
        flow.at(plan.totalMs, () => ctx.meeting.end(frec));
      },
      onEnd: () => endFlow(sid),
      onSwitch: () => endFlow(sid), // a workflow phase took the meeting over: the lead announces it
    });
    if (!mt) endFlow(sid); // nobody to hold a meeting with (no spots, an empty floor)
  }

  // ---------- keeping the picture in step with the state ----------

  function onFloorEvent({ floor, removed }) {
    const sid = floor.sid;
    if (sid === LOBBY_ID) return;
    if (removed || !ctx.floorActive(floor)) endFlow(sid);
    if (removed) {
      bells.get(floor)?.btn.remove();
      bells.delete(floor);
      lastRing.delete(sid);
    }
    syncBells();
  }

  ctx.onState(() => syncBells());
  for (const name of ['floor-shown', 'floor-hidden']) fx.onFx(name, (d) => {
    if (name === 'floor-hidden') onFloorEvent(d);
    else syncBells();
  }, { always: true });
  fx.onFxChange(() => syncBells());
  syncBells();
}
