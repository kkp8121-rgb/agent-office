// Builds tests/fixtures/scenes/studio2/ (a synthetic 1024x512 room: boxes instead of furniture). Run once, commit the output:
//   node tests/helpers/make-fixture.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writePng } from './png.mjs';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'scenes', 'studio2');
mkdirSync(dir, { recursive: true });

// ---- pictures ----
writePng(join(dir, 'shell.png'), 1024, 512, (x, y) => (y < 120 ? [222, 205, 170, 255] : (Math.floor(x / 32) + Math.floor(y / 32)) % 2 ? [201, 168, 120, 255] : [210, 178, 130, 255]));
writePng(join(dir, 'front.png'), 1024, 512, (x, y) => (y >= 496 ? [70, 50, 35, 255] : [0, 0, 0, 0]));

const KINDS_PX = [
  { name: 'desk', rect: [0, 0, 80, 56], color: [150, 100, 60] },
  { name: 'chair', rect: [80, 0, 32, 44], color: [150, 50, 50] },
  { name: 'plant', rect: [112, 0, 44, 70], color: [60, 140, 70] },
  { name: 'cabinet', rect: [156, 0, 120, 60], color: [90, 110, 140] },
  { name: 'lead-desk', rect: [276, 0, 96, 56], color: [120, 80, 50] },
];
writePng(join(dir, 'objects.png'), 384, 80, (x, y) => {
  for (const k of KINDS_PX) {
    const [rx, ry, w, h] = k.rect;
    if (x < rx || y < ry || x >= rx + w || y >= ry + h) continue;
    const edge = x === rx || y === ry || x === rx + w - 1 || y === ry + h - 1;
    const stripe = k.name === 'cabinet' && Math.floor((x - rx + (y - ry)) / 12) % 2 === 0;
    return edge ? [30, 20, 10, 255] : [...k.color.map((c) => (stripe ? c + 25 : c)), 255];
  }
  return [0, 0, 0, 0];
});

// ---- scene ----
const box = (hw, back) => [[-hw, back], [hw, back], [hw, 0], [-hw, 0]];
const kinds = {
  desk: {
    rect: [0, 0, 80, 56], anchor: [40, 56], footprint: box(40, -26), blocks: true, depth: 'auto',
    seat: { at: [0, -48], sitAt: [0, -44], approach: [0, -84], visit: [66, -30], face: 'right' },
  },
  chair: { rect: [80, 0, 32, 44], anchor: [16, 44], footprint: box(12, -8), blocks: true, depth: 'auto' },
  plant: { rect: [112, 0, 44, 70], anchor: [22, 70], footprint: box(10, -10), blocks: true, depth: 'auto' },
  cabinet: { rect: [156, 0, 120, 60], anchor: [60, 60], footprint: [[-60, -50], [60, -20], [60, 0], [-60, -30]], blocks: true, depth: 'auto' },
  'lead-desk': { rect: [276, 0, 96, 56], anchor: [48, 56], footprint: box(48, -26), blocks: true, depth: 'auto' },
};
const objects = [];
const seats = [];
[[300, 230], [430, 230], [300, 340], [430, 340]].forEach(([x, y], i) => {
  objects.push({ id: `desk-${i + 1}`, kind: 'desk', at: [x, y] }, { id: `chair-${i + 1}`, kind: 'chair', at: [x, y - 50] });
  seats.push(`desk-${i + 1}`);
});
objects.push(
  { id: 'plant-1', kind: 'plant', at: [640, 300] },
  { id: 'cabinet-1', kind: 'cabinet', at: [780, 330] },
  { id: 'lead-desk-1', kind: 'lead-desk', at: [520, 460] },
  { id: 'chair-lead', kind: 'chair', at: [520, 410] },
);
const row = (n, x0, y0, dx, dy, face) => Array.from({ length: n }, (_, i) => ({ at: [x0 + i * dx, y0 + i * dy], face }));
const scene = {
  version: 1,
  design: 'studio2',
  minSeats: 4,
  size: [1024, 512],
  shell: 'shell.png',
  front: 'front.png',
  atlas: 'objects.png',
  board: [16, 8, 300, 48],
  reports: [60, -62],
  sign: null,
  walkable: [[[16, 128], [1008, 128], [1008, 496], [16, 496]]],
  blocked: [],
  frontMask: [[[0, 496], [1024, 496], [1024, 512], [0, 512]]],
  door: { at: [960, 420], face: 'left' },
  kinds,
  objects,
  seats,
  lead: { desk: 'lead-desk-1', at: [520, 412], sitAt: [520, 416], approach: [520, 376], face: 'right' },
  tray: {
    object: 'lead-desk-1',
    queue: [...Array.from({ length: 6 }, (_, i) => [600 - i * 28, 480]), ...Array.from({ length: 6 }, (_, i) => [430 - i * 28, 452])],
  },
  idle: [...row(3, 860, 170, 0, 40, 'left'), ...row(3, 900, 170, 0, 40, 'left')],
  overflow: [...row(6, 80, 180, 0, 50, 'right'), ...row(2, 140, 180, 0, 50, 'right')],
  spots: [
    { id: 'coffee', kind: 'coffee', at: [660, 156], face: 'right', pair: [704, 156] },
    { id: 'window', kind: 'window', at: [160, 156], face: 'right' },
    { id: 'plant', kind: 'plant', at: [600, 290], face: 'right' },
    { id: 'board', kind: 'whiteboard', at: [400, 156], face: 'right' },
  ],
};
writeFileSync(join(dir, 'scene.json'), `${JSON.stringify(scene, null, 2)}\n`);
console.log('fixture written to', dir);
