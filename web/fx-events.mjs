// Effects area "events" (celebration and status effects on each floor's .fx-layer): sparkles when a sub-agent reports to its lead,
// confetti and a title pop at the whiteboard when a workflow phase starts, sparks on a high-five, rain drops or sweat drops while
// the failure face shows, a glow when an agent finishes, and a small dot puff when one starts thinking.
//
// Everything is drawn from the office's real events (fx.mjs bus), never from a timer of its own. Particles are small <i> elements
// from a fixed pool per floor layer (ui.fx.events.pool): they are put on the layer only while they animate and taken off again
// when done, so an idle layer stays empty (and not drawn at all, see .fx-layer:empty). Only transform and opacity are animated, with
// element.animate() (compositor), so no JS runs per frame. Numbers live in config ui.fx.events, the look in fx-events.css.
//
// Pure parts (tested): createPools, plan* (what to spawn for an event), frames (the keyframes). createEvents wires them to the bus
// with injected deps (makeEl, animate, rng), init(ctx) supplies the real ones.

const SMALL_ALPHA = 0; // opacity of a particle that is not shown (before it starts, after it ends)
const FULL_ALPHA = 1;

/** A random number in [lo, hi] from the injected rng; a plain number passes through. */
export function between(rng, range) {
  return Array.isArray(range) ? range[0] + rng() * (range[1] - range[0]) : range;
}

/**
 * Pools of reusable particle elements, one per layer: take(layer) hands out an element (null when `size` are in use), give(layer, el)
 * takes it back. Elements are made lazily by makeEl and never more than `size` per layer.
 */
export function createPools(size, makeEl) {
  const pools = new WeakMap();
  const poolOf = (layer) => {
    let p = pools.get(layer);
    if (!p) pools.set(layer, (p = { free: [], made: 0, used: 0 }));
    return p;
  };
  return {
    take(layer) {
      const p = poolOf(layer);
      let el = p.free.pop();
      if (!el) {
        if (p.made >= size) return null;
        el = makeEl();
        p.made += 1;
      }
      p.used += 1;
      return el;
    },
    give(layer, el) {
      const p = poolOf(layer);
      p.used -= 1;
      p.free.push(el);
    },
    stats: (layer) => {
      const p = poolOf(layer);
      return { made: p.made, used: p.used, free: p.free.length };
    },
  };
}

/** The css transform of one keyframe: centred on its anchor, then moved, turned and scaled. */
export const tf = (dx = 0, dy = 0, rot = 0, scale = 1) => `translate(-50%, -50%) translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px) rotate(${rot.toFixed(0)}deg) scale(${scale.toFixed(2)})`;

/**
 * The keyframes of a spec (only transform and opacity ever appear). spec.motion:
 *  burst  grows out to (tx, ty), turning, and fades; arc  flies up and falls like confetti; pop  the title: pops in, holds, floats off;
 *  glow   swells and fades in place; drift  rises a little and fades (thinking dots); loop  falls from the start and repeats (rain);
 *  flick  small drop that jumps off the forehead and repeats (sweat).
 */
