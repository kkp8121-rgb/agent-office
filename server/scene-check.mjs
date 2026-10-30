// Scene validator, stages 1-9 of the design (§10.1). Used by scripts/check-scenes.mjs and the tests; the server only
// runs stage 1 at start-up. Stage 6 only warns. It never decodes a picture: every check works on polygons and rects.
import { checkSceneFormat, polyMaxY, polyMinY, polysOverlap, pointInPolys, resolveScene, segHitsPoly } from '../web/scene.mjs';
import { bakeGrid, findPath, isOpen } from '../web/nav.mjs';
import { charZ, objectNodes } from '../web/depth.mjs';

const CHAIR = /chair/i;
const CHAIR_NEAR_PX = 70;

/** How far an object's picture top lies below its highest point at screen x: it follows the back line of a slanted footprint (0 for a straight one). */
const topDrop = (o, x) => (o?.footprint.length >= 3 ? backAt(o.footprint, x) - polyMinY(o.footprint) : 0);

/** Smallest y of the polygon at screen x (x clamped into the polygon's x range): the desk's back line where a seat sits. A slanted desk has no single back line. */
function backAt(poly, x) {
  const xs = poly.map((p) => p[0]);
  const cx = Math.min(Math.max(x, Math.min(...xs)), Math.max(...xs));
  let best = Infinity;
  for (let k = 0; k < poly.length; k++) {
    const [ax, ay] = poly[k];
    const [bx, by] = poly[(k + 1) % poly.length];
    if (ax === bx) {
      if (ax === cx) best = Math.min(best, ay, by);
    } else if (cx >= Math.min(ax, bx) && cx <= Math.max(ax, bx)) {
      best = Math.min(best, ay + ((by - ay) * (cx - ax)) / (bx - ax));
    }
  }
  return best;
}

/**
 * @param {object} raw scene.json content
 * @param {{atlasSize: [number, number]|null, cfg: object, minSeats?: number}} opts
 * @returns {{errors: string[], warnings: string[], grid: object|null, resolved: object|null, nodes: object[]}}
 */
