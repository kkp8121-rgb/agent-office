// persona.json loading (server/persona.mjs): a missing or broken file gives {} and is never created, bad parts are dropped, the page gets the result as `personas` in /api/ui.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../server/config.mjs';
import { Office } from '../server/office.mjs';
import { createServer } from '../server/http.mjs';
import { cleanPersona, loadPersonas, personaLimits } from '../server/persona.mjs';
import { TYPES, hashType } from '../web/fx-hit-rules.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = join(ROOT, 'tests', 'fixtures', 'persona-sample.json');
const cfg = loadConfig();
const limits = personaLimits(cfg);
const tmp = () => mkdtempSync(join(tmpdir(), 'ao-persona-'));

test('persona: the sample fixture loads with every persona intact', () => {
  const warns = [];
  const p = loadPersonas(FIXTURE, limits, (m) => warns.push(m));
  assert.deepEqual(warns, []);
  assert.deepEqual(Object.keys(p).sort(), ['cat', 'lead', 'plan', 'scout', 'worker']);
  assert.equal(p.scout.type, 'flinch');
  assert.equal(p.scout.voice, 1.2);
  assert.ok(p.scout.lines.poke1.length >= 3);
  assert.deepEqual(p.cat.snack.love, ['fish']);
});

test('persona: a missing file gives {} with one warning and is not created', () => {
  const dir = tmp();
  try {
    const file = join(dir, 'persona.json');
    const warns = [];
    assert.deepEqual(loadPersonas(file, limits, (m) => warns.push(m)), {});
    assert.equal(warns.length, 1);
    assert.equal(existsSync(file), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('persona: broken JSON and a file without personas give {} with one warning, and the file is left as it was', () => {
  const dir = tmp();
  try {
    for (const body of ['{ not json', '[]', '{"version":1}', '{"personas":[1]}']) {
      const file = join(dir, 'p.json');
      writeFileSync(file, body);
      const warns = [];
      assert.deepEqual(loadPersonas(file, limits, (m) => warns.push(m)), {}, body);
      assert.equal(warns.length, 1, body);
      assert.equal(readFileSync(file, 'utf8'), body);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('persona: an unknown type falls back to the type picked by a hash of the sprite key (always the same)', () => {
  const a = cleanPersona('worker', { type: 'sleepy' }, limits);
  const b = cleanPersona('worker', {}, limits);
  assert.equal(a.type, hashType('worker'));
  assert.equal(b.type, a.type);
  assert.ok(TYPES.includes(a.type));
  assert.equal(cleanPersona('worker', { type: 'tough' }, limits).type, 'tough');
});

test('persona: the hash picks every type for some key and is stable', () => {
  const seen = new Set();
  for (let i = 0; i < 400; i++) seen.add(hashType(`sprite-${i}`));
  assert.equal(seen.size, TYPES.length);
  assert.equal(hashType('scout'), hashType('scout'));
});

test('persona: snack kinds are limited to one per taste, unknown kinds dropped, people never eat fish, the cat only fish', () => {
  const person = cleanPersona('worker', { snack: { love: ['fish', 'donut', 'cookie'], dislike: ['pizza', 'coffee'] } }, limits);
  assert.deepEqual(person.snack, { love: ['donut'], dislike: ['coffee'] });
  const cat = cleanPersona('cat', { snack: { love: ['coffee', 'fish'], dislike: ['donut'] } }, limits);
  assert.deepEqual(cat.snack, { love: ['fish'], dislike: [] });
});

test('persona: lines over the bubble limit and impact words over their limit are dropped, the voice is clamped', () => {
  const long = 'ㄱ'.repeat(limits.lineMax + 1);
  const ok = 'ㄴ'.repeat(limits.lineMax);
  const p = cleanPersona('worker', {
    about: 'a'.repeat(limits.aboutMax + 1),
    voice: 9,
    hitWords: ['퍽!', '너무길어요!', '콩!', '쿵!', '탕!'],
    lines: { poke1: [long, ok], poke2: [long], poke3: 'not a list' },
  }, limits);
  assert.equal(p.about, '');
  assert.equal(p.voice, limits.voice[1]);
  assert.deepEqual(p.hitWords, ['퍽!', '콩!', '쿵!']);
  assert.deepEqual(p.lines, { poke1: [ok] });
  assert.equal(cleanPersona('worker', { voice: 0.1 }, limits).voice, limits.voice[0]);
  assert.equal(cleanPersona('worker', {}, limits).voice, 1);
});

test('persona: /api/ui carries the personas (and {} when there is none)', async (t) => {
  for (const personas of [loadPersonas(FIXTURE, limits), {}]) {
    const office = new Office(cfg, { hidden: [], names: {} });
    const server = createServer(cfg, office, { personas });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    t.after(() => {
      server.closeSse();
      server.close();
      server.closeAllConnections();
    });
    const port = server.address().port;
    const ui = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/api/ui', headers: { Host: `127.0.0.1:${port}` } }, (res) => {
        let s = '';
        res.setEncoding('utf8'); // a multi-byte letter may be split across chunks
        res.on('data', (c) => (s += c));
        res.on('end', () => resolve(JSON.parse(s)));
      }).on('error', reject);
    });
    assert.deepEqual(ui.personas, personas);
  }
});

test('persona: the repo ships no persona.json of its own from this area (the lines work writes it)', () => {
  // loadPersonas of the real path never writes: a missing file stays missing
  const file = join(ROOT, 'persona.json');
  const before = existsSync(file);
  loadPersonas(file, limits, () => {});
  assert.equal(existsSync(file), before);
});
