// Sessions opened from the desktop apps: titles (custom-title, session_index.jsonl), origin chip, scratch workdir,
// and the privacy of the new Codex meta fields.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../server/config.mjs';
import { Office } from '../server/office.mjs';
import { Poller } from '../server/poller.mjs';
import { createServer } from '../server/http.mjs';
import { parseLine } from '../server/parse.mjs';
import { parseCodexMeta } from '../server/codex.mjs';
import { CodexIndex } from '../server/codex-index.mjs';

const EMPTY = { hidden: [], names: {} };
const iso = (ms) => new Date(ms).toISOString();
const pad = (n) => String(n).padStart(2, '0');
const CWD_MAX = loadConfig().codex.cwdMaxChars;

// ---- parse ----------------------------------------------------------------------------------

test('parse: custom-title is a title that outranks ai-title; agent-name is ignored', () => {
  assert.deepEqual(parseLine('{"type":"custom-title","customTitle":"안녕"}'), [{ kind: 'title', ts: 0, title: '안녕', rank: 2 }]);
  assert.deepEqual(parseLine('{"type":"agent-name","agentName":"안녕"}'), []);
  assert.deepEqual(parseLine('{"type":"custom-title","customTitle":""}'), []);
  assert.deepEqual(parseLine('{"type":"custom-title","customTitle":5}'), []);
  assert.equal(parseLine(JSON.stringify({ type: 'custom-title', customTitle: 'x'.repeat(500) }))[0].title.length, loadConfig().parse.nameMaxChars);
});

test('parse: only entrypoint claude-desktop yields an origin event, and never copies other fields', () => {
  const line = (entrypoint) => JSON.stringify({ type: 'attachment', entrypoint, userType: 'external', promptSource: 'sdk', cwd: 'C:\\SECRET' });
  assert.deepEqual(parseLine(line('claude-desktop')), [{ kind: 'origin', ts: 0, origin: 'claudeApp' }]);
  assert.deepEqual(parseLine(line('cli')), []);
  assert.deepEqual(parseLine(line(undefined)), []);
  const withTool = JSON.stringify({ type: 'assistant', entrypoint: 'claude-desktop', message: { content: [{ type: 'thinking' }] } });
  assert.deepEqual(parseLine(withTool).map((e) => e.kind), ['origin', 'think']);
});

// ---- office ---------------------------------------------------------------------------------

const SCRATCH = 'C:\\Users\\u\\AppData\\Local\\Claude\\Data\\claude-ab12\\scratch-workspaces\\11111111-2222-3333-4444-555555555555-66666666\\scratch-2026-11-02-6e8277';
const live = (id, cwd, extra = {}) => ({ provider: 'claude', pid: 1, sessionId: id, cwd, status: 'busy', name: '', startedAt: 1000, ...extra });

function office(sessions) {
  const o = new Office(loadConfig(), EMPTY);
  o.syncSessions(sessions, 2000);
  return o;
}
const floor = (o, id) => o.snapshot().floors.find((f) => f.sessionId === id);

test('office: custom-title wins over ai-title in either order; an ai-title cannot replace it', () => {
  const o = office([live('s1', 'C:\\work\\proj')]);
  o.applySessionEvents('s1', [{ kind: 'title', ts: 0, title: 'AI 제목' }], 2100);
  assert.equal(floor(o, 's1').title, 'AI 제목');
  o.applySessionEvents('s1', [{ kind: 'title', ts: 0, title: '안녕', rank: 2 }], 2200);
  assert.equal(floor(o, 's1').title, '안녕');
  o.applySessionEvents('s1', [{ kind: 'title', ts: 0, title: '나중 AI 제목' }], 2300);
  assert.equal(floor(o, 's1').title, '안녕');
  o.applySessionEvents('s1', [{ kind: 'title', ts: 0, title: '바뀐 이름', rank: 2 }], 2400);
  assert.equal(floor(o, 's1').title, '바뀐 이름');
});

