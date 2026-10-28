import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MAX_LEN, clip } from '../server/sanitize.mjs';
import { parseLine } from '../server/parse.mjs';

const config = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
const nameMax = config.parse?.nameMaxChars;
const pathMax = config.parse?.pathMaxChars;

test('limits: MAX_LEN is log.headMaxChars and clip honours it', () => {
  assert.equal(MAX_LEN, config.log.headMaxChars);
  const out = clip('가'.repeat(MAX_LEN + 5), MAX_LEN);
  assert.equal(Array.from(out).length, MAX_LEN);
  assert.ok(out.endsWith('…'));
});

test('limits: parse name and path limits come from config.parse', () => {
  assert.equal(typeof nameMax, 'number');
  assert.equal(typeof pathMax, 'number');
  const title = parseLine(JSON.stringify({ type: 'ai-title', aiTitle: 'a'.repeat(nameMax + 50) }));
  assert.equal(Array.from(title[0].title).length, nameMax);
  const launch = (len) => parseLine(JSON.stringify({
    type: 'user', timestamp: '2026-10-28T00:00:00Z', message: { content: [] },
    toolUseResult: { taskType: 'local_workflow', runId: 'r', workflowName: 'w', scriptPath: 'p'.repeat(len) },
  }))[0].scriptPath;
  assert.equal(launch(pathMax).length, pathMax);
  assert.equal(launch(pathMax + 1), '');
});
