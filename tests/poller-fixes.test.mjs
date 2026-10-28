// Final-review fixes of the poller side: journal reading, session liveness, transcript lookup, tail cost,
// workflow run completion, abandoned agents and per-scan cost.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync, utimesSync } from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../server/config.mjs';
import { Office } from '../server/office.mjs';
import { Poller } from '../server/poller.mjs';
import { FileTail } from '../server/tail.mjs';
import { WorkflowJournal } from '../server/workflows.mjs';
import { listLiveSessions, findSessionPaths } from '../server/sessions.mjs';
import { listAgents, markSettled } from '../server/agents.mjs';

const STARTED = 1793170000000;
const O = { chunkBytes: 65536, maxLineBytes: 4194304 };

function tmpDir(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Counts calls of node:fs/promises functions (ESM named imports follow after syncBuiltinESMExports). */
function spyFs(t, ...names) {
  const calls = [];
  for (const name of names) {
    const real = fsp[name];
    fsp[name] = (...a) => {
      calls.push({ name, path: String(a[0]) });
      return real(...a);
    };
    t.after(() => {
      fsp[name] = real;
      syncBuiltinESMExports();
    });
  }
  syncBuiltinESMExports();
  return {
    calls,
    count: (name, suffix = '') => calls.filter((c) => c.name === name && c.path.endsWith(suffix)).length,
    reset: () => calls.splice(0),
  };
}

function fake(t, overrides = {}) {
  const dir = tmpDir(t, 'pfix-');
  mkdirSync(join(dir, 'sessions'));
  mkdirSync(join(dir, 'projects', 'P'), { recursive: true });
  const cfg = loadConfig({ agentScanEveryTicks: 1, ...overrides });
  cfg.claudeHome = dir;
  cfg.codexHome = join(dir, 'no-codex');
  const office = new Office(cfg, { hidden: [], names: {} });
  const sentAgents = new Map(); // agentId -> last meta sent to Office
  const progress = []; // setWorkflowProgress arguments, in order
  const syncAgents = office.syncAgents.bind(office);
  office.syncAgents = (id, metas, at) => {
    for (const m of metas) sentAgents.set(m.agentId, m);
    return syncAgents(id, metas, at);
  };
  const setProgress = office.setWorkflowProgress.bind(office);
  office.setWorkflowProgress = (id, runId, p) => {
    progress.push({ runId, ...p });
    return setProgress(id, runId, p);
  };
  const poller = new Poller(cfg, office);
  writeFileSync(
    join(dir, 'sessions', `${process.pid}.json`),
    JSON.stringify({ pid: process.pid, sessionId: 's1', cwd: 'C:\\Project\\app', status: 'busy', name: '', startedAt: STARTED }),
  );
  const run = join(dir, 'projects', 'P', 's1', 'subagents', 'workflows', 'wf_r1');
  return { dir, cfg, office, poller, sentAgents, progress, run, transcript: join(dir, 'projects', 'P', 's1.jsonl') };
}

const iso = (ms) => new Date(ms).toISOString();
const workflowLine = (ms, runId, workflowName) =>
  JSON.stringify({ type: 'user', timestamp: iso(ms), toolUseResult: { taskType: 'local_workflow', runId, workflowName, scriptPath: '' } }) + '\n';
const age = (path, msAgo) => {
  const at = new Date(Date.now() - msAgo);
  utimesSync(path, at, at);
};
const started = (id, phase = 'P1') => JSON.stringify({ type: 'started', key: `k${id}`, agentId: id, label: `l${id}`, phase }) + '\n';
const result = (id, pad = '') => JSON.stringify({ type: 'result', key: `k${id}`, agentId: id, result: { pad } }) + '\n';

function wfAgent(h, id, meta = {}) {
  mkdirSync(h.run, { recursive: true });
  writeFileSync(join(h.run, `agent-${id}.meta.json`), JSON.stringify({ agentType: 'worker', description: `d${id}`, workflowPhase: 'P1', ...meta }));
  writeFileSync(join(h.run, `agent-${id}.jsonl`), '');
}

// ---- F7 ----------------------------------------------------------------------------------------------

test('F7: a journal larger than the tail window is read from its first byte', async (t) => {
  const h = fake(t);
  const now = Date.now();
  writeFileSync(h.transcript, workflowLine(now, 'wf_r1', 'big'));
  const ids = Array.from({ length: 30 }, (_, i) => `a${i}`);
  for (const id of ids) wfAgent(h, id);
  writeFileSync(join(h.run, 'journal.jsonl'), ids.map((id) => started(id)).join('') + ids.map((id) => result(id, 'x'.repeat(12000))).join(''));
  await h.poller.tick(now);
  const open = ids.filter((id) => h.sentAgents.get(id)?.finished !== true);
  assert.deepEqual(open, [], 'every agent with a result line is finished, however far into the journal it is');
});

test('F7: result lines over the line limit still count, from their head', async (t) => {
  const dir = tmpDir(t, 'pfix-j-');
  writeFileSync(
    join(dir, 'journal.jsonl'),
    started('a1') + started('a2') + result('a1', 'y'.repeat(50000)) + 'not json\n' + result('a2'),
  );
  const j = new WorkflowJournal(dir, { ...O, maxLineBytes: 2048 });
  await j.poll();
  assert.deepEqual([...j.finished].sort(), ['a1', 'a2']);
  assert.deepEqual(j.started.get('a1'), { label: 'la1', phase: 'P1' });
});

test('F7: a started line cut at the limit keeps its label and phase', async (t) => {
  const dir = tmpDir(t, 'pfix-j-');
  const line = JSON.stringify({ type: 'started', key: 'k', agentId: 'a1', label: 'verify:\u00e9', phase: 'Phase "x"', extra: 'z'.repeat(5000) });
  writeFileSync(join(dir, 'journal.jsonl'), line + '\n');
  const j = new WorkflowJournal(dir, { ...O, maxLineBytes: 300 });
  await j.poll();
  assert.deepEqual(j.started.get('a1'), { label: 'verify:\u00e9', phase: 'Phase "x"' });
});

test('tail: clipLines delivers the head of an oversized line and the next line intact', async (t) => {
  const dir = tmpDir(t, 'pfix-t-');
  const file = join(dir, 'x.jsonl');
  writeFileSync(file, '{"big":"' + 'x'.repeat(190) + '"}\n{"ok":1}\n');
  const tail = new FileTail(file, { chunkBytes: 16, maxLineBytes: 50, clipLines: true });
  const got = await tail.poll();
  assert.equal(got.length, 2);
  assert.equal(got[0].length, 50);
  assert.equal(got[1], '{"ok":1}');
  assert.equal(tail.resumable, true);
});

test('tail: clipLines is not resumable while the rest of a clipped line is being dropped', async (t) => {
  const dir = tmpDir(t, 'pfix-t-');
  const file = join(dir, 'x.jsonl');
  writeFileSync(file, '{"a":1}\n' + 'x'.repeat(60));
  const tail = new FileTail(file, { chunkBytes: 16, maxLineBytes: 20, clipLines: true });
  assert.deepEqual(await tail.poll(), ['{"a":1}']);
  assert.equal(tail.resumable, false);
  appendFileSync(file, 'y'.repeat(10) + '\n{"ok":1}\n');
  const got = await tail.poll();
  assert.equal(got[0].length, 20);
  assert.equal(got[1], '{"ok":1}');
  assert.equal(tail.resumable, true);
});

// ---- F8 ----------------------------------------------------------------------------------------------

test('F8: a session file older than the boot belongs to a dead session even if its pid is alive', async (t) => {
  const dir = tmpDir(t, 'pfix-s-');
  mkdirSync(join(dir, 'sessions'));
  const boot = Date.now() - 60000;
  const write = (name, sessionId, startedAt, mtimeMs) => {
    const f = join(dir, 'sessions', name);
    writeFileSync(f, JSON.stringify({ pid: process.pid, sessionId, cwd: '', status: 'busy', name: '', startedAt }));
    utimesSync(f, new Date(mtimeMs), new Date(mtimeMs));
  };
  write('stale.json', 'stale', boot - 5000, boot - 4000); // written before the boot
  write('kept-alive.json', 'refreshed', boot - 5000, boot + 1000); // old start, file rewritten after the boot
  write('new.json', 'fresh', boot + 5000, boot + 5000);
  const ids = (await listLiveSessions(dir, boot)).map((s) => s.sessionId).sort();
  assert.deepEqual(ids, ['fresh', 'refreshed']);
});

// ---- F11 ---------------------------------------------------------------------------------------------

test('F11: a miss is not searched in every folder again before retryMs', async (t) => {
  const dir = tmpDir(t, 'pfix-f-');
  mkdirSync(join(dir, 'projects', 'X'), { recursive: true });
  mkdirSync(join(dir, 'projects', 'Y'), { recursive: true });
  const opt = (now) => ({ now, retryMs: 10000 });
  assert.equal(await findSessionPaths(dir, 's9', opt(1000)), null);
  writeFileSync(join(dir, 'projects', 'Y', 's9.jsonl'), '');
  assert.equal(await findSessionPaths(dir, 's9', opt(2000)), null, 'inside the retry window');
  const r = await findSessionPaths(dir, 's9', opt(11001));
  assert.equal(r.transcript, join(dir, 'projects', 'Y', 's9.jsonl'));
});

test('F11: the folder named after the cwd is tried on every call, so a new transcript shows at once', async (t) => {
  const dir = tmpDir(t, 'pfix-f-');
  mkdirSync(join(dir, 'projects', 'C--Dir-app'), { recursive: true });
  const opt = { cwd: 'C:\\Dir\\app', now: 1000, retryMs: 10000 };
  assert.equal(await findSessionPaths(dir, 's8', opt), null);
  writeFileSync(join(dir, 'projects', 'C--Dir-app', 's8.jsonl'), '');
  const r = await findSessionPaths(dir, 's8', { ...opt, now: 2000 });
  assert.equal(r.sessionDir, join(dir, 'projects', 'C--Dir-app', 's8'));
});

test('F11: a live session without a transcript is not scanned on every agent-scan tick', async (t) => {
  const h = fake(t);
  const now = Date.now();
  const fs = spyFs(t, 'readdir');
  await h.poller.tick(now);
  const first = fs.count('readdir', 'projects');
  assert.equal(first, 1);
  await h.poller.tick(now + 1500);
  await h.poller.tick(now + 3000);
  assert.equal(fs.count('readdir', 'projects'), first, 'no further scan of projects/');
});

// ---- F25 / F38 ---------------------------------------------------------------------------------------

test('F25: polling an unchanged file does not open it', async (t) => {
  const dir = tmpDir(t, 'pfix-t-');
  const file = join(dir, 'x.jsonl');
  writeFileSync(file, '{"a":1}\n');
  const tail = new FileTail(file, O);
  const fs = spyFs(t, 'open');
  assert.deepEqual(await tail.poll(), ['{"a":1}']);
  assert.equal(fs.count('open'), 1);
  assert.deepEqual(await tail.poll(), []);
  assert.deepEqual(await tail.poll(), []);
  assert.equal(fs.count('open'), 1, 'idle polls only stat');
  appendFileSync(file, '{"a":2}\n');
  assert.deepEqual(await tail.poll(), ['{"a":2}']);
  assert.equal(fs.count('open'), 2);
  writeFileSync(file, '{"b":1}\n'); // shorter than before: rotation is still noticed
  assert.deepEqual(await tail.poll(), ['{"b":1}']);
  await assert.rejects(new FileTail(join(dir, 'missing.jsonl'), O).poll(), { code: 'ENOENT' });
});

test('F38: FileTail.lastRead is the bytes actually read, and Poller.bytesRead sums it', async (t) => {
  const dir = tmpDir(t, 'pfix-t-');
  const file = join(dir, 'x.jsonl');
  writeFileSync(file, '{"a":1}\n'.repeat(100));
  const tail = new FileTail(file, { ...O, startBytes: 80 });
  await tail.poll();
  assert.equal(tail.lastRead, 80, 'only the start window was read, not the whole file');
  await tail.poll();
  assert.equal(tail.lastRead, 0);
  appendFileSync(file, '{"a":2}\n');
  await tail.poll();
  assert.equal(tail.lastRead, 8);
  writeFileSync(file, '{"b":1}\n');
  await tail.poll();
  assert.equal(tail.lastRead, 8, 'a reset file is read again from its start');

  const h = fake(t, { tail: { startBytes: 100 } });
  const big = '{"type":"x"}\n'.repeat(500);
  writeFileSync(h.transcript, big);
  await h.poller.tick(Date.now());
  assert.ok(h.poller.bytesRead <= 100 && h.poller.bytesRead > 0, `bytesRead ${h.poller.bytesRead}`);
});

// ---- F10 / F12: per-scan cost ------------------------------------------------------------------------

function agentTree(t) {
  const dir = tmpDir(t, 'pfix-a-');
  const sd = join(dir, 's1');
  const root = join(sd, 'subagents');
  const wf = join(root, 'workflows', 'wf_r1');
  mkdirSync(wf, { recursive: true });
  writeFileSync(join(root, 'agent-a1.meta.json'), '{"agentType":"worker","description":"x","finished":true}');
  writeFileSync(join(wf, 'agent-a2.meta.json'), '{"agentType":"worker","description":"y","workflowPhase":"P"}');
  const old = new Date(Date.now() - 60000); // listings made later are far from these times
  for (const d of [root, join(root, 'workflows'), wf]) utimesSync(d, old, old);
  return { sd, root, wf };
}

test('F10/F12: finished agents are not stat-ed again and unchanged folders are not listed again', async (t) => {
  const { sd } = agentTree(t);
  const cache = new Map();
  const fs = spyFs(t, 'stat', 'readdir');
  assert.equal((await listAgents(sd, cache, undefined, 2000)).length, 2);
  assert.equal(fs.count('readdir'), 3);
  fs.reset();
  assert.equal((await listAgents(sd, cache, undefined, 2000)).length, 2);
  assert.equal(fs.count('readdir'), 0, 'folder mtimes unchanged');
  assert.equal(fs.count('stat', 'agent-a1.meta.json'), 0, 'finished meta never changes again');
  assert.equal(fs.count('stat', 'agent-a2.meta.json'), 1, 'a running agent is still checked');
  const [, wfAgent2] = (await listAgents(sd, cache, undefined, 2000)).sort((a, b) => a.agentId.localeCompare(b.agentId));
  markSettled(cache, wfAgent2); // its end is known from the workflow journal
  fs.reset();
  await listAgents(sd, cache, undefined, 2000);
  assert.equal(fs.count('stat', '.meta.json'), 0);
  assert.equal(fs.count('stat'), 3, 'only the three folders are stat-ed');
});

test('F10/F12: a new agent in a known folder is found, and a fresh folder mtime is never trusted', async (t) => {
  const { sd, wf } = agentTree(t);
  const cache = new Map();
  await listAgents(sd, cache, undefined, 2000);
  writeFileSync(join(wf, 'agent-a3.meta.json'), '{"agentType":"worker","description":"z","workflowPhase":"P"}');
  assert.deepEqual((await listAgents(sd, cache, undefined, 2000)).map((a) => a.agentId).sort(), ['a1', 'a2', 'a3']);
  // wf was listed just after its modification: the next call lists it again, a later change cannot hide behind the same mtime
  writeFileSync(join(wf, 'agent-a4.meta.json'), '{"agentType":"worker","description":"w","workflowPhase":"P"}');
  assert.equal((await listAgents(sd, cache, undefined, 2000)).length, 4);
});

test('F10/F12: a folder listed right after its mtime is listed again when the mtime did not move (coarse timestamps)', async (t) => {
  const { sd, wf } = agentTree(t);
  const cache = new Map();
  const T = new Date(Math.floor(Date.now() / 1000) * 1000); // whole second, as on a file system with 1 s timestamps
  utimesSync(wf, T, T);
  await listAgents(sd, cache, undefined, 2000);
  writeFileSync(join(wf, 'agent-a3.meta.json'), '{"agentType":"worker","description":"z","workflowPhase":"P"}');
  utimesSync(wf, T, T); // the change is invisible in the folder mtime
  assert.deepEqual((await listAgents(sd, cache, undefined, 2000)).map((a) => a.agentId).sort(), ['a1', 'a2', 'a3']);
});

test('F10/F12: an idle tick does not stat the metas of finished agents', async (t) => {
  const h = fake(t);
  const now = Date.now();
  writeFileSync(h.transcript, '');
  const sub = join(h.dir, 'projects', 'P', 's1', 'subagents');
  mkdirSync(sub, { recursive: true });
  for (const id of ['f1', 'f2', 'f3']) {
    writeFileSync(join(sub, `agent-${id}.meta.json`), JSON.stringify({ agentType: 'worker', description: id, finished: true }));
    writeFileSync(join(sub, `agent-${id}.jsonl`), '');
  }
  const fs = spyFs(t, 'stat');
  await h.poller.tick(now);
  assert.equal(fs.count('stat', '.meta.json'), 3);
  fs.reset();
  await h.poller.tick(now + 1500);
  await h.poller.tick(now + 3000);
  assert.equal(fs.count('stat', '.meta.json'), 0);
});

// ---- F23 ---------------------------------------------------------------------------------------------

test('F23: a long-silent agent is abandoned, not finished; a finished one is finished', async (t) => {
  const h = fake(t);
  const now = Date.now();
  writeFileSync(h.transcript, '');
  const sub = join(h.dir, 'projects', 'P', 's1', 'subagents');
  mkdirSync(sub, { recursive: true });
  writeFileSync(join(sub, 'agent-ok.meta.json'), JSON.stringify({ agentType: 'worker', description: 'ok', finished: true }));
  writeFileSync(join(sub, 'agent-ok.jsonl'), '');
  writeFileSync(join(sub, 'agent-lost.meta.json'), JSON.stringify({ agentType: 'worker', description: 'lost' }));
  writeFileSync(join(sub, 'agent-lost.jsonl'), '');
  for (const f of ['agent-lost.meta.json', 'agent-lost.jsonl']) age(join(sub, f), h.cfg.agent.abandonMs * 2);
  await h.poller.tick(now);
  assert.deepEqual({ f: h.sentAgents.get('lost').finished, a: h.sentAgents.get('lost').abandoned }, { f: false, a: true });
  assert.equal(h.sentAgents.get('ok').finished, true);
  assert.notEqual(h.sentAgents.get('ok').abandoned, true);
});

// ---- F6 / F19 / F13 / F35: workflow run completion ---------------------------------------------------

test('F6/F19: a run is done when all its agents ended and it has been quiet for doneQuietMs, then it is not polled', async (t) => {
  const h = fake(t);
  const now = Date.now();
  const quiet = h.cfg.workflow.doneQuietMs;
  writeFileSync(h.transcript, workflowLine(now, 'wf_r1', 'review'));
  wfAgent(h, 'w1');
  wfAgent(h, 'w2');
  writeFileSync(join(h.run, 'journal.jsonl'), started('w1') + started('w2'));
  await h.poller.tick(now);
  assert.deepEqual(h.progress.map((p) => p.done), [false]);

  appendFileSync(join(h.run, 'journal.jsonl'), result('w1'));
  await h.poller.tick(now + quiet * 2);
  assert.equal(h.progress.at(-1).done, false, 'w2 has not returned a result');

  appendFileSync(join(h.run, 'journal.jsonl'), result('w2'));
  await h.poller.tick(now + 3000);
  assert.equal(h.progress.at(-1).done, false, 'all ended, but the journal changed a moment ago');
  assert.equal(h.progress.at(-1).current, 'P1');

  const fs = spyFs(t, 'stat', 'open');
  await h.poller.tick(now + quiet + 60000);
  assert.deepEqual(h.progress.map((p) => p.done), [false, false, false, true]);
  assert.equal(h.progress.at(-1).name, 'review');
  const sent = h.progress.length;
  fs.reset();
  await h.poller.tick(now + quiet + 61500);
  await h.poller.tick(now + quiet + 63000);
  assert.equal(h.progress.length, sent, 'done is sent once');
  assert.equal(fs.count('stat', 'journal.jsonl') + fs.count('open', 'journal.jsonl'), 0, 'a done run is not polled');
});

test('F6/F19: a done run that gets a new agent is polled again and reported as running', async (t) => {
  const h = fake(t);
  const now = Date.now();
  const later = now + h.cfg.workflow.doneQuietMs + 60000;
  writeFileSync(h.transcript, workflowLine(now, 'wf_r1', 'review'));
  wfAgent(h, 'w1');
  writeFileSync(join(h.run, 'journal.jsonl'), started('w1') + result('w1'));
  await h.poller.tick(now);
  await h.poller.tick(later);
  assert.equal(h.progress.at(-1).done, true);

  wfAgent(h, 'w2');
  appendFileSync(join(h.run, 'journal.jsonl'), started('w2', 'P2'));
  await h.poller.tick(later + 1500);
  assert.equal(h.progress.at(-1).done, false);
  assert.equal(h.progress.at(-1).current, 'P2');

  appendFileSync(join(h.run, 'journal.jsonl'), result('w2'));
  await h.poller.tick(later + 3000);
  await h.poller.tick(later + 3000 + h.cfg.workflow.doneQuietMs + 60000);
  assert.equal(h.progress.at(-1).done, true);
});

test('F13/F35: a stopped run (agents silent for abandonMs) is done and its journal is not polled again', async (t) => {
  const h = fake(t);
  const now = Date.now();
  writeFileSync(h.transcript, workflowLine(now, 'wf_r1', 'crashed'));
  wfAgent(h, 'w1');
  writeFileSync(join(h.run, 'journal.jsonl'), started('w1')); // no result will ever come
  for (const f of ['agent-w1.meta.json', 'agent-w1.jsonl', 'journal.jsonl']) age(join(h.run, f), h.cfg.agent.abandonMs * 2);
  const fs = spyFs(t, 'stat', 'open');
  await h.poller.tick(now);
  assert.equal(h.progress.at(-1).done, true);
  assert.equal(h.sentAgents.get('w1').abandoned, true);
  fs.reset();
  await h.poller.tick(now + 1500);
  await h.poller.tick(now + 3000);
  assert.equal(fs.count('stat', 'journal.jsonl') + fs.count('open', 'journal.jsonl'), 0);
});
