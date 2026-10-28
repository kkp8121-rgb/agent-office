// Final-fix round 2, poller side: scan cost follows the active workflow runs, not the session's whole run history.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync, readdirSync } from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../server/config.mjs';
import { Office } from '../server/office.mjs';
import { Poller } from '../server/poller.mjs';
import { listAgents } from '../server/agents.mjs';

const STARTED = 1793170000000;
const FINISHED = '{"agentType":"worker","description":"x","finished":true,"workflowPhase":"P"}';
const RUNNING = '{"agentType":"worker","description":"y","workflowPhase":"P"}';

function tmpDir(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Counts stat and readdir calls of node:fs/promises with the path they were given. */
function spyFs(t) {
  const calls = [];
  for (const name of ['stat', 'readdir']) {
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
  return { calls, reset: () => calls.splice(0), under: (needle) => calls.filter((c) => c.path.includes(needle)).length };
}

/** `runs` finished workflow runs of `perRun` agents each, every folder and meta file dated a minute ago (`freshMetas`: metas keep their write time). */
function history(t, runs, perRun, extra = {}, freshMetas = false) {
  const sd = join(tmpDir(t, 'r2p-'), 's1');
  const wfRoot = join(sd, 'subagents', 'workflows');
  for (let r = 0; r < runs; r++) {
    const rd = join(wfRoot, `wf_old${r}`);
    mkdirSync(rd, { recursive: true });
    for (let a = 0; a < perRun; a++) writeFileSync(join(rd, `agent-a${a}.meta.json`), FINISHED);
  }
  for (const [run, agents] of Object.entries(extra)) {
    mkdirSync(join(wfRoot, run), { recursive: true });
    for (const [id, body] of Object.entries(agents)) writeFileSync(join(wfRoot, run, `agent-${id}.meta.json`), body);
  }
  const old = new Date(Date.now() - 60000);
  const runDirs = [...[...Array(runs).keys()].map((r) => `wf_old${r}`), ...Object.keys(extra)];
  if (!freshMetas) {
    for (const r of runDirs) for (const n of readdirSync(join(wfRoot, r))) utimesSync(join(wfRoot, r, n), old, old);
  }
  for (const d of [join(sd, 'subagents'), wfRoot, ...runDirs.map((r) => join(wfRoot, r))]) utimesSync(d, old, old);
  return { sd, wfRoot };
}

test('F10/F12: a finished, quiet run is not stat-ed or listed again, however many runs there are', async (t) => {
  const { sd } = history(t, 50, 4);
  const cache = new Map();
  assert.equal((await listAgents(sd, cache, undefined, 2000)).length, 200);
  await listAgents(sd, cache, undefined, 2000); // the first scan saw the agents finish; this one still settles the runs
  const fs = spyFs(t);
  assert.equal((await listAgents(sd, cache, undefined, 2000)).length, 200, 'the agents of settled runs are still reported');
  assert.equal(fs.under('wf_old'), 0, 'no run folder and no meta is touched');
  assert.ok(fs.calls.length <= 2, `only the two parent folders: ${fs.calls.length}`);
});

test('F10/F12: a new run is found within one scan once the workflows folder mtime moved; old runs stay untouched', async (t) => {
  const { sd, wfRoot } = history(t, 20, 3);
  const cache = new Map();
  await listAgents(sd, cache, undefined, 2000);
  await listAgents(sd, cache, undefined, 2000);
  const nr = join(wfRoot, 'wf_new');
  mkdirSync(nr);
  writeFileSync(join(nr, 'agent-n1.meta.json'), RUNNING);
  const fs = spyFs(t);
  const ids = (await listAgents(sd, cache, undefined, 2000)).map((a) => a.agentId);
  assert.ok(ids.includes('n1') && ids.length === 61);
  assert.equal(fs.under('wf_old'), 0);
  assert.equal(fs.calls.filter((c) => c.name === 'readdir').length, 2, 'the workflows folder and the new run only');
});

test('F10/F12: a run with an agent still running keeps being checked, and its new agents are found', async (t) => {
  const { sd, wfRoot } = history(t, 5, 2, { wf_live: { l1: RUNNING } });
  const cache = new Map();
  await listAgents(sd, cache, undefined, 2000);
  await listAgents(sd, cache, undefined, 2000);
  writeFileSync(join(wfRoot, 'wf_live', 'agent-l2.meta.json'), RUNNING);
  const fs = spyFs(t);
  const ids = (await listAgents(sd, cache, undefined, 2000)).map((a) => a.agentId);
  assert.ok(ids.includes('l1') && ids.includes('l2'));
  assert.equal(fs.under('wf_old'), 0);
  assert.ok(fs.under('wf_live') >= 1);
});

test('F10/F12: a run settles only after it was quiet for the settle window', async (t) => {
  const { sd } = history(t, 3, 2);
  const cache = new Map();
  const fs = spyFs(t);
  await listAgents(sd, cache, undefined, 2000, 3600000); // folders are a minute old, window is an hour
  fs.reset();
  await listAgents(sd, cache, undefined, 2000, 3600000);
  assert.equal(fs.under('wf_old0'), 1, 'not settled: still stat-ed');
  await listAgents(sd, cache, undefined, 2000, 30000); // now a minute old is quiet enough
  fs.reset();
  await listAgents(sd, cache, undefined, 2000, 30000);
  assert.equal(fs.under('wf_old0'), 0);
});

test('F10/F12: a poller tick does not touch finished run folders', async (t) => {
  const dir = tmpDir(t, 'r2pt-');
  mkdirSync(join(dir, 'sessions'));
  mkdirSync(join(dir, 'projects', 'P'), { recursive: true });
  const cfg = loadConfig({ agentScanEveryTicks: 1 });
  cfg.claudeHome = dir;
  cfg.codexHome = join(dir, 'no-codex');
  cfg.workflow.doneQuietMs = 1000;
  const poller = new Poller(cfg, new Office(cfg, { hidden: [], names: {} }));
  writeFileSync(
    join(dir, 'sessions', `${process.pid}.json`),
    JSON.stringify({ pid: process.pid, sessionId: 's1', cwd: 'C:\Project\app', status: 'busy', name: '', startedAt: STARTED }),
  );
  writeFileSync(join(dir, 'projects', 'P', 's1.jsonl'), '');
  const sd = join(dir, 'projects', 'P', 's1');
  const wfRoot = join(sd, 'subagents', 'workflows');
  for (let r = 0; r < 10; r++) {
    const rd = join(wfRoot, `wf_old${r}`);
    mkdirSync(rd, { recursive: true });
    writeFileSync(join(rd, 'agent-a1.meta.json'), FINISHED);
    writeFileSync(join(rd, 'agent-a1.jsonl'), '');
    const old = new Date(Date.now() - 60000);
    for (const p of [rd, join(rd, 'agent-a1.meta.json'), join(rd, 'agent-a1.jsonl')]) utimesSync(p, old, old);
  }
  const now = Date.now();
  await poller.tick(now);
  await poller.tick(now + 3000);
  const fs = spyFs(t);
  await poller.tick(now + 6000);
  await poller.tick(now + 9000);
  assert.equal(fs.under('wf_old'), 0);
});

test('F10/F12: a phase 2 agent appearing right after phase 1 finished is found, although the run folder mtime is old', async (t) => {
  // Phase 1 agents ran a long time: the folder mtime is their start, but their metas were rewritten (finished) just now.
  const { sd, wfRoot } = history(t, 1, 2, {}, true);
  const cache = new Map();
  const window = 30000;
  assert.equal((await listAgents(sd, cache, undefined, 2000, window)).length, 2);
  assert.equal((await listAgents(sd, cache, undefined, 2000, window)).length, 2);
  writeFileSync(join(wfRoot, 'wf_old0', 'agent-p2.meta.json'), RUNNING);
  const ids = (await listAgents(sd, cache, undefined, 2000, window)).map((m) => m.agentId).sort();
  assert.deepEqual(ids, ['a0', 'a1', 'p2']);
});

test('F10/F12: a run freezes once its metas, not only its folder, have been quiet for the settle window', async (t) => {
  const { sd } = history(t, 1, 2, {}, true);
  const cache = new Map();
  const fs = spyFs(t);
  const window = 300;
  await listAgents(sd, cache, undefined, 2000, window);
  fs.reset();
  await listAgents(sd, cache, undefined, 2000, window);
  assert.equal(fs.under('wf_old0'), 1, 'metas are fresh: run still checked');
  await new Promise((r) => setTimeout(r, window + 100)); // the fresh metas become old
  await listAgents(sd, cache, undefined, 2000, window); // freezes
  fs.reset();
  await listAgents(sd, cache, undefined, 2000, window);
  assert.equal(fs.under('wf_old0'), 0);
});
