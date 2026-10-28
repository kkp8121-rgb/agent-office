// Scene data: format check, resolving (kinds -> placed objects, seats, lead, tray) and the point helpers every
// other scene module shares. Pure: no DOM, no process, no I/O, so the browser, the server, the tests and the
// validator all run the same code. Every planned number arrives as an argument.

/** @typedef {[number, number]} Pt */
/** @typedef {'left'|'right'} Face */

export const SPOT_KINDS = ['coffee', 'water', 'window', 'shelf', 'plant', 'sofa', 'whiteboard', 'other'];
const DEPTHS = ['auto', 'overhead', 'floor'];
const MIN_SEATS = 12;
const MIN_QUEUE = 12;
const MIN_IDLE = 6;
const MIN_OVERFLOW = 8;
const SPOTS_RANGE = [4, 8];

// ---------- geometry ----------

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
export const isPt = (p) => Array.isArray(p) && p.length === 2 && isNum(p[0]) && isNum(p[1]);
const isPoly = (p) => Array.isArray(p) && p.length >= 3 && p.every(isPt);

export function pointInPoly(pt, poly) {
  const [x, y] = pt;
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** @param {Pt} pt @param {Pt[][]} polys */
export function pointInPolys(pt, polys) {
  return polys.some((poly) => pointInPoly(pt, poly));
}

export function closestOnSeg(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2));
  return [a[0] + t * dx, a[1] + t * dy];
}

/** Distance from `pt` to the nearest edge of one polygon (inside or outside). */
export function distToPolyEdge(pt, poly) {
  let best = Infinity;
  for (let k = 0; k < poly.length; k++) {
    const q = closestOnSeg(pt, poly[k], poly[(k + 1) % poly.length]);
    best = Math.min(best, Math.hypot(pt[0] - q[0], pt[1] - q[1]));
  }
  return best;
}

/** Distance to the outer boundary of a union of polygons: an edge stretch lying inside another polygon is not boundary. */
export function distToUnionEdge(pt, polys) {
  let best = Infinity;
  polys.forEach((poly, pi) => {
    for (let k = 0; k < poly.length; k++) {
      const q = closestOnSeg(pt, poly[k], poly[(k + 1) % poly.length]);
      const d = Math.hypot(pt[0] - q[0], pt[1] - q[1]);
      if (d >= best) continue;
      if (polys.length > 1 && polys.some((o, oi) => oi !== pi && pointInPoly(q, o))) continue;
      best = d;
    }
  });
  return best;
}

const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

