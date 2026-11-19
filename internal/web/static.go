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
	return ServeFS(c, Dist())
}

// CanServe reports whether the path would be handled by the embedded frontend,
// without writing a response. The rate limiter uses it to keep page loads and
// hashed assets out of the API request budget.
func CanServe(fsys fs.FS, method, requestPath string) bool {
	_, ok := resolveTarget(fsys, method, requestPath)
	return ok
}

// ServeFS is Serve with an injectable filesystem, used by tests.
func ServeFS(c *gin.Context, fsys fs.FS) bool {
	target, ok := resolveTarget(fsys, c.Request.Method, c.Request.URL.Path)
	if !ok {
		return false
	}
	return serveFile(c, fsys, target.name, target.urlPath)
}

type staticTarget struct {
	name    string
	urlPath string
}

func resolveTarget(fsys fs.FS, method, requestPath string) (staticTarget, bool) {
	if fsys == nil || (method != http.MethodGet && method != http.MethodHead) {
		return staticTarget{}, false
	}
	if requestPath == "" {
		requestPath = "/"
	}
	if strings.ContainsAny(requestPath, "\\\x00") {
		return staticTarget{}, false
	}
	for _, segment := range strings.Split(requestPath, "/") {
		if segment == ".." {
			return staticTarget{}, false
		}
	}

	clean := path.Clean(requestPath)
	if !strings.HasPrefix(clean, "/") {
		clean = "/" + clean
	}
	if reserved(clean) {
		return staticTarget{}, false
	}

	rel := strings.TrimPrefix(clean, "/")
	if rel == "" {
		return indexTarget(fsys)
	}
	if !fs.ValidPath(rel) {
		return staticTarget{}, false
	}

	info, err := fs.Stat(fsys, rel)
	if err == nil {
		if info.IsDir() {
			// A directory is not an SPA route with a document; only serve a nested
			// index.html when the build actually has one.
			index := path.Join(rel, "index.html")
			if nested, nestedErr := fs.Stat(fsys, index); nestedErr == nil && !nested.IsDir() {
				return staticTarget{name: index, urlPath: "/index.html"}, true
			}
			return staticTarget{}, false
		}
		return staticTarget{name: rel, urlPath: clean}, true
	}

	// Missing files with an extension are real 404s. Falling back to index.html for
	// them would turn a typo /assets/app.js into an HTML response with a JS MIME
	// type, which is exactly the kind of error a cache then keeps serving.
	if path.Ext(clean) != "" {
		return staticTarget{}, false
	}
	return indexTarget(fsys)
}

func indexTarget(fsys fs.FS) (staticTarget, bool) {
	info, err := fs.Stat(fsys, "index.html")
	if err != nil || info.IsDir() {
		return staticTarget{}, false
	}
	return staticTarget{name: "index.html", urlPath: "/index.html"}, true
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

// reserved paths belong to the API, the control plane, monitoring or per-site
// crawler/feed handlers. They must never fall through to index.html, even when
// the route does not exist.
func reserved(urlPath string) bool {
	for _, prefix := range []string{"/api", "/plugins", "/__pp", "/metrics", "/healthz", "/readyz"} {
		if urlPath == prefix || strings.HasPrefix(urlPath, prefix+"/") {
			return true
		}
	}
	switch urlPath {
	case "/sitemap.xml", "/robots.txt", "/rss.xml", "/atom.xml", "/feed.xml":
		return true
	}
	if strings.HasPrefix(urlPath, "/category/") || strings.HasPrefix(urlPath, "/tag/") {
		if strings.HasSuffix(urlPath, "/rss.xml") || strings.HasSuffix(urlPath, "/atom.xml") {
			return true
		}
	}
	return false
}
