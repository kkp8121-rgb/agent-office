import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { loadConfig } from '../server/config.mjs';
import { resolveScene, trayPoint } from '../web/scene.mjs';

// logrow.js is a classic script: load it into a fresh context (its DOM helpers are only touched inside functions).
function loadLogrow() {
  const ctx = vm.createContext({});
  vm.runInContext(readFileSync(new URL('../web/logrow.js', import.meta.url), 'utf8'), ctx);
  return (expr) => vm.runInContext(expr, ctx);
}

test('web: session colour comes from the server palette index, grey while unknown', () => {
  const run = loadLogrow();
  run(`sessionPalette = ['#111111', '#222222']; sessionColorIdx.set('s-a', 1)`);
  assert.equal(run(`colorOf('s-a')`), '#222222');
  assert.equal(run(`colorOf('s-unknown')`), '#8a6a42');
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

test('web: tray slots never coincide, even for 24 finished agents', () => {
  const cfg = loadConfig();
  for (const d of cfg.designOrder) {
    const r = resolveScene(cfg.scenes[d].raw);
    const pts = new Set(Array.from({ length: 24 }, (_, i) => trayPoint(r, i, cfg.nav.trayRowPx).join(',')));
    assert.equal(pts.size, 24, d);
  }
});

test('web: hasOwn title lookup ignores inherited keys', () => {
  const run = loadLogrow();
  assert.equal(run(`sessionLabel('constructor', new Map(), {})`), '지난 세션 construc');
});
