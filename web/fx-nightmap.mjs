// The real night (「실감 나는 밤」): at night the room is dark and cool wherever no light reaches, every lit seat (working, thinking or idle at its desk) lights its own pool with the light of its screen,
// and the lamps the room art draws as lit warm the places round them. A piece of the weather area (web/fx-weather.mjs creates it, calls it from its own sync and turns it
// on and off with the viewer's night light choice, setting 「밤 모니터 빛」). The numbers are config ui.fx.weather.night, the places of monitors and lamps are the data file
// assets/nightmap/nightmap.json (keyed by room design, the lobby too) and the pictures <design>-mon.png / <design>-rim.png drawn from it by scripts/make-nightmap.mjs.
//
// What is on the page while it is on (one stage = one floor or the lobby):
//   - the veil (.stage::after) becomes ONE picture, an SVG data: URL built here: the veil colour (darker and cooler than the plain dark mode) with a hole at every pool and every
//     lamp and the warm light of the lamps drawn into it, and the floor plaque's rectangle left exactly as the plain veil (the plaque is
//     see-through, so what lies under it must not change). The picture is built again only when a seat starts or stops being lit, a seat moves, the plaque's box or the
//     theme changes: no timer, no frame loop, no canvas, no mask, no blend mode.
//   - per lit seat: .fxn-f the fill (the veil's colour in the shape of the hole: opacity 1 = no pool, 0 = the full pool; it is what fades in and out), .fxn-m the near-black copy of the monitor back (above the desk and the cool light, so the monitor stays a dark shape inside the light) and .fxn-r the light
//     round the monitor's edge (between the figure and the desk), .fxn-t the cool light of the screen (plain alpha, over the desk and the figure, under the monitor copy).
// A pool is an ellipse nearer the monitor than the face (mix), so the desk and the face are lit and the wall behind the figure falls off fast.
// Day mode (light theme), effects off and rooms the data file does not know: nothing is built and the page keeps its own pixels. There is no flicker: the face light already ripples, and an animated layer
// under the see-through floor plaque would change its pixels by a rounding level. The only motion is the fade of a pool (opacity, none under reduced motion).

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
export function poolPlan(face, monitor, deskId, cfg, design = '') {
  const { rx, ry, mix } = { ...cfg.pool, ...cfg.pool.designs?.[design] };
  const cx = Math.round(monitor[0] + (face[0] - monitor[0]) * mix);
  const cy = Math.round(monitor[1] + (face[1] - monitor[1]) * mix);
  return { cx, cy, rx, ry, x: cx - rx, y: cy - ry, w: 2 * rx, h: 2 * ry, deskId, monitor, face };
}

/** A key that changes when the pool of a seat has to be drawn again. */
export const poolKey = (p) => `${p.deskId}|${p.cx}|${p.cy}`;

/** The desk id of a seated character: the lead's desk, the desk of its seat slot, or (a lobby figure has no slot) the desk of the seat it stands at; null when it has none. */
export function deskIdOf(rec, r) {
  if (rec.isLead) return r.lead.deskId;
  if (rec.slot?.kind === 'seat') return r.seats[rec.slot.i]?.deskId ?? null;
  const at = rec.home?.at;
  return at ? r.seats.find((s) => s.at[0] === at[0] && s.at[1] === at[1])?.deskId ?? null : null;
}

/** The lamps of a room as boxes in floor pixels, from the data file's lamps.<design> = [{kind, at: [x, y]}] and cfg.lamps.kinds.<kind> = {rx, ry}; a kind the config does not know is left out. */
export function lampPlans(list, cfg) {
  const out = [];
  for (const l of list ?? []) {
    const k = cfg.lamps.kinds[l.kind];
    if (!k) continue;
    out.push({ kind: l.kind, cx: l.at[0], cy: l.at[1], rx: k.rx, ry: k.ry, x: l.at[0] - k.rx, y: l.at[1] - k.ry, w: 2 * k.rx, h: 2 * k.ry });
  }
  return out;
}

/** The alpha of a pool's hole at a point of its ellipse, t = 0 (middle) .. 1 (edge): the piecewise linear cfg.pool.falloff. */
export function holeAt(t, cfg) {
  const f = cfg.pool.falloff;
  if (t <= f[0][0]) return f[0][1];
  for (let i = 1; i < f.length; i++) {
    if (t <= f[i][0]) return f[i - 1][1] + ((t - f[i - 1][0]) / (f[i][0] - f[i - 1][0])) * (f[i][1] - f[i - 1][1]);
  }
  return f[f.length - 1][1];
}

/**
 * The fill of a pool: the veil's colour with the alpha b(t) such that veil (opacity o x (1 - h)) and fill (b) together are exactly the plain veil's o:
 * 1 - (1 - o(1 - h))... in transmittance: (1 - o(1 - h)) (1 - b) = 1 - o  =>  b = 1 - (1 - o) / (1 - o (1 - h)).
 */
