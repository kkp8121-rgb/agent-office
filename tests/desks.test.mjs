// Tests of the seated pose at desks: the lower legs of seated figures under open tables (scripts/make-leg-sprites.mjs, scene seat.legs, style.css "desks"),
// the lobby desks (monitor and laptop backs in the middle, the figure sits behind), and the chair base of the open table's chair.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePng, encodePng, SPRITES } from '../scripts/make-lit-sprites.mjs';
import { LEGS_DIR, LEGS_ROWS, legSources, legsFile, legsOf } from '../scripts/make-leg-sprites.mjs';
import { checkSceneFormat, resolveScene } from '../web/scene.mjs';
import { FORMAT_OPTS, fixtureRaw } from './helpers/fixture.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const app = readFileSync(join(ROOT, 'web', 'app.mjs'), 'utf8');
const css = readFileSync(join(ROOT, 'web', 'style.css'), 'utf8');
const scene = (name) => JSON.parse(readFileSync(join(ROOT, 'assets', 'scenes', name, 'scene.json'), 'utf8'));
const atlas = (name) => decodePng(readFileSync(join(ROOT, 'assets', 'scenes', name, 'objects.png')));
const alphaAt = (im, x, y) => im.rgba[(y * im.w + x) * 4 + 3];

// ---- the legs pictures ----

test('legs: every seated picture (but the cat) has a legs picture that is what legsFile makes', () => {
  const sources = legSources();
  assert.ok(sources.length >= 30, `${sources.length} seated pictures`);
  assert.equal(sources.some((n) => n.startsWith('cat-')), false);
  const have = readdirSync(LEGS_DIR).filter((n) => n.endsWith('-legs.png')).sort();
  assert.deepEqual(have, sources.map((n) => n.replace('-sit.png', '-legs.png')).sort(), 'one legs picture per seated picture, no strays');
  for (const name of sources) {
    const want = legsFile(name);
    const got = decodePng(readFileSync(join(LEGS_DIR, name.replace('-sit.png', '-legs.png'))));
    assert.equal(got.w, want.w, `${name}: as wide as the seated picture`);
    assert.equal(got.h, LEGS_ROWS, `${name}: ${LEGS_ROWS} rows`);
    assert.ok(Buffer.from(got.rgba).equals(Buffer.from(want.rgba)), `${name}: not what make-leg-sprites.mjs draws now (run it again)`);
    assert.deepEqual(got.w, decodePng(readFileSync(join(SPRITES, name))).w);
  }
});

test('legs: the soles are on the last row, the pixels come from the standing picture, nothing outside the picture', () => {
  for (const name of legSources()) {
    const key = name.replace('-sit.png', '');
    const legs = decodePng(readFileSync(join(LEGS_DIR, `${key}-legs.png`)));
    const stand = decodePng(readFileSync(join(SPRITES, `${key}.png`)));
    const colours = new Set();
    for (let i = 0; i < stand.rgba.length; i += 4) if (stand.rgba[i + 3] > 40) colours.add(`${stand.rgba[i]},${stand.rgba[i + 1]},${stand.rgba[i + 2]},${stand.rgba[i + 3]}`);
    let last = 0;
    let opaque = 0;
    for (let y = 0; y < legs.h; y++) {
      for (let x = 0; x < legs.w; x++) {
        if (alphaAt(legs, x, y) === 0) continue;
        opaque++;
        if (y === legs.h - 1) last++;
        const i = (y * legs.w + x) * 4;
        assert.ok(colours.has(`${legs.rgba[i]},${legs.rgba[i + 1]},${legs.rgba[i + 2]},${legs.rgba[i + 3]}`), `${key}: pixel ${x},${y} is not a colour of the standing picture`);
      }
    }
    assert.ok(last >= 3, `${key}: the soles are on the last row (${last} pixels)`);
    assert.ok(opaque >= 60, `${key}: ${opaque} pixels of legs`);
  }
});

