// Draws the two pictures per room design that the real night needs (web/fx-nightmap.mjs), from assets/nightmap/nightmap.json and the room's objects.png:
//   assets/nightmap/<design>-mon.png  the monitor backs of every desk kind, as a near-black silhouette (config night.monitor.color), on the same pixels as in objects.png
//                                     (laid over the desk in a lit pool and faded in with it, it keeps the monitor back a dark shape)
//   assets/nightmap/<design>-rim.png  a thin cool glow in the 1-3 pixels just outside those silhouettes, only where objects.png is transparent
//                                     (laid under the desk, over the figure behind it, so light leaks round the monitor's edge)
// Both pictures have the size of objects.png, so they use the same box and background position as the desk node itself.
// Numbers: config ui.fx.weather.night (monitor.color, rim.color, rim.falloff). Run it again after changing them or the data file:   node scripts/make-nightmap.mjs
// (tests/fx-nightmap.test.mjs fails when a picture is missing or no longer matches what monitorMask / rimOf make.) Zero dependencies.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { decodePng, encodePng } from './make-lit-sprites.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const DIR = join(ROOT, 'assets', 'nightmap');
export const loadData = () => JSON.parse(readFileSync(join(DIR, 'nightmap.json'), 'utf8'));
export const loadConfig = () => JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8')).ui.fx.weather.night;
export const sceneOf = (design) => JSON.parse(readFileSync(join(ROOT, 'assets', 'scenes', design, 'scene.json'), 'utf8'));
export const atlasOf = (design, scene = sceneOf(design)) => decodePng(readFileSync(join(ROOT, 'assets', 'scenes', design, scene.atlas)));

const sat = (rgba, i) => {
  const mx = Math.max(rgba[i], rgba[i + 1], rgba[i + 2]);
  const mn = Math.min(rgba[i], rgba[i + 1], rgba[i + 2]);
  return mx === 0 ? 0 : (mx - mn) / mx;
};

/** The monitor pixels of one desk kind as a Set of atlas pixel indexes: from the seed, the connected (4-way) grey pixels (saturation <= rule.maxSat, alpha >= rule.minAlpha) inside the box. */
export function monitorMask(atlas, kindRect, spec, rule) {
  const [rx, ry] = kindRect;
  const [bx0, by0, bx1, by1] = spec.box;
  const idx = (x, y) => (ry + y) * atlas.w + rx + x;
  const grey = (x, y) => x >= bx0 && x < bx1 && y >= by0 && y < by1 && atlas.rgba[idx(x, y) * 4 + 3] >= rule.minAlpha && sat(atlas.rgba, idx(x, y) * 4) <= rule.maxSat;
  const out = new Set();
  const stack = [spec.seed];
  if (!grey(...spec.seed)) throw new Error(`the seed ${spec.seed} is not a monitor pixel`);
  while (stack.length) {
    const [x, y] = stack.pop();
    if (out.has(idx(x, y)) || !grey(x, y)) continue;
    out.add(idx(x, y));
    stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
  }
  return out;
}

/** The silhouette picture (RGBA, atlas size) of a design: every kind's monitor pixels in the colour [r, g, b], opaque. */
export function monDrawing(design, data, cfg) {
  const scene = sceneOf(design);
  const atlas = atlasOf(design, scene);
  const rgba = new Uint8ClampedArray(atlas.w * atlas.h * 4);
  const masks = {};
  for (const [kind, spec] of Object.entries(data.monitors[design])) {
    masks[kind] = monitorMask(atlas, scene.kinds[kind].rect, spec, data.monitorRule);
    for (const i of masks[kind]) rgba.set([...cfg.monitor.color, 255], i * 4);
  }
  return { w: atlas.w, h: atlas.h, rgba, masks, atlas };
}

/** The rim picture of a design: for each ring distance d = 1..falloff.length (Chebyshev, 8 neighbours) around a silhouette, a pixel of rim.color at alpha falloff[d-1], only where the atlas is transparent. */
export function rimDrawing(mon, cfg) {
  const { w, h, atlas } = mon;
  const rgba = new Uint8ClampedArray(w * h * 4);
  const dist = new Uint8Array(w * h); // 0 = not reached
  const ring = new Map(); // pixel -> its distance
  const inside = new Uint8Array(w * h);
  for (const m of Object.values(mon.masks)) for (const i of m) inside[i] = 1;
  const steps = cfg.rim.falloff.length;
  let front = [...inside.keys()].filter((i) => inside[i]);
  for (let d = 1; d <= steps; d++) {
    const next = [];
    for (const i of front) {
      const x = i % w;
      const y = (i - x) / w;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const j = ny * w + nx;
          if (inside[j] || dist[j]) continue;
          dist[j] = d;
          next.push(j);
        }
      }
    }
    front = next;
  }
  for (let j = 0; j < w * h; j++) {
    if (!dist[j] || atlas.rgba[j * 4 + 3] !== 0) continue;
    rgba.set([...cfg.rim.color, Math.round(cfg.rim.falloff[dist[j] - 1] * 255)], j * 4);
  }
  return { w, h, rgba };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const data = loadData();
  const cfg = loadConfig();
  mkdirSync(DIR, { recursive: true });
  for (const design of Object.keys(data.monitors)) {
    const mon = monDrawing(design, data, cfg);
    const rim = rimDrawing(mon, cfg);
    writeFileSync(join(DIR, `${design}-mon.png`), encodePng(mon.w, mon.h, mon.rgba));
    writeFileSync(join(DIR, `${design}-rim.png`), encodePng(rim.w, rim.h, rim.rgba));
    const counts = Object.entries(mon.masks).map(([k, m]) => `${k}=${m.size}`).join(' ');
    console.log(`${design}: monitor pixels ${counts}`);
  }
}
