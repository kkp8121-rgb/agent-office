// Final review, group A: label filter bypasses (F1, F2), Codex period start after restart (F20), Codex id check (F38)
// and quiet-rollout stat cost.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../server/config.mjs';
import { firstWord, describeTool } from '../server/sanitize.mjs';
import { parseCodexMeta, parseCodexLine, CodexSource } from '../server/codex.mjs';

const PARENT_ID = '22222222-2222-4222-8222-222222222222';
const CHILD_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_ID = '44444444-4444-4444-8444-444444444444';
const MIN = 60000;

const iso = (ms) => new Date(ms).toISOString();
const line = (ms, type, payload) => JSON.stringify({ timestamp: iso(ms), type, payload }) + '\n';
const ev = (ms, type, extra = {}) => line(ms, 'event_msg', { type, ...extra });
const started = (ms) => ev(ms, 'task_started', { turn_id: 't' });
const complete = (ms) => ev(ms, 'task_complete', { turn_id: 't' });
const meta = (ms, id, source = 'cli') => line(ms, 'session_meta', { id, timestamp: iso(ms), cwd: 'C:\\Project\\app', originator: 'codex_cli', source });
const childMeta = (ms, id, parentId) =>
  meta(ms, id, { subagent: { thread_spawn: { parent_thread_id: parentId, depth: 1, agent_path: '/root/long_job', agent_role: 'worker' } } });
const spawn = (ms) => line(ms, 'response_item', { type: 'function_call', name: 'spawn_agent', call_id: 'sp', arguments: '{"task_name":"long job"}' });
const output = (ms) => line(ms, 'response_item', { type: 'function_call_output', call_id: 'sp', output: 'x' });

const execStart = (input) =>
  parseCodexLine(line(5, 'response_item', { type: 'custom_tool_call', name: 'exec', call_id: 'c1', input }))[0].text;
const execDone = (cmd) =>
  parseCodexLine(line(8, 'event_msg', { type: 'item_completed', item: { type: 'CommandExecution', id: 'x', parsed_cmd: [{ cmd }] } }))[0].text;

function home(t, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'codex-fix-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cfg = loadConfig({ agentScanEveryTicks: 1, ...overrides });
  cfg.codexHome = dir;
  const pad = (n) => String(n).padStart(2, '0');
  const rollout = (id, content) => {
    const day = new Date(Date.now() - 60 * 60000); // the tests poll up to an hour back: put the file in the day folder every poll scans (a test run just after midnight would miss today's)
    const d = join(dir, 'sessions', String(day.getFullYear()), pad(day.getMonth() + 1), pad(day.getDate()));
    mkdirSync(d, { recursive: true });
    const file = join(d, `rollout-2026-10-28T00-00-00-${id}.jsonl`);
    writeFileSync(file, content);
    return file;
  };
  return { cfg, rollout };
}

// ---- F1: firstWord and NAME=value tokens -------------------------------------------------------

test('F1: an assignment glued to ; | & < > never lets a word of the command body through', () => {
  for (const command of [
    'A=1;echo SECRET-123', 'X=1;mysql -pSECRET-123 db', 'A=1|grep SECRET-123', 'A=1>out SECRET-123',
    'A=1&&echo SECRET-123', 'A=1<in cat SECRET-123', 'A=1#x SECRET-123', 'A=é SECRET-123', 'A=b=c SECRET-123',
  ]) {
    assert.equal(firstWord(command), '', command);
    assert.equal(describeTool('Bash', { command }), '명령 실행', command);
  }
  // plain values are still skipped
  assert.equal(firstWord('PATH=/usr/bin:/bin git status'), 'git');
  assert.equal(firstWord('URL=user@h:8080/x,y%20+z git'), 'git');
  assert.equal(firstWord('FOO= git'), 'git');
});

test('F1: adversarial shapes around quotes and line breaks', () => {
  for (const command of [
    '"A=1"SECRET-123 x', // one shell word, not an assignment followed by a command
    "'A=1'SECRET-123 x",
    'A=1\nSECRET-123 x', // the assignment ends a line: the next line is another command
    'A=1\r\nSECRET-123 x',
    '"git"SECRET-123',
    'git;SECRET-123',
    '$(echo SECRET-123)',
    '`echo SECRET-123`',
    'A="" SECRET-123',
    "A='x' B=1 SECRET-123",
    'A=1 "SECRET-123 x"',
  ]) assert.equal(firstWord(command), '', JSON.stringify(command));
  assert.equal(firstWord('A=1\tgit status'), 'git', 'a tab is a blank');
  assert.equal(firstWord(`A=1${' '.repeat(100000)}git`), 'git', 'very long input');
  assert.equal(firstWord('npm\nSECRET-123'), 'npm', 'only the first word');
});