export function frames(spec) {
  const { tx = 0, ty = 0, rot = 0 } = spec;
  switch (spec.motion) {
    case 'burst':
      return [
        { transform: tf(0, 0, 0, 0.2), opacity: SMALL_ALPHA },
        { transform: tf(tx * 0.7, ty * 0.7, rot * 0.5, 1), opacity: FULL_ALPHA, offset: 0.35 },
        { transform: tf(tx, ty, rot, 0.1), opacity: SMALL_ALPHA },
      ];
    case 'arc':
      return [
        { transform: tf(0, 0, 0, 1), opacity: FULL_ALPHA, easing: 'ease-out' },
        { transform: tf(tx * 0.6, -spec.up, rot * 0.5, 1), opacity: FULL_ALPHA, offset: 0.35, easing: 'ease-in' },
        { transform: tf(tx, ty, rot, 1), opacity: SMALL_ALPHA },
      ];
    case 'pop':
      return [
        { transform: tf(0, spec.lift, 0, 0.3), opacity: SMALL_ALPHA },
        { transform: tf(0, 0, 0, 1.15), opacity: FULL_ALPHA, offset: spec.popAt },
        { transform: tf(0, 0, 0, 1), opacity: FULL_ALPHA, offset: spec.settleAt },
        { transform: tf(0, 0, 0, 1), opacity: FULL_ALPHA, offset: spec.fadeAt },
        { transform: tf(0, -spec.riseOut, 0, 1), opacity: SMALL_ALPHA },
      ];
    case 'glow':
      return [
        { transform: tf(0, 0, 0, spec.scaleFrom), opacity: SMALL_ALPHA },
        { transform: tf(0, 0, 0, (spec.scaleFrom + spec.scaleTo) / 2), opacity: spec.peak, offset: spec.peakAt },
        { transform: tf(0, 0, 0, spec.scaleTo), opacity: SMALL_ALPHA },
      ];
    case 'drift':
      return [
        { transform: tf(0, 0, 0, 0.6), opacity: SMALL_ALPHA },
        { transform: tf(0, ty * 0.4, 0, 1), opacity: FULL_ALPHA, offset: 0.3 },
        { transform: tf(0, ty, 0, 1), opacity: SMALL_ALPHA },
      ];
    case 'loop':
      return [
        { transform: tf(0, 0, 0, 1), opacity: SMALL_ALPHA },
        { transform: tf(0, ty * 0.1, 0, 1), opacity: FULL_ALPHA, offset: 0.15 },
        { transform: tf(0, ty, 0, 1), opacity: 0.7, offset: 0.8 },
        { transform: tf(0, ty, 0, 1), opacity: SMALL_ALPHA },
      ];
    case 'flick':
      return [
        { transform: tf(0, 0, 0, 0.6), opacity: SMALL_ALPHA },
        { transform: tf(tx * 0.3, -spec.up, 0, 1), opacity: FULL_ALPHA, offset: 0.25, easing: 'ease-in' },
        { transform: tf(tx, ty, 0, 1), opacity: SMALL_ALPHA },
      ];
    default:
      throw new Error(`unknown motion ${spec.motion}`);
  }
}

// ---- plans: what to spawn for one event, as plain specs relative to an origin (floor px). rng is injected. ----

/** Star sparkles flying out of a point. `count` overrides the configured count. */
export function planSparkle(c, rng, count = c.sparkle.count) {
  const k = c.sparkle;
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const ang = ((i + rng() * 0.6) / count) * Math.PI * 2;
    const dist = k.radiusPx * (0.5 + rng() * 0.5);
    const s = between(rng, k.sizePx);
    out.push({
      cls: 'star', motion: 'burst', x: 0, y: 0, w: s, h: s, color: k.colors[i % k.colors.length],
      tx: Math.cos(ang) * dist, ty: Math.sin(ang) * dist, rot: 90 + rng() * 180, ms: k.ms, delay: i * k.staggerMs,
    });
  }
  return out;
}

/** Confetti thrown up from a point (the whiteboard's top edge or the boss's spot). */
export function planConfetti(c, rng, count = c.confetti.count) {
  const k = c.confetti;
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const w = between(rng, k.sizePx);
    out.push({
      cls: 'rect', motion: 'arc', x: (rng() - 0.5) * k.spreadPx * 0.3, y: 0, w, h: w * 0.6, color: k.colors[Math.floor(rng() * k.colors.length)],
      tx: (rng() - 0.5) * k.spreadPx * 2, up: between(rng, k.upPx), ty: between(rng, k.fallPx), rot: (rng() < 0.5 ? -1 : 1) * between(rng, k.spinDeg),
      ms: between(rng, k.ms), delay: i * k.staggerMs,
    });
  }
  return out;
}

/** The phase title popping up over the board (one element with text). */
export function planTitle(c, title) {
  const k = c.title;
  const text = [...String(title ?? '')].slice(0, k.maxChars).join('');
  if (!text) return [];
  return [{ cls: 'title', motion: 'pop', x: 0, y: 0, text, ms: k.ms, delay: 0, popAt: k.popAt, settleAt: k.settleAt, fadeAt: k.fadeAt, riseOut: k.riseOutPx, lift: k.lift, vars: { '--fxe-bg': k.bg, '--fxe-ink': k.ink, '--fxe-ring': k.ring, '--fxe-font': `${k.fontPx}px` } }];
}

