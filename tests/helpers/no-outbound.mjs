// Test guard (node --import): the suite must never reach a non-loopback host, even though weather is enabled in config.json.
// Every TCP connect goes through net.Socket.prototype.connect (fetch, http and https included), so a connect to anything but
// the loopback is refused here, and written to the file named by AGENT_OFFICE_LEAK_LOG when that is set (the leak check reads it; tests/no-outbound.test.mjs probes the guard on purpose with `globalThis.__outboundProbe` set, which skips the log).
import net from 'node:net';
import { appendFileSync } from 'node:fs';

const LOOPBACK = /^(127(\.\d{1,3}){3}|localhost|\[?::1\]?|0\.0\.0\.0|\[?::\]?)$/i;
const connect = net.Socket.prototype.connect;

function targetOf(args) {
  const [a, b] = Array.isArray(args[0]) ? [args[0][0], undefined] : args; // net.connect hands over already-normalized [options, cb]
  if (a !== null && typeof a === 'object') return a.path ? null : String(a.host ?? 'localhost');
  if (typeof a === 'string' && !/^\d+$/.test(a)) return null; // a pipe path
  return typeof b === 'string' ? b : 'localhost'; // connect(port[, host])
}

net.Socket.prototype.connect = function guardedConnect(...args) {
  const host = targetOf(args);
  if (host !== null && !LOOPBACK.test(host)) {
    const msg = `outbound connection blocked in tests: ${host}`;
    if (process.env.AGENT_OFFICE_LEAK_LOG && !globalThis.__outboundProbe) appendFileSync(process.env.AGENT_OFFICE_LEAK_LOG, `${msg}\n`);
    throw new Error(msg);
  }
  return connect.apply(this, args);
};
