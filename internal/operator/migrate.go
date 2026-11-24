// Package operator holds the maintenance commands that the server binary runs
// in-process: migrate, seed, backup, media-gc and searchindex.
//
// All of them read the same DATABASE_* / STORAGE_* environment as the API, so a
// deployment configures one binary once instead of shipping extra executables.
// The commands stay usable on their own (`go run ./cmd/migrate`) through thin
// wrappers for development.
package operator

import (
	"context"
	"flag"
	"fmt"
	"os"
	"time"

	"entgo.io/ent/dialect/sql/schema"

	"github.com/practacu/practacu-press/internal/infrastructure/db"
)

const migrateTimeout = 2 * time.Minute

// Migrate applies the persistence schema to the configured database.
//
// It is additive on purpose: dropping columns or indexes is refused, so a mistyped
// deployment cannot silently destroy data. Production change sets are generated
// and reviewed instead of applied by this command (see internal/migrations/README.md).
func Migrate(args []string) error {
	flags := flag.NewFlagSet("migrate", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	driver := flags.String("driver", os.Getenv("DATABASE_DRIVER"), "database driver: sqlite, mysql, postgres")
	dsn := flags.String("dsn", os.Getenv("DATABASE_DSN"), "database connection string")
	if err := flags.Parse(args); err != nil {
		return err
	}

	ctx, cancel := context.WithTimeout(context.Background(), migrateTimeout)
	defer cancel()

	handle, err := db.Open(ctx, *driver, *dsn)
	if err != nil {
		return err
	}
	defer handle.Close()

	if err := handle.Client.Schema.Create(ctx,
		schema.WithDropColumn(false),
		schema.WithDropIndex(false),
	); err != nil {
		return fmt.Errorf("apply schema: %w", err)
	}

	fmt.Fprintf(os.Stdout, "migrate: schema applied (driver=%s)\n", handle.Driver())
	return nil
}
