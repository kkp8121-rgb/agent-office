// New Claude signals of the parser: usage, ctx, compact, limit, same-file keys, model. Fixtures are synthetic
// (tests/fixtures/signals); the private-looking text inside them must never reach an event.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import config from '../config.json' with { type: 'json' };
import { claudeUsage, parseLine, setFileKeySalt } from '../server/parse.mjs';
import { fileKey } from '../server/filekey.mjs';

const lines = (name) => readFileSync(new URL(`./fixtures/signals/${name}.jsonl`, import.meta.url), 'utf8').split('\n').filter(Boolean);
const T = (iso) => Date.parse(iso);
const keys = (o) => Object.keys(o).sort();
const kind = (evs, k) => evs.filter((e) => e.kind === k);
const FORBIDDEN = ['SECRET', 'sk-', 'tok-', 'https://', 'toolu_', 'Users\\'];
const noLeak = (evs, extra = []) => {
  const s = JSON.stringify(evs);
  for (const bad of [...FORBIDDEN, ...extra]) assert.ok(!s.includes(bad), `"${bad}" is in ${s}`);
};

const SALT = Buffer.from('fixed-test-salt-');
setFileKeySalt(SALT);
const OPTS = { maxChars: config.conflict.maxPathChars, hashChars: config.conflict.hashChars };
const HEX = new RegExp(`^[0-9a-f]{${config.conflict.hashChars}}$`);

// ---- usage ------------------------------------------------------------------------------------

test('same message.id on three lines gives the same msgId', () => {
  const usages = lines('claude-usage').slice(0, 3).flatMap((l) => kind(parseLine(l), 'usage'));
  assert.equal(usages.length, 3);
  assert.deepEqual(usages.map((u) => u.msgId), ['msg_a1', 'msg_a1', 'msg_a1']);
  assert.deepEqual(usages.map((u) => u.tokens), [35, 35, 35]);
});

test('a string token count counts as 0', () => {
  const [u] = kind(parseLine(lines('claude-usage')[3]), 'usage');
  assert.equal(u.msgId, 'msg_a2');
  assert.equal(u.tokens, 0 + 3 + 4); // input_tokens "12" is a string
  assert.equal(u.cacheRead, 7);
});

test('a <synthetic> model gives no usage', () => {
  const line = lines('claude-usage')[4];
  assert.equal(kind(parseLine(line), 'usage').length, 0);
  assert.equal(claudeUsage(JSON.parse(line)), null);
});

test('usage keys are exactly kind ts msgId tokens cacheRead and tokens leave cache reads out', () => {
  const line = lines('claude-usage')[0];
  const [u] = kind(parseLine(line), 'usage');
  assert.deepEqual(keys(u), ['cacheRead', 'kind', 'msgId', 'tokens', 'ts']);
  assert.deepEqual(u, { kind: 'usage', ts: T('2026-11-06T09:00:00.000Z'), msgId: 'msg_a1', tokens: 10 + 20 + 5, cacheRead: 400 });
  const direct = claudeUsage(JSON.parse(line));
  assert.deepEqual(keys(direct), ['cacheRead', 'msgId', 'tokens', 'ts']);
  assert.equal(direct.tokens, 35); // 435 would mean the cache read was added
});

// ---- compact and limit ------------------------------------------------------------------------

test('compact_boundary keys are exactly kind ts trigger durationMs', () => {
  const evs = parseLine(lines('claude-system')[0]);
  assert.equal(evs.length, 1);
  assert.deepEqual(keys(evs[0]), ['durationMs', 'kind', 'trigger', 'ts']);
  assert.deepEqual(evs[0], { kind: 'compact', ts: T('2026-11-06T09:20:00.000Z'), trigger: 'auto', durationMs: 4200 });
});

test('an unknown trigger folds to other', () => {
  const [weird] = parseLine(lines('claude-system')[1]);
  assert.equal(weird.trigger, 'other');
  assert.equal(weird.durationMs, null);
  const [manual] = parseLine(lines('claude-system')[2]);
  assert.equal(manual.trigger, 'manual');
  assert.equal(manual.durationMs, null); // "slow" is not a number
});

test('the summary text never reaches the event', () => {
  const evs = lines('claude-system').slice(0, 3).flatMap(parseLine);
  assert.equal(evs.length, 3);
  noLeak(evs, ['compacted', 'Conversation']);
});

