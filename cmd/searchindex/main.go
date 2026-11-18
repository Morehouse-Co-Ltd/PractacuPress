// Command searchindex reports and rebuilds the full text search index.
//
// content_search is derived data, never the source of truth: the API writes it
// after a content row commits, and this command is the repair and backfill path.
// Run it once after applying the reviewed 20261115000000_content_search change
// set (older items have no index row yet), and again any time the index is
// suspected of drifting, for example after an interrupted deployment or a
// restored content table.
//
// The default mode only reports. It never writes, so it is safe on production:
//
//	go run ./cmd/searchindex            # report only
//	go run ./cmd/searchindex -rebuild   # truncate and re-derive
//
// A rebuild is idempotent and bounded: it reads content_items in batches of 200
// and re-indexes both published and unpublished rows (an unpublished row is
// indexed too so a later publish needs no reindex, and the search query itself
// filters on status). Search never consults a stale index silently: if the index
// cannot be created or a write fails, the process answers from the portable LIKE
// fallback and reports degraded, and this command is how the operator fixes it.
//
// It reads the same DATABASE_DRIVER / DATABASE_DSN environment as the API.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"time"

	"github.com/practacu/practacu-press/internal/infrastructure/contentstore"
	"github.com/practacu/practacu-press/internal/infrastructure/db"
	"github.com/practacu/practacu-press/internal/platform/config"
)

const defaultTimeout = 30 * time.Minute

func main() {
	var (
		rebuild = flag.Bool("rebuild", false, "truncate the index and re-derive every content row")
		driver  = flag.String("driver", envOr("DATABASE_DRIVER", config.DriverSQLite),
			"database driver: sqlite, mysql or postgres")
		dsn     = flag.String("dsn", os.Getenv("DATABASE_DSN"), "database connection string")
		timeout = flag.Duration("timeout", defaultTimeout, "overall command timeout")
	)
	flag.Parse()

	if err := run(*driver, *dsn, *rebuild, *timeout); err != nil {
		fmt.Fprintf(os.Stderr, "searchindex failed: %v\n", err)
		os.Exit(1)
	}
}

func run(driver, dsn string, rebuild bool, timeout time.Duration) error {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	handle, err := db.Open(ctx, driver, dsn)
	if err != nil {
		return err
	}
	defer handle.Close()

	store := contentstore.New(handle.Client, handle)

	var status contentstore.SearchIndexStatus
	if rebuild {
		status, err = store.RebuildSearchIndex(ctx)
		if err != nil {
			return fmt.Errorf("rebuild index: %w", err)
		}
	} else {
		if err := store.EnsureSearchIndex(ctx); err != nil {
			return fmt.Errorf("create index: %w", err)
		}
		status, err = store.SearchIndexStatus(ctx)
		if err != nil {
			return fmt.Errorf("inspect index: %w", err)
		}
	}

	raw, err := json.MarshalIndent(report{
		Action:    actionOf(rebuild),
		Dialect:   status.Dialect,
		Available: status.Available,
		Indexed:   status.Indexed,
		Published: status.Published,
		Missing:   status.Missing,
		LastError: status.LastError,
	}, "", "  ")
	if err != nil {
		return err
	}
	fmt.Fprintln(os.Stdout, string(raw))

	// A missing row means search silently omits real content, so it is a failure
	// for both modes: the report is actionable only if the drift stays visible to
	// a deploy script.
	if status.Missing > 0 {
		return fmt.Errorf("%d published item(s) are missing from the index; run with -rebuild", status.Missing)
	}
	return nil
}

type report struct {
	Action    string `json:"action"`
	Dialect   string `json:"dialect"`
	Available bool   `json:"available"`
	Indexed   int    `json:"indexed"`
	Published int    `json:"published"`
	Missing   int    `json:"missing"`
	LastError string `json:"last_error,omitempty"`
}

func actionOf(rebuild bool) string {
	if rebuild {
		return "rebuild"
	}
	return "report"
}

func envOr(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}
