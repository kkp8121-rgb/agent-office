// Demo feeder: builds a fake ~/.claude (two sessions) and keeps feeding it so the office has something to show.
//   node scripts/demo-feed.mjs <tmpHome>
//   AGENT_OFFICE_CLAUDE_HOME=<tmpHome> AGENT_OFFICE_CODEX_HOME=<empty dir> AGENT_OFFICE_PORT=47811 node server/main.mjs
// Every 2 s: tool lines, new subagents, finished subagents. To simulate "run the session again" (same sessionId,
// new process), write the sessionId into <tmpHome>/rerun.txt. The sessions' pids are child processes of this script;
// they are stopped when the script exits (and they exit by themselves if this script is killed).
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const home = process.argv[2];
if (!home) {
  console.error('사용법: node scripts/demo-feed.mjs <tmpHome>');
  process.exit(1);
}
const TICK_MS = 2000;
const SPAWN_EVERY = 3; // ticks between new subagents
const MAX_ALIVE = 5;
const LIFE_TICKS = [9, 12, 7, 14, 10]; // how long each subagent lives, in turn

const SESSIONS = [
  {
    id: 'demo-session-a', project: 'C--Project', cwd: 'C:\\Project', title: '에이전트 사무실 만들기',
    agents: [['worker', '기록 읽기'], ['scout', '코드 찾기'], ['code-critic', '변경 검토'], ['Explore', '구조 파악'], ['architect', '설계 검토']],
  },
  {
    id: 'demo-session-b', project: 'C--work-teazr-frontend', cwd: 'C:\\work\\teazr-frontend', title: '결제 화면 점검',
    agents: [['frontend', '결제 화면'], ['worker-high', '빌드 확인'], ['backend', 'API 확인'], ['Plan', '계획 정리']],
  },
];
const TOOLS = [
  ['Read', { file_path: 'C:\\Project\\src\\PostController.cs' }],
  ['Grep', { pattern: 'subagent' }],
  ['Bash', { command: 'npm run build', description: '프론트 빌드 확인' }],
  ['Edit', { file_path: 'C:\\Project\\src\\ReelsLayout.tsx' }],
  ['Glob', { pattern: '**/*.tsx' }],
  ['Read', { file_path: 'C:\\Project\\docs\\plan.md' }],
  ['Write', { file_path: 'C:\\Project\\web\\app.js' }],
];

const nowIso = () => new Date().toISOString();
const line = (obj) => `${JSON.stringify(obj)}\n`;
const toolLine = (id, [name, input]) =>
  line({ type: 'assistant', timestamp: nowIso(), message: { content: [{ type: 'tool_use', id, name, input }], stop_reason: null } });
const doneLine = (id) =>
  line({ type: 'user', timestamp: nowIso(), message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });
