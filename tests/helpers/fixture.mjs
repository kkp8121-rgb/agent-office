// Shared bits for the scene tests: the synthetic fixture scene and the numbers from config.json.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { readPngSize } from '../../server/scenes.mjs';

export const ROOT = fileURLToPath(new URL('../..', import.meta.url));
export const FIXTURE_SCENES = join(ROOT, 'tests', 'fixtures', 'scenes');
export const FIXTURE_DIR = join(FIXTURE_SCENES, 'studio2');
export const cfg = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8'));
export const atlasSize = readPngSize(join(FIXTURE_DIR, 'objects.png'));
export const fixtureRaw = () => JSON.parse(readFileSync(join(FIXTURE_DIR, 'scene.json'), 'utf8'));
export const FORMAT_OPTS = { atlasSize, inflatePx: cfg.nav.inflatePx, minSeats: 4 };

/** A temporary scenes folder holding one copy of the fixture room per name (each with its own `design`); removed when the process ends. */
export function namedScenesDir(...names) {
  const dir = mkdtempSync(join(tmpdir(), 'scenes-'));
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
  for (const name of names) {
    cpSync(FIXTURE_DIR, join(dir, name), { recursive: true });
    writeFileSync(join(dir, name, 'scene.json'), JSON.stringify({ ...fixtureRaw(), design: name }));
  }
  return dir;
}
