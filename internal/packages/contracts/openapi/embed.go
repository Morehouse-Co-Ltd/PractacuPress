// Package openapi embeds the cross-team OpenAPI contract so the running server
// serves exactly the document the repository ships.
//
// The YAML file stays the single source of truth: it is edited by hand (and by the
// contract tests), not generated. Embedding it here keeps the binary self-contained,
// which matters for the desktop install and for the Docker image, neither of which
// ships the repository tree.
package openapi

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"sync"

	"gopkg.in/yaml.v3"
)

//go:embed openapi.yaml
var document []byte

// YAML returns a copy of the contract source.
//
// It is a copy so a caller cannot mutate the embedded document, which is shared by
// every request.
func YAML() []byte {
	return append([]byte(nil), document...)
}

// jsonDocument converts the embedded YAML once. The conversion is lazy so a malformed
// document fails the request that needs it instead of crashing at process start;
// jsonDocument also leaves the tests free to assert on the error.
var jsonDocument = sync.OnceValues(func() ([]byte, error) {
	var spec any
	if err := yaml.Unmarshal(document, &spec); err != nil {
		return nil, fmt.Errorf("openapi: decode embedded contract: %w", err)
	}

	encoded, err := json.Marshal(spec)
	if err != nil {
		return nil, fmt.Errorf("openapi: encode embedded contract as JSON: %w", err)
	}
	return encoded, nil
})

// JSON returns the contract rendered as JSON.
//
// The returned slice is shared between callers and must be treated as read-only;
// net/http only reads it while writing the response.
func JSON() ([]byte, error) {
	return jsonDocument()
}
