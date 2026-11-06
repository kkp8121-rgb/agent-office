import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { FX_EVENTS, createFx, loadStored, nextCombo, parseChoice, resolveFx, resolveSfx, saveStored } from '../web/fx.mjs';
import { INDEX_HTML } from '../server/pages.mjs';
import { loadConfig } from '../server/config.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (...p) => readFileSync(join(ROOT, ...p), 'utf8');
const appSrc = read('web', 'app.mjs');

/** A storage that remembers; `blocked` makes every access throw like a blocked localStorage. */
function memStorage(initial = {}, blocked = false) {
  const m = new Map(Object.entries(initial));
  const guard = () => { if (blocked) throw new Error('blocked'); };
  return { getItem: (k) => (guard(), m.has(k) ? m.get(k) : null), setItem: (k, v) => (guard(), void m.set(k, String(v))), raw: m };
}

/** A matchMedia stand-in whose `matches` the test can flip (and announce). */
function fakeMedia(matches) {
  const subs = [];
  const mq = { matches, addEventListener: (_t, fn) => subs.push(fn), flip(v) { mq.matches = v; for (const fn of subs) fn({ matches: v }); } };
  return mq;
}

const fakeDoc = () => {
  const on = new Set();
  return { on, documentElement: { classList: { toggle: (c, v) => (v ? on.add(c) : on.delete(c)) } } };
};

function make({ stored = {}, blocked = false, reduced = false, cfg = {} } = {}) {
  const storage = memStorage(stored, blocked);
  const mq = fakeMedia(reduced);
  const logs = [];
  const fx = createFx({ getStorage: () => storage, matchMedia: () => mq, log: (...a) => logs.push(a) });
  const doc = fakeDoc();
  fx.start({ enabled: true, sound: true, volume: 0.25, ...cfg }, doc);
  return { fx, storage, mq, logs, doc };
}

// ---- the pure parts ----

test('choices: only 1 and 0 are a choice, everything else means the viewer has not chosen', () => {
  assert.equal(parseChoice('1'), true);
  assert.equal(parseChoice('0'), false);
  for (const v of [null, undefined, '', 'true', 'yes', '2']) assert.equal(parseChoice(v), null, String(v));
});

test('defaults: reduced motion turns the effects off until the viewer chooses; sound is on by default', () => {
  assert.equal(resolveFx(null, false, true), true);
  assert.equal(resolveFx(null, true, true), false, 'reduced motion');
  assert.equal(resolveFx(true, true, true), true, 'a choice beats reduced motion');
  assert.equal(resolveFx(false, false, true), false);
  assert.equal(resolveFx(null, false, false), false, 'the config default');
  assert.equal(resolveSfx(null, true), true);
  assert.equal(resolveSfx(false, true), false);
  assert.equal(resolveSfx(null, false), false);
});

test('combo: consecutive clicks within resetMs count on without a cap, a pause or a first click starts at 1', () => {
  let c = nextCombo(null, 1000, 1500);
  assert.equal(c.n, 1);
  const ns = [];
  for (let t = 1400; ns.length < 9; t += 300) { c = nextCombo(c, t, 1500); ns.push(c.n); }
  assert.deepEqual(ns, [2, 3, 4, 5, 6, 7, 8, 9, 10], 'not capped (ui.poke.maxLevel only caps the level)');
  assert.equal(nextCombo(c, c.at + 1500, 1500).n, 11, 'exactly resetMs later still counts, like nextPoke');
  assert.equal(nextCombo(c, c.at + 1501, 1500).n, 1, 'one ms later it starts again');
});

// ---- the switchboard ----

test('switches: on by default, off under reduced motion, <html> carries fx-on, sound follows the effects', () => {
  const a = make();
  assert.equal(a.fx.fxOn(), true);
  assert.equal(a.fx.sfxOn(), true);
  assert.equal(a.fx.fxVolume(), 0.25);
  assert.ok(a.doc.on.has('fx-on'));
  const b = make({ reduced: true });
  assert.equal(b.fx.fxOn(), false);
  assert.equal(b.fx.sfxOn(), false, 'no effects, no sound');
  assert.equal(b.fx.choices().sfx, true, 'but the sound switch itself still shows its own state');
  assert.ok(!b.doc.on.has('fx-on'));
});

