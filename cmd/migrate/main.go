// Command migrate applies the persistence schema to the configured database.
//
// It is additive on purpose: dropping columns or indexes is refused, so a mistyped
// deployment cannot silently destroy data. Production change sets are generated
// and reviewed instead of applied by this command (see migrations/README.md).
package main

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

func main() {
	driver := flag.String("driver", os.Getenv("DATABASE_DRIVER"), "database driver: sqlite, mysql, postgres")
	dsn := flag.String("dsn", os.Getenv("DATABASE_DSN"), "database connection string")
	flag.Parse()

	if err := run(*driver, *dsn); err != nil {
		fmt.Fprintf(os.Stderr, "migrate failed: %v\n", err)
		os.Exit(1)
	}
}

func run(driver, dsn string) error {
	ctx, cancel := context.WithTimeout(context.Background(), migrateTimeout)
	defer cancel()

	handle, err := db.Open(ctx, driver, dsn)
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