/** Short bright sparks flying out of a high-five. */
export function planHighFive(c, rng) {
  const k = c.highFive;
  const out = [];
  for (let i = 0; i < k.count; i += 1) {
    const ang = ((i + rng() * 0.5) / k.count) * Math.PI * 2;
    const dist = between(rng, k.radiusPx);
    const s = between(rng, k.sizePx);
    out.push({
      cls: 'star', motion: 'burst', x: 0, y: 0, w: s, h: s, color: k.colors[i % k.colors.length],
      tx: Math.cos(ang) * dist, ty: Math.sin(ang) * dist, rot: 120, ms: k.ms, delay: 0,
    });
  }
  return out;
}

/** Rain from the failure cloud (kind 'cloud') or sweat drops jumping off the head (kind 'sweat'); both loop until the failure ends. seated = sitting pose. */
export function planFail(c, kind, seated) {
  const out = [];
  if (kind === 'cloud') {
    const k = c.rain;
    const from = k.fromPx - (seated ? c.headStandPx - c.headSeatPx : 0);
    for (let i = 0; i < k.drops; i += 1) {
      out.push({
        cls: 'drop', motion: 'loop', loop: true, x: (i - (k.drops - 1) / 2) * k.spreadPx, y: -from, w: k.widthPx, h: k.heightPx, color: k.color,
        ty: k.fallPx, ms: k.ms, delay: i * k.staggerMs,
      });
    }
    return out;
  }
  const k = c.sweat;
  const top = c.headStandPx - (seated ? c.headStandPx - c.headSeatPx : 0);
  for (let i = 0; i < k.drops; i += 1) {
    const dir = i % 2 === 0 ? 1 : -1;
    out.push({
      cls: 'sweat', motion: 'flick', loop: true, x: k.offsetXPx * dir, y: -top + 10, w: k.sizePx, h: k.sizePx * 1.4, color: k.color,
      tx: dir * (k.dxPx[0] + (k.dxPx[1] - k.dxPx[0]) * 0.5), up: 6, ty: k.dyPx, ms: k.ms, delay: i * k.staggerMs,
    });
  }
  return out;
}

/** The glow around a finished agent, with a few sparkles. */
export function planGlow(c, rng) {
  const k = c.glow;
  const glow = { cls: 'glow', motion: 'glow', x: 0, y: 0, w: k.sizePx, h: k.sizePx, color: k.color, scaleFrom: k.scaleFrom, scaleTo: k.scaleTo, peak: k.peak, peakAt: k.peakAt, ms: k.ms, delay: 0 };
  return [glow, ...planSparkle(c, rng, k.sparkles)];
}

/** Dots rising one after another over a thinking head. */
export function planThink(c) {
  const k = c.think;
  const out = [];
  for (let i = 0; i < k.dots; i += 1) {
    out.push({ cls: 'dot', motion: 'drift', x: (i - (k.dots - 1) / 2) * k.gapPx, y: 0, w: k.sizePx, h: k.sizePx, color: k.color, ty: -k.risePx, ms: k.ms, delay: i * k.staggerMs });
  }
  return out;
}

/**
 * The area itself. ctx = FxCtx (fx.mjs); deps: makeEl() -> a bare particle element, animate(el, keyframes, options, onDone) -> cancel(), rng().
 * Returns {stats(), clearAll()} for tests and tidying.
 */
