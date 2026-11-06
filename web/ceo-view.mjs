// The boss room (사장실) as plain rules: no DOM, no clock, no timers. web/ceo-floor.mjs draws and moves; tests/ceo-view.test.mjs checks these.
// What lives here: which visit spot a calling floor's lead gets (and the 「대기 n」 queue), the one-boss rule of the bell meeting, who goes up to the roof,
// the schedule of a bell meeting with the boss in the chair, and the five lines of the chalkboard (numbers from web/cost-view.mjs).
// Numbers and words come from config ui.ceo, ui.bellMeeting, ui.cost; nothing here has a number of its own.
import { costView } from './cost-view.mjs';

/** `{n}`-style placeholders of a config text. */
export const fill = (text, vars) => String(text).replace(/\{(\w+)\}/g, (_, key) => String(vars[key] ?? ''));

// ---------- which floors call, which floors rest ----------

const order = (a, b) => {
  const [x, y] = [a.since ?? Infinity, b.since ?? Infinity];
  return x === y ? 0 : x < y ? -1 : 1;
};

/** The floors whose lead brings a paper to the boss: a call is on, the floor is not on its lunch break and not leaving. [{sid, since}] in the order the views came. */
export const callers = (list) => list.filter((v) => typeof v.call === 'string' && !v.rest && v.status !== 'leaving').map((v) => ({ sid: v.sessionId, since: v.callSince ?? null }));

/** The floors on a lunch break (a usage limit), in the order the views came. */
export const resters = (list) => list.filter((v) => v.rest && v.status !== 'leaving').map((v) => v.sessionId);

// ---------- visit spots ----------

/**
 * The visit spots in front of the boss's desk (scene `visits`). A floor that calls gets the lowest free spot, the one that called first before the others
 * (`since`; equal or unknown: the order given). A floor without a free spot waits in the queue; it gets the spot of the next floor whose call ends.
 * `sync` takes the floors that call now and returns what changed: `started` (a lead goes up: new calls and queued ones that got a spot) and `released` (a call ended).
 * @param {number} spotCount
 */
export function createVisitBoard(spotCount) {
  const spots = Array.from({ length: spotCount }, () => null);
  let waiting = [];
  return {
    /** @param {{sid: string, since: ?number}[]} calling @returns {{started: {sid: string, spot: number}[], released: {sid: string, spot: number}[]}} */
    sync(calling) {
      const sids = [...calling].sort(order).map((c) => c.sid);
      const live = new Set(sids);
      const released = [];
      spots.forEach((sid, spot) => {
        if (sid === null || live.has(sid)) return;
        released.push({ sid, spot });
        spots[spot] = null;
      });
      const started = [];
      waiting = [];
      for (const sid of sids) {
        if (spots.includes(sid)) continue;
        const spot = spots.indexOf(null);
        if (spot < 0) {
          waiting.push(sid);
          continue;
        }
        spots[spot] = sid;
        started.push({ sid, spot });
      }
      return { started, released };
    },
    spotOf(sid) {
      const spot = spots.indexOf(sid);
      return spot < 0 ? null : spot;
    },
    /** The floors standing at a spot: [{sid, spot}] by spot. */
    assigned: () => spots.flatMap((sid, spot) => (sid === null ? [] : [{ sid, spot }])),
    queued: () => [...waiting],
    queueCount: () => waiting.length,
  };
}

/**
 * What the screens show, from the board: the boss room has one visitor per assigned floor, but only while the room is alive (a still or hidden boss room has no
 * visitor records at all, they are made again, standing, when it wakes); a floor's lead is away only while the whole building is on show.
 * @returns {{visitors: {sid: string, spot: number}[], away: string[], queue: number}}
 */
export function presence(board, { ceoActive, buildingActive }) {
  const assigned = board.assigned();
  return { visitors: ceoActive ? assigned : [], away: buildingActive ? assigned.map((a) => a.sid) : [], queue: ceoActive ? board.queueCount() : 0 };
}

// ---------- the one boss ----------

