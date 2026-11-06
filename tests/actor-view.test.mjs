// Tests of the "actor" marks (web/actor-view.mjs): the model band (feature 17), the paper pile (18) and the hourglass (19).
// Pure rules only; the DOM part (web/fx-actor.mjs) is checked by the headless captures of the package report.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import config from '../config.json' with { type: 'json' };
import { bandOf, createTicker, deskOf, glassPlan, hourglassText, lumaGap, pileAnchor, pilePlan } from '../web/actor-view.mjs';

const { badge, pile, hourglass } = config.ui;
const MODELS = ['opus', 'sonnet', 'haiku', 'other', 'codex'];

// ---------- model band (4) ----------

test('the band takes the light or the dark colour of the model', () => {
  for (const m of MODELS) {
    assert.equal(bandOf(badge, m, false).color, badge.colors[m].light);
    assert.equal(bandOf(badge, m, true).color, badge.colors[m].dark);
  }
  assert.notEqual(bandOf(badge, 'opus', false).color, bandOf(badge, 'opus', true).color);
});

test('the band label is the ui.badge.labels text of the model', () => {
  assert.deepEqual(MODELS.map((m) => bandOf(badge, m, false).label), ['Opus', 'Sonnet', 'Haiku', '기타 모델', 'Codex']);
  assert.equal(bandOf(badge, 'codex', true).label, badge.labels.codex);
});

test('no model draws no band (null, and a model the table does not know)', () => {
  assert.equal(bandOf(badge, null, false), null);
  assert.equal(bandOf(badge, undefined, true), null);
  assert.equal(bandOf(badge, 'gpt', false), null);
});

