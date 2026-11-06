// The registry of effects areas (web/areas.mjs): an entry that is deleted must make a test fail, because a deleted entry silently switches a whole feature off.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AREAS, SERVER_EVENTS } from '../web/areas.mjs';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');

// every area, in start order (an area may rely on one before it); add a line here together with the entry in web/areas.mjs
const EXPECTED = ['fx-weather', 'fx-chars', 'fx-events', 'fx-led', 'fx-hit', 'officelife', 'incidents', 'fx-handoff', 'cost', 'fx-conflict', 'fx-actor', 'bell-floor'];

test('the registry lists exactly the known areas in start order, each with an init function', () => {
  assert.deepEqual(AREAS.map((a) => a.name), EXPECTED);
  assert.equal(new Set(AREAS.map((a) => a.name)).size, AREAS.length, 'no area twice');
  for (const a of AREAS) assert.equal(typeof a.init, 'function', a.name);
  assert.equal(new Set(AREAS.map((a) => a.init)).size, AREAS.length, 'no init registered under two names');
});

test('every module of web/ that exports an area init (init(ctx) or initCost) is registered', () => {
  const registered = new Set(AREAS.map((a) => a.init));
  const found = [];
  for (const file of readdirSync(WEB).filter((n) => n.endsWith('.mjs') && n !== 'areas.mjs')) {
    const text = readFileSync(join(WEB, file), 'utf8');
    if (/^export function (init|initCost)\(ctx\)/m.test(text)) found.push(file);
  }
  assert.ok(found.length >= EXPECTED.length - 1, `found ${found.join(', ')}`);
  const importLines = readFileSync(join(WEB, 'areas.mjs'), 'utf8');
  for (const file of found) assert.ok(importLines.includes(`'./${file}'`), `${file} exports an area init but areas.mjs does not import it`);
  assert.equal(registered.size, AREAS.length);
});

test('the server events relayed to the areas are the four of 1.1', () => {
  assert.deepEqual([...SERVER_EVENTS].sort(), ['compact', 'conflict', 'cost', 'handoff']);
});
