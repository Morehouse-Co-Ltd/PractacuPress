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

	// Local compose builds pass VERSION=development. appVersion.ts parses the
	// imported manifest at boot, so writing "development" into version.json would
	// crash the SPA; only real release tags may stamp it, using the shared script.
	for _, want := range []string{
		"COPY scripts/stamp-version.mjs /tmp/stamp-version.mjs",
		`"$VERSION" != "development"`,
		`node /tmp/stamp-version.mjs --dist public --version "$VERSION"`,
	} {
		if !strings.Contains(text, want) {
			t.Errorf("Dockerfile web stage is missing %q", want)
		}
	}
	if strings.Contains(text, "j.version=") || strings.Contains(text, "j.style=") {
		t.Error("Dockerfile must not carry a second version parser; use scripts/stamp-version.mjs")
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
