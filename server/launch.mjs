// Launcher: node server/launch.mjs
// Server already up -> only open the browser. Nothing answering -> start the server window.
// Something else on the port -> tell the user. AGENT_OFFICE_NO_BROWSER=1 skips opening the browser (debugging).
import http from 'node:http';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.mjs';

const APP_ID = 'agent-office';
const SERVER_WINDOW_TITLE = '에이전트 사무실 서버';

/** Asks /health. Resolves { up:false } when nothing answers in time, else { up:true, body } (body null if not JSON). */
export function probe(port, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: timeoutMs, agent: false }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { if (text.length < 4096) text += c; });
      res.on('end', () => {
        let body = null;
        try { body = JSON.parse(text); } catch { /* not ours */ }
        resolve({ up: true, body });
      });
      res.on('error', () => resolve({ up: false }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ up: false }); });
    req.on('error', () => resolve({ up: false }));
  });
}

/** Pure decision from a probe result: 'open' | 'start' | 'conflict'. */
export function decide(result) {
  if (!result.up) return 'start';
  return result.body?.app === APP_ID ? 'open' : 'conflict';
}

/**
 * One launcher pass. deps.spawn(command, args) starts a detached process; deps.probe answers /health.
 * Injectable so tests never open a window. Returns the action taken.
 */
export async function launch(cfg, { spawn: spawnFn, probe: probeFn = probe, noBrowser = false, log = console.error } = {}) {
  const url = `http://127.0.0.1:${cfg.port}/`;
  const action = decide(await probeFn(cfg.port, cfg.launch.healthTimeoutMs));
  if (action === 'open') {
    if (!noBrowser) spawnFn('cmd', ['/c', 'start', '', url]);
  } else if (action === 'start') {
    const args = ['/c', 'start', SERVER_WINDOW_TITLE, '/min', 'node', join(cfg.root, 'server', 'main.mjs')];
    if (!noBrowser) args.push('--open');
    spawnFn('cmd', args);
  } else {
    log(`포트 ${cfg.port} 을 다른 프로그램이 쓰고 있습니다 — config.json 의 port 를 바꾸세요`);
  }
  return action;
}

export const DETACHED_OPTIONS = { detached: true, stdio: 'ignore', windowsHide: true };

function detachedSpawn(command, args) {
  spawn(command, args, DETACHED_OPTIONS).unref();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const action = await launch(loadConfig(), { spawn: detachedSpawn, noBrowser: !!process.env.AGENT_OFFICE_NO_BROWSER });
  if (action === 'conflict') process.exitCode = 1;
}