test('legs: legsOf moves each leg of the standing picture under the matching knee of the seated one', () => {
  const px = (w, h, f) => {
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const c = f(x, y); if (c) rgba.set([...c, 255], (y * w + x) * 4); }
    return { w, h, rgba };
  };
  // standing: 20 wide, 40 high, legs (rows 30..39) at cols 6..8 (red) and 11..13 (blue) with a gap between, a body above
  const stand = px(20, 40, (x, y) => (y < 30 ? (x >= 5 && x <= 14 ? [100, 100, 100] : null) : x >= 6 && x <= 8 ? [255, 0, 0] : x >= 11 && x <= 13 ? [0, 0, 255] : null));
  // seated: 30 wide, 20 high, thighs end on the last row between cols 4 and 25 (knees at 27% / 73% of that span)
  const sit = px(30, 20, (x, y) => (x >= 4 && x <= 25 ? [90, 90, 90] : null));
  const legs = legsOf(stand, sit);
  assert.equal(legs.w, 30);
  assert.equal(legs.h, LEGS_ROWS);
  const colsOf = (r, g, b) => {
    const cols = new Set();
    for (let y = 0; y < legs.h; y++) for (let x = 0; x < legs.w; x++) { const i = (y * legs.w + x) * 4; if (legs.rgba[i + 3] && legs.rgba[i] === r && legs.rgba[i + 1] === g && legs.rgba[i + 2] === b) cols.add(x); }
    return [...cols];
  };
  const red = colsOf(255, 0, 0);
  const blue = colsOf(0, 0, 255);
  const mid = (xs) => (Math.min(...xs) + Math.max(...xs)) / 2;
  assert.ok(Math.abs(mid(red) - (4 + 21 * 0.27)) <= 1, `left leg under the left knee (${mid(red)})`);
  assert.ok(Math.abs(mid(blue) - (4 + 21 * 0.73)) <= 1, `right leg under the right knee (${mid(blue)})`);
  assert.ok(Math.max(...red) < Math.min(...blue), 'the legs keep their sides');
  for (let x = 0; x < legs.w; x++) assert.ok(alphaAt(legs, x, legs.h - 1) === 0 || red.includes(x) || blue.includes(x), 'the last row is the soles only');
});

// ---- the scene data ----

test('scene: seat.legs is a whole number from 0 up; resolveScene hands it on (0 when absent)', () => {
  const bad = (v) => { const raw = fixtureRaw(); raw.kinds.desk.seat.legs = v; return checkSceneFormat(raw, FORMAT_OPTS); };
  assert.deepEqual(bad(26), []);
  assert.deepEqual(bad(0), []);
  for (const v of [-1, 2.5, '26', null]) assert.ok(bad(v).some((e) => /seat\.legs/.test(e)), String(v));
  const raw = fixtureRaw();
  assert.ok(resolveScene(raw).seats.every((s) => s.legs === 0));
  raw.kinds.desk.seat.legs = 26;
  assert.ok(resolveScene(raw).seats.every((s) => s.legs === 26));
});

test('scenes: the open tables show legs (greenhouse desk, lounge desk), the desks with a front panel do not', () => {
  const sole = (design, kind) => scene(design).kinds[kind].seat.legs ?? 0;
  assert.equal(sole('greenhouse', 'desk'), 30);
  assert.equal(sole('lounge', 'desk'), 26);
  for (const [design, kind] of [['greenhouse', 'lead-desk'], ['lounge', 'lead-desk'], ['library', 'desk'], ['library', 'lead-desk'], ['studio2', 'desk'], ['studio2', 'lead-desk'], ['lobby', 'desk'], ['lobby', 'desk-b']]) {
    assert.equal(scene(design).kinds[kind]?.seat?.legs ?? 0, 0, `${design}/${kind} has a front panel`);
  }
});

test('greenhouse: the chairs of the open desks are chair-open (taller, the star base lowered), the lead desk keeps its chair', () => {
  const raw = scene('greenhouse');
  const open = raw.objects.filter((o) => o.kind === 'chair-open');
  assert.equal(open.length, 12);
  assert.equal(raw.objects.filter((o) => o.kind === 'chair').length, 1);
  const k = raw.kinds['chair-open'];
  const old = raw.kinds.chair;
  assert.deepEqual([k.rect[0], k.rect[1], k.rect[2]], [old.rect[0], old.rect[1], old.rect[2]]);
  assert.ok(k.rect[3] > old.rect[3], 'taller');
  assert.deepEqual(k.anchor, old.anchor, 'same anchor: the seat does not move');
  assert.deepEqual(k.footprint, old.footprint);
  const im = atlas('greenhouse');
  const [x, y, w, h] = k.rect;
  assert.ok(x + w <= im.w && y + h <= im.h, 'inside the atlas');
  let low = -1;
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) if (alphaAt(im, x + c, y + r) > 40) low = r;
  assert.ok(low >= h - 3, `the wheels reach the bottom rows (lowest ${low} of ${h})`);
  // a stem of 5 pixels joins the seat to the base: the same columns are opaque in every row between the seat and the base arms
  for (let r = 34; r < 44; r++) for (let c = 16; c <= 19; c++) assert.ok(alphaAt(im, x + c, y + r) > 40, `stem row ${r} col ${c}`);
});

