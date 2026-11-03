// Desk props: every desk of a floor is different, the choice is stable, nothing overlaps, flipped desks mirror right.
// Data: the shipped assets/decor/decor.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveScene } from '../web/scene.mjs';
import { deskSlots, localPlacement, overlaps, personalFor, planFloor, signature, withPersonal, worldLeft } from '../web/decor.mjs';
import { cfg, ROOT } from './helpers/fixture.mjs';

const C = cfg.ui.decor;
const data = JSON.parse(readFileSync(join(ROOT, 'assets', 'decor', 'decor.json'), 'utf8'));
const DESIGNS = [...cfg.designOrder, cfg.lobby.design];
const rawOf = (design) => JSON.parse(readFileSync(join(ROOT, 'assets', 'scenes', design, 'scene.json'), 'utf8'));
const desksOf = (design, edit) => {
  const raw = rawOf(design);
  edit?.(raw);
  return resolveScene(raw).objects.filter((o) => data.desks[design]?.[o.kind]);
};
const plan = (design, floor = 2, desks = desksOf(design)) => planFloor({ design, floor, desks, data, cfg: C });
const t = (name, fn) => test(`decor: ${name}`, fn);

t('config: the ui.decor block holds every number', () => {
  assert.deepEqual([C.enabled, C.surface, C.monitorTop, C.stickers, C.personal], [true, [2, 4], [0, 1], [0, 2], true]);
  assert.ok(C.tries > 0 && C.data);
});

t('every design and desk kind has slots, every referenced item exists', () => {
  assert.equal(data.version, 1);
  for (const design of DESIGNS) {
    const kinds = Object.keys(rawOf(design).kinds).filter((k) => k.includes('desk'));
    for (const kind of kinds) {
      const s = deskSlots(data, design, kind);
      assert.ok(s.surface.length >= 1 && s.screen, `${design}/${kind}`);
      const screens = Object.values(data.items).filter((it) => it.slot === 'screen' && it.design === design && it.rect[2] === s.screen[2] && it.rect[3] === s.screen[3]);
      assert.ok(screens.length >= 1, `${design}/${kind} has a screen picture of ${s.screen[2]}x${s.screen[3]}`);
    }
  }
  for (const design of DESIGNS) for (const p of plan(design).flatMap((d) => d.items)) assert.ok(data.items[p.id], p.id);
});

t('no two desks of a floor are alike, for every design and the 40 desks of the lobby', () => {
  for (const design of DESIGNS) {
    const desks = desksOf(design);
    assert.ok(desks.length >= (design === 'lobby' ? 40 : 13), `${design}: ${desks.length} desks`);
    const plans = plan(design, design === 'lobby' ? 1 : 3, desks);
    assert.equal(new Set(plans.map((p) => signature(p))).size, desks.length, design);
  }
  assert.equal(desksOf('lobby').length, 40);
});

t('the sets are stable: same floor same desks, another floor or design another set', () => {
  assert.deepEqual(plan('studio2', 2), plan('studio2', 2));
  const a = plan('studio2', 2).map((p) => signature(p));
  assert.notDeepEqual(a, plan('studio2', 3).map((p) => signature(p)));
  assert.notDeepEqual(a, plan('lounge', 2).map((p) => signature(p)));
  assert.deepEqual(plan('lobby', 1).slice(0, 5), plan('lobby', 1).slice(0, 5));
});

t('a desk gets 2-4 surface items, 0-1 monitor topper, 0-2 stickers and exactly one screen of the right size', () => {
  for (const design of DESIGNS) {
    for (const p of plan(design)) {
      const slots = deskSlots(data, design, p.kind);
      const count = (s) => p.items.filter((i) => i.slot === s).length;
      assert.ok(count('surface') >= Math.min(C.surface[0], slots.surface.length) && count('surface') <= C.surface[1], `${design} ${p.id} surface ${count('surface')}`);
      assert.ok(count('monitorTop') <= C.monitorTop[1]);
      assert.ok(count('bezel') + count('monitorEdge') <= C.stickers[1]);
      assert.equal(count('screen'), 1);
      const [s] = p.items.filter((i) => i.slot === 'screen');
      assert.deepEqual([s.x, s.y, s.w, s.h], slots.screen);
      assert.equal(data.items[s.id].design, design);
      for (const i of p.items) assert.equal(data.items[i.id].slot, i.slot);
    }
  }
});

