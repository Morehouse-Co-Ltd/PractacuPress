# Runs the browser E2E smoke suite against a throwaway full stack.
#
#   powershell -ExecutionPolicy Bypass -File scripts\e2e.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\e2e.ps1 -SkipWebBuild
#
# The script delegates to web/e2e/harness.mjs, which:
#   - builds the Go API and the Rust security service (binary must exist),
#   - creates a fresh SQLite database under .tmp/e2e/data,
#   - builds the web app and serves it with the same-origin /api proxy,
#   - runs Playwright headless with Chromium/Chrome.
#
# Output: .tmp/e2e/artifacts (HTML/JSON report, screenshots, failed traces),
#         .tmp/e2e/logs (API, security and web server logs).
#
# Optional switches map to the harness environment variables:
#   -SkipWebBuild   reuse web/dist (PP_E2E_SKIP_WEB_BUILD=1)
#   -SkipSecurity   do not start the Rust service (PP_E2E_SKIP_SECURITY=1)

param(
    [switch]$SkipWebBuild,
    [switch]$SkipSecurity,
    [int]$ApiPort = 0,
    [int]$SecurityPort = 0,
    [int]$WebPort = 0
)

$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)

$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCommand) { throw 'node was not found; install Node.js 22 or newer' }

if ($SkipWebBuild) { $env:PP_E2E_SKIP_WEB_BUILD = '1' }
if ($SkipSecurity) { $env:PP_E2E_SKIP_SECURITY = '1' }
if ($ApiPort -gt 0) { $env:PP_E2E_API_PORT = [string]$ApiPort }
if ($SecurityPort -gt 0) { $env:PP_E2E_SECURITY_PORT = [string]$SecurityPort }
if ($WebPort -gt 0) { $env:PP_E2E_WEB_PORT = [string]$WebPort }

& $nodeCommand.Source 'web\e2e\harness.mjs'
$code = $LASTEXITCODE
if ($code -ne 0) {
    Write-Host ''
    Write-Host "browser E2E failed with exit code $code"
    Write-Host '  report     : .tmp\e2e\artifacts\html\index.html'
    Write-Host '  screenshots: .tmp\e2e\artifacts\screens'
    Write-Host '  traces     : .tmp\e2e\artifacts\test-results'
    Write-Host '  logs       : .tmp\e2e\logs'
}
exit $code
