// "Today's labour cost": token totals per day, per hour of the day, per floor and per person.
// Pure: no I/O and no clock of its own. The caller says what time it is and how a time becomes a day (`clock`), so tests
// and the server agree on every day boundary. Only numbers are kept; the one string a file holds is a day key.

const HOURS = 24;
const HOUR_MS = 3600 * 1000;
const MINUTE_MS = 60 * 1000;
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
const KEY_LEN = 10; // YYYY-MM-DD

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const count = (v) => (isNum(v) && v > 0 ? v : 0);

/** The day key `n` calendar days from `key` (negative = earlier). */
export function shiftDay(key, n) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, KEY_LEN);
}

/**
 * Day boundaries on this PC's wall clock: a day starts at `dayStartHour` local time. `offsetMinutes(ts)` is the local
 * offset from UTC at that time (default: the machine's own; tests pass a fixed one).
 * @returns {{dayKey(ts:number):string, hourOf(ts:number):number, dayStart(key:string):number}}
 */
export function localClock(dayStartHour, offsetMinutes = (ts) => -new Date(ts).getTimezoneOffset()) {
  const shifted = (ts) => ts + offsetMinutes(ts) * MINUTE_MS - dayStartHour * HOUR_MS;
  return {
    dayKey: (ts) => new Date(shifted(ts)).toISOString().slice(0, KEY_LEN),
    hourOf: (ts) => new Date(shifted(ts)).getUTCHours(),
    dayStart(key) {
      const [y, m, d] = key.split('-').map(Number);
      const wall = Date.UTC(y, m - 1, d) + dayStartHour * HOUR_MS; // the wall-clock moment, written as if it were UTC
      return wall - offsetMinutes(wall - offsetMinutes(wall) * MINUTE_MS) * MINUTE_MS;
    },
  };
}

const newDay = () => ({ tokens: 0, cacheRead: 0, byHour: new Array(HOURS).fill(0), partial: false });

export class CostLedger {
  #clock;
  #keepDays;
  #dedupeCap;
  #topCount;
  #days = new Map(); // day key -> {tokens, cacheRead, byHour[24], partial}
  #detail = new Map(); // day key -> {floors: Map(sessionId -> {tokens, cacheRead}), people: Map(sessionId + NUL + agentKey -> {sessionId, agentKey, tokens})}
  #seen = new Map(); // file key -> Map(msgId -> day key): the recent message ids of one transcript, oldest first
  #scanned = new Set(); // day keys that a start-up scan has counted
  #scanning = false;
  #seenUntil = 0; // newest time counted so far
  #liveFloor = 0; // a live line at or before this was counted by an earlier run (see fromJSON)
  #version = 0;

  /**
   * @param {{clock:{dayKey:Function,hourOf:Function}, keepDays:number, dedupePerFile:number, topCount:number}} o
   */
  constructor({ clock, keepDays, dedupePerFile, topCount }) {
    this.#clock = clock;
    this.#keepDays = keepDays;
    this.#dedupeCap = dedupePerFile;
    this.#topCount = topCount;
  }

  /** The day and hour bucket of `ts`: the frame's "same hour last week" figure moves when this does. */
  slot(ts) {
    return `${this.#clock.dayKey(ts)}|${this.#clock.hourOf(ts)}`;
  }

  /** Grows whenever something the frame shows may have changed. */
  get version() {
    return this.#version;
  }

  get scanning() {
    return this.#scanning;
  }

  setScanning(on) {
    if (this.#scanning === on) return;
    this.#scanning = on;
    this.#version++;
  }

  isScanned(day) {
    return this.#scanned.has(day);
  }

  /**
   * A start-up scan is about to count `days` from the records: whatever those days hold (from a live run, or from a scan that
   * did not finish) is dropped, and so are the message ids that made it, so the scan counts the day once and whole.
   */
  beginScan(days) {
    const drop = new Set(days);
    for (const day of drop) {
      this.#days.delete(day);
      this.#detail.delete(day);
    }
    for (const ids of this.#seen.values()) for (const [id, day] of ids) if (drop.has(day)) ids.delete(id);
    this.#version++;
  }

  /** The scan of `day` is over; `partial` = the byte limit stopped it before every file was read. */
  markScanned(day, partial) {
    this.#scanned.add(day);
    if (partial) this.#dayRec(day).partial = true;
    this.#version++;
  }

  #dayRec(day) {
    let rec = this.#days.get(day);
    if (!rec) this.#days.set(day, (rec = newDay()));
    return rec;
  }

  #detailRec(day) {
    let rec = this.#detail.get(day);
    if (!rec) this.#detail.set(day, (rec = { floors: new Map(), people: new Map() }));
    return rec;
  }

