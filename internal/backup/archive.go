package backup

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// Backup origins. The scheduler prunes only the packages it created itself, so a
// manual pre-upgrade backup is never deleted by retention.
const (
	// OriginManual is a package created from the admin console or CLI.
	OriginManual = "manual"
	// OriginAuto is a package created by the scheduled backup loop.
	OriginAuto = "auto"
)

// Artifact is one stored backup package.
type Artifact struct {
	ID       string `json:"id"`
	FileName string `json:"file_name"`
	Size     int64  `json:"size"`
	// SHA256 is the hash of the stored bytes: the ciphertext for an encrypted
	// package, so `sha256sum` over the file matches this value.
	SHA256        string    `json:"sha256"`
	CreatedAt     time.Time `json:"created_at"`
	Driver        string    `json:"driver"`
	Dialect       string    `json:"dialect"`
	IncludesMedia bool      `json:"includes_media"`
	// Origin records who created the package: manual or auto. A sidecar written
	// before this field existed decodes as "" and is treated as manual, which keeps
	// old operator packages safe from automatic pruning.
	Origin string `json:"origin,omitempty"`
	// Encrypted says the stored package is a PPBAK1 envelope and FileName ends
	// in .ppbak. Reading it back requires the deployment's encryption key.
	Encrypted bool     `json:"encrypted,omitempty"`
	Warnings  []string `json:"warnings,omitempty"`
	Path      string   `json:"-"`
}

// zipBuilder streams entries into a zip while hashing their uncompressed bytes.
//
// It never buffers a whole media file: the checksum and the zip compressor read
// the same io.Copy stream.
type zipBuilder struct {
	writer  *zip.Writer
	entries []Entry
	now     time.Time
}

func newZipBuilder(writer io.Writer, now time.Time) *zipBuilder {
	return &zipBuilder{writer: zip.NewWriter(writer), now: now}
}

// addReader copies one entry and records its checksum.
func (b *zipBuilder) addReader(entryPath string, modified time.Time, reader io.Reader) (Entry, error) {
	if err := safeEntryPath(entryPath); err != nil {
		return Entry{}, err
	}
	if modified.IsZero() {
		modified = b.now
	}
	header := &zip.FileHeader{
		Name:     entryPath,
		Method:   zip.Deflate,
		Modified: modified.UTC(),
	}
	header.SetMode(0o644)
	target, err := b.writer.CreateHeader(header)
	if err != nil {
		return Entry{}, err
	}
	hasher := sha256.New()
	written, err := io.Copy(io.MultiWriter(target, hasher), reader)
	if err != nil {
		return Entry{}, err
	}
	entry := Entry{Path: entryPath, Size: written, SHA256: hex.EncodeToString(hasher.Sum(nil))}
	b.entries = append(b.entries, entry)
	return entry, nil
}

// addBytes writes a small generated file.
func (b *zipBuilder) addBytes(entryPath string, modified time.Time, data []byte) (Entry, error) {
	return b.addReader(entryPath, modified, bytes.NewReader(data))
}

// addFile streams one file from disk.
func (b *zipBuilder) addFile(entryPath, sourcePath string, modified time.Time) (Entry, error) {
	file, err := os.Open(sourcePath)
	if err != nil {
		return Entry{}, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return Entry{}, err
	}
	if modified.IsZero() {
		modified = info.ModTime()
	}
	return b.addReader(entryPath, modified, file)
}

// addManifest writes the manifest last without listing itself.
func (b *zipBuilder) addManifest(manifest any) error {
	raw, err := encodeJSON(manifest)
	if err != nil {
		return err
	}
	header := &zip.FileHeader{
		Name:     ManifestName,
		Method:   zip.Deflate,
		Modified: b.now.UTC(),
	}
	header.SetMode(0o644)
	target, err := b.writer.CreateHeader(header)
	if err != nil {
		return err
	}
	_, err = target.Write(raw)
	return err
}

// close closes the underlying zip writer.
func (b *zipBuilder) close() error { return b.writer.Close() }

// CreateBackup builds a whole instance backup package on explicit operator request.
func (s *Service) CreateBackup(ctx context.Context) (Artifact, error) {
	return s.createBackup(ctx, OriginManual)
}

