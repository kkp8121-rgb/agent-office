// Same-file edit tracker: which floors edited the same file lately. Pure: no I/O, no clock; the caller passes every `now`.
// A file is only ever seen as an opaque key (parse.mjs hashes the path with a per-start salt): keys never leave the server.

const CONFLICT_ID_PREFIX = 'c'; // ids are a plain counter, unrelated to the key: 'c1', 'c2', ...

export class ConflictTracker {
  /** @param {{windowMs:number, maxKeys:number}} cfg `conflict` block of config.json */
  constructor(cfg) {
    this.windowMs = cfg.windowMs;
    this.maxKeys = cfg.maxKeys;
    this.keys = new Map(); // fileKey -> Map(sessionId -> {actorKey, ts}); Map order = least recently touched first
    this.active = new Map(); // fileKey -> {id, since} of a conflict that is on
    this.seq = 0;
    this.sig = '[]'; // what the last evaluate() returned, to tell the caller whether anything changed
  }

  /** `actorKey` is the person who edited it (the lead or an agent key); the newest edit of a floor wins. */
  touch(fileKey, sessionId, actorKey, ts) {
    let floors = this.keys.get(fileKey);
    if (floors) this.keys.delete(fileKey); // re-inserted below: the Map order is the recency order
    else floors = new Map();
    this.keys.set(fileKey, floors);
    const prev = floors.get(sessionId);
    if (!prev || ts >= prev.ts) floors.set(sessionId, { actorKey, ts });
    while (this.keys.size > this.maxKeys) {
      const oldest = this.keys.keys().next().value;
      this.keys.delete(oldest);
      this.active.delete(oldest);
    }
  }

  /** A floor that left or was hidden: none of its edits count any more. */
  drop(sessionId) {
    for (const [key, floors] of this.keys) {
      floors.delete(sessionId);
      if (floors.size === 0) this.keys.delete(key);
    }
  }

  /**
   * Conflicts at `now`: a file that two or more different floors edited within windowMs (a floor's own lead and agents
   * editing it is not a conflict). Returns
   *   bySession: Map(sessionId -> [{id, with:[sessionId], since, actorKey}]) oldest first
   *   raised:    [{id, sessionIds, since}] conflicts that began since the last call
   *   changed:   whether bySession differs from the last call
   */
  evaluate(now) {
    const from = now - this.windowMs;
    const bySession = new Map();
    const raised = [];
    const seen = new Set();
    for (const [key, floors] of this.keys) {
      for (const [sessionId, e] of floors) if (e.ts < from) floors.delete(sessionId);
      if (floors.size === 0) {
        this.keys.delete(key);
        continue;
      }
      if (floors.size < 2) continue; // one floor only (its lead and agents share one entry): not a conflict
      seen.add(key);
      const ts = [...floors.values()].map((e) => e.ts).sort((a, b) => a - b);
      let c = this.active.get(key);
      if (!c) {
        c = { id: `${CONFLICT_ID_PREFIX}${++this.seq}`, since: ts[1] }; // it began when the second floor joined
        this.active.set(key, c);
        raised.push({ id: c.id, sessionIds: [...floors.keys()].sort(), since: c.since });
      }
      for (const [sessionId, e] of floors) {
        const others = [...floors.keys()].filter((s) => s !== sessionId).sort();
        if (!bySession.has(sessionId)) bySession.set(sessionId, []);
        bySession.get(sessionId).push({ id: c.id, with: others, since: c.since, actorKey: e.actorKey });
      }
    }
    for (const key of [...this.active.keys()]) if (!seen.has(key)) this.active.delete(key); // gone: a new one gets a new id
    for (const list of bySession.values()) list.sort((a, b) => a.since - b.since || Number(a.id.slice(1)) - Number(b.id.slice(1)));
    const sig = JSON.stringify([...bySession].sort(([a], [b]) => (a < b ? -1 : 1)).map(([s, l]) => [s, l.map((c) => [c.id, c.with, c.since, c.actorKey])]));
    const changed = sig !== this.sig;
    this.sig = sig;
    return { bySession, raised, changed };
  }
}
