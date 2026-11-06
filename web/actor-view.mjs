// The rules of the "actor" marks (pure: no DOM, no clock of its own, so the browser and the tests run the same code):
//   the model band under a name tag (feature 17), the paper pile on a desk (feature 18) and the hourglass over a slow command (feature 19).
// Every number and word comes from ui.badge, ui.pile and ui.hourglass of config.json; the DOM part is web/fx-actor.mjs.
//
// What shows (design sections 3.3, 4.3 and 5.3):
//   band       an information mark: always, whatever the effects switch says. No model (null) = no band.
//   pile       a decoration: only while the effects are on. With them off only the last stage speaks, in the name tag's title.
//   hourglass  an information mark: always (a still picture, the time text stays). It only spins while the effects are on.
//              A floor on its lunch break (rest) hides it. The hourglass is not drawn in the lobby.

/** Where a pile picture lives (assets/props/README.md). */
export const pileSrc = (level) => `/assets/props/pile-${level}.png`;
/** The hourglass picture (16x16). */
export const GLASS_SRC = '/assets/props/hourglass.png';

// ---------- model band ----------

const channel = (v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);

/** Relative luminance of '#rrggbb' times 255 (the scale of ui.badge.minLumaGap). */
export function lumaOf(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => channel(parseInt(hex.slice(i, i + 2), 16) / 255));
  return 255 * (0.2126 * r + 0.7152 * g + 0.0722 * b);
}

/** The brightness difference of two '#rrggbb' colours on that scale. */
export const lumaGap = (a, b) => Math.abs(lumaOf(a) - lumaOf(b));

/** @returns {{color: string, label: string}|null} the band of a model (the colour of the theme), null for no model or an unknown one */
export function bandOf(badge, model, dark) {
  const c = model ? badge.colors[model] : null;
  if (!c) return null;
  return { color: dark ? c.dark : c.light, label: badge.labels[model] };
}

// ---------- paper pile ----------

/** The pile's offset [dx, dy] from its desk for a room design, or null (that design draws no pile). */
export const pileOffset = (cfg, design) => cfg.offset[design] ?? null;

/**
 * What one person's pile shows. `pile` = 0..top (the view's stage). `meeting`: the person is away from the desk at a meeting (the desk is empty, so no pile).
 * @returns {{draw: {level: number, offset: number[], wobble: boolean}|null, title: string}}
 *   draw: the picture, only while the effects are on, a stage above 0 and the design has an offset.
 *   title: the last stage's words for the name tag when no picture shows it (effects off).
 */
export function pilePlan({ pile, design, fxOn, meeting = false }, cfg) {
  const top = cfg.titles.length - 1;
  const level = Math.min(Math.max(Math.trunc(pile) || 0, 0), top);
  const offset = pileOffset(cfg, design);
  if (fxOn && level > 0 && offset && !meeting) return { draw: { level, offset, wobble: level === top }, title: '' };
  return { draw: null, title: level === top ? cfg.titles[top] : '' };
}

/** Where a pile stands in floor px: its bottom centre is the desk's `at` plus the offset (dx mirrors with a flipped desk). */
export function pileAnchor(desk, offset) {
  return [desk.at[0] + (desk.flipX ? -offset[0] : offset[0]), desk.at[1] + offset[1]];
}

/** The desk object (of the resolved scene) a person sits at: the lead's desk, or the desk of a seat slot; null when the person has no desk. */
export function deskOf(scene, key, slot) {
  const id = key === 'lead' ? scene.lead.deskId : slot?.kind === 'seat' ? scene.seats[slot.i]?.deskId : null;
  return id ? scene.objects.find((o) => o.id === id) ?? null : null;
}

// ---------- hourglass ----------

/** 「{m}분 {s}초」, or 「{h}시간 {m}분」 from the hour on (cfg = ui.hourglass). */
export function hourglassText(cfg, seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const template = h > 0 ? cfg.textHour : cfg.text;
  return template.replace('{h}', String(h)).replace('{m}', String(m)).replace('{s}', String(s % 60));
}

/**
 * The hourglass of one person: `slowSince` (ms, from the view), `nowMs` (the server's clock), `rest` (the floor's view).
 * @returns {{text: string, spin: boolean}|null} null = none (no slow command, or the floor's bell / lunch comes first)
 */
export function glassPlan({ slowSince, nowMs, rest, fxOn }, cfg) {
  if (slowSince == null || rest) return null;
  return { text: hourglassText(cfg, (nowMs - slowSince) / 1000), spin: !!fxOn };
}

/**
 * One timer per floor that needs its hourglass text refreshed (cfg tickMs), made through the office's timers with the floor's mark.
 * `ids()` = the floors that need one now (shown, with an hourglass); `run(id)` refreshes that floor. sync() adds the missing timers and
 * drops the ones no longer wanted; a timer that fires runs its floor, then sync() chains the next one.
 */
export function createTicker({ timers, tickMs, ids, run }) {
  const live = new Map(); // floor id -> timer
  const sync = () => {
    const want = new Set(ids());
    for (const [id, t] of live) {
      if (want.has(id)) continue;
      timers.clearTimeout(t);
      live.delete(id);
    }
    for (const id of want) {
      if (live.has(id)) continue;
      live.set(id, timers.setTimeout(() => {
        live.delete(id);
        run(id);
        sync();
      }, tickMs, id));
    }
  };
  return { sync, count: () => live.size };
}
