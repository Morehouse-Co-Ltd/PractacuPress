package extensions

import (
	"archive/zip"
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"strings"

	"github.com/practacu/practacu-press/internal/plugins"
)

// ImportZip installs one extension package from a zip stream.
//
// The archive is untrusted input, so every entry name is validated before it is
// written: traversal, absolute paths, symbolic links, Windows reserved names and
// alternate data stream colons are rejected. The package is unpacked into a
// dot-prefixed staging directory inside the package root, validated, and only
// then renamed into place, so a rejected upload never leaves a half installed
// directory behind. Replacing an existing id keeps its enable state.
func (m *Manager) ImportZip(reader io.Reader, maxBytes int64) (Extension, error) {
	if maxBytes <= 0 {
		maxBytes = m.maxPackage
	}
	data, err := readPackage(reader, maxBytes)
	if err != nil {
		return Extension{}, err
	}
	archive, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return Extension{}, fmt.Errorf("%w: not a zip archive: %v", ErrInvalidPackage, err)
	}

	m.mu.Lock()
	defer m.mu.Unlock()

	staging, err := os.MkdirTemp(m.root, ".incoming-*")
	if err != nil {
		return Extension{}, fmt.Errorf("extensions: create staging directory: %w", err)
	}
	staged := true
	defer func() {
		if staged {
			_ = os.RemoveAll(staging)
		}
	}()

	manifest, err := unpackArchive(archive, staging, m.maxFiles, m.maxUnpacked)
	if err != nil {
		return Extension{}, err
	}
	// Beta 1.2 contract D: record the digest of the manifest exactly as unpacked,
	// inside the package directory and before it becomes visible. The installer is
	// the only writer, so "verified" means "this server unpacked these bytes".
	if _, err := plugins.WriteManifestSidecar(staging, m.now()); err != nil {
		return Extension{}, fmt.Errorf("extensions: record manifest integrity: %w", err)
	}
	destination, err := m.extensionDir(manifest.ID)
	if err != nil {
		return Extension{}, fmt.Errorf("%w: id %q", ErrInvalidPackage, manifest.ID)
	}

	// A new package starts enabled; an upgrade keeps the previous decision.
	enabled := true
	if status, ok := m.host.Get(manifest.ID); ok {
		enabled = status.State == plugins.StateEnabled
	} else if decision, ok := m.state[manifest.ID]; ok {
		enabled = decision.Enabled
	}

	// The host must not keep a compiled module pointing at a directory this import
	// is about to replace.
	if _, installed := m.host.Get(manifest.ID); installed {
		if err := m.host.Remove(manifest.ID); err != nil {
			return Extension{}, fmt.Errorf("extensions: unload previous %s: %w", manifest.ID, err)
		}
	}

	backup, backupErr := m.moveAside(destination)
	if backupErr != nil {
		return Extension{}, backupErr
	}
	restore := func() {
		if backup == "" {
			return
		}
		_ = os.RemoveAll(destination)
		if err := os.Rename(backup, destination); err != nil {
			m.logger.Error("restoring the previous extension package failed",
				"extension", manifest.ID, "error", err)
			return
		}
		if _, err := m.host.Install(destination); err != nil {
			m.logger.Error("reinstalling the previous extension package failed",
				"extension", manifest.ID, "error", err)
		}
	}

	if err := os.Rename(staging, destination); err != nil {
		// The staging directory still exists, so the deferred cleanup removes it.
		restore()
		return Extension{}, fmt.Errorf("extensions: move package into place: %w", err)
	}
	staged = false

	status, err := m.host.Install(destination)
	if err != nil {
		if backup != "" {
			restore()
		} else {
			_ = os.RemoveAll(destination)
		}
		return Extension{}, fmt.Errorf("%w: %v", ErrInvalidPackage, err)
	}
	if enabled {
		status, err = m.host.Enable(manifest.ID)
	} else {
		status, err = m.host.Disable(manifest.ID)
	}
	if err != nil {
		m.logger.Warn("applying the extension enable state failed",
			"extension", manifest.ID, "error", err)
		// Enable/Disable may have left the package unloaded; report and persist what
		// the host actually holds instead of the requested state, so the dashboard
		// and the next boot agree with the running process.
		if actual, ok := m.host.Get(manifest.ID); ok {
			status = actual
		}
	}
	if backup != "" {
		_ = os.RemoveAll(backup)
	}

	m.manifests[manifest.ID] = manifest
	m.dirs[manifest.ID] = destination
	m.state[manifest.ID] = stateEntry{Enabled: status.State == plugins.StateEnabled}
	m.persistLocked()
	extension := extensionFromManifest(manifest, status)
	m.applyIntegrityLocked(&extension, destination)
	return extension, nil
}

