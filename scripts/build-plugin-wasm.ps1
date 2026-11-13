# 构建一个 pp 服务端插件：Go 源码 -> wasip1 WASM。
#
# 用法：
#   ./scripts/build-plugin-wasm.ps1 -PluginDir apps/api/internal/plugins/testdata/hello
#   ./scripts/build-plugin-wasm.ps1 -PluginDir <dir> -Output custom.wasm
#
# 安装器不会执行构建；发布时必须带上构建产物和哈希/签名。

param(
    [Parameter(Mandatory = $true)]
    [string]$PluginDir,
    [string]$Output = ""
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$resolved = Resolve-Path (Join-Path $root $PluginDir)
$backend = Join-Path $resolved 'backend'
if (-not (Test-Path $backend)) {
    throw "backend directory not found: $backend"
}

if ([string]::IsNullOrWhiteSpace($Output)) {
    $Output = 'hello.wasm'
}
$target = Join-Path $backend $Output

$previousGoos = $env:GOOS
$previousGoarch = $env:GOARCH
try {
    $env:GOOS = 'wasip1'
    $env:GOARCH = 'wasm'
    Push-Location $backend
    try {
        go build -trimpath -ldflags="-s -w" -o $target .
        if ($LASTEXITCODE -ne 0) {
            throw "go build failed with exit code $LASTEXITCODE"
        }
    }
    finally {
        Pop-Location
    }
}
finally {
    $env:GOOS = $previousGoos
    $env:GOARCH = $previousGoarch
}

$file = Get-Item $target
Write-Host ("built {0} ({1:N1} MiB)" -f $file.FullName, ($file.Length / 1MB))
