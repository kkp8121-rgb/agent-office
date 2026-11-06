// Tests of the empty-office screen's rules (web/empty-view.mjs): when a design shows, which one, and the words each design carries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VARIANTS, catPoint, queryOf, resolveEmpty, stackRooms } from '../web/empty-view.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8')).ui.empty;
const none = queryOf('');
const show = (over = {}) => resolveEmpty({ floorCount: 0, view: 'building', query: none, cfg, ...over });

test('a design shows when the whole building has no floor, in the configured design, and its rooms fit the box', () => {
  const r = show();
  assert.equal(r.show, true);
  assert.equal(r.variant, cfg.variant);
  assert.equal(cfg.variant, 'a'); // the placeholder until the owner picks
  const st = stackRooms(700, 600, [[1024, 512], [1024, 512], [1024, 170]]); // three rooms one under the other at one common width
  assert.ok(st.height <= 600 + 1e-9 && st.W <= 700, `${st.height} high, ${st.W} wide`);
  assert.deepEqual(st.rooms.map((x) => Math.round(x.w)), [Math.round(st.W), Math.round(st.W), Math.round(st.W)]);
  assert.equal(st.rooms[1].top, st.rooms[0].h);
  const areas = readFileSync(join(ROOT, 'web/areas.mjs'), 'utf8');
  assert.match(areas, /import \{ init as initFxEmpty \} from '\.\/fx-empty\.mjs';/);
  assert.match(areas, /\{ name: 'fx-empty', init: initFxEmpty \}/, 'the area that draws the screen is registered');
});

test('nothing is drawn once a floor exists', () => {
  for (const floorCount of [1, 2, 12]) assert.equal(show({ floorCount }).show, false, `${floorCount} floors`);
});

test('nothing is drawn in the single-floor views: the lobby, the boss room or a session floor', () => {
  for (const view of ['lobby', 'ceo', 'sess-1']) assert.equal(show({ view }).show, false, view);
  assert.equal(show({ view: 'lobby', query: queryOf('?debug=empty&empty=c') }).show, false, 'not even under ?debug=empty');
});

test('the query wins: ?debug=empty&empty=b draws design b, over floors too', () => {
  const q = queryOf('?debug=empty&empty=b');
  assert.deepEqual(q, { debug: 'empty', empty: 'b' });
  const r = show({ floorCount: 3, query: q });
  assert.equal(r.show, true);
  assert.equal(r.variant, 'b');
  assert.equal(show({ query: queryOf('?empty=c') }).variant, cfg.variant, 'the design is chosen by the query only under ?debug=empty');
});

test('an unknown value falls back to the configured design, then to the first', () => {
  assert.equal(show({ query: queryOf('?debug=empty&empty=z') }).variant, cfg.variant);
  assert.equal(show({ query: queryOf('?debug=empty') }).variant, cfg.variant);
  assert.equal(show({ cfg: { ...cfg, variant: 'q' } }).variant, VARIANTS[0]);
  assert.deepEqual(catPoint([1, 2], []), [1, 2]);
  assert.deepEqual(catPoint(null, [{ id: 'lounge', at: [3, 4] }]), [3, 4], 'no configured place: the scene lounge spot');
  assert.equal(catPoint('x', [{ id: 'plant', at: [5, 6] }]), null);
});

test('every design carries the fixed text', () => {
  assert.equal(cfg.text, '터미널이나 데스크톱 앱에서 Claude Code·Codex를 켜면 첫 직원이 출근합니다');
  for (const v of VARIANTS) {
    const r = show({ query: queryOf(`?debug=empty&empty=${v}`) });
    assert.ok(r.lines.includes(cfg.text), `design ${v}`);
    assert.ok(r.lines.every((l) => typeof l === 'string' && l.length > 0), `design ${v} has no empty line`);
  }
  assert.deepEqual(show({ query: queryOf('?debug=empty&empty=c') }).lines, [cfg.cardTitle, cfg.text, ...cfg.cardSteps]);
});