t('props of one desk never overlap, also with a personal item swapped in', () => {
  const keys = Object.values(data.items).map((i) => i.personal).filter(Boolean);
  for (const design of DESIGNS) {
    for (const p of plan(design)) {
      for (const items of [p.items, ...keys.map((k) => withPersonal(p, data, k))]) {
        const solid = items.filter((i) => i.slot !== 'screen');
        solid.forEach((a, i) => solid.slice(i + 1).forEach((b) => assert.ok(!overlaps(a, b), `${design} ${p.id}: ${a.id} / ${b.id}`)));
        assert.equal(new Set(items.map((i) => i.id)).size, items.length);
      }
    }
  }
});

t('lead items sit only on lead desks, and a lead desk gets one when the art has them', () => {
  const lead = new Set(Object.entries(data.items).filter(([, it]) => it.tags?.includes('lead')).map(([id]) => id));
  for (const design of DESIGNS) {
    for (const p of plan(design)) {
      const has = p.items.some((i) => lead.has(i.id));
      if (!p.kind.startsWith('lead')) assert.ok(!has, `${design} ${p.id} is no lead desk`);
      else if (lead.size) assert.ok(has, `${design} ${p.id} wears a lead item`);
    }
  }
});

t('the personal swap changes the set with the occupant and keeps every desk different', () => {
  const keys = [...new Set(Object.values(data.items).map((i) => i.personal).filter(Boolean))];
  if (!keys.length) return; // the art has no personal items yet
  for (const design of DESIGNS) {
    const plans = plan(design);
    for (const k of keys) {
      const sigs = plans.map((p) => withPersonal(p, data, k).map((i) => i.id).sort().join('|'));
      assert.equal(new Set(sigs).size, plans.length, `${design} everyone is ${k}`);
    }
    const p = plans.find((q) => q.personal >= 0 && !q.kind.startsWith('lead'));
    const [a, b] = keys.filter((k) => withPersonal(p, data, k) !== p.items).slice(0, 2);
    if (b) assert.notEqual(withPersonal(p, data, a)[p.personal].id, withPersonal(p, data, b)[p.personal].id, 'another occupant, another item');
    assert.equal(personalFor(data, 'no-such-sprite'), null);
    assert.equal(withPersonal(p, data, 'no-such-sprite'), p.items);
    assert.equal(withPersonal(p, data, null), p.items);
  }
});

t('personal off: nothing is reserved for a swap', () => {
  for (const p of planFloor({ design: 'studio2', floor: 2, desks: desksOf('studio2'), data, cfg: { ...C, personal: false } })) assert.equal(p.personal, -1);
});

t('a floor with more desks than distinct sets fails loudly', () => {
  const tiny = { ...data, items: Object.fromEntries(Object.entries(data.items).filter(([, it]) => it.slot === 'surface' && !it.tags?.includes('lead') && !it.personal).slice(0, 2)) }; // two props: one possible set
  assert.throws(() => planFloor({ design: 'studio2', floor: 2, desks: desksOf('studio2'), data: tiny, cfg: { ...C, tries: 30 } }), /no distinct set left/);
});

/** Where a node's own CSS mirror puts a child at local `x` of width `w`: the picture's left edge on the stage. */
const visualLeft = (n, x, w) => (n.flipX ? n.x + n.w - x - w : n.x + x);

