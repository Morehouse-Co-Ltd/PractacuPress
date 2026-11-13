### Task 3: gzip 涓棿浠朵笌濯掍綋缂撳瓨绛栫暐

**Files:**
- Create: `apps/api/internal/transport/http/gin/middleware/gzip.go`
- Test: `apps/api/internal/transport/http/gin/middleware/gzip_test.go`
- Modify: `apps/api/internal/transport/http/gin/router.go:34-41`
- Modify: `apps/api/internal/media/handler.go:182-185`

**Interfaces:**
- Produces: `middleware.Gzip()` gin 涓棿浠躲€?- Produces: `media.cacheControlFor(purpose Purpose) string`銆?
- [ ] **Step 1: 鍐欏け璐ユ祴璇?*

鏂板缓 `apps/api/internal/transport/http/gin/middleware/gzip_test.go`锛?
```go
package middleware

import (
	"compress/gzip"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestGzipCompressesJSON(t *testing.T) {
	gin.SetMode(gin.TestMode)
	engine := gin.New()
	engine.Use(Gzip())
	engine.GET("/api/v1/x", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"body": strings.Repeat("璁捐", 500)})
	})

	req := httptest.NewRequest(http.MethodGet, "/api/v1/x", nil)
	req.Header.Set("Accept-Encoding", "gzip")
	rec := httptest.NewRecorder()
	engine.ServeHTTP(rec, req)

	if got := rec.Header().Get("Content-Encoding"); got != "gzip" {
		t.Fatalf("Content-Encoding = %q, want gzip", got)
	}
	reader, err := gzip.NewReader(rec.Body)
	if err != nil {
		t.Fatalf("response is not valid gzip: %v", err)
	}
	defer reader.Close()
	body, err := io.ReadAll(reader)
	if err != nil {
		t.Fatalf("read gzip body: %v", err)
	}
	if !strings.Contains(string(body), "璁捐") {
		t.Fatalf("decompressed body lost its content: %q", string(body))
	}
}

func TestGzipSkipsWhenNotAccepted(t *testing.T) {
	gin.SetMode(gin.TestMode)
	engine := gin.New()
	engine.Use(Gzip())
	engine.GET("/api/v1/x", func(c *gin.Context) { c.String(http.StatusOK, "plain") })

	rec := httptest.NewRecorder()
	engine.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/v1/x", nil))
	if rec.Header().Get("Content-Encoding") != "" {
		t.Fatal("must not compress when the client did not ask for it")
	}
}

func TestGzipSkipsEventStream(t *testing.T) {
	gin.SetMode(gin.TestMode)
	engine := gin.New()
	engine.Use(Gzip())
	engine.GET("/api/v1/events", func(c *gin.Context) { c.String(http.StatusOK, "stream") })

	req := httptest.NewRequest(http.MethodGet, "/api/v1/events", nil)
	req.Header.Set("Accept-Encoding", "gzip")
	rec := httptest.NewRecorder()
	engine.ServeHTTP(rec, req)
	if rec.Header().Get("Content-Encoding") != "" {
		t.Fatal("long-lived streaming endpoints must not be buffered through gzip")
	}
}
```

- [ ] **Step 2: 璺戞祴璇曠‘璁ゅけ璐?*

```bash
go test ./apps/api/internal/transport/http/gin/middleware/ -run TestGzip -v
```

Expected: FAIL 鈥斺€?`undefined: Gzip`銆?
- [ ] **Step 3: 鍐欎腑闂翠欢**

鏂板缓 `apps/api/internal/transport/http/gin/middleware/gzip.go`锛?
```go
package middleware

import (
	"compress/gzip"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
)

// streamingPrefixes 鏄暱杩炴帴绔偣锛氬帇缂╀細缂撳啿锛岀瓑浜庢妸浜嬩欢娴佹帎姝汇€?var streamingPrefixes = []string{"/api/v1/events", "/api/v1/ws"}

// gzipWriter 鍙湪鐪熺殑鍐欎簡 body 鏃舵墠鏀跺熬锛?04 / 304 涓嶅厑璁稿甫 body锛?// 涔熷氨涓嶅厑璁稿甫 gzip 甯с€?type gzipWriter struct {
	gin.ResponseWriter
	writer *gzip.Writer
	skip   bool
	wrote  bool
}

func (w *gzipWriter) WriteHeader(code int) {
	// 蹇呴』鍦ㄥ簳灞?Header 钀界洏涔嬪墠鍒犳帀 Content-Encoding锛?04 甯?gzip 澶存槸鍗忚閿欒銆?	if code < http.StatusOK || code == http.StatusNoContent || code == http.StatusNotModified {
		w.skip = true
		w.Header().Del("Content-Encoding")
	}
	w.ResponseWriter.WriteHeader(code)
}

func (w *gzipWriter) Write(data []byte) (int, error) {
	if w.skip {
		return w.ResponseWriter.Write(data)
	}
	w.wrote = true
	return w.writer.Write(data)
}

func (w *gzipWriter) Close() error {
	if w.skip || !w.wrote {
		return nil
	}
	return w.writer.Close()
}

// Gzip compresses API responses with the standard library.
//
// The API process serves the site design document (up to 1 MiB) on every page load;
// only the container deployment had a proxy compressing it, so the desktop build sent
// the whole thing as plain text. Streaming, upgraded and body-less responses are skipped.
func Gzip() gin.HandlerFunc {
	return func(c *gin.Context) {
		if !strings.Contains(c.GetHeader("Accept-Encoding"), "gzip") {
			c.Next()
			return
		}
		for _, prefix := range streamingPrefixes {
			if strings.HasPrefix(c.Request.URL.Path, prefix) {
				c.Next()
				return
			}
		}
		if c.GetHeader("Upgrade") != "" {
			c.Next()
			return
		}

		c.Header("Content-Encoding", "gzip")
		c.Header("Vary", "Accept-Encoding")
		c.Header("Content-Length", "")
		c.Writer.Header().Del("Content-Length")

		writer := &gzipWriter{ResponseWriter: c.Writer, writer: gzip.NewWriter(c.Writer)}
		c.Writer = writer
		c.Next()
		if err := writer.Close(); err != nil {
			_ = c.Error(err)
		}
	}
}
```