test('office: the desktop app scratch folder is not shown as workdir; a normal folder is', () => {
  const o = office([live('app', SCRATCH), live('cli', 'C:\\work\\scratch-2026-11-02-6e8277'), live('lookalike', 'C:\\Claude\\Data\\x\\scratch-2026-11-02-6e8277')]);
  const app = floor(o, 'app');
  assert.equal(app.folder, '');
  assert.equal(app.title, '새 대화'); // no title yet: not the folder name
  assert.equal(floor(o, 'cli').folder, 'scratch-2026-11-02-6e8277');
  assert.equal(floor(o, 'lookalike').folder, 'scratch-2026-11-02-6e8277'); // no scratch-workspaces level
  o.applySessionEvents('app', [{ kind: 'title', ts: 0, title: '안녕', rank: 2 }], 2100);
  assert.equal(floor(o, 'app').title, '안녕');
});

test('office: origin comes from events (Claude) or the session (Codex); CLI floors have none', () => {
  const o = office([live('a', 'C:\\w'), live('b', 'C:\\w'), live('c', 'C:\\w', { provider: 'codex', origin: 'codexWork' })]);
  o.applySessionEvents('a', [{ kind: 'origin', ts: 0, origin: 'claudeApp' }], 2100);
  assert.deepEqual(['a', 'b', 'c'].map((id) => floor(o, id).origin), ['claudeApp', '', 'codexWork']);
  // a sub-agent line of the same app must not disturb the sub-agent's state
  o.applyAgentEvents('a', 'nobody', [{ kind: 'origin', ts: 0, origin: 'claudeApp' }], 2200);
});

test('config: chip and counter strings live in config.json ui', () => {
  const { ui } = loadConfig();
  assert.deepEqual(Object.keys(ui.origin).sort(), ['claudeApp', 'codexApp', 'codexWork']);
  assert.equal(ui.origin.codexWork, 'Codex 앱 · Work');
  assert.ok(ui.reportsTitle.includes('{n}') && ui.reportsTitle.includes('일꾼'));
});

// ---- codex meta ----------------------------------------------------------------------------

test('codex meta: originator maps to the app origin and nothing else is kept', () => {
  const id = '99999999-9999-4999-8999-999999999999';
  const meta = (originator) => parseCodexMeta(JSON.stringify({ type: 'session_meta', payload: {
    id, cwd: 'C:\\d', originator, source: 'vscode', creator_user_id: 'U-SECRET', creator_account_id: 'A-SECRET', base_instructions: { text: 'SECRET-INSTRUCTIONS' },
  } }), CWD_MAX);
  assert.equal(meta('codex_work_desktop').origin, 'codexWork');
  assert.equal(meta('Codex Desktop').origin, 'codexApp');
  assert.equal(meta('codex_cli_rs').origin, '');
  assert.equal(meta('codex_exec').origin, '');
  assert.ok(!JSON.stringify(meta('Codex Desktop')).includes('SECRET'));
});

// ---- session_index.jsonl -------------------------------------------------------------------

const ID1 = '11111111-1111-4111-8111-111111111111';
const ID2 = '22222222-2222-4222-8222-222222222222';
const row = (id, name) => JSON.stringify({ id, thread_name: name, updated_at: '2026-11-02T00:00:00Z' }) + '\n';

test('session_index: reads appends only, latest line wins, partial line waits, shrink/replace rereads', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cxindex-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'session_index.jsonl');
  const idx = new CodexIndex(file);
  await idx.poll(); // missing file: nothing, no throw
  assert.equal(idx.names.size, 0);

  writeFileSync(file, row(ID1, '첫 이름') + 'not json\n' + row('../evil', 'x') + row(ID2, 'a\u202Eb\nc'));
  await idx.poll();
  assert.equal(idx.names.get(ID1), '첫 이름');
  assert.equal(idx.names.get(ID2), 'a b c');
  assert.equal(idx.names.size, 2);

  appendFileSync(file, row(ID1, '바뀐 이름').slice(0, 20)); // half a line
  await idx.poll();
  assert.equal(idx.names.get(ID1), '첫 이름');
  appendFileSync(file, row(ID1, '바뀐 이름').slice(20));
  await idx.poll();
  assert.equal(idx.names.get(ID1), '바뀐 이름');

  writeFileSync(file, row(ID2, '새 파일')); // shorter: read again from the start
  await idx.poll();
  assert.deepEqual([...idx.names], [[ID2, '새 파일']]);

  rmSync(file);
  await idx.poll();
  assert.equal(idx.names.size, 0);
});

