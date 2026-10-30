import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fitZoom } from '../web/pip.mjs';

test('pip: fitZoom scales the widest floor down to the room and never up', () => {
  assert.equal(fitZoom(408, 1024), String(408 / 1024));
  assert.equal(fitZoom(1024, 1024), '');
  assert.equal(fitZoom(1500, 1024), '');
  assert.equal(fitZoom(-5, 1024), '0');
  assert.equal(fitZoom(300, 0), '');
});

test('pip: config.json gives the small window a positive size', () => {
  const { width, height } = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8')).ui.pip;
  assert.ok(width > 0 && height > 0);
});
