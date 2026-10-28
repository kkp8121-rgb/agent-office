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

test('web: config has the tray spread and it clears the character width', () => {
  const cfg = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
  assert.ok(cfg.ui.traySpreadPx >= 44);
});

test('web: tray slots never coincide, even for 24 finished agents', () => {
  const run = loadLogrow();
  const cfg = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
  const pts = new Set();
  for (let i = 0; i < 24; i++) {
    const p = run(`trayPos(${i}, [400, 500], ${cfg.ui.traySpreadPx}, ${cfg.ui.trayRowPx})`);
    pts.add(`${p.x},${p.y}`);
  }
  assert.equal(pts.size, 24);
});

test('web: hasOwn title lookup ignores inherited keys', () => {
  const run = loadLogrow();
  assert.equal(run(`sessionLabel('constructor', new Map(), {})`), '지난 세션 construc');
});
