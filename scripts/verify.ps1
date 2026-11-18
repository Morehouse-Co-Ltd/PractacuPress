# Reproducible verification tasks (Windows mirror of scripts/ci/verify.sh).
#
#   powershell -ExecutionPolicy Bypass -File scripts\verify.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\verify.ps1 -Task go
#   powershell -ExecutionPolicy Bypass -File scripts\verify.ps1 -Task web
#   powershell -ExecutionPolicy Bypass -File scripts\verify.ps1 -Task migrations
#   powershell -ExecutionPolicy Bypass -File scripts\verify.ps1 -Task config
#
# Optional environment:
#   PP_TEST_RACE=1              add -race to go test
#   PP_WEB_INSTALL=ci|auto|skip  npm install strategy (auto = only when missing)
#   PP_TEST_MYSQL_DSN=...       disposable MySQL for the up/down round trip
#   PP_TEST_POSTGRES_DSN=...    disposable PostgreSQL for the up/down round trip
#   PP_MIGRATE_SQLITE_DSN=...   override the temporary SQLite file
#   PP_MIGRATE_MYSQL_DSN=...    disposable MySQL for `cmd/migrate` idempotency
#   PP_MIGRATE_POSTGRES_DSN=... disposable PostgreSQL for `cmd/migrate` idempotency

param(
    [ValidateSet('go', 'web', 'migrations', 'config', 'all')]
    [string]$Task = 'all'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

# 64-bit Go: the PATH entry on this machine is a 32-bit install.
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

$npm = 'npm'
$npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
if ($npmCommand) { $npm = $npmCommand.Source }

function Write-Step {
    param([string]$Message)
    Write-Host ""
    Write-Host "==> $Message"
}

function Invoke-Native {
    param(
        [string]$File,
        [string[]]$Arguments
    )
    Write-Host ("> " + $File + " " + ($Arguments -join ' '))
    & $File @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$File $($Arguments -join ' ') failed with exit code $LASTEXITCODE"
    }
}

function Invoke-Go {
    param([string[]]$Arguments)
    Invoke-Native $go $Arguments
}

function Invoke-GoTask {
    Write-Step 'go build ./...'
    Invoke-Go @('build', './...')

    Write-Step 'go vet ./...'
    Invoke-Go @('vet', './...')

    $testArguments = @('test')
    if ($env:PP_TEST_RACE -eq '1') { $testArguments += '-race' }
    $testArguments += '-count=1'
    $testArguments += './...'
    Write-Step ('go ' + ($testArguments -join ' '))
    Invoke-Go $testArguments
}

function Invoke-WebTask {
    $installMode = $env:PP_WEB_INSTALL
    if (-not $installMode) { $installMode = 'auto' }

    Push-Location (Join-Path $root 'web')
    try {
        if ($installMode -eq 'ci' -or ($installMode -eq 'auto' -and -not (Test-Path 'node_modules'))) {
            Write-Step 'npm ci (web)'
            Invoke-Native $npm @('ci', '--no-audit', '--no-fund')
        }
        elseif ($installMode -eq 'skip') {
            Write-Step 'npm install skipped by PP_WEB_INSTALL=skip'
        }
        else {
            Write-Step 'using existing web/node_modules'
        }

        Write-Step 'npm run typecheck'
        Invoke-Native $npm @('run', 'typecheck')

        Write-Step 'npm run build'
        Invoke-Native $npm @('run', 'build')

        Write-Step 'npm test (vitest)'
        Invoke-Native $npm @('test')
    }
    finally {
        Pop-Location
    }

    Write-Step 'node --test scripts/release-version.test.mjs'
    Invoke-Native 'node' @('--test', 'scripts/release-version.test.mjs')
}

function Invoke-MigrateTwice {
    param(
        [string]$Dialect,
        [string]$Dsn
    )
    Write-Step "cmd/migrate $Dialect (first run)"
    Invoke-Go @('run', './cmd/migrate', '-driver', $Dialect, '-dsn', $Dsn)
    Write-Step "cmd/migrate $Dialect (second run, must be idempotent)"
    Invoke-Go @('run', './cmd/migrate', '-driver', $Dialect, '-dsn', $Dsn)
}

function Invoke-MigrationsTask {
    Write-Step 'reviewed migration pairs and SQL up/down round trip'
    # SQLite always runs; MySQL/PostgreSQL run when their DSNs are exported.
    Invoke-Go @('test', '-v', '-count=1', './internal/tests/migrations/...')

    $tmp = Join-Path $root '.tmp\verify'
    New-Item -ItemType Directory -Force -Path $tmp | Out-Null
    $sqliteDb = Join-Path $tmp 'migrate.db'
    foreach ($suffix in @('', '-wal', '-shm')) {
        Remove-Item -LiteralPath ($sqliteDb + $suffix) -Force -ErrorAction SilentlyContinue
    }

    $sqliteDsn = $env:PP_MIGRATE_SQLITE_DSN
    if (-not $sqliteDsn) {
        $sqlitePath = $sqliteDb -replace '\\', '/'
        $sqliteDsn = 'file:' + $sqlitePath + '?_pragma=foreign_keys(1)&_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)'
    }
    Invoke-MigrateTwice 'sqlite' $sqliteDsn

    $mysqlDsn = $env:PP_MIGRATE_MYSQL_DSN
    if (-not $mysqlDsn) { $mysqlDsn = $env:PP_TEST_MYSQL_DSN }
    if ($mysqlDsn) {
        Invoke-MigrateTwice 'mysql' $mysqlDsn
    }
    else {
        Write-Step 'MYSQL: no PP_MIGRATE_MYSQL_DSN / PP_TEST_MYSQL_DSN, schema apply skipped'
    }

    $postgresDsn = $env:PP_MIGRATE_POSTGRES_DSN
    if (-not $postgresDsn) { $postgresDsn = $env:PP_TEST_POSTGRES_DSN }
    if ($postgresDsn) {
        Invoke-MigrateTwice 'postgres' $postgresDsn
    }
    else {
        Write-Step 'POSTGRES: no PP_MIGRATE_POSTGRES_DSN / PP_TEST_POSTGRES_DSN, schema apply skipped'
    }
}

function Invoke-ConfigTask {
    Write-Step 'migration pairs, workflows, Compose files and scripts'
    Invoke-Go @('test', '-v', '-count=1', './internal/tests/ci/...')

    $docker = Get-Command docker -ErrorAction SilentlyContinue
    if (-not $docker) {
        Write-Step 'docker not available: compose config skipped'
        Write-Step '(workflow/Compose YAML and script checks above are Docker-independent)'
        return
    }

    & docker compose version *> $null
    if ($LASTEXITCODE -ne 0) {
        Write-Step 'docker compose plugin not available: compose config skipped'
        Write-Step '(workflow/Compose YAML and script checks above are Docker-independent)'
        return
    }

    Write-Step 'docker compose config (single compose file)'
    Invoke-Native 'docker' @('compose', '-f', 'docker-compose.yml', 'config', '-q')
}

if ($Task -in @('go', 'all')) { Invoke-GoTask }
if ($Task -in @('web', 'all')) { Invoke-WebTask }
if ($Task -in @('migrations', 'all')) { Invoke-MigrationsTask }
if ($Task -in @('config', 'all')) { Invoke-ConfigTask }

Write-Host ""
Write-Host "verify: $Task passed"
