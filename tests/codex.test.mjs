import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../server/config.mjs';
import { Office } from '../server/office.mjs';
import { Poller } from '../server/poller.mjs';
import { parseCodexMeta, parseCodexLine, CodexSource } from '../server/codex.mjs';
import { describeTool } from '../server/sanitize.mjs';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'codex');
const fixture = (name) => readFileSync(join(FIX, name), 'utf8').trim();

const EXEC_ID = '11111111-1111-4111-8111-111111111111';
const PARENT_ID = '22222222-2222-4222-8222-222222222222';
const CHILD_ID = '33333333-3333-4333-8333-333333333333';
const EMPTY = { hidden: [], names: {} };
const CWD_MAX = loadConfig().codex.cwdMaxChars;

const iso = (ms) => new Date(ms).toISOString();
const line = (ms, type, payload) => JSON.stringify({ timestamp: iso(ms), type, payload }) + '\n';
const ev = (ms, type, extra = {}) => line(ms, 'event_msg', { type, ...extra });
const started = (ms) => ev(ms, 'task_started', { turn_id: 't' });
const complete = (ms) => ev(ms, 'task_complete', { turn_id: 't' });
const meta = (ms, id, { source = 'cli', originator = 'codex_cli', cwd = 'C:\\Project\\storybeginz-frontend' } = {}) =>
  line(ms, 'session_meta', { creator_user_id: 'U-SECRET', id, timestamp: iso(ms), cwd, originator, source });
const childMeta = (ms, id, parentId, role = 'scout', path = '/root/find_files') =>
  meta(ms, id, {
    source: { subagent: { thread_spawn: { parent_thread_id: parentId, depth: 1, agent_path: path, agent_nickname: 'K', agent_role: role } } },
  });

/** Fake codex home; removed when the test ends, pass or fail. */
function fake(t, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'codex-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cfg = loadConfig({ agentScanEveryTicks: 1, ...overrides });
  cfg.codexHome = dir;
  const pad = (n) => String(n).padStart(2, '0');
  const rollout = (id, content, day = new Date()) => {
    const d = join(dir, 'sessions', String(day.getFullYear()), pad(day.getMonth() + 1), pad(day.getDate()));
    mkdirSync(d, { recursive: true });
    const file = join(d, `rollout-${iso(day.getTime()).replace(/[:.]/g, '-')}-${id}.jsonl`);
    writeFileSync(file, content);
    return file;
  };
  return { dir, cfg, rollout };
}

// ---- parsing ---------------------------------------------------------------------------------

test('codex: meta of exec, interactive and subagent', () => {
  const exec = parseCodexMeta(fixture('meta-exec.jsonl'), CWD_MAX);
  assert.equal(exec.kind, 'exec');
  assert.equal(exec.id, EXEC_ID);
  assert.equal(exec.cwd, 'C:\\Project\\billing-app');
  assert.equal(exec.parentId, null);
  assert.equal(exec.agentRole, null);
  assert.equal(exec.startedAt, Date.parse('2026-10-28T08:00:00.000Z'));

  const inter = parseCodexMeta(fixture('meta-interactive.jsonl'), CWD_MAX);
  assert.equal(inter.kind, 'interactive');
  assert.equal(inter.id, PARENT_ID);

  const sub = parseCodexMeta(fixture('meta-subagent.jsonl'), CWD_MAX);
  assert.equal(sub.kind, 'subagent');
  assert.equal(sub.id, CHILD_ID);
  assert.equal(sub.parentId, PARENT_ID);
  assert.equal(sub.agentRole, 'scout');
  assert.equal(sub.taskName, 'billing config review');

  assert.equal(parseCodexMeta('not json', CWD_MAX), null);
  assert.equal(parseCodexMeta(line(1, 'event_msg', { type: 'task_started' }), CWD_MAX), null);
});

test('codex: meta never carries account ids', () => {
  for (const f of ['meta-exec.jsonl', 'meta-interactive.jsonl', 'meta-subagent.jsonl']) {
    const out = JSON.stringify(parseCodexMeta(fixture(f), CWD_MAX));
    for (const secret of ['U-SECRET', 'A-SECRET', 'SECRET-INSTRUCTIONS']) assert.ok(!out.includes(secret), `${f}: ${secret}`);
  }
});