test('session_index: an append is read from the old offset, not from the start', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cxindex-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'session_index.jsonl');
  writeFileSync(file, row(ID1, '하나'));
  const idx = new CodexIndex(file);
  await idx.poll();
  idx.names.delete(ID1); // a reread from the start would bring it back
  appendFileSync(file, row(ID2, '둘'));
  await idx.poll();
  assert.deepEqual([...idx.names], [[ID2, '둘']]);
});

test('session_index: a huge file is read from its newest part only', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cxindex-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'session_index.jsonl');
  writeFileSync(file, row(ID1, '아주 오래된') + row(ID2, '최근'));
  const idx = new CodexIndex(file, row(ID2, '최근').length + 10);
  await idx.poll();
  assert.deepEqual([...idx.names], [[ID2, '최근']]);
});

// ---- server / SSE --------------------------------------------------------------------------

const CLAUDE_ID = 'c1aude00-0000-4000-8000-000000000001';
const CLI_ID = 'c1aude00-0000-4000-8000-000000000002';
const WORK_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const APP_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
const PLAIN_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3';

function homes(t, now) {
  const claude = mkdtempSync(join(tmpdir(), 'appnames-claude-'));
  const codex = mkdtempSync(join(tmpdir(), 'appnames-codex-'));
  t.after(() => { rmSync(claude, { recursive: true, force: true }); rmSync(codex, { recursive: true, force: true }); });
  mkdirSync(join(claude, 'sessions'));
  const sess = (pid, id, cwd) => writeFileSync(join(claude, 'sessions', `${pid}.json`),
    JSON.stringify({ pid, sessionId: id, cwd, status: 'busy', name: '', startedAt: now - 60000 }));
  sess(process.pid, CLAUDE_ID, SCRATCH);
  sess(process.ppid, CLI_ID, 'C:\\work\\plain-proj');
  const proj = join(claude, 'projects', 'P');
  mkdirSync(proj, { recursive: true });
  const l = (o) => JSON.stringify({ timestamp: iso(now - 5000), ...o }) + '\n';
  writeFileSync(join(proj, `${CLAUDE_ID}.jsonl`), [
    l({ type: 'queue-operation', operation: 'enqueue', content: 'SECRET-QUEUE' }),
    l({ type: 'attachment', entrypoint: 'claude-desktop', userType: 'external', promptSource: 'sdk', cwd: SCRATCH }),
    l({ type: 'ai-title', aiTitle: '자동 제목' }),
    l({ type: 'custom-title', customTitle: '안녕' }),
    l({ type: 'agent-name', agentName: 'SECRET-AGENTNAME' }),
  ].join(''));
  writeFileSync(join(proj, `${CLI_ID}.jsonl`), l({ type: 'attachment', entrypoint: 'cli' }) + l({ type: 'ai-title', aiTitle: 'CLI 제목' }));

  const day = new Date(now);
  const d = join(codex, 'sessions', String(day.getFullYear()), pad(day.getMonth() + 1), pad(day.getDate()));
  mkdirSync(d, { recursive: true });
  const rollout = (id, originator, cwd) => writeFileSync(join(d, `rollout-2026-11-02T00-00-00-${id}.jsonl`), [
    JSON.stringify({ timestamp: iso(now - 9000), type: 'session_meta', payload: {
      creator_user_id: 'CREATOR-USER-MARKER', creator_account_id: 'CREATOR-ACCOUNT-MARKER', session_id: id, id, timestamp: iso(now - 9000), cwd,
      originator, cli_version: '0.166.0-alpha.5.1', source: 'vscode', thread_source: 'user',
      base_instructions: { text: 'BASE-INSTRUCTIONS-MARKER', provenance: 'BASE-PROVENANCE-MARKER' }, context_window: { window_id: 'WINDOW-MARKER' },
    } }),
    JSON.stringify({ timestamp: iso(now - 8000), type: 'event_msg', payload: { type: 'task_started', turn_id: 't' } }),
  ].join('\n') + '\n');
  rollout(WORK_ID, 'codex_work_desktop', 'C:\\d');
  rollout(APP_ID, 'Codex Desktop', 'C:\\new-chat');
  rollout(PLAIN_ID, 'codex_cli_rs', 'C:\\work\\cli-proj');
  writeFileSync(join(codex, 'session_index.jsonl'), row(WORK_ID, '작업 스레드') + row(APP_ID, '코덱스 스레드') + row(APP_ID, '코덱스 스레드 2') + row(PLAIN_ID, '터미널 스레드'));
  return { claude, codex };
}

