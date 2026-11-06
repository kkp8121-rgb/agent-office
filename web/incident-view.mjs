// Lunch break (a usage limit) and the faint after a compaction as plain rules, no DOM. web/fx-incidents.mjs draws;
// tests/incident-view.test.mjs checks these. Numbers and words come from config ui.rest, ui.faint and ui.lines.

import { fill } from './call-view.mjs';

/** How long a faint lasts in total: the character lies down for `downMs`, which is this share of the whole fall-lie-rise (the keyframes in incidents.css). */
export const FAINT_LIE_SHARE = 0.7;

/** Opacity of the lunch veil: the night picture is already dark (small), then dark mode, then the plain light room. */
export function restDim(cfg, { dark, night }) {
  if (night) return cfg.dimNight;
  return dark ? cfg.dimDark : cfg.dimLight;
}

const two = (n) => String(n).padStart(2, '0');

/** The text of the lunch sign: the sign word, plus the return time (browser local time) when the server knows when the limit ends. */
export function restSignText(cfg, rest) {
  if (!rest) return '';
  if (!Number.isFinite(rest.until)) return cfg.signText;
  const at = new Date(rest.until);
  return `${cfg.signText} · ${fill(cfg.untilText, { hh: two(at.getHours()), mm: two(at.getMinutes()) })}`;
}

/** What a faint signal does to one character: 'skip' (nothing at all), 'say' (only the line) or 'full' (fall, notepad and line).
 *  A floor on its lunch break and a character that fainted a moment ago stay silent. Without the effects there is the line only. */
export function faintPlan({ fxOn, rest, lastAt, now, cooldownMs }) {
  if (rest) return 'skip';
  if (Number.isFinite(lastAt) && now - lastAt < cooldownMs) return 'skip';
  return fxOn ? 'full' : 'say';
}

export const faintTotalMs = (downMs) => Math.round(downMs / FAINT_LIE_SHARE);
