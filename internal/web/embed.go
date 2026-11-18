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
	"os"
	"path"
	"sync"
)

//go:embed all:dist
var embedded embed.FS

var (
	distMu    sync.RWMutex
	dist      fs.FS
	localDist fs.FS
)

func init() {
	sub, err := fs.Sub(embedded, "dist")
	if err != nil {
		// The embed directive guarantees the directory exists; a failure here is
		// a programming error rather than a runtime condition.
		panic("web: embedded dist is missing: " + err.Error())
	}
	dist = sub
}

// Dist returns the active frontend tree: the embedded build when present, or a
// development-only directory registered with UseDir.
func Dist() fs.FS {
	distMu.RLock()
	defer distMu.RUnlock()
	if hasIndex(dist) {
		return dist
	}
	if localDist != nil {
		return localDist
	}
	return dist
}

// UseDir registers a built frontend on disk for local development. Production
// builds always use the embedded copy; this keeps `go run` usable in GoLand
// without recompiling the binary after every frontend build.
func UseDir(dir string) error {
	info, err := os.Stat(path.Join(dir, "index.html"))
	if err != nil {
		return err
	}
	if info.IsDir() {
		return &os.PathError{Op: "open", Path: path.Join(dir, "index.html"), Err: os.ErrInvalid}
	}
	distMu.Lock()
	localDist = os.DirFS(dir)
	distMu.Unlock()
	return nil
}

// Available reports whether a frontend can be served.
func Available() bool {
	return hasIndex(Dist())
}

func hasIndex(fsys fs.FS) bool {
	if fsys == nil {
		return false
	}
	info, err := fs.Stat(fsys, "index.html")
	return err == nil && !info.IsDir()
}
