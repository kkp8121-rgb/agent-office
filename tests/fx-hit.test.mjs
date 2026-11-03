// Effects area "hit": the pure rules (web/fx-hit-rules.mjs), the sound synth and its gating (web/fx-hit-sound.mjs), the shipped numbers (config ui.fx.hit)
// and the area's wiring with a fake page (web/fx-hit.mjs): no AudioContext before a gesture or while 「효과음」 is off, persona lines through the picker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../server/config.mjs';
import { loadPersonas, personaLimits } from '../server/persona.mjs';
import { createFx, nextCombo } from '../web/fx.mjs';
import { nextPoke } from '../web/play.mjs';
import {
  TYPES, bounceFrames, burstPlan, comboSpeaks, comboView, createLinePicker, flightFrames, headShakeFrames, hitStopMs, knockDir, landFrames, lineKeyFor,
  liftFrames, moodLineKey, motionFrames, personaKey, personaOf, snackMood, typeOf,
} from '../web/fx-hit-rules.mjs';
import { createSound, soundPlan } from '../web/fx-hit-sound.mjs';
import { init } from '../web/fx-hit.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const cfg = loadConfig();
const H = cfg.ui.fx.hit;
const personas = loadPersonas(join(ROOT, 'tests', 'fixtures', 'persona-sample.json'), personaLimits(cfg), () => {});
const seq = (...v) => {
  let i = 0;
  return () => v[i++ % v.length];
};
const REST = 'translate(0px, 0px) rotate(0deg) scale(1, 1)';

// ---- hit-stop and motion timing ----

test('hit-stop: 50-90 ms, longer with the level, plus the type bonus (tough holds longer)', () => {
  const plain = {};
  const ms = [1, 2, 3, 4].map((l) => hitStopMs(l, plain, H));
  assert.deepEqual(ms, H.hitStopMs);
  assert.ok(ms[0] >= 50 && ms[3] <= 90);
  assert.ok(ms.every((v, i) => i === 0 || v > ms[i - 1]));
  assert.equal(hitStopMs(1, H.types.tough, H), H.hitStopMs[0] + H.types.tough.stopBonus);
  assert.equal(hitStopMs(4, H.types.tough, H), H.hitStopMs[3]); // the bonus never pushes it past the top of the window
  for (const name of [...TYPES, 'cat']) {
    const row = [1, 2, 3, 4].map((l) => hitStopMs(l, H.types[name], H));
    assert.ok(row.every((v) => v >= 50 && v <= 90), `${name} hit-stop ${row} inside 50-90 ms`);
    assert.ok(row.every((v, i) => i === 0 || v >= row[i - 1]), `${name} hit-stop ${row} does not shrink with the level`);
  }
  assert.equal(hitStopMs(9, plain, H), H.hitStopMs[3]); // beyond the top level: the top level
  assert.equal(hitStopMs(0, plain, H), H.hitStopMs[0]);
});

test('motion: the freeze sits at the impact (pressed within pressMs, held for the hit-stop, then the reaction)', () => {
  for (const name of [...TYPES, 'cat']) {
    const p = H.types[name];
    for (const level of [1, 2, 3, 4]) {
      const stopMs = hitStopMs(level, p, H);
      const m = motionFrames(p, level, 1, { stopMs, H });
      const hold = stopMs + (p.delay ?? 0);
      assert.equal(m.ms, hold + p.ms, `${name} ${level} length`);
      assert.ok(Math.abs(m.stopEnd - hold / m.ms) < 0.002, `${name} ${level} stopEnd`);
      assert.ok(Math.abs(m.pressedAt - Math.min(H.pressMs, hold) / m.ms) < 0.002);
      const at = (o) => m.frames.find((f) => Math.abs(f.offset - o) < 0.002);
      assert.equal(at(m.pressedAt).transform, at(m.stopEnd).transform, `${name} ${level}: held still during the hit-stop`);
      assert.equal(m.frames[0].offset, 0);
      assert.equal(m.frames.at(-1).offset, 1);
      for (let i = 1; i < m.frames.length; i++) assert.ok(m.frames[i].offset >= m.frames[i - 1].offset, `${name} ${level}: offsets in order`);
      const shape = (t) => t.replace(/-?\d+(\.\d+)?/g, '#');
      assert.ok(m.frames.every((f) => shape(f.transform) === shape(m.frames[0].transform)), `${name} ${level}: one transform list so the browser can interpolate`);
    }
  }
});