// moveAside renames an existing package directory to a dot-prefixed backup so the
// replacement can be rolled back when the new package fails to load.
func (m *Manager) moveAside(destination string) (string, error) {
	if _, err := os.Stat(destination); errors.Is(err, os.ErrNotExist) {
		return "", nil
	} else if err != nil {
		return "", fmt.Errorf("extensions: inspect package directory: %w", err)
	}
	backup, err := os.MkdirTemp(m.root, ".replaced-*")
	if err != nil {
		return "", fmt.Errorf("extensions: prepare package replacement: %w", err)
	}
	// MkdirTemp created the directory; Rename needs the name to be free.
	if err := os.Remove(backup); err != nil {
		return "", fmt.Errorf("extensions: prepare package replacement: %w", err)
	}
	if err := os.Rename(destination, backup); err != nil {
		return "", fmt.Errorf("extensions: set previous package aside: %w", err)
	}
	return backup, nil
}

// readPackage bounds the upload before the zip reader ever sees it.
func readPackage(reader io.Reader, maxBytes int64) ([]byte, error) {
	if reader == nil {
		return nil, fmt.Errorf("%w: the package is empty", ErrInvalidPackage)
	}
	if maxBytes <= 0 {
		maxBytes = DefaultMaxPackageBytes
	}
	data, err := io.ReadAll(io.LimitReader(reader, maxBytes+1))
	if err != nil {
		return nil, fmt.Errorf("%w: read package: %v", ErrInvalidPackage, err)
	}
	if int64(len(data)) > maxBytes {
		return nil, fmt.Errorf("%w: package exceeds %d bytes", ErrPackageTooLarge, maxBytes)
	}
	if len(data) == 0 {
		return nil, fmt.Errorf("%w: the package is empty", ErrInvalidPackage)
	}
	return data, nil
}

// unpackArchive validates and extracts the archive into destination, then loads
// the manifest so the declared files are checked as a set.
func unpackArchive(archive *zip.Reader, destination string, maxFiles int, maxUnpacked int64) (plugins.Manifest, error) {
	if maxFiles <= 0 {
		maxFiles = DefaultMaxFiles
	}
	if maxUnpacked <= 0 {
		maxUnpacked = DefaultMaxUnpackedBytes
	}
	files := 0
	var unpacked int64
	for _, entry := range archive.File {
		name, isDir, err := safeArchiveName(entry.Name)
		if err != nil {
			return plugins.Manifest{}, err
		}
		if isDir {
			continue
		}
		files++
		if files > maxFiles {
			return plugins.Manifest{}, fmt.Errorf(
				"%w: the package contains more than %d files", ErrInvalidPackage, maxFiles)
		}
		info := entry.FileInfo()
		if info.Mode()&os.ModeSymlink != 0 {
			return plugins.Manifest{}, fmt.Errorf("%w: %q is a symbolic link", ErrInvalidPackage, entry.Name)
		}
		if !info.Mode().IsRegular() {
			return plugins.Manifest{}, fmt.Errorf("%w: %q is not a regular file", ErrInvalidPackage, entry.Name)
		}
		size := int64(entry.UncompressedSize64)
		if size < 0 || unpacked+size > maxUnpacked {
			return plugins.Manifest{}, fmt.Errorf(
				"%w: the unpacked package would exceed %d bytes", ErrPackageTooLarge, maxUnpacked)
		}
		target := filepath.Join(destination, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return plugins.Manifest{}, fmt.Errorf("extensions: create package directory: %w", err)
		}
		written, err := writeArchiveEntry(entry, target, size)
		if err != nil {
			return plugins.Manifest{}, err
		}
		unpacked += written
	}

	manifestPath := filepath.Join(destination, plugins.ManifestFileName)
	info, err := os.Stat(manifestPath)
	if err != nil || !info.Mode().IsRegular() {
		return plugins.Manifest{}, fmt.Errorf(
			"%w: the package root must contain %s", ErrInvalidPackage, plugins.ManifestFileName)
	}
	manifest, err := plugins.LoadManifest(destination)
	if err != nil {
		return plugins.Manifest{}, fmt.Errorf("%w: %v", ErrInvalidPackage, err)
	}
	return manifest, nil
}

