import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeTool, clip } from '../server/sanitize.mjs';

test('sanitize: bash uses description', () =>
  assert.equal(describeTool('Bash', {command:'npm run build', description:'프론트 빌드 확인'}), '프론트 빌드 확인'));
test('sanitize: bash without description exposes first word only', () => {
  const t = describeTool('Bash', {command:"curl -H 'Authorization: Bearer sk-abc123' https://x.io/a?token=zz"});
  assert.equal(t, 'curl 실행'); assert.ok(!t.includes('sk-abc') && !t.includes('x.io'));
});
test('sanitize: quoted exe path reduces to bare name', () =>
  assert.equal(describeTool('Bash', {command:'"C:/Program Files/nodejs/node.exe" x.mjs'}), 'node 실행'));
test('sanitize: file tools show basename only', () => {
  assert.equal(describeTool('Read', {file_path:'C:\\Users\\gustj\\secret\\PostController.cs'}), 'PostController.cs 읽는 중');
  assert.equal(describeTool('Edit', {file_path:'/a/b/app.js'}), 'app.js 고치는 중');
  assert.equal(describeTool('Write', {file_path:'/a/b/new.md'}), 'new.md 쓰는 중');
});
test('sanitize: search never exposes pattern', () => {
  assert.equal(describeTool('Grep', {pattern:'password=hunter2', path:'/x'}), '검색 중');
  assert.equal(describeTool('Glob', {pattern:'**/*.key'}), '검색 중');
});
test('sanitize: delegation, skill, mcp, unknown', () => {
  assert.equal(describeTool('Agent', {subagent_type:'worker', description:'기록 구조 조사'}), '위임 · 기록 구조 조사');
  assert.equal(describeTool('Skill', {skill:'superpowers:brainstorming'}), '스킬 · superpowers:brainstorming');
  assert.equal(describeTool('Workflow', {script:'...'}), '워크플로 시작');
  assert.equal(describeTool('WebSearch', {query:'q'}), '웹 조사 중');
  assert.equal(describeTool('mcp__notion__API-post-page', {}), 'notion 도구 사용');
  assert.equal(describeTool('FooBar', {}), 'FooBar 사용 중');
});
test('sanitize: output is bounded to 80 chars', () =>
  assert.ok(describeTool('Bash', {description:'가'.repeat(200)}).length <= 80));
test('sanitize: clip counts code points', () => {
  assert.equal(clip('abcdef', 4), 'abc…');
  assert.equal(clip('abc', 4), 'abc');
  assert.equal(clip('😀😀😀', 2), '😀…');
});
test('sanitize: bash first word never leaks env assignments, URLs or stray quotes', () => {
  assert.equal(describeTool('Bash', {command:'API_KEY=sk-live-123 node run.mjs'}), 'node 실행');
  assert.equal(describeTool('Bash', {command:'"FOO=secret" cmd'}), 'cmd 실행');
  assert.equal(describeTool('Bash', {command:'https://x.io/a?token=zz'}), '명령 실행');
  assert.equal(describeTool('Bash', {command:'"abc secret=1 more'}), '명령 실행');
  assert.equal(describeTool('Bash', {command:'   git status'}), 'git 실행');
  assert.equal(describeTool('Bash', {command:''}), '명령 실행');
  assert.equal(describeTool('Bash', {}), '명령 실행');
  assert.equal(describeTool('Bash', {command:'A=1 B=2'}), '명령 실행');
});
test('sanitize: bash label refuses quoted env values, so no word inside them leaks', () => {
  for (const command of ['TOKEN="a hunter2 c" git push', "TOKEN='a hunter2 c' git push", 'A=1 TOKEN="x hunter2" git']) {
    const text = describeTool('Bash', { command });
    assert.equal(text, '명령 실행', command);
    assert.ok(!text.includes('hunter2'));
  }
  assert.equal(describeTool('Bash', { command: 'FOO=bar git push' }), 'git 실행');
  assert.equal(describeTool('Bash', { command: 'A=1 B=2 git push' }), 'git 실행');
});
