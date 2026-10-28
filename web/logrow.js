'use strict';
// Shared by the main page and the full log page (classic script: its top-level names are global to app.js / log.js).
// All server strings are inserted with textContent only.

function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

const hues = new Map(); // sessionId -> hue; consecutive sessions get well-separated hues (golden angle)
function hueOf(sessionId) {
  if (!hues.has(sessionId)) hues.set(sessionId, Math.round((hues.size * 137.508 + 15) % 360));
  return hues.get(sessionId);
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
