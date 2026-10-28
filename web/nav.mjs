// Walking grid: bake open/closed cells from a resolved scene, 8-way A*, line of sight, path smoothing and a
// per-page path cache. Pure (no DOM, no process): the browser, the tests and the validator use the same code.
import { distToPolyEdge, distToUnionEdge, pointInPoly, pointInPolys } from './scene.mjs';

/** @typedef {[number, number]} Pt */
/** @typedef {{cols:number, rows:number, cellPx:number, open:Uint8Array}} Grid */

const SQRT2 = Math.SQRT2;
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

/** Polygons that block walking: blocking objects' footprints plus the scene's own `blocked` list. */
export function blockingPolys(r) {
  return [...r.objects.filter((o) => o.blocks && o.footprint.length >= 3).map((o) => o.footprint), ...r.blocked];
}

/**
 * A cell is open when its centre is on the walkable floor, `inflatePx` or more from the floor's outer edge, and
 * `inflatePx` or more from every blocking polygon (the walker's foot radius).
 * @returns {Grid}
 */
export function bakeGrid(r, nav) {
  const { cellPx, inflatePx } = nav;
  const cols = Math.ceil(r.size[0] / cellPx);
  const rows = Math.ceil(r.size[1] / cellPx);
  const open = new Uint8Array(cols * rows);
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const c = [(col + 0.5) * cellPx, (row + 0.5) * cellPx];
      if (pointInPolys(c, r.walkable) && distToUnionEdge(c, r.walkable) >= inflatePx) open[row * cols + col] = 1;
    }
  }
  for (const poly of blockingPolys(r)) {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const [x, y] of poly) {
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
    const c0 = Math.max(0, Math.floor((x0 - inflatePx) / cellPx));
    const c1 = Math.min(cols - 1, Math.floor((x1 + inflatePx) / cellPx));
    const r0 = Math.max(0, Math.floor((y0 - inflatePx) / cellPx));
    const r1 = Math.min(rows - 1, Math.floor((y1 + inflatePx) / cellPx));
    for (let row = r0; row <= r1; row++) {
      for (let col = c0; col <= c1; col++) {
        const i = row * cols + col;
        if (!open[i]) continue;
        const c = [(col + 0.5) * cellPx, (row + 0.5) * cellPx];
        if (pointInPoly(c, poly) || distToPolyEdge(c, poly) <= inflatePx) open[i] = 0;
      }
    }
  }
  return { cols, rows, cellPx, open };
}

const cellOpen = (g, c, r) => c >= 0 && r >= 0 && c < g.cols && r < g.rows && g.open[r * g.cols + c] === 1;

export const cellOf = (g, p) => [Math.floor(p[0] / g.cellPx), Math.floor(p[1] / g.cellPx)];
const centerOf = (g, c, r) => [(c + 0.5) * g.cellPx, (r + 0.5) * g.cellPx];

/** @param {Grid} g @param {Pt} p */
export function isOpen(g, p) {
  const [c, r] = cellOf(g, p);
  return cellOpen(g, c, r);
}

/** Centre of the open cell nearest to `p` within `radiusCells` rings (BFS by rings), or null. */
export function snapOpen(g, p, radiusCells) {
  const [pc, pr] = cellOf(g, p);
  let best = null;
  let bestD = Infinity;
  let foundRing = -1;
  for (let ring = 0; ring <= radiusCells; ring++) {
    if (foundRing >= 0 && ring > foundRing + 1) break;
    for (let dr = -ring; dr <= ring; dr++) {
      for (let dc = -ring; dc <= ring; dc++) {
        if (Math.max(Math.abs(dc), Math.abs(dr)) !== ring || !cellOpen(g, pc + dc, pr + dr)) continue;
        const c = centerOf(g, pc + dc, pr + dr);
        const d = Math.hypot(c[0] - p[0], c[1] - p[1]);
        if (d < bestD) {
          bestD = d;
          best = c;
          if (foundRing < 0) foundRing = ring;
        }
      }
    }
  }
  return best;
}

