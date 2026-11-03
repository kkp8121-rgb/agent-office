import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanCard, loadCards } from '../server/cards.mjs';
import { cardFields, createCardState, fitScale, signature, tagRoute } from '../web/card.mjs';
import { INDEX_HTML } from '../server/pages.mjs';
import { loadConfig } from '../server/config.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const cfg = loadConfig();
const C = cfg.ui.card;
const LIM = C.limits;

function tmpFile(content) {
  const dir = mkdtempSync(join(tmpdir(), 'card-test-'));
  const file = join(dir, 'cards.json');
  if (content !== undefined) writeFileSync(file, content);
  return { file, done: () => rmSync(dir, { recursive: true, force: true }) };
}

const good = { age: '25세', birthplace: '달빛 항구', hair: '갈색', eye: '검은 눈', height: '165cm', weight: '비밀', skills: ['길 찾기', '눈치'], bio: '짧은 소개입니다.' };

// ---- cards.json validator ----

test('config: the card limits are the contract numbers', () => {
  assert.deepEqual(LIM, { age: 10, birthplace: 14, hair: 10, eye: 10, height: 10, weight: 14, skillsMin: 2, skillsMax: 4, skill: 16, bio: 120 });
  assert.equal(C.enabled, true);
  for (const t of ['flinch', 'angry', 'dodge', 'proud', 'lazy', 'bubbly', 'tough', 'dramatic', 'shy', 'goofy']) assert.ok(C.typeLabels[t], t);
});

test('loadCards: a missing file gives {} and one warning', () => {
  const t = tmpFile();
  const warns = [];
  assert.deepEqual(loadCards(t.file, LIM, (m) => warns.push(m)), {});
  assert.equal(warns.length, 1);
  t.done();
});

test('loadCards: broken JSON and a file without cards give {} and one warning each', () => {
  for (const content of ['{ not json', '[]', '{"version":1}', '{"cards":[1,2]}', 'null']) {
    const t = tmpFile(content);
    const warns = [];
    assert.deepEqual(loadCards(t.file, LIM, (m) => warns.push(m)), {}, content);
    assert.equal(warns.length, 1, content);
    t.done();
  }
});

test('loadCards: a good card passes unchanged, extra fields and keys with nothing valid are left out', () => {
  const t = tmpFile(JSON.stringify({ version: 1, cards: { worker: { ...good, mood: 'happy', nested: { a: 1 } }, empty: { nothing: 1 }, '../evil': good, scout: 'text' } }));
  const warns = [];
  const out = loadCards(t.file, LIM, (m) => warns.push(m));
  assert.deepEqual(out, { worker: good });
  assert.equal(warns.length, 0);
  t.done();
});

test('cleanCard: an over-limit field is dropped, the others stay', () => {
  const c = cleanCard({ ...good, age: 'x'.repeat(LIM.age + 1), bio: 'y'.repeat(LIM.bio + 1), weight: 'w'.repeat(LIM.weight) }, LIM);
  assert.equal(c.age, undefined);
  assert.equal(c.bio, undefined);
  assert.equal(c.weight, 'w'.repeat(LIM.weight));
  assert.equal(c.hair, good.hair);
  assert.deepEqual(c.skills, good.skills);
});

test('cleanCard: limits count code points, not UTF-16 units', () => {
  const emoji = '😀'.repeat(LIM.age); // 10 code points, 20 units
  assert.equal(cleanCard({ age: emoji }, LIM).age, emoji);
  assert.equal(cleanCard({ age: `${emoji}😀` }, LIM).age, undefined);
});

test('cleanCard: wrong types and blanks are dropped', () => {
  const c = cleanCard({ age: 25, birthplace: '   ', hair: null, eye: ['a'], height: {}, weight: '', bio: undefined }, LIM);
  assert.deepEqual(c, {});
  assert.deepEqual(cleanCard('nope', LIM), {});
  assert.deepEqual(cleanCard(null, LIM), {});
});

test('cleanCard: skills keep 2-4 good items, bad items are left out, too few drop the field', () => {
  const long = 's'.repeat(LIM.skill + 1);
  assert.deepEqual(cleanCard({ skills: ['a', 'b', 'c', 'd', 'e'] }, LIM).skills, ['a', 'b', 'c', 'd']);
  assert.deepEqual(cleanCard({ skills: ['a', long, 'c', 5] }, LIM).skills, ['a', 'c']);
  assert.equal(cleanCard({ skills: ['a', long] }, LIM).skills, undefined);
  assert.equal(cleanCard({ skills: ['only one'] }, LIM).skills, undefined);
  assert.equal(cleanCard({ skills: 'not a list' }, LIM).skills, undefined);
});