// CreateAutomaticBackup builds a package for the scheduled retention loop. Its
// origin is what keeps prune from deleting manual packages.
func (s *Service) CreateAutomaticBackup(ctx context.Context) (Artifact, error) {
	return s.createBackup(ctx, OriginAuto)
}

// createBackup builds a whole instance backup package and returns its metadata.
//
// The package contains database/practacu.db, design/<site>.json for every site,
// media/<root>/<key> for every local storage root, and a manifest with per entry
// checksums. The database is captured with VACUUM INTO, so the file is a
// consistent copy even while the API is serving writes.
func (s *Service) createBackup(ctx context.Context, origin string) (Artifact, error) {
	if s.snapshotter == nil {
		return Artifact{}, fmt.Errorf("%w: no database snapshotter configured", ErrUnsupportedDriver)
	}
	if s.driver != "" && s.driver != "sqlite" {
		return Artifact{}, errUnsupported(s.driver)
	}
	if err := ctx.Err(); err != nil {
		return Artifact{}, err
	}

	createdAt := s.now().UTC()
	encrypted := len(s.encryptionKey) > 0
	extension := plainPackageExtension
	if encrypted {
		extension = encryptedPackageExtension
	}
	id := "backup-" + createdAt.Format("20060102-150405")
	// Two backups in the same second must not overwrite each other.
	for suffix := 2; s.packageExists(id); suffix++ {
		id = fmt.Sprintf("backup-%s-%d", createdAt.Format("20060102-150405"), suffix)
	}
	finalPath := s.packagePath(id, encrypted)
	tempPath := filepath.Join(s.backupDir, "."+id+extension+".tmp")
	out, err := os.OpenFile(tempPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o640)
	if err != nil {
		return Artifact{}, fmt.Errorf("backup: create package: %w", err)
	}
	committed := false
	defer func() {
		_ = out.Close()
		if !committed {
			_ = os.Remove(tempPath)
		}
	}()

	packageHash := sha256.New()
	// The hash covers the stored bytes: EncryptWriter writes through the hashing
	// sink, so an encrypted artifact's SHA256 is sha256sum of the .ppbak file and
	// a plaintext artifact's is sha256sum of the .zip file.
	var payload io.Writer = io.MultiWriter(out, packageHash)
	var encryptor io.WriteCloser
	if encrypted {
		encryptor, err = EncryptWriter(payload, s.encryptionKey)
		if err != nil {
			return Artifact{}, fmt.Errorf("backup: start encrypted package: %w", err)
		}
		payload = encryptor
	}
	builder := newZipBuilder(payload, createdAt)

	tempDir, err := os.MkdirTemp(s.backupDir, ".snapshot-*")
	if err != nil {
		return Artifact{}, fmt.Errorf("backup: create snapshot directory: %w", err)
	}
	defer os.RemoveAll(tempDir)

	dumpPath := filepath.Join(tempDir, "practacu.db")
	if err := s.snapshotter.Snapshot(ctx, dumpPath); err != nil {
		return Artifact{}, err
	}
	dumpEntry, err := builder.addFile("database/practacu.db", dumpPath, createdAt)
	if err != nil {
		return Artifact{}, fmt.Errorf("backup: add database: %w", err)
	}

	designs, _, designWarnings, err := s.addDesigns(ctx, builder, createdAt)
	if err != nil {
		return Artifact{}, err
	}
	mediaInfo, err := s.addMedia(ctx, builder, createdAt)
	if err != nil {
		return Artifact{}, err
	}
	warnings := append(append([]string(nil), designWarnings...), mediaInfo.Warnings...)

	entries := append([]Entry(nil), builder.entries...)
	manifest := BackupManifest{
		Format:        FormatBackup,
		FormatVersion: FormatVersion,
		Kind:          "backup",
		AppVersion:    s.appVersion,
		SchemaVersion: s.schemaVersion,
		CreatedAt:     createdAt,
		Encrypted:     encrypted,
		Database: DatabaseInfo{
			Driver:        s.driver,
			Dialect:       s.driver,
			Dump:          dumpEntry.Path,
			Size:          dumpEntry.Size,
			SHA256:        dumpEntry.SHA256,
			SchemaVersion: s.schemaVersion,
		},
		Media:           mediaInfo,
		Designs:         designs,
		Entries:         entries,
		ContentChecksum: entryChecksum(entries),
		Warnings:        warnings,
	}
	if err := builder.addManifest(manifest); err != nil {
		return Artifact{}, fmt.Errorf("backup: add manifest: %w", err)
	}
	if err := builder.close(); err != nil {
		return Artifact{}, fmt.Errorf("backup: finish package: %w", err)
	}
	// The encryptor must flush its last chunk and the authenticated end marker
	// before the file is synced, otherwise the published package is truncated.
	if encryptor != nil {
		if err := encryptor.Close(); err != nil {
			return Artifact{}, fmt.Errorf("backup: finish encrypted package: %w", err)
		}
	}
	if err := out.Sync(); err != nil {
		return Artifact{}, err
	}
	if err := out.Close(); err != nil {
		return Artifact{}, err
	}
	if err := os.Rename(tempPath, finalPath); err != nil {
		return Artifact{}, fmt.Errorf("backup: publish package: %w", err)
	}
	committed = true

	info, err := os.Stat(finalPath)
	if err != nil {
		return Artifact{}, err
	}
	artifact := Artifact{
		ID:            id,
		FileName:      id + extension,
		Size:          info.Size(),
		SHA256:        hex.EncodeToString(packageHash.Sum(nil)),
		CreatedAt:     createdAt,
		Driver:        s.driver,
		Dialect:       s.driver,
		IncludesMedia: mediaInfo.Included,
		Origin:        origin,
		Encrypted:     encrypted,
		Warnings:      warnings,
		Path:          finalPath,
	}
	if err := s.writeArtifactMeta(artifact); err != nil {
		return Artifact{}, err
	}
	return artifact, nil
}

