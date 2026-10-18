// Package db turns a driver name and DSN into an Ent client.
//
// It is deliberately the only package that knows which Go drivers exist, so no
// repository or service ever branches on the database. SQLite uses the pure Go
// modernc driver: the default mattn driver needs cgo, and the deployment targets
// build with CGO_ENABLED=0 (review P0-3).
package db

import (
	"entgo.io/ent/dialect"

	"github.com/practacu/practacu-press/apps/api/internal/platform/config"

	// database/sql drivers, registered by side effect.
	_ "github.com/go-sql-driver/mysql"
	_ "github.com/jackc/pgx/v5/stdlib"
	_ "modernc.org/sqlite"
)

// SQL driver names registered with database/sql.
const (
	sqlDriverSQLite   = "sqlite"
	sqlDriverMySQL    = "mysql"
	sqlDriverPostgres = "pgx"
)

// NormalizeDriver maps a driver alias to its canonical name.
//
// It delegates to config so the accepted vocabulary has exactly one owner.
func NormalizeDriver(name string) (string, bool) { return config.NormalizeDriver(name) }

// IsSupportedDriver reports whether name resolves to a supported dialect.
func IsSupportedDriver(name string) bool {
	_, ok := NormalizeDriver(name)
	return ok
}

// DialectOf returns the Ent dialect for a driver name.
func DialectOf(name string) (string, bool) {
	canonical, ok := NormalizeDriver(name)
	if !ok {
		return "", false
	}
	return dialectOfCanonical(canonical), true
}

func dialectOfCanonical(canonical string) string {
	switch canonical {
	case config.DriverMySQL:
		return dialect.MySQL
	case config.DriverPostgres:
		return dialect.Postgres
	default:
		return dialect.SQLite
	}
}

func sqlDriverOf(canonical string) string {
	switch canonical {
	case config.DriverMySQL:
		return sqlDriverMySQL
	case config.DriverPostgres:
		return sqlDriverPostgres
	default:
		return sqlDriverSQLite
	}
}
