# Runs the Go verification gate with the toolchain and proxy this machine needs.
#
#   powershell -ExecutionPolicy Bypass -File scripts\test.ps1
#
# The bypass is required because the repository scripts are unsigned; the earlier
# attempt to dot-source scripts\env.ps1 failed with an execution policy error.

param(
    [ValidateSet('build', 'vet', 'test', 'all')]
    [string]$Task = 'all'
)

$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)

# 64-bit Go: the PATH entry is a 32-bit install.
$go = 'C:\Program Files\Go\bin\go.exe'
if (-not (Test-Path $go)) { $go = 'go' }

# go does not read the WinINET proxy.
if (-not $env:HTTPS_PROXY) {
    $ie = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction SilentlyContinue
    if ($ie -and $ie.ProxyEnable -eq 1 -and $ie.ProxyServer) {
        $env:HTTP_PROXY  = 'http://' + $ie.ProxyServer
        $env:HTTPS_PROXY = $env:HTTP_PROXY
    }
}

function Invoke-Go {
    param([string[]]$GoArgs)

    Write-Host "> go $($GoArgs -join ' ')"
    & $go @GoArgs
    if ($LASTEXITCODE -ne 0) {
        throw "go $($GoArgs -join ' ') failed with exit code $LASTEXITCODE"
    }
}

if ($Task -in @('build', 'all')) { Invoke-Go @('build', './...') }
if ($Task -in @('vet', 'all'))   { Invoke-Go @('vet', './...') }
if ($Task -in @('test', 'all'))  { Invoke-Go @('test', './...') }

Write-Host "ok: $Task"
