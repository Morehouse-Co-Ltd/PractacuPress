package citests

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestFrontendIsEmbedded keeps the single-binary contract: the Go package owns
// the //go:embed directive, and the API image copies the built SPA into that
// package before compiling. Without this, the default compose stack would start
// an API that returns 404 for every page.
func TestFrontendIsEmbedded(t *testing.T) {
	root := repoRoot(t)

	embedSource, err := os.ReadFile(filepath.Join(root, "internal", "web", "embed.go"))
	if err != nil {
		t.Fatalf("read embed.go: %v", err)
	}
	if !strings.Contains(string(embedSource), "//go:embed all:dist") {
		t.Error("internal/web/embed.go does not embed all:dist")
	}

	dockerfile, err := os.ReadFile(filepath.Join(root, "Dockerfile"))
	if err != nil {
		t.Fatalf("read Dockerfile: %v", err)
	}
	text := string(dockerfile)
	for _, want := range []string{
		"AS web",
		"COPY web ./",
		"npm run build",
		"COPY --from=web /web/dist ./internal/web/dist",
	} {
		if !strings.Contains(text, want) {
			t.Errorf("Dockerfile is missing %q", want)
		}
	}

	compose, err := os.ReadFile(filepath.Join(root, "docker-compose.yml"))
	if err != nil {
		t.Fatalf("read docker-compose.yml: %v", err)
	}
	if !strings.Contains(string(compose), `"127.0.0.1:${PP_HTTP_PORT:-8080}:8080"`) {
		t.Error("compose must publish the API (which serves the embedded SPA) on 8080")
	}
	if strings.Contains(string(compose), "web:") {
		t.Error("compose must not define a separate web service; the API serves the embedded SPA")
	}
}

// TestReleaseShipsOneBinary keeps the operator commands inside the server binary.
//
// migrate / seed / backup / media-gc / searchindex used to be separate executables
// in every package. Shipping five extra binaries meant five more files that could
// drift from the API they maintain, and the Docker image advertised
// `practacu-press migrate` while the server never parsed a subcommand. The release
// must build cmd/server exactly once and let the installer call subcommands of that
// same file.
func TestReleaseShipsOneBinary(t *testing.T) {
	root := repoRoot(t)

	read := func(relative string) string {
		t.Helper()
		data, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(relative)))
		if err != nil {
			t.Fatalf("read %s: %v", relative, err)
		}
		return string(data)
	}

	server := read("cmd/server/main.go")
	for _, want := range []string{"operator.Known(command)", "operator.Run(command, os.Args[2:])"} {
		if !strings.Contains(server, want) {
			t.Errorf("cmd/server/main.go is missing %q; the server no longer dispatches subcommands", want)
		}
	}

	dockerfile := read("Dockerfile")
	if !strings.Contains(dockerfile, "-o /out/practacu-press ./cmd/server") {
		t.Error("Dockerfile must build cmd/server as /out/practacu-press")
	}
	if !strings.Contains(dockerfile, "http://127.0.0.1:8080/api/healthz") {
		t.Error("Dockerfile healthcheck must probe /api/healthz; /healthz is not a route and marks every container unhealthy")
	}
	for _, unwanted := range []string{
		"./cmd/migrate", "./cmd/seed", "./cmd/backup", "./cmd/media-gc", "./cmd/searchindex",
	} {
		if strings.Contains(dockerfile, unwanted) {
			t.Errorf("Dockerfile still builds %s; the image must ship one binary", unwanted)
		}
	}

	for _, script := range []string{
		"scripts/package-linux.mjs",
		"scripts/package-macos.mjs",
	} {
		body := read(script)
		if !strings.Contains(body, "'./cmd/server'") {
			t.Errorf("%s must build ./cmd/server", script)
		}
		for _, unwanted := range []string{
			"practacu-migrate", "practacu-seed", "practacu-backup",
			"practacu-media-gc", "practacu-searchindex",
		} {
			if strings.Contains(body, unwanted) {
				t.Errorf("%s still stages %s as a separate binary", script, unwanted)
			}
		}
	}

	installer := read("deploy/linux/install.sh")
	if !strings.Contains(installer, `"$INSTALL_DIR/bin/practacu-press" seed`) {
		t.Error("install.sh must seed through the single binary's seed subcommand")
	}
	if strings.Contains(installer, "bin/practacu-seed") {
		t.Error("install.sh still expects a separate practacu-seed binary")
	}
}

// TestRepositoryHasSingleBackendEntrypoint keeps the source tree as consolidated
// as the release: cmd/server is the only main package, and every maintenance
// command is a subcommand of it rather than a sibling binary.
func TestRepositoryHasSingleBackendEntrypoint(t *testing.T) {
	root := repoRoot(t)
	entries, err := os.ReadDir(filepath.Join(root, "cmd"))
	if err != nil {
		t.Fatalf("read cmd: %v", err)
	}
	if len(entries) != 1 || entries[0].Name() != "server" || !entries[0].IsDir() {
		var names []string
		for _, entry := range entries {
			names = append(names, entry.Name())
		}
		t.Fatalf("cmd/ must contain only server, found %v; move the command into operator and dispatch it from cmd/server", names)
	}
}
