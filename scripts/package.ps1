# Practacu Press - Windows portable package
#
# Run from the repository root:
#   powershell -ExecutionPolicy Bypass -File scripts\package.ps1
#
# The Node script does the actual frontend build, API build, self-test and zip.

[CmdletBinding()]
param(
    [ValidateSet('amd64', 'arm64')]
    [string]$Arch = '',
    [switch]$SkipSmoke,
    [switch]$NoZip,
    [string]$ReleaseDir = '',
    [int]$Port = 0
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

function Write-Step {
    param([string]$Text)
    Write-Host ''
    Write-Host "==> $Text" -ForegroundColor Cyan
}

function Stop-WithError {
    param([string]$Text)
    Write-Host ''
    Write-Host "[ERROR] $Text" -ForegroundColor Red
    exit 1
}

Write-Host 'Practacu Press - Windows package' -ForegroundColor Green
Write-Host "Repository: $repo"

Write-Step 'Checking toolchain'
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Stop-WithError 'Node.js was not found. Install Node.js 22 or newer: https://nodejs.org'
}
$nodeVersion = (& node --version).Trim().TrimStart('v')
$nodeParts = $nodeVersion.Split('.')
$nodeMajor = 0
$nodeMinor = 0
[void][int]::TryParse($nodeParts[0], [ref]$nodeMajor)
if ($nodeParts.Count -gt 1) { [void][int]::TryParse($nodeParts[1], [ref]$nodeMinor) }
if ($nodeMajor -lt 22 -or ($nodeMajor -eq 22 -and $nodeMinor -lt 12)) {
    Stop-WithError "Node.js is too old ($nodeVersion); install 22.12 or newer."
}
Write-Host "  Node    v$nodeVersion"

$go = $null
foreach ($candidate in @('C:\Program Files\Go\bin\go.exe', 'C:\Program Files (x86)\Go\bin\go.exe')) {
    if (Test-Path $candidate) { $go = $candidate; break }
}
if (-not $go) {
    $found = Get-Command go -ErrorAction SilentlyContinue
    if ($found) { $go = $found.Source }
}
if (-not $go) {
    Stop-WithError 'Go was not found. Install Go 1.26 or newer: https://go.dev/dl/'
}
Write-Host "  Go      $(& $go version)"

$nodeArgs = @('scripts/package-windows.mjs')
if ($Arch) { $nodeArgs += @('--arch', $Arch) }
if ($SkipSmoke) { $nodeArgs += '--skip-smoke' }
if ($NoZip) { $nodeArgs += '--no-zip' }
if ($ReleaseDir) { $nodeArgs += @('--release-dir', $ReleaseDir) }
if ($Port -gt 0) { $nodeArgs += @('--port', [string]$Port) }

$archLabel = if ($Arch -eq 'arm64') { 'arm64' } elseif ($Arch -eq 'amd64') { 'x64' } elseif ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }

Write-Step 'Building package'
$started = Get-Date
& node @nodeArgs
$code = $LASTEXITCODE
$elapsed = (Get-Date) - $started

if ($code -ne 0) {
    Write-Host ''
    Write-Host "[FAILED] Packaging failed (exit $code) after $([int]$elapsed.TotalSeconds)s." -ForegroundColor Red
    Write-Host '         See the log above for the failing step.' -ForegroundColor Yellow
    exit $code
}

Write-Host ''
Write-Host "[DONE] Package built in $([int]$elapsed.TotalSeconds)s." -ForegroundColor Green
Write-Host '       Directory: release\PractacuPress'
Write-Host "       ZIP:       release\PractacuPress-Windows-$archLabel.zip"
Write-Host '       Unzip, then double-click 启动.cmd or run PractacuPressAPI.exe.'
exit 0
