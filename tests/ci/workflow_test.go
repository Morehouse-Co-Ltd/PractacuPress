// Package citests keeps the repository's delivery configuration honest without a
// network or a Docker daemon. It runs as part of `go test ./...` on every
// platform, so a broken workflow, an unpinned action or a drifted Compose file
// fails the same way locally as it does in CI.
package citests

import (
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

// Known action repositories allowed in the workflow. Anything else has to be
// reviewed and added here deliberately.
var allowedActions = map[string]bool{
	"actions/checkout":        true,
	"actions/setup-go":        true,
	"actions/setup-node":      true,
	"actions/upload-artifact": true,
}

// actionRef accepts tags such as @v7, @v7.0.1 or a full commit SHA, and rejects
// floating branches like @main. Action refs only ever use the two-part
// owner/repository form in this workflow.
var actionRef = regexp.MustCompile(`^([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)@(v[0-9]+(?:\.[0-9]+){0,2}|[0-9a-f]{40})$`)

func TestWorkflowStructure(t *testing.T) {
	root := repoRoot(t)
	workflow := loadYAML(t, filepath.Join(root, ".github", "workflows", "ci.yml"))

	if scalar(lookup(workflow, "name")) == "" {
		t.Error("workflow has no name")
	}

	// Triggers.
	triggers := lookup(workflow, "on")
	if triggers == nil || triggers.Kind != yaml.MappingNode {
		t.Fatalf("workflow has no on: mapping")
	}
	for _, trigger := range []string{"push", "pull_request", "workflow_dispatch"} {
		if lookup(triggers, trigger) == nil {
			t.Errorf("workflow is missing the %q trigger", trigger)
		}
	}

	// Least privilege and duplicate-run cancellation.
	if permissions := lookup(workflow, "permissions"); permissions == nil {
		t.Error("workflow has no top-level permissions block")
	} else if got := scalar(lookup(permissions, "contents")); got != "read" {
		t.Errorf("permissions.contents = %q, want %q", got, "read")
	}
	concurrency := lookup(workflow, "concurrency")
	if concurrency == nil {
		t.Error("workflow has no concurrency block")
	} else {
		if scalar(lookup(concurrency, "group")) == "" {
			t.Error("concurrency.group is empty")
		}
		if !isTrue(lookup(concurrency, "cancel-in-progress")) {
			t.Error("concurrency.cancel-in-progress must be true")
		}
	}

	jobs := lookup(workflow, "jobs")
	if jobs == nil || jobs.Kind != yaml.MappingNode {
		t.Fatalf("workflow has no jobs mapping")
	}
	jobNames := mappingKeys(jobs)
	expectedJobs := []string{"go", "web", "migrations", "config"}
	for _, want := range expectedJobs {
		if !contains(jobNames, want) {
			t.Errorf("workflow is missing job %q (have %v)", want, jobNames)
		}
	}

	usedActions := map[string]bool{}
	for _, jobName := range jobNames {
		job := lookup(jobs, jobName)
		t.Run("job/"+jobName, func(t *testing.T) {
			if scalar(lookup(job, "runs-on")) == "" {
				t.Errorf("job %s has no runs-on", jobName)
			}
			if timeout := intValue(lookup(job, "timeout-minutes")); timeout <= 0 || timeout > 60 {
				t.Errorf("job %s timeout-minutes = %d, want 1..60", jobName, timeout)
			}

			steps := sequence(lookup(job, "steps"))
			if len(steps) == 0 {
				t.Fatalf("job %s has no steps", jobName)
			}
			hasFailureArtifact := false
			for index, step := range steps {
				uses := scalar(lookup(step, "uses"))
				if uses != "" {
					match := actionRef.FindStringSubmatch(uses)
					if match == nil {
						t.Errorf("job %s step %d uses unpinned or malformed action %q", jobName, index+1, uses)
					} else {
						usedActions[match[1]] = true
						if !allowedActions[match[1]] {
							t.Errorf("job %s uses unvetted action %q", jobName, match[1])
						}
					}
					if strings.HasPrefix(uses, "actions/upload-artifact@") {
						hasFailureArtifact = true
						if !strings.Contains(scalar(lookup(step, "if")), "failure()") {
							t.Errorf("job %s upload-artifact step must set if: failure()", jobName)
						}
						with := lookup(step, "with")
						if scalar(lookup(with, "name")) == "" || scalar(lookup(with, "path")) == "" {
							t.Errorf("job %s upload-artifact step needs name and path", jobName)
						}
					}
				}

				run := scalar(lookup(step, "run"))
				if strings.Contains(run, "scripts/ci/verify.sh") || strings.Contains(run, "scripts/verify.ps1") {
					if intValue(lookup(step, "timeout-minutes")) <= 0 {
						t.Errorf("job %s step %d runs verification without a step timeout", jobName, index+1)
					}
					logged := strings.Contains(run, ".ci-logs")
					if !logged {
						t.Errorf("job %s step %d does not retain logs under .ci-logs", jobName, index+1)
					}
				}
			}
			if !hasFailureArtifact {
				t.Errorf("job %s has no upload-artifact step for failure logs", jobName)
			}
		})
	}

	for _, action := range []string{"actions/checkout", "actions/setup-go", "actions/setup-node", "actions/upload-artifact"} {
		if !usedActions[action] {
			t.Errorf("workflow never uses %s", action)
		}
	}
}

func TestGoMatrixAndCaching(t *testing.T) {
	root := repoRoot(t)
	workflow := loadYAML(t, filepath.Join(root, ".github", "workflows", "ci.yml"))
	jobs := lookup(workflow, "jobs")
	goJob := lookup(jobs, "go")
	if goJob == nil {
		t.Fatal("no go job")
	}

	matrix := lookup(lookup(goJob, "strategy"), "matrix")
	var runners []string
	for _, entry := range sequence(lookup(matrix, "include")) {
		if osName := scalar(lookup(entry, "os")); osName != "" {
			runners = append(runners, osName)
		}
	}
	for _, want := range []string{"ubuntu-latest", "windows-latest"} {
		if !contains(runners, want) {
			t.Errorf("go matrix runners = %v, want %s", runners, want)
		}
	}

	var hasGoCache, hasLinuxRun, hasWindowsRun bool
	for _, step := range sequence(lookup(goJob, "steps")) {
		uses := scalar(lookup(step, "uses"))
		if strings.HasPrefix(uses, "actions/setup-go@") {
			with := lookup(step, "with")
			if scalar(lookup(with, "go-version-file")) != "go.mod" {
				t.Error("setup-go must read go-version-file: go.mod")
			}
			if !isTrue(lookup(with, "cache")) && scalar(lookup(with, "cache")) != "true" {
				t.Error("setup-go must enable the module/build cache")
			}
			hasGoCache = true
		}
		condition := scalar(lookup(step, "if"))
		run := scalar(lookup(step, "run"))
		if condition == "runner.os == 'Linux'" && strings.Contains(run, "scripts/ci/verify.sh go") {
			hasLinuxRun = true
		}
		if condition == "runner.os == 'Windows'" && strings.Contains(run, "scripts/verify.ps1 -Task go") {
			hasWindowsRun = true
		}
	}
	if !hasGoCache {
		t.Error("go job does not configure actions/setup-go caching")
	}
	if !hasLinuxRun {
		t.Error("go job has no Linux step calling scripts/ci/verify.sh go")
	}
	if !hasWindowsRun {
		t.Error("go job has no Windows step calling scripts/verify.ps1 -Task go")
	}
}

func TestWebJob(t *testing.T) {
	root := repoRoot(t)
	workflow := loadYAML(t, filepath.Join(root, ".github", "workflows", "ci.yml"))
	webJob := lookup(lookup(workflow, "jobs"), "web")
	if webJob == nil {
		t.Fatal("no web job")
	}

	var hasNodeSetup, hasWebRun bool
	for _, step := range sequence(lookup(webJob, "steps")) {
		uses := scalar(lookup(step, "uses"))
		if strings.HasPrefix(uses, "actions/setup-node@") {
			with := lookup(step, "with")
			if got := scalar(lookup(with, "node-version")); got != "22" {
				t.Errorf("setup-node node-version = %q, want 22 (matches deploy/docker/api.Dockerfile)", got)
			}
			if scalar(lookup(with, "cache")) != "npm" {
				t.Error("setup-node must cache npm")
			}
			if !strings.Contains(scalar(lookup(with, "cache-dependency-path")), "web/package-lock.json") {
				t.Error("setup-node cache-dependency-path must point at web/package-lock.json")
			}
			hasNodeSetup = true
		}
		if run := scalar(lookup(step, "run")); strings.Contains(run, "scripts/ci/verify.sh web") {
			if got := scalar(lookup(lookup(step, "env"), "PP_WEB_INSTALL")); got != "ci" {
				t.Errorf("web verification step must set PP_WEB_INSTALL=ci, got %q", got)
			}
			hasWebRun = true
		}
	}
	if !hasNodeSetup {
		t.Error("web job does not use actions/setup-node")
	}
	if !hasWebRun {
		t.Error("web job does not call scripts/ci/verify.sh web")
	}
}

func TestMigrationServices(t *testing.T) {
	root := repoRoot(t)
	workflow := loadYAML(t, filepath.Join(root, ".github", "workflows", "ci.yml"))
	job := lookup(lookup(workflow, "jobs"), "migrations")
	if job == nil {
		t.Fatal("no migrations job")
	}

	services := lookup(job, "services")
	if services == nil {
		t.Fatal("migrations job has no services")
	}
	for _, service := range []string{"mysql", "postgres"} {
		node := lookup(services, service)
		if node == nil {
			t.Errorf("migrations job has no %s service", service)
			continue
		}
		image := scalar(lookup(node, "image"))
		if image == "" {
			t.Errorf("%s service has no image", service)
		}
		if strings.HasSuffix(image, ":latest") || !strings.Contains(image, ":") {
			t.Errorf("%s service image %q must be pinned to a major version", service, image)
		}
		if !strings.Contains(scalar(lookup(node, "options")), "--health-cmd") {
			t.Errorf("%s service has no container health check", service)
		}
	}

	env := lookup(job, "env")
	for _, key := range []string{"PP_TEST_MYSQL_DSN", "PP_TEST_POSTGRES_DSN", "PP_MIGRATE_MYSQL_DSN", "PP_MIGRATE_POSTGRES_DSN"} {
		if scalar(lookup(env, key)) == "" {
			t.Errorf("migrations job does not set %s", key)
		}
	}

	var run string
	for _, step := range sequence(lookup(job, "steps")) {
		run += scalar(lookup(step, "run"))
	}
	if !strings.Contains(run, "scripts/ci/verify.sh migrations") {
		t.Error("migrations job does not call scripts/ci/verify.sh migrations")
	}
}

func TestConfigJob(t *testing.T) {
	root := repoRoot(t)
	workflow := loadYAML(t, filepath.Join(root, ".github", "workflows", "ci.yml"))
	job := lookup(lookup(workflow, "jobs"), "config")
	if job == nil {
		t.Fatal("no config job")
	}
	var run string
	for _, step := range sequence(lookup(job, "steps")) {
		run += scalar(lookup(step, "run"))
	}
	if !strings.Contains(run, "scripts/ci/verify.sh config") {
		t.Error("config job does not call scripts/ci/verify.sh config")
	}
}

// TestLocalParity checks that the same checks can be reproduced on a developer
// machine without CI, which is the point of the scripts/ wrappers.
func TestLocalParity(t *testing.T) {
	root := repoRoot(t)
	bashScript := filepath.Join(root, "scripts", "ci", "verify.sh")
	psScript := filepath.Join(root, "scripts", "verify.ps1")

	for _, path := range []string{bashScript, psScript} {
		data, err := os.ReadFile(path)
		if err != nil {
			t.Errorf("read %s: %v", path, err)
			continue
		}
		text := string(data)
		for _, task := range []string{"go", "web", "migrations", "config"} {
			if !strings.Contains(text, task) {
				t.Errorf("%s does not expose the %q task", filepath.Base(path), task)
			}
		}
	}

	ps := string(mustRead(t, psScript))
	if !strings.Contains(ps, "$ErrorActionPreference = 'Stop'") {
		t.Error("scripts/verify.ps1 must stop on the first error")
	}
	bash := string(mustRead(t, bashScript))
	if !strings.Contains(bash, "set -euo pipefail") {
		t.Error("scripts/ci/verify.sh must use set -euo pipefail")
	}

	makefile := string(mustRead(t, filepath.Join(root, "Makefile")))
	for _, target := range []string{"\nverify:", "\nverify-go:", "\nverify-web:", "\nverify-migrations:", "\nverify-config:", "\nci:"} {
		if !strings.Contains(makefile, target) {
			t.Errorf("Makefile is missing target %q", strings.TrimSuffix(strings.TrimPrefix(target, "\n"), ":"))
		}
	}
}

func TestComposeConfiguration(t *testing.T) {
	root := repoRoot(t)
	compose := loadYAML(t, filepath.Join(root, "docker-compose.yml"))
	services := lookup(compose, "services")
	if services == nil {
		t.Fatal("docker-compose.yml has no services")
	}
	for _, service := range []string{"api"} {
		if lookup(services, service) == nil {
			t.Errorf("docker-compose.yml has no %s service", service)
		}
	}

	api := lookup(services, "api")
	if test := lookup(lookup(api, "healthcheck"), "test"); test == nil {
		t.Error("api service has no healthcheck")
	} else if !scalarsContain(test, "healthz") {
		t.Error("api healthcheck does not probe /api/healthz")
	}
	if ports := lookup(lookup(services, "api"), "ports"); ports == nil || !scalarsContain(ports, "8080") {
		t.Error("api service must publish the embedded frontend/API on 8080")
	}

	// One compose file serves local, production and prebuilt-image deployments.
	// The production switches must be interpolation expressions, not hardcoded
	// development values, and the image must be selectable for release runs.
	apiEnv := lookup(api, "environment")
	for key, want := range map[string]string{
		"APP_ENV":                    "development",
		"PP_DESKTOP":                 "true",
		"COOKIE_SECURE":              "false",
		"PP_FIRST_ADMIN_TRUST_PROXY": "1",
	} {
		got := scalar(lookup(apiEnv, key))
		if !strings.Contains(got, "${") || !strings.Contains(got, want) {
			t.Errorf("api %s = %q, want an interpolation default containing %q", key, got, want)
		}
	}
	if got := scalar(lookup(api, "image")); !strings.Contains(got, "PP_IMAGE") {
		t.Errorf("api image = %q, want PP_IMAGE override for published images", got)
	}
	if files := lookup(api, "env_file"); files == nil || !scalarsContain(files, ".env.prod") {
		t.Error("api env_file must allow the optional .env.prod production file")
	}

	// Every build context must point at a Dockerfile that exists in the repo.
	for _, file := range dockerfileRefs(t, compose) {
		if _, err := os.Stat(filepath.Join(root, filepath.FromSlash(file))); err != nil {
			t.Errorf("compose references missing Dockerfile %s", file)
		}
	}

	// There is deliberately only one compose file; overlays caused drift.
	for _, name := range []string{"docker-compose.prod.yml", "docker-compose.release.yml"} {
		if _, err := os.Stat(filepath.Join(root, name)); err == nil {
			t.Errorf("%s must not exist; use docker-compose.yml with env overrides", name)
		}
	}
}

func TestDockerComposeHasNoFloatingImages(t *testing.T) {
	root := repoRoot(t)
	doc := loadYAML(t, filepath.Join(root, "docker-compose.yml"))
	walkScalars(doc, func(value string) {
		if strings.HasPrefix(value, "docker.io/") || (strings.Contains(value, ":") && strings.HasSuffix(value, ":latest")) {
			t.Errorf("docker-compose.yml pins a floating image %q", value)
		}
	})
}

func dockerfileRefs(t *testing.T, doc *yaml.Node) []string {
	t.Helper()
	var refs []string
	walkScalars(doc, func(value string) {
		if strings.HasSuffix(value, ".Dockerfile") {
			refs = append(refs, value)
		}
	})
	sort.Strings(refs)
	return refs
}

// --- YAML node helpers -------------------------------------------------------

func repoRoot(t *testing.T) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot locate the test file")
	}
	return filepath.Clean(filepath.Join(filepath.Dir(file), "..", ".."))
}

