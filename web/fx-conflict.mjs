// Effects area "conflict" (feature 16): two floors editing the same file.
//   always (information): a marker next to the floor's name plate (ctx.signSlot 'conflict'), a small tag over the person who edited last,
//     one speech bubble when the conflict is raised live, and the warning lamp on the lobby wall (lit while any conflict stands).
//   effects on (decoration, motion): the paper in the person's hand, and every ui.conflict.tugEveryMs a short pull-back (CSS keyframes on
//     .fx-move) for ui.conflict.tugMs, taken from the gesture arbiter ('tug'); the lamp blinks. Only on shown floors, with ctx.timers.
// Rules are pure (web/conflict-view.mjs, tests/conflict-view.test.mjs); this file is the DOM glue.
import { lampState, peerFloors, personMarks, tagLabel, tugAllowed } from './conflict-view.mjs';

const PROP_URL = '/assets/props/';
const SAY_SHARE = 2; // a bubble stays half of the pause between two pulls

/** @param {import('./fx.mjs').FxCtx} ctx */
export function init(ctx) {
  const cfg = ctx.ui.conflict;
  if (!cfg) return;
  const { fx } = ctx;
  const entries = new Map(); // character rec -> {rec, frec, sid, id, tag, prop, timer, endTimer, token}
  const signs = new Map(); // floor rec -> its marker in the name plate slot
  const meetings = new Set(); // floor recs that hold a workflow meeting now
  const said = new Set(); // `${sid}|${key}|${id}`: the live bubble was spoken
  const live = new Set(); // conflict ids raised by a live signal
  let lamp = null; // {el}
  let lastList = [];

  const viewOf = (sid) => ctx.view(sid);

  function mk(tag, cls) {
    const e = document.createElement(tag);
    e.className = cls;
    return e;
  }

  // ---------- tug ----------
  function stopTug(e) {
    if (e.endTimer) ctx.timers.clearTimeout(e.endTimer);
    e.endTimer = 0;
    e.rec.fxMove.classList.remove('cf-tugging');
    e.prop?.classList.remove('cf-tugging');
    if (e.token) ctx.gesture.release(e.token);
    e.token = null;
  }

  function cancelTimers(e) {
    if (e.timer) ctx.timers.clearTimeout(e.timer);
    e.timer = 0;
    stopTug(e);
  }

  function plan(e) { // the next pull, only while the effects are on and the floor is shown
    if (e.timer || e.token || !fx.fxOn() || !e.prop || !ctx.floorActive(e.frec)) return;
    e.timer = ctx.timers.setTimeout(() => pull(e), cfg.tugEveryMs, e.sid);
  }

  function pull(e) {
    e.timer = 0;
    if (entries.get(e.rec) !== e || !fx.fxOn() || !ctx.floorActive(e.frec)) return;
    const { rec } = e;
    const busy = rec.walk || rec.trip || rec.away || rec.grab || rec.play;
    if (busy || !tugAllowed(ctx.ui.gesture.priority, ctx.gesture.current(rec), meetings.has(e.frec))) return plan(e);
    const token = ctx.gesture.acquire(rec, 'tug');
    if (!token) return plan(e);
    e.token = token;
    ctx.gesture.onPreempt(token, () => stopTug(e));
    rec.fxMove.style.setProperty('--cf-tug-ms', `${cfg.tugMs}ms`);
    e.prop.style.setProperty('--cf-tug-ms', `${cfg.tugMs}ms`);
    rec.fxMove.classList.add('cf-tugging');
    e.prop.classList.add('cf-tugging');
    e.endTimer = ctx.timers.setTimeout(() => {
      e.endTimer = 0;
      stopTug(e);
      plan(e);
    }, cfg.tugMs, e.sid);
  }

  // ---------- people ----------
  function drop(e) {
    cancelTimers(e);
    e.tag?.remove();
    e.prop?.remove();
    entries.delete(e.rec);
  }

  function person(rec, frec, fv, key, id) {
    let e = entries.get(rec);
    if (e && e.id !== id) {
      drop(e);
      e = null;
    }
    if (!e) {
      e = { rec, frec, sid: fv.sessionId, id, tag: null, prop: null, timer: 0, endTimer: 0, token: null };
      entries.set(rec, e);
    }
    const marks = personMarks(fx.fxOn(), id);
    const text = tagLabel(cfg.tagText, peerFloors(fv, id, viewOf));
    if (marks.tag && !e.tag) {
      e.tag = mk('div', 'cf-tag');
      rec.tagRoot.append(e.tag);
    }
    if (e.tag && e.tag.textContent !== text) e.tag.textContent = text;
    if (e.tag) e.tag.hidden = text === '';
    if (marks.prop && !e.prop) {
      e.prop = mk('img', 'cf-prop');
      e.prop.src = `${PROP_URL}tug-paper.png`;
      e.prop.alt = '';
      rec.tagRoot.append(e.prop);
    } else if (!marks.prop && e.prop) {
      cancelTimers(e);
      e.prop.remove();
      e.prop = null;
    }
    plan(e);
    const mark = `${fv.sessionId}|${key}|${id}`;
    if (live.has(id) && !said.has(mark) && ctx.floorActive(frec)) {
      said.add(mark);
      ctx.sayFor(rec, ctx.line('conflictTug', undefined, rec), cfg.tugEveryMs / SAY_SHARE);
    }
  }

  // ---------- name plate marker ----------
  function sign(frec, fv) {
    const slot = ctx.signSlot(frec, 'conflict');
    if (!slot) return;
    const has = fv.conflicts.length > 0;
    slot.hidden = !has;
    let s = signs.get(frec);
    if (!has) {
      s?.remove();
      signs.delete(frec);
      return;
    }
    if (!s) {
      s = mk('span', 'cf-sign');
      const img = mk('img', 'cf-sign-lamp');
      img.src = `${PROP_URL}warn-lamp-on.png`;
      img.alt = '';
      s.append(img, mk('span', 'cf-sign-text'));
      slot.append(s);
      signs.set(frec, s);
    }
    const text = tagLabel(cfg.tagText, peerFloors(fv, null, viewOf));
    const t = s.lastChild;
    if (t.textContent !== text) t.textContent = text;
  }

  // ---------- lobby lamp ----------
  function blink() {
    if (lamp) lamp.el.dataset.blink = fx.fxOn() && ctx.floorActive(ctx.lobby()) ? '1' : '0';
  }

  function syncLamp(list) {
    const st = lampState(list, cfg.lobbyLampAt);
    const lb = ctx.lobby();
    if (!st || !lb) {
      lamp?.el.remove();
      lamp = null;
      return;
    }
    if (!lamp) {
      const el = mk('div', 'cf-lamp');
      const off = mk('img', 'cf-lamp-off');
      const on = mk('img', 'cf-lamp-on');
      off.src = `${PROP_URL}warn-lamp-off.png`;
      on.src = `${PROP_URL}warn-lamp-on.png`;
      off.alt = on.alt = '';
      el.append(off, on);
      lb.stage.append(el);
      lamp = { el };
    }
    const [x, y] = st.at;
    const [w, h] = cfg.lobbyLampSize;
    Object.assign(lamp.el.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
    lamp.el.style.setProperty('--cf-blink-ms', `${cfg.blinkMs}ms`);
    lamp.el.dataset.on = st.on ? '1' : '0';
    blink();
  }

  // ---------- state ----------
  function sync(list) {
    lastList = list;
    const seen = new Set();
    for (const fv of list) {
      const frec = ctx.floor(fv.sessionId);
      if (!frec) continue;
      sign(frec, fv);
      for (const [key, a] of [['lead', fv.lead], ...fv.agents.map((x) => [x.key, x])]) {
        const rec = frec.agents.get(key);
        if (!rec || !a.conflict) continue;
        seen.add(rec);
        person(rec, frec, fv, key, a.conflict);
      }
    }
    for (const e of [...entries.values()]) if (!seen.has(e.rec)) drop(e);
    for (const [frec, s] of [...signs]) {
      if (!frec.el.isConnected) {
        s.remove();
        signs.delete(frec);
      }
    }
    syncLamp(list);
  }

  const resync = () => sync(lastList);
  ctx.onState(sync);
  ctx.onServer('conflict', (d) => {
    live.add(d.id);
    resync();
  });
  fx.onFx('meeting-start', (d) => meetings.add(d.floor), { always: true });
  fx.onFx('meeting-end', (d) => meetings.delete(d.floor), { always: true });
  const wake = () => {
    for (const e of entries.values()) {
      if (ctx.floorActive(e.frec)) plan(e);
      else cancelTimers(e);
    }
    blink();
  };
  fx.onFx('floor-shown', wake, { always: true });
  fx.onFx('floor-hidden', wake, { always: true });
  ctx.onPauseChange(wake);
  fx.onFxChange(resync);
}
