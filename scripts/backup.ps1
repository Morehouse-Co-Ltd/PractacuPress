# Practacu Press backup helper.
#
#   powershell -ExecutionPolicy Bypass -File scripts\backup.ps1 create
#   powershell -ExecutionPolicy Bypass -File scripts\backup.ps1 verify -Archive .\data\backups\backup-....zip
#   powershell -ExecutionPolicy Bypass -File scripts\backup.ps1 restore -Archive .\data\backups\backup-....zip -Confirm
#
# The command itself lives in apps/api/cmd/backup so the packaged server and the
# source checkout use exactly the same code. Database defaults come from the same
# DATABASE_DRIVER / DATABASE_DSN / STORAGE_DIR / BACKUP_DIR variables the API uses.

param(
    [Parameter(Position = 0)]
    [ValidateSet('create', 'verify', 'restore', 'help')]
    [string]$Command = 'help',

    [string]$Archive = '',
    [string]$Out = '',
    [string]$Database = '',
    [string]$Dsn = $env:DATABASE_DSN,
    [string]$Driver = $(if ($env:DATABASE_DRIVER) { $env:DATABASE_DRIVER } else { 'sqlite' }),
    [string]$MediaDir = $(if ($env:STORAGE_DIR) { $env:STORAGE_DIR } else { './data/media' }),
    [string]$BackupDir = $(if ($env:BACKUP_DIR) { $env:BACKUP_DIR } else { './data/backups' }),
    [switch]$Confirm,
    [switch]$SkipMedia,
    [string[]]$ScopeDir = @()
)

$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)

if ($Command -eq 'help') {
    Get-Content $PSCommandPath | Select-Object -First 12
    exit 0
}

$go = 'C:\Program Files\Go\bin\go.exe'
if (-not (Test-Path $go)) { $go = 'go' }

$arguments = @('run', './apps/api/cmd/backup', $Command, '--driver', $Driver)
# PowerShell drops empty array elements when splatting, so an empty --dsn would
# swallow the next flag as its value. Only pass values that exist.
if ($Dsn) { $arguments += @('--dsn', $Dsn) }
$arguments += @('--media-dir', $MediaDir, '--backup-dir', $BackupDir)

switch ($Command) {
    'create' {
        if ($Out) { $arguments += @('--out', $Out) }
    }
    'verify' {
        if (-not $Archive) { throw '-Archive is required for verify' }
        $arguments += @('--in', $Archive)
    }
    'restore' {
        if (-not $Archive) { throw '-Archive is required for restore' }
        $arguments += @('--in', $Archive)
        if ($Database) { $arguments += @('--db', $Database) }
        if ($Confirm) { $arguments += '--confirm' }
        if ($SkipMedia) { $arguments += '--skip-media' }
    }
}
foreach ($entry in $ScopeDir) {
    $arguments += @('--scope-dir', $entry)
}

& $go @arguments
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