func loadYAML(t *testing.T, path string) *yaml.Node {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	var document yaml.Node
	if err := yaml.Unmarshal(data, &document); err != nil {
		t.Fatalf("%s is not valid YAML: %v", path, err)
	}
	if len(document.Content) == 0 || document.Content[0].Kind != yaml.MappingNode {
		t.Fatalf("%s does not contain a top-level mapping", path)
	}
	return document.Content[0]
}

func lookup(node *yaml.Node, key string) *yaml.Node {
	if node == nil || node.Kind != yaml.MappingNode {
		return nil
	}
	for i := 0; i+1 < len(node.Content); i += 2 {
		if node.Content[i].Value == key {
			return node.Content[i+1]
		}
	}
	return nil
}

func scalar(node *yaml.Node) string {
	if node == nil || node.Kind != yaml.ScalarNode {
		return ""
	}
	return node.Value
}

func sequence(node *yaml.Node) []*yaml.Node {
	if node == nil || node.Kind != yaml.SequenceNode {
		return nil
	}
	return node.Content
}

func mappingKeys(node *yaml.Node) []string {
	if node == nil || node.Kind != yaml.MappingNode {
		return nil
	}
	var keys []string
	for i := 0; i+1 < len(node.Content); i += 2 {
		keys = append(keys, node.Content[i].Value)
	}
	return keys
}

func intValue(node *yaml.Node) int {
	value, err := strconv.Atoi(scalar(node))
	if err != nil {
		return 0
	}
	return value
}

func isTrue(node *yaml.Node) bool {
	if node == nil {
		return false
	}
	return node.Value == "true" || node.Tag == "!!bool" && node.Value == "true"
}

func contains(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}

func scalarsContain(node *yaml.Node, want string) bool {
	found := false
	walkScalars(node, func(value string) {
		if strings.Contains(value, want) {
			found = true
		}
	})
	return found
}

func walkScalars(node *yaml.Node, visit func(string)) {
	if node == nil {
		return
	}
	switch node.Kind {
	case yaml.ScalarNode:
		visit(node.Value)
	case yaml.SequenceNode, yaml.DocumentNode:
		for _, child := range node.Content {
			walkScalars(child, visit)
		}
	case yaml.MappingNode:
		for i := 0; i+1 < len(node.Content); i += 2 {
			walkScalars(node.Content[i+1], visit)
		}
	}
}

func mustRead(t *testing.T, path string) []byte {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return data
}
