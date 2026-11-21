package db

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"entgo.io/ent/dialect/sql/schema"
	"modernc.org/sqlite"

	"github.com/practacu/practacu-press/internal/platform/config"
)

// sqliteRestorer is the online backup half of modernc.org/sqlite's connection.
// It is defined as an interface instead of importing the unexported connection
// type so the assertion below stays driver-internal and testable through the
// public database/sql API.
type sqliteRestorer interface {
	NewRestore(source string) (*sqlite.Backup, error)
}

// RestoreFrom overwrites the live SQLite database from sourcePath.
//
// The database file the process has open must not be renamed over: SQLite's
// backup API copies pages into the existing connection instead. That is what
// makes an in-process restore possible while the server keeps running. The
// caller must serialize restores against backup creation and normal writes.
func (d *DB) RestoreFrom(ctx context.Context, sourcePath string) error {
	if d.driver != config.DriverSQLite {
		return fmt.Errorf("%w: driver=%s", ErrRestoreUnsupported, d.driver)
	}
	sourcePath = strings.TrimSpace(sourcePath)
	if sourcePath == "" {
		return errors.New("db: restore source is required")
	}
	if max := d.sqlDB.Stats().MaxOpenConnections; max != 1 {
		return fmt.Errorf(
			"%w: online SQLite restore requires max_open_connections=1 (got %d)",
			ErrRestoreUnsupported, max,
		)
	}

	conn, err := d.sqlDB.Conn(ctx)
	if err != nil {
		return fmt.Errorf("db: acquire restore connection: %w", err)
	}
	defer conn.Close()

	if err := conn.Raw(func(driverConn any) error {
		restorer, ok := driverConn.(sqliteRestorer)
		if !ok {
			return fmt.Errorf("%w: driver connection does not expose NewRestore", ErrRestoreUnsupported)
		}
		backup, err := restorer.NewRestore(sourcePath)
		if err != nil {
			return fmt.Errorf("db: start online restore: %w", err)
		}
		finished := false
		defer func() {
			if !finished {
				_ = backup.Finish()
			}
		}()
		for {
			more, err := backup.Step(-1)
			if err != nil {
				return fmt.Errorf("db: copy restore pages: %w", err)
			}
			if !more {
				break
			}
		}
		if err := backup.Finish(); err != nil {
			return fmt.Errorf("db: finish online restore: %w", err)
		}
		finished = true
		return nil
	}); err != nil {
		return err
	}

	// The live connection is still ours here. Flush the write-ahead log before
	// handing it back so a later request cannot replay pages from the old file.
	var busy, logPages, checkpointed int
	if err := conn.QueryRowContext(ctx, "PRAGMA wal_checkpoint(TRUNCATE)").
		Scan(&busy, &logPages, &checkpointed); err != nil {
		return fmt.Errorf("db: checkpoint restored database: %w", err)
	}
	if busy != 0 {
		return fmt.Errorf("db: checkpoint restored database: %d readers are still active", busy)
	}

	var check string
	if err := conn.QueryRowContext(ctx, "PRAGMA quick_check").Scan(&check); err != nil {
		return fmt.Errorf("db: verify restored database: %w", err)
	}
	if check != "ok" {
		return fmt.Errorf("db: restored database failed quick_check: %s", check)
	}
	return nil
}

// EnsureSchema applies the additive Ent schema pass to the live database.
//
// It deliberately keeps columns and indexes: restore must repair an older
// package, not drop data that a newer binary does not know about yet.
func (d *DB) EnsureSchema(ctx context.Context) error {
	if d.Client == nil {
		return errors.New("db: ent client is not configured")
	}
	return d.Client.Schema.Create(ctx,
		schema.WithDropColumn(false),
		schema.WithDropIndex(false),
	)
}
