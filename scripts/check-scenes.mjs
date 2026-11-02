// Scene validator CLI: node scripts/check-scenes.mjs [--dir <scenesDir>] [--json <design>] [design...]
// Prints OK / WARN / FAIL lines per design and exits 1 when any design fails. --json prints one design's resolved
// scene, baked grid, draw nodes, warnings and the optional decor anchors (whiteboard, windows, meeting, seasonal) (for art/scene_sheet.py).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPngSize } from '../server/scenes.mjs';
import { checkScene } from '../server/scene-check.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));

const args = process.argv.slice(2);
let dir = path.resolve(ROOT, cfg.scenesDir);
let jsonDesign = null;
const names = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--dir') dir = path.resolve(args[++i]);
  else if (args[i] === '--json') jsonDesign = args[++i];
  else names.push(args[i]);
}
if (jsonDesign) names.push(jsonDesign);

const designs = names.length
  ? names
  : (fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && fs.existsSync(path.join(dir, d.name, 'scene.json'))).map((d) => d.name) : []);

function run(design) {
  const file = path.join(dir, design, 'scene.json');
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return { errors: [`1단계 형식: scene.json 을 읽지 못했습니다 (${e.message})`], warnings: [], resolved: null };
  }
  const res = checkScene(raw, { atlasSize: readPngSize(path.join(dir, design, String(raw?.atlas ?? ''))), cfg });
  for (const key of ['day', 'night']) { // the outside view pictures must exist and match view.size exactly
    const v = raw?.view;
    if (!v || typeof v[key] !== 'string') continue;
    const got = readPngSize(path.join(dir, design, v[key]));
    if (!got) res.errors.push(`10단계 장식 앵커: view.${key} 그림 ${v[key]} 이(가) 없거나 PNG 가 아닙니다`);
    else if (Array.isArray(v.size) && (got[0] !== v.size[0] || got[1] !== v.size[1])) res.errors.push(`10단계 장식 앵커: view.${key} 그림 크기 ${got.join('x')} 이(가) view.size ${v.size.join('x')} 와 다릅니다`);
  }
  res.decor = { whiteboard: raw.whiteboard, windows: raw.windows, meeting: raw.meeting, seasonal: raw.seasonal };
  if (raw?.design !== design) res.errors.unshift(`1단계 형식: design: 폴더 이름 "${design}" 과 같아야 합니다`);
  return res;
}

let failed = false;
for (const design of designs) {
  const res = run(design);
  if (jsonDesign === design) {
    const { cols, rows, cellPx, open } = res.grid ?? { cols: 0, rows: 0, cellPx: 0, open: [] };
    console.log(JSON.stringify({ resolved: res.resolved, grid: { cols, rows, cellPx, open: Array.from(open).join('') }, nodes: res.nodes, decor: res.decor, warnings: res.warnings, errors: res.errors }));
    if (!res.resolved) failed = true;
    continue;
  }
  for (const w of res.warnings) console.log(`WARN ${design}: ${w}`);
  for (const e of res.errors) console.log(`FAIL ${design}: ${e}`);
  if (res.errors.length) failed = true;
  else console.log(`OK ${design}`);
}
process.exit(failed ? 1 : 0);
