param(
    [ValidateSet('auto', 'cn', 'global', 'both')][string]$Region = 'both',
    [string]$StateDir = (Join-Path $env:USERPROFILE '.workbuddy-connect')
)
$ErrorActionPreference = 'Stop'
$sourceRoot = Split-Path -Parent $PSScriptRoot
$resolvedState = [IO.Path]::GetFullPath($StateDir)
. (Join-Path $PSScriptRoot 'Resolve-NodePath.ps1')
$nodePath = Resolve-BridgeNodePath
& $nodePath (Join-Path $sourceRoot 'src\cli.ts') remove --state-dir $resolvedState --region $Region
$removeExit = $LASTEXITCODE
if ($removeExit -eq 2) { throw 'Provider removal was skipped because a provider is not owned by this bridge. The bridge and startup shortcut remain unchanged.' }
if ($removeExit -ne 0) { throw 'Provider removal failed; bridge and startup shortcut remain unchanged.' }
if ($Region -eq 'cn' -or $Region -eq 'global') {
    Write-Output 'Selected WorkBuddy provider removed. The shared bridge and startup shortcut remain available for the other region.'
    return
}
$shortcutPath = Join-Path ([Environment]::GetFolderPath('Startup')) 'WorkBuddy Connect.lnk'
& (Join-Path $PSScriptRoot 'Remove-BridgeTask.ps1') -StateDir $resolvedState
if (Test-Path -LiteralPath $shortcutPath) {
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($shortcutPath)
    if ($shortcut.Arguments.Contains((Join-Path $PSScriptRoot 'Start-Bridge.ps1')) -and $shortcut.Arguments.Contains($resolvedState)) { Remove-Item -LiteralPath $shortcutPath }
}
$runtimePath = Join-Path $resolvedState 'runtime.json'
if (Test-Path -LiteralPath $runtimePath) {
    $runtime = Get-Content -LiteralPath $runtimePath -Raw | ConvertFrom-Json
    $bridgeProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $($runtime.pid)" -ErrorAction SilentlyContinue
    $entry = Join-Path $sourceRoot 'src\cli.ts'
    if ($bridgeProcess -and $bridgeProcess.CommandLine -and $bridgeProcess.CommandLine.Contains($entry) -and $bridgeProcess.CommandLine.Contains($resolvedState)) { Stop-Process -Id $runtime.pid }
}
Write-Output 'WorkBuddy providers and this installation’s startup shortcut removed. Desktop login files are untouched.'
