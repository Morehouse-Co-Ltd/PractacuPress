package db

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// TestSchemaVersionMatchesNewestMigration keeps the version stamped into backup
// manifests in step with the reviewed change sets. A stale constant makes a restore
// compare against the wrong level: packages from this binary are labelled older
// than they are, and a newer package can be accepted as if a migration covered it.
func TestSchemaVersionMatchesNewestMigration(t *testing.T) {
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot locate this test file")
	}
	root := filepath.Clean(filepath.Join(filepath.Dir(file), "..", "..", ".."))
	dir := filepath.Join(root, "internal", "migrations", "sqlite")
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read %s: %v", dir, err)
	}

	newest := ""
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasSuffix(name, ".up.sql") {
			continue
		}
		version, _, found := strings.Cut(name, "_")
		if !found || len(version) != 14 {
			t.Fatalf("migration %q has no 14 digit version prefix", name)
		}
		if version > newest {
			newest = version
		}
	}
	if newest == "" {
		t.Fatal("no .up.sql migration was found")
	}
	if SchemaVersion != newest {
		t.Fatalf("SchemaVersion = %q, newest migration is %q", SchemaVersion, newest)
	}
}
