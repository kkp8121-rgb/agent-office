import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../server/config.mjs';
import { Office } from '../server/office.mjs';
import { Poller } from '../server/poller.mjs';

const EMPTY = { hidden: [], names: {} };
const STARTED = 1793170000000;

function fake(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'poller-'));
  mkdirSync(join(dir, 'sessions'));
  mkdirSync(join(dir, 'projects', 'P'), { recursive: true });
  const cfg = loadConfig({ agentScanEveryTicks: 1, ...overrides });
  cfg.claudeHome = dir;
  const office = new Office(cfg, EMPTY);
  const poller = new Poller(cfg, office);
  const sessionFile = join(dir, 'sessions', `${process.pid}.json`);
  const sessionJson = (startedAt) =>
    JSON.stringify({ pid: process.pid, sessionId: 's1', cwd: 'C:\\Project\\app', status: 'busy', name: '', startedAt });
  const startSession = (startedAt = STARTED) => writeFileSync(sessionFile, sessionJson(startedAt));
  startSession();
  return {
    dir, cfg, office, poller, sessionFile, startSession,
    transcript: join(dir, 'projects', 'P', 's1.jsonl'),
    subagents: join(dir, 'projects', 'P', 's1', 'subagents'),
    done: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const iso = (ms) => new Date(ms).toISOString();
const toolLine = (ms, name, input) =>
  JSON.stringify({ type: 'assistant', timestamp: iso(ms), message: { content: [{ type: 'tool_use', id: `t${ms}`, name, input }] } }) + '\n';
const workflowLine = (ms, runId, workflowName, scriptPath) =>
  JSON.stringify({ type: 'user', timestamp: iso(ms), toolUseResult: { taskType: 'local_workflow', runId, workflowName, scriptPath } }) + '\n';
const floor = (office) => office.snapshot().floors[0];
const age = (path, msAgo) => {
  const t = new Date(Date.now() - msAgo);
  utimesSync(path, t, t);
};

function agentFiles(h, id, meta, lines = '') {
  mkdirSync(h.subagents, { recursive: true });
  writeFileSync(join(h.subagents, `agent-${id}.meta.json`), JSON.stringify(meta));
  writeFileSync(join(h.subagents, `agent-${id}.jsonl`), lines);
}

test('poller: end to end on fake claude home', async () => {
  const h = fake();
  const now = Date.now();
  writeFileSync(h.transcript, toolLine(now, 'Bash', { command: 'ls', description: 'DB 마이그 확인' }));
  agentFiles(h, 'a1', { agentType: 'worker', description: '조사' }, toolLine(now, 'Read', { file_path: 'C:\\x\\x.cs' }));
  await h.poller.tick(now);
  await h.poller.tick(now + 1500);
  const f = floor(h.office);
  assert.equal(h.office.snapshot().floors.length, 1);
  assert.equal(f.lead.bubble, 'DB 마이그 확인');
  assert.equal(f.agents.length, 1);
  assert.equal(f.agents[0].name, '서진');
  assert.equal(f.agents[0].bubble, 'x.cs 읽는 중');

  const meta = join(h.subagents, 'agent-a1.meta.json');
  writeFileSync(meta, JSON.stringify({ agentType: 'worker', description: '조사', finished: true }));
  utimesSync(meta, new Date(now + 5000), new Date(now + 5000));
  await h.poller.tick(now + 3000);
  assert.equal(floor(h.office).agents[0].state, 'done');
  h.done();
});

test('poller: idle tick reads nothing new', async () => {
  const h = fake();
  const now = Date.now();
  writeFileSync(h.transcript, toolLine(now, 'Bash', { command: 'ls' }));
  agentFiles(h, 'a1', { agentType: 'worker', description: '조사' }, toolLine(now, 'Read', { file_path: 'x.cs' }));
  await h.poller.tick(now);
  assert.ok(h.poller.bytesRead > 0);
  const before = h.poller.bytesRead;
  await h.poller.tick(now + 1500);
  await h.poller.tick(now + 3000);
  assert.equal(h.poller.bytesRead, before);
  appendFileSync(h.transcript, toolLine(now + 4000, 'Bash', { command: 'pwd' }));
  await h.poller.tick(now + 4500);
  assert.ok(h.poller.bytesRead > before);
  assert.equal(floor(h.office).lead.bubble, 'pwd 실행');
  h.done();
});

test('poller: missing transcript is retried until it appears', async () => {
  const h = fake();
  const now = Date.now();
  await h.poller.tick(now); // no transcript yet: no throw, floor still exists
  assert.equal(h.office.snapshot().floors.length, 1);
  writeFileSync(h.transcript, toolLine(now, 'Bash', { command: 'ls', description: '늦게 생긴 기록' }));
  await h.poller.tick(now + 1500);
  assert.equal(floor(h.office).lead.bubble, '늦게 생긴 기록');
  h.done();
});

test('poller: transcript removed while tailing does not stop the tick', async () => {
  const h = fake();
  const now = Date.now();
  writeFileSync(h.transcript, toolLine(now, 'Bash', { command: 'ls', description: '첫 줄' }));
  await h.poller.tick(now);
  rmSync(h.transcript);
  await h.poller.tick(now + 1500);
  assert.equal(floor(h.office).lead.bubble, '첫 줄');
  h.done();
});

test('poller: an empty session list counts only after two consecutive ticks', async () => {
  const h = fake();
  const now = Date.now();
  await h.poller.tick(now);
  rmSync(h.sessionFile);
  await h.poller.tick(now + 1500);
  assert.equal(floor(h.office).status, 'busy');
  h.startSession();
  await h.poller.tick(now + 3000);
  rmSync(h.sessionFile);
  await h.poller.tick(now + 4500);
  assert.equal(floor(h.office).status, 'busy'); // the streak restarted
  await h.poller.tick(now + 6000);
  assert.equal(floor(h.office).status, 'leaving');
  h.done();
});

test('poller: forced hide survives one failed read of the session list', async () => {
  const h = fake();
  const now = Date.now();
  await h.poller.tick(now);
  assert.equal(h.office.hide('s1'), true);
  rmSync(h.sessionFile);
  await h.poller.tick(now + 1500);
  h.startSession();
  await h.poller.tick(now + 3000);
  assert.equal(h.office.snapshot().floors.length, 0);
  assert.equal(h.office.saved().hidden.length, 1);
  h.done();
});

test('poller: abandoned agents are not shown, and running ones finish after abandonMs', async () => {
  const h = fake();
  const now = Date.now();
  writeFileSync(h.transcript, '');
  const ancient = h.cfg.agent.abandonMs * 2;
  agentFiles(h, 'old', { agentType: 'worker', description: '오래된' });
  age(join(h.subagents, 'agent-old.meta.json'), ancient);
  age(join(h.subagents, 'agent-old.jsonl'), ancient);
  agentFiles(h, 'live', { agentType: 'worker', description: '진행 중' });
  await h.poller.tick(now);
  assert.deepEqual(floor(h.office).agents.map((a) => a.agentId), ['live']);

  age(join(h.subagents, 'agent-live.meta.json'), ancient);
  age(join(h.subagents, 'agent-live.jsonl'), ancient);
  await h.poller.tick(now + 1500);
  assert.equal(floor(h.office).agents[0].state, 'done');
  h.done();
});

test('poller: a recently written agent transcript keeps an old meta alive', async () => {
  const h = fake();
  const now = Date.now();
  writeFileSync(h.transcript, '');
  agentFiles(h, 'a1', { agentType: 'worker', description: '조사' });
  age(join(h.subagents, 'agent-a1.meta.json'), h.cfg.agent.abandonMs * 2);
  await h.poller.tick(now);
  assert.equal(floor(h.office).agents.length, 1);
  assert.notEqual(floor(h.office).agents[0].state, 'done');
  h.done();
});

test('poller: events older than backfillMinutes set state but are not logged', async () => {
  const h = fake();
  const now = Date.now();
  const old = now - (h.cfg.log.backfillMinutes + 5) * 60000;
  writeFileSync(
    h.transcript,
    toolLine(old, 'Bash', { command: 'ls', description: '옛 작업' }) + toolLine(now, 'Bash', { command: 'ls', description: '새 작업' }),
  );
  await h.poller.tick(now);
  assert.equal(floor(h.office).lead.bubble, '새 작업');
  assert.deepEqual(h.office.queryLog({}).map((e) => e.text), ['새 작업']);
  h.done();
});

test('poller: workflow agents finish via the journal and the board shows progress', async () => {
  const h = fake();
  const now = Date.now();
  const script = join(h.dir, 'wf.js');
  writeFileSync(script, "export const meta = { name: 'x', phases: [{ title: 'Review' }, { title: 'Verify' }] }\n");
  writeFileSync(h.transcript, workflowLine(now, 'wf_r1', 'review-changes', script));
  const run = join(h.subagents, 'workflows', 'wf_r1');
  mkdirSync(run, { recursive: true });
  writeFileSync(join(run, 'agent-w1.meta.json'), JSON.stringify({ agentType: 'worker', description: 'verify:1', workflowPhase: 'Verify' }));
  writeFileSync(join(run, 'agent-w1.jsonl'), '');
  writeFileSync(join(run, 'journal.jsonl'), '{"type":"started","agentId":"w1","label":"verify:1","phase":"Verify"}\n');

  await h.poller.tick(now);
  assert.equal(floor(h.office).board.line, 'review-changes · Verify 2/2');
  assert.equal(floor(h.office).agents[0].state, 'enter');

  rmSync(script); // the script is read once per run
  appendFileSync(join(run, 'journal.jsonl'), '{"type":"result","agentId":"w1","result":{}}\n');
  await h.poller.tick(now + 1500);
  assert.equal(floor(h.office).agents[0].state, 'done');
  assert.equal(floor(h.office).board.line, 'review-changes · Verify 2/2');
  h.done();
});

test('poller: a workflow run with a missing script and an empty runId is tolerated', async () => {
  const h = fake();
  const now = Date.now();
  writeFileSync(h.transcript, workflowLine(now, 'wf_r2', 'w', join(h.dir, 'nope.js')) + workflowLine(now, '', 'empty', ''));
  await h.poller.tick(now);
  assert.equal(h.office.snapshot().floors.length, 1);
  assert.deepEqual(h.office.workflowRuns('s1').map((r) => r.runId), ['wf_r2']);
  h.done();
});

test('poller: a re-run session (new start time) restarts its tail', async () => {
  const h = fake();
  const now = Date.now();
  writeFileSync(h.transcript, toolLine(now, 'Bash', { command: 'ls', description: '첫 실행' }));
  await h.poller.tick(now);
  h.startSession(STARTED + 1);
  writeFileSync(h.transcript, toolLine(now + 100, 'Bash', { command: 'ls', description: '새 실행' }));
  await h.poller.tick(now + 1500);
  assert.equal(floor(h.office).lead.bubble, '새 실행');
  h.done();
});
