// Package deploytests keeps the deployment templates honest about the browser security
// headers they ship. Nginx cannot import Go, so the policy lives in three places — the
// launcher, the docker template and the production template — and the copies drift
// silently otherwise. A drifted `frame-src` already broke the page builder once: the
// same-origin preview iframe was refused and authors saw the browser's "this content is
// blocked" page instead of their site.
package deploytests

import (
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

// TestTemplatesAllowTheEditorsOwnFrames checks every Content-Security-Policy the nginx
// templates emit. `frame-src` has to allow the same origin (the page builder previews
// the real front end in an iframe) plus https/http (the "website" block's iframe mode),
// while `frame-ancestors 'self'` keeps other sites from framing this one.
func TestTemplatesAllowTheEditorsOwnFrames(t *testing.T) {
	root := repoRoot(t)
	templates := []string{
		filepath.Join(root, "deploy", "docker", "nginx.conf"),
		filepath.Join(root, "deploy", "production", "nginx.conf"),
	}

	var first string
	var firstFile string
	seen := 0
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
			seen++
			policy := match[1]
			directives := cspSources(policy)

			frameSrc, ok := directives["frame-src"]
			if !ok {
				t.Errorf("%s: policy has no frame-src directive", template)
				continue
			}
			allowed := map[string]bool{}
			for _, source := range frameSrc {
				allowed[source] = true
			}
			if !allowed["'self'"] {
				t.Errorf("%s: frame-src = %v, want 'self' for the page builder preview", template, frameSrc)
			}
			for _, scheme := range []string{"https:", "http:"} {
				if !allowed[scheme] {
					t.Errorf("%s: frame-src = %v, want %s for the website block", template, frameSrc, scheme)
				}
			}
			if got := directives["frame-ancestors"]; len(got) != 1 || got[0] != "'self'" {
				t.Errorf("%s: frame-ancestors = %v, want [\"'self'\"]", template, got)
			}
			fonts := map[string]bool{}
			for _, source := range directives["font-src"] {
				fonts[source] = true
			}
			if !fonts["'self'"] || !fonts["data:"] {
				t.Errorf("%s: font-src = %v, want 'self' and data: for the bundled maths fonts", template, directives["font-src"])
			}

			// Every location-level copy has to stay identical to the server-level one,
			// otherwise one response shape would carry a different policy.
			if first == "" {
				first, firstFile = policy, template
				continue
			}
			if policy != first {
				t.Errorf("%s ships a different policy than %s", template, firstFile)
			}
		}
	}
	if seen == 0 {
		t.Fatal("no Content-Security-Policy was checked")
	}
}
