<#
dogfood-launcher.ps1: starts the dogfooding `npm run dev` on Windows under a parent PID that
Windows cannot hand to another process.

A process tree killer that follows recorded parent PIDs without checking creation time can adopt
any process whose parent has exited, once the dead parent's PID is reused inside the tree it is
killing. Windows does not reuse a PID while a handle to that process is open, so this script
keeps one open on the exited launcher above the dev server. See "Dogfooding on Windows" in
docs/developer-guide.md for the mechanism and the measurements.

Usage (Windows PowerShell 5.1 or later):
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\dogfood-launcher.ps1 -CreateShortcut
    Writes "Kangentic (dev).lnk" to this checkout's root, where git ignores it. Double-click it
    there, or pin it to the taskbar. The shortcut carries this checkout's absolute path, so
    generate it on each machine. -ShortcutPath <file.lnk> writes it somewhere else.
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\dogfood-launcher.ps1 -DevCommand "<cmd>"
    Runs the launcher directly with <cmd> in place of `npm run dev`, with no shortcut involved.

The shortcut runs this script with no mode switch (the launcher), which opens a classic console
window running this script again with -PinParent (the host). The host pins the launcher, the
launcher exits, and the host runs -DevCommand (default `npm run dev`) and then stays at a prompt.
#>
param(
  [switch] $CreateShortcut,
  [string] $ShortcutPath,
  # Internal. The launcher passes its own PID to the host window it starts; 0 means launcher mode.
  [int] $PinParent = 0,
  # What the host runs once the pin holds.
  [string] $DevCommand = 'npm run dev'
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path $PSScriptRoot -Parent
# An explicit classic console host. With the default terminal set to "Let Windows decide", a new
# console is handed to Windows Terminal, and the dev server would die with that window.
$conhostPath = Join-Path $env:SystemRoot 'System32\conhost.exe'
$powershellPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$pinEventPrefix = 'Local\kangentic-dogfood-pin-'
$pinTimeoutMilliseconds = 30000

if ($CreateShortcut) {
  if (-not $ShortcutPath) {
    # Ignored by .gitignore. Rename it there too if this name changes.
    $ShortcutPath = Join-Path $repoRoot 'Kangentic (dev).lnk'
  }
  # WScript.Shell resolves a relative path against the process directory, which Set-Location does
  # not move, so resolve it against the PowerShell location first.
  $ShortcutPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($ShortcutPath)
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($ShortcutPath)
  $shortcut.TargetPath = $conhostPath
  $shortcut.Arguments = "`"$powershellPath`" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$PSCommandPath`""
  $shortcut.WorkingDirectory = $repoRoot
  $shortcut.WindowStyle = 7
  $shortcut.Description = 'npm run dev for this checkout, under a pinned parent PID'
  # The app's own icon, so the shortcut stands out in the checkout root. Without node_modules the
  # shortcut keeps conhost's icon.
  $iconPath = Join-Path $repoRoot 'node_modules\@kangentic\branding\resources\desktop\icon.ico'
  if (Test-Path -LiteralPath $iconPath) {
    $shortcut.IconLocation = "$iconPath,0"
  }
  $shortcut.Save()
  Write-Host "Wrote $ShortcutPath"
  Write-Host 'Double-click it to start the dev server, or right-click it and pin it to the taskbar.'
  return
}

if ($PinParent -eq 0) {
  # Launcher. Wait for the host to hold a handle on this process, then exit.
  # The host command line wraps -DevCommand in double quotes. A quote inside it ends the argument
  # early, and a trailing backslash escapes the closing quote.
  if ($DevCommand.Contains('"') -or $DevCommand.EndsWith('\')) {
    throw '-DevCommand cannot contain a double quote or end with a backslash.'
  }
  $pinEvent = New-Object System.Threading.EventWaitHandle($false, [System.Threading.EventResetMode]::ManualReset, ($pinEventPrefix + $PID))
  try {
    $hostArguments = "`"$powershellPath`" -NoProfile -ExecutionPolicy Bypass -NoExit -File `"$PSCommandPath`" -PinParent $PID -DevCommand `"$DevCommand`""
    Start-Process -FilePath $conhostPath -ArgumentList $hostArguments -WorkingDirectory $repoRoot
    [void] $pinEvent.WaitOne($pinTimeoutMilliseconds)
  } finally {
    $pinEvent.Dispose()
  }
  return
}

# Host. Pin the launcher, check that the pinned process really is the one above this window's
# console host, and refuse to run the dev server if anything is off.
$failure = $null
$consoleHost = $null
try {
  # Global on purpose. A script-scope variable is gone once the script ends, and the handle has to
  # stay open at the -NoExit prompt for as long as the window lives. Reading .Handle opens it.
  $global:KangenticDogfoodPin = [System.Diagnostics.Process]::GetProcessById($PinParent)
  $null = $global:KangenticDogfoodPin.Handle
  $self = Get-CimInstance Win32_Process -Filter "ProcessId=$PID" -Property ProcessId, ParentProcessId
  $consoleHost = Get-CimInstance Win32_Process -Filter "ProcessId=$($self.ParentProcessId)" -Property ProcessId, ParentProcessId, Name, CreationDate
  if (-not $consoleHost -or $consoleHost.Name -ne 'conhost.exe') {
    $failure = "this window's parent is not conhost.exe."
  } elseif ([int]$consoleHost.ParentProcessId -ne $PinParent) {
    $failure = "conhost $($consoleHost.ProcessId) records parent $($consoleHost.ParentProcessId), not launcher $PinParent."
  } elseif ($global:KangenticDogfoodPin.HasExited) {
    $failure = "launcher $PinParent exited before this window could hold it."
  } elseif ($global:KangenticDogfoodPin.StartTime -gt $consoleHost.CreationDate) {
    $failure = "PID $PinParent now belongs to a process newer than this window's console host."
  }
} catch {
  $failure = "could not open launcher ${PinParent}: $($_.Exception.Message)"
}

try {
  [System.Threading.EventWaitHandle]::OpenExisting($pinEventPrefix + $PinParent).Set() | Out-Null
} catch {
  # The launcher already gave up waiting. The checks above decide whether this window is safe.
}

Set-Location $repoRoot
if ($failure) {
  Remove-Variable -Name KangenticDogfoodPin -Scope Global -ErrorAction SilentlyContinue
  Write-Host "NOT PROTECTED: $failure" -ForegroundColor Red
  Write-Host 'The dev server was not started. Close this window and launch the shortcut again.' -ForegroundColor Red
  return
}

$Host.UI.RawUI.WindowTitle = 'Kangentic dev server'
Write-Host "Pinned: conhost $($consoleHost.ProcessId) records parent $PinParent, and this window holds it open, so Windows will not reuse that PID while the window is open." -ForegroundColor Green
Invoke-Expression $DevCommand