test('fix-back: only spaces and tabs end a skipped assignment; a quoted NAME=value is the command word', () => {
  for (const command of [
    'A=1 SECRET-123 ls', // NBSP: bash keeps "1 SECRET-123" in the value and runs ls
    'A=1\fSECRET-123 ls',
    'A=1\vSECRET-123 ls',
    'A=1 SECRET-123 ls',
    'A=1　SECRET-123 ls',
    'A=1 B=2 SECRET-123 ls',
    "'A=1' SECRET-123", // the command 'A=1' with argument SECRET-123
    '"A=1" SECRET-123',
    '"FOO=bar" git',
  ]) {
    assert.equal(firstWord(command), '', JSON.stringify(command));
    assert.equal(describeTool('Bash', { command }), '명령 실행', JSON.stringify(command));
  }
  assert.equal(firstWord('A=1 \t B=2\tgit status'), 'git', 'spaces and tabs still separate');
  assert.equal(firstWord('A=1​SECRET-123 ls'), '', 'zero-width space');
  assert.equal(execStart('await tools.exec_command({cmd:"A=1 SECRET-123 ls"})'), '명령 실행');
});

test('fix-back: an HTML-like comment or a non-ASCII identifier start stops the exec scan', () => {
  for (const input of [
    '<!-- tools.exec_command({cmd:"SECRET-1 x"})\n await tools.exec_command({cmd:"ls"})',
    'x = 1\n--> tools.exec_command({cmd:"SECRET-2 x"})',
    'x = 1 --> tools.exec_command({cmd:"SECRET-3 x"})',
    'ätools.exec_command({cmd:"SECRET-4 x"})',
    'тtools.exec_command({cmd:"SECRET-5 x"})',
  ]) assert.equal(execStart(input), '명령 실행', JSON.stringify(input));
  // a plain call still labels, and text inside literals is not mistaken for a comment
  assert.equal(execStart('const s = "<!--"; await tools.exec_command({cmd:"git status"})'), 'git 실행');
  assert.equal(execStart('x--; await tools.exec_command({cmd:"ls"})'), 'ls 실행');
});

// ---- F2: the Codex exec label is tied to the exec_command call ---------------------------------

test('F2: cmd: inside comments, strings or other keys never becomes the label', () => {
  const cases = [
    ["// cmd: 'SECRET-123 x'\nawait tools.exec_command({cmd:\"git status\"})", 'git 실행'],
    ["const c = \"cmd:'SECRET-123 x'\"; await tools.exec_command({cmd: c})", '명령 실행'],
    ["await tools.exec_command({cmd:[\"bash\",\"-lc\",\"echo cmd:'SECRET-123'\"]})", '명령 실행'],
    ["await tools.exec_command({workdir:\"cmd: 'SECRET-123'\", cmd:\"ls\"})", '명령 실행'],
  ];
  for (const [input, want] of cases) {
    assert.equal(execStart(input), want, input);
    assert.ok(!execStart(input).includes('SECRET'));
  }
});