test('the shipped cards.json (when present) loads with every card intact', () => {
  const warns = [];
  const out = loadCards(join(ROOT, 'cards.json'), LIM, (m) => warns.push(m));
  const raw = JSON.parse(readFileSync(join(ROOT, 'cards.json'), 'utf8')).cards;
  assert.equal(warns.length, 0);
  assert.deepEqual(Object.keys(out).sort(), Object.keys(raw).sort());
  for (const [k, c] of Object.entries(out)) assert.deepEqual(c, raw[k], `${k}: every field of the shipped card is valid`);
});

// ---- the field mapping ----

const L = cfg.ui.lobby;
const NOW = 1_000_000_000_000;
const who = (over = {}) => ({ sprite: 'worker', name: '다온', role: '정찰', rank: 'staff', state: 'working', floorStatus: 'active', floorNo: 3, lobby: false, startedAt: NOW - 12 * 60000, ...over });

test('cardFields: name and role, the card fields and the live 사는 곳 / 메모', () => {
  const f = cardFields(who(), good, C, L, NOW);
  assert.equal(f.name, '다온 · 정찰');
  assert.equal(f.age, '25세');
  assert.equal(f.residence, '3층');
  assert.deepEqual(f.skills, good.skills);
  assert.equal(f.bio, good.bio);
  assert.deepEqual(f.memo, ['정찰 · 직원', '근무 중 · 근무 12분']);
  assert.equal(f.stamp, '');
});

test('cardFields: a lobby figure lives in the lobby and names its team floor in the memo', () => {
  const f = cardFields(who({ lobby: true, floorNo: 2, rank: 'lead', state: 'idle' }), good, C, L, NOW);
  assert.equal(f.residence, '1층 로비');
  assert.deepEqual(f.memo, ['정찰 · 팀장', '대기 · 근무 12분', '2층 소속']);
});

test('cardFields: the live fields follow the character (state, leaving floor, hours, unknown start)', () => {
  const a = cardFields(who({ state: 'thinking', startedAt: NOW - 125 * 60000 }), good, C, L, NOW);
  assert.deepEqual(a.memo, ['정찰 · 직원', '생각 중 · 근무 2시간 5분']);
  const b = cardFields(who({ floorStatus: 'leaving', startedAt: 0 }), good, C, L, NOW);
  assert.deepEqual(b.memo, ['정찰 · 직원', '퇴근 중']);
  const c = cardFields(who({ floorNo: 4 }), good, C, L, NOW);
  assert.equal(c.residence, '4층');
});

test('cardFields: no card entry gives the placeholder, never undefined', () => {
  const f = cardFields(who(), undefined, C, L, NOW);
  for (const k of ['age', 'birthplace', 'hair', 'eye', 'height', 'weight', 'bio']) assert.equal(f[k], C.labels.empty, k);
  assert.deepEqual(f.skills, []);
});

test('cardFields: the cat has its own role line, no state and no rank', () => {
  const f = cardFields({ sprite: 'cat', name: '치즈', role: '', rank: 'cat', state: '', floorStatus: '', floorNo: 2, lobby: false, startedAt: 0 }, good, C, L, NOW);
  assert.equal(f.name, '치즈 · 사무실 고양이');
  assert.equal(f.residence, '2층');
  assert.deepEqual(f.memo, ['사무실 고양이']);
});

test('cardFields: the personality stamp shows only for a known type', () => {
  assert.equal(cardFields(who(), good, C, L, NOW, 'shy').stamp, C.typeLabels.shy);
  assert.equal(cardFields(who(), good, C, L, NOW, '').stamp, '');
  assert.equal(cardFields(who(), good, C, L, NOW, 'unknown-type').stamp, '');
});

// ---- the signature ----

test('signature: stable per name, different between names, always drawable', () => {
  assert.deepEqual(signature('다온'), signature('다온'));
  const names = ['다온', '채원', '루아', '하린', '치즈', '나래', '세아', '은재', '시온', '가온'];
  const ds = new Set(names.map((n) => signature(n).d));
  assert.equal(ds.size, names.length);
  for (const n of names) {
    const s = signature(n);
    assert.match(s.d, /^M[-\d. CSQ]+$/);
    assert.match(s.under, /^M[-\d. Q]+$/);
  }
  assert.ok(signature('').d.length > 10);
});

// ---- the tag: what an event on it means ----

