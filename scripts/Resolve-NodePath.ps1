# Shared Node.js resolution for the bridge scripts.
#
# The bridge runs TypeScript directly, so it needs a runtime with type stripping
# enabled by default (Node 22.18+). A plain ZCode or WorkBuddy desktop user often
# has no global `node`, so besides PATH this also accepts the runtime WorkBuddy
# itself ships, and the usual Windows install locations.
#
# Dot-source this file, then call Resolve-BridgeNodePath.

function Get-NodeMajorMinor([string]$Executable) {
    $version = (& $Executable --version 2>$null)
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($version)) { return $null }
    $parts = $version.Trim().TrimStart('v').Split('.')
    if ($parts.Length -lt 2) { return $null }
    return [pscustomobject]@{ Major = [int]$parts[0]; Minor = [int]$parts[1]; Text = $version.Trim() }
}

function Resolve-BridgeNodePath {
    param([string]$Explicit)

    $candidates = New-Object System.Collections.Generic.List[string]
    if (-not [string]::IsNullOrWhiteSpace($Explicit)) { $candidates.Add($Explicit) }
    if (-not [string]::IsNullOrWhiteSpace($env:WORKBUDDY_NODE_PATH)) { $candidates.Add($env:WORKBUDDY_NODE_PATH) }

    $onPath = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($null -ne $onPath) { $candidates.Add($onPath.Source) }

    # WorkBuddy bundles its own Node runtime next to the desktop app's data.
    $bundledRoot = Join-Path $env:USERPROFILE '.workbuddy\binaries\node\versions'
    if (Test-Path -LiteralPath $bundledRoot) {
        Get-ChildItem -LiteralPath $bundledRoot -Directory -ErrorAction SilentlyContinue |
            Sort-Object -Property Name -Descending |
            ForEach-Object { $candidates.Add((Join-Path $_.FullName 'node.exe')) }
    }

    foreach ($root in @($env:ProgramFiles, ${env:ProgramFiles(x86)})) {
        if (-not [string]::IsNullOrWhiteSpace($root)) { $candidates.Add((Join-Path $root 'nodejs\node.exe')) }
    }

    $seen = New-Object System.Collections.Generic.HashSet[string]
    foreach ($candidate in $candidates) {
        if ([string]::IsNullOrWhiteSpace($candidate)) { continue }
        $full = [IO.Path]::GetFullPath($candidate)
        if (-not $seen.Add($full.ToLowerInvariant())) { continue }
        if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { continue }
        $parsed = Get-NodeMajorMinor $full
        if ($null -eq $parsed) { continue }
        if ($parsed.Major -gt 22 -or ($parsed.Major -eq 22 -and $parsed.Minor -ge 18)) { return $full }
    }

    throw 'Node.js 22.18 or newer was not found. Install it from https://nodejs.org/en/download (or point WORKBUDDY_NODE_PATH at an existing node.exe), then rerun.'
}
