// Effects area "weather" (window weather and room light). While the effects are on, every room window gets a richer sky than the plain
// one of weather.mjs: rain and snow in three parallax sheets, drifting cloud banks, rolling fog, soft lightning in a storm, a smooth
// day -> dusk -> night cross-fade of the light, and a soft glow of the monitors on the desks of those who work at night.
//
// Everything that moves is a pre-drawn tile (inline SVG or a CSS gradient) on a layer that only slides by transform, or a tint that only
// changes opacity (web/fx-weather.css), so the GPU does the work and no script runs per frame. The only timers are the lightning
// bursts (storm only) and the removal of the glows after they faded out. Effects off: nothing is built, no timer, no listener work.
//
// The top half of this module is pure (tiles, layers per weather, light plan, lightning schedule, glow spots; randomness is injected),
// the bottom half is the DOM part: init(ctx), called once at start-up (see the ctx typedef in fx.mjs). Numbers: config ui.fx.weather.
// It never invents activity: the weather and the light are the office's real ones (the `weather` and `daylight` events); the lightning
// only decorates a real storm; a glow shows only at the desk of someone who is really seated and working or thinking.

import { windowBoxes } from './weather.mjs';

/** A small seeded random generator (mulberry32): the same seed always draws the same tile. */
export function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const num = (n) => Number(n.toFixed(2));

/** Positions to draw a shape at so a tile wraps: the shape's box [x0,x1]x[y0,y1] repeated at +-tile where it crosses an edge. */
function wrapOffsets(box, tw, th) {
  const out = [];
  for (const ox of [-tw, 0, tw]) {
    for (const oy of [-th, 0, th]) {
      if (box.x1 + ox >= 0 && box.x0 + ox <= tw && box.y1 + oy >= 0 && box.y0 + oy <= th) out.push([ox, oy]);
    }
  }
  return out;
}

/** How a layer's tile slides in one loop: rain falls down and to the left (the tile's own slope), snow by spec.dx, clouds and fog to the right. */
export function motion(spec) {
  const [tw, th] = spec.tile;
  if (spec.type === 'rain') return { dx: -tw, dy: th };
  if (spec.type === 'snow') return { dx: spec.dx ?? 0, dy: th };
  return { dx: tw, dy: 0 };
}