- [ ] **Step 4: 璺戞祴璇曠‘璁ら€氳繃**

```bash
go test ./apps/api/internal/transport/http/gin/middleware/ -v
```

Expected: 涓変釜 gzip 鐢ㄤ緥 PASS锛屾棦鏈変腑闂翠欢鐢ㄤ緥涓嶅洖褰掋€?
- [ ] **Step 5: 鎸傚埌寮曟搸**

鍦?`apps/api/internal/transport/http/gin/router.go` 鐨?`r.Use(...)` 鍒楄〃閲岋紝
`middleware.SecurityHeaders(),` 涔嬪悗鍔犱竴琛岋細

```go
		// Compression runs after the security headers so a 304 or an error still
		// carries them; it sits before handlers so every JSON body benefits.
		middleware.Gzip(),
```

- [ ] **Step 6: 濯掍綋缂撳瓨绛栫暐鎸夌敤閫斿垎娴?*

鍦?`apps/api/internal/media/handler.go` 鐨勪笅杞藉鐞嗗嚱鏁伴噷锛屾妸锛?
```go
	c.Header("Cache-Control", "private, max-age=300")
```

鎹㈡垚锛?
```go
	c.Header("Cache-Control", cacheControlFor(asset.Purpose))
```

骞跺湪鍚屾枃浠跺簳閮ㄥ姞锛?
```go
// cacheControlFor keeps public site assets cacheable at the edge while leaving content
// and attachments private: a published article can be withdrawn, its images must not
// stay in a shared cache forever.
func cacheControlFor(purpose Purpose) string {
	switch purpose {
	case PurposeSite, PurposeAvatar:
		return "public, max-age=31536000, immutable"
	default:
		return "private, max-age=300"
	}
}
```

> 璇ュ浣滅敤鍩熼噷宸叉湁 `asset Asset`锛堝悓涓€鍑芥暟鍒氱敤瀹冨彇瀛樺偍閿笌 MIME type锛夈€傝嫢鍙橀噺鍚嶄笉鍚岋紝
> 鎸夊疄闄呭悕瀛楁浛鎹紝涓嶈涓烘鏀瑰彉鍑芥暟绛惧悕銆?
- [ ] **Step 7: 鍏ㄩ噺楠岃瘉**

```bash
go build ./apps/api/... && go test ./apps/api/... 2>&1 | tail -30
```

Expected: 鍏ㄩ儴 PASS锛堝惈 `openapi_contract_test.go`鈥斺€旀湰璁″垝娌℃湁鏂板璺敱锛夈€?
- [ ] **Step 8: 鎵嬪伐纭 304 涓?gzip**

```bash
go run ./apps/api/cmd/server/ 2>/dev/null &
sleep 2
curl -s -o /dev/null -D - -H 'Accept-Encoding: gzip' http://127.0.0.1:8080/api/v1/sites/1/customization | head -20
```

Expected: 鍝嶅簲澶撮噷鍚屾椂鏈?`ETag:` 涓?`Content-Encoding: gzip`锛堣嫢姝ゅ墠浠庢湭淇濆瓨杩囪璁″垯杩斿洖 404锛?鍏堣窇涓€閬嶅畨瑁呮寚寮曞啀楠岃瘉锛夈€?
- [ ] **Step 9: 鎻愪氦**

```bash
git add apps/api/internal/transport/http/gin/middleware/gzip.go \
  apps/api/internal/transport/http/gin/middleware/gzip_test.go \
  apps/api/internal/transport/http/gin/router.go apps/api/internal/media/handler.go
git commit -m "perf(api): gzip JSON responses and cache public media at the edge"
```

---

