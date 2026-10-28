// End to end privacy check (spec §8, §10.6): forbidden text in fake ~/.claude and ~/.codex homes must not reach any
// API response after a full Poller -> Office -> http round.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../server/config.mjs';
import { Office } from '../server/office.mjs';
import { Poller } from '../server/poller.mjs';
import { createServer } from '../server/http.mjs';

const EMPTY = { hidden: [], names: {} };
const iso = (ms) => new Date(ms).toISOString();
const pad = (n) => String(n).padStart(2, '0');

// Every string here sits somewhere in the fake homes; none may appear in a response.
const FORBIDDEN = [
  'SECRET', // marker inside every private value below
  'tok-',
  'hunter2',
  'Bearer',
  'sk-',
  'U-SECRET',
  'https://',
  '@host',
  'Users\\\\', // a full Windows path as it would look inside JSON
  'deep-folder',
  'toolu_',
];

function claudeHome(t, now) {
  const dir = mkdtempSync(join(tmpdir(), 'privacy-claude-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'sessions'));
  mkdirSync(join(dir, 'projects', 'P', 's1', 'subagents'), { recursive: true });
  const cwd = 'C:\\Users\\someone\\deep-folder\\SECRET-CWD\\proj';
  writeFileSync(join(dir, 'sessions', `${process.pid}.json`),
    JSON.stringify({ pid: process.pid, sessionId: 's1', cwd, status: 'busy', name: '', startedAt: now - 60000 }));
  writeFileSync(join(dir, 'sessions', `${process.pid}.key`), 'SECRET-KEYFILE sk-SECRET-KEY');
  const a = (ms, content) => JSON.stringify({ type: 'assistant', timestamp: iso(ms), message: { content } }) + '\n';
  const u = (ms, content, extra = {}) => JSON.stringify({ type: 'user', timestamp: iso(ms), message: { role: 'user', content }, ...extra }) + '\n';
  const tool = (ms, id, name, input) => a(ms, [{ type: 'tool_use', id, name, input }]);
  let ms = now - 30000;
  const lines = [
    u(ms++, 'SECRET-USER please deploy with password hunter2'),
    JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: iso(ms++), content: 'SECRET-QUEUE next prompt' }) + '\n',
    JSON.stringify({ type: 'attachment', timestamp: iso(ms++), attachment: { content: 'SECRET-ATTACH' } }) + '\n',
    a(ms++, [{ type: 'thinking', thinking: 'SECRET-THINK' }, { type: 'text', text: 'SECRET-ANSWER' }]),
    tool(ms++, 'toolu_SECRET1', 'Bash', { command: 'git push https://tok-SECRET@host/x.git' }),
    tool(ms++, 'toolu_SECRET2', 'Bash', { command: 'curl -H "Authorization: Bearer SECRET-BEARER" https://api.x/y' }),
    tool(ms++, 'toolu_SECRET3', 'Bash', { command: 'A=1;echo SECRET-BASH1' }),
    tool(ms++, 'toolu_SECRET4', 'Grep', { pattern: 'SECRET-QUERY', path: 'C:\\Users\\someone\\deep-folder' }),
    tool(ms++, 'toolu_SECRET5', 'WebSearch', { query: 'SECRET-WEBQUERY' }),
    tool(ms++, 'toolu_SECRET6', 'Read', { file_path: 'C:\\Users\\someone\\deep-folder\\SECRET-DIR\\notes.md' }),
    u(ms++, [{ type: 'tool_result', tool_use_id: 'toolu_SECRET1', content: 'SECRET-RESULT sk-SECRET-RESULT' }]),
  ];
  writeFileSync(join(dir, 'projects', 'P', 's1.jsonl'), lines.join(''));
  writeFileSync(join(dir, 'projects', 'P', 's1', 'subagents', 'agent-a1.meta.json'), JSON.stringify({ agentType: 'worker', description: '조사' }));
  writeFileSync(join(dir, 'projects', 'P', 's1', 'subagents', 'agent-a1.jsonl'),
    tool(ms++, 'toolu_SECRET7', 'Bash', { command: 'X=1|mysql -pSECRET-SUB db' }) + a(ms++, [{ type: 'text', text: 'SECRET-SUBANSWER' }]));
  return dir;
}

