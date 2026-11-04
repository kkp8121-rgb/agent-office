// Effects area "weather" (window weather and room light). While the effects are on, the outside of every room window gets a richer sky than the
// plain one of weather.mjs: rain and snow in three parallax sheets, pixel-art cloud banks that drift behind the buildings, rolling fog, soft lightning
// in a storm, a smooth day -> dusk -> night cross-fade of the light, and a soft glow of the monitors on the desks of those who work at night.
//
// The weather is OUTSIDE, behind the glass, like the view picture. One overlay per floor sits in the box of the view picture (scene.json "view"),
// under a second copy of the room picture (the shell), so it shows only through the shell's holes and never changes a pixel the room paints
// (frames, mullions, sills, walls). Clouds, the overcast and the lightning glow live in a group masked by the sky mask of the view picture
// (assets/scenes/<room>/sky-day.png, sky-night.png, art/skymask.py): they are only where the picture shows sky, behind the skyline, mountains and
// trees. Rain, snow and fog may pass in front of the buildings. The banks are laid out in view coordinates, one sky per floor: a cloud that
// leaves one pane comes out of the next at the same height and speed (no per-window phase).
//
// Everything that moves is a pre-drawn tile (inline SVG or a CSS gradient) on a layer that only slides by transform, or a tint that only
// changes opacity (web/fx-weather.css), so the GPU does the work and no script runs per frame. The only timers are the lightning
// bursts (storm only) and the removal of the glows after they faded out. Effects off: nothing is built, no timer, no listener work.
//
// The top half of this module is pure (tiles, clouds, layers per weather, light plan, lightning schedule, glow spots; randomness is injected),
// the bottom half is the DOM part: init(ctx), called once at start-up (see the ctx typedef in fx.mjs). Numbers: config ui.fx.weather.
// It never invents activity: the weather and the light are the office's real ones (the `weather` and `daylight` events); the lightning
// only decorates a real storm; a glow shows only at the desk of someone who is really seated and working or thinking.

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

/** The SVG text of a rain or snow tile (seamless when slid by `motion`). Clouds are `cloudSvg`, fog is a CSS gradient, see `fogBackground`. */
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
  for (let i = 0; i < spec.count; i++) {
    const x = rand() * tw;
    const y = rand() * th;
    const r = spec.r[0] + rand() * (spec.r[1] - spec.r[0]);
    const box = { x0: x - r, x1: x + r, y0: y - r, y1: y + r };
    for (const [ox, oy] of wrapOffsets(box, tw, th)) parts.push(`<circle cx="${num(x + ox)}" cy="${num(y + oy)}" r="${num(r)}"/>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${tw}" height="${th}"><g fill="#ffffff" fill-opacity="${spec.alpha}">${parts.join('')}</g></svg>`;
}

// ---- clouds: lumpy pixel-art shapes, a lit top and a soft grey belly, in cells of cfg.cell scene pixels ----

/** The file of a view picture's sky mask: view-day.png -> sky-day.png (a name that does not start with "view" gets the prefix "sky-"). */
export function skyMaskFile(viewFile) {
  return /^view/.test(viewFile) ? viewFile.replace(/^view/, 'sky') : `sky-${viewFile}`;
}

/** The tones of a cloud cell, as the index into the palette of a tone (cfg.tones): lit top edge, body, belly, lowest row of the belly. */
export const TONE = { hi: 0, mid: 1, low: 2, deep: 3 };

/**
 * One cloud of w x h cells as runs [{y, x0, x1, tone}] (x1 exclusive): a few overlapping bumps, taller in the middle, clipped to a flat belly on the
 * last row. A cell with nothing above it is lit (hi), the two lowest cells of a column are the belly (low, and deep for the very last), the rest is body.
 */
export function cloudRuns(rand, w, h) {
  const base = h - 1;
  const grid = Array.from({ length: h }, () => new Array(w).fill(false));
  const k = Math.max(3, Math.min(6, Math.round(w / (h * 0.9))));
  const maxRy = base / 1.55; // the bump's centre sits 0.55 ry above the belly, its top must stay inside the box
  for (let i = 0; i < k; i++) {
    const t = (i + 0.5 + (rand() - 0.5) * 0.4) / k;
    const mid = 1 - Math.abs(t - 0.5) * 1.3;
    const ry = Math.max(1.5, Math.min(maxRy, maxRy * (0.5 + 0.5 * mid * (0.75 + 0.25 * rand()))));
    const rx = Math.max(ry * (1.15 + 0.5 * rand()), (w / k) * 0.75); // wide enough to meet the next bump, so a cloud is one piece
    const cx = t * w;
    const cy = base - ry * 0.55;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const dx = (x + 0.5 - cx) / rx;
        const dy = (y + 0.5 - cy) / ry;
        if (dx * dx + dy * dy <= 1) grid[y][x] = true;
      }
    }
  }
  const runs = [];
  for (let y = 0; y < h; y++) {
    let cur = null;
    for (let x = 0; x <= w; x++) {
      let tone = null;
      if (x < w && grid[y][x]) {
        let below = 0;
        while (y + below + 1 < h && grid[y + below + 1][x]) below++;
        tone = y === 0 || !grid[y - 1][x] ? TONE.hi : below === 0 ? TONE.deep : below === 1 ? TONE.low : TONE.mid;
      }
      if (cur && cur.tone !== tone) {
        runs.push({ y, x0: cur.x0, x1: x, tone: cur.tone });
        cur = null;
      }
      if (tone !== null && !cur) cur = { x0: x, tone };
    }
  }
  return runs;
}

