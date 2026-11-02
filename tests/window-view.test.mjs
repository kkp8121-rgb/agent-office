import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkScene } from '../server/scene-check.mjs';
import { readPngSize } from '../server/scenes.mjs';
import { resolveScene } from '../web/scene.mjs';
import { ROOT, atlasSize, cfg, fixtureRaw } from './helpers/fixture.mjs';

const SCENES = join(ROOT, 'assets', 'scenes');
const DESIGNS = ['studio2', 'lounge', 'library', 'greenhouse'];
const shipped = (d) => JSON.parse(readFileSync(join(SCENES, d, 'scene.json'), 'utf8'));
const errorsOf = (raw) => checkScene(raw, { atlasSize, cfg }).errors;
const colourType = (file) => readFileSync(file)[25]; // IHDR colour type: 6 = RGBA

test('window view: every shipped room has one view picture per light, as big as view.size, inside the scene', () => {
  for (const d of DESIGNS) {
    const raw = shipped(d);
    const v = raw.view;
    assert.ok(v, `${d}: view`);
    for (const key of ['day', 'night']) assert.deepEqual(readPngSize(join(SCENES, d, v[key])), v.size, `${d}: ${key} picture size`);
    assert.ok(v.origin[0] >= 0 && v.origin[1] >= 0 && v.origin[0] + v.size[0] <= raw.size[0] && v.origin[1] + v.size[1] <= raw.size[1], `${d}: view box inside the scene`);
    assert.ok(v.horizon > v.origin[1] && v.horizon < v.origin[1] + v.size[1], `${d}: horizon inside the view box`);
    assert.equal(resolveScene(raw).view.horizon, v.horizon, `${d}: the resolved scene carries view`);
  }
});

test('window view: every window polygon lies inside the view box, so no pane shows anything but the view', () => {
  for (const d of DESIGNS) {
    const { view: v, windows } = shipped(d);
    for (const [i, poly] of windows.entries()) {
      for (const [x, y] of poly) assert.ok(x >= v.origin[0] && x <= v.origin[0] + v.size[0] && y >= v.origin[1] && y <= v.origin[1] + v.size[1], `${d}: windows[${i}] point ${x},${y}`);
    }
  }
});

test('window view: the shell has holes where the glass is (RGBA picture), the view sits under it', () => {
  for (const d of DESIGNS) assert.equal(colourType(join(SCENES, d, 'shell.png')), 6, `${d}: shell.png is RGBA`);
});

test('window view: the validator accepts the fixture with a view and refuses a broken one', () => {
  const ok = fixtureRaw();
  ok.view = { origin: [0, 0], size: [400, 200], day: 'a.png', night: 'b.png', horizon: 90 };
  assert.ok(!errorsOf(ok).some((e) => /view/.test(e)), errorsOf(ok).join('\n'));
  const bad = (patch) => errorsOf({ ...fixtureRaw(), view: { ...ok.view, ...patch } }).filter((e) => /view/.test(e));
  assert.ok(bad({ horizon: 500 }).length, 'horizon outside the box');
  assert.ok(bad({ size: [4000, 200] }).length, 'box outside the scene');
  assert.ok(bad({ day: '../x.png' }).length, 'a picture outside the room folder');
  assert.ok(bad({ night: 'x.jpg' }).length, 'not a PNG');
  assert.ok(bad({ origin: [1.5, 0] }).length, 'not whole pixels');
});

test('window view: a window polygon outside the view box is refused by the view box', () => {
  const raw = fixtureRaw();
  raw.windows = [[[50, 50], [80, 50], [80, 90]]];
  raw.view = { origin: [0, 0], size: [10, 10], day: 'a.png', night: 'b.png', horizon: 5 };
  assert.ok(errorsOf(raw).some((e) => /windows\[0\]/.test(e) && /view/.test(e)), errorsOf(raw).join('\n'));
});

test('window view: style.css picks the picture by data-light and paints the view under the shell with no script', () => {
  const css = readFileSync(join(ROOT, 'web', 'style.css'), 'utf8');
  assert.match(css, /\.stage\.viewed \{[^}]*background-image: var\(--shell\), var\(--view-day\)/);
  assert.match(css, /\.stage\.viewed\[data-light="night"\] \{[^}]*var\(--shell\), var\(--view-night\)/);
  assert.match(css, /\.stage\.viewed\[data-light="sunset"\] \{[^}]*linear-gradient[^}]*var\(--view-day\)/);
  const view = css.match(/\.stage\.viewed[^{]*\{[^}]*\}/g).join('\n');
  assert.doesNotMatch(view, /filter|animation|transition|blend/, 'static layers only');
  const app = readFileSync(join(ROOT, 'web', 'app.mjs'), 'utf8');
  assert.match(app, /'--view-day'/);
  assert.match(app, /'--view-night'/);
  assert.match(app, /classList\.add\('viewed'\)/);
});