/** The SVG text of a rain, snow or cloud tile (seamless when slid by `motion`). Fog is a CSS gradient, see `fogBackground`. */
export function tileSvg(spec) {
  const [tw, th] = spec.tile;
  const rand = seeded(spec.seed ?? 1);
  const parts = [];
  if (spec.type === 'rain') {
    const slope = tw / th; // the tile slides by (-tw, th), so a streak runs along (-slope, 1)
    for (let i = 0; i < spec.count; i++) {
      const x = rand() * tw;
      const y = rand() * th;
      const len = spec.len[0] + rand() * (spec.len[1] - spec.len[0]);
      const box = { x0: x - len * slope, x1: x, y0: y, y1: y + len };
      for (const [ox, oy] of wrapOffsets(box, tw, th)) {
        parts.push(`<line x1="${num(x + ox)}" y1="${num(y + oy)}" x2="${num(x - len * slope + ox)}" y2="${num(y + len + oy)}"/>`);
      }
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${tw}" height="${th}"><g stroke="#dce8ff" stroke-opacity="${spec.alpha}" stroke-width="${spec.width}" stroke-linecap="round">${parts.join('')}</g></svg>`;
  }
  if (spec.type === 'snow') {
    for (let i = 0; i < spec.count; i++) {
      const x = rand() * tw;
      const y = rand() * th;
      const r = spec.r[0] + rand() * (spec.r[1] - spec.r[0]);
      const box = { x0: x - r, x1: x + r, y0: y - r, y1: y + r };
      for (const [ox, oy] of wrapOffsets(box, tw, th)) parts.push(`<circle cx="${num(x + ox)}" cy="${num(y + oy)}" r="${num(r)}"/>`);
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${tw}" height="${th}"><g fill="#ffffff" fill-opacity="${spec.alpha}">${parts.join('')}</g></svg>`;
  }
  // a cloud bank: `count` puffs of four overlapping ellipses, spread over the tile and wrapped sideways
  const fill = spec.tone === 'dark' ? '#4a5266' : '#ffffff';
  for (let i = 0; i < spec.count; i++) {
    const cx = ((i + 0.3 + rand() * 0.4) / spec.count) * tw;
    const cy = th * (0.4 + rand() * 0.25);
    const w = (tw / spec.count) * (0.55 + rand() * 0.25);
    const h = th * (0.3 + rand() * 0.15);
    const blobs = [[0, 0, w * 0.5, h * 0.55], [-w * 0.28, h * 0.18, w * 0.32, h * 0.4], [w * 0.3, h * 0.12, w * 0.34, h * 0.42], [0, h * 0.28, w * 0.55, h * 0.3]];
    for (const [ox, oy, rx, ry] of blobs) {
      for (const sx of [-tw, 0, tw]) {
        if (cx + ox + rx + sx < 0 || cx + ox - rx + sx > tw) continue;
        parts.push(`<ellipse cx="${num(cx + ox + sx)}" cy="${num(cy + oy)}" rx="${num(rx)}" ry="${num(ry)}"/>`);
      }
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${tw}" height="${th}"><g fill="${fill}" fill-opacity="0.9">${parts.join('')}</g></svg>`;
}

/** The CSS background of a fog layer: two soft ellipses per tile, fully faded before the tile's edges (so the tile repeats without a seam). */
export function fogBackground(spec) {
  const c = spec.tone === 'dark' ? '90, 98, 118' : '236, 240, 246';
  return `radial-gradient(ellipse 24% 52% at 25% 62%, rgba(${c}, .9), rgba(${c}, 0)), radial-gradient(ellipse 22% 44% at 75% 36%, rgba(${c}, .7), rgba(${c}, 0))`;
}

/** The CSS `background-image` of a layer. */
export function tileImage(spec) {
  return spec.type === 'fog' ? fogBackground(spec) : `url("data:image/svg+xml,${encodeURIComponent(tileSvg(spec))}")`;
}

/**
 * The box of one layer inside a window box {width, height}, so the slide of `motion` never uncovers the window:
 * rain and snow start one tile up (and left), clouds one tile left; fog fills the window's height and scales its tile to it.
 */
export function layerBox(spec, win) {
  const [tw, th] = spec.tile;
  const { dx, dy } = motion(spec);
  const left = dx > 0 ? -dx : 0; // sliding right: start left of the window
  const width = win.width + Math.abs(dx);
  if (spec.type === 'rain' || spec.type === 'snow') return { left, top: -dy, width, height: win.height + dy, size: `${tw}px ${th}px` };
  if (spec.type === 'fog') return { left, top: 0, width, height: win.height, size: `${tw}px 100%` };
  return { left, top: Math.round(win.height * (spec.at ?? 0)), width, height: th, size: `${tw}px ${th}px` };
}

/** The layers a weather draws: `c` = cloud or fog banks (under the light tint), `p` = rain or snow sheets (above it). Other kinds draw none. */
export function layersFor(kind, cfg) {
  const k = cfg.kinds?.[kind];
  return { c: k?.c ?? [], p: k?.p ?? [] };
}

/** What the light does for a phase (day|sunset|night): the tint opacities, the monitor glow and how bright the rain and snow stay. */
export function lightTarget(phase, cfg) {
  const t = cfg.light[phase] ?? cfg.light.day;
  return { dusk: t.dusk, night: t.night, glow: t.glow, dim: cfg.particleDim[phase] ?? 1 };
}

/** One change of the light: the targets of the new phase and how long the cross-fade takes (none at the very start, when `prev` is null). */
export function fadePlan(prev, next, cfg) {
  return { ...lightTarget(next, cfg), ms: prev == null || prev === next ? 0 : cfg.fadeMs };
}

/**
 * The next lightning burst: wait `delayMs` (from the last flash of the burst before, always at least minGapMs), then 1 flash, or
 * with chance burstChance up to maxPerBurst flashes, each at least minGapMs after the one before. Peaks are soft (cfg.lightning.peak).
 * @returns {{delayMs: number, flashes: {atMs: number, peak: number, ms: number}[]}}
 */
export function planBurst(rand, cfg) {
  const L = cfg.lightning;
  const delayMs = Math.round(L.minGapMs + rand() * (L.maxGapMs - L.minGapMs));
  const count = rand() < L.burstChance ? L.maxPerBurst : 1;
  const flashes = [];
  let at = 0;
  for (let i = 0; i < count; i++) {
    flashes.push({ atMs: at, peak: num(L.peak[0] + rand() * (L.peak[1] - L.peak[0])), ms: L.flashMs });
    at += Math.round(L.minGapMs * (1 + rand() * 0.5));
  }
  return { delayMs, flashes };
}

/** The opacity keyframes of one soft flash: a quick rise, a fall, a weaker second flicker, out (never a hard strobe). */
export function flashFrames(peak) {
  return [
    { opacity: 0, offset: 0 }, { opacity: peak, offset: 0.14 }, { opacity: num(peak * 0.25), offset: 0.32 },
    { opacity: num(peak * 0.7), offset: 0.44 }, { opacity: 0, offset: 1 },
  ];
}

/** Where the monitor glows go: one per character that is really seated and in one of cfg.glow.states, as a centre in scene pixels. */
export function glowSpots(recs, cfg) {
  const out = [];
  for (const rec of recs) {
    if (!rec.seated || rec.away || !cfg.glow.states.includes(rec.state)) continue;
    out.push({ rec, x: Math.round(rec.x + cfg.glow.offset[0]), y: Math.round(rec.y + cfg.glow.offset[1]) });
  }
  return out;
}

// ---------------------------------------------------------------- DOM part

/** @param {import('./fx.mjs').FxCtx} ctx */
export function init(ctx) {
  const cfg = ctx.ui.fx.weather;
  if (!cfg.enabled) return;
  const { fx } = ctx;
  const doc = document;
  const floorsState = new Map(); // floor record -> {root, wins: [{box, el, c: [], p: [], flash}], glows: Map(rec -> el), glowLayer}
  const tileCache = new Map(); // spec object -> css background-image text (tiles are drawn once)
  let phase = null; // the phase the overlays show now (null before the first sync)
  let kind = 'none';
  let target = null; // lightTarget of the phase
  let fadeMs = 0;
  let lightningTimer = 0;
  let syncTimer = 0;
  const reduced = () => !!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  const bg = (spec) => {
    let v = tileCache.get(spec);
    if (!v) tileCache.set(spec, (v = tileImage(spec)));
    return v;
  };

  function slot(win, group, i, spec) {
    let el = win[group][i];
    if (!el) {
      el = doc.createElement('div');
      win.el.insertBefore(el, group === 'c' ? win.dusk : win.flash); // clouds under the tints, sheets above them, the flash on top
      win[group][i] = el;
    }
    el.className = `fxw-l fxw-${group} fxw-${spec.type}`;
    const b = layerBox(spec, win.box);
    const m = motion(spec);
    Object.assign(el.style, { left: `${b.left}px`, top: `${b.top}px`, width: `${b.width}px`, height: `${b.height}px`, backgroundImage: bg(spec), backgroundSize: b.size });
    el.style.setProperty('--fxw-dx', `${m.dx}px`);
    el.style.setProperty('--fxw-dy', `${m.dy}px`);
    el.style.setProperty('--fxw-ms', `${spec.ms}ms`);
    el.style.setProperty('--fxw-o', String(spec.opacity));
    return el;
  }

  /** Dresses the windows of a floor for the current kind: the layers it needs show, the others are removed (the pools only grow to the biggest set). */
  function dress(st) {
    const { c, p } = layersFor(kind, cfg);
    for (const win of st.wins) {
      for (const [group, specs] of [['c', c], ['p', p]]) {
        specs.forEach((spec, i) => slot(win, group, i, spec));
        for (let i = specs.length; i < win[group].length; i++) win[group][i].className = 'fxw-l fxw-off';
      }
    }
  }

  function build(floor) {
    const windows = floor.scene?.raw?.windows;
    if (!floor.stage || !windows?.length) return null;
    const root = doc.createElement('div');
    root.className = 'fxw';
    root.style.zIndex = '1';
    const st = { root, wins: [], glows: new Map(), glowLayer: null };
    windowBoxes(windows).forEach((box, i) => {
      const el = doc.createElement('div');
      el.className = 'fxw-win';
      Object.assign(el.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px`, clipPath: box.clip });
      el.style.setProperty('--fxw-p', ((i * 0.6180339887) % 1).toFixed(3));
      const dusk = doc.createElement('div');
      dusk.className = 'fxw-tint fxw-dusk';
      const night = doc.createElement('div');
      night.className = 'fxw-tint fxw-night';
      el.append(dusk, night);
      const flash = doc.createElement('div');
      flash.className = 'fxw-f';
      el.append(flash);
      root.append(el);
      st.wins.push({ box, el, c: [], p: [], dusk, flash });
    });
    const after = floor.stage.querySelector(':scope > .wx') ?? floor.stage.querySelector(':scope > .sky');
    if (after) after.after(root);
    else floor.stage.prepend(root);
    floorsState.set(floor, st);
    return st;
  }

  function applyLight(st) {
    const s = st.root.style;
    s.setProperty('--fxw-fade', `${fadeMs}ms`);
    s.setProperty('--fxw-dusk', String(target.dusk));
    s.setProperty('--fxw-night', String(target.night));
    s.setProperty('--fxw-dim', String(target.dim));
  }

  // ---- monitor glow ----
  function syncGlow(floor, st) {
    if (!floor.layer || floor.cropped) return;
    const want = target.glow > 0 ? glowSpots(ctx.chars(floor), cfg) : [];
    const keep = new Set(want.map((w) => w.rec));
    for (const [rec, el] of st.glows) {
      if (keep.has(rec)) continue;
      el.style.opacity = '0';
      st.glows.delete(rec);
      ctx.timers.setTimeout(() => el.remove(), fadeMs + 200);
    }
    for (const w of want) {
      let el = st.glows.get(w.rec);
      if (!el) {
        el = doc.createElement('div');
        el.className = 'fxw-glow';
        Object.assign(el.style, { left: `${w.x - cfg.glow.size[0] / 2}px`, top: `${w.y - cfg.glow.size[1] / 2}px`, width: `${cfg.glow.size[0]}px`, height: `${cfg.glow.size[1]}px`, opacity: '0' });
        floor.layer.append(el);
        void el.offsetWidth; // one reflow so the first opacity change is a transition
        st.glows.set(w.rec, el);
      }
      el.style.transitionDuration = `${fadeMs || 400}ms`;
      el.style.opacity = String(target.glow);
    }
  }

  // ---- lightning ----
  function flashNow(f) {
    if (ctx.paused() || reduced()) return;
    for (const [floor, st] of floorsState) {
      if (!ctx.floorActive(floor)) continue;
      for (const win of st.wins) win.flash.animate(flashFrames(f.peak), { duration: f.ms, easing: 'ease-out' });
    }
  }

  function stopLightning() {
    if (lightningTimer) ctx.timers.clearTimeout(lightningTimer);
    lightningTimer = 0;
  }

  function armLightning() {
    stopLightning();
    if (kind !== 'storm' || !fx.fxOn() || reduced()) return;
    const plan = planBurst(Math.random, cfg);
    const run = (i) => {
      flashNow(plan.flashes[i]);
      if (i + 1 < plan.flashes.length) lightningTimer = ctx.timers.setTimeout(() => run(i + 1), plan.flashes[i + 1].atMs - plan.flashes[i].atMs);
      else lightningTimer = ctx.timers.setTimeout(armLightning, 0);
    };
    lightningTimer = ctx.timers.setTimeout(() => run(0), plan.delayMs);
  }

  // ---- syncing ----
  function sync() {
    syncTimer = 0;
    const next = ctx.light();
    const p = next === phase ? null : fadePlan(phase, next, cfg);
    if (p) {
      fadeMs = p.ms;
      target = p;
      phase = next;
    } else if (!target) {
      target = fadePlan(null, next, cfg);
      phase = next;
    }
    const nextKind = ctx.weather().kind;
    const kindChanged = nextKind !== kind;
    kind = nextKind;
    for (const floor of ctx.floors()) {
      if (floor.off) continue;
      const st = floorsState.get(floor) ?? build(floor);
      if (!st) continue;
      if (kindChanged || !st.dressed) {
        dress(st);
        st.dressed = true;
      }
      applyLight(st);
      st.root.dataset.phase = phase;
      st.root.dataset.kind = kind;
      syncGlow(floor, st);
    }
    if (kindChanged) armLightning();
  }

  /** Several events can come in one tick (state changes especially): one sync after a short pause. */
  function later() {
    if (!syncTimer) syncTimer = ctx.timers.setTimeout(sync, cfg.settleMs);
  }

  function tidy() {
    stopLightning();
    if (syncTimer) ctx.timers.clearTimeout(syncTimer);
    syncTimer = 0;
    for (const st of floorsState.values()) {
      st.root.remove();
      for (const el of st.glows.values()) el.remove();
    }
    floorsState.clear();
    phase = null;
    target = null;
    kind = 'none';
    fadeMs = 0;
  }

  for (const name of ['weather', 'daylight', 'floor-shown', 'pose', 'state', 'crop']) fx.onFx(name, later);
  fx.onFx('floor-hidden', (d) => {
    const st = floorsState.get(d.floor);
    if (!st) return;
    if (d.removed) {
      st.root.remove();
      for (const el of st.glows.values()) el.remove();
      floorsState.delete(d.floor);
    }
  });
  ctx.onPauseChange(() => {
    if (ctx.paused()) stopLightning();
    else armLightning();
  });
  fx.onFxChange(({ fx: on }) => {
    if (on) sync();
    else tidy();
  });
  if (fx.fxOn()) sync();
}