const endLine = () =>
  line({ type: 'assistant', timestamp: nowIso(), message: { content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn' } });

// ---- session processes ----

const children = new Set();
const WATCHDOG = (parent) => `setInterval(()=>{try{process.kill(${parent},0)}catch{process.exit(0)}},1000)`;

function spawnSessionProcess() {
  const child = spawn(process.execPath, ['-e', WATCHDOG(process.pid)], { stdio: 'ignore', windowsHide: true });
  children.add(child);
  child.on('exit', () => children.delete(child));
  return child;
}

function stopChildren() {
  for (const c of children) {
    try {
      process.kill(c.pid); // own child, by its own pid
    } catch {
      // already gone
    }
  }
  children.clear();
}
process.on('exit', stopChildren);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(sig, () => process.exit(0));

// ---- fake ~/.claude ----

mkdirSync(join(home, 'sessions'), { recursive: true });

function writeSessionFile(s) {
  rmSync(s.file ?? '', { force: true });
  s.file = join(home, 'sessions', `${s.child.pid}.json`);
  writeFileSync(s.file, JSON.stringify({ pid: s.child.pid, sessionId: s.id, cwd: s.cwd, status: 'busy', name: '', startedAt: s.startedAt }));
}

function startSession(def, index) {
  const s = { ...def, index, tick: 0, nextAgent: 0, agents: [], defs: def.agents, toolNo: index * 3, lifeNo: 0 };
  s.dir = join(home, 'projects', def.project);
  s.sessionDir = join(s.dir, def.id);
  s.transcript = join(s.dir, `${def.id}.jsonl`);
  mkdirSync(join(s.sessionDir, 'subagents'), { recursive: true });
  writeFileSync(s.transcript, line({ type: 'ai-title', sessionId: def.id, aiTitle: def.title }));
  s.child = spawnSessionProcess();
  s.startedAt = Date.now() - index * 60000;
  writeSessionFile(s);
  return s;
}

function rerun(s) {
  const old = s.child;
  s.child = spawnSessionProcess();
  s.startedAt = Date.now();
  writeSessionFile(s);
  try {
    process.kill(old.pid);
  } catch {
    // already gone
  }
  console.log(`다시 실행: ${s.id} pid ${s.child.pid}`);
}

function nextTool(s) {
  return TOOLS[s.toolNo++ % TOOLS.length];
}

function spawnAgent(s) {
  const [type, description] = s.defs[s.nextAgent++ % s.defs.length];
  const agentId = `${s.id.slice(-1)}${String(s.nextAgent).padStart(3, '0')}`;
  const base = join(s.sessionDir, 'subagents', `agent-${agentId}`);
  const a = { agentId, base, type, description, age: 0, life: LIFE_TICKS[s.lifeNo++ % LIFE_TICKS.length], calls: 0, open: null };
  writeFileSync(`${base}.meta.json`, JSON.stringify({ agentType: type, description, finished: false }));
  writeFileSync(`${base}.jsonl`, '');
  s.agents.push(a);
  appendFileSync(s.transcript, toolLine(`toolu_main_${s.tick}`, ['Agent', { subagent_type: type, description }]));
}

function stepAgent(s, a) {
  a.age++;
  if (a.age >= a.life) {
    appendFileSync(`${a.base}.jsonl`, endLine());
    writeFileSync(`${a.base}.meta.json`, JSON.stringify({ agentType: a.type, description: a.description, finished: true }));
    return false;
  }
  if (a.open) {
    appendFileSync(`${a.base}.jsonl`, doneLine(a.open)); // tool finished: the character thinks for a tick
    a.open = null;
  } else {
    a.open = `toolu_${a.agentId}_${a.calls++}`;
    appendFileSync(`${a.base}.jsonl`, toolLine(a.open, nextTool(s)));
  }
  return true;
}

function step(s) {
  s.tick++;
  if (s.tick % 2 === 1) appendFileSync(s.transcript, toolLine(`toolu_lead_${s.tick}`, nextTool(s)));
  else appendFileSync(s.transcript, line({ type: 'assistant', timestamp: nowIso(), message: { content: [{ type: 'thinking', thinking: '' }], stop_reason: null } }));
  if (s.tick % SPAWN_EVERY === 1 && s.agents.length < MAX_ALIVE) spawnAgent(s);
  s.agents = s.agents.filter((a) => stepAgent(s, a));
}

const sessions = SESSIONS.map(startSession);

function checkRerun() {
  const file = join(home, 'rerun.txt');
  let id;
  try {
    id = readFileSync(file, 'utf8').trim();
    rmSync(file, { force: true });
  } catch {
    return;
  }
  const s = sessions.find((x) => x.id === id);
  if (s) rerun(s);
}

console.log(`시연기 시작 (pid ${process.pid}) — 가짜 홈: ${home}`);
for (const s of sessions) console.log(`  세션 ${s.id} pid ${s.child.pid}`);
setInterval(() => {
  checkRerun();
  for (const s of sessions) step(s);
}, TICK_MS);
