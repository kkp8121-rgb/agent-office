// Draw order. Objects get a fixed z from the front edge of their footprint (wide slanted ones are cut into vertical
// strips, one z each); a character's z follows its foot y, and a walk is cut where it crosses an object's depth line
// so one z per piece is always right. Pure: no DOM, no process; every number comes from the `depth` config block.

/** @typedef {[number, number]} Pt */
/** @typedef {{id:string, objId:string, x:number, y:number, w:number, h:number, bgX:number, bgY:number, flipX:boolean,
 *             depthY:number, z:number}} ObjNode */
/** @typedef {{from:Pt, to:Pt, z:number}} Piece */

/** Largest y of the polygon at screen x (x is clamped into the polygon's x range). */
function frontAt(poly, x) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const [px] of poly) {
    lo = Math.min(lo, px);
    hi = Math.max(hi, px);
  }
  const cx = Math.min(Math.max(x, lo), hi);
  let best = -Infinity;
  for (let k = 0; k < poly.length; k++) {
    const [ax, ay] = poly[k];
    const [bx, by] = poly[(k + 1) % poly.length];
    if (ax === bx) {
      if (ax === cx) best = Math.max(best, ay, by);
    } else if (cx >= Math.min(ax, bx) && cx <= Math.max(ax, bx)) {
      best = Math.max(best, ay + ((by - ay) * (cx - ax)) / (bx - ax));
    }
  }
  return best;
}

/** Largest front y over x in [x0, x1]: the extremes of a piecewise linear profile sit at the ends or at vertices. */
function frontOver(poly, x0, x1) {
  let best = Math.max(frontAt(poly, x0), frontAt(poly, x1));
  for (const [px] of poly) if (px > x0 && px < x1) best = Math.max(best, frontAt(poly, px));
  return best;
}

/** @returns {ObjNode[]} one DOM node per object, or per strip of a sliced one */
export function objectNodes(r, depth) {
  const { zBase, frontZ, sliceTolerancePx, sliceWidthPx, sliceOverlapPx } = depth;
  const nodes = [];
  for (const o of r.objects) {
    const [rx, ry, w, h] = o.rect;
    const left = o.at[0] - (o.flipX ? w - o.anchor[0] : o.anchor[0]);
    const top = o.at[1] - o.anchor[1];
    const whole = (depthY, z) => nodes.push({ id: o.id, objId: o.id, x: left, y: top, w, h, bgX: rx, bgY: ry, flipX: o.flipX, depthY, z });
    if (o.depth === 'floor') {
      whole(o.at[1], zBase - 1);
      continue;
    }
    if (o.depth === 'overhead') {
      whole(o.at[1], frontZ - 1);
      continue;
    }
    const fp = o.footprint;
    if (fp.length < 3) {
      whole(o.at[1], zBase + 2 * Math.round(o.at[1]));
      continue;
    }
    const xs = fp.map((p) => p[0]);
    const profile = [Math.min(...xs), Math.max(...xs), ...xs].map((x) => frontAt(fp, x));
    const front = Math.max(...profile);
    if (front - Math.min(...profile) <= sliceTolerancePx) {
      whole(front, zBase + 2 * Math.round(front));
      continue;
    }
    let k = 0;
    for (let sx = 0; sx < w; sx += sliceWidthPx, k++) {
      const last = sx + sliceWidthPx >= w;
      const nodeW = last ? w - sx : sliceWidthPx + sliceOverlapPx;
      const depthY = frontOver(fp, left + sx, left + Math.min(sx + sliceWidthPx, w));
      nodes.push({
        id: `${o.id}#${k}`, objId: o.id, x: left + sx, y: top, w: nodeW, h,
        bgX: o.flipX ? rx + w - sx - nodeW : rx + sx, bgY: ry, flipX: o.flipX,
        depthY, z: zBase + 2 * Math.round(depthY),
      });
    }
  }
  return nodes;
}

/** z of a character whose feet are at `footY`: in front of an object whose front edge is at the same y. */
export const charZ = (footY, depth) => depth.zBase + 2 * Math.round(footY) + 1;

/**
 * Cuts a walk (polyline) at every depth line it crosses within `pickMarginPx` of an object's x range, and gives each
 * piece the z of its middle. Pieces shorter than 1px are dropped (a transition that barely changes never ends).
 * @param {Pt[]} points @param {ObjNode[]} nodes
 * @returns {Piece[]}
 */
export function splitWalk(points, nodes, depth) {
  const m = depth.pickMarginPx;
  const lines = nodes.filter((n) => n.z >= depth.zBase && n.z < depth.frontZ - 1);
  const pieces = [];
  for (let k = 0; k < points.length - 1; k++) {
    const a = points[k];
    const b = points[k + 1];
    const ts = [0, 1];
    if (a[1] !== b[1]) {
      const xlo = Math.min(a[0], b[0]);
      const xhi = Math.max(a[0], b[0]);
      for (const n of lines) {
        if (xhi < n.x - m || xlo > n.x + n.w + m) continue;
        const t = (n.depthY - a[1]) / (b[1] - a[1]);
        if (t > 0 && t < 1) ts.push(t);
      }
    }
    ts.sort((p, q) => p - q);
    const cuts = ts.filter((t, i) => i === 0 || t - ts[i - 1] > 1e-9);
    const at = (t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    let prev = null;
    for (let i = 0; i < cuts.length - 1; i++) {
      const from = at(cuts[i]);
      const to = at(cuts[i + 1]);
      if (Math.hypot(to[0] - from[0], to[1] - from[1]) < 1) continue;
      const z = charZ((from[1] + to[1]) / 2, depth);
      if (prev && prev.z === z && prev.seg === k) {
        prev.piece.to = to;
        continue;
      }
      prev = { piece: { from, to, z }, seg: k };
      pieces.push(prev.piece);
    }
  }
  const end = points[points.length - 1];
  const tail = pieces[pieces.length - 1];
  if (tail && (tail.to[0] !== end[0] || tail.to[1] !== end[1]) && Math.hypot(tail.to[0] - end[0], tail.to[1] - end[1]) < 1) tail.to = end;
  return pieces;
}
