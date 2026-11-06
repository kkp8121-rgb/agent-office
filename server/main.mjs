// Entry point: node server/main.mjs [--open]
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { loadConfig, pollDelayMs } from './config.mjs';
import { Office } from './office.mjs';
import { Poller } from './poller.mjs';
import { createServer } from './http.mjs';
import { DETACHED_OPTIONS } from './launch.mjs';
import { loadSaved, saveSaved } from './hidden.mjs';
import { createWeather } from './weather.mjs';
import { createSysLoad } from './sysload.mjs';
import { loadPersonas, personaLimits } from './persona.mjs';
import { CostLedger, localClock } from './cost.mjs';
import { CostScan, planTargets, loadCostFile, saveCostFile } from './cost-scan.mjs';

const EXIT_PORT_BUSY = 2;

const cfg = loadConfig();
const dataDir = cfg.dataDir;
const office = new Office(cfg, loadSaved(dataDir));
// Labour cost: the live tails count into the ledger, one scan of the records at start-up counts today and last week's same weekday,
// and data/cost.json keeps the day totals between runs.
const costClock = localClock(cfg.cost.dayStartHour);
const costFile = path.join(dataDir, cfg.cost.file);
const ledger = CostLedger.fromJSON(loadCostFile(costFile), {
  clock: costClock, keepDays: cfg.cost.keepDays, dedupePerFile: cfg.cost.dedupePerFile, topCount: cfg.ui.cost.topCount,
}, Date.now());
const poller = new Poller(cfg, office, ledger);
// The only outbound connection (see README: Weather). AGENT_OFFICE_WEATHER_URL points it at a local fake server for checks.
const weather = createWeather(cfg.weather, { baseUrl: process.env.AGENT_OFFICE_WEATHER_URL || undefined });
const sysload = createSysLoad(cfg.sysload); // PC-wide CPU % and memory %: sampled only while a page is connected

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

let costSavedVersion = ledger.version;
let costSavedAt = 0;

/** Writes cost.json when the ledger changed and cost.saveMinMs has passed since the last write (`force`: now, at shutdown). */
function saveCostIfDue(now, force = false) {
  if (ledger.version === costSavedVersion || (!force && now - costSavedAt < cfg.cost.saveMinMs)) return Promise.resolve();
  const version = ledger.version;
  ledger.prune(now);
  costSavedAt = now;
  mkdirSync(dataDir, { recursive: true });
  return saveCostFile(costFile, ledger.toJSON(now)).then(() => { costSavedVersion = version; });
}

let scanTimer = null;
if (cfg.cost.backfill.enabled) {
  const targets = planTargets({ ledger, clock: costClock, nowTs: Date.now(), backfill: cfg.cost.backfill });
  if (targets.length) {
    ledger.setScanning(true); // the screen says "counting" until the scan ends
    const scan = new CostScan({ ledger, claudeHome: cfg.claudeHome, codexHome: cfg.codex?.enabled ? cfg.codexHome : '', cfg: { backfill: cfg.cost.backfill, tail: cfg.tail, codex: cfg.codex } });
    scanTimer = setTimeout(() => {
      scan.run(targets).catch((e) => console.error('인건비 집계 실패:', e?.message ?? e));
    }, cfg.cost.backfill.delayMs);
  }
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
  clearTimeout(scanTimer);
  sysload.close(); // the CPU helper process ends with the server
  const closed = new Promise((resolve) => server.close(resolve));
  server.closeSse();
  server.closeAllConnections();
  inflight.then(saveIfChanged).then(() => saveCostIfDue(Date.now(), true)).then(() => closed).finally(() => process.exit(0));
}

// A browser just connected while the loop sleeps at the idle rate: poll now instead of showing a stale floor.
function wake() {
  if (closing || running) return;
  clearTimeout(timer);
  inflight = round();
}

// persona.json (the lines work writes it, never this server); AGENT_OFFICE_PERSONA_FILE points a check at another file
const personas = loadPersonas(process.env.AGENT_OFFICE_PERSONA_FILE || path.join(cfg.root, 'persona.json'), personaLimits(cfg));
const server = createServer(cfg, office, { onSavedChange: saveIfChanged, onShutdown: shutdown, onSseConnect: wake, weather, sysload, personas, cost: ledger });

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
  await step(failures, () => saveCostIfDue(now));
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