export function fillGradient(cfg) {
  const { color, opacity: o } = cfg.outside;
  const stops = cfg.pool.falloff.map(([t, h]) => `${rgba(color, 1 - (1 - o) / (1 - o * (1 - h)))} ${num(t * 100)}%`);
  return `radial-gradient(closest-side, ${stops.join(', ')})`;
}

/** The cool light of a pool: a gradient of cfg.tint.color, strongest in the middle, nothing at the edge (plain alpha over what lies below it). */
export function tintGradient(cfg) {
  const { color, alpha } = cfg.tint;
  const stops = cfg.pool.falloff.map(([t, h]) => `${rgba(color, alpha * h)} ${num(t * 100)}%`);
  return `radial-gradient(closest-side, ${stops.join(', ')})`;
}

/** The box of the cool light of a pool: the pool's ellipse scaled about its centre by cfg.tint.scale. */
export function tintBox(p, cfg) { // p carries its own rx, ry (a design may have smaller pools)
  const rx = Math.round(p.rx * cfg.tint.scale);
  const ry = Math.round(p.ry * cfg.tint.scale);
  return { x: p.cx - rx, y: p.cy - ry, w: 2 * rx, h: 2 * ry };
}

/**
 * The veil picture of a stage as SVG text. plan = {size: [w, h], pools: [pool plans], lamps: [lamp plans], sign: [x, y, w, h] | null}.
 * Layers: the veil (cfg.outside) through a mask that is white except at the holes (a black radial gradient per pool, per lamp one cfg.lamps.hole deep), then the warm light of every
 * lamp as a plain alpha gradient. Everything but the plaque's rectangle is clipped in: there the page's own plain veil lies (the .fxn-p element,
 * made like .stage::after), so the see-through plaque shows the same pixels as ever, down to the rounding.
 */