// ---- the lounge desk ----

test('lounge art: the monitor back stands in front of the seat (between the viewer and the figure), the plant moved to the old monitor place', () => {
  const im = atlas('lounge');
  const raw = scene('lounge');
  const k = raw.kinds.desk;
  const [rx, ry, rw, rh] = k.rect;
  const seatX = k.anchor[0] + k.seat.sitAt[0]; // the figure's column inside the desk picture
  const grey = (x, y) => {
    const i = ((ry + y) * im.w + rx + x) * 4;
    return im.rgba[i + 3] > 40 && im.rgba[i] < 60 && im.rgba[i + 1] < 62 && im.rgba[i + 2] < 50 && im.rgba[i + 1] >= im.rgba[i] - 2; // the monitor's black-grey body
  };
  let a = rw;
  let b = -1;
  for (let y = 0; y < rh - 15; y++) for (let x = 0; x < rw; x++) if (grey(x, y)) { a = Math.min(a, x); b = Math.max(b, x); }
  assert.ok(a <= seatX - 8 && b >= seatX, `the monitor columns ${a}..${b} cover the seat column ${seatX} from the viewer's side`);
  for (let y = 4; y < 34; y++) for (let x = 24; x < 40; x++) assert.equal(grey(x, y) && x < 30, false, `nothing grey stays at the old monitor place (${x},${y})`);
  // the lounge decor slots follow: every monitor slot lies on the monitor, none on the old place
  const slots = JSON.parse(readFileSync(join(ROOT, 'assets', 'decor', 'decor.json'), 'utf8')).desks.lounge.desk;
  for (const [x] of [...slots.monitorTop, ...slots.bezel]) assert.ok(x >= a && x <= b, `monitor slot at x ${x} lies within ${a}..${b}`);
});

// ---- the lobby desks ----

test('lobby art: the monitor back and the laptop lid stand in the middle of their desks, nothing stays at the old places', () => {
  const im = atlas('lobby');
  const raw = scene('lobby');
  const darkBox = (x0, y0, w, h) => {
    let a = w;
    let b = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 20; x < 58; x++) { // between the things lying on the desk top (the notebook on the left, the mug on the right)
        const i = ((y0 + y) * im.w + x0 + x) * 4;
        if (im.rgba[i + 3] > 40 && im.rgba[i] < 100 && im.rgba[i + 1] < 100) { a = Math.min(a, x); b = Math.max(b, x); }
      }
    }
    return [a, b];
  };
  const [bx, by, bw, bh] = raw.kinds['desk-b'].rect;
  const [b0, b1] = darkBox(bx, by, bw, 5);
  assert.ok(Math.abs((b0 + b1) / 2 - bw / 2) <= 2, `desk-b monitor centre ${(b0 + b1) / 2} of ${bw}`);
  for (let y = 0; y < 7; y++) for (let x = 54; x <= 72; x++) assert.equal(alphaAt(im, bx + x, by + y), 0, `desk-b: nothing floats above the desk top at the old monitor place (${x},${y})`);
  const [dx, dy, dw] = raw.kinds.desk.rect;
  const [l0, l1] = darkBox(dx, dy, dw, 7);
  assert.ok(Math.abs((l0 + l1) / 2 - dw / 2) <= 2, `desk lid centre ${(l0 + l1) / 2} of ${dw}`);
  assert.deepEqual(raw.kinds.desk.rect.slice(2), [76, 31]);
  assert.equal(raw.kinds.desk.anchor[1], 30, 'the sprite grew 4 rows upward, its front edge stays where it was');
  // the lid and the monitor wear no screen: no bright or blue pixel on them
  for (const [x0, y0] of [[dx + 29, dy + 2], [bx + 29, by]]) {
    for (let y = 0; y < 9; y++) {
      for (let x = 0; x < 18; x++) {
        const i = ((y0 + y) * im.w + x0 + x) * 4;
        if (im.rgba[i + 3] < 40) continue;
        const [r, g, b] = [im.rgba[i], im.rgba[i + 1], im.rgba[i + 2]];
        assert.ok(!(b > 120 && b > r + 30) && Math.min(r, g, b) <= 200, `a screen-coloured pixel at ${x0 + x},${y0 + y}`);
      }
    }
  }
});

