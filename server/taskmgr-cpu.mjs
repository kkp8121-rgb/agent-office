// Task Manager style CPU %, computed by ONE long-lived helper process (script text in server/taskmgr-cpu-script.mjs).
// Never one process per sample: the short-lived processes a sample would start are the very thing that separates Task Manager's number from the cores' busy time.
// This file owns the helper's life (start, stop, restart with growing gaps, give up) and the parsing of its lines. The spawner is injected, so tests use a fake child.
import { spawn as nodeSpawn } from 'node:child_process';
import os from 'node:os';
import { join } from 'node:path';
import { SCRIPT } from './taskmgr-cpu-script.mjs';

/** One helper output line "C <0..100>" -> integer percent; anything else (cut line, noise, out of range) -> null. */
export function parseLine(line) {
  const m = /^C (\d{1,3})$/.exec(line.trim());
  if (!m) return null;
  const v = Number(m[1]);
  return v > 100 ? null : v;
}

/**
 * Starts the real helper: Windows PowerShell 5.1 with the script passed as -EncodedCommand (no script file to run, so the execution policy does not matter).
 * The script ends by itself within a second once `parentPid` is gone, so a killed server never leaves it behind. Priority BelowNormal.
 * Returns {pid, onLine(fn), onExit(fn), kill()}.
 */
export function spawnHelper({ intervalSeconds, parentPid = process.pid, spawn = nodeSpawn } = {}) {
  const text = `$ParentPid = ${Number(parentPid)}; $IntervalSec = ${Math.max(1, Math.round(intervalSeconds))};\n${SCRIPT}`;
  const exe = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const child = spawn(exe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(text, 'utf16le').toString('base64')], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  try {
    os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
  } catch {
    // the child already ended (spawn failed): the exit handler counts that as a failure
  }
  const lineListeners = new Set();
  let rest = '';
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk) => {
    const lines = (rest + chunk).split('\n');
    rest = lines.pop(); // a cut last line waits for the rest of it; at exit it is dropped
    for (const l of lines) for (const fn of lineListeners) fn(l);
  });
  return {
    pid: child.pid,
    onLine: (fn) => lineListeners.add(fn),
    onExit: (fn) => { child.on('exit', fn); child.on('error', fn); },
    kill: () => child.kill(),
  };
}

/**
 * The helper's keeper. start() / stop() are idempotent; at most one child lives at a time.
 * A child that ends before its first valid line is a failure; failures in a row wait 1 s, 2 s, 4 s ... (at most 30 s) before the next start,
 * and `maxFailures` of them in a row give up (`failed`): the caller falls back to the os.cpus way and the log gets one line, once per server run.
 * A child that did report and then died is restarted after 1 s and does not count as a failure. stop() / start() again (the option switched off and on) tries again.
 */
export function createTaskMgrCpu({ spawn = spawnHelper, intervalSeconds = 3, maxFailures = 5, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, log = console.error } = {}) {
  let child = null;
  let dying = null; // a child that was told to stop and has not ended yet: no new one starts before it is gone
  let wanted = false; // start() came while `dying` was still alive
  let retry = null;
  let failures = 0;
  let gaveUp = false;
  let logged = false;
  let value = null;
  let valueAt = 0;
  const freshMs = Math.max(30, intervalSeconds * 10) * 1000; // a helper that hangs without exiting must not freeze the number (generous: at BelowNormal on a saturated PC its lines come late)

  function launch() {
    retry = null;
    let c;
    try {
      c = spawn({ intervalSeconds });
    } catch (e) {
      return failed(e);
    }
    child = c;
    let reported = false;
    c.onLine((line) => {
      if (child !== c) return;
      const v = parseLine(line);
      if (v === null) return;
      reported = true;
      failures = 0;
      value = v;
      valueAt = now();
    });
    c.onExit(() => {
      if (child !== c) { // stopped on purpose (then the next start may go on), or the error and exit events both came
        if (dying === c) {
          dying = null;
          if (wanted) { wanted = false; launch(); }
        }
        return;
      }
      child = null;
      value = null;
      if (reported) retry = setTimer(launch, 1000);
      else failed();
    });
  }

  function failed(err) {
    failures += 1;
    if (failures >= maxFailures) {
      gaveUp = true;
      if (!logged) {
        logged = true;
        log(`작업 관리자 기준 CPU 보조 프로세스가 ${failures}번 연달아 실패해 코어 기준 CPU 로 표시합니다${err ? `: ${err.message ?? err}` : ''}`);
      }
      return;
    }
    retry = setTimer(launch, Math.min(30000, 1000 * 2 ** (failures - 1)));
  }

  return {
    start() {
      if (child || retry || gaveUp) return;
      if (dying) wanted = true;
      else launch();
    },
    stop() {
      if (retry) clearTimer(retry);
      retry = null;
      wanted = false;
      const c = child;
      child = null; // before kill(), so the exit event is not taken for a crash
      value = null;
      failures = 0;
      if (c) {
        dying = c;
        c.kill();
      }
    },
    /** Reset after the option was switched off and on, or after a stop: a new try. */
    retryAgain() { gaveUp = false; failures = 0; },
    /** Latest percent, or null when there is none yet, the helper is gone, or the number is too old. */
    value: () => (value !== null && now() - valueAt <= freshMs ? value : null),
    /** True while the helper has failed since the last good value (retrying or given up): the caller shows the os.cpus value meanwhile. */
    get failing() { return gaveUp || failures > 0; },
    get failed() { return gaveUp; },
    get pid() { return child?.pid ?? null; },
    get running() { return child !== null; },
  };
}
