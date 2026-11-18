// Package deploytests keeps the deployment templates honest about the browser security
// headers they ship. Nginx cannot import Go, so the policy lives in three places — the
// launcher, the docker template and the production template — and the copies drift
// silently otherwise. A drifted `frame-src` already broke the page builder once: the
// same-origin preview iframe was refused and authors saw the browser's "this content is
// blocked" page instead of their site.
package deploytests

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"testing"
)

var cspHeader = regexp.MustCompile(`Content-Security-Policy\s+"([^"]+)"`)

// cspSources splits a policy into directive name → source list, the way a browser reads
// it: directives are separated by `;`, sources by whitespace.
func cspSources(policy string) map[string][]string {
	out := map[string][]string{}
	for _, directive := range strings.Split(policy, ";") {
		fields := strings.Fields(directive)
		if len(fields) == 0 {
			continue
		}
		out[fields[0]] = fields[1:]
	}
	return out
}

func repoRoot(t *testing.T) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot locate this test file")
	}
	return filepath.Dir(filepath.Dir(filepath.Dir(file)))
}

// TestTemplatesAllowTheEditorsOwnFrames checks every Content-Security-Policy the
// deployment ships: both nginx templates, the API middleware that serves the
// embedded SPA, and the launcher's own Go constant. The launcher comment used to
// claim a three-way copy while the test only read the two files, so a
// launcher-only drift stayed green.
func TestTemplatesAllowTheEditorsOwnFrames(t *testing.T) {
	root := repoRoot(t)
	launcherPolicy, err := launcherCSP(filepath.Join(root, "apps", "launcher", "main.go"))
	if err != nil {
		t.Fatalf("read launcher policy: %v", err)
	}
	apiPolicy, err := apiCSP(filepath.Join(root, "apps", "api", "internal", "transport", "http", "gin", "middleware", "security_headers.go"))
	if err != nil {
		t.Fatalf("read API policy: %v", err)
	}
	templates := []string{
		filepath.Join(root, "deploy", "docker", "nginx.conf"),
		filepath.Join(root, "deploy", "production", "nginx.conf"),
		filepath.Join(root, "deploy", "linux", "nginx", "locations.conf.in"),
	}

	policies := []struct {
		file   string
		policy string
	}{
		{file: "apps/launcher/main.go", policy: launcherPolicy},
		{file: "apps/api/internal/transport/http/gin/middleware/security_headers.go", policy: apiPolicy},
	}

	for _, template := range templates {
		body, err := os.ReadFile(template)
		if err != nil {
			t.Fatalf("read %s: %v", template, err)
		}
		matches := cspHeader.FindAllStringSubmatch(string(body), -1)
		if len(matches) == 0 {
			t.Fatalf("%s sets no Content-Security-Policy", template)
		}
		for _, match := range matches {
			policies = append(policies, struct {
				file   string
				policy string
			}{file: template, policy: match[1]})
		}
	}

	var first, firstFile string
	for _, entry := range policies {
		policy := entry.policy
		directives := cspSources(policy)

		frameSrc, ok := directives["frame-src"]
		if !ok {
			t.Errorf("%s: policy has no frame-src directive", entry.file)
			continue
		}
		allowed := map[string]bool{}
		for _, source := range frameSrc {
			allowed[source] = true
		}
		if !allowed["'self'"] {
			t.Errorf("%s: frame-src = %v, want 'self' for the page builder preview", entry.file, frameSrc)
		}
		for _, scheme := range []string{"https:", "http:"} {
			if !allowed[scheme] {
				t.Errorf("%s: frame-src = %v, want %s for the website block", entry.file, frameSrc, scheme)
			}
		}
		if got := directives["frame-ancestors"]; len(got) != 1 || got[0] != "'self'" {
			t.Errorf("%s: frame-ancestors = %v, want [\"'self'\"]", entry.file, got)
		}
		fonts := map[string]bool{}
		for _, source := range directives["font-src"] {
			fonts[source] = true
		}
		if !fonts["'self'"] || !fonts["data:"] {
			t.Errorf("%s: font-src = %v, want 'self' and data: for the bundled maths fonts", entry.file, directives["font-src"])
		}

		// Every copy has to stay identical, otherwise one response shape carries a
		// different policy than the others.
		if first == "" {
			first, firstFile = policy, entry.file
			continue
		}
		if policy != first {
			t.Errorf("%s ships a different policy than %s", entry.file, firstFile)
		}
	}
	if len(policies) == 0 {
		t.Fatal("no Content-Security-Policy was checked")
	}
}

// launcherCSP reconstructs the contentSecurityPolicy constant from the launcher's
// Go source: it is a concatenation of quoted string literals.
var launcherCSPConst = regexp.MustCompile(`(?s)const contentSecurityPolicy\s*=\s*(.*?)\r?\n\r?\n`)
var goStringLiteral = regexp.MustCompile(`"([^"]*)"`)

func launcherCSP(path string) (string, error) {
	return goCSP(path, launcherCSPConst, "contentSecurityPolicy")
}

var apiCSPConst = regexp.MustCompile(`(?s)const ContentSecurityPolicy\s*=\s*(.*?)\r?\n\r?\n`)

func apiCSP(path string) (string, error) {
	return goCSP(path, apiCSPConst, "ContentSecurityPolicy")
}

func goCSP(path string, constRE *regexp.Regexp, name string) (string, error) {
	body, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	match := constRE.FindStringSubmatch(string(body))
	if match == nil {
		return "", fmt.Errorf("%s: %s constant not found", path, name)
	}
	var builder strings.Builder
	for _, literal := range goStringLiteral.FindAllStringSubmatch(match[1], -1) {
		builder.WriteString(literal[1])
	}
	if builder.Len() == 0 {
		return "", fmt.Errorf("%s: %s has no string literals", path, name)
	}
	return builder.String(), nil
}
