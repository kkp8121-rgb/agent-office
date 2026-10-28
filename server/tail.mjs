// Incremental reader for append-only JSONL files. Reads only the bytes added since the
// last poll, splits on newline at Buffer level and decodes UTF-8 only per complete line.
import { open, stat } from 'node:fs/promises';

const NL = 0x0a;

export class FileTail {
  #path;
  #startBytes;
  #max;
  #chunk;
  #clip;
  #buf = null; // allocated on the first read: a tail that never reads (or is dropped) holds no buffer
  #offset = 0;
  #mtimeMs = 0;
  #started = false;
  #carry = [];
  #carryLen = 0;
  #skipping = false;
  #clipped = false;

  /** Bytes read from the file by the last poll (0 when the poll found nothing new). */
  lastRead = 0;

  /**
   * `clipLines`: a line longer than maxLineBytes is delivered cut to its first maxLineBytes bytes instead of being
   * skipped, for readers that only need the head of each line.
   * `offset` (optional): resume at a line start returned by `lineStart` instead of starting at the end window. */
  constructor(path, { startBytes, chunkBytes, maxLineBytes, clipLines = false, offset = 0 }) {
    this.#path = path;
    if (offset > 0) {
      this.#offset = offset;
      this.#started = true;
    }
    this.#startBytes = startBytes;
    this.#max = maxLineBytes;
    this.#chunk = chunkBytes;
    this.#clip = clipLines;
  }

  get offset() {
    return this.#offset;
  }

  /** Modification time seen by the last poll (ms; 0 before the first). */
  get mtimeMs() {
    return this.#mtimeMs;
  }

  /** False while the rest of an oversized line is being skipped or clipped: `lineStart` is not a line start then. */
  get resumable() {
    return !this.#skipping && !this.#clipped;
  }

  /** Where an incomplete trailing line begins (equals `offset` when the last read ended on a line end). */
  get lineStart() {
    return this.#offset - this.#carryLen;
  }

  #reset() {
    this.#offset = 0;
    this.#started = false;
    this.#carry = [];
    this.#carryLen = 0;
    this.#skipping = false;
    this.#clipped = false;
  }

  async poll() {
    this.lastRead = 0;
    const st = await stat(this.#path);
    this.#mtimeMs = st.mtimeMs;
    if (this.#started && st.size === this.#offset) return []; // nothing appended: no open
    const fh = await open(this.#path, 'r');
    try {
      const { size } = await fh.stat();
      if (size < this.#offset) this.#reset();
      this.#buf ??= Buffer.allocUnsafe(this.#chunk);
      if (!this.#started) {
        this.#started = true;
        const start = this.#startBytes && size > this.#startBytes ? size - this.#startBytes : 0;
        this.#offset = start;
        if (start > 0) {
          // Mid-file start: drop the partial first line unless we land exactly on a line start.
          const { bytesRead } = await fh.read(this.#buf, 0, 1, start - 1);
          this.#skipping = !(bytesRead === 1 && this.#buf[0] === NL);
        }
      }
      const lines = [];
      while (this.#offset < size) {
        const want = Math.min(this.#buf.length, size - this.#offset);
        const { bytesRead } = await fh.read(this.#buf, 0, want, this.#offset);
        if (bytesRead === 0) break;
        this.#offset += bytesRead;
        this.lastRead += bytesRead;
        this.#consume(this.#buf.subarray(0, bytesRead), lines);
      }
      return lines;
    } finally {
      await fh.close();
    }
  }

  #consume(chunk, lines) {
    let pos = 0;
    while (pos < chunk.length) {
      const nl = chunk.indexOf(NL, pos);
      const end = nl === -1 ? chunk.length : nl;
      if (!this.#skipping && !this.#clipped) {
        const room = this.#max - this.#carryLen;
        if (end - pos > room) {
          if (this.#clip) {
            this.#carry.push(Buffer.from(chunk.subarray(pos, pos + room)));
            this.#carryLen += room;
            this.#clipped = true;
          } else {
            this.#carry = [];
            this.#carryLen = 0;
            this.#skipping = true;
          }
        } else if (end > pos) {
          // Copy: the read buffer is reused by the next read.
          this.#carry.push(Buffer.from(chunk.subarray(pos, end)));
          this.#carryLen += end - pos;
        }
      }
      if (nl === -1) return;
      if (this.#skipping) {
        this.#skipping = false;
      } else {
        this.#clipped = false;
        const text = Buffer.concat(this.#carry, this.#carryLen).toString('utf8').replace(/\r$/, '');
        if (text) lines.push(text);
        this.#carry = [];
        this.#carryLen = 0;
      }
      pos = nl + 1;
    }
  }
}