/**
 * The layout of one cloud bank for a design: `spec` = {n, gap, size, from, to, seed}, `sky` = {band: [y0, y1], h: [min, max]} (rows of the view picture
 * where sky shows, and the cloud heights in scene pixels that suit the picture's scale), `cell` = scene pixels per cell.
 * Returns the tile {tile: [w, h] in px, top: where the layer starts in the view box} and the clouds {x, y, w, h, seed} in cells (x may be negative or reach
 * past the tile: it is drawn again on the other side, so the tile wraps).
 */
export function cloudPlan(spec, sky, cell) {
  const rand = seeded(spec.seed ?? 1);
  const [y0, y1] = sky.band;
  const span = y1 - y0;
  const size = spec.size ?? 1;
  const cells = (px) => Math.max(3, Math.round(px / cell));
  const sizes = [];
  for (let i = 0; i < spec.n; i++) {
    const h = cells((sky.h[0] + rand() * (sky.h[1] - sky.h[0])) * size);
    sizes.push({ w: Math.round(h * (2.3 + rand() * 1.2)), h });
  }
  const tw = Math.max(1, Math.round(sizes.reduce((sum, c) => sum + c.w, 0) * spec.gap));
  const th = Math.max(...sizes.map((c) => c.h), cells((spec.to - spec.from) * span + sky.h[1] * size));
  const clouds = sizes.map((c, i) => ({
    x: Math.round(((i + 0.5 + (rand() - 0.5) * 0.5) / spec.n) * tw - c.w / 2),
    y: Math.floor(rand() * (th - c.h + 1)),
    w: c.w, h: c.h, seed: Math.floor(rand() * 1e6) + 1,
  }));
  return { tile: [tw * cell, th * cell], top: Math.round((y0 + spec.from * span) / cell) * cell, cell, clouds };
}

/** The SVG text of a cloud tile of a resolved spec ({tile, cell, clouds, colors}): crisp rectangles per run, drawn again on the far side where a cloud crosses the tile's edge. */
export function cloudSvg(spec) {
  const [tw, th] = spec.tile;
  const { cell } = spec;
  const twc = tw / cell;
  const byTone = spec.colors.map(() => []);
  for (const c of spec.clouds) {
    for (const r of cloudRuns(seeded(c.seed), c.w, c.h)) {
      for (const sx of [-twc, 0, twc]) {
        const x0 = Math.max(0, c.x + r.x0 + sx);
        const x1 = Math.min(twc, c.x + r.x1 + sx);
        if (x1 <= x0) continue;
        byTone[r.tone].push(`<rect x="${x0 * cell}" y="${(c.y + r.y) * cell}" width="${(x1 - x0) * cell}" height="${cell}"/>`);
      }
    }
  }
  const groups = spec.colors.map((color, i) => (byTone[i].length ? `<g fill="${color}">${byTone[i].join('')}</g>` : '')).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${tw}" height="${th}" shape-rendering="crispEdges">${groups}</svg>`;
}

