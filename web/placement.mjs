// Furniture placement rule, shared by the server (which enforces it) and the page (which previews it), so they
// cannot disagree. Pure: no DOM, no process, no I/O. Every number arrives as an argument.
import { pointInPoly, pointInPolys, polysOverlap } from './scene.mjs';
import { bakeGrid, findPath, isOpen } from './nav.mjs';

/** @typedef {[number, number]} Pt */
/** @typedef {{id:string, blocks:boolean, footprint:Pt[]}} DecorKind footprint = [dx, dy] corners from the floor-contact point */

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** Footprint of one item standing at (x, y), in scene pixels. */
export function worldFootprint(kind, x, y) {
  return kind.footprint.map(([dx, dy]) => [x + dx, y + dy]);
}

/** Every place a walker must be able to reach (and that furniture must not cover): entrance excluded, it is the route start. */
export function mustReach(r) {
  return [
    ['자리', r.seats.map((s) => s.approach)],
    ['방문 자리', r.seats.filter((s) => s.visit).map((s) => s.visit)],
    ['사장 자리', [r.lead.approach]],
    ['대기 줄', r.tray.queue],
    ['쉬는 자리', r.idle.map((s) => s.at)],
    ['대기 자리', r.overflow.map((s) => s.at)],
    ['쉬는 곳', r.spots.flatMap((s) => (s.pair ? [s.at, s.pair] : [s.at]))],
  ].flatMap(([label, pts]) => pts.map((p) => [label, p]));
}

/** Points a footprint must never lie on (the standing and sitting points themselves, not only the approaches). */
function slotPoints(r) {
  return [
    ...r.seats.flatMap((s) => [s.at, s.sitAt, s.approach]),
    r.lead.at, r.lead.sitAt,
    ...r.tray.queue,
    ...r.idle.map((s) => s.at),
    ...r.overflow.map((s) => s.at),
    ...r.spots.flatMap((s) => (s.pair ? [s.at, s.pair] : [s.at])),
    r.door.at,
  ];
}

const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];

/**
 * Decides whether `candidate` may stand in the room.
 * @param {object} r resolved scene
 * @param {object} nav the `nav` block of config.json
 * @param {Map<string, DecorKind>|Record<string, DecorKind>} kinds catalog by id
 * @param {{item:string, x:number, y:number, uid?:string}[]} placed what already stands in this room (the moved item must not be in it)
 * @param {{item:string, x:number, y:number}} candidate
 * @returns {{ok:true} | {ok:false, code:string, message:string}}
 */
export function checkPlacement(r, nav, kinds, placed, candidate) {
  const get = (id) => (kinds instanceof Map ? kinds.get(id) : Object.hasOwn(kinds, id) ? kinds[id] : undefined);
  const fail = (code, message) => ({ ok: false, code, message });
  const kind = get(candidate.item);
  if (!kind) return fail('unknown-item', '알 수 없는 가구예요');
  const { x, y } = candidate;
  if (!isNum(x) || !isNum(y) || x < 0 || y < 0 || x > r.size[0] || y > r.size[1]) return fail('bad-position', '방 밖이에요');

  // lies on the walkable floor (corners and edge middles, so a notch in the floor is noticed)
  const poly = worldFootprint(kind, x, y);
  const probes = [...poly, ...poly.map((p, i) => mid(p, poly[(i + 1) % poly.length]))];
  if (!probes.every((p) => pointInPolys(p, r.walkable))) return fail('off-floor', '바닥 위에만 놓을 수 있어요');
  if (!kind.blocks) return { ok: true }; // flat: nobody has to walk around it

  // does not stand on, or overlap, anything that already blocks
  for (const o of r.objects) {
    if (o.blocks && o.footprint.length >= 3 && polysOverlap(poly, o.footprint)) return fail('overlap', '다른 가구와 겹쳐요');
  }
  for (const b of r.blocked) if (polysOverlap(poly, b)) return fail('overlap', '막힌 곳과 겹쳐요');
  const others = placed.map((p) => ({ kind: get(p.item), p })).filter((o) => o.kind?.blocks);
  const otherPolys = others.map((o) => worldFootprint(o.kind, o.p.x, o.p.y));
  for (const q of otherPolys) if (polysOverlap(poly, q)) return fail('overlap', '다른 가구와 겹쳐요');

  // does not cover a seat, a rest spot or the entrance
  if (slotPoints(r).some((p) => pointInPoly(p, poly))) return fail('covers-slot', '자리나 쉬는 곳, 출입구를 덮을 수 없어요');

  // every place a walker goes stays reachable from the entrance on the grid that includes this item
  const grid = bakeGrid({ ...r, blocked: [...r.blocked, ...otherPolys, poly] }, nav);
  if (!isOpen(grid, r.door.at)) return fail('blocks-path', '출입구로 가는 길을 막아요');
  const opts = { snapRadiusCells: nav.snapRadiusCells };
  for (const [label, p] of mustReach(r)) {
    if (!isOpen(grid, p) || !findPath(grid, r.door.at, p, opts)) return fail('blocks-path', `${label}(으)로 가는 길을 막아요`);
  }
  return { ok: true };
}