test('F2: adversarial exec inputs', () => {
  const cases = [
    // a call written inside a comment or a string is not the call
    ["// tools.exec_command({cmd:\"SECRET-1 x\"})\nconst r = await tools.exec_command({cmd:\"git status\"})", 'git 실행'],
    ["/* tools.exec_command({cmd:'SECRET-2 x'}) */ text(await tools.exec_command({cmd:'npm test'}))", 'npm 실행'],
    ["const s = 'tools.exec_command({cmd:\"SECRET-3 x\"})'; text((await tools.exec_command({cmd:\"node -v\"})).output)", 'node 실행'],
    ["const s = `tools.exec_command({cmd:\"SECRET-4 x\"})`; await tools.exec_command({cmd:\"ls\"})", 'ls 실행'],
    // text the walker cannot follow safely gives no word at all
    ['const s = `${x}tools.exec_command({cmd:"SECRET-5 x"})`; await tools.exec_command({cmd:"ls"})', '명령 실행'],
    ['const re = /"/; await tools.exec_command({cmd:"SECRET-6 x"})', '명령 실행'],
    ["const re = /\"/; const s = \"tools.exec_command({cmd:'SECRET-6 x'})\";", '명령 실행'], // a regex literal would desync the walker
    [String.raw`await tools.exec_command({cmd:"\u0053ECRET-7 x"})`, '명령 실행'],
    [String.raw`await tools.exec_command({cmd:"\x53ECRET-7 x"})`, '명령 실행'],
    ['await tools.exec_command({cmd:`${tok} SECRET-8`})', '명령 실행'],
    ['/* SECRET-9 never closed tools.exec_command({cmd:"SECRET-9 x"})', '명령 실행'],
    ['await tools.exec_command({cmd:"SECRET-10', '명령 실행'],
    // the call must be tools.exec_command itself
    ['mytools.exec_command({cmd:"SECRET-11 x"})', '명령 실행'],
    ['x.tools.exec_command({cmd:"SECRET-12 x"})', '명령 실행'],
    ['// only a comment cmd:\'SECRET-13 x\'', '명령 실행'],
    // the first call decides, even when a later one has a cmd literal
    ['await tools.exec_command({workdir:"w", cmd:"ls"}); await tools.exec_command({cmd:"SECRET-18 y"})', '명령 실행'],
    // the command string still goes through firstWord
    ['await tools.exec_command({cmd:"A=1;echo SECRET-14"})', '명령 실행'],
    [String.raw`await tools.exec_command({cmd:"\"SECRET-15\"x y"})`, '명령 실행'],
    ['await tools.exec_command({cmd:"한글 SECRET-16"})', '명령 실행'],
    // ordinary shapes seen in real rollouts keep their label
    ["await tools.exec_command({ \"cmd\" : 'git log' })", 'git 실행'],
    ["await tools.exec_command({cmd:'git status', workdir:\"cmd:'SECRET-17 x'\"})", 'git 실행'],
    ['text(await tools.exec_command({cmd:"rg -n x"}))', 'rg 실행'],
    ['const r = await tools.exec_command({cmd:"C:\\\\tools\\\\git.exe status"});\ntext(r.output)', 'git 실행'],
  ];
  for (const [input, want] of cases) {
    const got = execStart(input);
    assert.equal(got, want, input);
    assert.ok(!got.includes('SECRET'), input);
  }
});

test('F1 via Codex: item_completed parsed_cmd with a glued assignment', () => {
  assert.equal(execDone('X=1;cat SECRET-PARSED'), '명령 실행');
  assert.equal(execDone('A=1|grep SECRET-PARSED'), '명령 실행');
});

// ---- F38: Codex ids use the shared isSafeId ------------------------------------------------------

test('F38: a Codex session or parent id of ".." is refused', () => {
  assert.equal(parseCodexMeta(meta(1, '..'), 500), null);
  assert.equal(parseCodexMeta(meta(1, 'a..b'), 500), null);
  assert.equal(parseCodexMeta(childMeta(1, CHILD_ID, '..'), 500).parentId, null);
  assert.equal(parseCodexMeta(meta(1, PARENT_ID), 500).id, PARENT_ID);
});

// ---- F20: a hidden Codex parent keeps its startedAt across a restart -------------------------------

/** Parent spawns a long sub-agent at t0 and stays silent; the child writes every 5 min for 45 min; the parent writes at t0+47m. */
async function longChild(t, childBusyMin) {
  const h = home(t);
  const t0 = Date.now() - 60 * MIN;
  const parent = h.rollout(PARENT_ID, meta(t0, PARENT_ID) + started(t0 + 1000) + spawn(t0 + 2000));
  const child = h.rollout(CHILD_ID, childMeta(t0 + 3000, CHILD_ID, PARENT_ID) + started(t0 + 4000));
  const running = new CodexSource(h.cfg);
  await running.poll(t0 + 5000);
  for (let m = 5; m <= 45; m += 5) {
    if (m < childBusyMin) appendFileSync(child, ev(t0 + m * MIN, 'token_count'));
    else if (m === childBusyMin) appendFileSync(child, complete(t0 + m * MIN));
    await running.poll(t0 + m * MIN + 1000);
  }
  appendFileSync(parent, output(t0 + 47 * MIN));
  const now = t0 + 47 * MIN + 1000;
  const longRunning = (await running.poll(now)).sessions.find((s) => s.sessionId === PARENT_ID).startedAt;
  const restarted = (await new CodexSource(h.cfg).poll(now)).sessions.find((s) => s.sessionId === PARENT_ID).startedAt;
  return { t0, longRunning, restarted };
}

test('F20: a parent kept listed by a busy sub-agent keeps its startedAt after a restart', async (t) => {
  const r = await longChild(t, 50); // child never completes inside the run
  assert.equal(r.longRunning, r.t0);
  assert.equal(r.restarted, r.longRunning);
});