test('tagRoute: a click, Enter or Space open the card', () => {
  assert.deepEqual(tagRoute('click', { button: 0 }), { open: true, stop: true, prevent: false });
  assert.equal(tagRoute('click', {}).open, true);
  assert.equal(tagRoute('keydown', { key: 'Enter' }).open, true);
  const space = tagRoute('keydown', { key: ' ' });
  assert.equal(space.open, true);
  assert.equal(space.prevent, true); // Space must not scroll the page
});

test('tagRoute: other buttons and keys open nothing', () => {
  assert.equal(tagRoute('click', { button: 2 }).open, false);
  assert.equal(tagRoute('keydown', { key: 'a' }).open, false);
  assert.equal(tagRoute('keydown', { key: 'Enter', ctrlKey: true }).open, false);
  assert.equal(tagRoute('keydown', { key: 'Tab' }).stop, false);
  assert.equal(tagRoute('mouseover', {}).stop, false);
});

test('tagRoute: a press on a tag never travels on to the poke, lift or drag handlers', () => {
  for (const type of ['pointerdown', 'pointerup', 'pointercancel', 'dblclick', 'click']) {
    const r = tagRoute(type, { button: 0, isPrimary: true });
    assert.equal(r.stop, true, type);
  }
  assert.equal(tagRoute('pointerdown', { button: 0 }).open, false); // the card opens on the click, not on the press
});

test('app.mjs: only the name tag is bound to the card, never the body that pokes and lifts', () => {
  const app = readFileSync(join(ROOT, 'web', 'app.mjs'), 'utf8');
  assert.equal((app.match(/bindTag\(/g) ?? []).length, 1);
  assert.match(app, /bindTag\(rec\.tag, \(\) => card\.open\(rec, rec\.tag, cardWho\)\)/);
  assert.equal((app.match(/bindCardTag\(rec\);/g) ?? []).length, 3, 'floor characters, lobby figures and the cat');
  const grab = app.slice(app.indexOf('function bindGrab'), app.indexOf('function releaseCapture'));
  assert.doesNotMatch(grab, /card/);
});

// ---- open / close state, fit ----

test('createCardState: one card at a time', () => {
  const s = createCardState();
  assert.equal(s.isOpen(), false);
  assert.equal(s.open('a'), null);
  assert.equal(s.isOpen(), true);
  assert.equal(s.current, 'a');
  assert.equal(s.open('b'), 'a'); // opening another one replaces the first
  assert.equal(s.current, 'b');
  assert.equal(s.close(), 'b');
  assert.equal(s.isOpen(), false);
  assert.equal(s.close(), null);
});

test('fitScale: full size when the window is big, smaller when it is not, never below the floor', () => {
  const lay = C.layout;
  assert.equal(fitScale(1920, 1080, lay), 1);
  const small = fitScale(420, 640, lay);
  assert.ok(small < 1 && small >= lay.minScale);
  assert.ok(lay.width * small <= 420 - 2 * lay.margin + 1e-9);
  assert.ok(lay.height * small <= 640 - 2 * lay.margin + 1e-9);
  assert.equal(fitScale(40, 40, lay), lay.minScale);
  assert.equal(fitScale(Number.NaN, 600, lay), 1);
});

// ---- wiring ----

test('the page links card.css after the other area CSS, once', () => {
  const links = [...INDEX_HTML.matchAll(/href="\/web\/([\w-]+\.css)"/g)].map((m) => m[1]);
  assert.equal(links.filter((l) => l === 'card.css').length, 1);
  assert.equal(links.at(-1), 'card.css');
});

test('/api/ui carries the validated cards of the cards.json in the root (and {} without one)', async (t) => {
  const { Office } = await import('../server/office.mjs');
  const { createServer } = await import('../server/http.mjs');
  const ask = async (root) => {
    const c = loadConfig();
    c.root = root;
    const server = createServer(c, new Office(c, { hidden: [], names: {} }));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    t.after(() => new Promise((r) => { server.closeSse(); server.close(r); server.closeAllConnections(); }));
    const port = server.address().port;
    return (await (await fetch(`http://127.0.0.1:${port}/api/ui`)).json()).cards;
  };
  const withFile = tmpFile(JSON.stringify({ version: 1, cards: { worker: { ...good, age: 'x'.repeat(40) } } }));
  const root = dirname(withFile.file);
  const cards = await ask(root);
  assert.equal(cards.worker.age, undefined);
  assert.equal(cards.worker.hair, good.hair);
  withFile.done();
  const bare = tmpFile();
  assert.deepEqual(await ask(dirname(bare.file)), {});
  bare.done();
});