// addDesigns writes one readable design JSON per site and returns review-only
// entries. The database dump remains the source of truth for restore.
func (s *Service) addDesigns(
	ctx context.Context,
	builder *zipBuilder,
	createdAt time.Time,
) ([]DesignInfo, []Entry, []string, error) {
	if s.designs == nil {
		return nil, nil, []string{"site designs were not packaged: design source is not configured"}, nil
	}
	snapshots, err := s.designs.SnapshotDesigns(ctx)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("backup: list site designs: %w", err)
	}
	infos := make([]DesignInfo, 0, len(snapshots))
	entries := make([]Entry, 0, len(snapshots))
	for _, snapshot := range snapshots {
		if len(snapshot.Document) == 0 {
			continue
		}
		entryPath := "design/" + snapshot.SiteID + ".json"
		entry, err := builder.addBytes(entryPath, createdAt, snapshot.Document)
		if err != nil {
			return nil, nil, nil, fmt.Errorf("backup: add design %s: %w", snapshot.SiteID, err)
		}
		entries = append(entries, entry)
		infos = append(infos, DesignInfo{
			SiteID:   snapshot.SiteID,
			Name:     snapshot.Name,
			Slug:     snapshot.Slug,
			Domain:   snapshot.Domain,
			Path:     entryPath,
			Revision: snapshot.Revision,
		})
	}
	return infos, entries, nil, nil
}

