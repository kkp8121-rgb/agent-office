import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileTail } from '../server/tail.mjs';

/** Temp dir for one test; removed when the test ends, pass or fail. */
function tmp(ctx) {
  const dir = mkdtempSync(join(tmpdir(), 'tail-'));
  ctx.after(() => rmSync(dir, { recursive: true, force: true }));
  return { file: join(dir, 'x.jsonl') };
}
const O = { chunkBytes: 65536, maxLineBytes: 4194304 };

test('tail: reads only appended bytes', async (ctx) => {
  const t = tmp(ctx);
  writeFileSync(t.file, '{"a":1}\n{"a":2}\n');
  const tail = new FileTail(t.file, O);
  assert.deepEqual(await tail.poll(), ['{"a":1}', '{"a":2}']);
  appendFileSync(t.file, '{"a":3}\n');
  assert.deepEqual(await tail.poll(), ['{"a":3}']);
  assert.deepEqual(await tail.poll(), []);
  assert.equal(tail.offset, 24);
});

test('tail: partial line is completed on next poll', async (ctx) => {
  const t = tmp(ctx);
  writeFileSync(t.file, '{"a":1}\n{"b"');
  const tail = new FileTail(t.file, O);
  assert.deepEqual(await tail.poll(), ['{"a":1}']);
  appendFileSync(t.file, ':2}\n');
  assert.deepEqual(await tail.poll(), ['{"b":2}']);
});

test('tail: multibyte char split across chunks decodes intact', async (ctx) => {
  const t = tmp(ctx);
  writeFileSync(t.file, '{"t":"가나다"}\n');
  const tail = new FileTail(t.file, { chunkBytes: 4, maxLineBytes: 4194304 });
  assert.deepEqual(await tail.poll(), ['{"t":"가나다"}']);
});

test('tail: startBytes skips the partial first line', async (ctx) => {
  const t = tmp(ctx);
  const lines = Array.from({ length: 1000 }, (_, i) => `{"i":${i}}`);
  writeFileSync(t.file, lines.join('\n') + '\n');
  const tail = new FileTail(t.file, { ...O, startBytes: 100 });
  const got = await tail.poll();
  assert.ok(got.length > 5 && got.length < 20);
  assert.equal(got.at(-1), '{"i":999}');
  for (const g of got) assert.equal(g, lines[JSON.parse(g).i]);
});

test('tail: startBytes at a line boundary keeps that line', async (ctx) => {
  const t = tmp(ctx);
  writeFileSync(t.file, '{"a":1}\n{"a":2}\n');
  const tail = new FileTail(t.file, { ...O, startBytes: 8 });
  assert.deepEqual(await tail.poll(), ['{"a":2}']);
});

test('tail: oversized line is skipped, next line parsed', async (ctx) => {
  const t = tmp(ctx);
  writeFileSync(t.file, '{"big":"' + 'x'.repeat(190) + '"}\n{"ok":1}\n');
  const tail = new FileTail(t.file, { chunkBytes: 16, maxLineBytes: 50 });
  assert.deepEqual(await tail.poll(), ['{"ok":1}']);
});

test('tail: oversized line spanning polls is skipped', async (ctx) => {
  const t = tmp(ctx);
  writeFileSync(t.file, '{"big":"' + 'x'.repeat(100));
  const tail = new FileTail(t.file, { chunkBytes: 16, maxLineBytes: 50 });
  assert.deepEqual(await tail.poll(), []);
  appendFileSync(t.file, 'y"}\n{"ok":1}\n');
  assert.deepEqual(await tail.poll(), ['{"ok":1}']);
});

test('tail: truncated file restarts from tail', async (ctx) => {
  const t = tmp(ctx);
  writeFileSync(t.file, '{"a":1}\n{"a":2}\n{"a":3}\n');
  const tail = new FileTail(t.file, O);
  await tail.poll();
  writeFileSync(t.file, '{"b":1}\n');
  assert.deepEqual(await tail.poll(), ['{"b":1}']);
});

test('tail: resumes at a given line start and exposes where an incomplete line begins', async (ctx) => {
  const t = tmp(ctx);
  writeFileSync(t.file, '{"a":1}\n{"b"');
  const a = new FileTail(t.file, O);
  assert.deepEqual(await a.poll(), ['{"a":1}']);
  assert.equal(a.offset, 12);
  assert.equal(a.lineStart, 8, 'start of the incomplete line');
  const b = new FileTail(t.file, { ...O, startBytes: 4, offset: a.lineStart });
  appendFileSync(t.file, ':2}\n{"c":3}\n');
  assert.deepEqual(await b.poll(), ['{"b":2}', '{"c":3}'], 'resumed, neither replayed nor skipped');
  assert.equal(b.lineStart, b.offset);
});

test('tail: not resumable while skipping an oversized line', async (ctx) => {
  const t = tmp(ctx);
  writeFileSync(t.file, '{"a":1}\n' + 'x'.repeat(50));
  const tail = new FileTail(t.file, { chunkBytes: 16, maxLineBytes: 20 });
  assert.deepEqual(await tail.poll(), ['{"a":1}']);
  assert.equal(tail.resumable, false, 'the oversized line is being skipped');
  appendFileSync(t.file, 'y'.repeat(10) + '\n{"ok":1}\n');
  assert.deepEqual(await tail.poll(), ['{"ok":1}']);
  assert.equal(tail.resumable, true);
});