/** A spec ready to draw for a design: a cloud bank gets its tile, top, slide time (one tile at `pxPerSec`) and colours; the others are as written. */
export function resolveSpec(spec, cfg, design) {
  if (spec.type !== 'cloud') return spec;
  const plan = cloudPlan(spec, cfg.sky[design] ?? cfg.sky.default, cfg.cell);
  return { ...spec, ...plan, ms: Math.round((plan.tile[0] / spec.pxPerSec) * 1000), colors: cfg.tones[spec.tone] };
}

/** The CSS background of a fog layer: two soft ellipses per tile, fully faded before the tile's edges (so the tile repeats without a seam). */
export function fogBackground(spec) {
  const c = spec.tone === 'dark' ? '90, 98, 118' : '236, 240, 246';
  return `radial-gradient(ellipse 24% 52% at 25% 62%, rgba(${c}, .9), rgba(${c}, 0)), radial-gradient(ellipse 22% 44% at 75% 36%, rgba(${c}, .7), rgba(${c}, 0))`;
}

/** The CSS `background-image` of a layer (a cloud spec must be resolved, see `resolveSpec`). */
export function tileImage(spec) {
  if (spec.type === 'fog') return fogBackground(spec);
  return `url("data:image/svg+xml,${encodeURIComponent(spec.type === 'cloud' ? cloudSvg(spec) : tileSvg(spec))}")`;
}

/**
 * The box of one layer inside the view box {width, height}, so the slide of `motion` never uncovers it:
 * rain and snow start one tile up (and left), clouds one tile left; fog fills the view's height and scales its tile to it.
 */
export function layerBox(spec, view) {
  const [tw, th] = spec.tile;
  const { dx, dy } = motion(spec);
  const left = dx > 0 ? -dx : 0; // sliding right: start left of the view
  const width = view.width + Math.abs(dx);
  if (spec.type === 'rain' || spec.type === 'snow') return { left, top: -dy, width, height: view.height + dy, size: `${tw}px ${th}px` };
  if (spec.type === 'fog') return { left, top: 0, width, height: view.height, size: `${tw}px 100%` };
  return { left, top: spec.top, width, height: th, size: `${tw}px ${th}px` };
}

/** The layers a weather draws: `c` = cloud or fog banks (under the light tint), `p` = rain or snow sheets (above it). Other kinds draw none. */
export function layersFor(kind, cfg) {
  const k = cfg.kinds?.[kind];
  return { c: k?.c ?? [], p: k?.p ?? [] };
}

/** What the light does for a phase (day|sunset|night): the tint opacities, the monitor glow, how bright the rain and snow stay and how bright the sky weather (clouds, overcast, fog) stays. */
export function lightTarget(phase, cfg) {
  const t = cfg.light[phase] ?? cfg.light.day;
  return { dusk: t.dusk, night: t.night, glow: t.glow, dim: cfg.particleDim[phase] ?? 1, sdim: cfg.skyDim[phase] ?? 1 };
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
    out.push({ rec, x: Math.round(rec.x + cfg.glow.offset[0]), y: Math.round(rec.y + cfg.glow.offset[1]), lead: Boolean(rec.isLead) });
  }
  return out;
}

/**
 * The clip of one glow: its box minus the back of the monitor on the desk. The seated one faces the screen, so the viewer sees only the dark
 * back panel; the light falls on the face, the upper body and the desk around it, never on the panel. `holes` (cfg.glow.holes) holds, per design and
 * desk kind (desk | lead), the panel's outline as points in scene pixels around the glow's centre. Nothing known for a design: no clip.
 */
export function glowClip(size, holes, design, lead) {
  const pts = holes?.[design]?.[lead ? 'lead' : 'desk'];
  if (!pts?.length) return '';
  const [w, h] = size;
  return `path(evenodd, "M0 0H${w}V${h}H0Z M${pts.map(([x, y]) => `${x + w / 2} ${y + h / 2}`).join(' L')}Z")`;
}

