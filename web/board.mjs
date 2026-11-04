// Whiteboard (pure): where the board sits on the wall, how many lines fit, which items of the list show, what the board says.
// What it says comes from the server (floor.todos: {items: [{text, status}], done, total}, or floor.sheet when there is no list; text already clipped).

/**
 * The CSS frame of a board whose writing surface is the quad [top-left, top-right, bottom-right, bottom-left].
 * Left and right edges are vertical, so one shear lays a plain box on the wall: the box is `w` x `h` at (`x`, `y`) and
 * the transform matrix(1, slope, 0, 1, 0, 0) around its top-left corner.
 */
export function boardFrame(quad) {
  const [tl, tr, , bl] = quad;
  const w = tr[0] - tl[0];
  return { x: tl[0], y: tl[1], w, h: bl[1] - tl[1], slope: (tr[1] - tl[1]) / w };
}

/** How many item lines fit under the title in a board `h` px high (at least `min`); `extraPx` is more space the title takes (the progress bar). */
export function boardCapacity(h, linePx, padPx, min, extraPx = 0) {
  return Math.max(min, Math.floor((h - 2 * padPx - extraPx) / linePx) - 1);
}

/** Share of the work done as 0..1 (0 when there is nothing to count; never above 1). */
export const progressFrac = (done, total) => (total > 0 ? Math.min(1, Math.max(0, done / total)) : 0);

/**
 * The lines to draw on a board with room for `cap` lines under the title: {rows, hidden}. `items` is what the server sent
 * and `more` how many it left out. When something is hidden the last line says so, so the rows leave one line free; the
 * in-progress item always stays among the rows, with the items around it (itemWindow). hidden counts every item not drawn.
 */
export function boardRows(items, more, cap) {
  const all = items.length + more;
  if (all <= cap) return { rows: items, hidden: 0 };
  const rows = itemWindow(items, Math.max(1, cap - 1));
  return { rows, hidden: all - rows.length };
}

/** The class of an item row in the progress display: done (struck through), now (in progress, stands out), next (remaining). */
export const rowKind = (status) => (status === 'completed' ? 'done' : status === 'in_progress' ? 'now' : 'next');

/**
 * The run of `cap` items to show: it holds the in-progress item (else the first pending one, else the last item), with
 * one finished item above it for context when there is one.
 */
export function itemWindow(items, cap) {
  if (items.length <= cap) return items;
  let at = items.findIndex((t) => t.status === 'in_progress');
  if (at < 0) at = items.findIndex((t) => t.status === 'pending');
  if (at < 0) at = items.length - 1;
  const start = Math.min(Math.max(0, at - 1), items.length - cap);
  return items.slice(start, start + cap);
}

/** A string that changes exactly when what the board shows changes. */
export const todoKey = (t) => `${t.done}/${t.total}|${t.items.map((i) => `${i.status[0]}${i.text}`).join('\n')}`;

const fill = (template, vars) => template.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''));

/**
 * What the wall board of a floor shows, from its snapshot view: {head, items: [{text, status}], more, progress} or null when there is nothing.
 * `progress` is {done, total, frac} for a to-do list and for the phases of a workflow that lists them (the board draws the count and a bar), else null.
 * `more` counts the items the server left out. The to-do list wins; without one the server sends `sheet`
 * (phases of the running workflow, sub-agents, or the session title) already cleaned and clipped. `labels` is ui.board.
 */
export function boardSheet(fv, labels) {
  const s = fv.sheet;
  if (!s) {
    const t = fv.todos;
    if (!t || t.total === 0) return null;
    return { head: fill(labels.todos, { done: t.done, total: t.total }), items: t.items, more: t.total - t.items.length, progress: progressOf(t.done, t.total) };
  }
  if (s.kind === 'title') return { head: '', items: [{ text: s.text, status: 'plain' }], more: 0, progress: null }; // no list: the title as one wrapped line
  if (s.kind !== 'phases') return { head: fill(labels.agents, s), items: s.items, more: s.more, progress: null };
  const done = Math.min(Math.max(0, s.n - 1), s.total); // the phases before the current one; a script that lists none has no total and no bar
  return { head: fill(s.total > 0 ? labels.phases : labels.phasesOpen, { ...s, done }), items: s.items, more: s.more, progress: s.total > 0 ? progressOf(done, s.total) : null };
}

const progressOf = (done, total) => ({ done, total, frac: progressFrac(done, total) });

/** A string that changes exactly when what the board shows changes ('' for nothing). */
export const sheetKey = (b) => (b ? `${b.head}|${b.more}|${b.items.map((i) => `${i.status[0]}${i.text}`).join('\n')}` : '');

/**
 * Perspective frame for a lobby screen whose top and bottom edges are NOT parallel (the wings of the wall are taller at the outer end):
 * the text box is `w` x `h` at (`x`, `y`) (w = the wider horizontal edge, h = the SHORTER vertical edge, so no character is drawn smaller
 * than its CSS size and the taller end magnifies it) and `matrix3d` is the homography that lays the four corners of the box on the quad
 * [top-left, top-right, bottom-right, bottom-left] (relative to the top-left corner, transform-origin 0 0). A parallelogram or a plain
 * rectangle gives g = h = 0, an affine map (the old shear). Throws on a quad with no area (a point or a line).
 */
export function quadFrame(quad) {
  const [tl, tr, br, bl] = quad;
  const w = Math.max(tr[0] - tl[0], br[0] - bl[0]);
  const h = Math.min(bl[1] - tl[1], br[1] - tr[1]);
  if (!(w > 0 && h > 0)) throw new Error('quadFrame: the quad needs a positive width and height');
  const src = [[0, 0], [w, 0], [w, h], [0, h]];
  const dst = quad.map(([x, y]) => [x - tl[0], y - tl[1]]);
  // the 8 unknowns a..h of x' = (ax+by+c)/(gx+hy+1), y' = (dx+ey+f)/(gx+hy+1), by gaussian elimination with partial pivoting
  const A = [];
  const B = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i];
    const [X, Y] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -x * X, -y * X]);
    B.push(X);
    A.push([0, 0, 0, x, y, 1, -x * Y, -y * Y]);
    B.push(Y);
  }
  for (let c = 0; c < 8; c++) {
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    if (Math.abs(A[p][c]) < 1e-9) throw new Error('quadFrame: the quad is degenerate');
    [A[c], A[p]] = [A[p], A[c]];
    [B[c], B[p]] = [B[p], B[c]];
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const k = A[r][c] / A[c][c];
      for (let j = c; j < 8; j++) A[r][j] -= k * A[c][j];
      B[r] -= k * B[c];
    }
  }
  const [a, b, c, d, e, f, g, hh] = B.map((v, i) => v / A[i][i]);
  const n = (v) => +v.toFixed(9);
  return { x: tl[0], y: tl[1], w, h, matrix3d: `matrix3d(${[a, d, 0, g, b, e, 0, hh, 0, 0, 1, 0, c, f, 0, 1].map(n).join(',')})` };
}
