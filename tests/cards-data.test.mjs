// cards.json: every sprite key has a card, every field is within the card limits, and no two cards share a birthplace or a biography.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, cfg } from './helpers/fixture.mjs';

const data = JSON.parse(readFileSync(join(ROOT, 'cards.json'), 'utf8'));
const cards = data.cards;
const len = (s) => Array.from(s).length;
const KEYS = [...new Set([...Object.values(cfg.roles).map((r) => r.key), ...cfg.leads.map((l) => l.key), ...cfg.extras.map((e) => e.key), 'cat'])];
const LIMITS = { age: 10, birthplace: 14, hair: 10, eye: 10, height: 10, weight: 14, bio: 120 };
const SKILL_COUNT = [2, 4];
const SKILL_MAX = 16;

test('cards.json has version 1 and one card for each of the 35 sprite keys', () => {
  assert.equal(data.version, 1);
  assert.equal(KEYS.length, 35);
  assert.deepEqual(Object.keys(cards).sort(), [...KEYS].sort());
});

test('every field is a non-empty string within its limit', () => {
  for (const key of KEYS) {
    for (const [field, max] of Object.entries(LIMITS)) {
      const v = cards[key][field];
      assert.equal(typeof v, 'string', `${key}.${field}`);
      assert.ok(len(v) > 0 && len(v) <= max, `${key}.${field} is ${len(v)} chars (max ${max}): ${v}`);
    }
  }
});

test('skills are 2-4 short items', () => {
  for (const key of KEYS) {
    const s = cards[key].skills;
    assert.ok(Array.isArray(s) && s.length >= SKILL_COUNT[0] && s.length <= SKILL_COUNT[1], `${key}.skills count`);
    for (const item of s) assert.ok(typeof item === 'string' && len(item) > 0 && len(item) <= SKILL_MAX, `${key} skill "${item}"`);
  }
});

test('no two cards share a birthplace, a biography or a skill set', () => {
  for (const field of ['birthplace', 'bio']) {
    const seen = new Set(KEYS.map((k) => cards[k][field]));
    assert.equal(seen.size, KEYS.length, `duplicate ${field}`);
  }
  const sets = new Set(KEYS.map((k) => [...cards[k].skills].sort().join('|')));
  assert.equal(sets.size, KEYS.length, 'duplicate skill set');
});
