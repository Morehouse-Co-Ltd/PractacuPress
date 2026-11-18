# Regenerates the Ent persistence layer.
#
#   powershell -ExecutionPolicy Bypass -File scripts\gen.ps1
#
# Why generation happens in a temp module: on this machine a file that appears in
# the workspace can be memory-mapped by a file scanner almost immediately, and
# Windows refuses to open a mapped file for writing ("user-mapped section open").
# Ent rewrites ~75 files in under a second, so an in-place run fails on a random
# file every time. Generating in a scratch module outside the workspace and copying
# the finished tree in avoids the window entirely.
#
# The scratch module reuses the same module path so the generated import paths are
# identical to the real ones.

$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)

$repo = (Get-Location).Path
$go = 'C:\Program Files\Go\bin\go.exe'
if (-not (Test-Path $go)) { $go = 'go' }

$scratch = Join-Path $env:TEMP 'pp-entgen'
if (Test-Path $scratch) { Remove-Item $scratch -Recurse -Force }
New-Item -ItemType Directory -Force -Path (Join-Path $scratch 'ent') | Out-Null

Copy-Item (Join-Path $repo 'go.mod') $scratch -Force
Copy-Item (Join-Path $repo 'go.sum') $scratch -Force
Copy-Item (Join-Path $repo 'ent\schema') (Join-Path $scratch 'ent') -Recurse -Force
Copy-Item (Join-Path $repo 'ent\generate.go') (Join-Path $scratch 'ent') -Force

Push-Location $scratch
try {
    Write-Host '> ent generate (scratch module)'
    & $go generate ./ent/...
    if ($LASTEXITCODE -ne 0) { throw "ent generate failed with exit code $LASTEXITCODE" }
} finally {
    Pop-Location
}

# Copy the finished tree in, excluding the hand written schema package and the
# generator stub, which must stay exactly as they are.
$source = Join-Path $scratch 'ent'
$target = Join-Path $repo 'ent'

$copied = 0
Get-ChildItem $source -Recurse -File | ForEach-Object {
    $relative = $_.FullName.Substring($source.Length).TrimStart('\')
    if ($relative -like 'schema\*' -or $relative -eq 'generate.go' -or $relative -eq 'go.mod' -or $relative -eq 'go.sum') {
        return
    }
    $destination = Join-Path $target $relative
    $directory = Split-Path -Parent $destination
    if (-not (Test-Path $directory)) { New-Item -ItemType Directory -Force -Path $directory | Out-Null }
    Copy-Item $_.FullName $destination -Force
    $copied++
}

Write-Host "copied $copied generated files"

Write-Host '> go build ./...'
& $go build ./...
if ($LASTEXITCODE -ne 0) { throw "build failed with exit code $LASTEXITCODE" }

Write-Host 'ok: ent regenerated'
