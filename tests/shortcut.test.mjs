import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { psQuote, buildScript, powershellArgs, createShortcut } from '../server/shortcut.mjs';
import { loadConfig } from '../server/config.mjs';

const WINDOWS = process.platform === 'win32';
const NASTY = `a b'c"d%E%&^$\`(x);한글 ’‘‚‛ end`;

const psRun = (script) => spawnSync('powershell.exe', powershellArgs(script), { encoding: 'utf8', windowsHide: true });
const utf8Base64 = (expr) => `[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string](${expr})))`;

test('psQuote: single-quoted literal, every kind of single quote doubled, nothing else touched', () => {
  assert.equal(psQuote(String.raw`C:\a b\c`), String.raw`'C:\a b\c'`);
  assert.equal(psQuote(`it's`), `'it''s'`);
  assert.equal(psQuote('\u2019'), `'\u2019\u2019'`);
  assert.equal(psQuote('%PATH% & "x" $y `z'), `'%PATH% & "x" $y \`z'`);
});

test('powershellArgs: no profile, no prompts, script as UTF-16LE base64 that decodes back', () => {
  const script = `'한글 ’' + 1`;
  const a = powershellArgs(script);
  assert.deepEqual(a.slice(0, 3), ['-NoProfile', '-NonInteractive', '-EncodedCommand']);
  assert.equal(Buffer.from(a[3], 'base64').toString('utf16le'), script);
});

const base = { name: '에이전트 사무실', target: String.raw`C:\n d\node.exe`, args: String.raw`"C:\a b\server\launch.mjs"`, workDir: String.raw`C:\a b`, icon: String.raw`C:\a b\assets\icon.ico`, windowStyle: 7 };

test('buildScript: every path is a quoted literal, Desktop comes from the shell folder, window style is minimized', () => {
  const s = buildScript(base);
  assert.match(s, /\$dir = \[Environment\]::GetFolderPath\('Desktop'\)/);
  assert.ok(s.includes(String.raw`$link.TargetPath = 'C:\n d\node.exe'`));
  assert.ok(s.includes(String.raw`$link.Arguments = '"C:\a b\server\launch.mjs"'`));
  assert.ok(s.includes(String.raw`$link.WorkingDirectory = 'C:\a b'`));
  assert.ok(s.includes(String.raw`'C:\a b\assets\icon.ico,0'`));
  assert.ok(s.includes('$link.WindowStyle = 7'));
  assert.ok(!s.includes('Test-Path -LiteralPath $path'));
});
test('buildScript: --if-missing adds the exists check before anything is written; a folder override replaces the Desktop', () => {
  const s = buildScript({ ...base, ifMissing: true, desktopDir: String.raw`D:\it's` });
  assert.ok(s.indexOf('Test-Path -LiteralPath $path') < s.indexOf('Save()'));
  assert.ok(s.includes(String.raw`$dir = 'D:\it''s'`));
  assert.ok(!s.includes('GetFolderPath'));
});