export function veilSvg(plan, cfg) {
  const [w, h] = plan.size;
  const stops = (list, f) => list.map(([t, v]) => f(t, v)).join('');
  const holeStop = (k) => (t, v) => `<stop offset="${num(t)}" stop-color="#000" stop-opacity="${num(v * k)}"/>`;
  const light = (c, a) => (t, v) => `<stop offset="${num(t)}" stop-color="${rgb(c)}" stop-opacity="${num(a * v)}"/>`;
  const lampFall = cfg.lamps.falloff;
  const poolFall = cfg.pool.falloff;
  const ell = (e, fill, k = 1) => `<ellipse cx="${num(e.cx)}" cy="${num(e.cy)}" rx="${num(e.rx * k)}" ry="${num(e.ry * k)}" fill="url(#${fill})"/>`;
  const defs = [
    `<radialGradient id="h">${stops(poolFall, holeStop(1))}</radialGradient>`,
    `<radialGradient id="g">${stops(lampFall, holeStop(cfg.lamps.hole))}</radialGradient>`,
    `<radialGradient id="l">${stops(lampFall, light(cfg.lamps.color, cfg.lamps.alpha))}</radialGradient>`,
    `<mask id="m" maskUnits="userSpaceOnUse" x="0" y="0" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="#fff"/>${plan.pools.map((p) => ell(p, 'h')).join('')}${plan.lamps.map((l) => ell(l, 'g')).join('')}</mask>`,
  ];
  let body = `<rect width="${w}" height="${h}" fill="${rgb(cfg.outside.color)}" fill-opacity="${num(cfg.outside.opacity)}" mask="url(#m)"/>`
    + plan.lamps.map((l) => ell(l, 'l', cfg.lamps.glowScale)).join('');
  if (plan.sign) {
    const [x, y, sw, sh] = plan.sign;
    defs.push(`<clipPath id="c"><path clip-rule="evenodd" d="M0 0H${w}V${h}H0ZM${x} ${y}h${sw}v${sh}h${-sw}Z"/></clipPath>`);
    body = `<g clip-path="url(#c)">${body}</g>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><defs>${defs.join('')}</defs>${body}</svg>`;
}

/** The CSS value of the veil picture. */
export const veilUrl = (svg) => `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;

// ---------------------------------------------------------------- DOM part

const CLS = { fill: 'fxn-f', tint: 'fxn-t', mon: 'fxn-m', rim: 'fxn-r' };

/**
 * Creates the real night. deps: ctx (the effects' ctx), cfg (ui.fx.weather.night), doc, modeOf(rec) -> 'work'|'rest'|'' (the face light's own decision),
 * resync() -> asks the weather area for a sync (it does nothing while the effects are off).
 */
export function createNightmap({ ctx, cfg, doc, modeOf, resync }) {
  let enabled = false; // the viewer's choice (the settings): off = the page as it was
  let data = null; // the data file, loaded the first time the real night is chosen
  let loading = false;
  let observer = null;
  let lastDark = null;
  const baseUrl = cfg.dataUrl.replace(/[^/]*$/, '');
  const floors = new Map(); // floor record -> {stage, pools: Map(rec -> pool), leaving: Set(pool), timers: Set, lamps: [], sig: string, seq: number, img, plaque, ro}
  const roomDim = () => Number.parseFloat(globalThis.getComputedStyle(doc.documentElement).getPropertyValue('--room-dim')) || 0;
  const fillImage = fillGradient(cfg);
  const tintImage = tintGradient(cfg);
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

  /** One absolutely placed div. */
  function box(cls, b, z) {
    const e = doc.createElement('div');
    e.className = cls;
    Object.assign(e.style, { left: px(b.x), top: px(b.y), width: px(b.w), height: px(b.h), zIndex: String(z) });
    return e;
  }

  function makePool(st, floor, rec, plan, deskObj) {
    const els = [];
    const add = (e) => {
      st.stage.append(e);
      els.push(e);
      e.dataset.on = '0';
      return e;
    };
    add(box(CLS.fill, plan, 7500)).style.backgroundImage = fillImage;
    const nodes = floor.scene.nodes.filter((x) => x.objId === deskObj.id);
    const deskZ = Math.max(...nodes.map((x) => x.z));
    const tint = add(box(CLS.tint, tintBox(plan, cfg), deskZ + 1)); // the cool light lies over the desk and the figure, under the monitor's dark copy
    tint.style.backgroundImage = tintImage;
    tint.style.setProperty('--fxn-o', '1');
    for (const n of nodes) {
      const layer = (cls, z, o, file) => {
        const e = add(box(cls, { x: n.x, y: n.y, w: n.w, h: n.h }, z));
        e.style.setProperty('--fxn-o', String(o));
        e.style.backgroundImage = `url(${baseUrl}${floor.design}-${file}.png)`;
        e.style.backgroundPosition = `${-n.bgX}px ${-n.bgY}px`;
        if (n.flipX) e.classList.add('fxn-fx'); // mirrored like the desk node itself (.obj.flip)
      };
      layer(CLS.mon, deskZ + 2, cfg.monitor.opacity, 'mon');
      layer(CLS.rim, n.z - 1, cfg.rim.opacity, 'rim');
    }
    return { rec, plan, key: poolKey(plan), els, on: false, nodes };
  }

  function setOn(pool, on) {
    pool.on = on;
    for (const e of pool.els) e.dataset.on = on ? '1' : '0';
  }

  /** The floor plaque's box (and a pixel round it) in stage pixels (the stage's own, unscaled), or null when the floor has none. */
  function signBox(stage) {
    const s = stage.querySelector('.sign');
    return s && s.offsetWidth ? [s.offsetLeft - 1, s.offsetTop - 1, s.offsetWidth + 2, s.offsetHeight + 2] : null; // a pixel wider all round: a scaled picture has a blurred edge, the plaque's own edge must lie in the plain veil
  }

  /** The plain veil under the floor plaque: one element, made like .stage::after (same colour, opacity from --room-dim), exactly where the picture has its hole. */
  function plaqueEl(st, sign) {
    if (!sign) {
      st.plaque?.remove();
      st.plaque = null;
      return;
    }
    if (!st.plaque) {
      st.plaque = doc.createElement('div');
      st.plaque.className = 'fxn-p';
      st.stage.append(st.plaque);
    }
    Object.assign(st.plaque.style, { left: px(sign[0]), top: px(sign[1]), width: px(sign[2]), height: px(sign[3]) });
  }

  /**
   * Draws the veil picture of a stage for the pools it has (the ones fading out keep their hole until they are gone) and its lamps. The new picture is decoded first, so the stage never
   * shows a frame without a veil; then `then` runs (the pools that wait for it fade in).
   */
  function applyVeil(st, floor) {
    const plan = { size: floor.scene.r.size, pools: [...st.pools.values(), ...st.leaving].map((p) => p.plan), lamps: st.lamps, sign: signBox(st.stage) };
    const svg = veilSvg(plan, cfg);
    if (svg === st.sig) {
      plaqueEl(st, plan.sign);
      lightUp(st);
      return;
    }
    st.sig = svg;
    const url = veilUrl(svg);
    const seq = ++st.seq;
    const go = () => {
      if (st.seq !== seq) return;
      plaqueEl(st, plan.sign); // the plain veil under the plaque changes in the same frame as the picture's hole
      st.stage.style.setProperty('--fxn-img', url);
      st.stage.classList.add('fxn-on');
      lightUp(st);
    };
    const img = (st.img ??= doc.createElement('img')); // one picture element per stage, so no node is left behind for every new veil
    img.src = `data:image/svg+xml,${encodeURIComponent(svg)}`;
    if (typeof img.decode === 'function') img.decode().then(go, go);
    else go();
  }

  /** The pools that wait for a picture fade in. Every picture that lands turns on all of them, so a newer picture that was built for another reason (lamp, plaque) cannot leave one dark. */
  function lightUp(st) {
    const waiting = [...st.pools.values()].filter((p) => !p.on);
    if (!waiting.length) return;
    void st.stage.offsetWidth; // one reflow so the first change of opacity is a fade
    for (const pool of waiting) setOn(pool, true);
  }

  function clearStage(st) {
    st.seq++;
    st.ro?.disconnect();
    st.ro = null;
    for (const timer of st.timers) ctx.timers.clearTimeout(timer);
    for (const pool of [...st.pools.values(), ...st.leaving]) for (const e of pool.els) e.remove();
    st.timers.clear();
    st.pools.clear();
    st.leaving.clear();
    st.stage.classList.remove('fxn-on');
    st.plaque?.remove();
    st.plaque = null;
    for (const k of ['--fxn-img', '--fxn-fade']) st.stage.style.removeProperty(k);
  }

  /** A pool that is no longer wanted fades out and is taken away (elements and hole) when the fade is over. */
  function retire(st, floor, pool) {
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
      applyVeil(st, floor);
    }, cfg.fadeMs + 60);
    st.timers.add(timer);
  }

  /** The pools a floor wants right now: lit seats (the face light says work or rest) at a desk the data file knows, each with its plan. */
  function wanted(floor) {
    const r = floor.scene.r;
    const sitH = ctx.server.sitHeight;
    const specs = data.monitors?.[floor.design] ?? {};
    const out = new Map();
    for (const rec of ctx.chars(floor)) {
      if (!modeOf(rec)) continue; // every seat the face light lights (working, thinking and idle at the desk) has its pool: a lead waiting at its desk is the one figure that sits idle
      const obj = r.objects.find((o) => o.id === deskIdOf(rec, r));
      const spec = specs[obj?.kind];
      if (obj && spec) out.set(rec, { plan: poolPlan(facePoint(rec, sitH, cfg), monitorSpot(obj, spec), obj.id, cfg, floor.design), obj });
    }
    return out;
  }

  /** Called by the weather area after it synced the face lights of a floor. */
  function sync(floor) {
    let st = floors.get(floor);
    if (enabled && !data && ctx.fx.fxOn()) load(); // the data file is fetched the first time the effects are on
    const known = !!(data?.monitors?.[floor.design] || data?.lamps?.[floor.design]);
    const active = enabled && !!floor.stage && !floor.off && known && ctx.fx.fxOn() && roomDim() > 0;
    if (!active) {
      if (st) {
        clearStage(st);
        floors.delete(floor);
      }
      return;
    }
    if (!st) floors.set(floor, (st = { stage: floor.stage, pools: new Map(), leaving: new Set(), timers: new Set(), lamps: lampPlans(data.lamps?.[floor.design], cfg), sig: '', seq: 0, img: null, plaque: null, ro: null }));
    const want = wanted(floor);
    st.stage.style.setProperty('--fxn-fade', `${cfg.fadeMs}ms`);
    for (const pool of [...st.pools.values()]) {
      const w = want.get(pool.rec);
      if (!w || poolKey(w.plan) !== pool.key) retire(st, floor, pool);
    }
    for (const [rec, w] of want) {
      if (st.pools.has(rec)) continue;
      const pool = makePool(st, floor, rec, w.plan, w.obj);
      st.pools.set(rec, pool);
    }
    applyVeil(st, floor);
    if (typeof globalThis.ResizeObserver === 'function' && !st.ro) {
      const sign = st.stage.querySelector('.sign');
      if (sign) { // the plaque changes its size with its text: draw the hole again at once, not at the next sync
        st.ro = new globalThis.ResizeObserver(() => { if (floors.get(floor) === st) applyVeil(st, floor); });
        st.ro.observe(sign);
      }
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

  /** The viewer's choice: on = the real night, off = the page as it was. */
  function setEnabled(on) {
    if (on === enabled) return;
    enabled = on;
    tidy();
    if (on) {
      if (ctx.fx.fxOn()) load();
      if (!observer && typeof MutationObserver === 'function') {
        // the theme changes the veil (--room-dim on the root): sync again when dark mode turns on or off
        observer = new MutationObserver(() => {
          const d = roomDim() > 0;
          if (d !== lastDark) {
            lastDark = d;
            resync();
          }
        });
        observer.observe(doc.documentElement, { attributes: true, attributeFilter: ['style', 'data-theme'] });
      }
      lastDark = roomDim() > 0;
    }
    resync();
  }

  return { sync, tidy, drop, setEnabled, enabled: () => enabled };
}
