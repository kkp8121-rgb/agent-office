// Incremental reader for append-only JSONL files. Reads only the bytes added since the
// last poll, splits on newline at Buffer level and decodes UTF-8 only per complete line.
import { open } from 'node:fs/promises';

const NL = 0x0a;

export class FileTail {
  #path;
  #startBytes;
  #max;
  #buf;
  #offset = 0;
  #started = false;
  #carry = [];
  #carryLen = 0;
  #skipping = false;

  /** `offset` (optional): resume at a line start returned by `lineStart` instead of starting at the end window. */
  constructor(path, { startBytes, chunkBytes, maxLineBytes, offset = 0 }) {
    this.#path = path;
    if (offset > 0) {
      this.#offset = offset;
      this.#started = true;
    }
    this.#startBytes = startBytes;
    this.#max = maxLineBytes;
    this.#buf = Buffer.allocUnsafe(chunkBytes);
  }

  get offset() {
    return this.#offset;
  }

  /** False while the rest of an oversized line is being skipped: `lineStart` is not a line start then. */
  get resumable() {
    return !this.#skipping;
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
  }

  async poll() {
    const fh = await open(this.#path, 'r');
    try {
      const { size } = await fh.stat();
      if (size < this.#offset) this.#reset();
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
      if (!this.#skipping) {
        if (this.#carryLen + (end - pos) > this.#max) {
          this.#carry = [];
          this.#carryLen = 0;
          this.#skipping = true;
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
        const text = Buffer.concat(this.#carry, this.#carryLen).toString('utf8').replace(/\r$/, '');
        if (text) lines.push(text);
        this.#carry = [];
        this.#carryLen = 0;
      }
      pos = nl + 1;
    }
  }
}
