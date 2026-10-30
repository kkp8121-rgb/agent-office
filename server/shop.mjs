// Coins, furniture inventory and placed furniture (<dir>/shop.json). Pure state plus one atomic save; no timers.
// Only ids and numbers are stored (agent ids as credit keys, item ids, scene pixels) - nothing from transcripts.
import { mkdirSync, readFileSync, renameSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveScene } from '../web/scene.mjs';
import { checkPlacement } from '../web/placement.mjs';

const HOUR = 3600000;
const PRUNE_EVERY_MS = HOUR;
const isObj = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const isCount = (v) => Number.isInteger(v) && v >= 0;

const ok = (extra = {}) => ({ ok: true, status: 200, ...extra });
const no = (status, code, message) => ({ ok: false, status, code, message });

export class Shop {
  /**
   * @param {object} cfg loaded config (cfg.shop, cfg.scenes, cfg.nav, cfg.dataDir)
   * @param {{log?: (msg: string) => void}} [opts]
   */
  constructor(cfg, { log = (m) => console.error(m) } = {}) {
    this.conf = cfg.shop;
    this.nav = cfg.nav;
    this.scenes = cfg.scenes;
    this.file = join(cfg.dataDir, 'shop.json');
    this.dir = cfg.dataDir;
    this.log = log;
    this.catalog = new Map(this.conf.catalog.map((c) => [c.id, c]));
    this.resolved = new Map(); // design -> resolved scene
    /** Increments on every change to what is stored. */
    this.version = 0;
    this.lastPrune = 0;
    this.events = []; // earn events not yet sent to the pages
    this.#load();
  }

  // ---- storage -----------------------------------------------------------------------------

