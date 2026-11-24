param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$Version
)

# Quick version replacement. The repository root VERSION file stays the source;
# scripts/version.mjs updates every checked-in declaration from it.
$ErrorActionPreference = 'Stop'
$script = Join-Path $PSScriptRoot 'version.mjs'
& node $script set $Version
exit $LASTEXITCODE
