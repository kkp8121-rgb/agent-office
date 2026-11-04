// Dependency-free PNG reader for tests (8-bit, not interlaced; grey, grey+alpha, RGB and RGBA). Returns {w, h, ch, data}: ch channels per pixel, rows top to bottom.
import { readFileSync } from 'node:fs';
import zlib from 'node:zlib';

const CHANNELS = { 0: 1, 2: 3, 4: 2, 6: 4 };

export function readPng(file) {
  const buf = readFileSync(file);
  let at = 8;
  let ihdr = null;
  const idat = [];
  while (at < buf.length) {
    const len = buf.readUInt32BE(at);
    const type = buf.toString('latin1', at + 4, at + 8);
    const body = buf.subarray(at + 8, at + 8 + len);
    if (type === 'IHDR') ihdr = body;
    else if (type === 'IDAT') idat.push(body);
    at += 12 + len;
  }
  const w = ihdr.readUInt32BE(0);
  const h = ihdr.readUInt32BE(4);
  const ch = CHANNELS[ihdr[9]];
  if (ihdr[8] !== 8 || !ch || ihdr[12] !== 0) throw new Error(`${file}: only 8-bit grey/RGB(A) PNGs without interlacing`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const data = Buffer.alloc(w * h * ch);
  const stride = w * ch;
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? data[y * stride + i - ch] : 0;
      const b = y ? data[(y - 1) * stride + i] : 0;
      const c = i >= ch && y ? data[(y - 1) * stride + i - ch] : 0;
      let v = line[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      data[y * stride + i] = v & 255;
    }
  }
  return { w, h, ch, data };
}

/** The alpha channel of a grey+alpha or RGBA picture as a flat array (one value per pixel). */
export function alphaOf(png) {
  const out = new Uint8Array(png.w * png.h);
  for (let i = 0; i < out.length; i++) out[i] = png.data[i * png.ch + png.ch - 1];
  return out;
}