function get(port, path, { firstChunk = false } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.get({ host: '127.0.0.1', port, path, headers: { Host: `127.0.0.1:${port}` } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        body += c;
        if (firstChunk && body.includes('event: state') && body.includes('event: log') && body.endsWith('\n\n')) {
          res.destroy();
          resolve(body);
        }
      });
      res.on('end', () => resolve(body));
    });
    r.on('error', reject);
  });
}

test('server: app sessions get their titles and origin; CLI floors unchanged; Codex meta secrets never leave', async (t) => {
  const now = Date.now();
  const cfg = loadConfig({ agentScanEveryTicks: 1 });
  Object.assign(cfg, { claudeHome: '', codexHome: '' });
  const h = homes(t, now);
  cfg.claudeHome = h.claude;
  cfg.codexHome = h.codex;
  const office = new Office(cfg, EMPTY);
  const poller = new Poller(cfg, office);
  await poller.tick(now);
  await poller.tick(now + 1500);
  office.tick(now + 1500);

  const server = createServer(cfg, office, {});
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => { server.closeSse(); server.close(r); server.closeAllConnections(); }));
  const { port } = server.address();
  const state = await get(port, '/api/state');
  const log = await get(port, '/api/log?limit=2000');
  const events = await get(port, '/api/events', { firstChunk: true });

  const by = Object.fromEntries(JSON.parse(state).floors.map((f) => [f.sessionId, f]));
  assert.equal(by[CLAUDE_ID].title, '안녕'); // custom-title beats the earlier ai-title
  assert.equal(by[CLAUDE_ID].origin, 'claudeApp');
  assert.equal(by[CLAUDE_ID].folder, '');
  assert.equal(by[CLI_ID].title, 'CLI 제목');
  assert.equal(by[CLI_ID].origin, '');
  assert.equal(by[CLI_ID].folder, 'plain-proj');
  assert.equal(by[WORK_ID].title, '작업 스레드');
  assert.equal(by[WORK_ID].origin, 'codexWork');
  assert.equal(by[APP_ID].title, '코덱스 스레드 2');
  assert.equal(by[APP_ID].origin, 'codexApp');
  assert.equal(by[PLAIN_ID].title, '터미널 스레드'); // the CLI also gets its thread name
  assert.equal(by[PLAIN_ID].origin, '');

  // a rename arrives while running
  appendFileSync(join(h.codex, 'session_index.jsonl'), row(WORK_ID, '다시 지은 이름'));
  await poller.tick(now + 3000);
  office.tick(now + 3000);
  assert.equal(JSON.parse(await get(port, '/api/state')).floors.find((f) => f.sessionId === WORK_ID).title, '다시 지은 이름');

  const MARKERS = ['CREATOR-USER-MARKER', 'CREATOR-ACCOUNT-MARKER', 'BASE-INSTRUCTIONS-MARKER', 'BASE-PROVENANCE-MARKER', 'WINDOW-MARKER',
    'SECRET', 'creator_user_id', 'creator_account_id', 'base_instructions', 'updated_at'];
  const state2 = await get(port, '/api/state');
  for (const [name, body] of [['state', state2], ['log', log], ['events', events]]) {
    for (const m of MARKERS) assert.ok(!body.includes(m), `/api/${name} contains ${m}`);
  }
});
