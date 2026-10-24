param(
    [Parameter(Mandatory = $true)][string]$StateDir,
    [ValidateRange(1024, 65535)][int]$Port = 10108,
    [string]$NodePath
)

# This script is the long-lived Scheduled Task supervision loop. Keep the Node
# process in the foreground: if it exits, Task Scheduler still owns this wrapper
# rather than an ephemeral parent shell that may disappear after installation.
$ErrorActionPreference = 'Stop'
$sourceRoot = Split-Path -Parent $PSScriptRoot
$bridgeEntry = Join-Path $sourceRoot 'src\cli.ts'
$resolvedState = [IO.Path]::GetFullPath($StateDir)
$logPath = Join-Path $resolvedState 'bridge-supervisor.log'

if (!(Test-Path -LiteralPath $bridgeEntry -PathType Leaf)) { throw 'Bridge entrypoint is missing.' }
New-Item -ItemType Directory -Force -Path $resolvedState | Out-Null

. (Join-Path $PSScriptRoot 'Resolve-NodePath.ps1')
# A scheduled task may start with a minimal environment, so resolve again
# instead of trusting a PATH that the task never inherited.
$NodePath = Resolve-BridgeNodePath -Explicit $NodePath

function Write-Log([string]$Message) {
    Add-Content -LiteralPath $logPath -Value $Message -Encoding UTF8
}

# The task action is wscript.exe (a GUI-subsystem host, so no console window is
# created at logon). That means a task stop kills wscript first and leaves this
# PowerShell process orphaned — it would keep supervising Node forever and the
# bridge would outlive the task. Watch the launcher and exit with it. When this
# script is started by hand there is no wscript parent, so no watchdog is armed
# and behaviour is unchanged.
$launcherPid = $null
try {
    $self = Get-CimInstance Win32_Process -Filter "ProcessId = $PID" -ErrorAction SilentlyContinue
    if ($self -and $self.ParentProcessId) {
        $parent = Get-CimInstance Win32_Process -Filter "ProcessId = $($self.ParentProcessId)" -ErrorAction SilentlyContinue
        if ($parent -and $parent.Name -ieq 'wscript.exe' -and $parent.CommandLine -and $parent.CommandLine.Contains('Launch-Bridge.vbs')) {
            $launcherPid = [int]$self.ParentProcessId
        }
    }
} catch { }
function Test-LauncherAlive {
    if ($null -eq $launcherPid) { return $true }
    return $null -ne (Get-Process -Id $launcherPid -ErrorAction SilentlyContinue)
}

# Task Scheduler can stop the wrapper without stopping its native child.
# Reclaim only a runtime recorded by this installation whose owner is gone.
$runtimePath = Join-Path $resolvedState 'runtime.json'
if (Test-Path -LiteralPath $runtimePath) {
    $previousRuntime = Get-Content -LiteralPath $runtimePath -Raw | ConvertFrom-Json
    if ($previousRuntime.pid) {
        $previousNode = Get-CimInstance Win32_Process -Filter "ProcessId = $($previousRuntime.pid)" -ErrorAction SilentlyContinue
        if ($previousNode -and $previousNode.CommandLine -and $previousNode.CommandLine.Contains($bridgeEntry) -and $previousNode.CommandLine.Contains($resolvedState)) {
            $previousOwner = Get-CimInstance Win32_Process -Filter "ProcessId = $($previousNode.ParentProcessId)" -ErrorAction SilentlyContinue
            $ownerAlive = $previousOwner -and $previousOwner.CommandLine -and $previousOwner.CommandLine.Contains($PSCommandPath) -and $previousOwner.CommandLine.Contains($resolvedState) -and ($previousOwner.CreationDate -le $previousNode.CreationDate)
            if ($ownerAlive) { throw 'Another supervisor already owns this bridge runtime.' }
            Stop-Process -Id ([int]$previousRuntime.pid) -ErrorAction Stop
            Wait-Process -Id ([int]$previousRuntime.pid) -Timeout 5 -ErrorAction SilentlyContinue
            Write-Log ("[{0:O}] reclaimed previous bridge child after supervisor exit" -f [DateTime]::UtcNow)
        }
    }
}

# Node's own stdout carries only its local service address and PID; credential
# files and tokens are never written to this task log.
$outFile = Join-Path $resolvedState 'bridge-supervisor.out.tmp'
$errFile = Join-Path $resolvedState 'bridge-supervisor.err.tmp'
function Send-NodeOutput {
    foreach ($file in @($outFile, $errFile)) {
        if (Test-Path -LiteralPath $file) {
            $content = Get-Content -LiteralPath $file -ErrorAction SilentlyContinue
            foreach ($line in @($content)) { if ($null -ne $line) { Write-Log ([string]$line) } }
            Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
        }
    }
}

$failureCount = 0
$stopSupervisor = $false
while (!$stopSupervisor) {
    $startedAt = [DateTime]::UtcNow
    Write-Log ("[{0:O}] starting local bridge" -f [DateTime]::UtcNow)
    # Started hidden and stopped by this loop rather than through a pipeline:
    # a pipeline would block the loop and make the launcher check impossible.
    $node = Start-Process -FilePath $NodePath -ArgumentList @($bridgeEntry, 'serve', '--state-dir', $resolvedState, '--port', $Port) `
        -RedirectStandardOutput $outFile -RedirectStandardError $errFile -WindowStyle Hidden -PassThru
    while (!$node.HasExited) {
        Start-Sleep -Milliseconds 500
        $node.Refresh()
        if (!$node.HasExited -and !(Test-LauncherAlive)) {
            # The Scheduled Task was stopped or disabled: take the child down
            # with us instead of becoming an orphan service.
            Stop-Process -Id $node.Id -Force -ErrorAction SilentlyContinue
            Start-Sleep -Milliseconds 300
            $node.Refresh()
            Send-NodeOutput
            Write-Log ("[{0:O}] launcher exited; stopping bridge with it" -f [DateTime]::UtcNow)
            $stopSupervisor = $true
            break
        }
    }
    if ($stopSupervisor) { break }
    $exitCode = $node.ExitCode
    Send-NodeOutput
    if (([DateTime]::UtcNow - $startedAt).TotalSeconds -ge 60) { $failureCount = 0 }
    $failureCount++
    $delay = if ($failureCount -ge 5) { 30 } else { 3 }
    Write-Log ("[{0:O}] bridge exited ({1}); retrying in {2}s" -f [DateTime]::UtcNow, $exitCode, $delay)
    # Sleep in slices so a stopped task is noticed promptly.
    $wokeAt = [DateTime]::UtcNow.AddSeconds($delay)
    while ([DateTime]::UtcNow -lt $wokeAt) {
        Start-Sleep -Milliseconds 500
        if (!(Test-LauncherAlive)) { Write-Log ("[{0:O}] launcher exited during backoff" -f [DateTime]::UtcNow); $stopSupervisor = $true; break }
    }
}
