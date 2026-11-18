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

	embedSource, err := os.ReadFile(filepath.Join(root, "apps", "api", "internal", "web", "embed.go"))
	if err != nil {
		t.Fatalf("read embed.go: %v", err)
	}
	if !strings.Contains(string(embedSource), "//go:embed all:dist") {
		t.Error("apps/api/internal/web/embed.go does not embed all:dist")
	}

	dockerfile, err := os.ReadFile(filepath.Join(root, "deploy", "docker", "api.Dockerfile"))
	if err != nil {
		t.Fatalf("read api.Dockerfile: %v", err)
	}
	text := string(dockerfile)
	for _, want := range []string{
		"AS web",
		"COPY apps/web ./",
		"npm run build",
		"COPY --from=web /web/dist ./apps/api/internal/web/dist",
	} {
		if !strings.Contains(text, want) {
			t.Errorf("api.Dockerfile is missing %q", want)
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
