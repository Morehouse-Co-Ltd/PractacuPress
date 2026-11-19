# Runs the browser E2E smoke suite against a throwaway full stack.
#
#   powershell -ExecutionPolicy Bypass -File scripts\e2e.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\e2e.ps1 -SkipWebBuild
#
# The script delegates to web/e2e/harness.mjs, which builds the Go API, creates a
# fresh SQLite database under .tmp/e2e/data, builds the web app, serves it with a
# same-origin /api proxy, and runs Playwright headless with Chromium/Chrome.
#
# Security checks are compiled into the API; there is no sidecar to start.
#
# Output: .tmp/e2e/artifacts (HTML/JSON report, screenshots, failed traces),
#         .tmp/e2e/logs (API and web server logs).

param(
    [switch]$SkipWebBuild,
    [int]$ApiPort = 0,
    [int]$WebPort = 0
)

$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)

$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCommand) { throw 'node was not found; install Node.js 22 or newer' }

if ($SkipWebBuild) { $env:PP_E2E_SKIP_WEB_BUILD = '1' }
if ($ApiPort -gt 0) { $env:PP_E2E_API_PORT = [string]$ApiPort }
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
