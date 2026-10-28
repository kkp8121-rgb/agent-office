# Creates the desktop shortcut "에이전트 사무실.lnk" (target: agent-office.cmd, minimized window).
# -Destination: folder to create it in (default: the Desktop).
param([string]$Destination = [Environment]::GetFolderPath('Desktop'))

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$cmd = Join-Path $root 'agent-office.cmd'
$icon = Join-Path $root 'assets\icon.ico'
$name = -join ([char[]](0xC5D0, 0xC774, 0xC804, 0xD2B8, 0x20, 0xC0AC, 0xBB34, 0xC2E4)) # "에이전트 사무실" (kept ASCII-safe: PowerShell 5 reads BOM-less files as ANSI)

New-Item -ItemType Directory -Force -Path $Destination | Out-Null
$lnkPath = Join-Path $Destination "$name.lnk"
$shell = New-Object -ComObject WScript.Shell
$lnk = $shell.CreateShortcut($lnkPath)
$lnk.TargetPath = $cmd
$lnk.WorkingDirectory = $root
$lnk.WindowStyle = 7 # minimized
if (Test-Path $icon) { $lnk.IconLocation = $icon }
$lnk.Save()
Write-Output $lnkPath
