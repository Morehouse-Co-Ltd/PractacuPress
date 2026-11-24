package db

import (
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// ensureSQLiteFile makes a file-backed SQLite DSN usable before database/sql
// opens it.
//
// SQLite itself creates a missing file, but only when the parent directory
// already exists, and the desktop package starts with a data directory that may
// not have been created yet. Creating both here keeps the first start a single
// step. In-memory and read-only DSNs are deliberately left alone: a missing
// read-only database is an operator error, not something to replace with an
// empty one.
func ensureSQLiteFile(dsn string) (bool, error) {
	path, shouldCreate, err := sqliteFileTarget(dsn)
	if err != nil || !shouldCreate {
		return false, err
	}

	info, err := os.Stat(path)
	switch {
	case err == nil:
		if info.IsDir() {
			return false, fmt.Errorf("db: sqlite path is a directory: %s", path)
		}
		return false, nil
	case !os.IsNotExist(err):
		return false, fmt.Errorf("db: inspect sqlite file %s: %w", path, err)
	}

	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return false, fmt.Errorf("db: create sqlite directory %s: %w", dir, err)
	}

	file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if os.IsExist(err) {
		// Another process won the race between stat and open. The file exists,
		// which is all this function promises.
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("db: create sqlite file %s: %w", path, err)
	}
	if err := file.Close(); err != nil {
		return false, fmt.Errorf("db: close new sqlite file %s: %w", path, err)
	}
	return true, nil
}

// sqliteFileTarget extracts the local path from a SQLite DSN.
//
// shouldCreate is false for memory databases and for read-only/immutable
// targets. The parser accepts the forms that appear in this repository and in
// modernc/sqlite documentation: file:relative/path, file:/absolute/path,
// file:///C:/path on Windows, and a bare path.
func sqliteFileTarget(dsn string) (path string, shouldCreate bool, err error) {
	raw := strings.TrimSpace(dsn)
	if raw == "" || raw == ":memory:" || strings.EqualFold(raw, "file::memory:") {
		return "", false, nil
	}

	target := raw
	query := ""
	if parsed, parseErr := url.Parse(raw); parseErr == nil && strings.EqualFold(parsed.Scheme, "file") {
		if parsed.Opaque != "" {
			target = parsed.Opaque
		} else {
			target = parsed.Path
			if parsed.Host != "" && !strings.EqualFold(parsed.Host, "localhost") {
				target = "//" + parsed.Host + target
			}
		}
		query = parsed.RawQuery
	} else if idx := strings.IndexByte(raw, '?'); idx >= 0 {
		target = raw[:idx]
		query = raw[idx+1:]
	}

	if target == "" || target == ":memory:" {
		return "", false, nil
	}

	values, parseErr := url.ParseQuery(query)
	if parseErr != nil {
		return "", false, fmt.Errorf("db: parse sqlite DSN query: %w", parseErr)
	}
	switch strings.ToLower(values.Get("mode")) {
	case "memory", "ro":
		return "", false, nil
	}
	if values.Get("immutable") != "" && values.Get("immutable") != "0" {
		return "", false, nil
	}

	if decoded, unescapeErr := url.PathUnescape(target); unescapeErr == nil {
		target = decoded
	}
	if runtime.GOOS == "windows" {
		// file:///C:/data/app.db has an absolute URL path. The leading slash is
		// part of the URI, not of the Windows path.
		if len(target) >= 3 && target[0] == '/' && target[2] == ':' {
			target = target[1:]
		}
	}
	return filepath.FromSlash(target), true, nil
}
