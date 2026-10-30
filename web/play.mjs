// Play with the characters (pure): poke escalation, throw velocity and flight path, who a drop lands near, which line to say.
// Numbers and lines come from `ui.poke`, `ui.throw`, `ui.play` and `ui.lines`. Pointer and DOM handling live in app.js.

/** Poke state after a click at `now`: the level goes up while clicks follow each other within `resetMs`, otherwise it starts again at 1. */
export function nextPoke(prev, now, p) {
  const level = prev && now - prev.at <= p.resetMs ? Math.min(prev.level + 1, p.maxLevel) : 1;
  return { level, at: now };
}

/** A random line of `pool` that is not `last` (a one-line pool repeats). `rng` returns [0, 1). */
export function pickLine(rng, pool, last) {
  if (pool.length < 2) return pool[0] ?? '';
  const i = Math.floor(rng() * (pool.length - 1));
  const at = last === undefined ? -1 : pool.indexOf(last);
  return pool[at >= 0 && i >= at ? i + 1 : i];
}

/** Morning, day, evening or night for a clock hour. */
export function daypart(hour) {
  if (hour >= 5 && hour < 11) return 'Morning';
  if (hour >= 11 && hour < 17) return 'Day';
  if (hour >= 17 && hour < 22) return 'Evening';
  return 'Night';
}

/**
 * The pointer's velocity at release in floor px per second, or null when it was too slow, too short, or had stopped.
 * `samples` are `{t, x, y}` (t in ms), oldest first; only those within `windowMs` of the last one count.
 */
export function throwVelocity(samples, now, t) {
  const last = samples[samples.length - 1];
  if (!last || now - last.t > t.staleMs) return null;
  const first = samples.find((s) => last.t - s.t <= t.windowMs);
  const dt = last.t - first.t;
  if (dt <= 0) return null;
  const vx = ((last.x - first.x) / dt) * 1000;
  const vy = ((last.y - first.y) / dt) * 1000;
  const speed = Math.hypot(vx, vy);
  return speed >= t.minSpeedPxS ? { vx, vy, speed } : null;
}

/** The box a thrown character bounces in: the bounds of the walkable cells of the floor's navigation grid, or null when there are none. */
export function openBox(grid) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < grid.open.length; i++) {
    if (!grid.open[i]) continue;
    const c = i % grid.cols;
    const r = Math.floor(i / grid.cols);
    x0 = Math.min(x0, c); x1 = Math.max(x1, c + 1);
    y0 = Math.min(y0, r); y1 = Math.max(y1, r + 1);
  }
  if (x0 === Infinity) return null;
  return { x0: x0 * grid.cellPx, y0: y0 * grid.cellPx, x1: x1 * grid.cellPx, y1: y1 * grid.cellPx };
}

/**
 * The flight of a thrown character, computed once: a polyline from `from` along the velocity that reflects off the walls of
 * `box` (each bounce keeps `bounceKeep` of the rest of the distance, at most `maxBounces`), never leaving the box.
 * Returns the points, each point's share (0..1) of the flight time (by travelled length), the flight's ms and the bounce count.
 */
export function throwPath(from, vel, box, t) {
  const clamp = (v, a, b) => Math.min(Math.max(v, a), b);
  let x = clamp(from[0], box.x0, box.x1);
  let y = clamp(from[1], box.y0, box.y1);
  let dx = vel.vx / vel.speed;
  let dy = vel.vy / vel.speed;
  let left = clamp(vel.speed * t.distPerSpeed, t.minDistPx, t.maxDistPx);
  const pts = [[x, y]];
  let bounces = 0;
  for (;;) {
    const tx = dx > 0 ? (box.x1 - x) / dx : dx < 0 ? (box.x0 - x) / dx : Infinity;
    const ty = dy > 0 ? (box.y1 - y) / dy : dy < 0 ? (box.y0 - y) / dy : Infinity;
    const hit = Math.max(0, Math.min(tx, ty));
    if (hit >= left) {
      x += dx * left;
      y += dy * left;
      pts.push([clamp(x, box.x0, box.x1), clamp(y, box.y0, box.y1)]);
      break;
    }
    x += dx * hit;
    y += dy * hit;
    pts.push([clamp(x, box.x0, box.x1), clamp(y, box.y0, box.y1)]);
    left = (left - hit) * t.bounceKeep;
    if (tx <= ty) dx = -dx;
    if (ty <= tx) dy = -dy;
    if (++bounces >= t.maxBounces) break;
  }
  const lens = pts.slice(1).map((p, i) => Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]));
  const total = lens.reduce((a, b) => a + b, 0);
  let run = 0;
  const offsets = [0, ...lens.map((l) => (total > 0 ? Math.min(1, (run += l) / total) : 1))];
  offsets[offsets.length - 1] = 1;
  return { pts, offsets, ms: Math.max(t.minFlyMs, (total / t.flyPxPerSec) * 1000), bounces };
}

/**
 * Who a drop at `p` lands near. `others` are the characters that can take part: `{id, isLead, x, y}` (feet). The dropped one is
 * `self`. A dropped worker near the boss reports (`radius.report`), else near another worker it high-fives (`radius.highFive`);
 * a dropped boss near a worker gets a boss line (`radius.report`). The nearest candidate of the kind wins.
 * @returns {{kind: 'report'|'highFive'|'bossLine', other: object} | null}
 */
export function playPartner(self, p, others, radius) {
  const nearest = (list, r) => {
    let best = null;
    let bestD = r;
    for (const o of list) {
      const d = Math.hypot(o.x - p[0], o.y - p[1]);
      if (d <= bestD) { best = o; bestD = d; }
    }
    return best;
  };
  const rest = others.filter((o) => o.id !== self.id);
  if (self.isLead) {
    const o = nearest(rest.filter((r) => !r.isLead), radius.report);
    return o ? { kind: 'bossLine', other: o } : null;
  }
  const boss = nearest(rest.filter((r) => r.isLead), radius.report);
  if (boss) return { kind: 'report', other: boss };
  const mate = nearest(rest.filter((r) => !r.isLead), radius.highFive);
  return mate ? { kind: 'highFive', other: mate } : null;
}
