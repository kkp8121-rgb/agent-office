// Seasonal decorations and the light outside the windows (pure): which season a date is in, how bright it is outside, when that
// changes next, and which decoration goes on which anchor. Dates and hours come from `ui.season` and `ui.daylight`; DOM lives in app.js.

/** Month and day (1-based) of the Korean lunar new year in `year`: the first day of lunar month 1 (Intl "dangi" calendar). */
export function lunarNewYear(year) {
  const fmt = new Intl.DateTimeFormat('en-u-ca-dangi', { month: 'numeric', day: 'numeric' });
  for (let d = 0; d < 60; d++) {
    const day = new Date(year, 0, 17 + d, 12); // local noon, so the date never slips with the time zone
    const parts = Object.fromEntries(fmt.formatToParts(day).map((p) => [p.type, p.value]));
    if (parts.day === '1' && parts.month === '1') return [day.getMonth() + 1, day.getDate()];
  }
  return null;
}

const dayNo = (y, m, d) => Math.round(Date.UTC(y, m - 1, d) / 86400000);

/** The season of `date` (local time): 'halloween', 'christmas', 'lunar' or 'none'. `cfg` is `ui.season`. */
export function seasonOn(date, cfg) {
  const y = date.getFullYear();
  const key = (m, d) => m * 100 + d;
  const today = key(date.getMonth() + 1, date.getDate());
  for (const name of ['halloween', 'christmas']) {
    const w = cfg[name];
    if (w && today >= key(...w.from) && today <= key(...w.to)) return name;
  }
  const lny = cfg.lunar && lunarNewYear(y);
  if (lny) {
    const off = dayNo(y, date.getMonth() + 1, date.getDate()) - dayNo(y, lny[0], lny[1]);
    if (off >= -cfg.lunar.daysBefore && off <= cfg.lunar.daysAfter) return 'lunar';
  }
  return 'none';
}

/** 'day', 'sunset' or 'night' for a clock hour. `cfg` is `ui.daylight`: `{sunset: [from, to], night: [from, to]}`, a range may wrap midnight. */
export function lightAt(hour, cfg) {
  const within = ([from, to]) => (from <= to ? hour >= from && hour < to : hour >= from || hour < to);
  return within(cfg.night) ? 'night' : within(cfg.sunset) ? 'sunset' : 'day';
}

/** Milliseconds from `now` to the next moment the light or the date can change: a boundary hour of `cfg` or midnight (at least 1 s). */
export function msToNextChange(now, cfg) {
  const hours = [0, ...cfg.sunset, ...cfg.night];
  let best = Infinity;
  for (const h of hours) {
    const t = new Date(now);
    t.setHours(h % 24, 0, 0, 0);
    if (t <= now) t.setDate(t.getDate() + 1);
    best = Math.min(best, t - now);
  }
  return Math.max(1000, best);
}

function hash(text) {
  let h = 2166136261;
  for (const ch of text) h = Math.imul(h ^ ch.codePointAt(0), 16777619);
  return h >>> 0;
}

/**
 * Which decoration of `season` goes on which anchor. `items` is assets/seasonal/items.json, `anchors` the scene's `seasonal` list.
 * An item must fit the anchor's `max`; among those that fit the choice is fixed by the design and the anchor's place in its kind,
 * so a room always looks the same and neighbours differ (a picture is used again only when all that fit are in use). Anchors nothing fits are left empty.
 * @returns {{anchor: object, item: object}[]}
 */
export function placeSeason(items, anchors, season, design) {
  const out = [];
  const rank = new Map();
  const used = new Map();
  const shift = hash(`${design}:${season}`);
  for (const anchor of anchors) {
    const n = rank.get(anchor.kind) ?? 0;
    rank.set(anchor.kind, n + 1);
    const fits = items.filter((it) => it.season === season && it.kind === anchor.kind && it.size[0] <= anchor.max[0] && it.size[1] <= anchor.max[1]);
    if (!fits.length) continue;
    const least = Math.min(...fits.map((it) => used.get(it) ?? 0)); // a room shows each picture before it repeats one
    const pool = fits.filter((it) => (used.get(it) ?? 0) === least);
    const item = pool[(n + shift) % pool.length];
    used.set(item, least + 1);
    out.push({ anchor, item });
  }
  return out;
}
