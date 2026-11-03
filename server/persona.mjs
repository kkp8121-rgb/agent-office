// Character personas (persona.json at the repo root, written by the lines work, only ever READ here): a type (one of ten motion sets), a voice
// (pitch of the hit sounds), impact words, snack taste and canned lines per sprite key. The page gets the validated result as `personas` in /api/ui.
// loadPersonas never creates or writes the file; a missing or broken file gives {} (one warning) and the office runs on its generic lines.
import fs from 'node:fs';
import { TYPES, hashType } from '../web/fx-hit-rules.mjs';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const len = (s) => Array.from(s).length;
const text = (v, max) => typeof v === 'string' && v.trim() !== '' && len(v) <= max;

/**
 * Validates one persona of sprite key `key`; returns the cleaned persona. Lenient: a bad part is dropped (and the rest kept), never the whole file.
 * limits = {aboutMax, hitWordMax, hitWordsMax, voice: [min, max], lineMax, kinds}; people never eat fish, only the cat does.
 */
export function cleanPersona(key, raw, limits) {
  const p = isObj(raw) ? raw : {};
  const isCat = key === 'cat';
  const eats = new Set(limits.kinds.filter((k) => (k === 'fish') === isCat));
  const taste = (list) => (Array.isArray(list) ? list.filter((k) => eats.has(k)).slice(0, 1) : []);
  const lines = {};
  if (isObj(p.lines)) {
    for (const [k, pool] of Object.entries(p.lines)) {
      const ok = Array.isArray(pool) ? pool.filter((l) => text(l, limits.lineMax)) : [];
      if (ok.length > 0) lines[k] = ok;
    }
  }
  const [lo, hi] = limits.voice;
  return {
    about: text(p.about, limits.aboutMax) ? p.about : '',
    type: TYPES.includes(p.type) ? p.type : hashType(key),
    voice: typeof p.voice === 'number' && Number.isFinite(p.voice) ? Math.min(Math.max(p.voice, lo), hi) : 1,
    hitWords: Array.isArray(p.hitWords) ? p.hitWords.filter((w) => text(w, limits.hitWordMax)).slice(0, limits.hitWordsMax) : [],
    snack: { love: taste(p.snack?.love), dislike: taste(p.snack?.dislike) },
    lines,
  };
}

/**
 * Reads and validates `file`. Returns {} when it is missing, unreadable, not JSON or has no personas object (one warning through `warn`).
 * @param {string} file
 * @param {object} limits see cleanPersona
 * @param {(msg: string) => void} [warn]
 * @returns {Record<string, object>} persona by sprite key
 */
export function loadPersonas(file, limits, warn = (m) => console.warn(m)) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    warn(`persona 파일을 읽지 못했습니다 (${err.code ?? err.name}): 기본 대사로 갑니다`);
    return {};
  }
  if (!isObj(raw) || !isObj(raw.personas)) {
    warn('persona 파일에 personas 항목이 없습니다: 기본 대사로 갑니다');
    return {};
  }
  const out = {};
  for (const [key, p] of Object.entries(raw.personas)) out[key] = cleanPersona(key, p, limits);
  return out;
}

/** The limits of cleanPersona from the loaded config (ui.fx.hit.persona, ui.bubbleMaxChars, ui.snack.kinds). */
export const personaLimits = (cfg) => ({ ...cfg.ui.fx.hit.persona, lineMax: cfg.ui.bubbleMaxChars, kinds: cfg.ui.snack.kinds });
