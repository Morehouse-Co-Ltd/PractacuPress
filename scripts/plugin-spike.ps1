# pp 插件 spike 验证入口。
#
# 覆盖：
#   1. Go 插件宿主：清单/生命周期/WASM 钩子/路由/超时/资产/契约
#   2. 路由接入：可选 Plugins 依赖，nil 时基础契约不变
#   3. 前端：typecheck + 插件运行时/区块注册表测试
#
# 用法：./scripts/plugin-spike.ps1

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
    Write-Host '== Go plugin host tests =='
    go test ./apps/api/internal/plugins/... -count=1
    if ($LASTEXITCODE -ne 0) { throw 'plugin host tests failed' }

    Write-Host '== Router integration + contract tests =='
    go test ./apps/api/internal/transport/http/gin/ -count=1
    if ($LASTEXITCODE -ne 0) { throw 'router tests failed' }

    Write-Host '== Web typecheck =='
    Push-Location 'apps/web'
    try {
        node node_modules/typescript/bin/tsc --noEmit
        if ($LASTEXITCODE -ne 0) { throw 'web typecheck failed' }

        Write-Host '== Web plugin runtime tests =='
        node node_modules/vitest/vitest.mjs run src/lib/plugins
        if ($LASTEXITCODE -ne 0) { throw 'web plugin tests failed' }
    }
    finally {
        Pop-Location
    }
}
finally {
    Pop-Location
}

Write-Host 'plugin spike: all checks passed'
exit 0