test('codex: exec tool start exposes first word only', () => {
  const start = (input) =>
    parseCodexLine(line(5, 'response_item', { type: 'custom_tool_call', name: 'exec', call_id: 'c1', input }));
  const [e] = start('await tools.exec_command({cmd:"git push https://token@x"})');
  assert.equal(e.kind, 'tool');
  assert.equal(e.toolUseId, 'c1');
  assert.equal(e.text, 'git 실행');
  assert.ok(!JSON.stringify(e).includes('token'));
  assert.equal(start('await tools.exec_command({cmd:"@\'\nsecret\n\'@ | x"})')[0].text, '명령 실행');
  assert.equal(start('await tools.exec_command({cmd:"$env:TOKEN"})')[0].text, '명령 실행');
  assert.equal(start('await tools.other({})')[0].text, '명령 실행');
  assert.equal(start('await tools.exec_command({cmd:"git status')[0].text, '명령 실행', 'unterminated literal');
});

test('codex: exec label reads only the first cmd literal and shares Claude\'s firstWord', () => {
  const start = (input) =>
    parseCodexLine(line(5, 'response_item', { type: 'custom_tool_call', name: 'exec', call_id: 'c1', input }));
  // the probe: a later `cmd:'word` inside the command body must never be picked up
  const probe = start('await tools.exec_command({cmd:"$env:X=1; echo cmd:\'hunter2 x\'"})');
  assert.equal(probe[0].text, '명령 실행');
  assert.ok(!JSON.stringify(probe).includes('hunter2'));
  assert.equal(start('await tools.exec_command({cmd:"C:\\\\tools\\\\git.exe status"})')[0].text, 'git 실행');
  assert.equal(start('await tools.exec_command({cmd:"FOO=bar git push"})')[0].text, 'git 실행');
  assert.equal(start('await tools.exec_command({cmd:"git \\"quoted\\" push"})')[0].text, 'git 실행');

  // item_completed goes through the same function
  const done = (cmd) => parseCodexLine(line(8, 'event_msg', { type: 'item_completed', item: { type: 'CommandExecution', id: 'x', parsed_cmd: [{ cmd }] } }))[0].text;
  assert.equal(done('FOO=bar git push'), 'git 실행');
  assert.equal(done('$env:X=1; echo cmd:\'hunter2 x\''), '명령 실행');

  // same answer as the Claude Bash label for the same command string
  for (const command of ['git status', 'C:\\tools\\git.exe status', 'FOO=bar npm run x', '$env:X=1', "@'\nx\n'@", 'curl https://u:p@h/x', '"C:\\Program Files\\Git\\git.exe" log']) {
    const claude = describeTool('Bash', { command });
    const codex = done(command);
    assert.equal(codex, claude, command);
  }
});

test('codex: call output and item_completed end the tool', () => {
  const [a] = parseCodexLine(line(6, 'response_item', { type: 'custom_tool_call_output', call_id: 'c1', output: 'SECRET-OUTPUT' }));
  assert.deepEqual(a, { kind: 'toolDone', ts: 6, toolUseId: 'c1' });
  const [b] = parseCodexLine(line(7, 'response_item', { type: 'function_call_output', call_id: 'c2', output: 'SECRET-OUTPUT' }));
  assert.deepEqual(b, { kind: 'toolDone', ts: 7, toolUseId: 'c2' });

  const done = parseCodexLine(
    line(8, 'event_msg', {
      type: 'item_completed',
      item: { type: 'CommandExecution', id: 'x1', call_id: 'c3', parsed_cmd: [{ type: 'unknown', cmd: 'npm run build' }], status: 'completed', aggregated_output: 'SECRET-OUTPUT' },
    }),
  );
  assert.equal(done.at(-1).kind, 'toolDone');
  assert.equal(done.at(-1).toolUseId, 'c3');
  assert.equal(done[0].text, 'npm 실행');
  assert.ok(!JSON.stringify(done).includes('SECRET-OUTPUT'));
});

