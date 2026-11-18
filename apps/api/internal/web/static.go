package web

import (
	"bytes"
	"io/fs"
	"mime"
	"net/http"
	"path"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

// Serve attempts to answer a request from the embedded SPA. It reports false for
// anything that is not a static file or an SPA navigation, so the caller can fall
// back to the API's JSON 404.
func Serve(c *gin.Context) bool {
	return ServeFS(c, dist)
}

// ServeFS is Serve with an injectable filesystem, used by tests.
func ServeFS(c *gin.Context, fsys fs.FS) bool {
	if fsys == nil || (c.Request.Method != http.MethodGet && c.Request.Method != http.MethodHead) {
		return false
	}

	requestPath := c.Request.URL.Path
	if requestPath == "" {
		requestPath = "/"
	}
	if strings.ContainsAny(requestPath, "\\\x00") {
		return false
	}
	for _, segment := range strings.Split(requestPath, "/") {
		if segment == ".." {
			return false
		}
	}

	clean := path.Clean(requestPath)
	if !strings.HasPrefix(clean, "/") {
		clean = "/" + clean
	}
	if reserved(clean) {
		return false
	}

	rel := strings.TrimPrefix(clean, "/")
	if rel == "" {
		return serveIndex(c, fsys)
	}
	if !fs.ValidPath(rel) {
		return false
	}

	info, err := fs.Stat(fsys, rel)
	if err == nil {
		if info.IsDir() {
			// A directory is not an SPA route with a document; only serve a nested
			// index.html when the build actually has one.
			index := path.Join(rel, "index.html")
			if nested, nestedErr := fs.Stat(fsys, index); nestedErr == nil && !nested.IsDir() {
				return serveFile(c, fsys, index, "/index.html")
			}
			return false
		}
		return serveFile(c, fsys, rel, clean)
	}

	// Missing files with an extension are real 404s. Falling back to index.html for
	// them would turn a typo /assets/app.js into an HTML response with a JS MIME
	// type, which is exactly the kind of error a cache then keeps serving.
	if path.Ext(clean) != "" {
		return false
	}
	return serveIndex(c, fsys)
}

func serveIndex(c *gin.Context, fsys fs.FS) bool {
	info, err := fs.Stat(fsys, "index.html")
	if err != nil || info.IsDir() {
		return false
	}
	return serveFile(c, fsys, "index.html", "/index.html")
}

func serveFile(c *gin.Context, fsys fs.FS, name, urlPath string) bool {
	data, err := fs.ReadFile(fsys, name)
	if err != nil {
		return false
	}

	header := c.Writer.Header()
	header.Set("Cache-Control", cacheControl(urlPath))
	header.Set("Content-Type", contentType(name))
	// A zero modtime avoids inventing a Last-Modified value that would make every
	// rebuild look unchanged to a conditional request.
	http.ServeContent(c.Writer, c.Request, name, time.Time{}, bytes.NewReader(data))
	return true
}

func cacheControl(urlPath string) string {
	switch {
	case strings.HasPrefix(urlPath, "/assets/"):
		return "public, max-age=31536000, immutable"
	case urlPath == "/index.html", urlPath == "/version.json", urlPath == "/theme-boot.js":
		return "no-cache"
	default:
		return "public, max-age=3600"
	}
}

func contentType(name string) string {
	switch path.Ext(name) {
	case ".html":
		return "text/html; charset=utf-8"
	case ".js", ".mjs":
		return "text/javascript; charset=utf-8"
	case ".css":
		return "text/css; charset=utf-8"
	case ".json", ".webmanifest":
		return "application/json; charset=utf-8"
	case ".svg":
		return "image/svg+xml"
	case ".woff2":
		return "font/woff2"
	case ".woff":
		return "font/woff"
	case ".ttf":
		return "font/ttf"
	case ".png":
		return "image/png"
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".webp":
		return "image/webp"
	case ".ico":
		return "image/x-icon"
	case ".txt":
		return "text/plain; charset=utf-8"
	case ".xml":
		return "application/xml; charset=utf-8"
	}
	if detected := mime.TypeByExtension(path.Ext(name)); detected != "" {
		return detected
	}
	return "application/octet-stream"
}

// reserved paths belong to the API, the control plane or monitoring. They must
// never fall through to index.html, even when the route does not exist.
func reserved(urlPath string) bool {
	for _, prefix := range []string{"/api", "/healthz", "/readyz", "/plugins", "/__pp", "/metrics"} {
		if urlPath == prefix || strings.HasPrefix(urlPath, prefix+"/") {
			return true
		}
	}
	return false
}
