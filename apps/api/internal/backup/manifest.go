// Package backup implements instance backups, restore, and whole-site content
// export/import.
//
// The package is deliberately boring about formats. A backup is a zip whose
// manifest names every entry and its SHA-256, so a truncated download or a
// modified database dump is detected before anything is overwritten. The same
// shape is used for a site export, which makes the import side a parser for a
// documented artifact rather than a second, parallel format.
package backup

import (
	"archive/zip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"path"
	"runtime/debug"
	"sort"
	"strings"
	"time"

	"github.com/practacu/practacu-press/apps/api/internal/content"
	"github.com/practacu/practacu-press/apps/api/internal/site"
)

// Artifact formats. They share a version because they share the entry and
// checksum model; a future incompatible change bumps FormatVersion once.
const (
	// FormatBackup marks a whole instance package: database, media, designs.
	FormatBackup = "practacu-press-backup"
	// FormatSiteExport marks a portable set of Markdown files plus media.
	FormatSiteExport = "practacu-press-site-export"
	// FormatVersion is the artifact layout this binary writes and reads.
	FormatVersion = 1
	// ManifestName is the single file every package must carry.
	ManifestName = "manifest.json"
	// MaxImportBytes bounds a whole-site import upload before it is parsed.
	MaxImportBytes int64 = 512 << 20
	// MaxManifestBytes bounds the manifest itself, so a hostile package cannot
	// allocate without limit before the entry checks run.
	MaxManifestBytes = 8 << 20
	// MaxUncompressedBytes bounds the sum of all expanded entries. The compressed
	// upload limit alone would still let a zip bomb expand to an unbounded size
	// while verification and media extraction stream it.
	MaxUncompressedBytes int64 = 4 << 30
)

// Sentinel errors.
var (
	// ErrUnsupportedDriver means the database cannot be snapshotted by this build.
	ErrUnsupportedDriver = errors.New("backup: database driver is not supported")
	// ErrInvalidArchive means the file is not a package this build understands.
	ErrInvalidArchive = errors.New("backup: invalid archive")
	// ErrChecksumMismatch means an entry changed after the manifest was written.
	ErrChecksumMismatch = errors.New("backup: checksum mismatch")
	// ErrConfirmationRequired means a non-empty database would be replaced.
	ErrConfirmationRequired = errors.New("backup: confirmation required")
	// ErrPermissionDenied means the caller may not perform this operation.
	ErrPermissionDenied = errors.New("backup: permission denied")
	// ErrNotFound means the backup or site does not exist.
	ErrNotFound = errors.New("backup: not found")
	// ErrInvalidInput means a field failed validation.
	ErrInvalidInput = errors.New("backup: invalid input")
)

// Actor is the caller performing a backup or transfer operation.
type Actor struct {
	UserID string
	SiteID string
	Role   site.Role
}

