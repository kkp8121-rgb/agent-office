import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseLine } from '../server/parse.mjs';

const fx = (n) => readFileSync(new URL(`./fixtures/lines/${n}.jsonl`, import.meta.url), 'utf8').split('\n').filter(Boolean);
const T = (iso) => Date.parse(iso);

test('parse: tool_use becomes sanitized tool event', () => {
  assert.deepEqual(parseLine(fx('assistant-bash')[0]), [
    { kind: 'tool', toolUseId: 'toolu_1', name: 'Bash', text: '프론트 빌드 확인', ts: T('2026-10-28T06:48:44.441Z') },
  ]);
});

test('parse: Agent tool_use carries agentType and description', () => {
  const [ev] = parseLine(fx('assistant-agent')[0]);
  assert.equal(ev.kind, 'tool');
  assert.equal(ev.name, 'Agent');
  assert.equal(ev.agentType, 'worker');
  assert.equal(ev.description, '기록 조사');
  assert.ok(!JSON.stringify(ev).includes('SECRET-PROMPT'));
});

test('parse: tool_result becomes toolDone', () => {
  assert.deepEqual(parseLine(fx('user-result')[0]), [
    { kind: 'toolDone', toolUseId: 'toolu_1', ts: T('2026-10-28T06:48:49.000Z') },
  ]);
});

test('parse: thinking and text become think', () => {
  const [a, b] = fx('assistant-think');
  assert.deepEqual(parseLine(a), [{ kind: 'think', ts: T('2026-10-28T06:48:46.000Z') }]);
  assert.deepEqual(parseLine(b), [{ kind: 'think', ts: T('2026-10-28T06:48:47.000Z') }]);
});

test('parse: end_turn adds end', () => {
  const evs = parseLine(fx('assistant-end')[0]);
  assert.deepEqual(evs.map((e) => e.kind), ['think', 'end']);
  assert.equal(evs[1].ts, T('2026-10-28T06:48:48.000Z'));
});

test('parse: workflow launch result', () => {
  const evs = parseLine(fx('user-workflow')[0]);
  const wf = evs.find((e) => e.kind === 'workflowLaunch');
  assert.deepEqual(wf, {
    kind: 'workflowLaunch', runId: 'wf_abc', workflowName: 'review-changes', scriptPath: 'C:/x/s.js',
    ts: T('2026-10-28T06:48:50.000Z'),
  });
  assert.ok(evs.some((e) => e.kind === 'toolDone' && e.toolUseId === 'toolu_3'));
});

test('parse: ai-title', () => {
  assert.deepEqual(parseLine(fx('ai-title')[0]), [{ kind: 'title', title: '에이전트 사무실', ts: 0 }]);
});

test('parse: never leaks content', () => {
  for (const line of fx('private')) assert.deepEqual(parseLine(line), []);
  const all = [
    ...fx('user-result'), ...fx('user-workflow'), ...fx('assistant-think'), ...fx('assistant-end'), ...fx('assistant-agent'),
  ].flatMap(parseLine);
  assert.ok(!JSON.stringify(all).includes('SECRET'));
});

test('parse: malformed and unknown lines yield []', () => {
  const weird = '{"type":"assistant","message":{"content":[{"type":"tool_use","id":5,"name":null,"input":7}]}}';
  for (const l of ['{bad', '{"type":"mystery"}', '', 'null', '[]', weird]) assert.doesNotThrow(() => parseLine(l));
  assert.deepEqual(parseLine('{bad'), []);
  assert.deepEqual(parseLine('{"type":"mystery"}'), []);
  assert.deepEqual(parseLine(''), []);
});
