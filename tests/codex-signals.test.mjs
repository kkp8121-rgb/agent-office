// New Codex signals of the parser: limit, usage, ctx. Fixtures are synthetic (tests/fixtures/signals).
// A rollout's lines are read in order with one shared line state, as CodexSource does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { codexUsage, parseCodexLine } from '../server/codex.mjs';

const lines = (name) => readFileSync(new URL(`./fixtures/signals/${name}.jsonl`, import.meta.url), 'utf8').split('\n').filter(Boolean);
const T = (iso) => Date.parse(iso);
const keys = (o) => Object.keys(o).sort();
const kind = (evs, k) => evs.filter((e) => e.kind === k);
const FORBIDDEN = ['SECRET', 'sk-', 'tok-', 'https://', 'toolu_', 'Users\\'];
const noLeak = (evs, extra = []) => {
  const s = JSON.stringify(evs);
  for (const bad of [...FORBIDDEN, ...extra]) assert.ok(!s.includes(bad), `"${bad}" is in ${s}`);
};
/** All lines of a fixture read in order with a shared state -> one event list per line. */
const rollout = (name) => {
  const st = { limitUntil: null };
  return lines(name).map((l) => parseCodexLine(l, st));
};

test('usage_limit_exceeded gives limit with the full rate limit resets_at', () => {
  const evs = rollout('codex-limit');
  assert.deepEqual(kind(evs[0], 'limit'), []);
  const [limit] = kind(evs[1], 'limit');
  // only the primary window is full (100%): the secondary at 40% does not count
  assert.deepEqual(limit, { kind: 'limit', ts: T('2026-11-06T10:10:05.000Z'), until: 1793350000 * 1000, limitKind: 'other' });
  assert.deepEqual(keys(limit), ['kind', 'limitKind', 'ts', 'until']);
  assert.equal(kind(evs[1], 'end').length, 1);
  assert.equal(kind(parseCodexLine(lines('codex-limit')[1]), 'limit')[0].until, null); // no earlier rate_limits seen
});

test('server_overloaded is not a limit', () => {
  const evs = rollout('codex-limit')[2];
  assert.equal(kind(evs, 'limit').length, 0);
  assert.equal(kind(evs, 'end').length, 1);
});

test('the error message text is not in the event', () => {
  noLeak([...rollout('codex-limit'), ...rollout('codex-usage')].flat(), ['repo-alpha', 'overloaded', 'usage limit']);
});

test('a repeated response_id gives the same msgId', () => {
  const evs = rollout('codex-usage');
  assert.equal(kind(evs[0], 'usage')[0].msgId, 'resp-1');
  assert.equal(kind(evs[1], 'usage')[0].msgId, 'resp-1');
  assert.equal(codexUsage(JSON.parse(lines('codex-usage')[1])).msgId, 'resp-1');
});

test('token_count gives no usage', () => {
  const evs = rollout('codex-usage');
  assert.equal(kind(evs[4], 'usage').length, 0);
  assert.equal(codexUsage(JSON.parse(lines('codex-usage')[4])), null);
});

test('token_count gives ctx with the context window', () => {
  const [ctx] = kind(rollout('codex-usage')[4], 'ctx');
  assert.deepEqual(ctx, { kind: 'ctx', ts: T('2026-11-06T10:30:00.100Z'), ctxTokens: 1000, window: 258400, model: null });
  assert.deepEqual(keys(ctx), ['ctxTokens', 'kind', 'model', 'ts', 'window']);
});

test('token_count with info null gives nothing', () => {
  assert.deepEqual(rollout('codex-usage')[5], []);
});

test('usage tokens are input minus cached plus cache write plus output', () => {
  const evs = rollout('codex-usage');
  const [u] = kind(evs[0], 'usage');
  assert.deepEqual(u, { kind: 'usage', ts: T('2026-11-06T10:30:00.000Z'), msgId: 'resp-1', tokens: 1000 - 600 + 50 + 30, cacheRead: 600 });
  assert.deepEqual(keys(u), ['cacheRead', 'kind', 'msgId', 'tokens', 'ts']);
  assert.equal(kind(evs[2], 'usage')[0].tokens, 2000 - 1500 + 0 + 120);
  assert.equal(kind(evs[3], 'usage')[0].tokens, 500 + 40); // nothing cached
});

test('total_tokens equals input plus output on the synthetic fixtures (assumption noted)', () => {
  // Assumption behind the formula above: cached_input_tokens is part of input_tokens (so a cache read is subtracted once)
  // and reasoning tokens are part of output_tokens. It is checked on synthetic records only; real rollouts were not compared.
  for (const l of lines('codex-usage')) {
    const o = JSON.parse(l);
    if (o.type !== 'token_usage_record') continue;
    const u = o.payload.usage;
    assert.equal(u.total_tokens, u.input_tokens + u.output_tokens);
  }
});
