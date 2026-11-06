// Labour cost view (pure: no DOM, no clock, no I/O): the numbers of the `cost` frame turned into what the screens write.
// Used by the lobby wall, the floor detail window and the character card.
//
// Totals are NEW tokens only (input + cache writes + output). Cache reads come as `cacheRead` (the office's, and one per floor in `floors`), a separate figure that only the detail window shows (owner decision D4).
// The frame can say the figures are not final: `scanning` (the first read of the old logs is still running) and `partial` (the read stopped at its size limit).
// A figure is never a wrong number: no frame yet -> ui.cost.empty, scanning -> ui.cost.scanning, partial -> the number with ui.cost.partial next to it.
// `cfg` = ui.cost everywhere below. The frame is {day, tokens, cacheRead, lastWeek: {day, tokensSameHour, partial}|null, floors: [{sessionId, tokens, cacheRead}],
// top: [{sessionId, agentKey, name, floorName, tokens}], scanning, partial}.

const fill = (template, vars) => template.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''));

/**
 * A token count in words: 「12.3M」. `units` = ui.cost.units (largest first), `decimals` = ui.cost.decimals. Under the smallest unit the plain integer.
 * A value that rounds up to the next unit (999,960 -> 「1.0M」, not 「1000.0k」) moves to that unit.
 */
export function fmtTokens(n, units, decimals) {
  const v = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  const i = units.findIndex(([size]) => v >= size);
  if (i < 0) return String(v);
  let [size, mark] = units[i];
  if (i > 0 && Number((v / size).toFixed(decimals)) >= units[i - 1][0] / size) [size, mark] = units[i - 1];
  return `${(v / size).toFixed(decimals)}${mark}`;
}

/** Change of `today` against `lastWeek` in whole percent (rounded, sign kept), or null when last week is not a positive number (nothing to divide by). */
export function diffPercent(today, lastWeek) {
  if (!Number.isFinite(today) || !Number.isFinite(lastWeek) || lastWeek <= 0) return null;
  return Math.round(((today - lastWeek) / lastWeek) * 100);
}

/** 「+12%」 / 「-5%」 / 「0%」. */
export const diffText = (pct) => `${pct > 0 ? '+' : ''}${pct}%`;

/**
 * Everything a screen needs from one frame (null before the first frame).
 * state: 'none' (no frame) | 'scanning' | 'ready'. partial: the day's figures cover only part of the logs.
 * text(n): a figure for a row (the plain number; the scanning / empty word instead while that is what is true); tagged(n): the same with the partial word when the day is partial.
 * Returns {state, partial, text, tagged, total, cacheRead, lastWeek, diff, news, top}:
 *   total / cacheRead: the figure texts (total carries the partial word); lastWeek: null or {text, partial}; diff: null or 「+12%」 (not shown when either side is partial);
 *   news: the one-line sentence of the lobby ticker; top: up to `cfg.topCount` people {sessionId, agentKey, name, floorName, tokens, text}.
 */
export function costView(frame, cfg) {
  const state = !frame ? 'none' : frame.scanning ? 'scanning' : 'ready';
  const partial = state === 'ready' && frame.partial === true;
  const word = state === 'none' ? cfg.empty : cfg.scanning;
  const text = (n) => (state === 'ready' ? fmtTokens(n, cfg.units, cfg.decimals) : word);
  const tagged = (n) => (partial ? `${text(n)} (${cfg.partial})` : text(n));
  const lw = state === 'ready' && frame.lastWeek ? frame.lastWeek : null;
  const lastWeek = lw ? { text: lw.partial ? `${text(lw.tokensSameHour)} (${cfg.partial})` : text(lw.tokensSameHour), partial: lw.partial === true } : null;
  const pct = state === 'ready' && lw && !partial && !lw.partial ? diffPercent(frame.tokens, lw.tokensSameHour) : null;
  const diff = pct === null ? null : diffText(pct);
  return {
    state,
    partial,
    text,
    tagged,
    total: tagged(frame?.tokens ?? 0),
    cacheRead: tagged(frame?.cacheRead ?? 0),
    lastWeek,
    diff,
    news: state === 'ready' ? newsLine(cfg, tagged(frame.tokens), lastWeek, diff) : `${cfg.title} ${word}`,
    top: state === 'none' ? [] : frame.top.slice(0, cfg.topCount).map((p) => ({ ...p, name: p.name || cfg.goneName, text: text(p.tokens) })),
  };
}

