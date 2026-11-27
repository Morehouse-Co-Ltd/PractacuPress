package operator

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/practacu/practacu-press/internal/infrastructure/db"
	"github.com/practacu/practacu-press/internal/infrastructure/mediastore"
	"github.com/practacu/practacu-press/internal/media"
	"github.com/practacu/practacu-press/internal/platform/config"
)

const mediaGCTimeout = 10 * time.Minute

// MediaGC removes media objects that no database row references.
//
// It is the offline half of media cleanup. Deleting an asset removes its variants
// eagerly, but an interrupted delete, a rejected upload whose bytes should not be kept,
// or an abandoned upload session can still leave objects behind. This command scans the
// configured storage adapters, compares them with the asset and upload tables, and
// removes the difference.
//
// Run it in dry-run mode first (the default) and inspect the report. The command is
// idempotent: running it twice reports nothing to do the second time. It reads the same
// STORAGE_* environment as the API, so a deployment does not need a second
// configuration file.
//
//	practacu-press media-gc                 # dry run
//	practacu-press media-gc -dry-run=false
func MediaGC(args []string) error {
	flags := flag.NewFlagSet("media-gc", flag.ContinueOnError)
	flags.SetOutput(os.Stderr)
	dryRun := flags.Bool("dry-run", true, "report what would be deleted without deleting anything")
	driver := flags.String("driver", envOr("DATABASE_DRIVER", config.DriverSQLite),
		"database driver: sqlite, mysql or postgres")
	dsn := flags.String("dsn", os.Getenv("DATABASE_DSN"), "database connection string")
	storageDriver := flags.String("storage-driver", envOr("STORAGE_DRIVER", config.StorageDriverLocal),
		"global storage driver: local or s3")
	storageDir := flags.String("storage-dir", envOr("STORAGE_DIR", "./data/media"),
		"local storage root")
	s3Bucket := flags.String("s3-bucket", os.Getenv("STORAGE_S3_BUCKET"), "S3 bucket")
	s3Region := flags.String("s3-region", envOr("STORAGE_S3_REGION", "us-east-1"), "S3 region")
	s3Endpoint := flags.String("s3-endpoint", os.Getenv("STORAGE_S3_ENDPOINT"), "S3 compatible endpoint")
	s3AccessKey := flags.String("s3-access-key", os.Getenv("STORAGE_S3_ACCESS_KEY"), "S3 access key")
	s3SecretKey := flags.String("s3-secret-key", os.Getenv("STORAGE_S3_SECRET_KEY"), "S3 secret key")
	s3Prefix := flags.String("s3-prefix", os.Getenv("STORAGE_S3_PREFIX"), "S3 key prefix")
	rejectedRetention := flags.Duration("rejected-retention", media.DefaultRejectedRetention,
		"how long the bytes of a rejected asset are kept")
	uploadGrace := flags.Duration("upload-grace", media.DefaultUploadGrace,
		"extra time past an upload session's expiry before its object is collected")
	allowUnknownKeys := flags.Bool("allow-unknown-keys", false,
		"also delete objects whose key does not look like a media object (only for a dedicated store)")
	timeout := flags.Duration("timeout", mediaGCTimeout, "overall command timeout")
	if err := flags.Parse(args); err != nil {
		return err
	}

	options := storageOptions{
		driver:      strings.ToLower(strings.TrimSpace(*storageDriver)),
		localDir:    *storageDir,
		s3Bucket:    *s3Bucket,
		s3Region:    *s3Region,
		s3Endpoint:  *s3Endpoint,
		s3AccessKey: *s3AccessKey,
		s3SecretKey: *s3SecretKey,
		s3Prefix:    *s3Prefix,
	}

	ctx, cancel := context.WithTimeout(context.Background(), *timeout)
	defer cancel()

	handle, err := db.Open(ctx, *driver, *dsn)
	if err != nil {
		return fmt.Errorf("open database: %w", err)
	}
	defer handle.Close()

	global, overrides, err := buildStorage(ctx, options)
	if err != nil {
		return fmt.Errorf("open media storage: %w", err)
	}

	collector, err := media.NewCollector(media.CollectorConfig{
		Catalog:           mediastore.New(handle.Client),
		Storage:           global,
		Storages:          overrides,
		RejectedRetention: *rejectedRetention,
		UploadGrace:       *uploadGrace,
		AllowUnknownKeys:  *allowUnknownKeys,
	})
	if err != nil {
		return err
	}

	report, err := collector.Run(ctx, *dryRun)
	if err != nil {
		return err
	}

	encoded, err := json.MarshalIndent(report, "", "  ")
	if err != nil {
		return fmt.Errorf("encode report: %w", err)
	}
	fmt.Fprintln(os.Stdout, string(encoded))

	if len(report.Errors) > 0 {
		return fmt.Errorf("%d object(s) could not be processed", len(report.Errors))
	}
	return nil
}