  static #fileKey({ provider, sessionId, agentKey }) {
    return `${provider}|${sessionId}|${agentKey ?? ''}`;
  }

  /**
   * Counts one model response once. The same `msgId` repeats on every transcript line a response is written on; it is
   * remembered per transcript (the last `dedupePerFile` ids). A live line from before the previous run's last count is
   * ignored (`scan: true` lines are exempt: a scan counts whole days). A scan keeps every id of the file it is reading
   * until `endFile`, so a file longer than the limit still recognises the lines a live tail counted first.
   * @returns {boolean} true when it was counted
   */
  add(ev, { scan = false } = {}) {
    const { ts, sessionId, agentKey = null, provider, msgId, tokens, cacheRead } = ev;
    if (!isNum(ts) || ts <= 0 || typeof sessionId !== 'string' || typeof msgId !== 'string' || !msgId) return false;
    if (!scan && ts <= this.#liveFloor) return false;
    const day = this.#clock.dayKey(ts);
    const fileKey = CostLedger.#fileKey({ provider, sessionId, agentKey });
    let ids = this.#seen.get(fileKey);
    if (!ids) this.#seen.set(fileKey, (ids = new Map()));
    if (ids.has(msgId)) {
      ids.delete(msgId); // seen again: it is the most recent one now
      ids.set(msgId, day);
      return false;
    }
    ids.set(msgId, day);
    if (!scan && ids.size > this.#dedupeCap) ids.delete(ids.keys().next().value);

    const t = count(tokens);
    const c = count(cacheRead);
    const rec = this.#dayRec(day);
    rec.tokens += t;
    rec.cacheRead += c;
    rec.byHour[this.#clock.hourOf(ts)] += t;
    const detail = this.#detailRec(day);
    const floor = detail.floors.get(sessionId) ?? { tokens: 0, cacheRead: 0 };
    floor.tokens += t;
    floor.cacheRead += c;
    detail.floors.set(sessionId, floor);
    const personKey = `${sessionId}\0${agentKey ?? ''}`;
    const person = detail.people.get(personKey) ?? { sessionId, agentKey, tokens: 0 };
    person.tokens += t;
    detail.people.set(personKey, person);
    this.#seenUntil = Math.max(this.#seenUntil, ts);
    this.#version++;
    return true;
  }

  /** A scan finished reading one transcript: its remembered ids shrink to the most recent `dedupePerFile`. */
  endFile(owner) {
    const ids = this.#seen.get(CostLedger.#fileKey(owner));
    while (ids && ids.size > this.#dedupeCap) ids.delete(ids.keys().next().value);
  }

  /**
   * What the screen shows at `nowTs`. `lastWeek` = the same weekday a week ago up to the same hour, or null when nothing
   * is recorded for that day. `floors` and `top` hold session and agent ids only (names are the caller's to add).
   */
  today(nowTs) {
    const day = this.#clock.dayKey(nowTs);
    const rec = this.#days.get(day) ?? newDay();
    const detail = this.#detail.get(day);
    const week = this.#days.get(shiftDay(day, -7));
    const hour = this.#clock.hourOf(nowTs);
    const people = detail ? [...detail.people.values()] : [];
    people.sort((a, b) => b.tokens - a.tokens);
    return {
      day,
      tokens: rec.tokens,
      cacheRead: rec.cacheRead,
      byHour: [...rec.byHour],
      partial: rec.partial,
      scanning: this.#scanning,
      lastWeek: week
        ? { day: shiftDay(day, -7), tokensSameHour: week.byHour.slice(0, hour + 1).reduce((a, b) => a + b, 0), partial: week.partial }
        : null,
      floors: detail ? [...detail.floors].map(([sessionId, f]) => ({ sessionId, tokens: f.tokens, cacheRead: f.cacheRead })) : [],
      top: people.slice(0, this.#topCount).map((p) => ({ sessionId: p.sessionId, agentKey: p.agentKey, tokens: p.tokens })),
    };
  }

  /** Drops what is older than `keepDays` before the day of `nowTs`. */
  prune(nowTs) {
    const cutoff = shiftDay(this.#clock.dayKey(nowTs), -this.#keepDays);
    for (const m of [this.#days, this.#detail]) for (const day of [...m.keys()]) if (day < cutoff) m.delete(day);
    for (const day of [...this.#scanned]) if (day < cutoff) this.#scanned.delete(day);
    for (const [key, ids] of this.#seen) {
      for (const [id, day] of ids) if (day < cutoff) ids.delete(id);
      if (ids.size === 0) this.#seen.delete(key);
    }
  }

  /**
   * The saved form: numbers, booleans and day keys only (no names, no paths, no text). Today's per-floor and per-person totals
   * are kept too, as numbers under the session and agent keys the ledger already uses, so a restart on the same day shows the
   * same floors and top; an earlier day's detail is not written. `nowTs` picks the cut-off for `keepDays` and which day is today
   * (default: the newest day held).
   */
  toJSON(nowTs) {
    const newest = [...this.#days.keys(), ...this.#scanned].sort().at(-1);
    const ref = isNum(nowTs) ? this.#clock.dayKey(nowTs) : newest;
    const cutoff = ref ? shiftDay(ref, -this.#keepDays) : '';
    const days = {};
    for (const [day, rec] of [...this.#days].sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (day >= cutoff) days[day] = { tokens: rec.tokens, cacheRead: rec.cacheRead, byHour: [...rec.byHour], partial: rec.partial };
    }
    const out = { version: 1, seenUntil: this.#seenUntil, scannedDays: [...this.#scanned].filter((d) => d >= cutoff).sort(), days };
    const detail = ref && this.#detail.get(ref);
    if (detail) {
      const people = Object.create(null);
      for (const { sessionId, agentKey, tokens } of detail.people.values()) {
        (people[sessionId] ??= Object.create(null))[agentKey ?? ''] = tokens;
      }
      out.detail = {
        day: ref,
        floors: Object.fromEntries([...detail.floors].map(([sessionId, f]) => [sessionId, { tokens: f.tokens, cacheRead: f.cacheRead }])),
        people: Object.fromEntries(Object.entries(people).map(([k, v]) => [k, { ...v }])),
      };
    }
    return out;
  }

  /**
   * A ledger from a saved form; anything malformed is skipped. With `nowTs`, saved per-floor and per-person totals of any other
   * day than today are dropped instead of restored.
   */
  static fromJSON(json, opts, nowTs) {
    const ledger = new CostLedger(opts);
    if (!json || typeof json !== 'object') return ledger;
    for (const [day, rec] of Object.entries(json.days && typeof json.days === 'object' ? json.days : {})) {
      if (!DAY_KEY.test(day) || !rec || typeof rec !== 'object') continue;
      const out = newDay();
      out.tokens = count(rec.tokens);
      out.cacheRead = count(rec.cacheRead);
      if (Array.isArray(rec.byHour)) for (let h = 0; h < HOURS; h++) out.byHour[h] = count(rec.byHour[h]);
      out.partial = rec.partial === true;
      ledger.#days.set(day, out);
    }
    for (const day of Array.isArray(json.scannedDays) ? json.scannedDays : []) if (typeof day === 'string' && DAY_KEY.test(day)) ledger.#scanned.add(day);
    ledger.#seenUntil = ledger.#liveFloor = count(json.seenUntil);
    const saved = json.detail;
    if (saved && typeof saved === 'object' && DAY_KEY.test(saved.day) && ledger.#days.has(saved.day) && (!isNum(nowTs) || opts.clock.dayKey(nowTs) === saved.day)) {
      const rec = ledger.#detailRec(saved.day);
      for (const [sessionId, f] of Object.entries(saved.floors && typeof saved.floors === 'object' ? saved.floors : {})) {
        // the earlier saved form held a plain number per floor (tokens only)
        rec.floors.set(sessionId, f && typeof f === 'object' ? { tokens: count(f.tokens), cacheRead: count(f.cacheRead) } : { tokens: count(f), cacheRead: 0 });
      }
      for (const [sessionId, agents] of Object.entries(saved.people && typeof saved.people === 'object' ? saved.people : {})) {
        for (const [key, tokens] of Object.entries(agents && typeof agents === 'object' ? agents : {})) {
          const agentKey = key === '' ? null : key;
          rec.people.set(`${sessionId}\0${key}`, { sessionId, agentKey, tokens: count(tokens) });
        }
      }
    }
    return ledger;
  }
}