t('flipped desks mirror the position and the picture; strips hold the item that is inside them', () => {
  const p = { x: 10, y: 30, w: 8, h: 6 };
  const plain = { left: 100, w: 80, flipX: false };
  const flipped = { left: 100, w: 80, flipX: true };
  const one = (d) => [{ x: d.left, w: d.w, flipX: d.flipX }];
  const a = localPlacement(p, plain, one(plain));
  const b = localPlacement(p, flipped, one(flipped));
  assert.deepEqual([a.x, a.flip, b.flip], [10, false, true]);
  assert.equal(visualLeft(one(plain)[0], a.x, p.w), 110, 'unflipped: left edge 10 from the desk left');
  assert.equal(visualLeft(one(flipped)[0], b.x, p.w), 100 + 80 - 10 - 8, 'flipped: mirrored about the desk');
  assert.equal(worldLeft(p, 100, 80, true), 162);
  // a desk cut into 16 px strips (+1 overlap), mirrored or not
  for (const flipX of [false, true]) {
    const desk = { left: 100, w: 83, flipX };
    const nodes = [];
    for (let sx = 0, k = 0; sx < 83; sx += 16, k++) nodes.push({ x: 100 + sx, w: sx + 16 >= 83 ? 83 - sx : 17, flipX });
    for (const q of [{ x: 2, y: 5, w: 6, h: 6 }, { x: 40, y: 30, w: 9, h: 8 }, { x: 70, y: 30, w: 10, h: 8 }]) {
      const lp = localPlacement(q, desk, nodes);
      const n = nodes[lp.node];
      assert.equal(visualLeft(n, lp.x, q.w), worldLeft(q, desk.left, desk.w, flipX), `x=${q.x} flip=${flipX}`);
      const centre = worldLeft(q, desk.left, desk.w, flipX) + q.w / 2;
      assert.ok(n.x <= centre && centre <= n.x + n.w, 'the strip holds the centre');
      assert.equal(lp.flip, flipX);
    }
  }
});

t('a flipped scene desk of the real data mirrors about its anchor', () => {
  const desks = desksOf('studio2', (raw) => raw.objects.forEach((o) => { if (o.kind === 'desk') o.flipX = true; })).filter((o) => o.kind === 'desk');
  assert.ok(desks.length && desks.every((o) => o.flipX));
  const o = desks[0];
  const [, , w] = o.rect;
  const left = o.at[0] - (w - o.anchor[0]);
  const [pl] = plan('studio2', 2, desks);
  for (const it of pl.items) assert.equal(worldLeft(it, left, w, true), left + w - it.x - it.w);
});

t('no prop can reach the head of the character sitting at its desk (any item on any slot point)', () => {
  const H = 64; // sprite height; the head box is its rows 4-32 (28 px wide) above the seat's foot point
  for (const design of DESIGNS) {
    const raw = rawOf(design);
    for (const o of raw.objects) {
      const slots = data.desks[design]?.[o.kind];
      if (!slots) continue;
      const k = raw.kinds[o.kind];
      const foot = o.kind.startsWith('lead') ? raw.lead.sitAt : [o.at[0] + k.seat.sitAt[0], o.at[1] + k.seat.sitAt[1]];
      const head = { x: foot[0] - 14, y: foot[1] - H + 4, w: 28, h: 28 };
      for (const slot of ['surface', 'monitorTop', 'bezel', 'monitorEdge']) {
        for (const [px, py] of slots[slot] ?? []) {
          for (const [id, it] of Object.entries(data.items)) {
            if (it.slot !== slot) continue;
            const p = { x: o.at[0] - k.anchor[0] + px - it.anchor[0], y: o.at[1] - k.anchor[1] + py - it.anchor[1], w: it.rect[2], h: it.rect[3] };
            assert.ok(!overlaps(p, head), `${design} ${o.id} ${slot} (${px},${py}) ${id} reaches the head`);
          }
        }
      }
    }
  }
});
