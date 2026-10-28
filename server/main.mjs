// Entry point: node server/main.mjs [--open]
import { spawn } from 'node:child_process';
import { loadConfig, pollDelayMs } from './config.mjs';
import { Office } from './office.mjs';
import { Poller } from './poller.mjs';
import { createServer } from './http.mjs';
import { DETACHED_OPTIONS } from './launch.mjs';
import { loadSaved, saveSaved } from './hidden.mjs';

const EXIT_PORT_BUSY = 2;

const cfg = loadConfig();
const dataDir = cfg.dataDir;
const office = new Office(cfg, loadSaved(dataDir));
const poller = new Poller(cfg, office);

// ---- persistence: only when the saved part changed (hide/rename, or hide records dropped at session end) ----

let savedVersion = office.savedVersion;
let saving = Promise.resolve();

function saveIfChanged() {
  if (office.savedVersion === savedVersion) return saving;
  const version = office.savedVersion;
  const snapshot = office.saved();
  const result = saving.then(() => saveSaved(dataDir, snapshot)).then(() => { savedVersion = version; });
  saving = result.catch(() => {}); // a failed save must not block the next one; callers see the rejection
  return result;
}

// ---- server ----

let timer = null;
let inflight = Promise.resolve(); // the running poll round
let closing = false;
let running = false; // a poll round is in progress

// Stop accepting first (the server refuses /api/events from then on), then end open streams and sockets,
// let the running round finish, save, and exit.
function shutdown() {
  if (closing) return;
  closing = true;
  clearTimeout(timer);
  const closed = new Promise((resolve) => server.close(resolve));
  server.closeSse();
  server.closeAllConnections();
  inflight.then(saveIfChanged).then(() => closed).finally(() => process.exit(0));
}

// A browser just connected while the loop sleeps at the idle rate: poll now instead of showing a stale floor.
function wake() {
  if (closing || running) return;
  clearTimeout(timer);
  inflight = round();
}

const server = createServer(cfg, office, { onSavedChange: saveIfChanged, onShutdown: shutdown, onSseConnect: wake });

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`포트 ${cfg.port} 을 다른 프로그램이 쓰고 있습니다`);
    process.exit(EXIT_PORT_BUSY);
  }
  throw e;
});

// ---- poll loop: a timeout chain, so rounds never overlap and one failure never stops it ----

let lastError = '';

/** Runs one step; an error is logged once per distinct message until a round has no error. */
async function step(roundFailures, fn) {
  try {
    await fn();
  } catch (e) {
    const msg = e?.message ?? String(e);
    roundFailures.push(msg);
    if (msg !== lastError) console.error('확인 중 오류:', msg);
    lastError = msg;
  }
}

async function round() {
  running = true;
  const now = Date.now();
  const failures = [];
  await step(failures, () => poller.tick(now));
  await step(failures, () => {
    office.tick(now);
    server.broadcast();
  });
  await step(failures, saveIfChanged);
  if (failures.length === 0) lastError = '';
  running = false;
  if (!closing) timer = setTimeout(() => { inflight = round(); }, pollDelayMs(cfg, server.sseClients));
}

server.listen(cfg.port, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${cfg.port}/`;
  console.log(`agent office: ${url}`);
  if (process.argv.includes('--open')) {
    spawn('cmd', ['/c', 'start', '', url], DETACHED_OPTIONS).unref();
  }
  inflight = round();
});

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