// writeArchiveEntry writes one file with the declared size as both a limit and an
// expectation, so a lying header is caught instead of trusted.
func writeArchiveEntry(entry *zip.File, target string, size int64) (int64, error) {
	source, err := entry.Open()
	if err != nil {
		return 0, fmt.Errorf("%w: open %q: %v", ErrInvalidPackage, entry.Name, err)
	}
	defer source.Close()

	file, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		return 0, fmt.Errorf("extensions: create package file: %w", err)
	}
	written, copyErr := io.Copy(file, io.LimitReader(source, size+1))
	closeErr := file.Close()
	if copyErr != nil {
		return 0, fmt.Errorf("%w: extract %q: %v", ErrInvalidPackage, entry.Name, copyErr)
	}
	if closeErr != nil {
		return 0, fmt.Errorf("extensions: write package file: %w", closeErr)
	}
	if written != size {
		return 0, fmt.Errorf("%w: %q has an inconsistent size", ErrInvalidPackage, entry.Name)
	}
	return written, nil
}

// reservedWindowsNames are the device names Windows refuses (or silently rewrites)
// in any directory. A package extracted on a Windows host must not contain them.
var reservedWindowsNames = map[string]struct{}{
	"CON": {}, "PRN": {}, "AUX": {}, "NUL": {},
	"COM1": {}, "COM2": {}, "COM3": {}, "COM4": {}, "COM5": {},
	"COM6": {}, "COM7": {}, "COM8": {}, "COM9": {},
	"LPT1": {}, "LPT2": {}, "LPT3": {}, "LPT4": {}, "LPT5": {},
	"LPT6": {}, "LPT7": {}, "LPT8": {}, "LPT9": {},
}

// safeArchiveName normalises and validates one entry name. It returns the clean
// slash-separated name and whether the entry is a directory.
func safeArchiveName(raw string) (string, bool, error) {
	invalid := func(reason string) (string, bool, error) {
		return "", false, fmt.Errorf("%w: %q %s", ErrInvalidPackage, raw, reason)
	}
	if raw == "" {
		return invalid("is empty")
	}
	if strings.ContainsRune(raw, 0) || strings.ContainsRune(raw, ':') {
		return invalid("contains a forbidden character")
	}
	// Windows zippers (PowerShell's Compress-Archive among them) store directory
	// separators as backslashes even though the zip spec says "/". Normalise first,
	// then apply the same traversal and reserved-name checks as a POSIX name, so a
	// package built on Windows installs identically on Linux and vice versa.
	raw = strings.ReplaceAll(raw, `\`, "/")
	if strings.HasPrefix(raw, "/") {
		return invalid("is an absolute path")
	}
	isDir := strings.HasSuffix(raw, "/")
	name := strings.TrimSuffix(raw, "/")
	if name == "" {
		return invalid("is empty")
	}
	clean := path.Clean(name)
	if clean != name || clean == "." || clean == ".." || strings.HasPrefix(clean, "../") {
		return invalid("escapes the package root")
	}
	for _, segment := range strings.Split(clean, "/") {
		if err := validateArchiveSegment(segment); err != nil {
			return invalid(err.Error())
		}
	}
	return clean, isDir, nil
}

// validateArchiveSegment rejects one path element that Windows would reinterpret.
func validateArchiveSegment(segment string) error {
	if segment == "" || segment == "." || segment == ".." {
		return errors.New("contains an empty or relative segment")
	}
	if strings.HasSuffix(segment, ".") || strings.HasSuffix(segment, " ") {
		return errors.New("ends with a dot or a space")
	}
	base := segment
	if index := strings.IndexByte(base, '.'); index >= 0 {
		base = base[:index]
	}
	if _, reserved := reservedWindowsNames[strings.ToUpper(base)]; reserved {
		return errors.New("uses a reserved device name")
	}
	for _, r := range segment {
		if r < 0x20 || r == 0x7f {
			return errors.New("contains a control character")
		}
	}
	return nil
}