test('codex: spawn, image_gen, web.search, mcp labels', () => {
  const fn = (name, args) => parseCodexLine(line(9, 'response_item', { type: 'function_call', name, call_id: 'f1', arguments: JSON.stringify(args) }));
  const spawn = fn('spawn_agent', { task_name: 'review', message: 'SECRET-PROMPT', agent_type: 'scout' })[0];
  assert.equal(spawn.text, '위임 · review');
  assert.equal(spawn.name, 'Agent');
  assert.ok(!JSON.stringify(spawn).includes('SECRET-PROMPT'));
  assert.equal(fn('spawn_agent', {})[0].text, '위임');
  assert.equal(fn('wait_agent', { targets: ['a'] })[0].text, '동료 기다리는 중');
  for (const n of ['list_agents', 'send_message', 'followup_task']) assert.equal(fn(n, { message: 'SECRET' })[0].text, '동료와 협업');

  const item = (it) => parseCodexLine(line(10, 'event_msg', { type: 'item_completed', item: it }));
  const img = item({ type: 'Extension', kind: 'image_gen.generation', id: 'i1', revisedPrompt: 'SECRET-PROMPT', savedPath: 'C:\\SECRET\\a.png' });
  assert.equal(img[0].text, '그림 그리는 중');
  assert.ok(!JSON.stringify(img).includes('SECRET'));
  assert.equal(item({ type: 'Extension', kind: 'web.search', id: 'w1' })[0].text, '웹 조사 중');
  const mcp = item({ type: 'McpToolCall', id: 'm1', server: 'notion', tool: 'search', arguments: { q: 'SECRET' } });
  assert.equal(mcp[0].text, 'notion 도구 사용');
  assert.ok(!JSON.stringify(mcp).includes('SECRET'));
});