test('switches: the viewer\'s choices persist as 1 / 0 and are read back by the next page', () => {
  const a = make({ reduced: true });
  a.fx.setFx(true);
  a.fx.setSfx(false);
  assert.equal(a.storage.raw.get('agent-office.fx'), '1');
  assert.equal(a.storage.raw.get('agent-office.sfx'), '0');
  assert.equal(a.fx.fxOn(), true, 'the choice beats reduced motion');
  assert.equal(a.fx.sfxOn(), false);
  assert.ok(a.doc.on.has('fx-on'));
  const b = make({ stored: Object.fromEntries(a.storage.raw), reduced: true });
  assert.equal(b.fx.fxOn(), true, 'the next page remembers');
  assert.equal(b.fx.sfxOn(), false);
  const c = make({ stored: { 'agent-office.fx': '0' } });
  assert.equal(c.fx.fxOn(), false);
  assert.ok(!c.doc.on.has('fx-on'));
  const d = make({ stored: { 'agent-office.fx': 'junk', 'agent-office.sfx': '2' } });
  assert.equal(d.fx.fxOn(), true, 'junk = not chosen = the default');
  assert.equal(d.fx.sfxOn(), true);
});

test('switches: a blocked storage never throws, the choice lasts for this page', () => {
  assert.equal(loadStored(() => { throw new Error('x'); }, 'k'), null);
  assert.equal(saveStored(() => { throw new Error('x'); }, 'k', true), false);
  const a = make({ blocked: true });
  assert.equal(a.fx.fxOn(), true);
  a.fx.setFx(false);
  assert.equal(a.fx.fxOn(), false, 'the page still obeys the switch');
  assert.ok(!a.doc.on.has('fx-on'));
  a.fx.setFx(true);
  assert.equal(a.fx.fxOn(), true);
});

test('switches: the default follows prefers-reduced-motion changes until the viewer has chosen', () => {
  const a = make();
  const seen = [];
  a.fx.onFxChange((s) => seen.push([s.fx, s.sfx]));
  a.mq.flip(true);
  assert.equal(a.fx.fxOn(), false);
  a.mq.flip(false);
  assert.equal(a.fx.fxOn(), true);
  assert.deepEqual(seen, [[false, false], [true, true]]);
  a.fx.setFx(false);
  a.mq.flip(true);
  a.mq.flip(false);
  assert.equal(a.fx.fxOn(), false, 'a chosen switch ignores the media query');
});

test('switches: the small window\'s <html> gets and loses fx-on with the main one (trackDoc)', () => {
  const a = make();
  const pip = fakeDoc();
  const stop = a.fx.trackDoc(pip);
  assert.ok(pip.on.has('fx-on'));
  a.fx.setFx(false);
  assert.ok(!pip.on.has('fx-on'));
  stop();
  a.fx.setFx(true);
  assert.ok(!pip.on.has('fx-on'), 'a stopped document is left alone');
});

test('bus: emit is synchronous, delivers the detail, and unsubscribe stops it', () => {
  const { fx } = make();
  const got = [];
  const off = fx.onFx('poke', (d) => got.push(d));
  const detail = { rec: {}, level: 1 };
  fx.emitFx('poke', detail);
  assert.deepEqual(got, [detail], 'delivered before emitFx returned');
  assert.equal(got[0], detail, 'the same object');
  fx.emitFx('lift', {});
  assert.equal(got.length, 1, 'other names do not reach it');
  off();
  fx.emitFx('poke', detail);
  assert.equal(got.length, 1);
  assert.doesNotThrow(() => fx.emitFx('nobody-listens', {}));
});