// Entry is one file in a package.
type Entry struct {
	Path   string `json:"path"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
}

// DatabaseInfo describes the packaged database dump.
type DatabaseInfo struct {
	Driver        string `json:"driver"`
	Dialect       string `json:"dialect"`
	Dump          string `json:"dump"`
	Size          int64  `json:"size"`
	SHA256        string `json:"sha256"`
	SchemaVersion string `json:"schema_version"`
}

// MediaRootInfo describes one configured storage root.
type MediaRootInfo struct {
	Alias  string `json:"alias"`
	Driver string `json:"driver"`
	Files  int    `json:"files"`
	Bytes  int64  `json:"bytes"`
}

// MediaInfo reports what media the package contains.
type MediaInfo struct {
	Included bool            `json:"included"`
	Roots    []MediaRootInfo `json:"roots"`
	Warnings []string        `json:"warnings,omitempty"`
}

// DesignInfo maps a site to its exported design document.
type DesignInfo struct {
	SiteID   string `json:"site_id"`
	Name     string `json:"name"`
	Slug     string `json:"slug"`
	Domain   string `json:"domain,omitempty"`
	Path     string `json:"path"`
	Revision int    `json:"revision"`
}

// BackupManifest is the index of a whole instance backup.
type BackupManifest struct {
	Format          string       `json:"format"`
	FormatVersion   int          `json:"format_version"`
	Kind            string       `json:"kind"`
	AppVersion      string       `json:"app_version"`
	SchemaVersion   string       `json:"schema_version"`
	CreatedAt       time.Time    `json:"created_at"`
	Database        DatabaseInfo `json:"database"`
	Media           MediaInfo    `json:"media"`
	Designs         []DesignInfo `json:"designs"`
	Entries         []Entry      `json:"entries"`
	ContentChecksum string       `json:"content_checksum"`
	Warnings        []string     `json:"warnings,omitempty"`
}

// ExportSiteInfo describes the exported site.
type ExportSiteInfo struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Slug    string `json:"slug"`
	Domain  string `json:"domain,omitempty"`
	Version string `json:"site_version,omitempty"`
}

// ExportItem maps one content file in a site export.
type ExportItem struct {
	Path      string `json:"path"`
	Kind      string `json:"kind"`
	ContentID string `json:"content_id"`
	Title     string `json:"title"`
	Slug      string `json:"slug"`
	Status    string `json:"status"`
}

// ExportMedia maps one media object in a site export.
type ExportMedia struct {
	AssetID string `json:"asset_id"`
	File    string `json:"file"`
	MIME    string `json:"mime"`
	Size    int64  `json:"size"`
	SHA256  string `json:"sha256"`
}

// ExportManifest is the index of a whole-site content export.
type ExportManifest struct {
	Format          string         `json:"format"`
	FormatVersion   int            `json:"format_version"`
	Kind            string         `json:"kind"`
	AppVersion      string         `json:"app_version"`
	SchemaVersion   string         `json:"schema_version"`
	CreatedAt       time.Time      `json:"created_at"`
	Site            ExportSiteInfo `json:"site"`
	PublishedOnly   bool           `json:"published_only"`
	ContentCount    int            `json:"content_count"`
	Items           []ExportItem   `json:"items"`
	Media           []ExportMedia  `json:"media"`
	Entries         []Entry        `json:"entries"`
	ContentChecksum string         `json:"content_checksum"`
	Warnings        []string       `json:"warnings,omitempty"`
}

// BuildVersion returns the module version when the build provides one.
func BuildVersion() string {
	if info, ok := debug.ReadBuildInfo(); ok {
		if version := strings.TrimSpace(info.Main.Version); version != "" && version != "(devel)" {
			return version
		}
	}
	return "dev"
}

// encodeJSON writes indented JSON. Manifests are meant to be readable by an
// operator who unzips a package to inspect it.
func encodeJSON(value any) ([]byte, error) {
	return json.MarshalIndent(value, "", "  ")
}

// entryChecksum hashes the manifest entry list deterministically, so a manifest
// cannot silently drop one entry while leaving the file in the package.
func entryChecksum(entries []Entry) string {
	sorted := append([]Entry(nil), entries...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].Path < sorted[j].Path })
	hasher := sha256.New()
	for _, entry := range sorted {
		_, _ = io.WriteString(hasher, entry.Path)
		_, _ = io.WriteString(hasher, "\x00")
		_, _ = io.WriteString(hasher, entry.SHA256)
		_, _ = io.WriteString(hasher, "\n")
	}
	return hex.EncodeToString(hasher.Sum(nil))
}

// safeEntryPath rejects absolute paths and traversal in either separator form.
func safeEntryPath(value string) error {
	if value == "" || strings.ContainsRune(value, 0) {
		return fmt.Errorf("%w: empty entry path", ErrInvalidArchive)
	}
	if strings.Contains(value, "\\") || strings.HasPrefix(value, "/") || path.IsAbs(value) {
		return fmt.Errorf("%w: unsafe entry path %q", ErrInvalidArchive, value)
	}
	cleaned := path.Clean(value)
	if cleaned == "." || cleaned == ".." || strings.HasPrefix(cleaned, "../") {
		return fmt.Errorf("%w: unsafe entry path %q", ErrInvalidArchive, value)
	}
	return nil
}

// entryIndex indexes the manifest by path.
func entryIndex(entries []Entry) (map[string]Entry, error) {
	index := make(map[string]Entry, len(entries))
	for _, entry := range entries {
		if err := safeEntryPath(entry.Path); err != nil {
			return nil, err
		}
		if _, exists := index[entry.Path]; exists {
			return nil, fmt.Errorf("%w: duplicate entry %q", ErrInvalidArchive, entry.Path)
		}
		index[entry.Path] = entry
	}
	return index, nil
}

// archiveManifestBase holds the fields shared by every package format.
//
// The full manifests differ (a backup has a database, an export has items and
// media rows), so verification decodes only the common shape and lets the caller
// decode its own format from the returned raw bytes.
type archiveManifestBase struct {
	Format          string    `json:"format"`
	FormatVersion   int       `json:"format_version"`
	Kind            string    `json:"kind"`
	AppVersion      string    `json:"app_version"`
	SchemaVersion   string    `json:"schema_version"`
	CreatedAt       time.Time `json:"created_at"`
	Entries         []Entry   `json:"entries"`
	ContentChecksum string    `json:"content_checksum"`
	Warnings        []string  `json:"warnings,omitempty"`
}

// verifyArchive checks the manifest, every listed entry and rejects unlisted
// files. It returns the common fields and the raw manifest bytes so the caller
// can decode the format specific fields.
func verifyArchive(reader *zip.Reader) (archiveManifestBase, []byte, error) {
	var manifest archiveManifestBase
	byPath := make(map[string]*zip.File, len(reader.File))
	for _, file := range reader.File {
		if err := safeEntryPath(file.Name); err != nil {
			return manifest, nil, err
		}
		if _, exists := byPath[file.Name]; exists {
			return manifest, nil, fmt.Errorf("%w: duplicate zip entry %q", ErrInvalidArchive, file.Name)
		}
		byPath[file.Name] = file
	}

	manifestFile, ok := byPath[ManifestName]
	if !ok {
		return manifest, nil, fmt.Errorf("%w: missing %s", ErrInvalidArchive, ManifestName)
	}
	raw, err := readZipEntry(manifestFile, MaxManifestBytes)
	if err != nil {
		return manifest, nil, err
	}
	if err := json.Unmarshal(raw, &manifest); err != nil {
		return manifest, nil, fmt.Errorf("%w: malformed manifest: %v", ErrInvalidArchive, err)
	}
	if manifest.FormatVersion != FormatVersion {
		return manifest, nil, fmt.Errorf(
			"%w: format_version=%d (this build supports %d)",
			ErrInvalidArchive, manifest.FormatVersion, FormatVersion,
		)
	}
	if manifest.Format != FormatBackup && manifest.Format != FormatSiteExport {
		return manifest, nil, fmt.Errorf("%w: unknown format %q", ErrInvalidArchive, manifest.Format)
	}

	index, err := entryIndex(manifest.Entries)
	if err != nil {
		return manifest, nil, err
	}
	var total int64
	for _, entry := range manifest.Entries {
		total += entry.Size
		if entry.Size < 0 || total > MaxUncompressedBytes {
			return manifest, nil, fmt.Errorf("%w: expanded package is larger than %d bytes", ErrInvalidArchive, MaxUncompressedBytes)
		}
	}
	for entryPath := range byPath {
		if entryPath == ManifestName {
			continue
		}
		if _, listed := index[entryPath]; !listed {
			return manifest, nil, fmt.Errorf("%w: unlisted entry %q", ErrInvalidArchive, entryPath)
		}
	}
	for entryPath, entry := range index {
		file, exists := byPath[entryPath]
		if !exists {
			return manifest, nil, fmt.Errorf("%w: listed entry %q is missing", ErrInvalidArchive, entryPath)
		}
		if err := verifyZipEntry(file, entry); err != nil {
			return manifest, nil, err
		}
	}
	if manifest.ContentChecksum != "" && manifest.ContentChecksum != entryChecksum(manifest.Entries) {
		return manifest, nil, fmt.Errorf("%w: content checksum does not match entries", ErrChecksumMismatch)
	}
	return manifest, raw, nil
}

// verifyZipEntry checks one file size and hash.
func verifyZipEntry(file *zip.File, entry Entry) error {
	if file.UncompressedSize64 != uint64(entry.Size) {
		return fmt.Errorf(
			"%w: %s size is %d, manifest says %d",
			ErrChecksumMismatch, entry.Path, file.UncompressedSize64, entry.Size,
		)
	}
	hasher := sha256.New()
	stream, err := file.Open()
	if err != nil {
		return fmt.Errorf("%w: open %s: %v", ErrInvalidArchive, entry.Path, err)
	}
	defer stream.Close()
	if _, err := io.Copy(hasher, stream); err != nil {
		return fmt.Errorf("%w: read %s: %v", ErrInvalidArchive, entry.Path, err)
	}
	if got := hex.EncodeToString(hasher.Sum(nil)); got != entry.SHA256 {
		return fmt.Errorf("%w: %s is %s, manifest says %s", ErrChecksumMismatch, entry.Path, got, entry.SHA256)
	}
	return nil
}

// readZipEntry reads a bounded entry into memory.
func readZipEntry(file *zip.File, limit int64) ([]byte, error) {
	if file.UncompressedSize64 > uint64(limit) {
		return nil, fmt.Errorf("%w: %s is larger than %d bytes", ErrInvalidArchive, file.Name, limit)
	}
	stream, err := file.Open()
	if err != nil {
		return nil, err
	}
	defer stream.Close()
	raw, err := io.ReadAll(io.LimitReader(stream, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(raw)) > limit {
		return nil, fmt.Errorf("%w: %s is larger than %d bytes", ErrInvalidArchive, file.Name, limit)
	}
	return raw, nil
}

// requireKind guards the two artifact kinds.
func requireKind(manifest archiveManifestBase, format string) error {
	if manifest.Format != format {
		return fmt.Errorf("%w: expected %s, got %s", ErrInvalidArchive, format, manifest.Format)
	}
	return nil
}

// cleanError strips the internal sentinel prefix from a client visible reason.
func cleanError(err error) string {
	text := err.Error()
	for _, prefix := range []string{
		ErrInvalidInput.Error() + ": ",
		ErrInvalidArchive.Error() + ": ",
		ErrChecksumMismatch.Error() + ": ",
		ErrUnsupportedDriver.Error() + ": ",
		ErrConfirmationRequired.Error() + ": ",
	} {
		text = strings.TrimPrefix(text, prefix)
	}
	return text
}

// slugForFile makes an item slug safe for a filename.
func slugForFile(item content.Content) string {
	slug := strings.TrimSpace(item.Slug)
	if slug == "" {
		slug = content.SlugFromTitle(item.Title)
	}
	if slug == "" {
		slug = item.ID
	}
	slug = strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '-', r == '_':
			return r
		default:
			return -1
		}
	}, slug)
	if slug == "" {
		return item.ID
	}
	if len(slug) > 80 {
		slug = strings.Trim(slug[:80], "-")
	}
	return slug
}