test('codex: reasoning and message become think without text', () => {
  const r = parseCodexLine(line(11, 'response_item', { type: 'reasoning', summary: [], encrypted_content: 'SECRET-BLOB' }));
  const m = parseCodexLine(line(12, 'response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'SECRET-ANSWER' }] }));
  assert.deepEqual(r, [{ kind: 'think', ts: 11 }]);
  assert.deepEqual(m, [{ kind: 'think', ts: 12 }]);
  assert.deepEqual(parseCodexLine(complete(13)), [{ kind: 'end', ts: 13 }]);
  assert.deepEqual(parseCodexLine('garbage'), []);
  assert.deepEqual(parseCodexLine(line(14, 'turn_context', { cwd: 'x' })), []);
});

// ---- CodexSource -----------------------------------------------------------------------------

test('codex: source lists busy session and its subagent', async (t) => {
  const h = fake(t);
  const now = Date.now();
  h.rollout(PARENT_ID, meta(now - 5000, PARENT_ID) + started(now - 4000));
  h.rollout(CHILD_ID, childMeta(now - 3000, CHILD_ID, PARENT_ID, 'scout') + started(now - 2000));
  const r = await new CodexSource(h.cfg).poll(now);
  assert.equal(r.sessions.length, 1);
  const s = r.sessions[0];
  assert.equal(s.provider, 'codex');
  assert.equal(s.pid, 0);
  assert.equal(s.sessionId, PARENT_ID);
  assert.equal(s.status, 'busy');
  assert.equal(s.name, '');
  assert.equal(s.cwd, 'C:\\Project\\storybeginz-frontend');
  const agents = r.agents.get(PARENT_ID);
  assert.equal(agents.length, 1);
  assert.equal(agents[0].agentId, CHILD_ID);
  assert.equal(agents[0].agentType, 'codex:scout');
  assert.equal(agents[0].description, 'find files');
  assert.equal(agents[0].finished, false);
  assert.ok(r.agentEvents.has(`${PARENT_ID}/${CHILD_ID}`));
  assert.deepEqual(r.sessionEvents.get(PARENT_ID).filter((e) => e.kind === 'title'), [{ kind: 'title', ts: 0, title: 'storybeginz-frontend' }]);
});

test('codex: exec session title, finished subagent and unknown role', async (t) => {
  const h = fake(t);
  const now = Date.now();
  h.rollout(EXEC_ID, meta(now - 5000, EXEC_ID, { source: 'exec', originator: 'codex_exec', cwd: 'C:\\Project\\billing-app' }) + started(now - 4000));
  h.rollout(CHILD_ID, childMeta(now - 3000, CHILD_ID, EXEC_ID, null, '/root/x') + started(now - 2000) + complete(now - 1000));
  h.rollout('44444444-4444-4444-8444-444444444444', childMeta(now - 3000, '44444444-4444-4444-8444-444444444444', 'ffffffff-ffff-4fff-8fff-ffffffffffff') + started(now - 2000));
  const r = await new CodexSource(h.cfg).poll(now);
  assert.equal(r.sessions.length, 1, 'orphan subagent is ignored, not a floor');
  assert.equal(r.sessionEvents.get(EXEC_ID).find((e) => e.kind === 'title').title, 'codex exec · billing-app');
  assert.equal(r.agents.get(EXEC_ID).length, 1);
  assert.equal(r.agents.get(EXEC_ID)[0].agentType, 'codex:__default');
  assert.equal(r.agents.get(EXEC_ID)[0].finished, true);
});

test('codex: finished exec session drops after execKeepMs', async (t) => {
  const h = fake(t);
  const now = Date.now();
  h.rollout(EXEC_ID, meta(now - 5000, EXEC_ID, { source: 'exec', originator: 'codex_exec' }) + started(now - 4000) + complete(now - 3000));
  const src = new CodexSource(h.cfg);
  const first = await src.poll(now);
  assert.equal(first.sessions.length, 1);
  assert.equal(first.sessions[0].status, 'waiting');
  const edge = await src.poll(now - 3000 + h.cfg.codex.execKeepMs);
  assert.equal(edge.sessions.length, 1);
  const late = await src.poll(now - 3000 + h.cfg.codex.execKeepMs + 1);
  assert.equal(late.sessions.length, 0);
});

test('codex: interactive session stays listed for idleKeepMs', async (t) => {
  const h = fake(t);
  const now = Date.now();
  h.rollout(PARENT_ID, meta(now - 5000, PARENT_ID) + started(now - 4000) + complete(now - 3000));
  const src = new CodexSource(h.cfg);
  assert.equal((await src.poll(now - 3000 + h.cfg.codex.execKeepMs + 1)).sessions.length, 1);
  assert.equal((await src.poll(now - 3000 + h.cfg.codex.idleKeepMs + 1)).sessions.length, 0);
});

test('codex: startedAt is stable across turns while listed', async (t) => {
  const h = fake(t);
  const now = Date.now();
  const file = h.rollout(PARENT_ID, meta(now - 9000, PARENT_ID) + started(now - 8000) + complete(now - 7000));
  const src = new CodexSource(h.cfg);
  const a = (await src.poll(now - 6000)).sessions[0];
  appendFileSync(file, started(now - 3000));
  const b = (await src.poll(now - 2000)).sessions[0];
  appendFileSync(file, complete(now - 1000) + started(now - 500));
  const c = (await src.poll(now)).sessions[0];
  assert.equal(a.startedAt, now - 9000, 'first line of the period');
  assert.equal(b.startedAt, a.startedAt);
  assert.equal(c.startedAt, a.startedAt);

  // dropped after the keep time, then active again: a new period starts
  const gone = await src.poll(now + h.cfg.codex.idleKeepMs * 2);
  assert.equal(gone.sessions.length, 0);
});

test('codex: a restarted period gets a new startedAt after the session was dropped', async (t) => {
  const h = fake(t);
  const now = Date.now();
  const file = h.rollout(PARENT_ID, meta(now - 9000, PARENT_ID) + started(now - 8000) + complete(now - 7000));
  const src = new CodexSource(h.cfg);
  const first = (await src.poll(now - 6000)).sessions[0];
  assert.equal((await src.poll(now + h.cfg.codex.idleKeepMs)).sessions.length, 0);
  const later = now + h.cfg.codex.idleKeepMs + 5000;
  appendFileSync(file, started(later - 1000));
  const again = (await src.poll(later)).sessions[0];
  assert.equal(again.startedAt, later - 1000);
  assert.notEqual(again.startedAt, first.startedAt);
});

test('codex: startedAt on first read is the start of the last active period', async (t) => {
  const h = fake(t);
  const now = Date.now();
  const long = h.cfg.codex.idleKeepMs * 3;
  h.rollout(PARENT_ID, meta(now - long, PARENT_ID) + started(now - long + 1000) + complete(now - long + 2000) + started(now - 10000) + ev(now - 9000, 'token_count'));
  const s = (await new CodexSource(h.cfg).poll(now)).sessions[0];
  assert.equal(s.startedAt, now - 10000);
});

test('codex: parent stays listed while a subagent is busy', async (t) => {
  const h = fake(t);
  const now = Date.now();
  h.rollout(PARENT_ID, meta(now - 9000, PARENT_ID) + started(now - 8000) + complete(now - 7000));
  const child = h.rollout(CHILD_ID, childMeta(now - 6000, CHILD_ID, PARENT_ID) + started(now - 5000) + complete(now - 4000));
  const src = new CodexSource(h.cfg);
  const late = now + h.cfg.codex.idleKeepMs + 1;
  assert.equal((await src.poll(late)).sessions.length, 0);
  appendFileSync(child, started(late));
  const r = await src.poll(late + 1);
  assert.equal(r.sessions.length, 1);
  assert.equal(r.agents.get(PARENT_ID)[0].finished, false);
});

test('codex: only today and yesterday rollouts are opened, nothing else', async (t) => {
  const h = fake(t);
  const now = Date.now();
  const day = (n) => new Date(new Date(now).getFullYear(), new Date(now).getMonth(), new Date(now).getDate() - n);
  h.rollout(PARENT_ID, meta(now - 5000, PARENT_ID) + started(now - 4000), day(0));
  h.rollout(EXEC_ID, meta(now - 5000, EXEC_ID, { source: 'exec', originator: 'codex_exec' }) + started(now - 4000), day(1));
  h.rollout('55555555-5555-4555-8555-555555555555', meta(now - 5000, '55555555-5555-4555-8555-555555555555') + started(now - 4000), day(2));
  writeFileSync(join(h.dir, 'auth.json'), '{"token":"SECRET"}');
  writeFileSync(join(h.dir, 'history.jsonl'), meta(now, 'history-secret'));
  writeFileSync(join(h.dir, 'sessions', 'stray.jsonl'), meta(now, 'stray'));
  const r = await new CodexSource(h.cfg).poll(now);
  assert.deepEqual(r.sessions.map((s) => s.sessionId).sort(), [EXEC_ID, PARENT_ID].sort());
  assert.ok(!JSON.stringify([...r.sessionEvents]).includes('SECRET'));
});

test('codex: missing codex home and disabled source are silent', async (t) => {
  const h = fake(t, { codex: { enabled: false } });
  h.rollout(PARENT_ID, meta(Date.now(), PARENT_ID) + started(Date.now()));
  assert.equal((await new CodexSource(h.cfg).poll(Date.now())).sessions.length, 0);
  const cfg = loadConfig();
  cfg.codexHome = join(h.dir, 'nope');
  assert.equal((await new CodexSource(cfg).poll(Date.now())).sessions.length, 0);
});

test('codex: an idle poll reads nothing', async (t) => {
  const h = fake(t);
  const now = Date.now();
  const file = h.rollout(PARENT_ID, meta(now - 5000, PARENT_ID) + started(now - 4000));
  const src = new CodexSource(h.cfg);
  await src.poll(now);
  const before = src.bytesRead;
  assert.ok(before > 0);
  const r = await src.poll(now + 1500);
  assert.equal(src.bytesRead, before);
  assert.equal(r.sessions.length, 1);
  assert.equal(r.sessionEvents.size, 0, 'events are delivered once');
  appendFileSync(file, complete(now + 1000));
  await src.poll(now + 3000);
  assert.ok(src.bytesRead > before);
});

// ---- Office ----------------------------------------------------------------------------------

test('office: codex floor uses 하나·팀장 and 도담 for worker', () => {
  const cfg = loadConfig();
  const office = new Office(cfg, EMPTY);
  const T = 1793170000000;
  office.syncSessions([{ provider: 'codex', pid: 0, sessionId: 'cx', cwd: 'C:\\Project\\a', status: 'busy', name: '', startedAt: T }], T);
  office.syncAgents('cx', [
    { agentId: 'a1', agentType: 'codex:worker', description: '개발', finished: false, transcriptPath: '', mtimeMs: T, workflow: null },
    { agentId: 'a2', agentType: 'codex:worker', description: '개발2', finished: false, transcriptPath: '', mtimeMs: T, workflow: null },
    { agentId: 'a3', agentType: 'codex:mystery', description: '', finished: false, transcriptPath: '', mtimeMs: T, workflow: null },
    { agentId: 'a4', agentType: 'codex:__default', description: '', finished: false, transcriptPath: '', mtimeMs: T, workflow: null },
    { agentId: 'a5', agentType: 'worker', description: '', finished: false, transcriptPath: '', mtimeMs: T, workflow: null },
  ], T);
  const f = office.snapshot().floors[0];
  assert.equal(f.provider, 'codex');
  assert.deepEqual([f.lead.name, f.lead.role], ['하나', '팀장']);
  const byId = Object.fromEntries(f.agents.map((a) => [a.agentId, a]));
  assert.deepEqual([byId.a1.name, byId.a1.role], ['도담', '개발']);
  assert.equal(byId.a2.name, '도담+1');
  assert.equal(byId.a3.name, '누리');
  assert.equal(byId.a4.name, '누리+1');
  assert.equal(byId.a5.name, '누리+2', 'a Claude role name is not a Codex role');

  office.syncSessions([{ provider: 'claude', pid: 1, sessionId: 'cl', cwd: 'C:\\Project\\b', status: 'busy', name: '', startedAt: T + 1 }], T + 1);
  office.syncAgents('cl', [{ agentId: 'c1', agentType: 'codex:worker', description: '', finished: false, transcriptPath: '', mtimeMs: T, workflow: null }], T + 1);
  const cl = office.snapshot().floors.find((x) => x.sessionId === 'cl');
  assert.equal(cl.lead.name, '유나');
  assert.equal(cl.agents[0].name, '나래', 'a Codex role name is not a Claude role');
});

// ---- Poller ----------------------------------------------------------------------------------

/** Poller over a fake claude home (one live session `cl1`) and a fake codex home. */
function withBoth(t, overrides = {}) {
  const h = fake(t, overrides);
  const claudeHome = mkdtempSync(join(tmpdir(), 'codex-claude-'));
  t.after(() => rmSync(claudeHome, { recursive: true, force: true }));
  mkdirSync(join(claudeHome, 'sessions'));
  mkdirSync(join(claudeHome, 'projects', 'P'), { recursive: true });
  h.cfg.claudeHome = claudeHome;
  writeFileSync(
    join(claudeHome, 'sessions', `${process.pid}.json`),
    JSON.stringify({ pid: process.pid, sessionId: 'cl1', cwd: 'C:\\Project\\app', status: 'busy', name: '', startedAt: 1793170000000 }),
  );
  writeFileSync(join(claudeHome, 'projects', 'P', 'cl1.jsonl'), '');
  const office = new Office(h.cfg, EMPTY);
  return { ...h, office, poller: new Poller(h.cfg, office) };
}

test('poller: claude and codex sessions merge into one sync', async (t) => {
  const h = withBoth(t);
  const now = Date.now();
  h.rollout(EXEC_ID, meta(now - 5000, EXEC_ID, { source: 'exec', originator: 'codex_exec', cwd: 'C:\\Project\\billing-app' }) + started(now - 4000));
  h.rollout(CHILD_ID, childMeta(now - 3000, CHILD_ID, EXEC_ID, 'worker') + started(now - 2000)
    + line(now - 1000, 'response_item', { type: 'custom_tool_call', name: 'exec', call_id: 'c1', input: 'await tools.exec_command({cmd:"git status"})' }));
  const syncs = [];
  const orig = h.office.syncSessions.bind(h.office);
  h.office.syncSessions = (live, n) => { syncs.push(live.map((s) => s.provider).sort()); return orig(live, n); };
  await h.poller.tick(now);
  assert.deepEqual(syncs, [['claude', 'codex']], 'one sync with both providers');
  const floors = h.office.snapshot().floors;
  assert.deepEqual(floors.map((f) => f.provider).sort(), ['claude', 'codex']);
  const cx = floors.find((f) => f.provider === 'codex');
  assert.equal(cx.title, 'codex exec · billing-app');
  assert.equal(cx.status, 'busy');
  assert.equal(cx.lead.name, '하나');
  assert.equal(cx.agents.length, 1);
  assert.equal(cx.agents[0].name, '도담');
  assert.equal(cx.agents[0].bubble, 'git 실행');
});

test('poller: codex floor leaves after execKeepMs and missTicks', async (t) => {
  const h = withBoth(t);
  const now = Date.now();
  h.rollout(EXEC_ID, meta(now - 5000, EXEC_ID, { source: 'exec', originator: 'codex_exec' }) + started(now - 4000) + complete(now - 3000));
  await h.poller.tick(now);
  assert.equal(h.office.snapshot().floors.length, 2);
  let n = now - 3000 + h.cfg.codex.execKeepMs + 1;
  for (let i = 0; i < h.cfg.floor.missTicks; i++) await h.poller.tick((n += 1500));
  const f = h.office.snapshot().floors.find((x) => x.provider === 'codex');
  assert.equal(f.status, 'leaving');
});

test('poller: forced hide holds for a codex session across turns', async (t) => {
  const h = withBoth(t);
  const now = Date.now();
  const file = h.rollout(PARENT_ID, meta(now - 9000, PARENT_ID) + started(now - 8000) + complete(now - 7000));
  await h.poller.tick(now);
  assert.equal(h.office.hide(PARENT_ID), true);
  assert.equal(h.office.snapshot().floors.some((f) => f.provider === 'codex'), false);
  appendFileSync(file, started(now + 1000) + complete(now + 2000) + started(now + 3000));
  await h.poller.tick(now + 4000);
  assert.equal(h.office.snapshot().floors.some((f) => f.provider === 'codex'), false, 'still hidden after new turns');
  assert.equal(h.office.queryLog({ sessionId: PARENT_ID }).length, 0);
});

// ---- fix round 1 -----------------------------------------------------------------------------

test('codex: startedAt after restart matches long-running value for a rollout larger than startBytes', async (t) => {
  const h = fake(t, { tail: { startBytes: 2000 } });
  const now = Date.now();
  const first = meta(now - 60000, PARENT_ID) + started(now - 59000);
  const file = h.rollout(PARENT_ID, first);
  const running = new CodexSource(h.cfg); // sees the file from its first line on
  assert.equal((await running.poll(now - 30000)).sessions[0].startedAt, now - 60000);
  let filler = '';
  for (let i = 0; i < 40; i++) filler += ev(now - 58000 + i * 100, 'token_count', { info: null });
  appendFileSync(file, filler);
  assert.ok(Buffer.byteLength(first + filler) > h.cfg.tail.startBytes * 2);
  const longRunning = (await running.poll(now)).sessions[0].startedAt;
  const restarted = (await new CodexSource(h.cfg).poll(now)).sessions[0].startedAt; // window starts mid-file
  assert.equal(longRunning, now - 60000);
  assert.equal(restarted, longRunning);
});

test('codex: a finished, unlisted rollout holds no FileTail and resumes from its offset', async (t) => {
  const h = fake(t);
  const now = Date.now();
  const file = h.rollout(EXEC_ID, meta(now - 5000, EXEC_ID, { source: 'exec', originator: 'codex_exec' }) + started(now - 4000) + complete(now - 3000));
  const src = new CodexSource(h.cfg);
  await src.poll(now);
  assert.equal(src.tailCount, 1, 'listed rollout keeps its tail');
  const gone = now - 3000 + h.cfg.codex.execKeepMs + 1;
  assert.equal((await src.poll(gone)).sessions.length, 0);
  assert.equal(src.tailCount, 0, 'finished and unlisted: tail released');

  const more = started(gone + 500);
  appendFileSync(file, more);
  const before = src.bytesRead;
  const r = await src.poll(gone + 1000);
  assert.equal(src.bytesRead - before, Buffer.byteLength(more), 'only the appended bytes are read');
  assert.equal(r.sessions.length, 1);
  assert.equal(r.sessions[0].startedAt, gone + 500, 'a new period');
  assert.equal(r.sessionEvents.get(EXEC_ID).filter((e) => e.kind === 'end').length, 0, 'nothing is replayed');
  assert.equal(src.tailCount, 1);
});

test('codex: a rollout that is a directory or a symlink is never watched', async (t) => {
  const h = fake(t);
  const now = Date.now();
  h.rollout(PARENT_ID, meta(now - 5000, PARENT_ID) + started(now - 4000));
  const d = new Date(now);
  const pad = (n) => String(n).padStart(2, '0');
  const day = join(h.dir, 'sessions', String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate()));
  mkdirSync(join(day, 'rollout-2026-10-28T00-00-00-folder.jsonl'));
  const target = join(h.dir, 'real.txt');
  writeFileSync(target, meta(now - 5000, EXEC_ID) + started(now - 4000));
  try {
    symlinkSync(target, join(day, `rollout-2026-10-28T00-00-01-${EXEC_ID}.jsonl`));
  } catch {
    // symlinks need a privilege on some Windows setups: the folder case above still runs
  }
  const r = await new CodexSource(h.cfg).poll(now);
  assert.deepEqual(r.sessions.map((s) => s.sessionId), [PARENT_ID]);
});

test('codex: item_completed with only item.id leaves nothing in working', async (t) => {
  const h = withBoth(t);
  const now = Date.now();
  const call = (id) => line(now - 3000, 'response_item', { type: 'custom_tool_call', name: 'exec', call_id: id, input: 'await tools.exec_command({cmd:"git status"})' });
  const item = line(now - 2000, 'event_msg', { type: 'item_completed', item: { type: 'CommandExecution', id: 'exec-uuid-1', parsed_cmd: [{ type: 'unknown', cmd: 'git status' }], status: 'completed' } });
  const output = (id) => line(now - 1000, 'response_item', { type: 'custom_tool_call_output', call_id: id, output: 'x' });
  // real order: call, item_completed (own id, no call_id), output
  h.rollout(EXEC_ID, meta(now - 5000, EXEC_ID, { source: 'exec', originator: 'codex_exec' }) + started(now - 4000) + call('c1') + item + output('c1'));
  // item_completed alone, without the output line
  h.rollout(PARENT_ID, meta(now - 5000, PARENT_ID) + started(now - 4000) + call('c2') + item);
  await h.poller.tick(now);
  const floors = h.office.snapshot().floors.filter((f) => f.provider === 'codex');
  assert.equal(floors.length, 2);
  for (const f of floors) {
    assert.notEqual(f.lead.state, 'working', f.title);
    assert.equal(f.lead.bubble, '생각 중…');
  }
});

test('codex: a hidden floor with a busy sub-agent shows neither the agent nor its events', async (t) => {
  const h = withBoth(t);
  const now = Date.now();
  const toolCall = (ms, cmd) => line(ms, 'response_item', { type: 'custom_tool_call', name: 'exec', call_id: `c${ms}`, input: `await tools.exec_command({cmd:"${cmd}"})` });
  h.rollout(PARENT_ID, meta(now - 9000, PARENT_ID) + started(now - 8000));
  const child = h.rollout(CHILD_ID, childMeta(now - 7000, CHILD_ID, PARENT_ID, 'worker') + started(now - 6000) + toolCall(now - 5000, 'git status'));
  await h.poller.tick(now);
  assert.equal(h.office.snapshot().floors.find((f) => f.provider === 'codex').agents.length, 1);
  assert.ok(h.office.queryLog({ sessionId: PARENT_ID }).length > 0, 'the agent start is logged while visible');

  assert.equal(h.office.hide(PARENT_ID), true);
  appendFileSync(child, toolCall(now + 500, 'npm install'));
  const second = '66666666-6666-4666-8666-666666666666';
  h.rollout(second, childMeta(now + 600, second, PARENT_ID, 'scout', '/root/more') + started(now + 700) + toolCall(now + 800, 'ls'));
  await h.poller.tick(now + 1500);

  const snap = JSON.stringify(h.office.snapshot());
  for (const needle of [PARENT_ID, CHILD_ID, second, 'codex', 'npm', 'git', '도담', '별이']) assert.ok(!snap.includes(needle), `snapshot: ${needle}`);
  assert.equal(h.office.queryLog({ sessionId: PARENT_ID }).length, 0);
  assert.equal(h.office.queryLog().filter((e) => e.sessionId === PARENT_ID).length, 0);
  assert.equal(h.office.drainLog().filter((e) => e.sessionId === PARENT_ID).length, 0);
});

// ---- fix round 2 -----------------------------------------------------------------------------

test('codex: cwdMaxChars is applied, so a deep folder name is not cut at 80 chars', async (t) => {
  const h = fake(t);
  const now = Date.now();
  const folder = 'b'.repeat(60);
  const cwd = `C:/Project/${'a'.repeat(60)}/${folder}`;
  assert.ok(cwd.length > 80 && cwd.length < h.cfg.codex.cwdMaxChars);
  h.rollout(PARENT_ID, meta(now - 5000, PARENT_ID, { cwd }) + started(now - 4000));
  const r = await new CodexSource(h.cfg).poll(now);
  assert.equal(r.sessions[0].cwd, cwd);
  assert.equal(r.sessionEvents.get(PARENT_ID).find((e) => e.kind === 'title').title, folder);
  assert.throws(() => parseCodexMeta(fixture('meta-exec.jsonl')), TypeError, 'the limit is required');
  const capped = parseCodexMeta(fixture('meta-exec.jsonl'), 10);
  assert.equal(capped.cwd.length, 10);
});

test('codex: quoted env values never leak a word into the label', () => {
  const start = (cmd) =>
    parseCodexLine(line(5, 'response_item', { type: 'custom_tool_call', name: 'exec', call_id: 'c1', input: `await tools.exec_command({cmd:${JSON.stringify(cmd)}})` }));
  const done = (cmd) => parseCodexLine(line(8, 'event_msg', { type: 'item_completed', item: { type: 'CommandExecution', id: 'x', parsed_cmd: [{ cmd }] } }))[0];
  for (const cmd of ['TOKEN="a hunter2 c" git', "TOKEN='a hunter2 c' git"]) {
    for (const e of [start(cmd)[0], done(cmd)]) {
      assert.equal(e.text, '명령 실행', cmd);
      assert.ok(!JSON.stringify(e).includes('hunter2'));
    }
  }
  assert.equal(start('FOO=bar git push')[0].text, 'git 실행');
  assert.equal(done('FOO=bar git push').text, 'git 실행');
});
