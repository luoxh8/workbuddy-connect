# Opt-in Windows integration test. No upstream model requests or provider edits.
#
# Verifies the Scheduled Task this project installs:
#   * no trigger at all for -NoAutoStart (an on-demand task)
#   * exactly one logon trigger for an autostart task (the once-a-minute
#     repetition trigger was removed: it only produced 0x800710E0 events)
#   * the action is wscript.exe running Launch-Bridge.vbs, not powershell.exe
#     directly — that is what keeps the black console window from flashing at
#     logon, so it is a regression guard rather than a cosmetic detail
#   * the bridge comes up and answers /healthz with its own token
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$testState = Join-Path $root ('.test-managed-task-' + [Guid]::NewGuid().ToString('N'))
$listener = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, 0)
$listener.Start()
$port = $listener.LocalEndpoint.Port
$listener.Stop()

function Read-Runtime { Get-Content -LiteralPath (Join-Path $testState 'runtime.json') -Raw | ConvertFrom-Json }
function Assert-HiddenLauncher([string]$TaskName) {
    $action = @((Get-ScheduledTask -TaskName $TaskName).Actions)[0]
    if ($null -eq $action) { throw 'Task has no action' }
    if (![IO.Path]::GetFileName($action.Execute).Equals('wscript.exe', [StringComparison]::OrdinalIgnoreCase)) {
        throw "Task action must be wscript.exe (no console window), found '$($action.Execute)'"
    }
    if (!$action.Arguments.Contains('Launch-Bridge.vbs')) {
        throw "Task action must run Launch-Bridge.vbs, found '$($action.Arguments)'"
    }
}
function Get-TriggerCount([string]$TaskName) {
    return @((Get-ScheduledTask -TaskName $TaskName).Triggers | Where-Object { $null -ne $_ }).Count
}

try {
    & (Join-Path $root 'scripts\Install-BridgeTask.ps1') -StateDir $testState -Port $port -NoAutoStart
    $metadata = Get-Content -LiteralPath (Join-Path $testState 'bridge-task.json') -Raw | ConvertFrom-Json
    if ((Get-TriggerCount $metadata.taskName) -ne 0) { throw 'On-demand install unexpectedly added a trigger' }
    Assert-HiddenLauncher $metadata.taskName

    $before = Read-Runtime
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($before.pid)"
    if (!$process.CommandLine.Contains($testState)) { throw 'Runtime process does not belong to this test' }

    # A no-trigger task stays on-demand when manually started without an
    # explicit opt-in. Then upgrade it explicitly to autostart for recovery.
    & (Join-Path $root 'scripts\Start-Bridge.ps1') -StateDir $testState
    if ((Get-TriggerCount $metadata.taskName) -ne 0) { throw 'Manual start changed an existing on-demand task to autostart' }
    & (Join-Path $root 'scripts\Install-BridgeTask.ps1') -StateDir $testState -Port $port -NoAutoStart:$false

    # One logon trigger, no repetition: the wrapper and node are restarted by
    # Run-Bridge.ps1 itself plus the task's RestartOnFailure setting.
    if ((Get-TriggerCount $metadata.taskName) -ne 1) {
        throw "Autostart task needs exactly one logon trigger, found $((Get-TriggerCount $metadata.taskName))"
    }
    [xml]$xml = Export-ScheduledTask -TaskName $metadata.taskName
    $timeTrigger = $xml.SelectSingleNode("//*[local-name()='Triggers']/*[local-name()='TimeTrigger']")
    if ($timeTrigger) { throw 'Autostart task must not carry a repetition TimeTrigger' }
    $logonTrigger = $xml.SelectSingleNode("//*[local-name()='Triggers']/*[local-name()='LogonTrigger']")
    if (!$logonTrigger) { throw 'Autostart task needs a logon trigger' }
    Assert-HiddenLauncher $metadata.taskName

    # The bridge must actually be serving, with the token from its own state.
    $state = Get-Content -LiteralPath (Join-Path $testState 'bridge.json') -Raw | ConvertFrom-Json
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/healthz" -Headers @{ Authorization = "Bearer $($state.token)" } -TimeoutSec 5
    if ($health.service -ne 'workbuddy-connect') { throw 'Bridge is not answering /healthz' }

    # Restart recovery: stopping the task must not leave a stale runtime behind,
    # and re-running the task has to produce a new healthy process.
    $firstPid = [int](Read-Runtime).pid
    Stop-ScheduledTask -TaskName $metadata.taskName
    Start-Sleep -Seconds 2
    Start-ScheduledTask -TaskName $metadata.taskName
    $recovered = $false
    $deadline = [DateTime]::UtcNow.AddSeconds(60)
    while ([DateTime]::UtcNow -lt $deadline) {
        Start-Sleep -Seconds 2
        try {
            $after = Read-Runtime
            if ([int]$after.pid -eq $firstPid) { continue }
            $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/healthz" -Headers @{ Authorization = "Bearer $($state.token)" } -TimeoutSec 2
            if ($health.service -eq 'workbuddy-connect') { $recovered = $true; break }
        } catch { }
    }
    if (!$recovered) { throw 'Bridge did not come back healthy within 60 seconds after a Task restart' }
    Write-Output 'PASS: task uses the hidden wscript launcher, has one logon trigger, and recovers on restart.'
} finally {
    & (Join-Path $root 'scripts\Remove-BridgeTask.ps1') -StateDir $testState
    if ($metadata -and (Get-ScheduledTask -TaskName $metadata.taskName -ErrorAction SilentlyContinue)) { throw 'Test task was not removed' }
}
