# Package an extension directory into an importable zip.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\package-extension.ps1 -Dir internal\plugins\examples\hello-admin
#   powershell -ExecutionPolicy Bypass -File scripts\package-extension.ps1 -Dir internal\plugins\examples\hello -Out .tmp\hello.zip
#
# The directory must contain plugin.json at its root. When backend/ is declared,
# the script checks (or builds) the WASM entry before zipping.
# The default output is dist/extensions/<id>-<version>.zip, which can be uploaded
# from Admin -> Extensions -> Import.

param(
    [Parameter(Mandatory = $true)]
    [string]$Dir,
    [string]$Out = "",
    [switch]$SkipBackendBuild
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$source = Resolve-Path (Join-Path $root $Dir)
$manifestPath = Join-Path $source 'plugin.json'
if (-not (Test-Path $manifestPath)) {
    throw "plugin.json not found in $source"
}

$manifest = Get-Content $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $manifest.id -or -not $manifest.version) {
    throw "plugin.json must contain id and version"
}

# The frontend bundle is a plain file and must already exist in the directory.
if ($manifest.frontend) {
    $entry = Join-Path $source $manifest.frontend.entry
    if (-not (Test-Path $entry)) {
        throw "frontend.entry not found: $($manifest.frontend.entry)"
    }
    foreach ($style in @($manifest.frontend.styles)) {
        if ($style -and -not (Test-Path (Join-Path $source $style))) {
            throw "frontend.styles not found: $style"
        }
    }
}

# Backend WASM: accept a committed/prebuilt artifact; build it with Go when missing
# (the installer itself never builds or runs package managers).
if ($manifest.backend) {
    $backendEntry = Join-Path $source $manifest.backend.entry
    if (-not (Test-Path $backendEntry)) {
        if ($SkipBackendBuild) {
            throw "backend.entry not found: $($manifest.backend.entry) (and -SkipBackendBuild was passed)"
        }
        $backendDir = Join-Path $source 'backend'
        if (-not (Test-Path $backendDir)) {
            throw "backend directory not found: $backendDir"
        }
        Write-Host "> building backend WASM (GOOS=wasip1 GOARCH=wasm)"
        $go = @(
            'C:\Program Files\Go\bin\go.exe',
            (Join-Path $env:LOCALAPPDATA 'Programs\Go\bin\go.exe'),
            (Get-Command go -ErrorAction SilentlyContinue).Source
        ) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
        if (-not $go) { throw 'go was not found; install Go or pass -SkipBackendBuild with a prebuilt wasm' }
        $entryRelative = $manifest.backend.entry -replace '^backend[\\/]', ''
        $previousGoos = $env:GOOS
        $previousGoarch = $env:GOARCH
        try {
            $env:GOOS = 'wasip1'
            $env:GOARCH = 'wasm'
            Push-Location $backendDir
            try {
                & $go build -trimpath -ldflags='-s -w' -o (Join-Path $backendDir $entryRelative) .
                if ($LASTEXITCODE -ne 0) { throw "go build failed with exit code $LASTEXITCODE" }
            }
            finally { Pop-Location }
        }
        finally {
            $env:GOOS = $previousGoos
            $env:GOARCH = $previousGoarch
        }
        if (-not (Test-Path $backendEntry)) { throw "backend.entry still missing after build: $($manifest.backend.entry)" }
    }
}

if ([string]::IsNullOrWhiteSpace($Out)) {
    $Out = Join-Path $root ('dist\extensions\{0}-{1}.zip' -f $manifest.id, $manifest.version)
} elseif (-not [System.IO.Path]::IsPathRooted($Out)) {
    $Out = Join-Path $root $Out
}
$outDir = Split-Path -Parent $Out
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

# Zip paths must start at the package root (plugin.json at the zip root), so zip
# the directory contents rather than the directory itself. Build entries manually
# and always write "/" separators: Windows PowerShell's Compress-Archive and even
# .NET Framework's CreateFromDirectory store "\" for nested paths, which violates
# the zip spec. (The API normalises both, but a clean package is portable.)
if (Test-Path $Out) { Remove-Item $Out -Force }
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::Open($Out, [System.IO.Compression.ZipArchiveMode]::Create)
try {
    $prefixLength = $source.Path.Length
    Get-ChildItem -Path $source -Recurse -File | ForEach-Object {
        $entryName = $_.FullName.Substring($prefixLength).TrimStart('\', '/') -replace '\\', '/'
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
            $zip,
            $_.FullName,
            $entryName,
            [System.IO.Compression.CompressionLevel]::Optimal
        ) | Out-Null
    }
}
finally {
    $zip.Dispose()
}
$file = Get-Item $Out
Write-Host ("packaged {0} v{1} -> {2} ({3:N1} KiB)" -f $manifest.id, $manifest.version, $file.FullName, ($file.Length / 1KB))
