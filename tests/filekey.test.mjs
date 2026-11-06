// Same-file keys (conflict alarm): one key per file, no path text in the key. Paths are synthetic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import config from '../config.json' with { type: 'json' };
import { fileKey } from '../server/filekey.mjs';

const OPTS = { maxChars: config.conflict.maxPathChars, hashChars: config.conflict.hashChars };
const SALT = Buffer.from('0123456789abcdef');
const key = (raw, salt = SALT) => fileKey(raw, salt, OPTS);

test('case, slashes and dot-dot differences give one key', () => {
  const k = key('C:\\fixture\\repo-alpha\\src\\a.mjs');
  assert.ok(k);
  assert.equal(key('c:/FIXTURE/Repo-Alpha/src/a.mjs'), k);
  assert.equal(key('C:\\fixture\\repo-alpha\\lib\\..\\src\\a.mjs'), k);
  assert.equal(key('C:\\fixture\\repo-alpha\\src\\a.mjs\\'), k);
  assert.equal(key('/work/repo-alpha/lib/../src/a.mjs'), key('/work/repo-alpha/src/a.mjs'));
  assert.notEqual(key('/work/repo-alpha/src/A.mjs'), key('/work/repo-alpha/src/a.mjs')); // a posix path keeps its case
});

test('same name in another folder gives another key', () => {
  assert.notEqual(key('C:\\fixture\\repo-alpha\\src\\a.mjs'), key('C:\\fixture\\repo-beta\\src\\a.mjs'));
  assert.notEqual(key('/work/repo-alpha/a.mjs'), key('/work/repo-beta/a.mjs'));
});

test('a relative path gives null', () => {
  for (const raw of ['src\\a.mjs', 'src/a.mjs', './a.mjs', '..\\a.mjs', 'C:a.mjs', '', 'a.mjs']) assert.equal(key(raw), null, raw);
  for (const raw of [undefined, null, 5, {}, ['/x']]) assert.equal(key(raw), null);
  assert.equal(key(`/${'a'.repeat(OPTS.maxChars)}`), null); // longer than conflict.maxPathChars
});

test('another salt gives another key', () => {
  const raw = 'C:\\fixture\\repo-alpha\\src\\a.mjs';
  assert.notEqual(key(raw, Buffer.from('another-salt-xyz')), key(raw));
  assert.equal(key(raw, Buffer.from('0123456789abcdef')), key(raw));
});

test('the key is hashChars hex and holds no folder name', () => {
  const k = key('C:\\fixture\\repo-alpha\\zeta-folder\\a.mjs');
  assert.match(k, new RegExp(`^[0-9a-f]{${OPTS.hashChars}}$`));
  for (const piece of ['fixture', 'repo-alpha', 'zeta-folder', 'a.mjs']) assert.ok(!k.includes(piece));
});

test('the \\\\?\\ prefix is dropped', () => {
  const k = key('C:\\fixture\\repo-alpha\\src\\a.mjs');
  assert.equal(key('\\\\?\\C:\\fixture\\repo-alpha\\src\\a.mjs'), k);
  assert.equal(key('\\\\?\\UNC\\server\\share\\a.mjs'), key('\\\\server\\share\\a.mjs'));
});