export function checkScene(raw, { atlasSize, cfg, minSeats }) {
  const errors = [];
  const warnings = [];
  const format = checkSceneFormat(raw, { atlasSize, inflatePx: cfg.nav.inflatePx, ...(minSeats ? { minSeats } : {}) });
  if (format.length) return { errors: format.map((e) => `1단계 형식: ${e}`), warnings, grid: null, resolved: null, nodes: [] };

  const r = resolveScene(raw);
  const grid = bakeGrid(r, cfg.nav);
  const nodes = objectNodes(r, cfg.depth);
  const { depth, nav } = cfg;
  const byId = new Map(r.objects.map((o) => [o.id, o]));
  const fmt = (p) => `[${Math.round(p[0])}, ${Math.round(p[1])}]`;

  // everyone who sits at a desk: the seats and the lead
  const sitters = [
    ...r.seats.map((s) => ({ label: `seats[${s.i}](${s.deskId})`, desk: byId.get(s.deskId), at: s.at, sitAt: s.sitAt, approach: s.approach })),
    { label: `lead(${r.lead.deskId})`, desk: byId.get(r.lead.deskId), at: r.lead.at, sitAt: r.lead.sitAt, approach: r.lead.approach },
  ];
  const chairOf = (p) => {
    let best = null;
    let bestD = CHAIR_NEAR_PX;
    for (const o of r.objects) {
      if (!CHAIR.test(o.kind) || o.footprint.length < 3) continue;
      const d = Math.hypot(o.at[0] - p[0], o.at[1] - p[1]);
      if (d < bestD) {
        bestD = d;
        best = o;
      }
    }
    return best;
  };
  for (const s of sitters) s.chair = chairOf(s.sitAt);

  // 2. reach: a route from the door to every place a character ends up
  const targets = [
    ...sitters.map((s) => [`${s.label}.approach`, s.approach]),
    ...r.tray.queue.map((p, i) => [`tray.queue[${i}]`, p]),
    ...r.idle.map((s, i) => [`idle[${i}].at`, s.at]),
    ...r.overflow.map((s, i) => [`overflow[${i}].at`, s.at]),
  ];
  const reach = (label, p, stage) => {
    if (!isOpen(grid, p)) return errors.push(`${stage}단계 도달: ${label} ${fmt(p)} 가 막힌 칸입니다 (걸을 수 없음, reach)`);
    if (!findPath(grid, r.door.at, p, { snapRadiusCells: nav.snapRadiusCells })) errors.push(`${stage}단계 도달: ${label} ${fmt(p)} 에 문에서 도달할 수 없습니다 (reach)`);
  };
  if (!isOpen(grid, r.door.at)) errors.push(`2단계 도달: door.at ${fmt(r.door.at)} 가 막힌 칸입니다 (reach)`);
  else for (const [label, p] of targets) reach(label, p, 2);

  // 3. last step: approach -> at -> sitAt crosses no blocking footprint except the seat's own desk and chair
  const blockers = r.objects.filter((o) => o.blocks && o.footprint.length >= 3);
  for (const s of sitters) {
    const legs = [[s.approach, s.at]];
    if (s.sitAt !== s.at) legs.push([s.at, s.sitAt]);
    for (const o of blockers) {
      if (o === s.desk || o === s.chair) continue;
      if (legs.some(([a, b]) => segHitsPoly(a, b, o.footprint))) errors.push(`3단계 마지막 걸음: ${s.label} 의 approach→at 걸음이 ${o.id} 를 지납니다`);
    }
  }

  // 4. spacing between arrival points (8 when a spot or visit point is involved)
  const pts = [
    ...r.seats.flatMap((s) => [[`seats[${s.i}].at`, s.at], ...(s.sitAt !== s.at ? [[`seats[${s.i}].sitAt`, s.sitAt]] : []), ...(s.visit ? [[`seats[${s.i}].visit`, s.visit]] : [])]),
    ['lead.at', r.lead.at],
    ...(r.lead.sitAt !== r.lead.at ? [['lead.sitAt', r.lead.sitAt]] : []),
    ...r.tray.queue.map((p, i) => [`tray.queue[${i}]`, p]),
    ...r.idle.map((s, i) => [`idle[${i}].at`, s.at]),
    ...r.overflow.map((s, i) => [`overflow[${i}].at`, s.at]),
    ...r.spots.flatMap((s, i) => [[`spots[${i}].at`, s.at], ...(s.pair ? [[`spots[${i}].pair`, s.pair]] : [])]),
  ];
  const ownerOf = (label) => label.replace(/\.(at|sitAt|visit|pair)$/, '');
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const [la, a] = pts[i];
      const [lb, b] = pts[j];
      if (ownerOf(la) === ownerOf(lb) && (la.endsWith('sitAt') || lb.endsWith('sitAt'))) continue; // one seat's two poses are never occupied together
      const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      if (d < nav.arrivalGapPx) {
        const stage = /spots|visit/.test(la + lb) ? 8 : 4;
        errors.push(`${stage}단계 간격: ${la} 와 ${lb} 가 ${Math.round(d)}px 로 가깝습니다 (${nav.arrivalGapPx}px 이상이어야 함)`);
      }
    }
  }

  // 5. depth: stand behind the desk's back line, chair behind the character, no overlapping blockers
  for (const s of sitters) {
    const back = backAt(s.desk.footprint, s.at[0]);
    if (!(s.at[1] < back)) errors.push(`5단계 깊이: ${s.label} at.y(${Math.round(s.at[1])}) 가 책상 뒤쪽 선(${Math.round(back)})보다 작아야 합니다`);
    if (!s.chair) warnings.push(`5단계 깊이: ${s.label} 근처에서 의자(종류 이름에 chair 포함)를 찾지 못했습니다`);
    else if (polyMaxY(s.chair.footprint) > s.at[1] - 2) errors.push(`5단계 깊이: ${s.label} 의자 ${s.chair.id} 앞쪽(${Math.round(polyMaxY(s.chair.footprint))})이 at.y−2(${Math.round(s.at[1] - 2)}) 이하여야 합니다`);
  }
  for (let i = 0; i < blockers.length; i++) {
    for (let j = i + 1; j < blockers.length; j++) {
      if (polysOverlap(blockers[i].footprint, blockers[j].footprint)) errors.push(`5단계 깊이: ${blockers[i].id} 와 ${blockers[j].id} 의 footprint 가 겹칩니다`);
    }
  }

  // 6. face covered (warning): a deeper object's picture box over the top of a character's head
  const standH = cfg.spriteHeight;
  const faces = [
    ...sitters.map((s) => ({ label: s.label, p: s.sitAt, h: cfg.sitHeight })),
    ...r.tray.queue.map((p, i) => ({ label: `tray.queue[${i}]`, p, h: standH })),
  ];
  for (const f of faces) {
    const [x0, x1, y0, y1] = [f.p[0] - depth.pickMarginPx, f.p[0] + depth.pickMarginPx, f.p[1] - f.h, f.p[1] - f.h + depth.faceTopPx];
    const cover = nodes.filter((n) => n.z > charZ(f.p[1], depth) && n.z < depth.frontZ - 1 && n.x < x1 && n.x + n.w > x0 && n.y + topDrop(byId.get(n.objId), f.p[0]) < y1 && n.y + n.h > y0);
    const ids = [...new Set(cover.map((n) => n.objId))];
    if (ids.length) warnings.push(`6단계 가림: ${f.label} 의 얼굴을 ${ids.join(', ')} 이(가) 가릴 수 있습니다`);
  }

  // 7. the front overlay must not cover where characters enter, stop or queue
  if (r.frontMask.length) {
    const open = [['door.at', r.door.at], ...sitters.map((s) => [`${s.label}.approach`, s.approach]), ...r.tray.queue.map((p, i) => [`tray.queue[${i}]`, p])];
    for (const [label, p] of open) if (pointInPolys(p, r.frontMask)) errors.push(`7단계 앞 덮개: ${label} ${fmt(p)} 가 frontMask 안입니다`);
  }

  // 8. spots and visit points: open and reachable (a route from the door reaches every approach too)
  if (isOpen(grid, r.door.at)) {
    r.spots.forEach((s, i) => {
      reach(`spots[${i}].at`, s.at, 8);
      if (s.pair) reach(`spots[${i}].pair`, s.pair, 8);
    });
    for (const s of r.seats) if (s.visit) reach(`seats[${s.i}].visit`, s.visit, 8);
  }

  // 9. seated pose shows: head and shoulders above the desk picture, behind the desk, in front of the chair
  for (const s of sitters) {
    const deskTop = s.desk.at[1] - s.desk.anchor[1] + topDrop(s.desk, s.sitAt[0]);
    const sitTop = s.sitAt[1] - cfg.sitHeight;
    if (sitTop > deskTop - depth.seatShowPx) {
      errors.push(`9단계 앉은 자세: ${s.label} 앉은 그림 윗변(${Math.round(sitTop)})이 책상 윗변(${Math.round(deskTop)})보다 ${depth.seatShowPx}px 이상 위여야 합니다`);
    }
    const back = backAt(s.desk.footprint, s.sitAt[0]);
    if (!(s.sitAt[1] < back)) errors.push(`9단계 앉은 자세: ${s.label} sitAt.y(${Math.round(s.sitAt[1])}) 가 책상 뒤쪽 선(${Math.round(back)})보다 작아야 합니다`);
    if (s.chair && polyMaxY(s.chair.footprint) > s.sitAt[1] - 2) errors.push(`9단계 앉은 자세: ${s.label} 의자 ${s.chair.id} 앞쪽이 sitAt.y−2 이하여야 합니다`);
  }

  return { errors, warnings, grid, resolved: r, nodes };
}