// storageOptions carries the global adapter settings. Per purpose overrides are read
// from STORAGE_<SCOPE>_* exactly like the API does, so one environment configures both.
type storageOptions struct {
	driver      string
	localDir    string
	s3Bucket    string
	s3Region    string
	s3Endpoint  string
	s3AccessKey string
	s3SecretKey string
	s3Prefix    string
}

// buildStorage mirrors the API's adapter selection, including per purpose overrides.
func buildStorage(
	ctx context.Context,
	options storageOptions,
) (media.Storage, map[media.Purpose]media.Storage, error) {
	global, err := buildAdapter(ctx, options, options.driver, options.localDir,
		options.s3Bucket, options.s3Prefix)
	if err != nil {
		return nil, nil, err
	}

	overrides := make(map[media.Purpose]media.Storage)
	for _, scope := range config.StorageScopeNames() {
		prefix := "STORAGE_" + strings.ToUpper(scope) + "_"
		driver := strings.ToLower(strings.TrimSpace(os.Getenv(prefix + "DRIVER")))
		if driver == "" || driver == config.StorageDriverInherit {
			continue
		}

		localDir := os.Getenv(prefix + "LOCAL_DIR")
		if driver == config.StorageDriverLocal && localDir == "" {
			localDir = filepath.Join(options.localDir, scope)
		}
		bucket := os.Getenv(prefix + "S3_BUCKET")
		keyPrefix := os.Getenv(prefix + "S3_PREFIX")
		if driver == config.StorageDriverS3 && keyPrefix == "" {
			keyPrefix = joinPrefix(options.s3Prefix, scope)
		}

		store, buildErr := buildAdapter(ctx, options, driver, localDir, bucket, keyPrefix)
		if buildErr != nil {
			return nil, nil, fmt.Errorf("%s storage: %w", scope, buildErr)
		}
		overrides[media.Purpose(scope)] = store
	}

	return global, overrides, nil
}

func buildAdapter(
	ctx context.Context,
	options storageOptions,
	driver, localDir, bucket, prefix string,
) (media.Storage, error) {
	switch driver {
	case config.StorageDriverS3:
		if strings.TrimSpace(bucket) == "" {
			return nil, fmt.Errorf("S3 bucket is required when the storage driver is s3")
		}
		return media.NewS3Storage(ctx, media.S3Config{
			Bucket:    bucket,
			Region:    options.s3Region,
			Endpoint:  options.s3Endpoint,
			AccessKey: options.s3AccessKey,
			SecretKey: options.s3SecretKey,
			Prefix:    prefix,
		})
	case config.StorageDriverLocal:
		return media.NewLocalStorage(localDir)
	default:
		return nil, fmt.Errorf("unsupported storage driver %q", driver)
	}
}

func joinPrefix(base, scope string) string {
	base = strings.Trim(base, "/")
	if base == "" {
		return scope
	}
	return base + "/" + scope
}
