# Starts the whole stack for local development.
#
#   powershell -ExecutionPolicy Bypass -File scripts\dev.ps1
#
# What it does:
#   1. puts the 64-bit Go toolchain on PATH (the PATH entry is a 32-bit install)
#   2. creates and seeds the SQLite database once
#   3. starts the Rust security service on $SecurityPort
#   4. starts the Go API on $ApiPort and waits until /healthz answers
#
# Both child processes are stopped when you press Ctrl+C, so nothing is left running.

param(
    [int]$ApiPort = 8080,
    [int]$SecurityPort = 9001,
    [string]$DataDir = '',
    [switch]$SkipSecurity,
    [switch]$RebuildSecurity
)

$ErrorActionPreference = 'Stop'
$repo = (Split-Path -Parent $PSScriptRoot)
Set-Location $repo

if ([string]::IsNullOrWhiteSpace($DataDir)) { $DataDir = Join-Path $repo 'data' }
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null

function Resolve-Go {
    $candidates = @(
        'C:\Program Files\Go\bin\go.exe',
        (Join-Path $env:LOCALAPPDATA 'Programs\Go\bin\go.exe')
    )
    foreach ($candidate in $candidates) {
        if (Test-Path $candidate) { return $candidate }
    }
    $onPath = Get-Command go -ErrorAction SilentlyContinue
    if ($onPath) { return $onPath.Source }
    throw 'go was not found; install Go 1.26 or newer'
}

$go = Resolve-Go
Write-Host "go:     $go"

$dsn = 'file:' + (($DataDir -replace '\\', '/')) + '/practacu.db' +
       '?_pragma=foreign_keys(1)&_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)'

$env:APP_ENV = 'development'
$env:HTTP_ADDR = "127.0.0.1:$ApiPort"
$env:DATABASE_DRIVER = 'sqlite'
$env:DATABASE_DSN = $dsn
$env:SECURITY_GRPC_ADDR = "127.0.0.1:$SecurityPort"
$env:STORAGE_DRIVER = 'local'
$env:STORAGE_DIR = Join-Path $DataDir 'media'
$env:SECURITY_GRPC_BIND = "127.0.0.1:$SecurityPort"
# One-click local installs have no operator console: the first account must be a
# platform administrator, and a database created before this flag existed is repaired
# at startup. Server deployments start the API without this flag.
$env:PP_DESKTOP = 'true'

$children = New-Object System.Collections.Generic.List[System.Diagnostics.Process]

function Stop-Children {
    foreach ($child in $children) {
        if (-not $child.HasExited) {
            try { Stop-Process -Id $child.Id -Force -ErrorAction SilentlyContinue } catch { }
        }
    }
    $children.Clear()
}

try {
    if (-not $env:HTTPS_PROXY) {
        $ie = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction SilentlyContinue
        if ($ie -and $ie.ProxyEnable -eq 1 -and $ie.ProxyServer) {
            $env:HTTP_PROXY = 'http://' + $ie.ProxyServer
            $env:HTTPS_PROXY = $env:HTTP_PROXY
            $env:NO_PROXY = 'localhost,127.0.0.1'
            Write-Host "proxy:  $($env:HTTPS_PROXY)"
        }
    }

    Write-Host '> applying schema and seeding the default site'
    & $go run ./apps/api/cmd/seed -driver sqlite -dsn $dsn | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "seed failed with exit code $LASTEXITCODE" }

    if (-not $SkipSecurity) {
        $securityExe = Join-Path $repo 'services\security\target\release\practacu-security.exe'
        if ((Test-Path $securityExe) -and -not $RebuildSecurity) {
            Write-Host "> starting security service  $securityExe"
            $children.Add((Start-Process -FilePath $securityExe -PassThru -NoNewWindow `
                -RedirectStandardOutput (Join-Path $DataDir 'security.log') `
                -RedirectStandardError (Join-Path $DataDir 'security.err.log')))
        }
        else {
            Write-Host '> building the security service (first run takes a few minutes)'
            Push-Location (Join-Path $repo 'services\security')
            try {
                & rustup run stable-x86_64-pc-windows-msvc cargo build --release
                if ($LASTEXITCODE -ne 0) { throw "cargo build failed with exit code $LASTEXITCODE" }
            }
            finally { Pop-Location }

            $children.Add((Start-Process -FilePath $securityExe -PassThru -NoNewWindow `
                -RedirectStandardOutput (Join-Path $DataDir 'security.log') `
                -RedirectStandardError (Join-Path $DataDir 'security.err.log')))
        }
    }
    else {
        Write-Host '> security service skipped: publishing and upload completion will fail closed'
    }

    # The server is built first and then started directly. Running it through "go run"
    # would leave the compiled child alive when only the wrapper is stopped.
    Write-Host '> building the API'
    $apiExe = Join-Path $DataDir 'practacu-api.exe'
    & $go build -o $apiExe ./apps/api/cmd/server
    if ($LASTEXITCODE -ne 0) { throw "go build failed with exit code $LASTEXITCODE" }

    Write-Host '> starting the API'
    $apiLog = Join-Path $DataDir 'api.log'
    $apiErr = Join-Path $DataDir 'api.err.log'
    $children.Add((Start-Process -FilePath $apiExe -PassThru -NoNewWindow `
        -RedirectStandardOutput $apiLog -RedirectStandardError $apiErr))

    $healthUrl = "http://127.0.0.1:$ApiPort/healthz"
    $ready = $false
    for ($i = 0; $i -lt 60; $i++) {
        Start-Sleep -Milliseconds 500
        try {
            $response = Invoke-WebRequest $healthUrl -UseBasicParsing -TimeoutSec 2
            if ($response.StatusCode -eq 200) { $ready = $true; break }
        }
        catch { }
    }
    if (-not $ready) {
        Write-Host '--- api stderr ---'
        Get-Content $apiErr -ErrorAction SilentlyContinue | Select-Object -Last 20 | ForEach-Object { Write-Host $_ }
        throw 'the API did not become healthy'
    }

    Write-Host ''
    Write-Host '  Practacu Press is running'
    Write-Host "  API        http://127.0.0.1:$ApiPort"
    Write-Host "  OpenAPI    http://127.0.0.1:$ApiPort/api/v1/openapi.json"
    Write-Host "  healthz    http://127.0.0.1:$ApiPort/healthz"
    Write-Host "  data       $DataDir"
    Write-Host ''
    Write-Host '  Press Ctrl+C to stop.'
    Write-Host ''

    while ($true) {
        Start-Sleep -Seconds 1
        foreach ($child in @($children)) {
            if ($child.HasExited) {
                Write-Host "a child process exited with code $($child.ExitCode)"
                throw 'a component stopped unexpectedly'
            }
        }
    }
}
finally {
    Write-Host ''
    Write-Host '> stopping'
    Stop-Children
}
