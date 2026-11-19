package backup

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/practacu/practacu-press/internal/content"
	"github.com/practacu/practacu-press/internal/infrastructure/db"
	"github.com/practacu/practacu-press/internal/media"
	"github.com/practacu/practacu-press/internal/platform/page"
	"github.com/practacu/practacu-press/internal/site"
	"github.com/practacu/practacu-press/internal/taxonomy"
)

// Snapshotter produces a consistent database copy. *db.DB implements it for
// SQLite; other drivers return ErrUnsupportedDriver.
type Snapshotter interface {
	Snapshot(ctx context.Context, destPath string) error
}

// DesignSnapshot is one site design document captured for a backup package.
type DesignSnapshot struct {
	SiteID    string
	Name      string
	Slug      string
	Domain    string
	Revision  int
	Document  []byte
	UpdatedAt time.Time
}

// DesignSource lists every site design. Backup includes them as readable JSON
// next to the database dump, so an operator can recover a single design even
// when restoring the whole database is not the goal.
type DesignSource interface {
	SnapshotDesigns(ctx context.Context) ([]DesignSnapshot, error)
}

// MediaRoot is one configured storage root. Driver is "local" or "s3". Only
// local roots are packaged; an S3 root is recorded as a warning because this
// build has no bucket listing capability.
type MediaRoot struct {
	Alias  string
	Driver string
	Dir    string
}

// SiteReader is the narrow site port used by export/import.
type SiteReader interface {
	Get(ctx context.Context, siteID, userID string) (site.Site, error)
	Customization(ctx context.Context, siteID string) (site.Customization, error)
}

// ContentStore is the narrow content port used by export/import.
type ContentStore interface {
	ListAfterFilter(
		ctx context.Context,
		actor content.Actor,
		kind content.Kind,
		limit int,
		after page.Cursor,
		narrow content.ListFilter,
	) ([]content.Content, string, error)
	CreateDraft(ctx context.Context, actor content.Actor, kind content.Kind, in content.DraftInput) (content.Content, error)
	UpdateDraft(ctx context.Context, actor content.Actor, contentID string, in content.DraftInput) (content.Content, error)
}

// TaxonomyReader lists a site's categories and tags.
type TaxonomyReader interface {
	List(ctx context.Context, siteID string) ([]taxonomy.Term, error)
}

// MediaStore is the narrow media port used by export/import.
type MediaStore interface {
	ListAssets(
		ctx context.Context,
		actor media.Actor,
		filter media.AssetFilter,
		limit int,
		after page.Cursor,
	) ([]media.Asset, string, error)
	OpenAsset(ctx context.Context, actor media.Actor, assetID string) (media.Asset, io.ReadCloser, error)
	CreateUpload(ctx context.Context, actor media.Actor, req media.UploadRequest) (media.Upload, error)
	StoreContent(ctx context.Context, actor media.Actor, uploadID string, body io.Reader, size int64) (media.Upload, error)
	CompleteUpload(ctx context.Context, actor media.Actor, uploadID string) (media.Asset, error)
	DeleteAsset(ctx context.Context, actor media.Actor, assetID string) error
}

// Config assembles a Service.
//
// The archiver dependencies (Snapshotter, Designs, MediaRoots) and the site
// transfer dependencies (Sites, Content, Taxonomy, Media) are separate: a CLI
// backup has no need for the HTTP content services, and a server may omit the
// snapshotter when the driver is not SQLite.
type Config struct {
	Driver      string
	DSN         string
	Snapshotter Snapshotter
	MediaRoots  []MediaRoot
	Designs     DesignSource
	BackupDir   string
	// SchemaVersion is the migration level this binary expects.
	SchemaVersion string
	// EncryptionKey enables at-rest encryption of whole-instance packages. It
	// must be a 32-byte AES-256 key; nil or empty keeps packages plaintext. The
	// key is never written into a package or its metadata.
	EncryptionKey []byte

	AppVersion string
	Now        func() time.Time

	Sites    SiteReader
	Content  ContentStore
	Taxonomy TaxonomyReader
	Media    MediaStore
}

// Service owns package creation, verification, restore and site transfer.
type Service struct {
	driver        string
	dsn           string
	snapshotter   Snapshotter
	mediaRoots    []MediaRoot
	designs       DesignSource
	backupDir     string
	schemaVersion string
	appVersion    string
	now           func() time.Time
	encryptionKey []byte

	sites    SiteReader
	content  ContentStore
	taxonomy TaxonomyReader
	media    MediaStore
}

