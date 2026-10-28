'use strict';
// Full log page. One fetch on load, one per filter change, one per 「새로 고침」 click. No timers, no streaming.
// Row rendering comes from logrow.js, shared with the main page.

const $ = (id) => document.getElementById(id);
const sessionSel = $('fsession');
const nameSel = $('fname');
const logEl = $('log');
const metaEl = $('logmeta');
const refreshBtn = $('refresh');

let seq = 0; // only the latest request may paint

async function getJson(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
}

/** Rebuilds a select keeping the chosen value when it is still offered; returns the value that ended up selected. */
function fillSelect(sel, options, wanted) {
  const keep = options.some(([v]) => v === wanted) ? wanted : '';
  sel.replaceChildren(el('option', '', '전체'));
  sel.firstChild.value = '';
  for (const [value, label] of options) {
    const o = el('option', '', label);
    o.value = value;
    sel.append(o);
  }
  sel.value = keep;
  return keep;
}

async function load() {
  const mine = ++seq;
  const params = new URLSearchParams();
  if (sessionSel.value) params.set('session', sessionSel.value);
  if (nameSel.value) params.set('name', nameSel.value);
  let state;
  let log;
  try {
    [state, log] = await Promise.all([getJson('/api/state'), getJson(`/api/log?${params}`)]);
  } catch {
    if (mine === seq) metaEl.textContent = '기록을 불러오지 못했습니다. 서버가 켜져 있는지 확인하세요.';
    return;
  }
  if (mine !== seq) return;
  const { entries, titles: known, capped } = log;

  // Options come only from live floors (the server leaves hidden ones out) and from what the log returned.
  const live = new Map(state.floors.map((f) => [f.sessionId, f.title]));
  const sessions = new Map(live);
  const names = new Set();
  for (const e of entries) {
    if (!sessions.has(e.sessionId)) sessions.set(e.sessionId, sessionLabel(e.sessionId, live, known));
    names.add(e.name);
  }
  const wantSid = sessionSel.value;
  const wantName = nameSel.value;
  const sid = fillSelect(sessionSel, [...sessions], wantSid);
  const nm = fillSelect(nameSel, [...names].map((n) => [n, n]), wantName);
  if (sid !== wantSid || nm !== wantName) return load(); // a chosen value is no longer offered (e.g. hidden): start over

  logEl.replaceChildren();
  for (const e of entries) {
    const row = createLogRow(e);
    fillLogRow(row, e);
    logEl.append(row);
  }
  setText(metaEl, logMetaText(entries.length, capped));
}

sessionSel.addEventListener('change', load);
nameSel.addEventListener('change', load);
refreshBtn.addEventListener('click', load);
load();