test('rate_limit gives limit with resetsAt seconds turned into ms', () => {
  const evs = parseLine(lines('claude-system')[3]);
  const [limit] = kind(evs, 'limit');
  assert.deepEqual(keys(limit), ['kind', 'limitKind', 'ts', 'until']);
  assert.deepEqual(limit, { kind: 'limit', ts: T('2026-11-06T09:30:00.000Z'), until: 1793350000 * 1000, limitKind: 'seven_day' });
  noLeak(evs);
});

test('server_error is not a limit', () => {
  const evs = parseLine(lines('claude-system')[4]);
  assert.equal(kind(evs, 'limit').length, 0);
  assert.equal(kind(evs, 'usage').length, 0);
  noLeak(evs);
});

test('a string resetsAt gives until null', () => {
  const [limit] = kind(parseLine(lines('claude-system')[5]), 'limit');
  assert.equal(limit.until, null);
  assert.equal(limit.limitKind, 'five_hour');
});

// ---- edited files -----------------------------------------------------------------------------

const editEvs = () => lines('claude-edits').map((l) => kind(parseLine(l), 'tool')[0]);

test('Edit has a fileKey', () => {
  const [edit] = editEvs();
  assert.match(edit.fileKey, HEX);
  assert.equal(edit.name, 'Edit');
  assert.equal(edit.fileKey, fileKey('C:\\fixture\\repo-alpha\\zeta-folder\\a.mjs', SALT, OPTS));
  assert.deepEqual(keys(edit), ['fileKey', 'kind', 'name', 'text', 'toolUseId', 'ts']);
});

test('MultiEdit has a fileKey', () => {
  const evs = editEvs();
  assert.equal(evs[1].name, 'MultiEdit');
  assert.match(evs[1].fileKey, HEX);
  assert.equal(evs[1].fileKey, evs[0].fileKey); // c:/…/a.mjs is the same file as C:\…\a.mjs
});

test('Write has a fileKey', () => {
  const evs = editEvs();
  assert.equal(evs[2].name, 'Write');
  assert.equal(evs[2].fileKey, evs[0].fileKey); // …\lib\..\zeta-folder\a.mjs is the same file again
});

test('NotebookEdit uses notebook_path', () => {
  const nb = editEvs()[3];
  assert.equal(nb.name, 'NotebookEdit');
  assert.equal(nb.fileKey, fileKey('C:\\fixture\\repo-alpha\\zeta-folder\\n.ipynb', SALT, OPTS));
  assert.notEqual(nb.fileKey, fileKey('C:\\fixture\\repo-alpha\\ignored\\x.ipynb', SALT, OPTS)); // its file_path is not the one read
});

test('Read has no fileKey', () => {
  const read = editEvs()[4];
  assert.equal(read.name, 'Read');
  assert.ok(!('fileKey' in read));
});

test('no folder name of the fixture path is in any serialized event', () => {
  const evs = [...lines('claude-edits'), ...lines('claude-usage'), ...lines('claude-models'), ...lines('claude-system')].flatMap(parseLine);
  assert.ok(kind(evs, 'tool').some((e) => e.fileKey));
  noLeak(evs, ['repo-alpha', 'zeta-folder', 'fixture', 'ignored']);
  // the SendMessage recipient rides along as sendTo; its message text does not
  const send = kind(evs, 'tool').find((e) => e.name === 'SendMessage');
  assert.equal(send.sendTo, 'worker-one');
});

// ---- model ------------------------------------------------------------------------------------

const modelOf = (i) => {
  const ctx = kind(parseLine(lines('claude-models')[i]), 'ctx');
  return ctx.length ? ctx[0].model : undefined;
};

test('opus', () => assert.equal(modelOf(0), 'opus'));
test('sonnet', () => assert.equal(modelOf(1), 'sonnet'));
test('haiku', () => assert.equal(modelOf(2), 'haiku'));
test('fable folds to other', () => assert.equal(modelOf(3), 'other'));
test('<synthetic> gives no ctx', () => assert.equal(modelOf(4), undefined));
test('mixed case gives the same model', () => assert.equal(modelOf(5), modelOf(0)));

test('ctxTokens is input plus cache creation plus cache read, window null', () => {
  const [ctx] = kind(parseLine(lines('claude-usage')[0]), 'ctx');
  assert.deepEqual(keys(ctx), ['ctxTokens', 'kind', 'model', 'ts', 'window']);
  assert.deepEqual(ctx, { kind: 'ctx', ts: T('2026-11-06T09:00:00.000Z'), ctxTokens: 10 + 20 + 400, window: null, model: 'opus' });
});
