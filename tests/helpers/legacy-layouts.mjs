// Loaded with `node --test --import` (see package.json). The tests written for the old layouts table (config, office,
// office-fixes, round2-web, privacy) must keep running against it even after a layered scene ships for a design, so they
// get an empty scenes folder through the environment. Tests of the scene path pin their own folder explicitly
// (loadConfig({ scenesDir })), which wins over this variable. Task 7 moves the old tests to scenes and deletes this file.
import { fileURLToPath } from 'node:url';

process.env.AGENT_OFFICE_SCENES_DIR ||= fileURLToPath(new URL('../fixtures/no-scenes', import.meta.url));
