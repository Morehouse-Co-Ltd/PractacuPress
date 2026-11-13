#!/usr/bin/env bash
# Reproducible verification tasks shared by CI and developer machines.
#
#   bash scripts/ci/verify.sh all
#   bash scripts/ci/verify.sh go
#   bash scripts/ci/verify.sh web
#   bash scripts/ci/verify.sh migrations
#   bash scripts/ci/verify.sh config
#
# Optional environment:
#   PP_TEST_RACE=1              run `go test -race` (Linux CI enables this)
#   PP_WEB_INSTALL=ci|auto|skip  npm install strategy (auto = only when missing)
#   PP_TEST_MYSQL_DSN=...       disposable MySQL for the up/down round trip
#   PP_TEST_POSTGRES_DSN=...    disposable PostgreSQL for the up/down round trip
#   PP_MIGRATE_SQLITE_DSN=...   override the temporary SQLite file
#   PP_MIGRATE_MYSQL_DSN=...    disposable MySQL for `cmd/migrate` idempotency
#   PP_MIGRATE_POSTGRES_DSN=... disposable PostgreSQL for `cmd/migrate` idempotency
set -euo pipefail

task="${1:-all}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"

go_bin="${GO:-go}"
npm_bin="${NPM:-npm}"

log() { printf '\n==> %s\n' "$*"; }

run_go() {
  log "go build ./..."
  "$go_bin" build ./...

  log "go vet ./..."
  "$go_bin" vet ./...

  local test_args=(test)
  if [[ "${PP_TEST_RACE:-0}" == "1" ]]; then
    test_args+=(-race)
  fi
  test_args+=(-count=1)
  test_args+=(./...)
  log "go ${test_args[*]}"
  "$go_bin" "${test_args[@]}"
}

run_web() {
  local install_mode="${PP_WEB_INSTALL:-auto}"
  (
    cd apps/web
    if [[ "$install_mode" == "ci" || ( "$install_mode" == "auto" && ! -d node_modules ) ]]; then
      log "npm ci (apps/web)"
      "$npm_bin" ci --no-audit --no-fund
    elif [[ "$install_mode" == "skip" ]]; then
      log "npm install skipped by PP_WEB_INSTALL=skip"
    else
      log "using existing apps/web/node_modules"
    fi

    log "npm run typecheck"
    "$npm_bin" run typecheck

    log "npm run build"
    "$npm_bin" run build

    log "npm test (vitest)"
    "$npm_bin" test
  )
}

run_migrate_twice() {
  local dialect="$1" dsn="$2"
  log "cmd/migrate $dialect (first run)"
  "$go_bin" run ./apps/api/cmd/migrate -driver "$dialect" -dsn "$dsn"
  log "cmd/migrate $dialect (second run, must be idempotent)"
  "$go_bin" run ./apps/api/cmd/migrate -driver "$dialect" -dsn "$dsn"
}

run_migrations() {
  log "reviewed migration pairs and SQL up/down round trip"
  # SQLite always runs; MySQL/PostgreSQL run when their DSNs are exported.
  "$go_bin" test -v -count=1 ./tests/migrations/...

  local tmp="${PP_VERIFY_TMP_DIR:-.tmp/verify}"
  mkdir -p "$tmp"
  local sqlite_db="$tmp/migrate.db"
  rm -f "$sqlite_db" "$sqlite_db-wal" "$sqlite_db-shm"
  local sqlite_path="$sqlite_db"
  if [[ "$sqlite_path" != /* ]]; then
    sqlite_path="./$sqlite_path"
  fi
  local sqlite_dsn="${PP_MIGRATE_SQLITE_DSN:-file:$sqlite_path?_pragma=foreign_keys(1)&_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)}"
  run_migrate_twice sqlite "$sqlite_dsn"

  local mysql_dsn="${PP_MIGRATE_MYSQL_DSN:-${PP_TEST_MYSQL_DSN:-}}"
  if [[ -n "$mysql_dsn" ]]; then
    run_migrate_twice mysql "$mysql_dsn"
  else
    log "MYSQL: no PP_MIGRATE_MYSQL_DSN / PP_TEST_MYSQL_DSN, schema apply skipped"
  fi

  local postgres_dsn="${PP_MIGRATE_POSTGRES_DSN:-${PP_TEST_POSTGRES_DSN:-}}"
  if [[ -n "$postgres_dsn" ]]; then
    run_migrate_twice postgres "$postgres_dsn"
  else
    log "POSTGRES: no PP_MIGRATE_POSTGRES_DSN / PP_TEST_POSTGRES_DSN, schema apply skipped"
  fi
}

run_config() {
  log "migration pairs, workflows, Compose files and scripts"
  "$go_bin" test -v -count=1 ./tests/ci/...

  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    log "docker compose config (default profile)"
    docker compose -f docker-compose.yml config -q

    log "docker compose config (production overlay)"
    # The production overlay requires a persistent key; any non-empty value is
    # enough to validate the merged configuration.
    AUTH_JWT_ED25519_PRIVATE_KEY=ci-placeholder \
      docker compose -f docker-compose.yml -f docker-compose.prod.yml config -q
  else
    log "docker not available: compose config skipped"
    log "(workflow/Compose YAML and script checks above are Docker-independent)"
  fi
}

case "$task" in
  go) run_go ;;
  web) run_web ;;
  migrations) run_migrations ;;
  config) run_config ;;
  all)
    run_go
    run_web
    run_migrations
    run_config
    ;;
  *)
    echo "unknown task: $task (want go|web|migrations|config|all)" >&2
    exit 2
    ;;
esac

log "verify: $task passed"
