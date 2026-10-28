// Shared bits for the scene tests: the synthetic fixture scene and the numbers from config.json.
import { readFileSync } from 'node:fs';
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
