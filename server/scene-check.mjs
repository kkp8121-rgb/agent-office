// Scene validator, stages 1-10 of the design (§10.1). Used by scripts/check-scenes.mjs and the tests; the server only
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

  // 10. optional anchors for the whiteboard text, the window tint, the workflow meeting and the seasonal decorations
  const [sw, sh] = r.size;
  const inside = (p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite) && p[0] >= 0 && p[0] <= sw && p[1] >= 0 && p[1] <= sh;
  const bad = (what, why) => errors.push(`10단계 장식 앵커: ${what} ${why}`);
  const near = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const gap = nav.arrivalGapPx;
  const boardFace = r.spots.find((sp) => sp.kind === 'whiteboard')?.face; // the way the existing whiteboard spot looks
  if (raw.whiteboard !== undefined) {
    const q = raw.whiteboard?.quad; // top-left, top-right, bottom-right, bottom-left of the writing surface
    if (!Array.isArray(q) || q.length !== 4 || !q.every(inside)) bad('whiteboard.quad', '는 장면 안의 점 4개 [왼위, 오른위, 오른아래, 왼아래] 여야 합니다');
    else {
      const [tl, tr, br, bl] = q;
      const slope = (a, b) => (b[1] - a[1]) / (b[0] - a[0]);
      const top = slope(tl, tr);
      const bottom = slope(bl, br);
      if (!(tr[0] > tl[0] && br[0] > bl[0] && bl[1] > tl[1] && br[1] > tr[1])) bad('whiteboard.quad', '의 점 순서가 왼위, 오른위, 오른아래, 왼아래 가 아닙니다');
      else if (Math.abs(tl[0] - bl[0]) > 3 || Math.abs(tr[0] - br[0]) > 3) bad('whiteboard.quad', '의 좌우 변은 수직이어야 합니다 (벽 기울기는 위아래 변에만 있음)');
      else if (Math.abs(top) < 0.2 || Math.abs(bottom) < 0.2 || Math.sign(top) !== Math.sign(bottom) || Math.abs(top - bottom) > 0.25) bad('whiteboard.quad', `의 위·아래 변이 벽의 기울기를 따르지 않습니다 (기울기 ${top.toFixed(2)} / ${bottom.toFixed(2)})`);
    }
  }
  if (raw.windows !== undefined) {
    if (!Array.isArray(raw.windows) || !raw.windows.length) bad('windows', '는 다각형 목록이어야 합니다');
    else raw.windows.forEach((poly, i) => { if (!Array.isArray(poly) || poly.length < 3 || !poly.every(inside)) bad(`windows[${i}]`, '는 장면 안의 점 3개 이상이어야 합니다'); });
  }
  if (raw.meeting !== undefined) {
    const m = raw.meeting;
    const spots = Array.isArray(m?.spots) ? m.spots : [];
    const all = [['boss', m?.boss], ...spots.map((s, i) => [`spots[${i}]`, s])];
    if (spots.length < 6 || spots.length > 8) bad('meeting.spots', `는 6~8곳이어야 합니다 (지금 ${spots.length})`);
    for (const [label, s] of all) {
      if (!inside(s?.at) || (s.face !== 'left' && s.face !== 'right')) { bad(`meeting.${label}`, '는 {at:[x, y], face:"left"|"right"} 여야 합니다'); continue; }
      if (boardFace && s.face !== boardFace) bad(`meeting.${label}`, `의 face 가 화이트보드 자리의 방향(${boardFace})과 다릅니다`);
      if (isOpen(grid, r.door.at)) reach(`meeting.${label}`, s.at, 10);
    }
    const ok = all.filter(([, s]) => inside(s?.at));
    for (let i = 0; i < ok.length; i++) {
      for (let j = i + 1; j < ok.length; j++) if (near(ok[i][1].at, ok[j][1].at) < gap) bad(`meeting.${ok[i][0]} 와 ${ok[j][0]}`, `가 ${Math.round(near(ok[i][1].at, ok[j][1].at))}px 로 가깝습니다 (${gap}px 이상이어야 함)`);
    }
    // a seat's own points and the door stay a full gap away; idle, tray and spot places only need to be "not on" (half a gap)
    const strict = [['door', r.door.at], ...r.seats.flatMap((s) => [[`seats[${s.i}].at`, s.at], [`seats[${s.i}].sitAt`, s.sitAt], [`seats[${s.i}].approach`, s.approach], ...(s.visit ? [[`seats[${s.i}].visit`, s.visit]] : [])]), ['lead.at', r.lead.at], ['lead.sitAt', r.lead.sitAt], ['lead.approach', r.lead.approach]];
    const loose = [...r.idle.map((s, i) => [`idle[${i}]`, s.at]), ...r.tray.queue.map((p, i) => [`tray.queue[${i}]`, p]), ...r.spots.flatMap((s, i) => [[`spots[${i}]`, s.at], ...(s.pair ? [[`spots[${i}].pair`, s.pair]] : [])])];
    for (const [label, s] of ok) {
      for (const [other, p] of strict) if (near(s.at, p) < gap) bad(`meeting.${label}`, `가 ${other} 와 ${Math.round(near(s.at, p))}px 로 가깝습니다 (${gap}px 이상이어야 함)`);
      for (const [other, p] of loose) if (near(s.at, p) < gap / 2) bad(`meeting.${label}`, `가 ${other} 위에 놓였습니다 (${Math.round(near(s.at, p))}px)`);
    }
  }
  if (raw.seasonal !== undefined) {
    const list = Array.isArray(raw.seasonal) ? raw.seasonal : [];
    const need = { floor: 3, wall: 2, desk: 3 };
    for (const [kind, n] of Object.entries(need)) if (list.filter((a) => a?.kind === kind).length < n) bad('seasonal', `에 ${kind} 앵커가 ${n}개 이상 있어야 합니다`);
    const deskBoxes = r.objects.filter((o) => /desk/.test(o.kind)).map((o) => ({ id: o.id, box: [o.at[0] - o.anchor[0], o.at[1] - o.anchor[1], o.at[0] - o.anchor[0] + o.rect[2], o.at[1] - o.anchor[1] + o.rect[3]] }));
    const ids = new Set();
    list.forEach((a, i) => {
      const label = `seasonal[${i}]${a?.id ? `(${a.id})` : ''}`;
      if (typeof a?.id !== 'string' || !a.id || ids.has(a.id)) bad(label, 'id 가 없거나 겹칩니다');
      ids.add(a?.id);
      if (!['floor', 'wall', 'desk'].includes(a?.kind) || !inside(a?.at) || !Array.isArray(a.max) || a.max.length !== 2 || !a.max.every((v) => Number.isFinite(v) && v > 0 && v <= 80)) return bad(label, '는 {id, kind:"floor"|"wall"|"desk", at:[x, y], max:[w, h]} 여야 합니다');
      if (a.kind === 'floor' && isOpen(grid, a.at)) bad(label, `${fmt(a.at)} 가 걸을 수 있는 칸입니다 (바닥 장식이 길을 막으면 안 됩니다)`);
      if (a.kind === 'desk' && !deskBoxes.some((d) => a.at[0] >= d.box[0] && a.at[0] <= d.box[2] && a.at[1] >= d.box[1] && a.at[1] <= d.box[3])) bad(label, `${fmt(a.at)} 가 어느 책상 그림 안에도 없습니다`);
      for (let j = 0; j < i; j++) if (inside(list[j]?.at) && near(a.at, list[j].at) < 20) bad(label, `와 seasonal[${j}] 가 ${Math.round(near(a.at, list[j].at))}px 로 가깝습니다 (20px 이상이어야 함)`);
    });
  }

  return { errors, warnings, grid, resolved: r, nodes };
}
