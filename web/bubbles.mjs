// Speech bubbles that must not cover each other (pure): which one of two overlapping bubbles gives way. DOM and timers live in app.mjs.
// Numbers come from `ui.bubbleClear`.

/** Who keeps the spot: a held character's line, then a canned line, then the task text, then the small 「…」 marker. */
const RANK = { grab: 0, say: 1, txt: 2, dot: 3 };

const hit = (a, b) => Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 0 && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 0;

/**
 * `items` are the visible bubbles of one floor as `{id, kind, x, y, w, h}` (kind grab | say | txt | dot; the box where the bubble sits with no lift).
 * Walks them in rank order (equal ranks keep their order): a 「…」 marker that would cover a placed bubble is hidden, any other bubble
 * moves up (a stack) until it is clear, at most `C.maxLifts` times, `C.gapPx` apart.
 * @returns {Map<any, {lift: number, hide: boolean}>} id -> px to move up and whether to hide
 */
export function clearBubbles(items, C) {
  const out = new Map();
  const placed = [];
  const order = items.map((b, i) => ({ b, i })).sort((p, q) => RANK[p.b.kind] - RANK[q.b.kind] || p.i - q.i);
  for (const { b } of order) {
    let lift = 0;
    const box = () => ({ x: b.x, y: b.y - lift, w: b.w, h: b.h });
    if (b.kind === 'dot') {
      const hide = placed.some((p) => hit(box(), p));
      if (!hide) placed.push(box());
      out.set(b.id, { lift: 0, hide });
      continue;
    }
    for (let n = 0; n < C.maxLifts; n++) {
      const blocker = placed.find((p) => hit(box(), p));
      if (!blocker) break;
      lift = b.y + b.h - blocker.y + C.gapPx; // its bottom edge goes just above the blocker's top
    }
    placed.push(box());
    out.set(b.id, { lift, hide: false });
  }
  return out;
}