test('bus: listeners run only while the effects are on, unless they ask to always hear', () => {
  const { fx } = make();
  const a = [];
  const b = [];
  fx.onFx('state', (d) => a.push(d));
  fx.onFx('state', (d) => b.push(d), { always: true });
  fx.setFx(false);
  fx.emitFx('state', 1);
  assert.deepEqual([a.length, b.length], [0, 1], 'off: the ordinary listener does no work at all');
  fx.setFx(true);
  fx.emitFx('state', 2);
  assert.deepEqual([a.length, b.length], [1, 2]);
});

test('bus: a throwing listener is logged once and cannot stop the other listeners or the emitter', () => {
  const { fx, logs } = make();
  const ok = [];
  fx.onFx('landed', () => { throw new Error('boom'); });
  fx.onFx('landed', (d) => ok.push(d));
  assert.doesNotThrow(() => fx.emitFx('landed', 1));
  assert.doesNotThrow(() => fx.emitFx('landed', 2));
  assert.deepEqual(ok, [1, 2], 'the next listener still ran, every time');
  assert.equal(logs.length, 1, 'reported once, not on every event');
  fx.onFxChange(() => { throw new Error('boom2'); });
  assert.doesNotThrow(() => fx.setFx(false));
});

test('bus: unsubscribing while an event is being delivered is safe', () => {
  const { fx } = make();
  const order = [];
  let offB;
  fx.onFx('drop', () => { order.push('a'); offB(); });
  offB = fx.onFx('drop', () => order.push('b'));
  fx.onFx('drop', () => order.push('c'));
  fx.emitFx('drop', {});
  assert.deepEqual(order, ['a', 'b', 'c'], 'the delivery in progress is not shortened');
  order.length = 0;
  fx.emitFx('drop', {});
  assert.deepEqual(order, ['a', 'c']);
});

// ---- the wiring: structure ----

