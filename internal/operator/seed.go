package operator

import (
	"context"
	"flag"
	"fmt"
	"os"
	"time"

	"entgo.io/ent/dialect/sql/schema"

	entgen "github.com/practacu/practacu-press/internal/ent"
	entsite "github.com/practacu/practacu-press/internal/ent/site"
	"github.com/practacu/practacu-press/internal/infrastructure/db"
)

const seedTimeout = 30 * time.Second

// Seed creates the default site and prints its id.
//
// It is idempotent: running it twice returns the same site id and creates nothing
// new, which is what lets the Windows initialisation flow be retried safely.
func Seed(args []string) error {
	flags := flag.NewFlagSet("seed", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	slug := flags.String("slug", "main", "site slug")
	name := flags.String("name", "Practacu Press", "site display name")
	driver := flags.String("driver", os.Getenv("DATABASE_DRIVER"), "database driver")
	dsn := flags.String("dsn", os.Getenv("DATABASE_DSN"), "database connection string")
	if err := flags.Parse(args); err != nil {
		return err
	}

	ctx, cancel := context.WithTimeout(context.Background(), seedTimeout)
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

	existing, err := handle.Client.Site.Query().Where(entsite.SlugEQ(*slug)).Only(ctx)
	switch {
	case err == nil:
		fmt.Fprintf(os.Stdout, "%s\n", existing.ID)
		return nil
	case !entgen.IsNotFound(err):
		return err
	}

	created, err := handle.Client.Site.Create().
		SetSlug(*slug).
		SetName(*name).
		Save(ctx)
	if err != nil {
		return err
	}

	fmt.Fprintf(os.Stdout, "%s\n", created.ID)
	return nil
}
