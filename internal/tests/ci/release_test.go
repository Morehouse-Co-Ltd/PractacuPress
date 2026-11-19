package citests

import (
	"path/filepath"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

// TestReleaseWorkflow keeps the release pipeline structurally complete: version
// detection, both registries, both Docker architectures, and one package job per
// OS/architecture family. It is deliberately a structure test, not a build.
func TestReleaseWorkflow(t *testing.T) {
	root := repoRoot(t)
	doc := loadYAML(t, filepath.Join(root, ".github", "workflows", "release.yml"))

	jobs := lookup(doc, "jobs")
	if jobs == nil {
		t.Fatal("release workflow has no jobs mapping")
	}
	for _, name := range []string{"version", "web", "docker", "linux", "windows", "macos", "release"} {
		if lookup(jobs, name) == nil {
			t.Errorf("release workflow is missing job %q", name)
		}
	}

	permissions := lookup(doc, "permissions")
	if got := scalar(lookup(permissions, "contents")); got != "write" {
		t.Errorf("permissions.contents = %q, want write (GitHub Release)", got)
	}
	if got := scalar(lookup(permissions, "packages")); got != "write" {
		t.Errorf("permissions.packages = %q, want write (GHCR)", got)
	}

	triggers := lookup(doc, "on")
	if triggers == nil {
		t.Fatal("release workflow has no on: mapping")
	}
	push := lookup(triggers, "push")
	if push == nil {
		t.Fatal("release workflow has no push trigger")
	}
	if lookup(push, "tags") == nil {
		t.Error("push trigger must accept version tags")
	}
	if lookup(triggers, "workflow_dispatch") == nil {
		t.Error("release workflow has no workflow_dispatch trigger")
	}

	var scalars []string
	walkScalars(doc, func(value string) { scalars = append(scalars, value) })
	body := strings.Join(scalars, "\n")

	for _, want := range []string{
		"release-version.mjs",
		"stamp-version.mjs",
		"ghcr.io",
		"DOCKERHUB_USERNAME",
		"linux/amd64,linux/arm64",
		"Dockerfile",
		"nfpm package",
		"deploy/package/nfpm.yaml",
		"package-linux.mjs",
		"package-windows.mjs",
		"package-macos.mjs",
		"gh release create",
		"gh release upload",
		"SHA256SUMS",
	} {
		if !strings.Contains(body, want) {
			t.Errorf("release workflow does not reference %q", want)
		}
	}

	windows := lookup(jobs, "windows")
	windowsBody := strings.Join(collectScalars(windows), "\n")
	for _, want := range []string{"windows-2022", "windows-11-vs2026-arm", "amd64", "arm64"} {
		if !strings.Contains(windowsBody, want) {
			t.Errorf("Windows job is missing %q", want)
		}
	}

	macos := lookup(jobs, "macos")
	macosBody := strings.Join(collectScalars(macos), "\n")
	for _, want := range []string{"--arch arm64", "--arch amd64"} {
		if !strings.Contains(macosBody, want) {
			t.Errorf("macOS job is missing %q", want)
		}
	}

	// The package-linux script clears .tmp/linuxpkg per run, so the deb/rpm step
	// must be inside the same per-architecture loop as the tar.gz assembly.
	linux := lookup(jobs, "linux")
	linuxBody := strings.Join(collectScalars(linux), "\n")
	if !strings.Contains(linuxBody, "for arch in amd64 arm64") {
		t.Error("Linux job must build each architecture's tar.gz and packages together")
	}
}

func collectScalars(node *yaml.Node) []string {
	values := make([]string, 0)
	walkScalars(node, func(value string) { values = append(values, value) })
	return values
}
