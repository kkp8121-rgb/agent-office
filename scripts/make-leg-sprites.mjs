// Draws the lower legs and feet of every seated figure: assets/sprites/<key>-sit.png (thighs end at the knees) -> assets/sprites/legs/<key>-legs.png.
// Under a table that is open below (legs only) a seated figure shows its shins and shoes; under a desk with a front panel the desk picture
// hides them. The legs are cut from the character's own standing picture (assets/sprites/<key>.png), so skin, stockings and shoes match:
// the rows from just above the knee to the sole, split between the two legs, each leg moved under the knee of the seated picture.
// The legs picture is as wide as the seated one, LEGS_ROWS rows high, the soles on its last row; above the knee the top row of the legs is repeated
// upward (that part sits behind the table top and behind the thighs). web/style.css "desks" lays it so that the soles end `seat.legs` px under the
// bottom edge of the seated picture.
// Run it again after changing a standing or seated picture:   node scripts/make-leg-sprites.mjs
// (tests/desks.test.mjs fails when a legs file is missing or no longer matches what legsFile makes.) Zero dependencies.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { decodePng, encodePng, SPRITES } from './make-lit-sprites.mjs';

export const LEGS_DIR = join(SPRITES, 'legs');
/** Rows kept above the gap between the legs (the knee), and the height of every legs picture. */
export const KNEE_ROWS = 4;
export const LEGS_ROWS = 30;
const ALPHA = 40;

/** Seated pictures that get legs: every <key>-sit.png except the office cat's, when the standing picture exists. */
export const legSources = () => readdirSync(SPRITES).filter((n) => n.endsWith('-sit.png') && !n.startsWith('cat-') && existsSync(join(SPRITES, n.replace('-sit.png', '.png')))).sort();

/** Opaque runs [from, to] (inclusive) of one row. */
function runs(im, y) {
  const out = [];
  let from = -1;
  for (let x = 0; x <= im.w; x++) {
    const on = x < im.w && im.rgba[(y * im.w + x) * 4 + 3] > ALPHA;
    if (on && from < 0) from = x;
    else if (!on && from >= 0) {
      out.push([from, x - 1]);
      from = -1;
    }
  }
  return out;
}

/** The last opaque row of a picture. */
function lastRow(im) {
  for (let y = im.h - 1; y >= 0; y--) if (runs(im, y).length) return y;
  return -1;
}

/**
 * The lower legs of one figure as {w, h, rgba}, w = the seated picture's width.
 * Where the two legs of the standing picture part (the rows near the bottom with two separate runs) is the split; the rows from KNEE_ROWS above the
 * highest row of that gap to the sole are kept. A figure without such a gap (a long skirt or robe) keeps its bottom 14 rows as one block.
 * Each leg is moved sideways so its centre lies under the matching knee of the seated picture: the knees are taken at 27% and 73% of the opaque span of the
 * seated picture's last rows.
 */
export function legsOf(stand, sit) {
  if (sit.h < 1) throw new Error('empty seated picture');
  const bottom = lastRow(stand);
  const sb = lastRow(sit);
  let split = -1;
  let gapTop = -1;
  for (let y = bottom; y >= Math.floor(stand.h * 0.55); y--) {
    const r = runs(stand, y);
    if (r.length >= 2 && r[r.length - 1][0] - r[0][1] > 1) {
      if (split < 0) split = Math.round((r[0][1] + r[r.length - 1][0]) / 2);
      gapTop = y;
    } else if (gapTop >= 0) break;
  }
  const rowFrom = gapTop >= 0 ? Math.max(gapTop - KNEE_ROWS, 0) : Math.max(bottom - 13, 0);
  const rows = bottom - rowFrom + 1;
  const H = LEGS_ROWS;
  let x0 = sit.w;
  let x1 = -1;
  for (let y = Math.max(sb - 2, 0); y <= sb; y++) {
    for (const [a, b] of runs(sit, y)) {
      x0 = Math.min(x0, a);
      x1 = Math.max(x1, b);
    }
  }
  const span = x1 - x0;
  const offset = Math.round((sit.w - stand.w) / 2); // both pictures are centred in the same box
  const out = new Uint8ClampedArray(sit.w * H * 4);
  const put = (sx, sy, dx) => {
    const x = sx + offset + dx;
    if (x < 0 || x >= sit.w) return;
    const s = (sy * stand.w + sx) * 4;
    if (stand.rgba[s + 3] <= ALPHA) return;
    const d = ((sy - rowFrom + H - rows) * sit.w + x) * 4; // the soles on the last row
    for (let k = 0; k < 4; k++) out[d + k] = stand.rgba[s + k];
  };
  const centreOf = (lo, hi) => {
    let a = stand.w;
    let b = -1;
    for (let y = rowFrom; y <= bottom; y++) for (let x = lo; x < hi; x++) if (stand.rgba[(y * stand.w + x) * 4 + 3] > ALPHA) { a = Math.min(a, x); b = Math.max(b, x); }
    return (a + b) / 2;
  };
  if (split < 0) {
    const dx = Math.round((x0 + x1) / 2 - (centreOf(0, stand.w) + offset));
    for (let y = rowFrom; y <= bottom; y++) for (let x = 0; x < stand.w; x++) put(x, y, dx);
  } else {
    const dxL = Math.round(x0 + span * 0.27 - (centreOf(0, split) + offset));
    const dxR = Math.round(x0 + span * 0.73 - (centreOf(split, stand.w) + offset));
    for (let y = rowFrom; y <= bottom; y++) {
      for (let x = 0; x < split; x++) put(x, y, dxL);
      for (let x = split; x < stand.w; x++) put(x, y, dxR);
    }
  }
  for (let y = H - rows - 1; y >= 0; y--) out.copyWithin(y * sit.w * 4, (y + 1) * sit.w * 4, (y + 2) * sit.w * 4); // above the knee: the top row again
  return { w: sit.w, h: H, rgba: out };
}

/** The legs of the picture file `name` (<key>-sit.png) as {w, h, rgba}. */
export function legsFile(name) {
  const stand = decodePng(readFileSync(join(SPRITES, name.replace('-sit.png', '.png'))));
  const sit = decodePng(readFileSync(join(SPRITES, name)));
  return legsOf(stand, sit);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  mkdirSync(LEGS_DIR, { recursive: true });
  for (const name of legSources()) {
    const { w, h, rgba } = legsFile(name);
    writeFileSync(join(LEGS_DIR, name.replace('-sit.png', '-legs.png')), encodePng(w, h, rgba));
  }
  console.log(`${legSources().length} legs pictures written to ${LEGS_DIR}`);
}