/** True when every cell the segment a-b touches (supercover, corners included) is open. */
export function lineOfSight(g, a, b) {
  const s = g.cellPx;
  const x0 = a[0] / s;
  const y0 = a[1] / s;
  const dx = b[0] / s - x0;
  const dy = b[1] / s - y0;
  let cx = Math.floor(x0);
  let cy = Math.floor(y0);
  const ex = Math.floor(b[0] / s);
  const ey = Math.floor(b[1] / s);
  if (!cellOpen(g, cx, cy)) return false;
  const sx = dx > 0 ? 1 : -1;
  const sy = dy > 0 ? 1 : -1;
  const tDx = dx === 0 ? Infinity : Math.abs(1 / dx);
  const tDy = dy === 0 ? Infinity : Math.abs(1 / dy);
  let tx = dx === 0 ? Infinity : (dx > 0 ? cx + 1 - x0 : x0 - cx) * tDx;
  let ty = dy === 0 ? Infinity : (dy > 0 ? cy + 1 - y0 : y0 - cy) * tDy;
  let steps = Math.abs(ex - cx) + Math.abs(ey - cy);
  while (steps-- > 0) {
    if (tx < ty) {
      cx += sx;
      tx += tDx;
    } else if (ty < tx) {
      cy += sy;
      ty += tDy;
    } else {
      if (!cellOpen(g, cx + sx, cy) || !cellOpen(g, cx, cy + sy)) return false;
      cx += sx;
      cy += sy;
      tx += tDx;
      ty += tDy;
      steps--;
    }
    if (!cellOpen(g, cx, cy)) return false;
  }
  return true;
}

/** Cell index path from cell s to cell t (both open), or null. 8-way, octile heuristic, no corner cutting. */
function astar(g, s, t) {
  const { cols, rows } = g;
  const n = cols * rows;
  const gs = new Float32Array(n).fill(Infinity);
  const fs = new Float32Array(n);
  const parent = new Int32Array(n).fill(-1);
  const done = new Uint8Array(n);
  const tc = t % cols;
  const tr = (t / cols) | 0;
  const h = (i) => {
    const dx = Math.abs((i % cols) - tc);
    const dy = Math.abs(((i / cols) | 0) - tr);
    return (Math.max(dx, dy) + (SQRT2 - 1) * Math.min(dx, dy)) * 1.001;
  };
  const heap = [];
  const push = (i) => {
    heap.push(i);
    let k = heap.length - 1;
    while (k > 0) {
      const p = (k - 1) >> 1;
      if (fs[heap[p]] <= fs[heap[k]]) break;
      [heap[p], heap[k]] = [heap[k], heap[p]];
      k = p;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      let k = 0;
      for (;;) {
        const l = 2 * k + 1;
        const rr = l + 1;
        let m = k;
        if (l < heap.length && fs[heap[l]] < fs[heap[m]]) m = l;
        if (rr < heap.length && fs[heap[rr]] < fs[heap[m]]) m = rr;
        if (m === k) break;
        [heap[m], heap[k]] = [heap[k], heap[m]];
        k = m;
      }
    }
    return top;
  };
  gs[s] = 0;
  fs[s] = h(s);
  push(s);
  while (heap.length) {
    const cur = pop();
    if (done[cur]) continue;
    done[cur] = 1;
    if (cur === t) {
      const path = [];
      for (let i = t; i !== -1; i = parent[i]) path.push(i);
      return path.reverse();
    }
    const cc = cur % cols;
    const cr = (cur / cols) | 0;
    for (const [dc, dr] of DIRS) {
      const nc = cc + dc;
      const nr = cr + dr;
      if (!cellOpen(g, nc, nr)) continue;
      if (dc !== 0 && dr !== 0 && (!cellOpen(g, cc + dc, cr) || !cellOpen(g, cc, cr + dr))) continue;
      const ni = nr * cols + nc;
      const ng = gs[cur] + (dc !== 0 && dr !== 0 ? SQRT2 : 1);
      if (ng < gs[ni]) {
        gs[ni] = ng;
        parent[ni] = cur;
        fs[ni] = ng + h(ni);
        push(ni);
      }
    }
  }
  return null;
}

