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

/** How many item lines fit under the title in a board `h` px high (at least `min`). */
export function boardCapacity(h, linePx, padPx, min) {
  return Math.max(min, Math.floor((h - 2 * padPx) / linePx) - 1);
}

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
 * What the wall board of a floor shows, from its snapshot view: {head, items: [{text, status}], more} or null when there is nothing.
 * `more` counts the items the server left out. The to-do list wins; without one the server sends `sheet`
 * (phases of the running workflow, sub-agents, or the session title) already cleaned and clipped. `labels` is ui.board.
 */
export function boardSheet(fv, labels) {
  const s = fv.sheet;
  if (!s) {
    const t = fv.todos;
    if (!t || t.total === 0) return null;
    return { head: fill(labels.todos, { done: t.done, total: t.total }), items: t.items, more: t.total - t.items.length };
  }
  if (s.kind === 'title') return { head: '', items: [{ text: s.text, status: 'plain' }], more: 0 }; // no list: the title as one wrapped line
  const head = s.kind === 'phases' ? fill(s.total > 0 ? labels.phases : labels.phasesOpen, s) : fill(labels.agents, s);
  return { head, items: s.items, more: s.more };
}

/** A string that changes exactly when what the board shows changes ('' for nothing). */
export const sheetKey = (b) => (b ? `${b.head}|${b.more}|${b.items.map((i) => `${i.status[0]}${i.text}`).join('\n')}` : '');
