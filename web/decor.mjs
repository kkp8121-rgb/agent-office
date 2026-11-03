// Desk props: every desk of a floor gets its own set of small things (figures, plants, mugs, books... on the desk, a
// topper on the monitor, stickers on the bezel, one screen picture), so no two desks on a floor look alike.
// Pure: no DOM, no timers; randomness is the seeded rngFor of ambient.mjs (design, floor number, desk index), so the same
// floor always draws the same desks. Numbers come from `ui.decor`; slot points and item rects from assets/decor/decor.json.
// Coordinates here are in the desk sprite as drawn in objects.png (unflipped); `localPlacement` maps them into a DOM node.
import { rngFor } from './ambient.mjs';

/** @typedef {{id:string, slot:string, point:[number,number], x:number, y:number, w:number, h:number, rx:number, ry:number}} Placement */
/** @typedef {{id:string, kind:string, flipX:boolean, items:Placement[], personal:number}} DeskPlan  personal = index in items of the swappable surface item, -1 when none */

const isLeadKind = (kind) => kind.startsWith('lead');
const isPersonalItem = (it) => it.personal !== undefined || it.tags?.includes('personal');
const intIn = (rng, [a, b]) => a + Math.floor(rng() * (b - a + 1));

/** Fisher-Yates over a copy. */
function shuffled(rng, list) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Slot points of one desk kind; a missing design or kind is a data error, not something to draw around. */
export function deskSlots(data, design, kind) {
  const s = data.desks?.[design]?.[kind];
  if (!s) throw new Error(`decor: no slots for ${design}/${kind}`);
  return s;
}

/** The placement of item `id` with its anchor on `point` (a screen fills its rect, so `point` is the rect's corner). */
function place(data, id, slot, point) {
  const it = data.items[id];
  const [rx, ry, w, h] = it.rect;
  const [ax, ay] = it.anchor;
  return slot === 'screen' ? { id, slot, point, x: point[0], y: point[1], w, h, rx, ry } : { id, slot, point, x: point[0] - ax, y: point[1] - ay, w, h, rx, ry };
}

export const overlaps = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/** Item ids by slot: base ones only (personal items are swapped in later), lead ones only for a lead desk, screens of this design. */
function pools(data, design, lead) {
  const out = { surface: [], monitorTop: [], bezel: [], monitorEdge: [], screen: [] };
  for (const [id, it] of Object.entries(data.items)) {
    if (isPersonalItem(it) || !out[it.slot]) continue;
    if (it.tags?.includes('lead') && !lead) continue;
    if (it.slot === 'screen' && it.design !== design) continue;
    out[it.slot].push(id);
  }
  return out;
}

/** One attempt at a desk's set. */
function build(data, cfg, desk, design, rng) {
  const slots = deskSlots(data, design, desk.kind);
  const lead = isLeadKind(desk.kind);
  const pool = pools(data, design, lead);
  const items = [];
  const used = new Set();
  const tags = new Set();
  /** Puts the first of `ids` (shuffled) that fits at `point`; a surface item of a tag not seen on this desk goes first, `wantTag` before that. */
  const put = (ids, slot, point, wantTag) => {
    const order = shuffled(rng, ids.filter((id) => !used.has(id)));
    if (slot === 'surface') order.sort((a, b) => Number(tags.has(data.items[a].tags?.[0])) - Number(tags.has(data.items[b].tags?.[0])));
    if (wantTag) order.sort((a, b) => Number(!data.items[a].tags?.includes(wantTag)) - Number(!data.items[b].tags?.includes(wantTag)));
    for (const id of order) {
      const p = place(data, id, slot, point);
      if (items.some((q) => q.slot !== 'screen' && overlaps(p, q))) continue;
      items.push(p);
      used.add(id);
      for (const t of data.items[id].tags ?? []) tags.add(t);
      return;
    }
  };
  const surf = shuffled(rng, slots.surface).slice(0, Math.min(intIn(rng, cfg.surface), slots.surface.length));
  surf.forEach((pt, k) => put(pool.surface, 'surface', pt, lead && k === 0 ? 'lead' : null));
  const personal = cfg.personal && items.length ? Math.floor(rng() * items.length) : -1;
  for (const pt of shuffled(rng, slots.monitorTop ?? []).slice(0, intIn(rng, cfg.monitorTop))) put(pool.monitorTop, 'monitorTop', pt);
  const stickerPts = shuffled(rng, [...(slots.bezel ?? []).map((p) => ['bezel', p]), ...(slots.monitorEdge ?? []).map((p) => ['monitorEdge', p])]);
  for (const [slot, pt] of stickerPts.slice(0, intIn(rng, cfg.stickers))) put(pool[slot], slot, pt);
  if (slots.screen) {
    const fit = pool.screen.filter((id) => data.items[id].rect[2] === slots.screen[2] && data.items[id].rect[3] === slots.screen[3]);
    const id = shuffled(rng, fit)[0];
    if (id) items.push(place(data, id, 'screen', [slots.screen[0], slots.screen[1]]));
  }
  return { id: desk.id, kind: desk.kind, flipX: !!desk.flipX, items, personal };
}

