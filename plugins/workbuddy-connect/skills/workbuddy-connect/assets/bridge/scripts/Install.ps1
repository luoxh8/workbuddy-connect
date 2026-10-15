param(
    [ValidateSet('auto', 'cn', 'global', 'both')][string]$Region = 'auto',
    [ValidateRange(1024, 65535)][int]$Port = 10108,
    [string]$StateDir = (Join-Path $env:USERPROFILE '.zcode\workbuddy-connect'),
    [switch]$FreeOnly,
    [switch]$NoAutoStart
)
$ErrorActionPreference = 'Stop'
$sourceRoot = Split-Path -Parent $PSScriptRoot
$resolvedState = [IO.Path]::GetFullPath($StateDir)
$portWasSpecified = $PSBoundParameters.ContainsKey('Port')
$node = Get-Command node.exe -ErrorAction SilentlyContinue
if ($null -eq $node) { throw 'Node.js 24 or newer is required. Install it first, then rerun this installer.' }
$nodeMajor = [int]((& $node.Source --version).Trim().TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 24) { throw "Node.js 24 or newer is required; found $nodeMajor." }
$statePath = Join-Path $resolvedState 'bridge.json'
$plannedPort = $Port
if (Test-Path -LiteralPath $statePath) {
    try { $plannedPort = (Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json).port }
    catch { throw 'Existing bridge state is invalid; it was not changed.' }
}
$startup = [Environment]::GetFolderPath('Startup')
$shortcutPath = Join-Path $startup 'WorkBuddy Connect.lnk'
$expectedStart = Join-Path $PSScriptRoot 'Start-Bridge.ps1'
$plannedArguments = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $expectedStart + '" -StateDir "' + $resolvedState + '" -Port ' + $plannedPort
if (Test-Path -LiteralPath $shortcutPath) {
    $existingShortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($shortcutPath)
    if (!$existingShortcut.Arguments.Contains($expectedStart) -or !$existingShortcut.Arguments.Contains($resolvedState)) { throw 'An unrelated WorkBuddy startup shortcut already exists. It was not overwritten and no provider was changed.' }
}
$startArgs = @{ StateDir = $resolvedState; NoAutoStart = $NoAutoStart }
if ($portWasSpecified) { $startArgs.Port = $Port }
& (Join-Path $PSScriptRoot 'Install-BridgeTask.ps1') @startArgs
$cliArgs = @((Join-Path $sourceRoot 'src\cli.ts'), 'install', '--state-dir', $resolvedState, '--region', $Region)
if ($portWasSpecified) { $cliArgs += @('--port', $Port) }
if ($FreeOnly) { $cliArgs += '--free-only' }
& $node.Source @cliArgs
if ($LASTEXITCODE -ne 0) { throw 'OpenCodex registration failed. The managed bridge remains available for diagnosis.' }
if (Test-Path -LiteralPath $shortcutPath) {
    Remove-Item -LiteralPath $shortcutPath
}
Write-Output 'WorkBuddy bridge is managed by Windows Task Scheduler with automatic recovery.'