test('createShortcut: builds the command from config, reports created / exists / failure in Korean', () => {
  const cfg = loadConfig();
  const seen = [];
  const run = (stdout, status = 0) => (args) => { seen.push(args); return { status, stdout }; };
  const made = createShortcut(cfg, { run: run('created\r\n'), platform: 'win32' });
  assert.equal(made.ok, true);
  assert.match(made.message, /「에이전트 사무실」 바로가기를 만들었습니다/);
  const script = Buffer.from(seen[0][3], 'base64').toString('utf16le');
  assert.ok(script.includes(psQuote(process.execPath)));
  assert.ok(script.includes(psQuote(`"${path.join(cfg.root, 'server', 'launch.mjs')}"`)));
  const skipped = createShortcut(cfg, { run: run('exists\r\n'), platform: 'win32', ifMissing: true });
  assert.match(skipped.message, /이미 있습니다/);
  const failed = createShortcut(cfg, { run: run('', 1), platform: 'win32' });
  assert.equal(failed.ok, false);
  assert.match(failed.message, /만들지 못했습니다/);
  assert.equal(createShortcut(cfg, { run: run(''), platform: 'linux' }).ok, false);
  const withReason = createShortcut(cfg, { run: run(`failed:${Buffer.from('접근이 거부되었습니다', 'utf8').toString('base64')}`, 1), platform: 'win32' });
  assert.match(withReason.message, /종료 코드 1\): 접근이 거부되었습니다$/);
  const odd = createShortcut(cfg, { run: run('something else\r\n'), platform: 'win32' });
  assert.equal(odd.ok, false);
  assert.doesNotMatch(odd.message, /이미 있습니다/);
  assert.equal(createShortcut(cfg, { run: () => ({ status: null, stdout: '', error: new Error('spawn powershell.exe ENOENT') }), platform: 'win32' }).message.endsWith('ENOENT'), true);
});

test('shortcut config: name, icon and window style come from config.json', () => {
  const cfg = loadConfig();
  assert.deepEqual(cfg.shortcut, { name: '에이전트 사무실', icon: 'assets/icon.ico', windowStyle: 7 });
  assert.ok(fs.existsSync(path.join(cfg.root, cfg.shortcut.icon)));
});

test('powershell reads a quoted literal back exactly (spaces, quotes, %, &, curly quotes, Korean)', { skip: !WINDOWS }, () => {
  const r = psRun(`[Console]::Out.Write((${psQuote(NASTY)}).ToCharArray().ForEach({ [int]$_ }) -join ',')`);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, [...NASTY].map((c) => c.codePointAt(0)).join(','));
});

test('a real shortcut is written in a temp folder and reads back through WScript.Shell', { skip: !WINDOWS }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `sc test ' & 한글 %x% `));
  try {
    const desktop = path.join(tmp, `desk ’top`);
    const root = path.join(tmp, `app root ' & 한글`);
    fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
    fs.copyFileSync(path.join(loadConfig().root, 'assets', 'icon.ico'), path.join(root, 'assets', 'icon.ico'));
    const cfg = { root, shortcut: loadConfig().shortcut };
    const first = createShortcut(cfg, { desktopDir: desktop });
    assert.equal(first.ok, true, first.message);
    const lnk = path.join(desktop, '에이전트 사무실.lnk');
    assert.ok(fs.existsSync(lnk));
    const readBack = `$l = (New-Object -ComObject WScript.Shell).CreateShortcut(${psQuote(lnk)})
      foreach ($v in @($l.TargetPath, $l.Arguments, $l.WorkingDirectory, $l.IconLocation, $l.WindowStyle)) { ${utf8Base64('$v')} }`;
    const lines = psRun(readBack).stdout.split(/\r?\n/).filter(Boolean).map((b) => Buffer.from(b, 'base64').toString('utf8'));
    assert.deepEqual(lines, [process.execPath, `"${path.join(root, 'server', 'launch.mjs')}"`, root, `${path.join(root, 'assets', 'icon.ico')},0`, '7']);
    const before = fs.statSync(lnk).mtimeMs;
    const again = createShortcut(cfg, { desktopDir: desktop, ifMissing: true });
    assert.match(again.message, /이미 있습니다/);
    assert.equal(fs.statSync(lnk).mtimeMs, before);
    assert.deepEqual(fs.readdirSync(desktop), ['에이전트 사무실.lnk']);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('a shortcut that cannot be written reports the PowerShell reason, not just an exit code', { skip: !WINDOWS }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-fail-'));
  try {
    const blocker = path.join(tmp, 'a-file');
    fs.writeFileSync(blocker, 'x');
    const result = createShortcut(loadConfig(), { desktopDir: path.join(blocker, 'sub') });
    assert.equal(result.ok, false);
    assert.match(result.message, /종료 코드 1\): .+/);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