function codexHome(t, now) {
  const dir = mkdtempSync(join(tmpdir(), 'privacy-codex-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'auth.json'), '{"OPENAI_API_KEY":"sk-SECRET-AUTH","tokens":{"account_id":"U-SECRET"}}');
  writeFileSync(join(dir, 'history.jsonl'), '{"text":"SECRET-HISTORY"}\n');
  const day = new Date(now);
  const d = join(dir, 'sessions', String(day.getFullYear()), pad(day.getMonth() + 1), pad(day.getDate()));
  mkdirSync(d, { recursive: true });
  const id = '22222222-2222-4222-8222-222222222222';
  const line = (ms, type, payload) => JSON.stringify({ timestamp: iso(ms), type, payload }) + '\n';
  let ms = now - 20000;
  const content = [
    line(ms++, 'session_meta', {
      id, creator_user_id: 'U-SECRET', account_id: 'U-SECRET-2', timestamp: iso(now - 20000),
      cwd: 'C:\\Users\\someone\\deep-folder\\SECRET-CXCWD\\cxproj', originator: 'codex_cli', source: 'cli',
      base_instructions: { text: 'SECRET-INSTRUCTIONS' },
    }),
    line(ms++, 'event_msg', { type: 'task_started', turn_id: 't' }),
    line(ms++, 'event_msg', { type: 'user_message', message: 'SECRET-CXUSER hunter2' }),
    line(ms++, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'SECRET-CXUSER2' }] }),
    line(ms++, 'response_item', { type: 'reasoning', summary: [{ type: 'summary_text', text: 'SECRET-CXTHINK' }] }),
    line(ms++, 'response_item', { type: 'custom_tool_call', name: 'exec', call_id: 'c1',
      input: 'const r = await tools.exec_command({cmd:"git push https://tok-SECRET-CX@host/x"})' }),
    line(ms++, 'response_item', { type: 'custom_tool_call_output', call_id: 'c1', output: 'SECRET-CXOUT sk-SECRET-CXOUT' }),
    line(ms++, 'response_item', { type: 'custom_tool_call', name: 'exec', call_id: 'c2',
      input: "// cmd: 'SECRET-CXCMD x'\nawait tools.exec_command({cmd:\"curl -H 'Authorization: Bearer SECRET-CXB' https://h\"})" }),
    line(ms++, 'event_msg', { type: 'item_completed', item: { type: 'CommandExecution', id: 'c3', parsed_cmd: [{ cmd: 'X=1;cat SECRET-PARSED' }] } }),
    line(ms++, 'event_msg', { type: 'item_completed', item: { type: 'Extension', kind: 'web.search', id: 'c4', query: 'SECRET-CXQUERY' } }),
    line(ms++, 'response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'SECRET-CXANSWER' }] }),
  ];
  writeFileSync(join(d, `rollout-2026-10-28T00-00-00-${id}.jsonl`), content.join(''));
  return dir;
}

function get(port, path, { firstChunk = false } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.get({ host: '127.0.0.1', port, path, headers: { Host: `127.0.0.1:${port}` } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        body += c;
        // the event stream stays open: stop once the opening state and log frames are in
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

test('privacy e2e: no forbidden text from either home reaches /api/state, /api/log or /api/events', async (t) => {
  const now = Date.now();
  const cfg = loadConfig({ agentScanEveryTicks: 1 });
  cfg.claudeHome = claudeHome(t, now);
  cfg.codexHome = codexHome(t, now);
  const office = new Office(cfg, EMPTY);
  const poller = new Poller(cfg, office);
  await poller.tick(now);
  await poller.tick(now + 1500);
  office.tick(now + 1500);

  const server = createServer(cfg, office, {});
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => {
    server.closeSse();
    server.close(r);
    server.closeAllConnections();
  }));
  const { port } = server.address();

  const state = await get(port, '/api/state');
  const log = await get(port, '/api/log?limit=2000');
  const events = await get(port, '/api/events', { firstChunk: true });

  // the round did produce output, so the check below is not vacuous
  const floors = JSON.parse(state).floors;
  assert.deepEqual(floors.map((f) => f.provider).sort(), ['claude', 'codex']);
  assert.ok(log.includes('git 실행'), 'claude and codex labels reached the log');
  assert.ok(log.includes('curl 실행') && log.includes('명령 실행'));
  assert.ok(events.includes('event: log'));

  for (const [name, body] of [['state', state], ['log', log], ['events', events]]) {
    for (const s of FORBIDDEN) assert.ok(!body.includes(s), `/api/${name} contains ${s}`);
  }
});