/** The boss is one person: whoever rings first has him; a second bell meeting at the same time is led by its floor's lead. */
export function createBossLock() {
  let holder = null;
  return {
    /** @returns {boolean} true when the boss is (now) with `sid` */
    claim(sid) {
      if (holder !== null && holder !== sid) return false;
      holder = sid;
      return true;
    },
    release(sid) {
      if (holder === sid) holder = null;
    },
    holder: () => holder,
  };
}

/** Who chairs the bell meeting of floor `sid`: the boss when he may walk (effects on, no reduced motion) and is not with another floor, else the lead. */
export function bellChair({ moves, lock, sid }) {
  return moves && lock.claim(sid) ? 'ceo' : 'lead';
}

/**
 * The bell meeting as a list of lines to say. `plan` is planBell(); with the boss in the chair he opens first (a line of his own), so the speakers start one
 * turn later than the plan says. `who` is a person id from the plan, or 'chair' (whoever stands at the boss spot).
 * @returns {{events: {at: number, who: any, text: string}[], totalMs: number}} events in time order
 */
export function bellTimeline(plan, bm) {
  const shift = plan.open ? bm.sayMs + bm.gapMs : 0;
  const events = [];
  if (plan.open) events.push({ at: 0, who: 'chair', text: plan.open.text });
  for (const slot of plan.slots) events.push({ at: slot.atMs + shift, who: slot.id, text: slot.text });
  events.push({ at: plan.close.atMs + shift, who: 'chair', text: plan.close.text });
  return { events, totalMs: plan.totalMs + shift };
}

/** The meeting spot a person stands on: the nearest of `spots` ([{at: [x, y]}]) to (x, y). */
export function nearestSpot(spots, x, y) {
  let best = 0;
  let bestD = Infinity;
  spots.forEach((s, i) => {
    const d = Math.hypot(s.at[0] - x, s.at[1] - y);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
}

// ---------- the roof ----------

/** Roof bench of each resting floor: a floor that already sits keeps its bench, a new one takes the lowest free one, the floors past `spotCount` stay at their desks. */
export function assignRoof(restSids, spotCount, prev = new Map()) {
  const next = new Map();
  const taken = new Set();
  for (const sid of restSids) {
    const had = prev.get(sid);
    if (had !== undefined && had < spotCount && !taken.has(had)) {
      next.set(sid, had);
      taken.add(had);
    }
  }
  for (const sid of restSids) {
    if (next.has(sid)) continue;
    let spot = 0;
    while (taken.has(spot)) spot++;
    if (spot >= spotCount) continue;
    next.set(sid, spot);
    taken.add(spot);
  }
  return next;
}

// ---------- the chalkboard ----------

/**
 * The lines of the boss room's chalkboard: 2 + `board.rows` of them. The first has the title and today's total, the second compares with the same hour last week,
 * then the top people of the day (name, floor, tokens). Before the first frame the words are ui.cost.empty, while the old logs are counted ui.cost.scanning.
 * `floorLabel(person)` is the text of the floor column (the floor number, or the floor's name when it has left).
 * @param {object|null} frame the latest `cost` frame
 * @returns {{kind: 'head'|'week'|'person', left: string, mid?: string, right: string}[]}
 */
export function boardLines(frame, board, cost, floorLabel) {
  const v = costView(frame, cost, board.rows);
  const weekHalf = cost.news.split(' · ').slice(1).join(' · ');
  const word = v.state === 'scanning' ? cost.scanning : cost.empty;
  let week = word;
  if (v.state === 'ready') week = v.lastWeek ? fill(weekHalf || cost.news, { lastWeek: v.lastWeek.text, diff: v.diff ?? '' }).replace(/\s*\(\)/, '') : cost.noLastWeek;
  const lines = [{ kind: 'head', left: board.title, right: v.total }, { kind: 'week', left: week, right: '' }];
  for (let i = 0; i < board.rows; i++) {
    const p = v.top[i];
    lines.push(p ? { kind: 'person', left: p.name, mid: floorLabel(p), right: p.text } : { kind: 'person', left: '', mid: '', right: '' });
  }
  return lines;
}

/** A string that changes exactly when the board's lines change (the board redraws only then). */
export const linesKey = (lines) => lines.map((l) => `${l.left}|${l.mid ?? ''}|${l.right}`).join('\n');