// addMedia streams every local storage root into the package. S3 roots are
// reported, never silently dropped: an operator must know the package does not
// include their objects.
func (s *Service) addMedia(
	ctx context.Context,
	builder *zipBuilder,
	createdAt time.Time,
) (MediaInfo, error) {
	roots := s.mediaRootList()
	info := MediaInfo{Included: false, Roots: make([]MediaRootInfo, 0, len(roots))}
	for _, root := range roots {
		rootInfo := MediaRootInfo{Alias: root.Alias, Driver: root.Driver}
		if root.Driver != "local" {
			info.Roots = append(info.Roots, rootInfo)
			info.Warnings = append(info.Warnings,
				fmt.Sprintf("storage root %q uses %s: objects were not packaged; back up that bucket separately",
					root.Alias, root.Driver))
			continue
		}
		if strings.TrimSpace(root.Dir) == "" {
			info.Warnings = append(info.Warnings,
				fmt.Sprintf("storage root %q has no local directory; skipped", root.Alias))
			info.Roots = append(info.Roots, rootInfo)
			continue
		}
		rootAbs, err := filepath.Abs(root.Dir)
		if err != nil {
			return info, err
		}
		if stat, statErr := os.Stat(rootAbs); statErr != nil {
			if os.IsNotExist(statErr) {
				info.Warnings = append(info.Warnings,
					fmt.Sprintf("storage root %q does not exist yet; nothing to package", root.Alias))
				info.Roots = append(info.Roots, rootInfo)
				continue
			}
			return info, statErr
		} else if !stat.IsDir() {
			return info, fmt.Errorf("backup: media root %q is not a directory", root.Alias)
		}

		err = filepath.WalkDir(rootAbs, func(current string, entry fs.DirEntry, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			if err := ctx.Err(); err != nil {
				return err
			}
			if entry.IsDir() {
				return nil
			}
			// Symlinks are skipped: following them could copy files outside the
			// storage root and produce a package the restore cannot reproduce.
			if entry.Type()&fs.ModeSymlink != 0 {
				return nil
			}
			relative, err := filepath.Rel(rootAbs, current)
			if err != nil {
				return err
			}
			archivePath := "media/" + root.Alias + "/" + filepath.ToSlash(relative)
			added, err := builder.addFile(archivePath, current, createdAt)
			if err != nil {
				return err
			}
			rootInfo.Files++
			rootInfo.Bytes += added.Size
			return nil
		})
		if err != nil {
			return info, fmt.Errorf("backup: package media %q: %w", root.Alias, err)
		}
		if rootInfo.Files > 0 {
			info.Included = true
		}
		info.Roots = append(info.Roots, rootInfo)
	}
	return info, nil
}

// writeArtifactMeta stores the small sidecar the list/download endpoints read.
func (s *Service) writeArtifactMeta(artifact Artifact) error {
	raw, err := encodeJSON(artifact)
	if err != nil {
		return err
	}
	temp := s.metaPath(artifact.ID) + ".tmp"
	if err := os.WriteFile(temp, raw, 0o640); err != nil {
		return err
	}
	return os.Rename(temp, s.metaPath(artifact.ID))
}

// ListBackups returns stored artifacts newest first. A corrupt sidecar is
// skipped rather than failing the whole page: one bad file must not hide the
// backups that are still usable.
func (s *Service) ListBackups(ctx context.Context, actor Actor) ([]Artifact, error) {
	if err := requirePlatformAdmin(actor); err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(s.backupDir)
	if err != nil {
		return nil, err
	}
	artifacts := make([]Artifact, 0)
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".meta.json") {
			continue
		}
		id := strings.TrimSuffix(entry.Name(), ".meta.json")
		artifact, readErr := s.readArtifact(id)
		if readErr != nil {
			continue
		}
		artifacts = append(artifacts, artifact)
	}
	sort.Slice(artifacts, func(i, j int) bool { return artifacts[i].CreatedAt.After(artifacts[j].CreatedAt) })
	return artifacts, nil
}

// OpenBackup returns one artifact and opens its file for streaming.
//
// The download endpoint serves the package exactly as stored: for an encrypted
// artifact that is the .ppbak ciphertext, which the operator restores with the
// deployment's key. The magic is checked against the sidecar so a file swapped
// behind the metadata cannot be handed out as a valid backup.
func (s *Service) OpenBackup(ctx context.Context, actor Actor, id string) (Artifact, *os.File, error) {
	if err := requirePlatformAdmin(actor); err != nil {
		return Artifact{}, nil, err
	}
	if err := ctx.Err(); err != nil {
		return Artifact{}, nil, err
	}
	artifact, err := s.readArtifact(id)
	if err != nil {
		return Artifact{}, nil, err
	}
	file, err := os.Open(artifact.Path)
	if err != nil {
		if isNotExist(err) {
			return Artifact{}, nil, ErrNotFound
		}
		return Artifact{}, nil, err
	}
	encrypted, err := IsEncryptedPackage(artifact.Path)
	if err != nil {
		_ = file.Close()
		return Artifact{}, nil, err
	}
	if encrypted != artifact.Encrypted {
		_ = file.Close()
		return Artifact{}, nil, fmt.Errorf(
			"%w: package %s does not match its metadata (encrypted=%v)",
			ErrInvalidArchive, artifact.ID, artifact.Encrypted,
		)
	}
	return artifact, file, nil
}

