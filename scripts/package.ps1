# Practacu Press · 一键打包（Windows x64 便携包）
#
# 双击仓库根目录的 打包.bat，或者在这里直接运行：
#   powershell -ExecutionPolicy Bypass -File scripts\package.ps1
#
# 这个脚本只做两件事：检查工具链，然后把工作交给 scripts/package-windows.mjs。
# 真正的构建、自检、压缩都在 Node 脚本里，方便 CI 复用同一套流程。
#
# 参数：
#   -SkipSecurity   不编译也不附带 Rust 安全服务（发布与上传会 fail-closed）
#   -SkipSmoke      跳过打包后的自检
#   -NoZip          只生成 release\PractacuPress 目录
#   -ReleaseDir     输出目录，默认 <仓库>\release
#   -Port           自检使用的固定端口，默认自动挑选空闲端口

[CmdletBinding()]
param(
    [switch]$SkipSecurity,
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
    Write-Host "[错误] $Text" -ForegroundColor Red
    exit 1
}

Write-Host 'Practacu Press · 一键打包' -ForegroundColor Green
Write-Host "仓库：$repo"

Write-Step '检查工具链'
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Stop-WithError '没有找到 Node.js。请安装 Node.js 22 或更高版本：https://nodejs.org'
}
$nodeVersion = (& node --version).Trim().TrimStart('v')
$nodeParts = $nodeVersion.Split('.')
$nodeMajor = 0
$nodeMinor = 0
[void][int]::TryParse($nodeParts[0], [ref]$nodeMajor)
if ($nodeParts.Count -gt 1) { [void][int]::TryParse($nodeParts[1], [ref]$nodeMinor) }
if ($nodeMajor -lt 22 -or ($nodeMajor -eq 22 -and $nodeMinor -lt 12)) {
    Stop-WithError "Node.js 版本过低（$nodeVersion），前端构建需要 22.12 或更高版本。"
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
    Stop-WithError '没有找到 Go。请安装 Go 1.26 或更高版本：https://go.dev/dl/'
}
Write-Host "  Go      $(& $go version)"

if (-not $SkipSecurity) {
    $rustup = Get-Command rustup -ErrorAction SilentlyContinue
    $cargo = Get-Command cargo -ErrorAction SilentlyContinue
    if (-not $rustup -and -not $cargo) {
        Stop-WithError '没有找到 Rust 工具链。请安装 Rust：https://rustup.rs（安装后重开窗口），或者加 -SkipSecurity 跳过安全服务。'
    }
    Write-Host '  Rust    已找到（打包时自动编译 release 版本）'
}
else {
    Write-Host '  Rust    跳过（-SkipSecurity：不编译也不附带安全服务）'
}

$nodeArgs = @('scripts/package-windows.mjs')
if ($SkipSecurity) { $nodeArgs += '--skip-security' }
if ($SkipSmoke) { $nodeArgs += '--skip-smoke' }
if ($NoZip) { $nodeArgs += '--no-zip' }
if ($ReleaseDir) { $nodeArgs += @('--release-dir', $ReleaseDir) }
if ($Port -gt 0) { $nodeArgs += @('--port', [string]$Port) }

Write-Step '开始打包（首次编译 Rust 需要几分钟）'
$started = Get-Date
& node @nodeArgs
$code = $LASTEXITCODE
$elapsed = (Get-Date) - $started

if ($code -ne 0) {
    Write-Host ''
    Write-Host "[失败] 打包没有完成（退出码 $code），耗时 $([int]$elapsed.TotalSeconds) 秒。" -ForegroundColor Red
    Write-Host '       上面的日志里通常能找到原因；加 -SkipSecurity 可以先跳过 Rust 试试。' -ForegroundColor Yellow
    exit $code
}

Write-Host ''
Write-Host "[完成] 打包成功，耗时 $([int]$elapsed.TotalSeconds) 秒。" -ForegroundColor Green
Write-Host '       分发目录：release\PractacuPress'
Write-Host '       分发压缩包：release\PractacuPress-Windows-x64.zip'
Write-Host '       解压后双击 PractacuPress.exe 即可运行。'
exit 0
