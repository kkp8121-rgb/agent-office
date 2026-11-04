// The night map: a night look in which the room is very dark and cool wherever no screen light reaches, and every working seat lights its own pool.
// A piece of the weather area (web/fx-weather.mjs creates it and calls it from its own sync); the numbers are config ui.fx.weather.night, the monitors' places
// are the data file assets/nightmap/nightmap.json (and the pictures <design>-mon.png / <design>-rim.png drawn from it by scripts/make-nightmap.mjs).
//
// Variants (a comparison, chosen only by ?debug=nightmap and window.__fxNight.set('v0'|'v1'|'v2'); there is no setting for it yet; the default is v0):
//   v0  today's look: the flat navy veil (.stage::after, --room-dim) and the outline face light. This module builds nothing and changes nothing.
//   v1  the veil becomes darker and cooler everywhere (cfg.outside) and every WORKING (or thinking) seat gets a pool: a hole in the veil (a mask made of one radial
//       gradient per pool, so the room's own colours show again inside it), a soft cool tint limited to the pool, and a dark copy of the monitor back above the desk
//       (so the monitor stays a dark shape inside the light). The pool is centred between the monitor and the face, falls off fast and takes in the desk and the
//       floor round it. Idle seats get no pool; the existing face light stays as it is.
//   v2  v1 plus light leaking round the monitor's edge (a thin glow in the pixels just outside the monitor, between the figure and the desk) and a flicker
//       that follows the face light's ripple (pure CSS: the same cycle length and offset as the figure's .fxw-lit).
//   v3 / v4 (next stage): a faint haze between screen and face (feature `haze`), warm pools from the room's own lamps (feature `lamps`, positions in the data file).
//       Add the variant to VARIANTS and a builder to makePool / sync below; nothing else has to change.
//
// How a pool fades in and out without animating a mask: the hole in the veil is static, and a "fill" (the veil's own colour in the shape of the hole, with the alpha
// that makes veil + fill exactly the plain veil) lies in it; the fill's opacity is what fades (1 = no pool, 0 = the full pool). The flicker is the fill's opacity too.
// Pools are recomputed only when a seat starts or stops working, a seat moves, the theme changes or the variant is switched (the pools are in floor pixels, so a
// resize or the small window needs nothing): no timer of its own besides the end of a fade, no frame loop, no canvas.
// Day mode (light theme), effects off and rooms the data file does not know: nothing is built and the page keeps its own pixels. Reduced motion: no flicker.

/** What each variant switches on: veil = darker veil with holes, pool = tint and dark monitor, rim = edge glow, flicker = the ripple. v0 is the page as it was. */
export const VARIANTS = Object.freeze({
  v0: Object.freeze({}),
  v1: Object.freeze({ veil: true, pool: true }),
  v2: Object.freeze({ veil: true, pool: true, rim: true, flicker: true }),
});

export const variantIds = () => Object.keys(VARIANTS);
export const isVariant = (id) => typeof id === 'string' && Object.hasOwn(VARIANTS, id);