function segsCross(p1, p2, p3, p4) {
  const d1 = cross(p3, p4, p1);
  const d2 = cross(p3, p4, p2);
  const d3 = cross(p1, p2, p3);
  const d4 = cross(p1, p2, p4);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** True when the segment a-b touches the polygon (an end point inside, or any edge crossing). */
export function segHitsPoly(a, b, poly) {
  if (pointInPoly(a, poly) || pointInPoly(b, poly)) return true;
  for (let k = 0; k < poly.length; k++) if (segsCross(a, b, poly[k], poly[(k + 1) % poly.length])) return true;
  return false;
}

/** True when two polygons overlap (a shared border alone does not count). Probes edge crossings, then vertices, edge midpoints and the centre. */
export function polysOverlap(p, q) {
  for (let i = 0; i < p.length; i++) {
    for (let j = 0; j < q.length; j++) {
      if (segsCross(p[i], p[(i + 1) % p.length], q[j], q[(j + 1) % q.length])) return true;
    }
  }
  const probes = (poly) => [
    ...poly,
    ...poly.map((a, i) => [(a[0] + poly[(i + 1) % poly.length][0]) / 2, (a[1] + poly[(i + 1) % poly.length][1]) / 2]),
    [poly.reduce((s, a) => s + a[0], 0) / poly.length, poly.reduce((s, a) => s + a[1], 0) / poly.length],
  ];
  const strictlyIn = (pt, poly) => pointInPoly(pt, poly) && distToPolyEdge(pt, poly) > 0.01;
  return probes(p).some((pt) => strictlyIn(pt, q)) || probes(q).some((pt) => strictlyIn(pt, p));
}

export const polyMinY = (poly) => Math.min(...poly.map((p) => p[1]));
export const polyMaxY = (poly) => Math.max(...poly.map((p) => p[1]));

// ---------- format check ----------

/**
 * Stage 1 of the scene check: shape of every field. Returns "<field path>: <reason>" strings, empty = passes.
 * @param {object} raw
 * @param {{atlasSize: Pt|null, inflatePx: number, minSeats?: number}} opts
 * @returns {string[]}
 */
export function checkSceneFormat(raw, opts) {
  const out = [];
  const err = (path, msg) => out.push(`${path}: ${msg}`);
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return ['scene: JSON 객체가 아닙니다'];
  const minSeats = opts.minSeats ?? raw.minSeats ?? MIN_SEATS;
  const { inflatePx } = opts;

  if (raw.version !== 1) err('version', '1 이어야 합니다');
  if (typeof raw.design !== 'string' || raw.design === '') err('design', '문자열이어야 합니다');
  const sizeOk = isPt(raw.size) && raw.size[0] > 0 && raw.size[1] > 0;
  if (!sizeOk) err('size', '[폭, 높이] 양수여야 합니다');
  const size = sizeOk ? raw.size : [Infinity, Infinity];
  for (const k of ['shell', 'atlas']) if (typeof raw[k] !== 'string' || raw[k] === '') err(k, '파일 이름 문자열이어야 합니다');
  if (raw.front !== null && raw.front !== undefined && typeof raw.front !== 'string') err('front', '파일 이름 또는 null 이어야 합니다');
  if (!Array.isArray(raw.board) || raw.board.length !== 4 || !raw.board.every(isNum)) err('board', '[x, y, w, h] 여야 합니다');
  if (!isPt(raw.reports)) err('reports', '[dx, dy] 여야 합니다');
  if (raw.sign !== null && raw.sign !== undefined && !isPt(raw.sign)) err('sign', '[x, y] 또는 null 이어야 합니다');

  const inSize = (p) => p[0] >= 0 && p[1] >= 0 && p[0] <= size[0] && p[1] <= size[1];
  const polyList = (name, required) => {
    const list = raw[name];
    if (!Array.isArray(list) || (required && list.length === 0)) {
      err(name, '다각형 목록이어야 합니다');
      return [];
    }
    list.forEach((poly, i) => {
      if (!isPoly(poly)) err(`${name}[${i}]`, '꼭짓점 3개 이상의 [x, y] 목록이어야 합니다');
      else if (!poly.every(inSize)) err(`${name}[${i}]`, '꼭짓점이 방 크기 밖입니다');
    });
    return list.filter(isPoly);
  };
  const walkable = polyList('walkable', true);
  polyList('blocked', false);
  polyList('frontMask', false);

  /** Point must be in the walkable floor, `inflatePx` or more away from its outer edge. */
  const margin = (path, p) => {
    if (!isPt(p)) return err(path, '[x, y] 여야 합니다');
    if (!inSize(p)) return err(path, '방 크기 밖입니다');
    if (!walkable.length) return;
    if (!pointInPolys(p, walkable)) return err(path, '걸을 수 있는 바닥 밖입니다');
    const d = distToUnionEdge(p, walkable);
    if (d < inflatePx) err(path, `바닥 경계에서 ${inflatePx}px 이상 안쪽이어야 합니다 (현재 ${Math.round(d)}px)`);
  };

  if (raw.door === null || typeof raw.door !== 'object') err('door', '{at, face} 여야 합니다');
  else {
    margin('door.at', raw.door.at);
    if (!['left', 'right'].includes(raw.door.face)) err('door.face', "'left' 또는 'right' 여야 합니다");
  }

  // kinds
  const kinds = raw.kinds !== null && typeof raw.kinds === 'object' && !Array.isArray(raw.kinds) ? raw.kinds : null;
  if (!kinds) err('kinds', '종류 표(객체)여야 합니다');
  for (const [name, k] of Object.entries(kinds ?? {})) {
    const p = `kinds.${name}`;
    if (k === null || typeof k !== 'object') {
      err(p, '객체여야 합니다');
      continue;
    }
    const r = k.rect;
    if (!Array.isArray(r) || r.length !== 4 || !r.every(isNum) || r[2] <= 0 || r[3] <= 0) err(`${p}.rect`, '[x, y, w, h] 양수여야 합니다');
    else if (opts.atlasSize && (r[0] < 0 || r[1] < 0 || r[0] + r[2] > opts.atlasSize[0] || r[1] + r[3] > opts.atlasSize[1])) {
      err(`${p}.rect`, `아틀라스(${opts.atlasSize[0]}x${opts.atlasSize[1]}) 밖입니다`);
    }
    if (!isPt(k.anchor)) err(`${p}.anchor`, '[ax, ay] 여야 합니다');
    else if (Array.isArray(r) && r.length === 4 && (k.anchor[0] < 0 || k.anchor[1] < 0 || k.anchor[0] > r[2] || k.anchor[1] > r[3])) err(`${p}.anchor`, '그림 안이어야 합니다');
    if (k.depth !== undefined && !DEPTHS.includes(k.depth)) err(`${p}.depth`, `${DEPTHS.join(' | ')} 중 하나여야 합니다`);
    if (k.footprint !== undefined && !isPoly(k.footprint)) err(`${p}.footprint`, '꼭짓점 3개 이상의 [dx, dy] 목록이어야 합니다');
    if (k.blocks !== undefined && typeof k.blocks !== 'boolean') err(`${p}.blocks`, 'true/false 여야 합니다');
    if ((k.depth ?? 'auto') === 'auto' && (k.blocks ?? true) && k.footprint === undefined) err(`${p}.footprint`, '길을 막는 종류에는 footprint 가 필요합니다');
    if (k.seat !== undefined) {
      const s = k.seat;
      if (s === null || typeof s !== 'object') err(`${p}.seat`, '객체여야 합니다');
      else {
        for (const f of ['at', 'approach']) if (!isPt(s[f])) err(`${p}.seat.${f}`, '[dx, dy] 여야 합니다');
        for (const f of ['sitAt', 'visit']) if (s[f] !== undefined && s[f] !== null && !isPt(s[f])) err(`${p}.seat.${f}`, '[dx, dy] 여야 합니다');
        if (!['left', 'right'].includes(s.face)) err(`${p}.seat.face`, "'left' 또는 'right' 여야 합니다");
      }
    }
  }

  // objects
  const byId = new Map();
  const ids = new Set();
  if (!Array.isArray(raw.objects) || raw.objects.length === 0) err('objects', '오브젝트 목록이어야 합니다');
  (Array.isArray(raw.objects) ? raw.objects : []).forEach((o, i) => {
    const p = `objects[${i}]`;
    if (o === null || typeof o !== 'object') return err(p, '객체여야 합니다');
    if (typeof o.id !== 'string' || o.id === '') err(`${p}.id`, '문자열이어야 합니다');
    else if (ids.has(o.id)) err(`${p}.id`, `중복 id "${o.id}"`);
    else {
      ids.add(o.id);
      byId.set(o.id, o);
    }
    if (kinds && !Object.hasOwn(kinds, o.kind)) err(`${p}.kind`, `없는 종류 "${o.kind}"`);
    if (!isPt(o.at)) err(`${p}.at`, '[x, y] 여야 합니다');
    else if (!inSize(o.at)) err(`${p}.at`, '방 크기 밖입니다');
    if (o.flipX !== undefined && typeof o.flipX !== 'boolean') err(`${p}.flipX`, 'true/false 여야 합니다');
  });

  // seats
  const seatAbs = []; // [path, point] for the margin check, only for seats whose object resolved
  if (!Array.isArray(raw.seats)) err('seats', '책상 id 목록이어야 합니다');
  else {
    if (raw.seats.length < minSeats) err('seats', `자리가 ${minSeats}개 이상이어야 합니다 (현재 ${raw.seats.length})`);
    raw.seats.forEach((id, i) => {
      const o = byId.get(id);
      if (!o) return err(`seats[${i}]`, `없는 오브젝트 id "${id}"`);
      const k = kinds?.[o.kind];
      if (!k?.seat) return err(`seats[${i}]`, `"${id}" 의 종류에 seat 가 없습니다`);
      if (isPt(o.at) && isPt(k.seat.approach)) seatAbs.push([`seats[${i}].approach`, rel(o, k.seat.approach)]);
      if (isPt(o.at) && isPt(k.seat.visit)) seatAbs.push([`seats[${i}].visit`, rel(o, k.seat.visit)]);
    });
    if (new Set(raw.seats).size !== raw.seats.length) err('seats', '같은 책상 id 가 두 번 있습니다');
  }

  // lead
  if (raw.lead === null || typeof raw.lead !== 'object') err('lead', '{desk, at, approach, face} 여야 합니다');
  else {
    const l = raw.lead;
    if (!byId.has(l.desk)) err('lead.desk', `없는 오브젝트 id "${l.desk}"`);
    if (!isPt(l.at)) err('lead.at', '[x, y] 여야 합니다');
    if (l.sitAt !== undefined && l.sitAt !== null && !isPt(l.sitAt)) err('lead.sitAt', '[x, y] 여야 합니다');
    margin('lead.approach', l.approach);
    if (!['left', 'right'].includes(l.face)) err('lead.face', "'left' 또는 'right' 여야 합니다");
  }
  for (const [path, p] of seatAbs) margin(path, p);

  // tray, idle, overflow
  if (raw.tray === null || typeof raw.tray !== 'object') err('tray', '{object, queue} 여야 합니다');
  else {
    if (!byId.has(raw.tray.object)) err('tray.object', `없는 오브젝트 id "${raw.tray.object}"`);
    if (!Array.isArray(raw.tray.queue) || raw.tray.queue.length < MIN_QUEUE) err('tray.queue', `${MIN_QUEUE}점 이상이어야 합니다`);
    else raw.tray.queue.forEach((p, i) => margin(`tray.queue[${i}]`, p));
  }
  for (const [name, min] of [['idle', MIN_IDLE], ['overflow', MIN_OVERFLOW]]) {
    if (!Array.isArray(raw[name]) || raw[name].length < min) err(name, `${min}점 이상이어야 합니다`);
    else {
      raw[name].forEach((s, i) => {
        margin(`${name}[${i}].at`, s?.at);
        if (!['left', 'right'].includes(s?.face)) err(`${name}[${i}].face`, "'left' 또는 'right' 여야 합니다");
      });
    }
  }

  // spots
  if (!Array.isArray(raw.spots) || raw.spots.length < SPOTS_RANGE[0] || raw.spots.length > SPOTS_RANGE[1]) {
    err('spots', `${SPOTS_RANGE[0]}~${SPOTS_RANGE[1]}개여야 합니다 (현재 ${Array.isArray(raw.spots) ? raw.spots.length : 0})`);
  }
  const spotIds = new Set();
  (Array.isArray(raw.spots) ? raw.spots : []).forEach((s, i) => {
    const p = `spots[${i}]`;
    if (s === null || typeof s !== 'object') return err(p, '객체여야 합니다');
    if (typeof s.id !== 'string' || s.id === '') err(`${p}.id`, '문자열이어야 합니다');
    else if (spotIds.has(s.id)) err(`${p}.id`, `중복 id "${s.id}"`);
    else spotIds.add(s.id);
    if (!SPOT_KINDS.includes(s.kind)) err(`${p}.kind`, `${SPOT_KINDS.join(' | ')} 중 하나여야 합니다`);
    margin(`${p}.at`, s.at);
    if (s.pair !== undefined && s.pair !== null) margin(`${p}.pair`, s.pair);
    if (!['left', 'right'].includes(s.face)) err(`${p}.face`, "'left' 또는 'right' 여야 합니다");
  });
  return out;
}

// ---------- resolving ----------

const flipFace = (face) => (face === 'left' ? 'right' : 'left');

/** Point given relative to an object's `at`, mirrored when the object is flipped. */
function rel(obj, d) {
  return [obj.at[0] + (obj.flipX ? -d[0] : d[0]), obj.at[1] + d[1]];
}

/**
 * Expands kinds into placed objects, seats and the special points. `sitAt` defaults to `at`, `visit` and `pair` to null.
 * A flipped object mirrors its footprint and its seat dx (and the seat's face).
 * @param {object} raw a scene that passed checkSceneFormat
 */
export function resolveScene(raw) {
  const objects = raw.objects.map((o) => {
    const k = raw.kinds[o.kind];
    const depth = o.depth ?? k.depth ?? 'auto';
    const flipX = o.flipX === true;
    const base = { at: o.at, flipX };
    const fp = o.footprint ?? k.footprint ?? [];
    return {
      id: o.id,
      kind: o.kind,
      at: o.at,
      flipX,
      rect: k.rect,
      anchor: k.anchor,
      footprint: fp.map((d) => rel(base, d)),
      blocks: depth === 'auto' ? (o.blocks ?? k.blocks ?? true) : false,
      depth,
    };
  });
  const byId = new Map(objects.map((o) => [o.id, o]));
  const seats = raw.seats.map((id, i) => {
    const o = byId.get(id);
    const s = raw.kinds[o.kind].seat;
    const base = { at: o.at, flipX: o.flipX };
    const at = rel(base, s.at);
    return {
      i,
      deskId: id,
      at,
      sitAt: s.sitAt ? rel(base, s.sitAt) : at,
      approach: rel(base, s.approach),
      visit: s.visit ? rel(base, s.visit) : null,
      face: o.flipX ? flipFace(s.face) : s.face,
    };
  });
  const l = raw.lead;
  const trayObj = byId.get(raw.tray.object);
  return {
    design: raw.design,
    size: raw.size,
    shell: raw.shell,
    front: raw.front ?? null,
    atlas: raw.atlas,
    board: raw.board,
    reports: raw.reports,
    sign: raw.sign ?? null,
    walkable: raw.walkable,
    blocked: raw.blocked,
    frontMask: raw.frontMask ?? [],
    door: raw.door,
    objects,
    seats,
    lead: { deskId: l.desk, at: l.at, sitAt: l.sitAt ?? l.at, approach: l.approach, face: l.face },
    tray: { objectId: raw.tray.object, at: trayObj.at, queue: raw.tray.queue },
    idle: raw.idle,
    overflow: raw.overflow,
    spots: raw.spots.map((s) => ({ ...s, pair: s.pair ?? null })),
  };
}

/** Where finished agent `i` stands: the queue point, then rows lifted `trayRowPx` per extra lap (before snapping to open floor). */
export function trayPoint(r, i, trayRowPx) {
  const { queue } = r.tray;
  const row = Math.floor(i / queue.length);
  const [x, y] = queue[i % queue.length];
  return [x, y - row * trayRowPx];
}

/**
 * Overflow points `0..count-1`. The first lap is the scene's own points. A later lap moves its base point to the nearest
 * spot (stepping `stepPx`, within `searchPx`) that is open floor and whose sprite box overlaps every seat, idle spot, the lead and
 * every earlier overflow point by at most `maxOverlap` of its area; when no spot is that free, the one with the smallest worst overlap wins. Open floor means
 * the screen's snap leaves the point where it is, so what is checked here is what is drawn.
 * @param {object} r resolved scene
 * @param {{isOpen: (p: number[]) => boolean, boxPx: number[], stepPx: number, searchPx: number, maxOverlap: number}} o
 * @returns {{at: number[], ring: number}[]}
 */
export function overflowPoints(r, count, o) {
  const n = r.overflow.length;
  const [bw, bh] = o.boxPx;
  const overlap = (p, q) => Math.max(0, bw - Math.abs(p[0] - q[0])) * Math.max(0, bh - Math.abs(p[1] - q[1])) / (bw * bh);
  const offsets = [];
  for (let dy = -o.searchPx; dy <= o.searchPx; dy += o.stepPx) {
    for (let dx = -o.searchPx; dx <= o.searchPx; dx += o.stepPx) if (Math.hypot(dx, dy) <= o.searchPx) offsets.push([dx, dy]);
  }
  offsets.sort((a, b) => Math.hypot(a[0], a[1]) - Math.hypot(b[0], b[1]) || a[1] - b[1] || a[0] - b[0]);
  const fixed = [r.lead.at, r.lead.sitAt, ...r.seats.flatMap((q) => [q.at, q.sitAt]), ...r.idle.map((q) => q.at)];
  const out = [];
  for (let k = 0; k < count; k++) {
    const base = r.overflow[k % n].at;
    const ring = Math.floor(k / n);
    if (ring === 0) {
      out.push({ at: base, ring });
      continue;
    }
    let best = null;
    let bestWorst = Infinity;
    for (const [dx, dy] of offsets) {
      const p = [base[0] + dx, base[1] + dy];
      if (p[0] < bw / 2 || p[0] > r.size[0] - bw / 2 || !o.isOpen(p)) continue;
      let worst = 0;
      for (const q of fixed) worst = Math.max(worst, overlap(p, q));
      for (const q of out) worst = Math.max(worst, overlap(p, q.at));
      if (worst < bestWorst) {
        best = p;
        bestWorst = worst;
        if (worst <= o.maxOverlap) break;
      }
    }
    out.push({ at: best ?? base, ring });
  }
  return out;
}

/** Overflow point `k` (see overflowPoints). */
export function overflowPoint(r, k, o) {
  return overflowPoints(r, k + 1, o)[k];
}
