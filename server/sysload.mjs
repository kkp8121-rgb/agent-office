// PC-wide CPU % and memory %, sampled only while at least one page is connected (same shape as weather.mjs).
import os from 'node:os';

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

export function createSysLoad(s = {}, { cpus = os.cpus, freemem = os.freemem, totalmem = os.totalmem, setTimer = setInterval, clearTimer = clearInterval } = {}) {
  const enabled = s.enabled === true;
  const intervalMs = Math.max(1, Number(s.intervalSeconds) || 3) * 1000;
  let connections = 0;
  let timer = null;
  let snap = null;
  let value = null; // {cpu, mem} integers, or null before the first sample of this run
  const listeners = new Set();

  function sample() {
    const cur = cpus();
    const cpu = snap ? cpuPercent(snap, cur) : null;
    snap = cur;
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
      }
    },
    current: () => value,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    get connections() { return connections; },
    get timerActive() { return timer !== null; },
  };
}
