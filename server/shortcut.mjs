// Desktop shortcut: node server/shortcut.mjs [--if-missing]
// Creates "<shortcut.name>.lnk" on the Desktop: target = the node that runs this, argument = server/launch.mjs, minimized.
// --if-missing leaves an existing shortcut alone. AGENT_OFFICE_SHORTCUT_DIR replaces the Desktop folder (tests).
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.mjs';

/** PowerShell single-quoted literal: PowerShell treats the curly single quotes like ', so each of them is doubled too. */
export function psQuote(text) {
  return `'${String(text).replace(/['‘’‚‛]/g, (q) => q + q)}'`;
}

/** The PowerShell script that writes the shortcut. Prints "created" or "exists"; on an error "failed:<base64 of the UTF-8 message>" and exit 1 (never raw text: stdout is not UTF-8). */
export function buildScript({ name, target, args, workDir, icon, windowStyle, desktopDir, ifMissing }) {
  return [
    `$ErrorActionPreference = 'Stop'`,
    `try {`,
    `$dir = ${desktopDir ? psQuote(desktopDir) : `[Environment]::GetFolderPath('Desktop')`}`,
    `$path = Join-Path $dir (${psQuote(`${name}.lnk`)})`,
    ifMissing ? `if (Test-Path -LiteralPath $path) { 'exists'; exit 0 }` : '',
    `New-Item -ItemType Directory -Force -Path $dir | Out-Null`,
    `$link = (New-Object -ComObject WScript.Shell).CreateShortcut($path)`,
    `$link.TargetPath = ${psQuote(target)}`,
    `$link.Arguments = ${psQuote(args)}`,
    `$link.WorkingDirectory = ${psQuote(workDir)}`,
    `$link.WindowStyle = ${Number(windowStyle)}`,
    `if (Test-Path -LiteralPath ${psQuote(icon)}) { $link.IconLocation = ${psQuote(`${icon},0`)} }`,
    `$link.Save()`,
    `'created'`,
    `} catch { [Console]::Out.Write('failed:' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$_.Exception.Message))); exit 1 }`,
  ].filter(Boolean).join('\n');
}

/** powershell.exe arguments: the script travels as UTF-16LE base64, so no quoting layer touches it. */
export function powershellArgs(script) {
  return ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
}

function runPowershell(args) {
  return spawnSync('powershell.exe', args, { encoding: 'utf8', windowsHide: true });
}

/** One pass. Returns { ok, message }; run(args) -> { status, stdout } is injectable. */
export function createShortcut(cfg, { ifMissing = false, desktopDir, run = runPowershell, platform = process.platform, target = process.execPath } = {}) {
  const name = cfg.shortcut.name;
  if (platform !== 'win32') return { ok: false, message: '바로가기는 윈도에서만 만들 수 있습니다' };
  const script = buildScript({
    name,
    target,
    args: `"${join(cfg.root, 'server', 'launch.mjs')}"`,
    workDir: cfg.root,
    icon: join(cfg.root, cfg.shortcut.icon),
    windowStyle: cfg.shortcut.windowStyle,
    desktopDir,
    ifMissing,
  });
  const r = run(powershellArgs(script));
  const out = String(r.stdout ?? '').trim();
  if (r.status === 0 && out.endsWith('created')) return { ok: true, message: `바탕화면에 「${name}」 바로가기를 만들었습니다` };
  if (r.status === 0 && out.endsWith('exists')) return { ok: true, message: `「${name}」 바로가기가 이미 있습니다` };
  const failed = out.match(/failed:([A-Za-z0-9+/=]+)$/);
  const reason = failed ? Buffer.from(failed[1], 'base64').toString('utf8') : (r.error?.message ?? String(r.stderr ?? '').trim().split(/\r?\n/)[0]);
  return { ok: false, message: `바로가기를 만들지 못했습니다 (종료 코드 ${r.status ?? '없음'})${reason ? `: ${reason}` : ''}` };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const result = createShortcut(loadConfig(), { ifMissing: process.argv.includes('--if-missing'), desktopDir: process.env.AGENT_OFFICE_SHORTCUT_DIR });
  (result.ok ? console.log : console.error)(result.message);
  if (!result.ok) process.exitCode = 1;
}
