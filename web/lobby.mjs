// Lobby (1F) helpers (pure): who stands in the lobby, where they sit, and every number and line the status wall shows.
// Everything here works on the snapshot the page already has (floors and their agents) plus the clock; nothing is drawn.

const BUSY = new Set(['working', 'thinking']);
const WAITING = new Set(['idle', 'enter', 'stale']);

const fill = (template, vars) => template.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''));
const pad2 = (n) => String(n).padStart(2, '0');

/** At most `max` characters (by code point); a longer text ends in an ellipsis. */
export function clip(text, max) {
  const chars = Array.from(String(text ?? ''));
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : chars.join('');
}

/**
 * Everyone of every floor, in floor order (floor number up): the floor's 팀장 first, then its 직원 by arrival time.
 * `floors` are snapshot floor views; `leadSince` maps a session id to when its 팀장's bubble last changed (the server sends no `since` for the lead).
 * rank: 'lead' | 'staff' | 'project' (a Workflow agent). `reports` of a 직원 is 1 once it has reported.
 */
export function lobbyRoster(floors, leadSince = new Map()) {
  const out = [];
  for (const fv of [...floors].sort((a, b) => a.floorNo - b.floorNo)) {
    const base = { sid: fv.sessionId, floorNo: fv.floorNo, colorIndex: fv.colorIndex, title: fv.title, floorStatus: fv.status };
    out.push({
      ...base, key: `${fv.sessionId}:lead`, name: fv.lead.name, role: fv.lead.role, sprite: fv.lead.sprite, rank: 'lead',
      state: fv.lead.state, bubble: fv.lead.bubble, since: leadSince.get(fv.sessionId) ?? 0, startedAt: fv.startedAt ?? 0, reports: fv.reports,
    });
    const agents = [...fv.agents].sort((a, b) => (a.enteredAt ?? 0) - (b.enteredAt ?? 0) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    for (const a of agents) {
      out.push({
        ...base, key: a.key, name: a.name, role: a.role, sprite: a.sprite, rank: a.wf ? 'project' : 'staff',
        state: a.state, bubble: a.bubble, since: a.since, startedAt: a.enteredAt ?? 0, reports: a.state === 'done' ? 1 : 0,
      });
    }
  }
  return out;
}

/** Index of the free slot closest to a team's own slots, else the first slot of the longest free run (ties: lowest index). -1 when none is free. */
function pickSlot(free, mine) {
  let best = -1;
  if (mine.length) {
    let bestD = Infinity;
    for (let i = 0; i < free.length; i++) {
      if (!free[i]) continue;
      let d = Infinity;
      for (const j of mine) d = Math.min(d, Math.abs(i - j));
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }
  let run = 0;
  let bestRun = 0;
  for (let i = 0; i <= free.length; i++) {
    if (i < free.length && free[i]) {
      run++;
      if (run > bestRun) {
        bestRun = run;
        best = i - run + 1;
      }
    } else run = 0;
  }
  return best;
}

/**
 * Where each roster entry sits: Map(key -> {kind: 'seat'|'overflow', i} | null). Entries keep the place they had in `prev`;
 * an overflow member moves to a free seat first, then newcomers are placed next to their own floor's seats (a floor with
 * none starts at the longest free run, so it has room to grow); a full lobby puts them on the standing spots, and beyond
 * those they get null (listed on the wall only). A newcomer that is already `done` is left out of the map (no seat, no figure, not
 * counted as unseated): it reported before the lobby ever drew it. One that already had a place keeps it.
 */
export function assignLobbySeats(prev, roster, seatCount, overflowCount) {
  const seats = new Array(seatCount).fill(true);
  const spots = new Array(overflowCount).fill(true);
  const out = new Map();
  const mine = { seat: new Map(), overflow: new Map() }; // sid -> indexes held
  const take = (e, kind, i) => {
    (kind === 'seat' ? seats : spots)[i] = false;
    out.set(e.key, { kind, i });
    const m = mine[kind];
    if (!m.has(e.sid)) m.set(e.sid, []);
    m.get(e.sid).push(i);
  };
  const waiting = [];
  const promoting = [];
  for (const e of roster) {
    const p = prev.get(e.key);
    if (p?.kind === 'seat' && p.i < seatCount && seats[p.i]) take(e, 'seat', p.i);
    else if (p?.kind === 'overflow' && p.i < overflowCount && spots[p.i]) {
      take(e, 'overflow', p.i);
      promoting.push(e);
    } else if (e.state !== 'done') waiting.push(e);
  }
  const place = (e, kinds) => {
    for (const kind of kinds) {
      const free = kind === 'seat' ? seats : spots;
      const i = pickSlot(free, mine[kind].get(e.sid) ?? []);
      if (i >= 0) return take(e, kind, i);
    }
    out.set(e.key, null);
  };
  for (const e of promoting) {
    const i = pickSlot(seats, mine.seat.get(e.sid) ?? []);
    if (i < 0) continue;
    const old = out.get(e.key);
    spots[old.i] = true;
    mine.overflow.set(e.sid, mine.overflow.get(e.sid).filter((j) => j !== old.i));
    take(e, 'seat', i);
  }
  for (const e of waiting) place(e, ['seat', 'overflow']);
  return out;
}

/**
 * The numbers of the five big cells (+ the sleepy count), over the roster and the floors.
 * 실패 = the failed tool results of every floor in the last `failMs` before `now` (the server sends their times in `failAt`), so it falls back to 0 when things calm down.
 */
export function headline(roster, floors, now, failMs) {
  let working = 0;
  let waiting = 0;
  let sleepy = 0;
  for (const e of roster) {
    if (BUSY.has(e.state)) working++;
    else if (WAITING.has(e.state)) waiting++;
    if (e.state === 'stale') sleepy++;
  }
  let reports = 0;
  let projects = 0;
  let fails = 0;
  for (const f of floors) {
    reports += f.reports ?? 0;
    projects += f.workflows ?? 0;
    for (const t of f.failAt ?? []) if (t > now - failMs && t <= now + 1000) fails++;
  }
  return { working, waiting, sleepy, reports, projects, fails };
}

// ---- 사무실 지수 and the per-floor 활동 지수 ----

/** Adds a sample {t, v} and drops what is no longer needed: the newest sample at least `windowMs` old stays as the base, older ones go. */
export function pushSample(samples, t, v, windowMs) {
  samples.push({ t, v });
  let base = -1;
  for (let i = 0; i < samples.length - 1; i++) {
    if (samples[i].t <= t - windowMs) base = i;
    else break;
  }
  if (base > 0) samples.splice(0, base);
  return samples;
}

/**
 * Change of the newest sample against the base sample (the newest one at least `windowMs` old, else the oldest one kept; a lone sample has no change).
 * `dir` is 'up' | 'down' | 'flat'; `pct` is the change in percent of the base (a base of 0 counts as 1), one decimal.
 */
export function changeOf(samples, windowMs) {
  const cur = samples[samples.length - 1];
  let base = null;
  for (let i = 0; i < samples.length - 1; i++) if (base === null || samples[i].t <= cur.t - windowMs) base = samples[i];
  const prev = base ? base.v : cur.v;
  const delta = cur.v - prev;
  const pct = Math.round((delta / Math.max(prev, 1)) * 1000) / 10;
  return { delta, pct, dir: delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat' };
}

/** `▲ 3 (5.0%)` / `▼ 2 (4.0%)` / `-`. `withPct` false leaves the percent out (narrow rows). */
export function changeText(ch, withPct = true) {
  if (ch.dir === 'flat') return '-';
  const mark = ch.dir === 'up' ? '▲' : '▼';
  const n = Math.abs(ch.delta);
  return withPct ? `${mark} ${n} (${Math.abs(ch.pct).toFixed(1)}%)` : `${mark}${n}`;
}

// ---- 직원 현황판 ----

/** 근무 시간: under an hour 「{m}분」, else 「{h}시간 {m}분」. `labels` = ui.lobby (minutes, hours). */
export function fmtDuration(ms, labels) {
  const mins = Math.max(0, Math.floor(ms / 60000));
  return mins < 60 ? fill(labels.minutes, { m: mins }) : fill(labels.hours, { h: Math.floor(mins / 60), m: mins % 60 });
}

/** The state words of the wall: a leaving floor says 퇴근 중 for everyone. */
export const stateLabel = (e, labels) => (e.floorStatus === 'leaving' ? labels.state.leaving : labels.state[e.state] ?? e.state);

/**
 * One table row per roster entry: cells in column order (이름, 층, 구분, 상태, 지금 하는 일, 근무 시간, 보고) and the full task text for the tooltip.
 * `labels` = ui.lobby, `bubbleMax` = ui.bubbleMaxChars, `now` in ms, `statusWords` = ui.play.statusBubbles (the stock phrases of a quiet 직원).
 * No column repeats another: see taskCell.
 */
export function employeeRows(roster, now, labels, bubbleMax, statusWords = []) {
  return roster.map((e) => {
    const state = stateLabel(e, labels);
    const started = e.startedAt > 0 ? fmtDuration(now - e.startedAt, labels) : '-';
    const others = [e.name, fill(labels.floorLabel, { n: e.floorNo }), labels.rank[e.rank], state, started];
    const cells = [others[0], others[1], others[2], state, taskCell(e.bubble, others, statusWords, bubbleMax), started, e.reports > 0 ? String(e.reports) : '-'];
    return { key: e.key, sid: e.sid, state: e.state, floorStatus: e.floorStatus, cells, text: cells.join('|') };
  });
}

/** A phrase without its trailing dots, ellipsis and spaces, so 「생각 중…」 and 「생각 중」 compare equal. */
const stem = (t) => String(t ?? '').replace(/[\s.…·]+$/u, '').trim();

/**
 * 지금 하는 일 of a row. The cell carries what the other columns do not already say, so it is 「-」 when the bubble is empty, when it only
 * repeats another cell of the row (the 상태 word 「생각 중」 as 「생각 중…」, a name, a floor, a rank), or when it is one of the stock phrases
 * a quiet 직원 shows (`statusWords`: 생각 중 / 응답 없음 / 입력 대기 / 작업 중 / 퇴근 중), which only restate the 상태. Otherwise the clipped text.
 */
export function taskCell(bubble, others, statusWords, max) {
  const t = stem(bubble);
  if (!t || others.some((c) => stem(c) === t) || statusWords.some((w) => stem(w) === t)) return '-';
  return clip(bubble, max);
}

/** Rows that fit a wall panel `h` px high: the header takes one line and the padding both sides (at least 1). */
export const tableCapacity = (h, rowPx, padPx) => Math.max(1, Math.floor((h - 2 * padPx) / rowPx) - 1);

/** Number of pages of `n` rows, `cap` per page (at least 1). */
export const pageCount = (n, cap) => Math.max(1, Math.ceil(n / cap));

/** The rows of page `page` (counted from 0; a page past the end wraps to the first). */
export function pageRows(rows, cap, page) {
  const p = page % pageCount(rows.length, cap);
  return rows.slice(p * cap, p * cap + cap);
}

// ---- 층별 활동 지수 ----

/**
 * One row per floor (floor order, as given): its number, clipped title, 팀장 name, score and change. At most `max` rows; `more` counts the rest.
 * `scores` maps a session id to its follow score, `changes` to its changeOf() result.
 */
export function indexRows(floors, scores, changes, labels, max) {
  const sorted = [...floors].sort((a, b) => a.floorNo - b.floorNo);
  const rows = sorted.slice(0, max).map((f) => {
    const score = scores.get(f.sessionId) ?? 0;
    const ch = changes.get(f.sessionId) ?? { delta: 0, pct: 0, dir: 'flat' };
    return { sid: f.sessionId, floorNo: f.floorNo, floor: fill(labels.floorLabel, { n: f.floorNo }), title: clip(f.title, labels.titleMax), lead: f.lead.name, score, change: ch, changeText: changeText(ch, false) };
  });
  return { rows, more: sorted.length - rows.length };
}

/**
 * The seats of the back row (the smallest y): only their full text bubbles are shown in the lobby, because above them there is the wall;
 * a bubble over any other row would sit on the face of the figure behind. Returns the set of seat indexes.
 */
export function backRowSeats(seats) {
  const top = Math.min(...seats.map((s) => s.at[1]));
  return new Set(seats.flatMap((s, i) => (s.at[1] <= top + 4 ? [i] : [])));
}

/** Sum of every floor's score (the 사무실 지수). */
export const officeScore = (scores) => [...scores.values()].reduce((s, v) => s + v, 0);

// ---- 업무 일지 line and clock ----

/** `HH:MM 2층 이름 · text` (the floor part is left out when the floor is gone). `e` is a log entry {ts, name, head?, text}. */
export function newsText(e, floorNo, labels) {
  const d = new Date(e.ts);
  const where = floorNo ? `${fill(labels.floorLabel, { n: floorNo })} ` : '';
  const body = e.head ? `${e.head} · ${e.text}` : e.text;
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())} ${where}${e.name} · ${clip(body, labels.newsMax)}`;
}

/** Date and time of the wall clock: {date: 'MM.DD (요일)', time: 'HH:MM'}. `days` = ui.lobby.days (Sunday first). */
export function clockParts(now, days) {
  const d = new Date(now);
  return { date: `${pad2(d.getMonth() + 1)}.${pad2(d.getDate())} (${days[d.getDay()]})`, time: `${pad2(d.getHours())}:${pad2(d.getMinutes())}` };
}

/** Milliseconds to the next full minute (at least 1 s, so a tick right on the boundary does not fire twice). */
export const msToNextMinute = (now) => Math.max(1000, 60000 - (now % 60000));