export function createEvents(ctx, deps) {
  const c = ctx.ui.fx.events;
  const pools = createPools(c.pool, deps.makeEl);
  const active = new Set(); // {el, layer, cancel}
  const fails = new Map(); // rec -> {floor, items}
  const lastThink = new WeakMap(); // rec -> ms of its last dots
  const doneWait = new Set(); // recs that finished while still walking: glow on arrival
  const offs = [];

  function release(item) {
    if (!active.delete(item)) return;
    item.cancel?.();
    const el = item.el;
    el.remove();
    el.className = 'fxe';
    el.style.cssText = '';
    el.textContent = '';
    pools.give(item.layer, el);
  }

  /** Puts one particle on the floor's layer; null when the pool is used up (the particle is simply skipped). */
  function spawn(floor, origin, spec) {
    const layer = floor.layer;
    const el = pools.take(layer);
    if (!el) return null;
    el.className = `fxe ${spec.cls}`;
    const st = el.style;
    st.left = `${(origin[0] + spec.x).toFixed(1)}px`;
    st.top = `${(origin[1] + spec.y).toFixed(1)}px`;
    if (spec.w) st.width = `${spec.w.toFixed(1)}px`;
    if (spec.h) st.height = `${spec.h.toFixed(1)}px`;
    if (spec.color) st.setProperty('--fxe-c', spec.color);
    for (const [k, v] of Object.entries(spec.vars ?? {})) st.setProperty(k, v);
    if (spec.text) el.textContent = spec.text;
    const item = { el, layer, cancel: null };
    active.add(item);
    layer.append(el);
    item.cancel = deps.animate(el, frames(spec), { duration: spec.ms, delay: spec.delay, iterations: spec.loop ? Infinity : 1, fill: 'backwards', easing: 'linear' }, () => release(item));
    return item;
  }

  const spawnAll = (floor, origin, specs) => specs.map((s) => spawn(floor, origin, s)).filter(Boolean);

  /** The floor a character stands on: floor characters carry it as rec.frec, the lobby's figures are found in the lobby's map. */
  const floorOf = (rec) => rec.frec ?? [...ctx.floors()].find((f) => [...(f.agents ?? f.chars).values()].includes(rec)) ?? null;

  /** The floor to draw on for this character, only when it can be seen right now. */
  function shownFloor(rec) {
    const f = floorOf(rec);
    return f && f.layer && ctx.floorActive(f) ? f : null;
  }

  const headOf = (rec) => [rec.x, rec.y - (rec.seated ? c.headSeatPx : c.headStandPx)];
  const bodyOf = (rec) => [rec.x, rec.y - c.bodyMidPx];

  /** Where a floor's whiteboard is (top centre), else the boss's meeting spot, else null. */
  function boardPoint(floor) {
    const f = floor.wb?.frame;
    if (f) return [f.x + f.w / 2, f.y];
    const boss = floor.scene?.raw?.meeting?.boss?.at;
    return boss ? [boss[0], boss[1] - c.headStandPx] : null;
  }

  // ---- real moments ----
  function onReport({ rec, lead }) {
    const floor = shownFloor(rec);
    if (!floor) return;
    spawnAll(floor, headOf(rec), planSparkle(c, deps.rng));
    spawnAll(floor, headOf(lead), planSparkle(c, deps.rng, c.sparkle.leadCount));
  }

  function onPhase({ floor, title }) {
    if (!floor.layer || !ctx.floorActive(floor)) return;
    const at = boardPoint(floor);
    if (!at) return;
    spawnAll(floor, [at[0], at[1] - c.title.lift], planTitle(c, title));
    spawnAll(floor, at, planConfetti(c, deps.rng));
  }

  function onMeetingStart({ floor }) {
    if (!floor.layer || !ctx.floorActive(floor)) return;
    const boss = floor.scene?.raw?.meeting?.boss?.at;
    if (boss) spawnAll(floor, [boss[0], boss[1] - c.headStandPx], planConfetti(c, deps.rng, c.confetti.meetingCount));
  }

  function onHighFive({ a, b }) {
    const floor = shownFloor(a);
    if (!floor) return;
    const [ax, ay] = bodyOf(a);
    const [bx, by] = bodyOf(b);
    spawnAll(floor, [(ax + bx) / 2, (ay + by) / 2 - c.highFive.upPx + c.bodyMidPx], planHighFive(c, deps.rng));
  }

  function stopFail(rec) {
    const f = fails.get(rec);
    if (!f) return;
    fails.delete(rec);
    for (const it of f.items) release(it);
  }

  /** Starts (or restarts at the character's current spot) the rain or sweat while its failure mood shows. */
  function startFail(rec) {
    stopFail(rec);
    if (!rec.mood || rec.walk) return;
    const floor = shownFloor(rec);
    if (!floor) return;
    const kind = rec.mood.el?.classList?.contains('cloud') ? 'cloud' : 'sweat';
    fails.set(rec, { floor, items: spawnAll(floor, [rec.x, rec.y], planFail(c, kind, !!rec.seated)) });
  }

  function glowAt(rec) {
    const floor = shownFloor(rec);
    if (floor && rec.state === 'done') spawnAll(floor, bodyOf(rec), planGlow(c, deps.rng));
  }

  function onState({ rec, from, to }) {
    doneWait.delete(rec);
    if (from === '' || rec.el?.classList?.contains('gone')) return; // the first sight of a character is not a change
    if (to === 'done') {
      // renderAgent sends the finished agent to its tray right after this event: look once it is clear whether it walks
      ctx.timers.setTimeout(() => {
        if (rec.state !== 'done') return;
        if (rec.walk) doneWait.add(rec);
        else glowAt(rec);
      }, 0);
    } else if (to === 'thinking') {
      const floor = shownFloor(rec);
      const t = ctx.now();
      if (!floor || t - (lastThink.get(rec) ?? -Infinity) < c.think.cooldownMs) return;
      lastThink.set(rec, t);
      const [x, y] = headOf(rec);
      spawnAll(floor, [x, y - c.think.sizePx], planThink(c));
    }
  }

  function onWalkEnd({ rec }) {
    if (doneWait.delete(rec)) glowAt(rec);
    else if (rec.mood) startFail(rec);
  }

  /** Takes everything of one floor off (not shown, cropped, or the floor is gone). */
  function clearFloor(floor) {
    for (const [rec, f] of [...fails]) if (f.floor === floor) stopFail(rec);
    for (const it of [...active]) if (it.layer === floor.layer) release(it);
  }

  function clearAll() {
    for (const rec of [...fails.keys()]) stopFail(rec);
    for (const it of [...active]) release(it);
    doneWait.clear();
  }

  /** Brings back what is still really going on (failure moods) after the effects, the floor or the page came back. */
  function resume(floorOnly) {
    for (const f of ctx.floors()) {
      if (floorOnly && f !== floorOnly) continue;
      for (const rec of (f.agents ?? f.chars).values()) if (rec.mood && !fails.has(rec)) startFail(rec);
    }
  }

  const { fx } = ctx;
  offs.push(fx.onFx('report', onReport));
  offs.push(fx.onFx('phase', onPhase));
  offs.push(fx.onFx('meeting-start', onMeetingStart));
  offs.push(fx.onFx('high-five', onHighFive));
  offs.push(fx.onFx('fail-start', ({ rec }) => startFail(rec)));
  offs.push(fx.onFx('fail-end', ({ rec }) => stopFail(rec)));
  offs.push(fx.onFx('state', onState));
  offs.push(fx.onFx('walk-start', ({ rec }) => stopFail(rec)));
  offs.push(fx.onFx('walk-end', onWalkEnd));
  offs.push(fx.onFx('pose', ({ rec }) => { if (fails.has(rec)) startFail(rec); }));
  offs.push(fx.onFx('floor-hidden', ({ floor }) => clearFloor(floor), { always: true }));
  offs.push(fx.onFx('floor-shown', ({ floor }) => resume(floor)));
  offs.push(fx.onFx('crop', ({ cropped, floor }) => (cropped ? clearFloor(floor) : resume(floor)), { always: true }));
  offs.push(fx.onFxChange(({ fx: on }) => (on ? resume() : clearAll())));
  offs.push(ctx.onPauseChange((paused) => (paused ? clearAll() : ctx.fx.fxOn() && resume())));

  return {
    clearAll,
    stats: () => ({ active: active.size, fails: fails.size }),
    pools,
    dispose() {
      clearAll();
      for (const off of offs) off();
    },
  };
}

/** @param {import('./fx.mjs').FxCtx} ctx */
export function init(ctx) {
  if (!ctx.ui.fx?.events?.enabled) return;
  createEvents(ctx, {
    makeEl: () => document.createElement('i'),
    animate(el, keyframes, options, onDone) {
      const a = el.animate(keyframes, options);
      a.onfinish = onDone;
      return () => {
        a.onfinish = null;
        a.cancel();
      };
    },
    rng: Math.random,
  });
}
