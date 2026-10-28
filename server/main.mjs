// Entry point: node server/main.mjs [--open]
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { loadConfig } from './config.mjs';
import { Office } from './office.mjs';
import { Poller } from './poller.mjs';
import { createServer } from './http.mjs';
import { loadSaved, saveSaved } from './hidden.mjs';

const EXIT_PORT_BUSY = 2;

const cfg = loadConfig();
const dataDir = join(cfg.root, 'data');
const office = new Office(cfg, loadSaved(dataDir));
const poller = new Poller(cfg, office);

// ---- persistence: only when the saved part changed (hide/rename, or hide records dropped at session end) ----

let savedVersion = office.savedVersion;
let saving = Promise.resolve();

function saveIfChanged() {
  if (office.savedVersion === savedVersion) return saving;
  const version = office.savedVersion;
  const snapshot = office.saved();
  saving = saving
    .then(() => saveSaved(dataDir, snapshot))
    .then(() => { savedVersion = version; })
    .catch((e) => console.error('숨김·이름 저장 실패:', e?.message ?? e));
  return saving;
}

// ---- server ----

let timer = null;
let closing = false;

function shutdown() {
  if (closing) return;
  closing = true;
  clearTimeout(timer);
  server.closeSse();
  saveIfChanged().finally(() => server.close(() => process.exit(0)));
  server.closeAllConnections();
}

const server = createServer(cfg, office, { onSavedChange: saveIfChanged, onShutdown: shutdown });

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`포트 ${cfg.port} 을 다른 프로그램이 쓰고 있습니다`);
    process.exit(EXIT_PORT_BUSY);
  }
  throw e;
});

// ---- poll loop: a timeout chain, so rounds never overlap ----

async function round() {
  const now = Date.now();
  try {
    await poller.tick(now);
  } catch (e) {
    console.error('확인 중 오류:', e?.message ?? e);
  }
  office.tick(now);
  server.broadcast();
  await saveIfChanged();
  if (!closing) timer = setTimeout(round, cfg.pollMs);
}

server.listen(cfg.port, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${cfg.port}/`;
  console.log(`agent office: ${url}`);
  if (process.argv.includes('--open')) {
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
  }
  round();
});

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