test('motion: only transform animates, and the character is back at rest at the end', () => {
  const m = motionFrames(H.types.bubbly, 3, -1, { stopMs: 75, H });
  assert.ok(m.frames.every((f) => Object.keys(f).every((k) => ['offset', 'transform', 'easing'].includes(k))));
  assert.equal(m.frames.at(-1).transform, REST);
});

test('motion: knockback goes away from the click and grows with the level; a seated character moves less', () => {
  const tx = (m, i) => Number(/translate\((-?[\d.]+)px/.exec(m.frames[i].transform)[1]);
  const peak = (m) => Math.max(...m.frames.map((_, i) => Math.abs(tx(m, i))));
  const right = motionFrames(H.types.flinch, 2, 1, { stopMs: 60, H });
  const left = motionFrames(H.types.flinch, 2, -1, { stopMs: 60, H });
  assert.ok(Math.max(...right.frames.map((_, i) => tx(right, i))) > 0);
  assert.ok(Math.min(...left.frames.map((_, i) => tx(left, i))) < 0);
  const lv1 = peak(motionFrames(H.types.flinch, 1, 1, { stopMs: 50, H }));
  const lv4 = peak(motionFrames(H.types.flinch, 4, 1, { stopMs: 90, H }));
  assert.ok(lv4 > lv1);
  assert.ok(peak(motionFrames(H.types.flinch, 4, 1, { stopMs: 90, seated: true, H })) < lv4);
});

test('motion: a missed dodge has no press and no hold; an angry one shakes; a dramatic one spins from level 3; a shy one turns its back', () => {
  const miss = motionFrames(H.types.dodge, 1, 1, { stopMs: 50, miss: true, H });
  assert.equal(miss.ms, H.types.dodge.ms);
  assert.equal(miss.stopEnd, 0);
  const angry = motionFrames(H.types.angry, 3, 1, { stopMs: 75, H });
  assert.ok(angry.frames.length >= H.types.angry.shakes + 3);
  const spin = (lv, seated) => motionFrames(H.types.dramatic, lv, 1, { stopMs: 60, seated, H }).frames.some((f) => /rotate\((360|180)deg\)/.test(f.transform));
  assert.equal(spin(2, false), false);
  assert.equal(spin(3, false), true);
  assert.equal(spin(4, true), false);
  const turned = (lv) => motionFrames(H.types.shy, lv, 1, { stopMs: 60, H }).frames.some((f) => /scale\(-/.test(f.transform));
  assert.equal(turned(1), false);
  assert.equal(turned(2), true);
});

test('motion: a dodger has already stepped aside when the tap lands, the others barely moved', () => {
  const tx = (m) => Number(/translate\((-?[\d.]+)px/.exec(m.frames.find((f) => Math.abs(f.offset - m.pressedAt) < 0.002).transform)[1]);
  const dodge = motionFrames(H.types.dodge, 4, 1, { stopMs: 90, H });
  const flinch = motionFrames(H.types.flinch, 4, 1, { stopMs: 90, H });
  assert.ok(tx(dodge) > H.types.dodge.knock * 0.5);
  assert.ok(tx(flinch) < H.types.flinch.knock * 0.5);
});

test('lift, flight, landing, bounce and head shake: transform-only keyframes that end at rest (flight at its spin)', () => {
  const lf = liftFrames(H.types.goofy, H);
  assert.equal(lf.pop.at(-1).transform, REST);
  assert.ok(lf.wiggle.length === 2 && lf.wiggleMs > 0);
  const ff = flightFrames(H.types.dramatic, 600, -200, 800, H);
  assert.equal(ff.ms, 800);
  assert.ok(ff.frames[0].transform.includes('scale(1.3, 0.8)'));
  const mid = H.throw.spinMidPx;
  assert.ok(ff.frames.every((f) => f.transform.startsWith(`translate(0px, ${-mid}px) `) && f.transform.endsWith(`translate(0px, ${mid}px)`)), 'turns about the body middle');
  assert.ok(ff.frames.at(-1).transform.includes(') rotate(1080deg) rotate('));
  assert.ok(flightFrames(H.types.tough, -600, 0, 500, H).frames.at(-1).transform.includes(') rotate(0deg) rotate('));
  assert.ok(flightFrames(H.types.flinch, -600, 0, 500, H).frames.at(-1).transform.includes(') rotate(-360deg) rotate('));
  for (const k of [landFrames(H.types.tough, H), bounceFrames(H.types.bubbly, H), headShakeFrames(H)]) {
    assert.ok(k.ms > 0);
    assert.equal(k.frames.at(-1).transform, REST);
  }
  assert.ok(landFrames(H.types.tough, H).frames[0].transform.includes('scale(1.07'));
});

// ---- combo ----

test('combo: counts from the third consecutive poke, grows with each click up to its cap; the persona line takes over past the top level', () => {
  let c = null;
  const ns = [];
  for (const t of [0, 400, 800, 1200, 1600, 5000]) {
    c = nextCombo(c, t, cfg.ui.poke.resetMs);
    ns.push(c.n);
  }
  assert.deepEqual(ns, [1, 2, 3, 4, 5, 1]);
  assert.equal(comboView(2, H), null);
  assert.equal(comboView(3, H).text, '3 콤보');
  assert.equal(comboView(3, H).scale, H.combo.baseScale);
  assert.ok(comboView(5, H).scale > comboView(4, H).scale);
  assert.equal(comboView(99, H).scale, H.combo.maxScale);
  const max = cfg.ui.poke.maxLevel;
  assert.equal(comboSpeaks(max, max), false);
  assert.equal(comboSpeaks(max + 1, max), true);
  // the poke level stops at maxLevel while the combo goes on
  let p = null;
  for (let i = 0; i < 7; i++) p = nextPoke(p, i * 300, cfg.ui.poke);
  assert.equal(p.level, max);
});

test('knock direction: away from the click; a click on the centre alternates with the combo', () => {
  assert.equal(knockDir(110, 100, 1), -1);
  assert.equal(knockDir(90, 100, 1), 1);
  assert.equal(knockDir(100, 100, 1), 1);
  assert.equal(knockDir(100, 100, 2), -1);
});

test('burst: the requested number of particles, deterministic with the same randomness, all moved away from the click', () => {
  const a = burstPlan(7, 28, seq(0.1, 0.5, 0.9));
  const b = burstPlan(7, 28, seq(0.1, 0.5, 0.9));
  assert.equal(a.length, 7);
  assert.deepEqual(a, b);
  assert.ok(a.every((q) => Math.hypot(q.dx, q.dy + 28 * 0.25) > 8));
});

// ---- personas and lines ----

test('persona of a character: its sprite key (the cat is "cat"), else a bare persona with a type from the hash', () => {
  assert.equal(personaKey({ isCat: true, sprite: 'cat-x' }), 'cat');
  assert.equal(personaKey({ sprite: 'scout' }), 'scout');
  assert.equal(personaOf(personas, { sprite: 'scout' }).type, 'flinch');
  const bare = personaOf(personas, { sprite: 'nobody' });
  assert.ok(TYPES.includes(bare.type));
  assert.deepEqual(bare.lines, {});
  assert.equal(typeOf({ isCat: true }, personas.cat), 'cat'); // the cat's motion set is its own whatever its persona type says
  assert.equal(typeOf({ sprite: 'scout' }, personas.scout), 'flinch');
});

test('line keys: lead variants map onto the plain keys, the cat generic combo and snack keys onto the persona ones', () => {
  const lead = { sprite: 'lead', isLead: true };
  assert.deepEqual([1, 2, 3, 4].map((n) => lineKeyFor(`pokeLead${n}`, lead)), ['poke1', 'poke2', 'poke3', 'poke4']);
  assert.equal(lineKeyFor('liftLead', lead), 'lift');
  assert.equal(lineKeyFor('grumbleLead', lead), 'grumble');
  assert.equal(lineKeyFor('poke2', lead), 'poke2');
  const cat = { isCat: true, sprite: 'cat' };
  assert.deepEqual(['catCombo', 'catSnackLove', 'catSnackDislike'].map((k) => lineKeyFor(k, cat)), ['combo', 'snackLove', 'snackDislike']);
  assert.equal(moodLineKey('snackDone', 'love'), 'snackLove');
  assert.equal(moodLineKey('catSnackDone', 'dislike'), 'snackDislike');
  assert.equal(moodLineKey('snackDone', null), 'snackDone');
  assert.equal(moodLineKey('poke1', 'love'), 'poke1');
});

test('line picker: the persona line when it has one, never twice in a row, lead variants mapped, otherwise undefined (the generic line)', () => {
  const generic = cfg.ui.lines;
  const rec = { sprite: 'scout' };
  const pk = createLinePicker({ personas, generic, rng: Math.random });
  const pool = personas.scout.lines.poke1;
  let last = '';
  for (let i = 0; i < 60; i++) {
    const t = pk.pick('poke1', undefined, rec);
    assert.ok(pool.includes(t));
    assert.notEqual(t, last);
    last = t;
  }
  const lead = { sprite: 'lead', isLead: true };
  assert.ok(personas.lead.lines.poke3.includes(pk.pick('pokeLead3', undefined, lead)));
  assert.ok(personas.lead.lines.lift.includes(pk.pick('liftLead', undefined, lead)));
  assert.ok(personas.lead.lines.grumble.includes(pk.pick('grumbleLead', undefined, lead)));
  assert.equal(pk.pick('poke1', undefined, undefined), undefined); // no speaker: generic
  assert.equal(pk.pick('poke1', undefined, { sprite: 'nobody' }), undefined); // no persona: generic
  assert.equal(pk.pick('bossDrop', undefined, rec), undefined); // a situation the persona has no line for: generic
  assert.equal(createLinePicker({ personas: {}, generic, rng: Math.random }).pick('poke1', undefined, rec), undefined);
  const withTask = createLinePicker({ personas: { x: { lines: { snackEat: ['{task} 냠'] } } }, generic, rng: Math.random });
  assert.equal(withTask.pick('snackEat', '커피', { sprite: 'x' }), '커피 냠');
});

test('line picker: the cat combo, a loved or disliked snack (done line), and the generic mood lines when the persona has none', () => {
  const generic = cfg.ui.lines;
  const pk = createLinePicker({ personas, generic, rng: Math.random });
  const cat = { isCat: true, sprite: 'cat' };
  assert.ok(personas.cat.lines.combo.includes(pk.pick('catCombo', undefined, cat)));
  pk.setMood(cat, 'love');
  assert.ok(personas.cat.lines.snackLove.includes(pk.pick('catSnackDone', undefined, cat)));
  assert.ok(personas.cat.lines.catSnackDone.includes(pk.pick('catSnackDone', undefined, cat)), 'the mood is used once');
  const w = { sprite: 'worker' };
  pk.setMood(w, 'dislike');
  assert.ok(personas.worker.lines.snackDislike.includes(pk.pick('snackDone', undefined, w)));
  const g = createLinePicker({ personas: { x: { lines: {} } }, generic, rng: Math.random });
  const x = { sprite: 'x' };
  g.setMood(x, 'love');
  assert.ok(generic.snackLove.includes(g.pick('snackDone', undefined, x)));
  const xc = { sprite: 'x', isCat: true };
  g.setMood(xc, 'dislike');
  assert.ok(generic.catSnackDislike.includes(g.pick('catSnackDone', undefined, xc)));
  g.setMood(x, null);
  assert.equal(g.pick('snackDone', undefined, x), undefined);
});

test('snack mood: love and dislike from the persona taste, none otherwise', () => {
  assert.equal(snackMood(personas.scout, 'cookie'), 'love');
  assert.equal(snackMood(personas.scout, 'coffee'), 'dislike');
  assert.equal(snackMood(personas.scout, 'donut'), null);
  assert.equal(snackMood(undefined, 'donut'), null);
});

// ---- shipped numbers ----

test('config: every type has its numbers, its sound exists, its words fit the limit; the generic lines for the new situations exist', () => {
  assert.deepEqual(Object.keys(H.types).sort(), [...TYPES, 'cat'].sort());
  for (const [name, t] of Object.entries(H.types)) {
    for (const k of ['knock', 'hop', 'tilt', 'press', 'peak', 'ms', 'peakShare', 'springs', 'decay', 'jelly', 'snd', 'color', 'words', 'wig', 'spin']) assert.ok(k in t, `${name}.${k}`);
    assert.ok(H.sound.recipes[t.snd], `${name} sound ${t.snd}`);
    assert.ok(t.words.every((w) => Array.from(w).length <= H.persona.hitWordMax), `${name} words`);
    if (t.extra?.kind === 'mark') assert.ok(H.marks[t.extra.mark], `${name} mark`);
  }
  for (const k of ['combo', 'snackLove', 'snackDislike', 'catCombo', 'catSnackLove', 'catSnackDislike']) {
    assert.ok(cfg.ui.lines[k].length >= 3, k);
    assert.ok(cfg.ui.lines[k].every((l) => Array.from(l).length <= cfg.ui.bubbleMaxChars), `${k} fits a bubble`);
  }
  assert.ok(H.shake.px <= 4 && H.shake.ms <= 250);
  assert.equal(H.shake.fromLevel, 3);
  assert.equal(H.flash.fromLevel, 3);
  assert.equal(H.combo.from, 3);
});

test('config: the fixture personas use real types and every fixture line fits a bubble', () => {
  const raw = JSON.parse(readFileSync(join(ROOT, 'tests', 'fixtures', 'persona-sample.json'), 'utf8'));
  for (const [key, p] of Object.entries(raw.personas)) {
    assert.ok(TYPES.includes(p.type), key);
    for (const pool of Object.values(p.lines)) for (const l of pool) assert.ok(Array.from(l).length <= cfg.ui.bubbleMaxChars, `${key}: ${l}`);
  }
});

// ---- sound ----

/** A fake Web Audio: counts what is made, lets the test end voices. */
function fakeAudio() {
  const made = { contexts: 0, voices: 0, ended: [] };
  class FakeParam {
    setValueAtTime() {}
    exponentialRampToValueAtTime() {}
  }
  class FakeAC {
    constructor() {
      made.contexts++;
      this.state = 'running';
      this.currentTime = 0;
      this.sampleRate = 1000;
      this.destination = {};
      made.last = this;
    }
    resume() { this.state = 'running'; }
    suspend() { this.state = 'suspended'; }
    createGain() { return { gain: new FakeParam(), connect() {} }; }
    createBuffer(_c, len) { return { getChannelData: () => new Float32Array(len) }; }
    createBiquadFilter() { return { frequency: new FakeParam(), Q: {}, connect() {} }; }
    createBufferSource() {
      const s = { connect() {}, start() { made.voices++; }, stop() {} };
      made.ended.push(s);
      return s;
    }
    createOscillator() {
      const s = { frequency: new FakeParam(), connect() {}, start() { made.voices++; }, stop() {} };
      made.ended.push(s);
      return s;
    }
  }
  return { Ctor: FakeAC, made };
}

const soundDeps = (over = {}) => ({ enabled: () => true, volume: () => 0.25, maxVoices: H.sound.maxVoices, noiseMs: H.sound.noiseMs, attackMs: H.sound.attackMs, tailMs: H.sound.tailMs, ...over });

test('sound plan: pitch follows the persona voice and the combo (capped), the master volume scales the gain, unknown kinds are silent', () => {
  const base = soundPlan('pop', 1, 1, H.sound)[0];
  assert.equal(soundPlan('pop', 1.2, 1, H.sound)[0].f0, base.f0 * 1.2);
  assert.ok(soundPlan('pop', 1, 4, H.sound)[0].f0 > base.f0);
  assert.equal(soundPlan('pop', 1, 99, H.sound)[0].f0, base.f0 * H.sound.comboPitchMax);
  assert.equal(base.gain, H.sound.recipes.pop[0].gain * H.sound.master);
  assert.deepEqual(soundPlan('nope', 1, 1, H.sound), []);
  assert.ok(soundPlan('whoosh', 1, 1, H.sound)[0].noise);
  for (const k of Object.keys(H.sound.recipes)) assert.ok(soundPlan(k, 1, 1, H.sound).every((v) => v.f0 > 0 && v.ms > 0 && v.gain > 0), k);
});

test('sound gating: no AudioContext before a gesture, none while the sound is off, silent until then', () => {
  const { Ctor, made } = fakeAudio();
  let on = false;
  const s = createSound(soundDeps({ Ctor, enabled: () => on }));
  assert.equal(made.contexts, 0);
  assert.equal(s.play(soundPlan('pop', 1, 1, H.sound)), false, 'nothing plays before a gesture');
  s.gesture(); // a gesture while 「효과음」 is off
  assert.equal(made.contexts, 0);
  on = true;
  assert.equal(s.play(soundPlan('pop', 1, 1, H.sound)), false, 'still no context: only a gesture makes it');
  assert.equal(made.contexts, 0);
  s.gesture();
  assert.equal(made.contexts, 1);
  assert.equal(s.ready(), true);
  s.gesture();
  assert.equal(made.contexts, 1, 'one context');
  assert.equal(s.play(soundPlan('pop', 1, 1, H.sound)), true);
  on = false;
  assert.equal(s.play(soundPlan('pop', 1, 1, H.sound)), false, 'off again: silent');
});

test('sound: at most maxVoices at once; a blocked or missing AudioContext keeps the office silent without throwing', () => {
  const { Ctor, made } = fakeAudio();
  const s = createSound(soundDeps({ Ctor }));
  s.gesture();
  const plan = soundPlan('thump', 1, 1, H.sound);
  const results = Array.from({ length: H.sound.maxVoices + 3 }, () => s.play(plan));
  assert.equal(results.filter(Boolean).length, H.sound.maxVoices);
  assert.equal(s.voices(), H.sound.maxVoices);
  for (const v of made.ended) v.onended?.();
  assert.equal(s.voices(), 0);
  assert.equal(s.play(plan), true, 'voices free again');
  const broken = createSound(soundDeps({ Ctor: class { constructor() { throw new Error('blocked'); } } }));
  broken.gesture();
  assert.equal(broken.ready(), false);
  assert.equal(broken.play(plan), false);
  const none = createSound(soundDeps({ Ctor: null }));
  none.gesture();
  assert.equal(none.ready(), false);
});

test('sound: sleep suspends a running context (costs nothing while off) and a later gesture wakes it', () => {
  const { Ctor, made } = fakeAudio();
  const s = createSound(soundDeps({ Ctor }));
  s.gesture();
  s.sleep();
  assert.equal(made.last.state, 'suspended');
  s.gesture();
  assert.equal(made.last.state, 'running');
});

// ---- the area wired to a fake page ----

/** A page stand-in for init(): the switchboard, a document that records its listeners, one floor with one character whose wrapper records its animations. */
function fakePage({ fxChoice = true, sfxChoice = true, hitEnabled = true } = {}) {
  const store = new Map([['agent-office.fx', fxChoice ? '1' : '0'], ['agent-office.sfx', sfxChoice ? '1' : '0']]);
  const fx = createFx({ getStorage: () => ({ getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) }), matchMedia: () => null });
  fx.start({ enabled: true, sound: true, volume: 0.25 });
  const listeners = [];
  const node = () => ({ className: '', textContent: '', style: { setProperty() {}, removeProperty() {} }, animate: () => ({ cancel() {} }), remove() {}, append() {} });
  globalThis.document = {
    addEventListener: (t, fn) => listeners.push({ t, fn }),
    removeEventListener: (t, fn) => listeners.splice(listeners.findIndex((l) => l.t === t && l.fn === fn), 1),
    createElement: node,
  };
  const audio = fakeAudio();
  globalThis.AudioContext = audio.Ctor;
  const pickers = [];
  const anims = [];
  const classes = new Set(['squash']);
  const rec = {
    sprite: 'scout', isCat: false, seated: false,
    body: { classList: { remove: (...c) => c.forEach((n) => classes.delete(n)) }, getBoundingClientRect: () => ({ left: 100, right: 144, top: 100, bottom: 164 }) },
    fxHit: { animate: (frames, opts) => { const a = { frames, opts, cancel() { a.cancelled = true; }, onfinish: null }; anims.push(a); return a; } },
    flip: { append() {} }, spr: { cloneNode: () => ({ ...node(), setAttribute() {} }) },
  };
  const floor = { off: false, layer: { append() {} }, stage: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }), animate: () => ({ cancel() {} }) }, scene: { r: { size: [800, 600] } } };
  rec.frec = floor;
  const said = [];
  const ctx = {
    ui: { ...cfg.ui, fx: { ...cfg.ui.fx, hit: { ...H, enabled: hitEnabled } } },
    server: { personas },
    fx,
    addLinePicker: (fn) => {
      pickers.push(fn);
      return () => {};
    },
    floorActive: () => true,
    onPauseChange: () => () => {},
    sayFor: (r, text) => said.push(text),
    line: (k, f, r) => pickers[0](k, f, r) ?? `generic:${k}`,
  };
  return { fx, ctx, listeners, audio, pickers, anims, classes, rec, said, floor };
}