/** 「오늘 합계 12.3M · 지난주 같은 시각 10.0M (+23%)」: ui.cost.news, whose two halves meet at 「 · 」. No last week -> its half is the 「기록 없음」 word; no diff -> no brackets. */
function newsLine(cfg, total, lastWeek, diff) {
  const [head, ...rest] = cfg.news.split(' · ');
  if (!lastWeek) return rest.length ? `${fill(head, { total })} · ${cfg.noLastWeek}` : fill(cfg.news, { total, lastWeek: cfg.noLastWeek, diff: '' });
  return fill(cfg.news, { total, lastWeek: lastWeek.text, diff: diff ?? '' }).replace(/\s*\(\)/, '');
}

/** Today's new tokens of one floor: a number, or null when the frame has no entry for it (the figure then reads 「—」, see costView().text). */
export function floorTokens(frame, sessionId) {
  return frame?.floors.find((f) => f.sessionId === sessionId)?.tokens ?? null;
}

/** Today's cache reads of one floor: a number, or null when the frame has no entry for it. Never part of a total (D4). */
export function floorCacheRead(frame, sessionId) {
  return frame?.floors.find((f) => f.sessionId === sessionId)?.cacheRead ?? null;
}

/** Today's tokens of one person (`agentKey` null = the 팀장) when the frame's top list names them, else null. The frame lists only the office's top people. */
export function personTokens(frame, sessionId, agentKey) {
  return frame?.top.find((p) => p.sessionId === sessionId && p.agentKey === agentKey)?.tokens ?? null;
}

/** The people of one floor that the frame's top list names, in its order, at most `max`. */
export function floorTop(frame, sessionId, max) {
  return (frame?.top ?? []).filter((p) => p.sessionId === sessionId).slice(0, max);
}

/**
 * The floor and person view of a card's character: the card only knows what the office draws (`who`: floorNo, rank, sprite, name), so it is matched in the
 * latest floor views. Returns {sessionId, agentKey, view} (view = the person's lead / agent view, with model and pile) or null.
 */
export function personOf(floors, who) {
  const fv = floors.find((f) => f.floorNo === who.floorNo);
  if (!fv) return null;
  if (who.rank === 'lead') return { sessionId: fv.sessionId, agentKey: null, view: fv.lead };
  const a = fv.agents.find((x) => x.sprite === who.sprite && x.name === who.name);
  return a ? { sessionId: fv.sessionId, agentKey: a.agentId ?? null, view: a } : null;
}

/**
 * The 「오늘 인건비」 block of a floor's detail window: {title, total, people, cache}, each a {label, text}.
 * `labels` = {floor, cacheRead}: the words of the first and last row (the caller owns the wording). `max` people of that floor, taken from the frame's top list.
 * `cache` is that floor's own cache reads (D4: never added to a total); the office-wide figure is not shown here.
 */
export function floorCost(frame, cfg, sessionId, labels, max) {
  const v = costView(frame, cfg);
  const n = floorTokens(frame, sessionId);
  const c = floorCacheRead(frame, sessionId);
  return {
    title: cfg.title,
    total: { label: labels.floor, text: v.state === 'ready' && n === null ? cfg.empty : v.tagged(n ?? 0) },
    people: floorTop(frame, sessionId, max).map((p) => ({ label: p.name || cfg.goneName, text: v.text(p.tokens) })),
    cache: { label: labels.cacheRead, text: v.state === 'ready' && c === null ? cfg.empty : v.tagged(c ?? 0) },
  };
}

/** One line for a character card: 「오늘 인건비 12.3M」. A person the frame's top list does not name has no figure (「—」). */
export function personCostLine(frame, cfg, sessionId, agentKey) {
  const v = costView(frame, cfg);
  const n = personTokens(frame, sessionId, agentKey);
  return `${cfg.title} ${v.state === 'ready' && n === null ? cfg.empty : v.text(n ?? 0)}`;
}
