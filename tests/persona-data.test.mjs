// persona-data.test.mjs - guards persona.json: one persona per sprite key, allowed types and voice range,
// hit words, snack rules, required/optional line keys with line counts and lengths, and line reuse limits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const read = (f) => readFileSync(fileURLToPath(new URL(f, root)), 'utf8');
const config = JSON.parse(read('config.json'));
const persona = JSON.parse(read('persona.json'));
const P = persona.personas;

const TYPES = ['flinch', 'angry', 'dodge', 'proud', 'lazy', 'bubbly', 'tough', 'dramatic', 'shy', 'goofy'];
const PEOPLE_REQUIRED = ['poke1', 'poke2', 'poke3', 'poke4', 'lift', 'heldLong', 'grumble', 'thrown', 'landed', 'combo',
  'snackEat', 'snackLove', 'snackDislike', 'snackDone', 'snackFull', 'snackNoFish'];
const PEOPLE_OPTIONAL = ['smallTalk', 'idleMutter', 'highFive', 'patReply'];
const CAT_REQUIRED = ['catPet1', 'catPet2', 'catPet3', 'catPet4', 'catLift', 'catHeldLong', 'catLanded', 'catSnackDone',
  'combo', 'snackLove', 'snackDislike'];
const PEOPLE_SNACKS = ['coffee', 'donut', 'cookie'];
const len = (s) => [...s].length;

const expectedKeys = new Set([
  ...config.leads.map((l) => l.key),
  ...config.extras.map((e) => e.key),
  ...Object.values(config.roles).map((r) => r.key),
  'cat',
]);
const people = Object.keys(P).filter((k) => k !== 'cat');

test('version is 1 and persona keys equal the sprite keys', () => {
  assert.equal(persona.version, 1);
  assert.deepEqual(new Set(Object.keys(P)), expectedKeys);
});

test('type, voice, about and hitWords are valid', () => {
  for (const [k, p] of Object.entries(P)) {
    assert.ok(TYPES.includes(p.type), `${k} type`);
    assert.ok(typeof p.voice === 'number' && p.voice >= 0.8 && p.voice <= 1.25, `${k} voice`);
    assert.ok(typeof p.about === 'string' && p.about.trim() === p.about && len(p.about) > 0 && len(p.about) <= 40, `${k} about`);
    assert.ok(Array.isArray(p.hitWords) && p.hitWords.length >= 2 && p.hitWords.length <= 3, `${k} hitWords count`);
    for (const w of p.hitWords) assert.ok(w.trim() === w && len(w) >= 1 && len(w) <= 4, `${k} hitWord ${w}`);
  }
});

test('every type is used at least twice among people', () => {
  for (const t of TYPES) assert.ok(people.filter((k) => P[k].type === t).length >= 2, t);
});

test('snack rules', () => {
  const kinds = config.ui.snack.kinds;
  for (const [k, p] of Object.entries(P)) {
    for (const f of ['love', 'dislike']) {
      assert.ok(Array.isArray(p.snack[f]) && p.snack[f].length <= 1, `${k} ${f}`);
      for (const s of p.snack[f]) assert.ok(kinds.includes(s), `${k} ${f} ${s}`);
    }
    const overlap = p.snack.love.filter((s) => p.snack.dislike.includes(s));
    assert.equal(overlap.length, 0, `${k} love and dislike overlap`);
    if (k === 'cat') {
      assert.deepEqual(p.snack.love, ['fish']);
      assert.ok(!p.snack.dislike.includes('fish'));
    } else {
      for (const f of ['love', 'dislike']) for (const s of p.snack[f]) assert.ok(PEOPLE_SNACKS.includes(s), `${k} eats ${s}`);
    }
  }
});

test('required and optional line keys, counts and lengths', () => {
  const max = config.ui.bubbleMaxChars;
  for (const [k, p] of Object.entries(P)) {
    const req = k === 'cat' ? CAT_REQUIRED : PEOPLE_REQUIRED;
    const opt = k === 'cat' ? [] : PEOPLE_OPTIONAL;
    for (const key of req) {
      assert.ok(Array.isArray(p.lines[key]), `${k}.${key} missing`);
      assert.ok(p.lines[key].length >= 3 && p.lines[key].length <= 4, `${k}.${key} needs 3-4 lines`);
    }
    for (const key of opt) {
      if (p.lines[key] !== undefined) assert.ok(p.lines[key].length >= 2 && p.lines[key].length <= 3, `${k}.${key} needs 2-3 lines`);
    }
    for (const key of Object.keys(p.lines)) assert.ok([...req, ...opt].includes(key), `${k}.${key} unknown key`);
    for (const [key, arr] of Object.entries(p.lines)) {
      for (const s of arr) {
        assert.equal(typeof s, 'string');
        assert.ok(s.length > 0 && s.trim() === s, `${k}.${key} blank or untrimmed "${s}"`);
        assert.ok(len(s) <= max, `${k}.${key} too long (${len(s)}) "${s}"`);
      }
    }
  }
});

test('no duplicate line within a persona and no line used by more than two characters', () => {
  const owners = new Map();
  for (const [k, p] of Object.entries(P)) {
    const seen = new Set();
    for (const arr of Object.values(p.lines)) {
      for (const s of arr) {
        assert.ok(!seen.has(s), `${k} repeats "${s}"`);
        seen.add(s);
      }
    }
    for (const s of seen) owners.set(s, [...(owners.get(s) ?? []), k]);
  }
  for (const [s, who] of owners) assert.ok(who.length <= 2, `"${s}" used by ${who.join(', ')}`);
});

test('characters of the same type share at most two lines', () => {
  const keys = Object.keys(P);
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      const a = P[keys[i]];
      const b = P[keys[j]];
      if (a.type !== b.type) continue;
      const lines = new Set(Object.values(a.lines).flat());
      const shared = new Set(Object.values(b.lines).flat().filter((s) => lines.has(s)));
      assert.ok(shared.size <= 2, `${keys[i]} and ${keys[j]} (${a.type}) share ${shared.size} lines: ${[...shared].join(' / ')}`);
    }
  }
});