const num = (n) => Number(n.toFixed(3));
const rgb = (c) => `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
const rgba = (c, a) => `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${num(a)})`;

/** The scene point (floor px) of the middle of a desk's screen back; `spec` = monitors.<design>.<kind> of the data file, `obj` = a resolved scene object. */
export function monitorSpot(obj, spec) {
  const rw = obj.rect[2];
  const left = obj.at[0] - (obj.flipX ? rw - obj.anchor[0] : obj.anchor[0]);
  const top = obj.at[1] - obj.anchor[1];
  const [x0, y0, x1, y1] = spec.screen;
  const mx = (x0 + x1) / 2;
  return [left + (obj.flipX ? rw - mx : mx), top + (y0 + y1) / 2];
}

/** The point of a seated figure's face: its feet are at (x, y), the seated picture is `sitH` tall, the face sits `faceY` of it from the top. */
export const facePoint = (rec, sitH, cfg) => [rec.x, rec.y - (1 - cfg.pool.faceY) * sitH];

/**
 * The pool of one working seat: centred `mix` of the way from the monitor to the face, an ellipse of rx x ry, and its box in whole floor pixels.
 * @returns {{cx:number, cy:number, rx:number, ry:number, x:number, y:number, w:number, h:number, deskId:string}}
 */
export function poolPlan(face, monitor, deskId, cfg) {
  const { rx, ry, mix } = cfg.pool;
  const cx = Math.round(monitor[0] + (face[0] - monitor[0]) * mix);
  const cy = Math.round(monitor[1] + (face[1] - monitor[1]) * mix);
  return { cx, cy, rx, ry, x: cx - rx, y: cy - ry, w: 2 * rx, h: 2 * ry, deskId };
}

/** A key that changes when the pool of a seat has to be drawn again. */
export const poolKey = (p) => `${p.deskId}|${p.cx}|${p.cy}`;

/** The desk id of a seated character: the lead's desk, or the desk of its seat slot (null when it has no desk). */
export function deskIdOf(rec, r) {
  if (rec.isLead) return r.lead.deskId;
  return rec.slot?.kind === 'seat' ? r.seats[rec.slot.i]?.deskId ?? null : null;
}

/** The CSS gradient of one pool inside the mask: the alpha of the hole (1 in the middle of the pool, 0 at its edge) in an ellipse that touches the box on all four sides. */
export function maskGradient(cfg) {
  const stops = cfg.pool.falloff.map(([t, h]) => `rgba(0, 0, 0, ${num(h)}) ${num(t * 100)}%`);
  return `radial-gradient(closest-side, ${stops.join(', ')})`;
}

/**
 * The veil's mask for a set of pools: the first layer is the whole veil, taken away where any pool's hole is (subtract); the holes add up (add).
 * The parts are CSS custom property values for mask-image, mask-size, mask-position and mask-composite (one entry per layer).
 */
export function maskParts(pools, cfg) {
  if (!pools.length) return { mi: 'none', ms: 'auto', mp: '0 0', mc: 'add' };
  const grad = maskGradient(cfg);
  return {
    mi: ['linear-gradient(#000, #000)', ...pools.map(() => grad)].join(', '),
    ms: ['100% 100%', ...pools.map((p) => `${p.w}px ${p.h}px`)].join(', '),
    mp: ['0 0', ...pools.map((p) => `${p.x}px ${p.y}px`)].join(', '),
    mc: ['subtract', ...pools.map(() => 'add')].join(', '),
  };
}

/**
 * The fill of a pool: the veil's colour with the alpha b(t) such that veil (opacity o x (1 - h)) and fill (b) together are exactly the plain veil's o:
 * 1 - (1 - o(1 - h))(1 - b) = o  =>  b = 1 - (1 - o) / (1 - o(1 - h)).
 */
export function fillGradient(cfg) {
  const { color, opacity: o } = cfg.outside;
  const stops = cfg.pool.falloff.map(([t, h]) => `${rgba(color, 1 - (1 - o) / (1 - o * (1 - h)))} ${num(t * 100)}%`);
  return `radial-gradient(closest-side, ${stops.join(', ')})`;
}

/** The cool tint of a pool: a gradient of cfg.tint.color, strongest in the middle, nothing at the edge (blended into what lies below it, cfg.tint.blend). */
export function tintGradient(cfg) {
  const { color, alpha } = cfg.tint;
  const stops = cfg.pool.falloff.map(([t, h]) => `${rgba(color, alpha * h)} ${num(t * 100)}%`);
  return `radial-gradient(closest-side, ${stops.join(', ')})`;
}

/** The box of the tint of a pool: the pool's ellipse scaled about its centre by cfg.tint.scale. */
export function tintBox(p, cfg) {
  const rx = Math.round(p.rx * cfg.tint.scale);
  const ry = Math.round(p.ry * cfg.tint.scale);
  return { x: p.cx - rx, y: p.cy - ry, w: 2 * rx, h: 2 * ry };
}

/** The custom properties of the night map that sit on a stage: the veil's colour and opacity, and the mask. */
export function stageVars(pools, cfg) {
  const m = maskParts(pools, cfg);
  return { '--fxn-veil': rgb(cfg.outside.color), '--fxn-o': String(cfg.outside.opacity), '--fxn-dim': String(cfg.flicker.dim), '--fxn-mi': m.mi, '--fxn-ms': m.ms, '--fxn-mp': m.mp, '--fxn-mc': m.mc };
}

// ---------------------------------------------------------------- DOM part

const CLS = { tint: 'fxn-t', fill: 'fxn-f', mon: 'fxn-m', rim: 'fxn-r' };

/**
 * Creates the night map. deps: ctx (the effects' ctx), cfg (ui.fx.weather.night), doc, modeOf(rec) -> 'work'|'rest'|'' (the face light's own decision),
 * timingOf(rec) -> {ms, delay} (CSS time strings of the figure's ripple) or null, resync() -> asks the weather area for a sync, debug -> true under ?debug=nightmap.
 */
export function createNightmap({ ctx, cfg, doc, modeOf, timingOf, resync, debug }) {
  let variantId = 'v0';
  let data = null; // the data file, loaded the first time a variant other than v0 is chosen
  let loading = false;
  let observer = null;
  let lastDark = null;
  const baseUrl = cfg.dataUrl.replace(/[^/]*$/, '');
  const floors = new Map(); // floor record -> {stage, pools: Map(rec -> pool), leaving: Set(pool), timers: Set, mask: string}
  const reduced = () => !!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const dark = () => Number.parseFloat(globalThis.getComputedStyle(doc.documentElement).getPropertyValue('--room-dim')) > 0;
  const features = () => VARIANTS[variantId];
  const gradients = { fill: fillGradient(cfg), tint: tintGradient(cfg) };
  const px = (n) => `${n}px`;

  function load() {
    if (data || loading) return;
    loading = true;
    fetch(cfg.dataUrl)
      .then((r) => r.json())
      .then((d) => {
        data = d;
        resync();
      })
      .catch(() => {
        loading = false; // no data file: the night keeps its old look
      });
  }

  /** One absolutely placed div of a pool. */
  function box(cls, b, z) {
    const e = doc.createElement('div');
    e.className = cls;
    Object.assign(e.style, { left: px(b.x), top: px(b.y), width: px(b.w), height: px(b.h), zIndex: String(z) });
    return e;
  }

  function makePool(st, floor, rec, plan, deskObj) {
    const f = features();
    const t = timingOf(rec);
    const els = [];
    const add = (e, o) => {
      st.stage.append(e);
      els.push(e);
      e.dataset.on = '0';
      if (o !== undefined) e.style.setProperty('--fxn-o', String(o));
      if (t) {
        e.style.setProperty('--fxn-t', t.ms);
        e.style.setProperty('--fxn-delay', t.delay);
      }
      return e;
    };
    add(box(CLS.fill, plan, 7500)).style.backgroundImage = gradients.fill;
    if (f.pool) {
      const tint = add(box(CLS.tint, tintBox(plan, cfg), 7400), 1);
      tint.style.backgroundImage = gradients.tint;
      tint.style.mixBlendMode = cfg.tint.blend;
      for (const n of floor.scene.nodes.filter((x) => x.objId === deskObj.id)) {
        const nb = { x: n.x, y: n.y, w: n.w, h: n.h };
        const layer = (cls, z, o, file) => {
          const e = add(box(cls, nb, z), o);
          e.style.backgroundImage = `url(${baseUrl}${floor.design}-${file}.png)`;
          e.style.backgroundPosition = `${-n.bgX}px ${-n.bgY}px`;
        };
        layer(CLS.mon, n.z + 1, cfg.monitor.opacity, 'mon');
        if (f.rim) layer(CLS.rim, n.z - 1, cfg.rim.opacity, 'rim');
      }
    }
    return { rec, plan, key: poolKey(plan), els, on: false };
  }

  function setOn(pool, on) {
    pool.on = on;
    for (const e of pool.els) e.dataset.on = on ? '1' : '0';
  }

  /** The veil's mask and colour for the pools of a floor (the ones fading out keep their hole until they are gone). */
  function applyMask(st) {
    const vars = stageVars([...st.pools.values(), ...st.leaving].map((p) => p.plan), cfg);
    const sig = JSON.stringify(vars);
    if (sig === st.mask) return;
    st.mask = sig;
    for (const [k, v] of Object.entries(vars)) st.stage.style.setProperty(k, v);
  }

  function clearStage(st) {
    for (const timer of st.timers) ctx.timers.clearTimeout(timer);
    for (const pool of [...st.pools.values(), ...st.leaving]) for (const e of pool.els) e.remove();
    st.timers.clear();
    st.pools.clear();
    st.leaving.clear();
    st.stage.classList.remove('fxn-on', 'fxn-fl');
    for (const k of ['--fxn-veil', '--fxn-o', '--fxn-dim', '--fxn-mi', '--fxn-ms', '--fxn-mp', '--fxn-mc', '--fxn-fade']) st.stage.style.removeProperty(k);
  }

  /** A pool that is no longer wanted fades out and is taken away (hole and elements) when the fade is over. */
  function retire(st, pool) {
    st.pools.delete(pool.rec);
    if (!pool.on) {
      for (const e of pool.els) e.remove();
      return;
    }
    setOn(pool, false);
    st.leaving.add(pool);
    const timer = ctx.timers.setTimeout(() => {
      st.timers.delete(timer);
      st.leaving.delete(pool);
      for (const e of pool.els) e.remove();
      applyMask(st);
    }, cfg.fadeMs + 60);
    st.timers.add(timer);
  }

  /** The pools a floor wants right now: working seats at a desk the data file knows, each with its plan. */
  function wanted(floor) {
    const r = floor.scene.r;
    const sitH = ctx.server.sitHeight;
    const out = new Map();
    for (const rec of ctx.chars(floor)) {
      if (modeOf(rec) !== 'work') continue;
      const obj = r.objects.find((o) => o.id === deskIdOf(rec, r));
      const spec = data.monitors[floor.design][obj?.kind];
      if (obj && spec) out.set(rec, { plan: poolPlan(facePoint(rec, sitH, cfg), monitorSpot(obj, spec), obj.id, cfg), obj });
    }
    return out;
  }

  /** Called by the weather area after it synced the face lights of a floor. */
  function sync(floor) {
    let st = floors.get(floor);
    const active = variantId !== 'v0' && !!floor.stage && !floor.off && !!data?.monitors?.[floor.design] && ctx.fx.fxOn() && dark();
    if (!active) {
      if (st) {
        clearStage(st);
        floors.delete(floor);
      }
      return;
    }
    if (!st) floors.set(floor, (st = { stage: floor.stage, pools: new Map(), leaving: new Set(), timers: new Set(), mask: '' }));
    const want = wanted(floor);
    st.stage.classList.add('fxn-on');
    st.stage.classList.toggle('fxn-fl', !!features().flicker && !reduced());
    st.stage.style.setProperty('--fxn-fade', `${cfg.fadeMs}ms`);
    for (const pool of [...st.pools.values()]) {
      const w = want.get(pool.rec);
      if (!w || poolKey(w.plan) !== pool.key) retire(st, pool);
    }
    const fresh = [];
    for (const [rec, w] of want) {
      if (st.pools.has(rec)) continue;
      const pool = makePool(st, floor, rec, w.plan, w.obj);
      st.pools.set(rec, pool);
      fresh.push(pool);
    }
    applyMask(st);
    if (fresh.length) {
      void st.stage.offsetWidth; // one reflow so the first change of opacity is a fade
      for (const pool of fresh) setOn(pool, true);
    }
  }

  function tidy() {
    for (const st of floors.values()) clearStage(st);
    floors.clear();
  }

  function drop(floor) {
    const st = floors.get(floor);
    if (st) clearStage(st);
    floors.delete(floor);
  }

  function setVariant(id) {
    if (!isVariant(id)) return false;
    if (id === variantId) return true;
    variantId = id;
    tidy();
    if (id !== 'v0') {
      load();
      if (!observer && typeof MutationObserver === 'function') {
        // the theme changes the veil (--room-dim on the root): sync again when dark mode turns on or off
        observer = new MutationObserver(() => {
          const d = dark();
          if (d !== lastDark) {
            lastDark = d;
            resync();
          }
        });
        observer.observe(doc.documentElement, { attributes: true, attributeFilter: ['style', 'data-theme'] });
      }
      lastDark = dark();
    }
    resync();
    return true;
  }

  if (debug) {
    globalThis.__fxNight = {
      variant: () => variantId,
      variants: variantIds,
      set: setVariant,
      ready: () => !!data,
      /** the pools of every floor that has some: [{design, shown, pools: [{cx, cy, rx, ry, x, y, w, h, deskId, on}]}] */
      pools: () => [...floors].map(([floor, st]) => ({ design: floor.design, shown: !!floor.stage?.offsetParent, pools: [...st.pools.values()].map((p) => ({ ...p.plan, on: p.on })) })),
    };
  }

  return { sync, tidy, drop, setVariant, variant: () => variantId };
}
