// Character cards (cards.json at the repo root, written by hand / by the copy work, only ever READ here): age, birthplace, hair, eyes, height,
// weight, skills and a short biography per sprite key. The page gets the validated result as `cards` in /api/ui.
// loadCards never creates or writes the file; a missing or broken file gives {} (one warning) and the cards show placeholders.
import fs from 'node:fs';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const len = (s) => Array.from(s).length;
const text = (v, max) => typeof v === 'string' && v.trim() !== '' && len(v) <= max;
const KEY = /^[\w-]{1,40}$/;
const TEXT_FIELDS = ['age', 'birthplace', 'hair', 'eye', 'height', 'weight', 'bio'];

/**
 * Validates one card; returns the cleaned card (only the fields that passed, extra fields ignored). Lenient: a bad field is dropped, never the card.
 * limits = {age, birthplace, hair, eye, height, weight, bio, skill, skillsMin, skillsMax}: the most characters (counted by code point) per field,
 * skills = a list of skillsMin..skillsMax items of at most `skill` characters (bad items are left out; too few good ones drop the field).
 */
export function cleanCard(raw, limits) {
  const out = {};
  if (!isObj(raw)) return out;
  for (const f of TEXT_FIELDS) if (text(raw[f], limits[f])) out[f] = raw[f].trim();
  if (Array.isArray(raw.skills)) {
    const skills = raw.skills.filter((s) => text(s, limits.skill)).map((s) => s.trim()).slice(0, limits.skillsMax);
    if (skills.length >= limits.skillsMin) out.skills = skills;
  }
  return out;
}

/**
 * Reads and validates `file`. Returns {} when it is missing, unreadable, not JSON or has no cards object (one warning through `warn`).
 * @param {string} file
 * @param {object} limits see cleanCard
 * @param {(msg: string) => void} [warn]
 * @returns {Record<string, object>} card by sprite key (a key with no valid field is left out)
 */
export function loadCards(file, limits, warn = (m) => console.warn(m)) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    warn(`cards 파일을 읽지 못했습니다 (${err.code ?? err.name}): 캐릭터 카드는 빈칸으로 나옵니다`);
    return {};
  }
  if (!isObj(raw) || !isObj(raw.cards)) {
    warn('cards 파일에 cards 항목이 없습니다: 캐릭터 카드는 빈칸으로 나옵니다');
    return {};
  }
  const out = {};
  for (const [key, c] of Object.entries(raw.cards)) {
    if (!KEY.test(key)) continue;
    const card = cleanCard(c, limits);
    if (Object.keys(card).length > 0) out[key] = card;
  }
  return out;
}
