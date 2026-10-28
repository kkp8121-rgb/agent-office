'use strict';
// Shared by the main page and the full log page (classic script: its top-level names are global to app.js / log.js).
// All server strings are inserted with textContent only.

function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

/** The hue is a pure function of the id (FNV-1a), so the main page, the log page and every reload agree. */
function hueOf(sessionId) {
  let h = 0x811c9dc5;
  for (let i = 0; i < sessionId.length; i++) h = Math.imul(h ^ sessionId.charCodeAt(i), 0x01000193);
  return (h >>> 0) % 360;
}
const colorOf = (sessionId) => `hsl(${hueOf(sessionId)} 55% 42%)`;

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
  return liveTitles.get(sessionId) ?? knownTitles?.[sessionId] ?? `지난 세션 ${sessionId.slice(0, 8)}`;
}

function logMetaText(count, capped) {
  if (!count) return '기록이 없습니다';
  return capped ? `최근 ${count}건만 표시 · 최신 순` : `${count}건 · 최신 순`;
}
