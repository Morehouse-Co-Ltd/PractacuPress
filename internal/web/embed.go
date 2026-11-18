// Package web serves the built frontend from inside the Go binary.
//
// The repository keeps only a placeholder in dist/ so `go build ./...` works on
// a fresh checkout. Every release/package build first copies web/dist here;
// `//go:embed all:dist` then puts the real SPA into the API binary. This is what
// lets the container and the native packages run without a separate web server.
package web

import (
	"embed"
	"io/fs"
)

//go:embed all:dist
var embedded embed.FS

var dist fs.FS

func init() {
	sub, err := fs.Sub(embedded, "dist")
	if err != nil {
		// The embed directive guarantees the directory exists; a failure here is
		// a programming error rather than a runtime condition.
		panic("web: embedded dist is missing: " + err.Error())
	}
	dist = sub
}

// Dist returns the embedded frontend tree.
func Dist() fs.FS { return dist }

// Available reports whether a real frontend was embedded. A fresh checkout only
// has dist/.gitkeep, which is enough to compile but cannot serve the SPA.
func Available() bool {
	info, err := fs.Stat(dist, "index.html")
	return err == nil && !info.IsDir()
}
