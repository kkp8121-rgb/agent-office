import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// Upload filters reject a file whose name has any dot-separated segment (after the first) in this list, so the
// files that ship in the package must never carry one. List copied from the filter's deny list.
const DENIED_EXT = new Set([
  'exe', 'dll', 'msi', 'bat', 'cmd', 'ps1', 'sh', 'bash', 'zsh', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'hta',
  'scr', 'com', 'pif', 'cpl', 'jar', 'apk', 'ipa', 'dmg', 'pkg', 'deb', 'rpm', 'lnk', 'url', 'reg', 'iso', 'img', 'vhd',
  'docm', 'xlsm', 'pptm',
  'html', 'htm', 'xhtml', 'shtml', 'mht', 'mhtml', 'svg', 'svgz', 'swf', 'xap', 'chm', 'hlp',
  'scpt', 'applescript', 'app', 'action', 'command', 'workflow', 'run', 'elf', 'so', 'dylib', 'sys', 'drv', 'ocx',
  'gadget', 'msp', 'mst', 'scf', 'inf', 'ins', 'isp', 'psm1', 'psd1', 'vb', 'ws', 'wsc', 'sct', 'shb', 'shs', 'vxd',
  'appx', 'msix', 'appxbundle', 'msixbundle', 'xbap', 'air', 'crx', 'xpi', 'ade', 'adp',
  'dotm', 'xltm', 'potm', 'sldm', 'xlam', 'ppam', 'torrent',
]);

const hasDeniedSegment = (name) => name.split('.').slice(1).some((seg) => DENIED_EXT.has(seg.trim().toLowerCase()));

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

test('shipped folders hold no file or folder name with a denied extension segment', () => {
  const names = [];
  for (const entry of ['server', 'web', 'assets', 'config.json', 'package.json']) {
    const p = join(ROOT, entry);
    assert.ok(existsSync(p), entry);
    names.push(...(entry.includes('.') ? [p] : walk(p)));
  }
  assert.ok(names.length > 100); // the walk really found the shipped files
  const bad = names
    .map((p) => relative(ROOT, p).replaceAll('\\', '/'))
    .filter((rel) => rel.split('/').some(hasDeniedSegment));
  assert.deepEqual(bad, []);
});

test('the name check itself: denied segments anywhere after the first dot are caught', () => {
  for (const n of ['app.js', 'index.html', 'a.exe.zip', 'report.pdf.exe', 'run.CMD', 'x.ps1']) assert.equal(hasDeniedSegment(n), true, n);
  for (const n of ['app.mjs', 'style.css', 'scene.json', 'wx-cloud-a-day.png', 'icon.ico', 'package.json', 'html']) assert.equal(hasDeniedSegment(n), false, n);
});