test('area: with the hit area switched off in config it registers nothing', () => {
  const page = fakePage({ hitEnabled: false });
  init(page.ctx);
  assert.equal(page.pickers.length, 0);
  assert.equal(page.listeners.length, 0);
});

test('area: with the effects off it draws and plays nothing: the bus never calls it and no sound listener is armed (the persona lines stay)', () => {
  const page = fakePage({ fxChoice: false });
  init(page.ctx);
  assert.equal(page.pickers.length, 1);
  assert.equal(page.listeners.length, 0);
  page.fx.emitFx('poke', { rec: page.rec, key: 'scout', level: 4, combo: 5, x: 120, y: 120 });
  assert.equal(page.anims.length, 0);
  assert.equal(page.classes.has('squash'), true, 'the office own squash is untouched');
  assert.equal(page.audio.made.contexts, 0);
});

test('area: the sound listener exists only while 「효과음」 is on, and the AudioContext appears only on a gesture', () => {
  const page = fakePage({ sfxChoice: false });
  init(page.ctx);
  assert.equal(page.listeners.length, 0);
  page.fx.emitFx('poke', { rec: page.rec, key: 'scout', level: 1, combo: 1, x: 120, y: 120 });
  assert.equal(page.audio.made.contexts, 0, 'visual reaction only');
  assert.equal(page.anims.length, 1);
  page.fx.setSfx(true);
  assert.deepEqual(page.listeners.map((l) => l.t).sort(), ['pointerdown', 'pointerup']);
  assert.equal(page.audio.made.contexts, 0, 'switching it on does not make a context');
  page.listeners[0].fn(); // the viewer's gesture
  assert.equal(page.audio.made.contexts, 1);
  page.fx.setSfx(false);
  assert.equal(page.listeners.length, 0);
  assert.equal(page.audio.made.last.state, 'suspended');
});

