// PC-wide CPU % and memory %, sampled only while at least one page is connected (same shape as weather.mjs).
import os from 'node:os';
import { createTaskMgrCpu } from './taskmgr-cpu.mjs';

/** CPU busy % between two os.cpus() snapshots, all cores summed; null when no time passed. */
export function cpuPercent(prev, cur) {
  const sum = (list) => list.reduce((a, c) => ({ idle: a.idle + c.times.idle, total: a.total + Object.values(c.times).reduce((x, y) => x + y, 0) }), { idle: 0, total: 0 });
  const a = sum(prev);
  const b = sum(cur);
  const total = b.total - a.total;
  if (!(total > 0)) return null;
  return clampPct(100 * (1 - (b.idle - a.idle) / total));
}

const clampPct = (v) => Math.max(0, Math.min(100, Math.round(v)));

/** Memory in use %. On Windows os.freemem() is the available physical memory (free + standby cache), the same as Task Manager's "Available". */
export function memPercent(free, total) {
  return total > 0 ? clampPct(100 * (1 - free / total)) : null;
}

/**
 * `s.taskManager` (default true) picks the CPU basis on Windows: Task Manager's number from the long-lived helper (server/taskmgr-cpu.mjs), or, when false,
 * the os.cpus() cores' busy share. Other systems always use os.cpus(). setTaskManager() switches it while running; the next sample uses the new basis.
 * `helper` is injectable for tests (same shape as createTaskMgrCpu's result).
 */
export function createSysLoad(s = {}, { cpus = os.cpus, freemem = os.freemem, totalmem = os.totalmem, setTimer = setInterval, clearTimer = clearInterval, platform = process.platform, helper = null } = {}) {
  const enabled = s.enabled === true;
  const intervalMs = Math.max(1, Number(s.intervalSeconds) || 3) * 1000;
  const available = enabled && platform === 'win32';
  const tm = available ? helper ?? createTaskMgrCpu({ intervalSeconds: intervalMs / 1000 }) : null;
  let taskManager = available && s.taskManager !== false; // the CPU basis in use
  let connections = 0;
  let timer = null;
  let snap = null;
  let value = null; // {cpu, mem} integers, or null before the first sample of this run
  const listeners = new Set();

  function sample() {
    const cur = cpus();
    const cores = snap ? cpuPercent(snap, cur) : null; // always taken, so switching the basis or falling back needs no warm-up
    snap = cur;
    let cpu = cores;
    if (taskManager && !tm.failing) cpu = tm.value(); // null while the helper warms up: nothing is shown instead of a wrong number
    const mem = memPercent(freemem(), totalmem());
    if (cpu === null || mem === null) return;
    if (value && value.cpu === cpu && value.mem === mem) return;
    value = { cpu, mem };
    for (const fn of listeners) fn(value);
  }

  return {
    enabled,
    /** A page connected. The first one takes the baseline snapshot and starts the timer. */
    connect() {
      if (!enabled) return;
      connections += 1;
      if (connections === 1) {
        snap = cpus();
        timer = setTimer(sample, intervalMs);
        timer.unref?.();
        if (taskManager) tm.start();
      }
    },
    /** A page left. The last one stops the timer and drops the value (the next run starts from a fresh baseline). */
    disconnect() {
      if (connections === 0) return;
      connections -= 1;
      if (connections === 0) {
        clearTimer(timer);
        timer = null;
        snap = null;
        value = null;
        tm?.stop();
      }
    },
    /** The server is ending: the helper must not outlive it. */
    close() { tm?.stop(); },
    /** Task Manager basis on (true) or the cores' busy share (false). Ignored where it is not available. */
    setTaskManager(on) {
      if (!available || taskManager === (on === true)) return;
      taskManager = on === true;
      if (taskManager) tm.retryAgain();
      if (timer) {
        if (taskManager) tm.start();
        else tm.stop();
      }
    },
    /** True on Windows with sysload enabled: the option can be used. */
    available,
    get taskManager() { return taskManager; },
    current: () => value,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    get connections() { return connections; },
    get timerActive() { return timer !== null; },
  };
}
