// Package apidocs embeds the self-hosted API reference page.
//
// The page is plain HTML, CSS and JavaScript because the deployment keeps a strict
// Content-Security-Policy (`script-src 'self'`) and must work without a CDN: an API
// reference that needs an internet connection is useless on the desktop build.
package apidocs

import (
	"embed"
	"fmt"
)

//go:embed index.html app.css app.js
var files embed.FS

// Read returns one embedded asset by its base name.
//
// Only the three files compiled into the package exist, so a caller cannot ask for
// an arbitrary path and an unknown name is a programming error rather than a 404.
func Read(name string) ([]byte, error) {
	data, err := files.ReadFile(name)
	if err != nil {
		return nil, fmt.Errorf("apidocs: read %q: %w", name, err)
	}
	return data, nil
}
