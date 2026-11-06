import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listLiveSessions, findSessionPaths, isPidAlive } from '../server/sessions.mjs';
import { listAgents } from '../server/agents.mjs';
import { WorkflowJournal, phasesFromScript } from '../server/workflows.mjs';

/** Temp dir for one test; removed when the test ends, pass or fail. */
function home(t) {
  const dir = mkdtempSync(join(tmpdir(), 'disc-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir };
}
const sess = (pid) =>
  JSON.stringify({ pid, sessionId: 's1', cwd: 'C:\\Project', status: 'busy', name: 'x', startedAt: 1793170000000 });
const O = { chunkBytes: 65536, maxLineBytes: 4194304 };

test('sessions: live session is listed', async (t) => {
  const h = home(t);
  mkdirSync(join(h.dir, 'sessions'));
  writeFileSync(join(h.dir, 'sessions', `${process.pid}.json`), sess(process.pid));
  const r = await listLiveSessions(h.dir);
  assert.equal(r.length, 1);
  assert.deepEqual(r[0], {
    provider: 'claude', pid: process.pid, sessionId: 's1', cwd: 'C:\\Project', status: 'busy', name: 'x', startedAt: 1793170000000,
  });
  assert.equal(isPidAlive(process.pid), true);
});

test('sessions: dead pid is excluded', async (t) => {
  const h = home(t);
  mkdirSync(join(h.dir, 'sessions'));
  writeFileSync(join(h.dir, 'sessions', '999999.json'), sess(999999));
  assert.equal((await listLiveSessions(h.dir)).length, 0);
});

test('sessions: key files and broken json are ignored', async (t) => {
  const h = home(t);
  mkdirSync(join(h.dir, 'sessions'));
  writeFileSync(join(h.dir, 'sessions', 'abc.key'), sess(process.pid)); // would be listed if opened
  writeFileSync(join(h.dir, 'sessions', 'bad.json'), '{x');
  assert.deepEqual(await listLiveSessions(h.dir), []);
  assert.deepEqual(await listLiveSessions(join(h.dir, 'nope')), []);
});

test('sessions: transcript is found across project folders', async (t) => {
  const h = home(t);
  mkdirSync(join(h.dir, 'projects', 'other'), { recursive: true });
  mkdirSync(join(h.dir, 'projects', 'C--Project'), { recursive: true });
  assert.equal(await findSessionPaths(h.dir, 's1'), null);
  writeFileSync(join(h.dir, 'projects', 'C--Project', 's1.jsonl'), '');
  const r = await findSessionPaths(h.dir, 's1');
  assert.equal(r.transcript, join(h.dir, 'projects', 'C--Project', 's1.jsonl'));
  assert.equal(r.sessionDir, join(h.dir, 'projects', 'C--Project', 's1'));
});

function agentFixture(h) {
  const sd = join(h.dir, 's1');
  mkdirSync(join(sd, 'subagents', 'workflows', 'wf_r1'), { recursive: true });
  writeFileSync(join(sd, 'subagents', 'agent-a1.meta.json'), '{"agentType":"worker","description":"조사","finished":true}');
  writeFileSync(
    join(sd, 'subagents', 'workflows', 'wf_r1', 'agent-a2.meta.json'),
    '{"agentType":"worker-high","description":"FE stg","workflowPhase":"Promote"}',
  );
  return sd;
}

test('agents: background and workflow agents are listed', async (t) => {
  const h = home(t);
  const sd = agentFixture(h);
  const r = await listAgents(sd, new Map());
  assert.equal(r.length, 2);
  const bg = r.find((a) => a.agentId === 'a1');
  assert.equal(bg.agentType, 'worker');
  assert.equal(bg.finished, true);
  assert.equal(bg.workflow, null);
  assert.equal(bg.transcriptPath, join(sd, 'subagents', 'agent-a1.jsonl'));
  const wf = r.find((a) => a.agentId === 'a2');
  assert.deepEqual(wf.workflow, { runId: 'wf_r1', phase: 'Promote', label: 'FE stg' });
  assert.equal(wf.finished, false);
  assert.deepEqual(await listAgents(join(h.dir, 'missing'), new Map()), []);
});

test('agents: unchanged meta is not re-read', async (t) => {
  const h = home(t);
  const sd = agentFixture(h);
  const cache = new Map();
  let reads = 0;
  const counting = (...a) => (reads++, readFile(...a));
  await listAgents(sd, cache, counting);
  assert.equal(reads, 2);
  await listAgents(sd, cache, counting);
  assert.equal(reads, 2);
});

test('workflows: journal tracks started and finished', async (t) => {
  const h = home(t);
  writeFileSync(
    join(h.dir, 'journal.jsonl'),
    [
      '{"type":"launched"}',
      '{"type":"started","key":"k1","agentId":"a1","label":"verify:1","phase":"Browser"}',
      '{"type":"started","key":"k2","agentId":"a2","label":"verify:2","phase":"Browser"}',
      '{"type":"result","key":"k2","agentId":"a2","result":{"secret":"x"}}',
      'not json',
    ].join('\n') + '\n',
  );
  const j = new WorkflowJournal(h.dir, O);
  await j.poll();
  assert.equal(j.started.size, 2);
  assert.deepEqual(j.started.get('a1'), { label: 'verify:1', phase: 'Browser' });
  assert.equal(j.finished.has('a2'), true);
  assert.equal(j.finished.has('a1'), false);
});

test('workflows: missing journal is not an error', async (t) => {
  const h = home(t);
  const j = new WorkflowJournal(h.dir, O);
  await j.poll();
  assert.equal(j.started.size, 0);
  appendFileSync(join(h.dir, 'journal.jsonl'), '{"type":"started","agentId":"a1","label":"l","phase":"p"}\n');
  await j.poll();
  assert.equal(j.started.size, 1);
});

test('workflows: phases from script', () => {
  const s = "export const meta = { name:'x', phases: [{ title: 'Review' }, { title: 'Verify', detail: 'd' }] }\nawait agent()";
  assert.deepEqual(phasesFromScript(s), ['Review', 'Verify']);
  assert.deepEqual(phasesFromScript('const a = 1;'), []);
});

test('sessions: path-like sessionId is rejected', async (t) => {
  const h = home(t);
  mkdirSync(join(h.dir, 'sessions'));
  writeFileSync(
    join(h.dir, 'sessions', 'evil.json'),
    JSON.stringify({ pid: process.pid, sessionId: '../x', cwd: '', status: '', name: '', startedAt: 1 }),
  );
  assert.deepEqual(await listLiveSessions(h.dir), []);
  assert.equal(await findSessionPaths(h.dir, '../x'), null);
});

test('sessions: pid 0 and negative are not alive', () => {
  assert.equal(isPidAlive(0), false);
  assert.equal(isPidAlive(-1), false);
  assert.equal(isPidAlive(1.5), false);
});
