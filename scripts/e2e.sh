#!/usr/bin/env bash
# Runs the browser E2E smoke suite against a throwaway full stack.
#
#   bash scripts/e2e.sh
#   PP_E2E_SKIP_WEB_BUILD=1 bash scripts/e2e.sh
#
# Requires: Go 1.26+, Node.js 22+, the Rust security service built
# (cargo build --release in services/security) and Google Chrome or Chromium.
# The harness starts the API, security service and static web server itself.
#
# Output: .tmp/e2e/artifacts (HTML/JSON report, screenshots, failed traces)
#         .tmp/e2e/logs (API, security and web server logs)
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

if ! command -v node >/dev/null 2>&1; then
  echo "node was not found; install Node.js 22 or newer" >&2
  exit 1
fi

set +e
node apps/web/e2e/harness.mjs
code=$?
set -e

if [[ $code -ne 0 ]]; then
  printf '\nbrowser E2E failed with exit code %s\n' "$code"
  printf '  report     : .tmp/e2e/artifacts/html/index.html\n'
  printf '  screenshots: .tmp/e2e/artifacts/screens\n'
  printf '  traces     : .tmp/e2e/artifacts/test-results\n'
  printf '  logs       : .tmp/e2e/logs\n'
fi
exit "$code"