test('every band colour keeps ui.badge.minLumaGap from the tag paper in both themes', () => {
  const css = readFileSync(new URL('../web/style.css', import.meta.url), 'utf8');
  const papers = [...css.matchAll(/--paper:\s*(#[0-9a-f]{6})/gi)].map((m) => m[1]);
  const paper = { light: papers[0], dark: papers[1] };
  assert.ok(paper.light && paper.dark);
  for (const m of MODELS) {
    assert.ok(lumaGap(badge.colors[m].light, paper.light) >= badge.minLumaGap, `${m} light`);
    assert.ok(lumaGap(badge.colors[m].dark, paper.dark) >= badge.minLumaGap, `${m} dark`);
  }
  assert.equal(Math.round(lumaGap('#000000', '#ffffff')), 255);
});

test('the five band colours differ pairwise by ui.badge.minLumaGap in relative luminance, light and dark separately', () => {
  for (const theme of ['light', 'dark']) {
    for (let i = 0; i < MODELS.length; i++) {
      for (let j = i + 1; j < MODELS.length; j++) {
        const gap = lumaGap(badge.colors[MODELS[i]][theme], badge.colors[MODELS[j]][theme]);
        assert.ok(gap >= badge.minLumaGap, `${MODELS[i]} vs ${MODELS[j]} ${theme}: ${gap.toFixed(1)}`);
      }
    }
  }
});

// ---------- paper pile (3) ----------

test('the pile offset is chosen by room design, null draws nothing, a flipped desk mirrors dx', () => {
  const cfg = { ...pile, offset: { studio2: [-14, -27], lounge: null } };
  assert.deepEqual(pilePlan({ pile: 2, design: 'studio2', fxOn: true }, cfg).draw, { level: 2, offset: [-14, -27], wobble: false });
  assert.equal(pilePlan({ pile: 2, design: 'lounge', fxOn: true }, cfg).draw, null);
  assert.equal(pilePlan({ pile: 2, design: 'unknown', fxOn: true }, cfg).draw, null);
  assert.equal(pilePlan({ pile: 0, design: 'studio2', fxOn: true }, cfg).draw, null);
  assert.deepEqual(pileAnchor({ at: [100, 200], flipX: false }, [-14, -27]), [86, 173]);
  assert.deepEqual(pileAnchor({ at: [100, 200], flipX: true }, [-14, -27]), [114, 173]);
});

test('with the effects off no pile is drawn and only stage 4 puts its words in the tag title', () => {
  const cfg = { ...pile, offset: { studio2: [-14, -27] } };
  for (let level = 0; level <= 4; level++) {
    const off = pilePlan({ pile: level, design: 'studio2', fxOn: false }, cfg);
    assert.equal(off.draw, null);
    assert.equal(off.title, level === 4 ? '곧 넘침' : '');
    assert.equal(pilePlan({ pile: level, design: 'studio2', fxOn: true }, cfg).title, ''); // a picture shows it
  }
});

test('only stage 4 wobbles', () => {
  const cfg = { ...pile, offset: { studio2: [-14, -27] } };
  const wobble = [1, 2, 3, 4].map((level) => pilePlan({ pile: level, design: 'studio2', fxOn: true }, cfg).draw.wobble);
  assert.deepEqual(wobble, [false, false, false, true]);
  assert.equal(pilePlan({ pile: 9, design: 'studio2', fxOn: true }, cfg).draw.level, 4); // clamped
  const scene = { lead: { deskId: 'lead-desk' }, seats: [{ deskId: 'desk-1' }, { deskId: 'desk-2' }], objects: [{ id: 'desk-2', at: [1, 2] }, { id: 'lead-desk', at: [3, 4] }] };
  assert.equal(deskOf(scene, 'lead', undefined).id, 'lead-desk');
  assert.equal(deskOf(scene, 'a1', { kind: 'seat', i: 1 }).id, 'desk-2');
  assert.equal(deskOf(scene, 'a2', { kind: 'overflow', i: 3 }), null); // no seat, no desk, no pile
});

// ---------- hourglass (5) ----------

test('the time text for 59 s, 61 s and 3601 s', () => {
  assert.equal(hourglassText(hourglass, 59), '0분 59초');
  assert.equal(hourglassText(hourglass, 61), '1분 1초');
  assert.equal(hourglassText(hourglass, 3601), '1시간 0분');
  assert.equal(hourglassText(hourglass, 7384), '2시간 3분');
});

test('the time counts from the server clock and never goes negative', () => {
  const at = (nowMs) => glassPlan({ slowSince: 1_000_000, nowMs, call: null, rest: null, fxOn: true }, hourglass);
  assert.equal(at(1_000_000 + 61_000).text, '1분 1초');
  assert.equal(at(999_000).text, '0분 0초');
  assert.equal(glassPlan({ slowSince: null, nowMs: 5, call: null, rest: null, fxOn: true }, hourglass), null);
});

test('a floor with a bell or a lunch break hides the hourglass', () => {
  const base = { slowSince: 0, nowMs: 90_000, fxOn: true };
  assert.ok(glassPlan({ ...base, call: null, rest: null }, hourglass));
  assert.equal(glassPlan({ ...base, call: 'ask', rest: null }, hourglass), null);
  assert.equal(glassPlan({ ...base, call: null, rest: { until: 5, limitKind: 'five_hour' } }, hourglass), null);
});

test('with the effects off the hourglass is a still picture and keeps its time text', () => {
  const on = glassPlan({ slowSince: 0, nowMs: 90_000, call: null, rest: null, fxOn: true }, hourglass);
  const off = glassPlan({ slowSince: 0, nowMs: 90_000, call: null, rest: null, fxOn: false }, hourglass);
  assert.equal(on.spin, true);
  assert.equal(off.spin, false);
  assert.equal(off.text, on.text);
  assert.equal(off.text, '1분 30초');
});

test('floor timers equal the visible floors with an hourglass', () => {
  /** The office's timers, by hand: a timer is {fn, ms, floorId}; the test fires them. */
  const timers = {
    live: new Map(),
    n: 0,
    setTimeout(fn, ms, floorId = '_') {
      this.live.set(++this.n, { fn, ms, floorId });
      return this.n;
    },
    clearTimeout(token) {
      this.live.delete(token);
    },
    fire(floorId) { // like the office: a timer that fires is gone before its function runs
      const [token, t] = [...this.live].find(([, x]) => x.floorId === floorId);
      this.live.delete(token);
      t.fn();
    },
    byFloor() {
      const by = {};
      for (const t of this.live.values()) by[t.floorId] = (by[t.floorId] ?? 0) + 1;
      return by;
    },
  };
  const floors = { a: { shown: true, glass: 2 }, b: { shown: true, glass: 0 }, c: { shown: false, glass: 1 }, d: { shown: true, glass: 1 } };
  const ran = [];
  const wanted = () => Object.keys(floors).filter((id) => floors[id].shown && floors[id].glass > 0);
  const ticker = createTicker({ timers, tickMs: hourglass.tickMs, ids: wanted, run: (id) => ran.push(id) });
  ticker.sync();
  assert.deepEqual(timers.byFloor(), { a: 1, d: 1 }); // one per floor, only the shown ones with an hourglass
  assert.equal(ticker.count(), wanted().length);
  assert.ok([...timers.live.values()].every((t) => t.ms === hourglass.tickMs));
  ticker.sync(); // nothing new arms twice
  assert.deepEqual(timers.byFloor(), { a: 1, d: 1 });
  floors.c.shown = true; // a floor came on screen
  floors.a.glass = 0; // the slow command of another ended
  ticker.sync();
  assert.deepEqual(timers.byFloor(), { c: 1, d: 1 });
  timers.fire('d'); // a tick: refresh that floor, chain the next one
  assert.deepEqual(ran, ['d']);
  assert.deepEqual(timers.byFloor(), { c: 1, d: 1 });
  floors.c.shown = floors.d.shown = false; // everything hidden: nothing keeps running
  ticker.sync();
  assert.deepEqual(timers.byFloor(), {});
});
