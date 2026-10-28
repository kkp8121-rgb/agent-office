'use strict';
// Shared by the main page and the full log page (classic script: its top-level names are global to app.js / log.js).
// All server strings are inserted with textContent only.

function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

/** The server gives each session a palette index (floor.colorIndex, /api/log colors); ui.sessionPalette turns it into a colour. */
const sessionColorIdx = new Map(); // sessionId -> palette index
let sessionPalette = [];
/** Finished agents fill a 3-wide grid leftwards from the tray; every other row is shifted half a step and stands one row higher, so no two slots coincide. */
function trayPos(i, tray, stepPx, rowPx) {
  const row = Math.floor(i / 3);
  return { x: tray[0] - ((i % 3) + (row % 2) / 2) * stepPx, y: tray[1] - row * rowPx };
}
const colorOf = (sessionId) => sessionPalette[sessionColorIdx.get(sessionId)] ?? '#8a6a42';

const spriteUrl = (key) => `/assets/sprites/${encodeURIComponent(key)}.png`;

function makeSprite(key) {
  const img = document.createElement('img');
  img.alt = '';
  img.decoding = 'async';
  img.addEventListener('error', () => {
    if (!img.src.endsWith('/default.png')) img.src = spriteUrl('default');
  });
  img.src = spriteUrl(key);
  return img;
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}
function clock(ts) {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function createLogRow(e) {
  const root = el('div', 'ev');
  const img = makeSprite(e.sprite);
  img.className = 'ico';
  const t = el('div', 't');
  const h = el('div', 'h');
  h.append(el('b'), el('span'));
  t.append(h, el('p'));
  root.append(img, t);
  return root;
}

function fillLogRow(row, e) {
  row.dataset.id = e.id;
  row.dataset.sid = e.sessionId;
  row.dataset.ts = String(e.ts);
  row.style.setProperty('--c', colorOf(e.sessionId));
  const [b, time] = row.querySelectorAll('.h > *');
  setText(b, e.name);
  b.title = e.role;
  setText(time, clock(e.ts));
  setText(row.querySelector('p'), e.head ? `${e.head} · ${e.text}` : e.text);
}

/** Session filter label: a live floor's title, else the last title the server remembers, else a bare id prefix. */
function sessionLabel(sessionId, liveTitles, knownTitles) {
  return liveTitles.get(sessionId) ?? (knownTitles && Object.hasOwn(knownTitles, sessionId) ? knownTitles[sessionId] : undefined) ?? `지난 세션 ${sessionId.slice(0, 8)}`;
}

function logMetaText(count, capped) {
  if (!count) return '기록이 없습니다';
  return capped ? `최근 ${count}건만 표시 · 최신 순` : `${count}건 · 최신 순`;
}
