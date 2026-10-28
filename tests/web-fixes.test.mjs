import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

// logrow.js is a classic script: load it into a fresh context (its DOM helpers are only touched inside functions).
function loadLogrow() {
  const ctx = vm.createContext({});
  vm.runInContext(readFileSync(new URL('../web/logrow.js', import.meta.url), 'utf8'), ctx);
  return (expr) => vm.runInContext(expr, ctx);
}

test('web: session hue depends only on the id, not on first-seen order', () => {
  const a = loadLogrow();
  const b = loadLogrow();
  const ids = ['s-aaaa', 's-bbbb', 's-cccc', 's-dddd'];
  const forward = ids.map((id) => a(`hueOf(${JSON.stringify(id)})`));
  const backward = [...ids].reverse().map((id) => b(`hueOf(${JSON.stringify(id)})`)).reverse();
  assert.deepEqual(forward, backward);
  for (const h of forward) assert.ok(Number.isInteger(h) && h >= 0 && h < 360);
  assert.ok(new Set(forward).size > 1);
});

test('web: session label prefers live title, then remembered title, then id prefix', () => {
  const run = loadLogrow();
  const call = (sid, known) => run(`sessionLabel(${JSON.stringify(sid)}, new Map([['live1','지금 세션']]), ${JSON.stringify(known)})`);
  assert.equal(call('live1', { live1: '옛 이름' }), '지금 세션');
  assert.equal(call('gone1', { gone1: '결제 리뷰' }), '결제 리뷰');
  assert.equal(call('abcdefghijkl', {}), '지난 세션 abcdefgh');
  assert.equal(call('abcdefghijkl', undefined), '지난 세션 abcdefgh');
});

test('web: log meta line says when the list is capped', () => {
  const run = loadLogrow();
  assert.equal(run('logMetaText(0, false)'), '기록이 없습니다');
  assert.equal(run('logMetaText(12, false)'), '12건 · 최신 순');
  assert.equal(run('logMetaText(500, true)'), '최근 500건만 표시 · 최신 순');
});

test('web: config has the tray spread and it clears the character width', () => {
  const cfg = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
  assert.ok(cfg.ui.traySpreadPx >= 44);
});
