// The PowerShell text the CPU helper runs (see server/taskmgr-cpu.mjs). It is a string here, not a .ps1 file, because upload filters refuse a package with a script file in it.
// $ParentPid and $IntervalSec are put in front of this text by the spawner.
// Every interval it prints one line "C <0..100>" (ASCII only, so the console code page never matters):
// the CPU time used by the processes that were alive at both snapshots (protected ones too), over interval x logical processors.
// A process that starts and ends between two snapshots is never seen, the same as in Task Manager.
export const SCRIPT = String.raw`
# FullLanguage reads the whole performance counter category in one cheap call. Constrained language mode (no .NET object creation) falls back to WMI, which does the same but costs more.
$ErrorActionPreference = 'Stop'
$full = $ExecutionContext.SessionState.LanguageMode -eq 'FullLanguage'
if ($full) {
  $n = [Environment]::ProcessorCount
  $cat = New-Object System.Diagnostics.PerformanceCounterCategory 'Process'
} else {
  $n = [int](Get-CimInstance Win32_ComputerSystem).NumberOfLogicalProcessors
}

function Snap {
  if (-not $full) { return SnapWmi }
  $d = $cat.ReadCategory()
  $time = $d['% Processor Time']
  $ids = $d['ID Process']
  $h = @{}
  $at = 0
  foreach ($k in @($time.Keys)) {
    if ($k -eq '_Total') { continue }
    $cell = $time[$k]
    $at = $cell.Sample.TimeStamp100nSec
    $id = [int]$ids[$k].RawValue
    if ($id -ne 0) { $h[$id] = [double]$cell.RawValue }
  }
  @{ At = [double]$at; Procs = $h }
}

function SnapWmi {
  $h = @{}
  $at = 0
  foreach ($p in (Get-CimInstance Win32_PerfRawData_PerfProc_Process -Property IDProcess, Name, PercentProcessorTime, Timestamp_Sys100NS)) {
    $at = $p.Timestamp_Sys100NS
    if ([int]$p.IDProcess -ne 0 -and $p.Name -ne '_Total') { $h[[int]$p.IDProcess] = [double]$p.PercentProcessorTime }
  }
  @{ At = [double]$at; Procs = $h }
}

$prev = Snap
$ticks = 1 # the first line comes after one second, so a page that just opened does not wait a whole interval
while ($true) {
  for ($i = 0; $i -lt $ticks; $i++) {
    Start-Sleep -Seconds 1
    if (-not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { exit 0 }
  }
  $cur = Snap
  $span = ($cur.At - $prev.At) * $n
  if ($span -gt 0) {
    $busy = 0.0
    foreach ($id in $cur.Procs.Keys) {
      if ($prev.Procs.ContainsKey($id)) {
        $d = $cur.Procs[$id] - $prev.Procs[$id]
        if ($d -gt 0) { $busy += $d }
      }
    }
    $pct = [int](100 * $busy / $span + 0.5)
    if ($pct -gt 100) { $pct = 100 }
    Write-Output ('C ' + [int]$pct)
  }
  $prev = $cur
  $ticks = $IntervalSec
}
`;
