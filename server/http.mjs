// Local HTTP server: JSON API, SSE push and static files. Every request must carry a loopback Host
// header (DNS rebinding) and every POST a matching Origin (cross-site requests). No CORS headers at all.
import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import { isSafeId } from './sessions.mjs';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico']);
const IMAGE_CACHE = 'max-age=3600';
// Sent with every response: the page must never be framed by another site (clickjacking of hide / quit).
const SECURITY_HEADERS = { 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "frame-ancestors 'none'" };
const STATIC_DIRS = ['web', 'assets'];

const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function sendText(res, status, text, extra = {}) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...extra });
  res.end(text);
}

const notFound = (res) => sendText(res, 404, 'not found');
const badRequest = (res) => sendText(res, 400, 'bad request', { Connection: 'close' });

/** Resolves to the body text, or null when it is larger than `max` (the rest is discarded, never buffered). */
function readBody(req, max) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    const tooBig = () => {
      chunks.length = 0;
      req.removeAllListeners('data');
      req.resume();
      resolve(null);
    };
    if (Number(req.headers['content-length']) > max) return tooBig();
    req.on('data', (c) => {
      size += c.length;
      if (size > max) tooBig();
      else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(null));
  });
}

export function createServer(cfg, office, { onSavedChange, onShutdown, onSseConnect } = {}) {
  const clients = new Set(); // open SSE responses
  let lastStateJson = null; // last floors JSON sent; null = send the next state in full

  const server = http.createServer((req, res) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    handle(req, res).catch((e) => {
      console.error('요청 처리 실패:', e?.message ?? e);
      if (!res.headersSent) sendText(res, 500, 'server error');
      else res.destroy();
    });
  });

  // ---- security ----------------------------------------------------------------------------

  let port = 0; // remembered: server.address() is null once close() has been called
  server.on('listening', () => { port = server.address().port; });
  const allowedHosts = () => [`127.0.0.1:${port}`, `localhost:${port}`];

  // ---- SSE ---------------------------------------------------------------------------------

  const frame = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

  function openEvents(res) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    const snap = office.snapshot();
    res.write(frame('state', snap));
    if (clients.size === 0) lastStateJson = JSON.stringify(snap.floors); // only client: in sync now; an older client's baseline is never overwritten
    res.write(frame('log', office.queryLog({ limit: cfg.log.sendCap }).reverse()));
    clients.add(res);
    res.on('close', () => clients.delete(res));
    onSseConnect?.();
  }

  /** Sends `state` only when it differs from the last one sent, and every new or updated log entry. */
  server.broadcast = () => {
    const entries = office.drainLog(); // drained even without clients so entries never pile up
    if (clients.size === 0) { // nobody to send to: skip the snapshot and its stringify; the next client gets a full state
      lastStateJson = null;
      return;
    }
    const snap = office.snapshot();
    const json = JSON.stringify(snap.floors);
    const changed = json !== lastStateJson;
    lastStateJson = json;
    for (const res of clients) {
      if (changed) res.write(frame('state', snap));
      if (entries.length) res.write(frame('log', entries));
    }
  };

  server.closeSse = () => {
    for (const res of clients) res.end();
    clients.clear();
  };

  Object.defineProperty(server, 'sseClients', { get: () => clients.size });

  const ping = setInterval(() => {
    for (const res of clients) res.write(': ping\n\n');
  }, cfg.server.ssePingMs);
  ping.unref();
  server.on('close', () => clearInterval(ping));

  // ---- static files ------------------------------------------------------------------------

  async function sendStatic(res, dirName, rawRel) {
    let rel;
    try {
      rel = decodeURIComponent(rawRel);
    } catch {
      return notFound(res);
    }
    if (rel.includes('\0')) return notFound(res);
    const base = join(cfg.root, dirName);
    const file = resolve(base, rel);
    const inside = relative(base, file);
    if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) return notFound(res);
    let st;
    try {
      st = await stat(file);
    } catch {
      return notFound(res);
    }
    if (!st.isFile()) return notFound(res);
    const ext = extname(file).toLowerCase();
    const headers = { 'Content-Type': TYPES[ext] ?? 'application/octet-stream', 'Content-Length': st.size };
    if (IMAGE_EXTS.has(ext)) headers['Cache-Control'] = IMAGE_CACHE;
    res.writeHead(200, headers);
    const stream = createReadStream(file);
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  }

  // ---- routes ------------------------------------------------------------------------------

  function uiConfig() {
    const roles = {};
    // Codex roles reuse the Claude sprite keys, so they must not overwrite the Claude names here.
    for (const [k, r] of Object.entries(cfg.roles)) if (!k.startsWith('codex:')) roles[r.key] = { name: r.name, role: r.role };
    return { spriteHeight: cfg.spriteHeight, layouts: cfg.layouts, ui: cfg.ui, bubbleShowMs: cfg.agent.bubbleShowMs, nameMaxChars: cfg.floor.nameMaxChars, roles };
  }

  const isVisible = (sessionId) => office.snapshot().floors.some((f) => f.sessionId === sessionId);

  /** {entries, titles, colors, capped}: entries newest first; titles and palette indexes by session id for those entries; capped when the limit cut the list.
   * `session` must be a safe id (400 otherwise); `limit` falls back to log.pageLimit and is clamped to [1, log.cap]. */
  function sendLog(res, query) {
    const params = new URLSearchParams(query);
    const filter = {};
    if (params.has('session')) {
      const sid = params.get('session');
      if (!isSafeId(sid)) return sendText(res, 400, 'bad request');
      filter.sessionId = sid;
    }
    if (params.has('name')) filter.name = params.get('name');
    const asked = Number(params.get('limit'));
    const limit = params.get('limit') === null || params.get('limit') === '' || !Number.isFinite(asked) ? cfg.log.pageLimit : Math.trunc(asked);
    filter.limit = Math.min(Math.max(limit, 1), cfg.log.cap);
    const entries = office.queryLog(filter);
    const ids = [...new Set(entries.map((e) => e.sessionId))];
    return sendJson(res, 200, { entries, titles: office.logTitles(ids), colors: office.logColors(ids), capped: entries.length === filter.limit });
  }

  async function handlePost(path, body, res) {
    if (path === '/api/shutdown') {
      res.writeHead(204, { Connection: 'close' });
      res.end(() => onShutdown?.());
      return;
    }
    if (path !== '/api/hide' && path !== '/api/rename') return notFound(res);

    let json;
    try {
      json = JSON.parse(body);
    } catch {
      return badRequest(res);
    }
    if (!isObj(json) || typeof json.sessionId !== 'string') return badRequest(res);

    if (path === '/api/hide') {
      if (!office.hide(json.sessionId)) return notFound(res);
    } else {
      if (typeof json.name !== 'string') return badRequest(res);
      if (!isVisible(json.sessionId)) return notFound(res);
      office.rename(json.sessionId, json.name);
    }
    await onSavedChange?.();
    res.writeHead(204);
    res.end();
  }

  async function handle(req, res) {
    if (!allowedHosts().includes(String(req.headers.host).toLowerCase())) return sendText(res, 403, 'forbidden');
    const q = req.url.indexOf('?');
    const path = q === -1 ? req.url : req.url.slice(0, q);
    const query = q === -1 ? '' : req.url.slice(q + 1); // not URL-normalized: traversal is checked on the file path

    if (req.method === 'POST') {
      const origin = String(req.headers.origin ?? '').toLowerCase();
      if (!allowedHosts().some((h) => origin === `http://${h}`)) return sendText(res, 403, 'forbidden');
      const body = await readBody(req, cfg.server.maxBodyBytes);
      if (body === null) return badRequest(res);
      return handlePost(path, body, res);
    }
    if (req.method !== 'GET') return notFound(res);

    switch (path) {
      case '/health': return sendJson(res, 200, { app: 'agent-office', pid: process.pid });
      case '/api/state': return sendJson(res, 200, office.snapshot());
      case '/api/log': return sendLog(res, query);
      case '/api/ui': return sendJson(res, 200, uiConfig());
      case '/api/events':
        if (!server.listening) return sendText(res, 503, 'closing', { Connection: 'close' }); // shutting down: no new streams
        return openEvents(res);
      case '/': return sendStatic(res, 'web', 'index.html');
      case '/log': return sendStatic(res, 'web', 'log.html');
      default:
    }
    for (const dir of STATIC_DIRS) {
      if (path.startsWith(`/${dir}/`)) return sendStatic(res, dir, path.slice(dir.length + 2));
    }
    return notFound(res);
  }

  return server;
}
