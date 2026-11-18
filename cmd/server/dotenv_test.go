package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestFindDotEnvWalksToModuleRoot(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "go.mod"), []byte("module example.test/app\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	envPath := filepath.Join(root, ".env")
	if err := os.WriteFile(envPath, []byte("APP_ENV=development\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	nested := filepath.Join(root, "cmd", "server")
	if err := os.MkdirAll(nested, 0o755); err != nil {
		t.Fatal(err)
	}

	t.Chdir(nested)
	if got := findDotEnv(); got != envPath {
		t.Fatalf("findDotEnv() = %q, want %q", got, envPath)
	}
}

func TestFindDotEnvDoesNotLeaveTheModule(t *testing.T) {
	parent := t.TempDir()
	// A stray .env above the module must not configure the server.
	if err := os.WriteFile(filepath.Join(parent, ".env"), []byte("APP_ENV=development\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(parent, "app")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "go.mod"), []byte("module example.test/app\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	nested := filepath.Join(root, "cmd", "server")
	if err := os.MkdirAll(nested, 0o755); err != nil {
		t.Fatal(err)
	}

	t.Chdir(nested)
	if got := findDotEnv(); got != "" {
		t.Fatalf("findDotEnv() = %q, want empty (no .env inside the module)", got)
	}
}