/** Drops the middle point of every three that lie on one line. */
function mergeCollinear(pts) {
  const out = [pts[0]];
  for (let k = 1; k < pts.length - 1; k++) {
    const a = out[out.length - 1];
    const b = pts[k];
    const c = pts[k + 1];
    const cr = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    const dot = (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1]);
    if (Math.abs(cr) > 1e-6 || dot < 0) out.push(b);
  }
  out.push(pts[pts.length - 1]);
  return out;
}

/**
 * Shortest walk from `from` to `to`: A*, then string pulling, then collinear merging. A blocked start or goal moves to
 * the nearest open cell centre (within `snapRadiusCells`). First point = `from`; last = `to`, or the snapped goal.
 * @returns {Pt[] | null} null when no route exists
 */
export function findPath(g, from, to, { snapRadiusCells }) {
  let a = from;
  let b = to;
  if (!isOpen(g, a)) {
    a = snapOpen(g, a, snapRadiusCells);
    if (!a) return null;
  }
  if (!isOpen(g, b)) {
    b = snapOpen(g, b, snapRadiusCells);
    if (!b) return null;
  }
  const [sc, sr] = cellOf(g, a);
  const [tc, tr] = cellOf(g, b);
  const cells = sc === tc && sr === tr ? [sr * g.cols + sc] : astar(g, sr * g.cols + sc, tr * g.cols + tc);
  if (!cells) return null;
  const pts = [from];
  if (a !== from) pts.push(a);
  for (const i of cells) pts.push(centerOf(g, i % g.cols, (i / g.cols) | 0));
  pts.push(b);
  // string pulling from the start, always to the farthest point still in sight
  const pulled = [pts[0]];
  let i = 0;
  while (i < pts.length - 1) {
    let j = pts.length - 1;
    while (j > i + 1 && !lineOfSight(g, pts[i], pts[j])) j--;
    pulled.push(pts[j]);
    i = j;
  }
  const merged = mergeCollinear(pulled);
  return merged.length === 2 && merged[0][0] === merged[1][0] && merged[0][1] === merged[1][1] ? [merged[0]] : merged;
}

/**
 * One baker + path cache for every scene on a page. Grids bake on first use; paths are cached by
 * `design|fromCell|toCell` in a LRU of `nav.pathCache` entries (end points are re-pinned to the asked-for points).
 * @param {Map<string, object>} scenes design -> resolved scene
 */
export function createNav(scenes, nav) {
  const grids = new Map();
  const cache = new Map();
  const stat = { bakes: 0, hits: 0, misses: 0 };
  const opts = { snapRadiusCells: nav.snapRadiusCells };
  const grid = (design) => {
    let g = grids.get(design);
    if (!g) {
      g = bakeGrid(scenes.get(design), nav);
      grids.set(design, g);
      stat.bakes++;
    }
    return g;
  };
  return {
    grid,
    snap: (design, p) => {
      const g = grid(design);
      return isOpen(g, p) ? p : snapOpen(g, p, nav.snapRadiusCells);
    },
    path(design, from, to) {
      const g = grid(design);
      const key = `${design}|${cellOf(g, from)}|${cellOf(g, to)}`;
      const hit = cache.get(key);
      if (hit !== undefined) {
        cache.delete(key);
        cache.set(key, hit);
        if (hit === null) {
          stat.hits++;
          return null;
        }
        const out = hit.map((p) => p.slice());
        out[0] = from;
        if (isOpen(g, to) && out.length > 1) out[out.length - 1] = to;
        // the re-pinned first and last legs were not smoothed against the grid: keep the hit only if they still see open cells
        const n = out.length;
        if (n < 2 || (lineOfSight(g, out[0], out[1]) && lineOfSight(g, out[n - 2], out[n - 1]))) {
          stat.hits++;
          return out;
        }
        stat.misses++;
        return findPath(g, from, to, opts);
      }
      stat.misses++;
      const p = findPath(g, from, to, opts);
      cache.set(key, p);
      if (cache.size > nav.pathCache) cache.delete(cache.keys().next().value);
      return p && p.map((q) => q.slice());
    },
    stats: () => ({ ...stat }),
  };
}