test('app.mjs emits exactly the documented events, each with the documented fields', () => {
  const emitted = new Set([...appSrc.matchAll(/emitFx\(\s*(?:'([a-z-]+)'|on \? '([a-z-]+)' : '([a-z-]+)')/g)].flatMap((m) => m.slice(1).filter(Boolean)));
  assert.deepEqual([...emitted].sort(), [...FX_EVENTS].sort());
  const header = read('web', 'fx.mjs').split('\n').filter((l) => l.startsWith('//')).join('\n');
  for (const name of FX_EVENTS) assert.match(header, new RegExp(`'${name}'\\s`), `${name} is documented in the header of fx.mjs`);
  const shapes = {
    poke: '{ rec, key: rec.sprite, level: lv, combo: rec.pokeCombo.n, x: e.clientX, y: e.clientY }',
    'cat-pet': '{ cat: rec, level: lv, combo: cat.pokeCombo.n, x: e.clientX, y: e.clientY }',
    thrown: '{ rec, vx: fling.vx, vy: fling.vy }',
    landed: '{ rec, bounces: g.bounces }',
    snack: '{ rec, kind, result: out }',
    report: '{ rec: guest, lead: host }',
    'high-five': '{ a: guest, b: host }',
    'meeting-start': '{ floor: frec, title: phase }',
    state: '{ rec, from, to: av.state }',
    pose: '{ rec, seated: sit, animate }',
    daylight: '{ phase: next }',
    sysload: '{ cpu: sysLoad.cpu, mem: sysLoad.mem }',
  };
  for (const [name, shape] of Object.entries(shapes)) assert.ok(appSrc.includes(`emitFx('${name}', ${shape})`), name);
});

test('the pages link the six area style sheets right after style.css, scripts stay as they were', () => {
  const css = ['fx-weather', 'fx-chars', 'fx-events', 'fx-led', 'fx-hit', 'officelife', 'handoff', 'decor'];
  const links = css.map((n) => `<link rel="stylesheet" href="/web/${n}.css">`).join('\n');
  assert.ok(INDEX_HTML.includes(`<link rel="stylesheet" href="/web/style.css">\n${links}\n<link rel="stylesheet" href="/web/card.css">\n`)); // the character card's sheet follows the six (later packages' sheets may follow it)
  const tail = ['conflict', 'actor', 'commute'].map((n) => `<link rel="stylesheet" href="/web/${n}.css">\n`).join('') + '</head>';
  assert.ok(INDEX_HTML.includes(`<link rel="stylesheet" href="/web/card.css">\n${tail}`)); // after card.css the later packages' sheets in merge order (k, j, l), then the head ends
  assert.match(INDEX_HTML, /<fieldset id="wx-choices"><legend><\/legend><\/fieldset>\s*<fieldset id="fx-choices"><legend><\/legend><\/fieldset>/);
  for (const n of css) assert.ok(existsSync(join(ROOT, 'web', `${n}.css`)), `${n}.css exists`);
});

test('every area is a stub with init(ctx), called once from app.mjs inside a guard', () => {
  for (const [file, name] of [['fx-weather', 'initFxWeather'], ['fx-chars', 'initFxChars'], ['fx-events', 'initFxEvents'], ['fx-led', 'initFxLed'], ['fx-hit', 'initFxHit'], ['officelife', 'initOfficeLife']]) {
    const src = read('web', `${file}.mjs`);
    assert.match(src, /^\/\/ /, `${file} starts with a header comment`);
    assert.match(src, /export function init\(ctx\)/);
    assert.ok(appSrc.includes(`import { init as ${name} } from './${file}.mjs';`), name);
    assert.equal([...appSrc.matchAll(new RegExp(`\\b${name}\\b`, 'g'))].length, 2, `${name}: the import and the one entry of the start list`);
  }
  assert.match(appSrc, /for \(const init of \[initFxWeather, initFxChars, initFxEvents, initFxLed, initFxHit, initOfficeLife\]\) \{\s*try \{\s*init\(ctx\);/);
});

test('config: ui.fx and ui.officeLife exist, every area on its own lines, strings next to the weather strings', () => {
  const cfg = loadConfig();
  assert.deepEqual(cfg.ui.fx.enabled, true);
  assert.equal(cfg.ui.fx.sound, true, 'sound on by default');
  assert.equal(cfg.ui.fx.volume, 0.25);
  for (const a of ['weather', 'chars', 'events', 'led', 'hit']) assert.equal(cfg.ui.fx[a].enabled, true, a);
  assert.equal(cfg.ui.officeLife.enabled, true);
  for (const k of ['fxGroup', 'fxSwitch', 'sfxSwitch', 'sfxHint']) assert.equal(typeof cfg.ui.weather[k], 'string', k);
  assert.equal(cfg.ui.weather.fxSwitch, '화려한 효과');
  assert.equal(cfg.ui.weather.sfxSwitch, '효과음');
  const text = read('config.json');
  for (const a of ['weather', 'chars', 'events', 'led', 'hit']) assert.match(text, new RegExp(`"${a}": \\{\\n\\s+"enabled": true(,\\n|\\n\\s+\\})`), `${a} is written on several lines`);
  assert.match(text, /"officeLife": \{\n\s+"enabled": true,/);
});

// ---- the wiring: behaviour of the pieces app.mjs changed (run the real source in a vm) ----

/** A tiny element tree: only what createChar and the wrappers need. */
function treeEl(cls = '') {
  const classes = new Set(cls.split(' ').filter(Boolean));
  const e = {
    cls, kids: [], style: { setProperty() {} },
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)), contains: (c) => classes.has(c) },
    append(...k) { e.kids.push(...k); },
    addEventListener() {},
  };
  return e;
}

function makeCharIn() {
  const ctx = vm.createContext({
    el: (tag, cls) => treeEl(cls), makeSprite: () => treeEl(), makeLegs: () => [], makeSitSprite: () => treeEl(), bindGrab() {}, charZ: () => 1000,
    sitSet: new Set(), recOf: new WeakMap(), ui: { depth: {} }, amb: { fidgetMs: 1200 },
  });
  vm.runInContext(appSrc.match(/function createChar\(.*?\n}\n/s)[0], ctx);
  vm.runInContext('globalThis.make = createChar', ctx);
  return ctx.make;
}

test('characters: the root holds .fx-move > .fx-hit > .body > .flip > .spr, and the record exposes them (the cat too)', () => {
  const make = makeCharIn();
  for (const isCat of [false, true]) {
    const rec = make({ sprite: 'worker', slot: null }, treeEl(), { x: 1, y: 2 }, null, isCat, false);
    assert.equal(rec.fxMove.cls, 'fx-move');
    assert.equal(rec.fxHit.cls, 'fx-hit');
    assert.equal(rec.el.kids[0], rec.fxMove, 'the root first child is the move wrapper');
    assert.deepEqual(rec.fxMove.kids, [rec.fxHit]);
    assert.deepEqual(rec.fxHit.kids, [rec.body]);
    assert.deepEqual(rec.body.kids, [rec.flip]);
    assert.deepEqual(rec.flip.kids, [rec.spr]);
    assert.equal(rec.el.style.transform, 'translate(1px, 2px)', 'walking stays on the root transform');
  }
});

test('style.css: the wrappers are zero-size with transform none, the layer is empty, above the name tags and below the plaques', () => {
  const css = read('web', 'style.css');
  assert.match(css, /\.fx-move, \.fx-hit \{[^}]*width: 0; height: 0; transform: none;/);
  assert.match(css, /\.fx-layer \{[^}]*inset: 0; z-index: 8200; pointer-events: none;/);
  assert.match(css, /\.fx-layer:empty \{ display: none; \}/, 'an empty layer is not drawn (it changed the text anti-aliasing under it)');
  assert.match(css, /\.agt \{ z-index: 8000;/);
  assert.match(css, /position: absolute; top: 8px; right: 8px; max-width: calc\(100% - 340px\); z-index: 9000;/);
});

test('line(): a persona picker is asked first and may decline; one that throws is skipped', () => {
  const logs = [];
  const ctx = vm.createContext({
    linePickers: new Set(), lastLine: new Map(), ui: { ui: { lines: { poke1: ['a', 'b'], other: ['z'] } } }, pickLine: (_r, pool) => pool[0], console: { error: (...a) => logs.push(a) },
  });
  vm.runInContext(appSrc.match(/function firstFrom\(.*?\n}\n/s)[0], ctx);
  vm.runInContext(appSrc.match(/function line\(.*?\n}\n/s)[0], ctx);
  assert.equal(vm.runInContext("line('poke1')", ctx), 'a', 'no picker: the default');
  const seen = [];
  ctx.linePickers.add(() => { throw new Error('bad area'); });
  ctx.linePickers.add((s, fill, who) => (seen.push([s, fill, who]), s === 'poke1' ? `persona:${who.sprite}` : undefined));
  ctx.who = { sprite: 'worker' };
  assert.equal(vm.runInContext("line('poke1', undefined, who)", ctx), 'persona:worker');
  assert.equal(vm.runInContext("line('other', undefined, who)", ctx).constructor, String, 'a declining picker falls back to the default');
  assert.equal(logs.length, 2, 'the throwing picker was reported each time and skipped');
});

test('walk events: start once per walk however many pieces, end once when it stops', () => {
  const events = [];
  const ctx = vm.createContext({ emitFx: (n, d) => events.push([n, d.rec.id]) });
  vm.runInContext(appSrc.match(/function noteWalk\(.*?\n}\n/s)[0], ctx);
  const rec = { id: 'r1' };
  ctx.rec = rec;
  vm.runInContext('noteWalk(rec, true); noteWalk(rec, true); noteWalk(rec, true); noteWalk(rec, false); noteWalk(rec, false); noteWalk(rec, true)', ctx);
  assert.deepEqual(events, [['walk-start', 'r1'], ['walk-end', 'r1'], ['walk-start', 'r1']]);
});
