// The empty-office screen (no session floors), the screen rules. Pure functions only: no DOM, no timers (the glue is web/fx-empty.mjs).
// Three designs, one text: a = the dark lobby with the sleeping cat and a standing sign, b = the building seen from outside with only the lobby lit,
// c = a ready empty office with a card. All words and the default design are in config.json ui.empty.

export const VARIANTS = Object.freeze(['a', 'b', 'c']);
const DEBUG_EMPTY = 'empty';

/** The two query values this screen reads: `?debug=empty&empty=a|b|c`. */
export function queryOf(search) {
  const q = new URLSearchParams(search);
  return { debug: q.get('debug'), empty: q.get('empty') };
}

/** The design to draw: the query's (only under ?debug=empty and only a known one), else the configured one, else the first. */
export function pickVariant(query, cfg) {
  if (query?.debug === DEBUG_EMPTY && VARIANTS.includes(query.empty)) return query.empty;
  return VARIANTS.includes(cfg.variant) ? cfg.variant : VARIANTS[0];
}

/** The words a design shows, top to bottom; every design carries the one fixed text. */
export function linesOf(variant, cfg) {
  if (variant === 'a') return [cfg.signA, cfg.text];
  if (variant === 'c') return [cfg.cardTitle, cfg.text, ...cfg.cardSteps];
  return [cfg.text];
}

/**
 * What the screen shows now. `floorCount` and `view` are what the building view reports ('building' or a view id: 'lobby', 'ceo', a session id).
 * Only the whole-building view gets a design, and only with no floor; ?debug=empty draws it over the floors too (the server state is untouched).
 * @returns {{show: boolean, variant: 'a'|'b'|'c', lines: string[]}}
 */
export function resolveEmpty({ floorCount, view, query, cfg }) {
  const forced = query?.debug === DEBUG_EMPTY;
  const show = view === 'building' && (floorCount === 0 || forced);
  const variant = pickVariant(query, cfg);
  return { show, variant, lines: linesOf(variant, cfg) };
}

/** Where the sleeping cat lies, in lobby scene points: the configured place, else the scene's own lounge spot; null when neither is a point. */
export function catPoint(catAt, spots) {
  const ok = (p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite);
  if (ok(catAt)) return catAt;
  const lounge = (spots ?? []).find((s) => s.id === 'lounge');
  return ok(lounge?.at) ? lounge.at : null;
}

/**
 * Places rooms one under the other at one common width `W` that fits the box: each room of scene size [w, h] is drawn at scale W / w.
 * @returns {{W: number, rooms: {k: number, w: number, h: number, top: number}[], height: number}}
 */
export function stackRooms(boxW, boxH, sizes, extraH = 0) {
  const ratio = sizes.reduce((sum, [w, h]) => sum + h / w, 0);
  const W = Math.min(boxW, (boxH - extraH) / ratio);
  let top = 0;
  const rooms = sizes.map(([w, h]) => {
    const k = W / w;
    const room = { k, w: W, h: h * k, top };
    top += room.h;
    return room;
  });
  return { W, rooms, height: top };
}