// NewService validates and builds a Service.
func NewService(cfg Config) (*Service, error) {
	if strings.TrimSpace(cfg.BackupDir) == "" {
		return nil, fmt.Errorf("%w: backup directory is required", ErrInvalidInput)
	}
	if err := os.MkdirAll(cfg.BackupDir, 0o750); err != nil {
		return nil, fmt.Errorf("backup: prepare backup directory: %w", err)
	}
	if cfg.SchemaVersion == "" {
		cfg.SchemaVersion = "unknown"
	}
	if cfg.AppVersion == "" {
		cfg.AppVersion = BuildVersion()
	}
	if cfg.Now == nil {
		cfg.Now = func() time.Time { return time.Now().UTC() }
	}
	key, err := normalizeEncryptionKey(cfg.EncryptionKey)
	if err != nil {
		return nil, err
	}
	return &Service{
		driver:        cfg.Driver,
		dsn:           cfg.DSN,
		snapshotter:   cfg.Snapshotter,
		mediaRoots:    append([]MediaRoot(nil), cfg.MediaRoots...),
		designs:       cfg.Designs,
		backupDir:     cfg.BackupDir,
		schemaVersion: cfg.SchemaVersion,
		appVersion:    cfg.AppVersion,
		now:           cfg.Now,
		encryptionKey: key,
		sites:         cfg.Sites,
		content:       cfg.Content,
		taxonomy:      cfg.Taxonomy,
		media:         cfg.Media,
	}, nil
}

// normalizeEncryptionKey validates the configured key and copies it so a caller
// cannot mutate the service's key afterwards. An empty key disables encryption.
func normalizeEncryptionKey(key []byte) ([]byte, error) {
	if len(key) == 0 {
		return nil, nil
	}
	if len(key) != EncryptionKeySize {
		return nil, fmt.Errorf(
			"%w: AES-256-GCM requires a %d-byte key, got %d bytes",
			ErrEncryptionKeyInvalid, EncryptionKeySize, len(key),
		)
	}
	return append([]byte(nil), key...), nil
}

// BackupDir returns the directory packages are written to.
func (s *Service) BackupDir() string { return s.backupDir }

// requirePlatformAdmin guards deployment wide data.
func requirePlatformAdmin(actor Actor) error {
	if actor.Role != site.RolePlatformAdmin {
		return fmt.Errorf("%w: platform administrator required", ErrPermissionDenied)
	}
	return nil
}

// requireSiteAdmin guards a site's own export/import.
func requireSiteAdmin(actor Actor, siteID string) error {
	if actor.SiteID != siteID || !actor.Role.AtLeast(site.RoleSiteAdmin) {
		return fmt.Errorf("%w: site administrator required", ErrPermissionDenied)
	}
	return nil
}

// siteActor converts the transfer caller into a content actor.
func siteActor(actor Actor) content.Actor {
	return content.Actor{UserID: actor.UserID, SiteID: actor.SiteID, Role: actor.Role}
}

// mediaActor converts the transfer caller into a media actor.
func mediaActor(actor Actor) media.Actor {
	return media.Actor{UserID: actor.UserID, SiteID: actor.SiteID, Role: actor.Role}
}

// listAllContent reads every page of both kinds. An editor sees every status;
// the caller filters published-only where the export option says so.
func (s *Service) listAllContent(ctx context.Context, actor Actor) ([]content.Content, error) {
	if s.content == nil {
		return nil, fmt.Errorf("%w: content service is not configured", ErrInvalidInput)
	}
	all := make([]content.Content, 0, 32)
	for _, kind := range []content.Kind{content.KindArticle, content.KindPost} {
		cursor := page.Cursor{}
		for {
			items, next, err := s.content.ListAfterFilter(
				ctx, siteActor(actor), kind, 100, cursor, content.ListFilter{},
			)
			if err != nil {
				return nil, err
			}
			all = append(all, items...)
			if strings.TrimSpace(next) == "" {
				break
			}
			cursor, err = page.Decode(next)
			if err != nil {
				return nil, err
			}
		}
	}
	return all, nil
}

// databaseDesignSource reads every site and its saved design through the raw
// database handle. It deliberately does not use the generated Ent query: a
// backup must still work when the database predates the newest Ent column, and
// a generated query selects every column.
type databaseDesignSource struct {
	database *db.DB
}

// NewDBDesignSource adapts the open database to DesignSource.
func NewDBDesignSource(database *db.DB) DesignSource {
	return &databaseDesignSource{database: database}
}

