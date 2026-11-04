// Draws the lit copy of every seated picture: assets/sprites/<key>-sit.png -> assets/sprites/lit/<key>-sit.png
// (a separate folder, so no check that lists the sprites by name mistakes a lit copy for a character).
// The lit copy is the same picture with the night monitor light screened onto the face and upper body (bakeLit in web/fx-weather.mjs, numbers in
// config ui.fx.weather.glow). web/fx-weather.mjs lays it over the plain picture in dark mode, so the light can only fall on the figure itself.
// Run it again after changing the glow numbers or adding a seated picture:   node scripts/make-lit-sprites.mjs
// (the test tests/fx-weather.test.mjs fails when a lit file is missing or no longer matches what bakeLit makes.) Zero dependencies.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import zlib from 'node:zlib';
import { bakeLit } from '../web/fx-weather.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const SPRITES = join(ROOT, 'assets', 'sprites');

/** Seated pictures that get a lit copy: every <key>-sit.png except the office cat's. */
export const litSources = () => readdirSync(SPRITES).filter((n) => n.endsWith('-sit.png') && !n.startsWith('cat-')).sort();
export const LIT = join(SPRITES, 'lit');

/** Reads an 8-bit RGBA, non-interlaced PNG (what every sprite is): {w, h, rgba}. */
export function decodePng(buf) {
  let o = 8;
  let w = 0;
  let h = 0;
  const idat = [];
  while (o < buf.length) {
    const len = buf.readUInt32BE(o);
    const type = buf.toString('latin1', o + 4, o + 8);
    const data = buf.subarray(o + 8, o + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      if (data[8] !== 8 || data[9] !== 6 || data[12] !== 0) throw new Error('only 8-bit RGBA, non-interlaced PNG is supported');
    } else if (type === 'IDAT') idat.push(data);
    o += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * 4;
  const rgba = new Uint8ClampedArray(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= 4 ? rgba[y * stride + i - 4] : 0;
      const b = y > 0 ? rgba[(y - 1) * stride + i] : 0;
      const c = i >= 4 && y > 0 ? rgba[(y - 1) * stride + i - 4] : 0;
      let v = line[i];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      rgba[y * stride + i] = v & 255;
    }
  }
  return { w, h, rgba };
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** 8-bit RGBA PNG without filtering. */
export function encodePng(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/** The lit pixels of one seated picture file, as {w, h, rgba}. */
export function litOf(name, cfg) {
  const { w, h, rgba } = decodePng(readFileSync(join(SPRITES, name)));
  return { w, h, rgba: bakeLit(rgba, w, h, cfg) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cfg = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8')).ui.fx.weather;
  mkdirSync(LIT, { recursive: true });
  for (const name of litSources()) {
    const { w, h, rgba } = litOf(name, cfg);
    writeFileSync(join(LIT, name), encodePng(w, h, rgba));
  }
  console.log(`${litSources().length} lit pictures written to ${LIT}`);
}
