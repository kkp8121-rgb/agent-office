// Seams between groups after the final-fix integration: Poller -> Office over a fake home.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../server/config.mjs';
import { Office } from '../server/office.mjs';
import { Poller } from '../server/poller.mjs';

function fake(t) {
  const dir = mkdtempSync(join(tmpdir(), 'integ-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'sessions'));
  mkdirSync(join(dir, 'projects', 'P'), { recursive: true });
  const cfg = loadConfig({ agentScanEveryTicks: 1 });
  cfg.claudeHome = dir;
  cfg.codexHome = join(dir, 'no-codex');
  const office = new Office(cfg, { hidden: [], names: {} });
  const poller = new Poller(cfg, office);
  writeFileSync(
    join(dir, 'sessions', `${process.pid}.json`),
    JSON.stringify({ pid: process.pid, sessionId: 's1', cwd: 'C:\Project\app', status: 'busy', name: '', startedAt: 1793170000000 }),
  );
  const sub = join(dir, 'projects', 'P', 's1', 'subagents');
  return { dir, cfg, office, poller, sub, run: join(sub, 'workflows', 'wf_r1'), transcript: join(dir, 'projects', 'P', 's1.jsonl') };
}

const floor = (h) => h.office.snapshot().floors.find((f) => f.sessionId === 's1');
const age = (path, msAgo) => {
  const at = new Date(Date.now() - msAgo);
  utimesSync(path, at, at);
};
const line = (o) => JSON.stringify(o) + '\n';

test('integration: a workflow run whose agents all finish clears the board line and the workflow count after the quiet window', async (t) => {
  const h = fake(t);
  const now = Date.now();
  writeFileSync(
    h.transcript,
    line({ type: 'user', timestamp: new Date(now).toISOString(), toolUseResult: { taskType: 'local_workflow', runId: 'wf_r1', workflowName: 'review', scriptPath: '' } }),
  );
  mkdirSync(h.run, { recursive: true });
  for (const id of ['w1', 'w2']) {
    writeFileSync(join(h.run, `agent-${id}.meta.json`), JSON.stringify({ agentType: 'worker', description: id, workflowPhase: 'P1' }));
    writeFileSync(join(h.run, `agent-${id}.jsonl`), '');
  }
  const started = (id) => line({ type: 'started', key: `k${id}`, agentId: id, label: id, phase: 'P1' });
  const result = (id) => line({ type: 'result', key: `k${id}`, agentId: id, result: {} });
  writeFileSync(join(h.run, 'journal.jsonl'), started('w1') + started('w2'));

  await h.poller.tick(now);
  assert.equal(floor(h).workflows, 1);
  assert.match(floor(h).board.line, /review/);

  appendFileSync(join(h.run, 'journal.jsonl'), result('w1') + result('w2'));
  await h.poller.tick(now + 3000);
  assert.match(floor(h).board.line, /review/, 'still shown inside the quiet window');

  await h.poller.tick(now + h.cfg.workflow.doneQuietMs + 60000);
  assert.equal(floor(h).board.line, '');
  assert.equal(floor(h).workflows, 0);
});

test('integration: an abandoned agent is released without a report and logged as 응답 없이 종료', async (t) => {
  const h = fake(t);
  const now = Date.now();
  writeFileSync(h.transcript, '');
  mkdirSync(h.sub, { recursive: true });
  writeFileSync(join(h.sub, 'agent-lost.meta.json'), JSON.stringify({ agentType: 'worker', description: 'lost' }));
  writeFileSync(join(h.sub, 'agent-lost.jsonl'), '');

  await h.poller.tick(now);
  assert.equal(floor(h).agents.length, 1, 'a fresh agent is on the floor');
  h.office.drainLog();

  for (const f of ['agent-lost.meta.json', 'agent-lost.jsonl']) age(join(h.sub, f), h.cfg.agent.abandonMs * 2);
  await h.poller.tick(now + 3000);
  assert.equal(floor(h).agents.length, 0);
  assert.equal(floor(h).reports, 0);
  assert.deepEqual(h.office.drainLog().map((e) => e.text), ['응답 없이 종료']);
});