  #fresh() {
    this.coins = this.conf.startCoins;
    this.inventory = {}; // item id -> count in the storage box
    this.placed = Object.fromEntries(Object.keys(this.scenes).map((d) => [d, []]));
    this.nextUid = 1;
    this.credited = {}; // credit key -> when it was credited (ms)
    this.version++; // a new store is written at the next save
  }

  #load() {
    let text;
    try {
      text = readFileSync(this.file, 'utf8');
    } catch (e) {
      if (e?.code !== 'ENOENT') this.log(`상점 파일을 읽지 못했습니다: ${e?.message ?? e}`);
      return this.#fresh();
    }
    let j;
    try {
      j = JSON.parse(text);
      if (!isObj(j) || j.version !== 1 || !isCount(j.coins) || !isObj(j.inventory) || !isObj(j.placed) || !isObj(j.credited)) throw new Error('형식이 맞지 않습니다');
    } catch (e) {
      const aside = join(this.dir, `shop.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
      try {
        renameSync(this.file, aside);
        this.log(`상점 파일이 깨져 있어 ${aside} 로 옮기고 새로 시작합니다 (${e?.message ?? e})`);
      } catch (e2) {
        this.log(`상점 파일이 깨져 있고 옮기지도 못했습니다: ${e2?.message ?? e2}`);
      }
      return this.#fresh();
    }
    this.coins = j.coins;
    this.inventory = {};
    for (const [id, n] of Object.entries(j.inventory)) if (this.catalog.has(id) && isCount(n) && n > 0) this.inventory[id] = n;
    this.placed = Object.fromEntries(Object.keys(this.scenes).map((d) => [d, []]));
    const uids = new Set();
    let dropped = 0;
    for (const [design, list] of Object.entries(j.placed)) {
      for (const p of Array.isArray(list) ? list : []) {
        const good = this.placed[design] && isObj(p) && typeof p.uid === 'string' && !uids.has(p.uid) && this.catalog.has(p.item) && Number.isFinite(p.x) && Number.isFinite(p.y);
        if (good) {
          uids.add(p.uid);
          this.placed[design].push({ uid: p.uid, item: p.item, x: p.x, y: p.y });
        } else dropped++;
      }
    }
    if (dropped) this.log(`상점 파일에서 알 수 없는 가구 ${dropped}개를 건너뛰었습니다`);
    this.nextUid = Math.max(isCount(j.nextUid) ? j.nextUid : 1, ...[...uids].map((u) => Number(/^d(\d+)$/.exec(u)?.[1] ?? 0) + 1));
    this.credited = {};
    for (const [k, ts] of Object.entries(j.credited)) if (Number.isFinite(ts)) this.credited[k] = ts;
    this.#prune(Date.now(), true);
  }

  /** The content written to disk. */
  toJSON() {
    return { version: 1, coins: this.coins, inventory: this.inventory, placed: this.placed, nextUid: this.nextUid, credited: this.credited };
  }

  /** Atomic write: temp file, then rename over the old one. */
  async save() {
    mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify(this, null, 2), 'utf8');
    await rename(tmp, this.file);
  }

  /** What the pages see (no credit keys). */
  view() {
    return { coins: this.coins, inventory: { ...this.inventory }, placed: Object.fromEntries(Object.entries(this.placed).map(([d, l]) => [d, l.map((p) => ({ ...p }))])) };
  }

  /** Catalog for the pages: id, name, price, blocks, footprint. */
  catalogView() {
    return this.conf.catalog.map((c) => ({ id: c.id, name: c.name, price: c.price, blocks: c.blocks, footprint: c.footprint.map((p) => [...p]) }));
  }

  // ---- earning -----------------------------------------------------------------------------

  /**
   * One credit per real finish. `info`: provider, sessionId, agentId, mtimeMs (when the agent's files last changed),
   * live (the office saw it running), hidden (its floor is hidden: the event then names no floor).
   *
   * Why this cannot pay twice: the key (provider:session:agent) stays in `credited` for creditKeepHours, so a repeat
   * (second sighting, backfill, restart) finds it. An agent the office never saw running is only credited when its files
   * changed within the last creditWindowHours, and creditKeepHours >= creditWindowHours: when a key has been pruned
   * (older than keepHours since credit), the agent's last change is older than its credit, so older than the window
   * as well, and it is refused.
   * @returns {{amount:number}|null}
   */
  credit(info, now) {
    const key = `${info.provider}:${info.sessionId}:${info.agentId}`;
    if (Object.hasOwn(this.credited, key)) return null;
    if (!info.live && !(info.mtimeMs > 0 && info.mtimeMs >= now - this.conf.creditWindowHours * HOUR)) return null;
    this.#prune(now);
    this.credited[key] = now;
    const amount = this.conf.coinsPerAgent;
    this.coins += amount;
    this.version++;
    this.events.push({ type: 'earn', amount, coins: this.coins, sessionId: info.hidden ? null : info.sessionId, key: info.hidden ? null : `${info.sessionId}:${info.agentId}`, live: info.live === true });
    return { amount };
  }

  #prune(now, force = false) {
    if (!force && now - this.lastPrune < PRUNE_EVERY_MS) return;
    this.lastPrune = now;
    const keep = now - this.conf.creditKeepHours * HOUR;
    let n = 0;
    for (const [k, ts] of Object.entries(this.credited)) {
      if (ts < keep) {
        delete this.credited[k];
        n++;
      }
    }
    if (n) this.version++;
  }

  drainEvents() {
    const out = this.events;
    this.events = [];
    return out;
  }

  // ---- shopping ----------------------------------------------------------------------------

  buy(item) {
    const c = typeof item === 'string' ? this.catalog.get(item) : undefined;
    if (!c) return no(400, 'unknown-item', '알 수 없는 가구예요');
    if (this.coins < c.price) return no(409, 'no-coins', `코인이 모자라요 (${c.price}코인 필요, ${this.coins}코인 보유)`);
    this.coins -= c.price;
    this.inventory[c.id] = (this.inventory[c.id] ?? 0) + 1;
    this.version++;
    return ok({ undo: () => { this.coins += c.price; this.#take(c.id); this.version++; } });
  }

  /** One item out of the storage box. */
  #take(id) {
    if (--this.inventory[id] === 0) delete this.inventory[id];
  }

  #scene(design) {
    if (!this.resolved.has(design)) this.resolved.set(design, resolveScene(this.scenes[design].raw));
    return this.resolved.get(design);
  }

  #check(design, placedWithout, cand) {
    return checkPlacement(this.#scene(design), this.nav, this.catalog, placedWithout, cand);
  }

  #point(v) {
    return Number.isFinite(v) ? Math.round(v) : NaN; // whole scene pixels: the page sends the same numbers it previewed
  }

  place(item, design, x, y) {
    if (typeof item !== 'string' || !this.catalog.has(item)) return no(400, 'unknown-item', '알 수 없는 가구예요');
    if (typeof design !== 'string' || !Object.hasOwn(this.scenes, design)) return no(400, 'unknown-design', '알 수 없는 방이에요');
    const px = this.#point(x);
    const py = this.#point(y);
    if (Number.isNaN(px) || Number.isNaN(py)) return no(400, 'bad-position', '위치가 올바르지 않아요');
    if (!(this.inventory[item] > 0)) return no(409, 'not-owned', '보관함에 없는 가구예요');
    const list = this.placed[design];
    if (list.length >= this.conf.maxPerRoom) return no(409, 'room-full', `한 방에는 ${this.conf.maxPerRoom}개까지 놓을 수 있어요`);
    const res = this.#check(design, list, { item, x: px, y: py });
    if (!res.ok) return no(res.code === 'bad-position' ? 400 : 409, res.code, res.message);
    const uid = `d${this.nextUid++}`;
    list.push({ uid, item, x: px, y: py });
    this.#take(item);
    this.version++;
    return ok({
      uid,
      undo: () => {
        const i = list.findIndex((p) => p.uid === uid);
        if (i >= 0) list.splice(i, 1);
        this.inventory[item] = (this.inventory[item] ?? 0) + 1;
        this.version++;
      },
    });
  }

  #find(uid) {
    if (typeof uid !== 'string') return null;
    for (const [design, list] of Object.entries(this.placed)) {
      const i = list.findIndex((p) => p.uid === uid);
      if (i >= 0) return { design, list, i };
    }
    return null;
  }

  move(uid, x, y) {
    const hit = this.#find(uid);
    if (!hit) return no(404, 'unknown-uid', '놓여 있지 않은 가구예요');
    const px = this.#point(x);
    const py = this.#point(y);
    if (Number.isNaN(px) || Number.isNaN(py)) return no(400, 'bad-position', '위치가 올바르지 않아요');
    const cur = hit.list[hit.i];
    const res = this.#check(hit.design, hit.list.filter((p) => p !== cur), { item: cur.item, x: px, y: py });
    if (!res.ok) return no(res.code === 'bad-position' ? 400 : 409, res.code, res.message);
    const [ox, oy] = [cur.x, cur.y];
    if (ox === px && oy === py) return ok({ uid });
    cur.x = px;
    cur.y = py;
    this.version++;
    return ok({ uid, undo: () => { [cur.x, cur.y] = [ox, oy]; this.version++; } });
  }

  store(uid) {
    const hit = this.#find(uid);
    if (!hit) return no(404, 'unknown-uid', '놓여 있지 않은 가구예요');
    const [cur] = hit.list.splice(hit.i, 1);
    this.inventory[cur.item] = (this.inventory[cur.item] ?? 0) + 1;
    this.version++;
    return ok({
      uid,
      undo: () => {
        hit.list.splice(Math.min(hit.i, hit.list.length), 0, cur);
        this.#take(cur.item);
        this.version++;
      },
    });
  }
}