// ---------------------------------------------------------------- DOM part

/** @param {import('./fx.mjs').FxCtx} ctx */
export function init(ctx) {
  const cfg = ctx.ui.fx.weather;
  if (!cfg.enabled) return;
  const { fx } = ctx;
  const doc = document;
  const floorsState = new Map(); // floor record -> {root, shell, view, box, sky, flash, dusk, night, c: [], p: [], glows: Map(rec -> el)}
  const tileCache = new Map(); // resolved spec -> css background-image text (tiles are drawn once)
  const resolved = new Map(); // design -> Map(spec object -> resolved spec)
  let phase = null; // the phase the overlays show now (null before the first sync)
  let kind = 'none';
  let target = null; // lightTarget of the phase
  let fadeMs = 0;
  let lightningTimer = 0;
  let syncTimer = 0;
  let glowOnlyPending = true; // true while only pose/state events asked for the next sync: then only the glows are refreshed
  const reduced = () => !!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  const specFor = (spec, design) => {
    let byDesign = resolved.get(design);
    if (!byDesign) resolved.set(design, (byDesign = new Map()));
    let r = byDesign.get(spec);
    if (!r) byDesign.set(spec, (r = resolveSpec(spec, cfg, design)));
    return r;
  };

  const bg = (spec) => {
    let v = tileCache.get(spec);
    if (!v) tileCache.set(spec, (v = tileImage(spec)));
    return v;
  };

  /** Puts layer `i` of a pool (c = clouds and fog, p = rain and snow) in its place: clouds in the sky group (masked), fog under the tints, sheets above them. */
  function slot(st, group, i, spec) {
    let el = st[group][i];
    if (!el) {
      el = doc.createElement('div');
      st[group][i] = el;
    }
    if (spec.type === 'cloud') st.sky.insertBefore(el, st.flash);
    else if (group === 'c') st.view.insertBefore(el, st.dusk);
    else st.view.append(el);
    el.className = `fxw-l fxw-${group} fxw-${spec.type}`;
    const b = layerBox(spec, st.box);
    const m = motion(spec);
    Object.assign(el.style, { left: `${b.left}px`, top: `${b.top}px`, width: `${b.width}px`, height: `${b.height}px`, backgroundImage: bg(spec), backgroundSize: b.size });
    el.style.setProperty('--fxw-dx', `${m.dx}px`);
    el.style.setProperty('--fxw-dy', `${m.dy}px`);
    el.style.setProperty('--fxw-ms', `${spec.ms}ms`);
    el.style.setProperty('--fxw-o', String(spec.opacity));
    return el;
  }

  /** Dresses a floor for the current kind: the layers it needs show, the others are removed (the pools only grow to the biggest set). */
  function dress(st) {
    const { c, p } = layersFor(kind, cfg);
    for (const [group, specs] of [['c', c], ['p', p]]) {
      specs.forEach((spec, i) => slot(st, group, i, specFor(spec, st.design)));
      for (let i = specs.length; i < st[group].length; i++) st[group][i].className = 'fxw-l fxw-off';
    }
    const k = cfg.kinds?.[kind];
    st.root.style.setProperty('--fxw-ovc', k?.overcast ?? 'transparent');
    st.root.style.setProperty('--fxw-haze', k?.haze ?? 'transparent');
  }

  const px = (n) => `${n}px`;

  function build(floor) {
    const sc = floor.scene;
    if (!floor.stage || !sc?.raw?.windows?.length) return null;
    const view = sc.r.view;
    const box = view ? { left: view.origin[0], top: view.origin[1], width: view.size[0], height: view.size[1] } : { left: 0, top: 0, width: sc.r.size[0], height: sc.r.size[1] };
    const root = doc.createElement('div');
    root.className = 'fxw';
    root.style.zIndex = '1';
    if (view) {
      const file = (name) => `url(${sc.url}${encodeURIComponent(skyMaskFile(name))})`;
      root.style.setProperty('--fxw-sky-day', file(view.day));
      root.style.setProperty('--fxw-sky-night', file(view.night));
    }
    const mk = (cls, parent) => {
      const el = doc.createElement('div');
      el.className = cls;
      parent.append(el);
      return el;
    };
    const viewEl = mk('fxw-view', root);
    Object.assign(viewEl.style, { left: px(box.left), top: px(box.top), width: px(box.width), height: px(box.height) });
    mk('fxw-haze', viewEl);
    const sky = mk(view ? 'fxw-sky' : 'fxw-sky fxw-nomask', viewEl); // clouds, overcast and the lightning glow: only where the picture shows sky
    mk('fxw-ovc', sky);
    const flash = mk('fxw-f', sky);
    const dusk = mk('fxw-tint fxw-dusk', viewEl);
    const night = mk('fxw-tint fxw-night', viewEl);
    // the room picture once more, above the weather: the weather shows only through its holes and can never touch a pixel the room paints
    const shell = doc.createElement('div');
    shell.className = 'fxw-shell';
    shell.style.backgroundImage = `url(${sc.url}${encodeURIComponent(sc.r.shell)})`;
    const st = { root, shell, view: viewEl, box, sky, flash, dusk, night, c: [], p: [], glows: new Map(), design: floor.design };
    const after = floor.stage.querySelector(':scope > .wx') ?? floor.stage.querySelector(':scope > .sky');
    if (after) after.after(root, shell);
    else floor.stage.prepend(root, shell);
    floorsState.set(floor, st);
    return st;
  }

  function applyLight(st) {
    const s = st.root.style;
    s.setProperty('--fxw-fade', `${fadeMs}ms`);
    s.setProperty('--fxw-dusk', String(target.dusk));
    s.setProperty('--fxw-night', String(target.night));
    s.setProperty('--fxw-dim', String(target.dim));
    s.setProperty('--fxw-sdim', String(target.sdim));
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
        const clip = glowClip(cfg.glow.size, cfg.glow.holes, floor.design, w.lead);
        if (clip) el.style.clipPath = clip;
        floor.layer.append(el);
        void el.offsetWidth; // one reflow so the first opacity change is a transition
        st.glows.set(w.rec, el);
      }
      const o = String(target.glow);
      if (el.style.opacity !== o) {
        el.style.transitionDuration = `${fadeMs || 400}ms`;
        el.style.opacity = o;
      }
    }
  }

  // ---- lightning ----
  function flashNow(f) {
    if (ctx.paused() || reduced()) return;
    for (const [floor, st] of floorsState) {
      if (!ctx.floorActive(floor)) continue;
      st.flash.animate(flashFrames(f.peak), { duration: f.ms, easing: 'ease-out' });
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
    const glowOnly = glowOnlyPending;
    glowOnlyPending = true;
    if (glowOnly && target) {
      for (const floor of ctx.floors()) {
        const st = floorsState.get(floor);
        if (st && !floor.off) syncGlow(floor, st);
      }
      return;
    }
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
      const key = `${phase}|${kind}|${fadeMs}`;
      if (st.lightKey !== key) {
        applyLight(st);
        st.root.dataset.phase = phase;
        st.root.dataset.kind = kind;
        st.lightKey = key;
      }
      syncGlow(floor, st);
    }
    if (kindChanged) armLightning();
  }

  /** Several events can come in one tick (state changes especially): one sync after a short pause. */
  function later(full = true) {
    if (full) glowOnlyPending = false;
    if (!syncTimer) syncTimer = ctx.timers.setTimeout(sync, cfg.settleMs);
  }

  function tidy() {
    stopLightning();
    if (syncTimer) ctx.timers.clearTimeout(syncTimer);
    syncTimer = 0;
    for (const st of floorsState.values()) {
      st.root.remove();
      st.shell.remove();
      for (const el of st.glows.values()) el.remove();
    }
    floorsState.clear();
    phase = null;
    target = null;
    kind = 'none';
    fadeMs = 0;
    glowOnlyPending = false;
  }

  for (const name of ['weather', 'daylight', 'floor-shown', 'crop']) fx.onFx(name, () => later(true));
  for (const name of ['pose', 'state']) fx.onFx(name, () => later(false));
  fx.onFx('floor-hidden', (d) => {
    const st = floorsState.get(d.floor);
    if (!st) return;
    if (d.removed) {
      st.root.remove();
      st.shell.remove();
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