// SnapshotDesigns implements DesignSource.
func (s *databaseDesignSource) SnapshotDesigns(ctx context.Context) ([]DesignSnapshot, error) {
	rows, err := s.database.DesignRows(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]DesignSnapshot, 0, len(rows))
	for _, row := range rows {
		out = append(out, DesignSnapshot{
			SiteID:    row.SiteID,
			Name:      row.Name,
			Slug:      row.Slug,
			Domain:    row.Domain,
			Revision:  row.Revision,
			Document:  row.Document,
			UpdatedAt: row.UpdatedAt,
		})
	}
	return out, nil
}

// Package extensions. Whole-instance backups switch to .ppbak when encrypted so
// an operator can tell an encrypted artifact from a plaintext zip at a glance;
// the decrypting readers rely on the magic, not the suffix.
const (
	plainPackageExtension     = ".zip"
	encryptedPackageExtension = ".ppbak"
)

// artifactPath maps an artifact id to its plaintext package path. It is kept for
// sidecars written before the file_name field was authoritative.
func (s *Service) artifactPath(id string) string {
	return filepath.Join(s.backupDir, id+plainPackageExtension)
}

// packagePath maps an artifact id to its package path for one encryption mode.
func (s *Service) packagePath(id string, encrypted bool) string {
	if encrypted {
		return filepath.Join(s.backupDir, id+encryptedPackageExtension)
	}
	return s.artifactPath(id)
}

// packageExists reports whether either package form for id is already on disk, so
// two backups in the same second never overwrite each other.
func (s *Service) packageExists(id string) bool {
	for _, encrypted := range []bool{false, true} {
		if _, err := os.Stat(s.packagePath(id, encrypted)); err == nil {
			return true
		}
	}
	return false
}

// storedPackagePath resolves the package path named by an artifact sidecar.
func (s *Service) storedPackagePath(id, fileName string) (string, error) {
	name := strings.TrimSpace(fileName)
	if name == "" {
		// Sidecars written before encryption have no file_name; fall back to the
		// two canonical names.
		for _, encrypted := range []bool{false, true} {
			path := s.packagePath(id, encrypted)
			if _, err := os.Stat(path); err == nil {
				return path, nil
			}
		}
		return s.artifactPath(id), nil
	}
	if name != filepath.Base(name) || name == "." || name == ".." {
		return "", ErrNotFound
	}
	return filepath.Join(s.backupDir, name), nil
}

// metaPath maps an artifact id to its metadata sidecar path.
func (s *Service) metaPath(id string) string {
	return filepath.Join(s.backupDir, id+".meta.json")
}

// readArtifact loads one stored artifact's metadata.
func (s *Service) readArtifact(id string) (Artifact, error) {
	if err := validateArtifactID(id); err != nil {
		return Artifact{}, err
	}
	raw, err := os.ReadFile(s.metaPath(id))
	if err != nil {
		if os.IsNotExist(err) {
			return Artifact{}, ErrNotFound
		}
		return Artifact{}, err
	}
	var artifact Artifact
	if err := decodeJSON(raw, &artifact); err != nil {
		return Artifact{}, fmt.Errorf("backup: read artifact metadata: %w", err)
	}
	path, err := s.storedPackagePath(id, artifact.FileName)
	if err != nil {
		return Artifact{}, err
	}
	info, err := os.Stat(path)
	if err != nil {
		if os.IsNotExist(err) {
			return Artifact{}, ErrNotFound
		}
		return Artifact{}, err
	}
	artifact.Path = path
	artifact.Size = info.Size()
	return artifact, nil
}

// validateArtifactID keeps path building limited to ids this package writes.
func validateArtifactID(id string) error {
	if id == "" || len(id) > 96 {
		return ErrNotFound
	}
	for _, r := range id {
		switch {
		case r >= 'a' && r <= 'z':
		case r >= 'A' && r <= 'Z':
		case r >= '0' && r <= '9':
		case r == '-', r == '_':
		default:
			return ErrNotFound
		}
	}
	return nil
}

// errUnsupported returns the operator-facing driver limitation.
func errUnsupported(driver string) error {
	return fmt.Errorf(
		"%w: %s databases need their native dump tool (mysqldump/pg_dump); "+
			"run that tool into a file and back up the media directory separately",
		ErrUnsupportedDriver, driver,
	)
}

// isNotExist reports a missing path without leaking the OS error.
func isNotExist(err error) bool { return errors.Is(err, os.ErrNotExist) }

// isSiteNotFound reports the site module's sentinel.
func isSiteNotFound(err error) bool { return errors.Is(err, site.ErrNotFound) }

// isCustomizationNotFound reports a site that never saved a design.
func isCustomizationNotFound(err error) bool {
	return errors.Is(err, site.ErrCustomizationNotFound)
}