test('area: a poke plays one reaction on the wrapper (the office own squash gives way), and clicks past the top level speak the persona combo line', () => {
  const page = fakePage();
  init(page.ctx);
  page.fx.emitFx('poke', { rec: page.rec, key: 'scout', level: 2, combo: 2, x: 120, y: 120 });
  assert.equal(page.anims.length, 1);
  assert.equal(page.classes.has('squash'), false);
  const first = page.anims[0];
  assert.ok(first.opts.duration > hitStopMs(2, H.types.flinch, H));
  assert.deepEqual(page.said, []);
  page.fx.emitFx('poke', { rec: page.rec, key: 'scout', level: 4, combo: 5, x: 120, y: 120 });
  assert.equal(first.cancelled, true, 'the new reaction replaces the old one');
  assert.equal(page.said.length, 1);
  assert.ok(personas.scout.lines.combo.includes(page.said[0]));
});

test('area: switching the effects off takes the running reaction away', () => {
  const page = fakePage();
  init(page.ctx);
  page.fx.emitFx('poke', { rec: page.rec, key: 'scout', level: 3, combo: 1, x: 120, y: 120 });
  const a = page.anims[0];
  assert.equal(a.cancelled, undefined);
  page.fx.setFx(false);
  assert.equal(a.cancelled, true);
});
