// Placed furniture, pure: where it blocks, how it sorts against characters, where the cat may sleep, what changed.
// No DOM, no process. Sizes and anchors come from `ui.decor.items`, depth numbers from the `depth` block.
import { worldFootprint } from './placement.mjs';

/** @typedef {{uid:string, item:string, x:number, y:number}} Placed */

/** Footprints that block walking in one room (flat items such as the rug never do). */
export function blockedPolys(placed, kinds) {
  return placed.flatMap((p) => {
    const k = kinds.get(p.item);
    return k?.blocks ? [worldFootprint(k, p.x, p.y)] : [];
  });
}

/**
 * One draw node per placed item. `z` follows the front edge (the contact point, footprint dy = 0) like an object; the rug lies
 * on the floor under everything (`zBase - 1`). The node is also a depth line for `splitWalk`, so walkers are cut where they pass it.
 */
export function decorNodes(placed, kinds, sizes, depth) {
  const out = [];
  for (const p of placed) {
    const k = kinds.get(p.item);
    const s = sizes[p.item];
    if (!k || !s) continue;
    const [w, h] = s.size;
    out.push({
      id: `decor:${p.uid}`, objId: 'decor', uid: p.uid, item: p.item, x: p.x - s.anchor[0], y: p.y - s.anchor[1], w, h, depthY: p.y,
      z: k.blocks ? depth.zBase + 2 * Math.round(p.y) : depth.zBase - 1,
    });
  }
  return out;
}

/** Cat beds among the placed items, as spots the cat logic can pick (kind `cat-house`); `approach` is where it stands up from. */
export function houseSpots(placed, approachOf) {
  const spots = [];
  for (const p of placed) {
    if (p.item !== 'cat-house') continue;
    const approach = approachOf(p);
    if (approach) spots.push({ id: `decor:${p.uid}`, kind: 'cat-house', at: [p.x, p.y], face: 'right', approach });
  }
  return spots;
}

/** Rooms whose list of placed items differs between two snapshots (design -> list). */
export function changedDesigns(prev, next) {
  const designs = new Set([...Object.keys(prev ?? {}), ...Object.keys(next ?? {})]);
  return [...designs].filter((d) => JSON.stringify(prev?.[d] ?? []) !== JSON.stringify(next?.[d] ?? []));
}

/** Why an item cannot be bought now, or '' when it can. */
export function buyBlock(coins, price) {
  return coins >= price ? '' : `코인이 ${price - coins}개 모자라요`;
}

/** Items the person owns (count above 0), in catalog order. */
export function ownedList(catalog, inventory) {
  return catalog.filter((c) => (inventory?.[c.id] ?? 0) > 0).map((c) => ({ ...c, count: inventory[c.id] }));
}