test('F20: a parent that was really unlisted during the silence still starts a new period after a restart', async (t) => {
  const r = await longChild(t, 10); // child completes at t0+10m, so the floor left at t0+32m
  assert.equal(r.longRunning, r.t0 + 47 * MIN);
  assert.equal(r.restarted, r.longRunning);
});

test('F20: a sub-agent silent for longer than abandonMs does not cover the silence on a restart', async (t) => {
  const h = home(t);
  const t0 = Date.now() - 60 * MIN;
  h.rollout(PARENT_ID, meta(t0, PARENT_ID) + started(t0 + 1000) + spawn(t0 + 2000) + output(t0 + 47 * MIN));
  // busy, then silent past abandonMs (counted as abandoned, so the floor left), then busy again
  h.rollout(CHILD_ID, childMeta(t0 + 3000, CHILD_ID, PARENT_ID) + started(t0 + 4000) + ev(t0 + 40 * MIN, 'token_count') + ev(t0 + 45 * MIN, 'token_count'));
  const s = (await new CodexSource(h.cfg).poll(t0 + 47 * MIN + 1000)).sessions.find((x) => x.sessionId === PARENT_ID);
  assert.ok(h.cfg.agent.abandonMs < 39 * MIN);
  assert.equal(s.startedAt, t0 + 40 * MIN, 'a new period, begun by the sub-agent line that ended the hole');
});

test('F20: the busy span before a sub-agent was abandoned still covers the parent silence', async (t) => {
  const h = home(t);
  const t0 = Date.now() - 70 * MIN;
  h.rollout(PARENT_ID, meta(t0, PARENT_ID) + started(t0 + 1000) + spawn(t0 + 2000) + output(t0 + 50 * MIN));
  let child = childMeta(t0 + 3000, CHILD_ID, PARENT_ID) + started(t0 + 4000);
  for (let m = 5; m <= 25; m += 5) child += ev(t0 + m * MIN, 'token_count');
  h.rollout(CHILD_ID, child + ev(t0 + 58 * MIN, 'token_count')); // unfinished until t0+25m+abandonMs, then back
  const s = (await new CodexSource(h.cfg).poll(t0 + 58 * MIN + 1000)).sessions.find((x) => x.sessionId === PARENT_ID);
  assert.equal(s.startedAt, t0, 'the floor never left');
});

// ---- resources: a quiet rollout is size-checked on scan ticks only ---------------------------------

test('codex: a rollout whose first line was still being written is checked again on the next tick', async (t) => {
  const h = home(t, { agentScanEveryTicks: 3 });
  const now = Date.now();
  const full = meta(now - 5000, PARENT_ID);
  const file = h.rollout(PARENT_ID, full.slice(0, 20));
  const src = new CodexSource(h.cfg);
  assert.equal((await src.poll(now)).sessions.length, 0);
  appendFileSync(file, full.slice(20) + started(now - 4000));
  assert.equal((await src.poll(now + 1500)).sessions.length, 1, 'seen on a non-scan tick');
});

test('codex: a quiet old rollout is not stat-ed on a non-scan tick', async (t) => {
  const h = home(t, { agentScanEveryTicks: 3 });
  const now = Date.now();
  const old = now - h.cfg.codex.idleKeepMs - 10 * MIN;
  const quiet = h.rollout(OTHER_ID, meta(old, OTHER_ID) + started(old + 1000) + complete(old + 2000));
  h.rollout(PARENT_ID, meta(now - 5000, PARENT_ID) + started(now - 4000));
  const src = new CodexSource(h.cfg);
  const r0 = await src.poll(now); // scan tick: both checked
  assert.deepEqual(r0.sessions.map((s) => s.sessionId), [PARENT_ID]);
  assert.equal(src.statCount, 2);
  await src.poll(now + 1500); // non-scan tick: only the listed one
  assert.equal(src.statCount, 3);
  appendFileSync(quiet, started(now + 2000));
  const r2 = await src.poll(now + 3000); // still a non-scan tick: not seen yet
  assert.equal(src.statCount, 4);
  assert.equal(r2.sessions.length, 1);
  const r3 = await src.poll(now + 4500); // scan tick: the quiet rollout is checked and comes back
  assert.equal(src.statCount, 6);
  assert.deepEqual(r3.sessions.map((s) => s.sessionId).sort(), [OTHER_ID, PARENT_ID].sort());
});