// prepareArchive resolves a package for the archive/zip readers.
//
// A plaintext package is returned unchanged. An encrypted package is streamed
// through the PPBAK1 decoder into a temporary zip, because archive/zip needs a
// seekable file. The returned cleanup removes that temporary file. A missing key
// on an encrypted package is an error, never a silent plaintext fallback.
func (s *Service) prepareArchive(path string) (string, func(), error) {
	encrypted, err := IsEncryptedPackage(path)
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			return "", nil, fmt.Errorf("%w: open package: %v", ErrInvalidArchive, err)
		}
		return "", nil, fmt.Errorf("backup: inspect package: %w", err)
	}
	if !encrypted {
		return path, func() {}, nil
	}
	if len(s.encryptionKey) == 0 {
		return "", nil, fmt.Errorf(
			"%w: this package is encrypted; supply the backup encryption key "+
				"(--key or BACKUP_ENCRYPTION_KEY) to read it",
			ErrEncryptionKeyRequired,
		)
	}

	source, err := os.Open(path)
	if err != nil {
		return "", nil, fmt.Errorf("%w: open package: %v", ErrInvalidArchive, err)
	}
	decrypted, err := NewDecryptingReader(source, s.encryptionKey)
	if err != nil {
		_ = source.Close()
		return "", nil, err
	}
	temp, err := os.CreateTemp("", "practacu-backup-*.zip")
	if err != nil {
		_ = source.Close()
		return "", nil, fmt.Errorf("backup: create decryption temp file: %w", err)
	}
	tempPath := temp.Name()
	cleanup := func() { _ = os.Remove(tempPath) }
	if _, err := io.Copy(temp, decrypted); err != nil {
		_ = temp.Close()
		_ = source.Close()
		cleanup()
		if errors.Is(err, ErrDecryptionFailed) || errors.Is(err, ErrInvalidArchive) {
			return "", nil, err
		}
		return "", nil, fmt.Errorf("backup: decrypt package: %w", err)
	}
	if err := temp.Close(); err != nil {
		_ = source.Close()
		cleanup()
		return "", nil, fmt.Errorf("backup: close decryption temp file: %w", err)
	}
	if err := source.Close(); err != nil {
		cleanup()
		return "", nil, err
	}
	return tempPath, cleanup, nil
}

// VerifyBackup checks a package without changing anything. An encrypted package
// is authenticated and decrypted to a temporary file first.
func (s *Service) VerifyBackup(path string) (BackupManifest, error) {
	resolved, cleanup, err := s.prepareArchive(path)
	if err != nil {
		return BackupManifest{}, err
	}
	defer cleanup()
	return s.verifyPlainArchive(resolved)
}

// verifyPlainArchive checks an already decrypted (or plaintext) package.
func (s *Service) verifyPlainArchive(path string) (BackupManifest, error) {
	reader, err := zip.OpenReader(path)
	if err != nil {
		return BackupManifest{}, fmt.Errorf("%w: open package: %v", ErrInvalidArchive, err)
	}
	defer reader.Close()
	base, raw, err := verifyArchive(&reader.Reader)
	if err != nil {
		return BackupManifest{}, err
	}
	if err := requireKind(base, FormatBackup); err != nil {
		return BackupManifest{}, err
	}
	var manifest BackupManifest
	if err := json.Unmarshal(raw, &manifest); err != nil {
		return BackupManifest{}, fmt.Errorf("%w: malformed backup manifest: %v", ErrInvalidArchive, err)
	}
	if manifest.Database.Dump != "database/practacu.db" {
		return manifest, fmt.Errorf("%w: database dump entry is missing", ErrInvalidArchive)
	}
	return manifest, nil
}

// decodeJSON is a small helper kept here so callers need no encoding/json import.
func decodeJSON(raw []byte, target any) error { return json.Unmarshal(raw, target) }
