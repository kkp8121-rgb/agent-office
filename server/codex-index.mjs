// ~/.codex/session_index.jsonl: one JSON line {id, thread_name, updated_at} per rename, the latest line of an id wins.
// Only the id and the (cleaned, clipped) thread name are kept. The file is stat-ed once per poll and read only
// when it changed: an append reads just the new bytes, a smaller or replaced file is read again from the start.
import { open, stat } from 'node:fs/promises';
import { cleanLine } from './sanitize.mjs';
import { isSafeId } from './sessions.mjs';
import config from '../config.json' with { type: 'json' };

const NAME_MAX = config.parse.nameMaxChars;

export class CodexIndex {
  /** thread id -> thread name */
  names = new Map();

  #path;
  #maxBytes;
  #offset = 0; // bytes consumed (up to the last complete line)
  #birth = 0;
  #size = -1;
  #mtime = 0;

  constructor(path, maxBytes) {
    this.#path = path;
    this.#maxBytes = Number.isInteger(maxBytes) && maxBytes > 0 ? maxBytes : 4194304;
  }

  #reset() {
    this.names.clear();
    this.#offset = 0;
    this.#size = -1;
  }

  async poll() {
    if (!this.#path) return;
    let st;
    try {
      st = await stat(this.#path);
    } catch (e) {
      if (e?.code === 'ENOENT') this.#reset();
      return;
    }
    if (!st.isFile()) return;
    if (st.size === this.#size && st.mtimeMs === this.#mtime) return;
    if (st.size < this.#offset || (this.#birth && st.birthtimeMs !== this.#birth)) this.#reset();
    this.#birth = st.birthtimeMs;
    try {
      await this.#readFrom(st);
    } catch {
      return; // locked or half-written: retried on a later poll
    }
    this.#size = st.size;
    this.#mtime = st.mtimeMs;
  }

  async #readFrom(st) {
    let from = this.#offset;
    let skipPartial = false;
    if (st.size - from > this.#maxBytes) { // only the newest part of a huge file
      from = st.size - this.#maxBytes;
      skipPartial = true;
    }
    const want = st.size - from;
    if (want <= 0) return;
    const fh = await open(this.#path, 'r');
    let buf;
    try {
      buf = Buffer.alloc(want);
      const { bytesRead } = await fh.read(buf, 0, want, from);
      buf = buf.subarray(0, bytesRead);
    } finally {
      await fh.close();
    }
    let start = 0;
    if (skipPartial) {
      const nl = buf.indexOf(0x0a);
      start = nl === -1 ? buf.length : nl + 1;
    }
    const end = buf.lastIndexOf(0x0a) + 1; // a last line without its newline is still being written
    if (end <= start) {
      if (skipPartial) this.#offset = from + start;
      return;
    }
    for (const text of buf.toString('utf8', start, end).split('\n')) this.#take(text.replace(/\r$/, ''));
    this.#offset = from + end;
  }

  #take(text) {
    if (!text) return;
    let o;
    try {
      o = JSON.parse(text);
    } catch {
      return;
    }
    if (typeof o !== 'object' || o === null || !isSafeId(o.id)) return;
    const name = cleanLine(o.thread_name, NAME_MAX);
    if (name) this.names.set(o.id, name);
  }
}