/** Identity of a desk's set: its item ids, order free; `blank` leaves out the swappable item. */
export function signature(plan, blank = false) {
  return plan.items.filter((_, i) => !(blank && i === plan.personal)).map((p) => p.id).sort().join('|');
}

/**
 * The sets of every desk of one floor, all different (also with the personal item swapped in: the swappable item is left out of the
 * comparison). Same floor and desk list -> same result. Throws when the floor has more desks than the data can tell apart.
 * @param {{design:string, floor:number, desks:{id:string, kind:string, flipX?:boolean}[], data:object, cfg:object}} a
 * @returns {DeskPlan[]}
 */
export function planFloor({ design, floor, desks, data, cfg }) {
  const seen = new Set();
  const seenBlank = new Set();
  return desks.map((desk, index) => {
    for (let attempt = 0; attempt < cfg.tries; attempt++) {
      const seed = `${design}|${floor}|${index}${attempt ? `|${attempt}` : ''}`;
      const plan = build(data, cfg, desk, design, rngFor(seed));
      const sig = signature(plan);
      const blank = signature(plan, true);
      if (seen.has(sig) || (cfg.personal && seenBlank.has(blank))) continue;
      seen.add(sig);
      seenBlank.add(blank);
      return plan;
    }
    throw new Error(`decor: ${design} floor ${floor}: no distinct set left for desk ${index} (${desk.id}) after ${cfg.tries} tries`);
  });
}

/** The item id wearing the personal touch of a sprite key, or null. */
export function personalFor(data, spriteKey) {
  for (const [id, it] of Object.entries(data.items)) if (it.personal === spriteKey) return id;
  return null;
}

/** The desk's items with its swappable one replaced by `spriteKey`'s personal item; unchanged when there is none or it would overlap another item. */
export function withPersonal(plan, data, spriteKey) {
  const id = plan.personal >= 0 && spriteKey ? personalFor(data, spriteKey) : null;
  if (!id) return plan.items;
  const swapped = place(data, id, 'surface', plan.items[plan.personal].point);
  if (plan.items.some((q, i) => i !== plan.personal && q.slot !== 'screen' && overlaps(swapped, q))) return plan.items;
  return plan.items.map((q, i) => (i === plan.personal ? swapped : q));
}

/** Where `p` lies in the world: desk sprite left edge `left`, sprite width `w`, mirrored when `flipX`. Returns the left x. */
export const worldLeft = (p, left, w, flipX) => (flipX ? left + w - p.x - p.w : left + p.x);

/**
 * Where a placement goes inside one node of its desk: the node that holds its centre (a desk cut into depth strips has several),
 * the left in that node before the node's own CSS mirror, and whether the picture must be mirrored back (a mirrored node mirrors its children).
 * @param {Placement} p @param {{left:number, w:number, flipX:boolean}} desk @param {{x:number, w:number, flipX:boolean}[]} nodes the desk's nodes, left to right
 */
export function localPlacement(p, desk, nodes) {
  const wx = worldLeft(p, desk.left, desk.w, desk.flipX);
  const centre = wx + p.w / 2;
  let node = 0;
  nodes.forEach((n, k) => { if (n.x <= centre) node = k; });
  const n = nodes[node];
  const x = n.flipX ? n.w - (wx - n.x) - p.w : wx - n.x;
  return { node, x, y: p.y, flip: !!n.flipX };
}