test('lobby: the chair stands behind the seated figure (front of its footprint above the seat), every desk of both kinds', () => {
  const raw = scene('lobby');
  const byId = new Map(raw.objects.map((o) => [o.id, o]));
  for (const id of raw.seats) {
    const desk = byId.get(id);
    const chair = byId.get(`chair-${id.split('-')[1]}`);
    const seat = raw.kinds[desk.kind].seat;
    assert.equal(chair.at[0], desk.at[0]);
    assert.equal(chair.at[1], desk.at[1] + seat.at[1] - 2, `${id}: chair front 2px behind the seat's standing point`);
  }
});

// ---- the page ----

test('page: a seat with legs gets them from the scene through setLegs; a lead, a stander and a character without a seated picture never', () => {
  assert.match(app, /const legs = canSit && av\.key !== 'lead' \? r\.seats\[s\.i\]\?\.legs \?\? 0 : 0;/);
  assert.match(app, /seat: \{ at: \[s\.x, s\.y\], sit: canSit \? s\.sit : null, approach: s\.approach, legs \}/);
  assert.match(app, /setLegs\(rec, target\.seat\?\.legs \?\? 0\);/);
  const fn = app.slice(app.indexOf('function setLegs('), app.indexOf('/** Stand up or sit down'));
  assert.match(fn, /rec\.sitImg !== null \? sole : 0/);
  assert.doesNotMatch(fn, /createElement|\bel\(|append\(/, 'no element is added: the legs are a CSS background');
  assert.match(fn, /--dk-legs/);
  assert.match(fn, /classList\.toggle\('dk-open', want > 0\)/);
});

test('page: the legs are drawn only while sitting, behind the seated picture, and the contact shadow moves to the soles (module prefix dk-)', () => {
  assert.match(css, /\.ag\.sitting\.dk-open \.spr\s*\{\s*isolation: isolate;/);
  assert.match(css, /\.ag\.sitting\.dk-open \.spr::before \{[^}]*z-index: -1;[^}]*var\(--dk-legs\)/s);
  assert.match(css, /top: calc\(100% \+ var\(--dk-sole\) - 30px\); height: 30px;/);
  assert.match(css, /\.ag\.sitting\.dk-open \.body::before \{ bottom: calc\(-2px - var\(--dk-sole\)\); \}/);
  assert.doesNotMatch(css, /(^|\n)\.legs-open|\.open-table/, 'no bare class name');
  assert.ok(LEGS_ROWS === 30, 'the CSS height is the pictures height');
});

test('lobby: a seated figure stands up to stroll and sits down again; the stroll route goes sit -> standing point -> aisle and back', () => {
  const route = app.slice(app.indexOf('function strollRoute('), app.indexOf('function lobbyStroll('));
  assert.match(route, /const pts = out \? \[from, \.\.\.\(via \? \[at, via\] : \[\]\)\] : \[from\];/);
  assert.match(route, /if \(!out && via\) pts\.push\(at, rest\);/);
  const stroll = app.slice(app.indexOf('function lobbyStroll('), app.indexOf('/** A walk leaves the time'));
  assert.match(stroll, /setPose\(rec, false, true\)/);
  const back = app.slice(app.indexOf('function strollBack('), app.indexOf('/** Back at the desk at once'));
  assert.match(back, /setPose\(rec, rec\.home\.sits, true\)/);
  const abort = app.slice(app.indexOf('function abortStroll('), app.indexOf('/** Starts the clock'));
  assert.match(abort, /placeAt\(rec, rec\.home\.rest, false\)/);
  assert.match(abort, /setPose\(rec, rec\.home\.sits, false\)/);
  const cfg = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8')).ui.lobby.life;
  assert.deepEqual(cfg.fidgets.seated, ['look', 'lean', 'stretch'], 'a seated figure fidgets like the floors');
});
