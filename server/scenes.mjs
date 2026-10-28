// Reads the layered scenes (assets/scenes/<design>/scene.json) at start-up and checks their format (stage 1 only;
// the heavy stages 2-9 belong to the validator and the tests).
import fs from 'node:fs';
import path from 'node:path';
import { checkSceneFormat } from '../web/scene.mjs';

/** [width, height] from a PNG's IHDR chunk (first 24 bytes), or null when the file is missing or not a PNG. */
export function readPngSize(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return null; // no such picture: the rect-inside-atlas check is skipped
  }
  try {
    const head = Buffer.alloc(24);
    if (fs.readSync(fd, head, 0, 24, 0) < 24 || head.readUInt32BE(0) !== 0x89504e47 || head.toString('latin1', 12, 16) !== 'IHDR') return null;
    return [head.readUInt32BE(16), head.readUInt32BE(20)];
  } finally {
    fs.closeSync(fd);
  }
}

/** Reads and format-checks one scene folder. Returns {raw} or {errors}. */
export function readScene(dir, design, cfg, opts = {}) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(dir, 'scene.json'), 'utf8'));
  } catch (e) {
    return { errors: [`scene.json: 읽지 못했습니다 (${e.message})`] };
  }
  const errors = checkSceneFormat(raw, { atlasSize: readPngSize(path.join(dir, String(raw?.atlas ?? ''))), inflatePx: cfg.nav.inflatePx, ...opts });
  if (raw?.design !== design) errors.unshift(`design: 폴더 이름 "${design}" 과 같아야 합니다`);
  return errors.length ? { errors } : { raw };
}

/** @returns {Record<string, {raw: object, url: string}>} every design in `designOrder`; a design without a valid scene refuses to start. */
export function loadScenes(cfg) {
  const out = {};
  for (const design of cfg.designOrder) {
    const dir = path.join(cfg.scenesDir, design);
    const res = readScene(dir, design, cfg);
    if (!res.raw) throw new Error(`장면 검사 실패: ${design}: ${res.errors[0]}`);
    out[design] = { raw: res.raw, url: `/scenes/${design}/` };
  }
  return out;
}
