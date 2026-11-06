// Area "incidents": what happens on a floor when a usage limit sends it to lunch and when a compaction makes someone faint.
//  - Information marks are always drawn, effects on or off: the lunch veil and sign, the tab marks, a line in a speech bubble.
//  - Decoration and motion only while the effects are on: the napping pose, the fall and the notepad.
//  - Nothing here loops by itself: every timer is ctx.timers.setTimeout of a floor that is shown, and a gesture is held through ctx.gesture.
// The rules are pure (web/incident-view.mjs, tested); this file is the DOM glue. Looks: web/incidents.css (classes ic-*).

import { restDim, restSignText, faintPlan, faintTotalMs } from './incident-view.mjs';

const PROPS = '/assets/props/';

function make(tag, className) {
  const e = document.createElement(tag);
  e.className = className;
  return e;
}

function prop(name, className) {
  const img = make('img', `ic-prop ${className}`);
  img.src = `${PROPS}${name}.png`;
  img.alt = '';
  img.draggable = false;
  return img;
}

const isDark = () => {
  const theme = document.documentElement.dataset.theme;
  return theme ? theme === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
};

/** @param {import('./fx.mjs').FxCtx} ctx */
export function init(ctx) {
  const { fx, ui } = ctx;
  const restCfg = ui.rest;
  const faintCfg = ui.faint;
  const floors = new Map(); // sessionId -> what this area keeps for the floor
  const lastFaint = new WeakMap(); // character record -> when it fainted
  const faints = new Map(); // character record -> {token, timer, notepad, notepadTimer}
  const pendingFaint = new Map(); // character record -> sessionId, waiting for a meeting on that floor to end
  let lastList = [];

  const lead = (frec) => frec.agents.get('lead') ?? null;
  const say = (rec, key) => ctx.sayFor(rec, ctx.line(key, undefined, rec), ui.officeLife.sayMs);

  // ---------- state of one floor ----------

  function stateOf(frec) {
    let st = floors.get(frec.sid);
    if (st && st.frec !== frec) { // the floor was built again under the same id
      endRest(st);
      floors.delete(frec.sid);
      st = null;
    }
    if (!st) {
      st = { frec, restOn: false, restSeen: false, veil: null, sign: null, naps: new Map() };
      floors.set(frec.sid, st);
    }
    return st;
  }

  // ---------- lunch break ----------

  const nightOn = (frec) => frec.stage.classList.contains('fxn-on');

  function paintRest(st, rest) {
    const { frec } = st;
    if (!st.veil) {
      st.veil = make('div', 'ic-veil');
      st.sign = make('div', 'ic-rest-sign');
      const [bx, by, , bh] = frec.scene.r.board;
      st.sign.style.left = `${bx}px`;
      st.sign.style.top = `${by + bh}px`;
      st.sign.hidden = true;
      frec.stage.append(st.veil, st.sign);
    }
    st.veil.classList.toggle('ic-on', Boolean(rest));
    if (!rest) {
      st.sign.hidden = true;
      return;
    }
    st.veil.style.setProperty('--ic-dim', String(restDim(restCfg, { dark: isDark(), night: nightOn(frec) })));
    const text = restSignText(restCfg, rest);
    if (st.sign.textContent !== text) st.sign.textContent = text;
    st.sign.hidden = false;
  }

  function holdRest(st) {
    const here = new Set(st.frec.agents.values());
    for (const [rec, held] of st.naps) {
      if (here.has(rec)) continue;
      ctx.gesture.release(held.token);
      st.naps.delete(rec);
    }
    for (const rec of here) {
      let held = st.naps.get(rec);
      if (!held) {
        const token = ctx.gesture.acquire(rec, 'rest');
        if (!token) continue;
        held = { token, nap: false };
        st.naps.set(rec, held);
      }
      const nap = fx.fxOn() && rec.seated;
      if (nap !== held.nap) {
        rec.body.classList.toggle('ic-nap', nap);
        held.nap = nap;
      }
    }
  }

  function endRest(st) {
    for (const [rec, held] of st.naps) {
      rec.body.classList.remove('ic-nap');
      ctx.gesture.release(held.token);
    }
    st.naps.clear();
  }

  function syncRest(st, rest) {
    paintRest(st, rest);
    const active = ctx.floorActive(st.frec);
    const rec = lead(st.frec);
    if (rest) {
      holdRest(st);
      if (!st.restOn && st.restSeen && active && rec) say(rec, 'restStart');
    } else if (st.restOn) {
      endRest(st);
      if (active && rec) say(rec, 'restEnd');
    }
    st.restOn = Boolean(rest);
    st.restSeen = true;
  }

  // ---------- the faint after a compaction ----------

  function endFaint(rec) {
    const f = faints.get(rec);
    if (!f) return;
    faints.delete(rec);
    if (f.timer) ctx.timers.clearTimeout(f.timer);
    if (f.notepadTimer) ctx.timers.clearTimeout(f.notepadTimer);
    rec.body.classList.remove('ic-faint');
    f.notepad?.remove();
    if (f.token) ctx.gesture.release(f.token);
  }

  function startFaint(frec, rec) {
    if (rec.walk) ctx.freeze(rec); // it faints where it stands
    const token = ctx.gesture.acquire(rec, 'faint');
    if (!token) return;
    const total = faintTotalMs(faintCfg.downMs);
    const f = { token, timer: 0, notepad: null, notepadTimer: 0 };
    faints.set(rec, f);
    rec.body.style.setProperty('--ic-faint-ms', `${total}ms`);
    rec.body.classList.add('ic-faint');
    ctx.gesture.onPreempt(token, () => {
      f.token = null;
      endFaint(rec);
    });
    f.timer = ctx.timers.setTimeout(() => {
      f.timer = 0;
      rec.body.classList.remove('ic-faint');
      ctx.gesture.release(f.token);
      f.token = null;
      f.notepad = prop('notepad', 'ic-notepad');
      rec.tagRoot.append(f.notepad);
      say(rec, 'compactWake');
      f.notepadTimer = ctx.timers.setTimeout(() => endFaint(rec), faintCfg.notepadMs, frec.sid);
    }, total, frec.sid);
  }

  function onCompact({ sessionId, agent }) {
    const frec = ctx.floor(sessionId);
    if (!frec || !ctx.floorActive(frec)) return;
    const rec = frec.agents.get(agent);
    if (!rec) return;
    const plan = faintPlan({ fxOn: fx.fxOn(), rest: floors.get(sessionId)?.restOn, lastAt: lastFaint.get(rec), now: ctx.now(), cooldownMs: faintCfg.cooldownMs });
    if (plan === 'skip') return;
    lastFaint.set(rec, ctx.now());
    if (plan === 'say') return say(rec, 'compactWake');
    if (frec.meeting) pendingFaint.set(rec, sessionId); // after the meeting
    else startFaint(frec, rec);
  }

  // ---------- tab marks ----------

  function drawTabs(list) {
    const buttons = new Map([...document.querySelectorAll('#tab-list > button')].map((b) => [b.textContent, b]));
    for (const view of list) {
      const b = buttons.get(String(view.floorNo));
      if (!b) continue;
      b.classList.toggle('ic-tab-rest', Boolean(view.rest));
    }
  }

  // ---------- wiring ----------

  function drawFloors(list) {
    const ids = new Set();
    for (const view of list) {
      const frec = ctx.floor(view.sessionId);
      if (!frec) continue;
      ids.add(view.sessionId);
      const st = stateOf(frec);
      syncRest(st, view.rest ?? null);
    }
    for (const [sid, st] of [...floors]) {
      if (ids.has(sid)) continue;
      endRest(st);
      floors.delete(sid);
    }
  }

  ctx.onState((list) => {
    lastList = list;
    drawFloors(list);
    drawTabs(list);
  });

  ctx.onServer('compact', onCompact);

  fx.onFx('meeting-end', ({ floor }) => {
    for (const [rec, sid] of [...pendingFaint]) {
      if (sid !== floor.sid) continue;
      pendingFaint.delete(rec);
      if (ctx.floorActive(floor)) startFaint(floor, rec);
    }
  });

  fx.onFx('floor-hidden', ({ floor, removed }) => {
    for (const [rec, sid] of [...pendingFaint]) if (sid === floor.sid) pendingFaint.delete(rec);
    if (removed) floors.delete(floor.sid);
  }, { always: true });

  fx.onFx('floor-shown', () => drawFloors(lastList), { always: true });

  fx.onFxChange(({ fx: on }) => {
    if (on) return drawFloors(lastList);
    for (const st of floors.values()) {
      for (const [rec, held] of st.naps) {
        rec.body.classList.remove('ic-nap');
        held.nap = false;
      }
    }
    for (const rec of [...faints.keys()]) endFaint(rec);
    pendingFaint.clear();
  });

}
