# 页面编排 v2 · P0 后端传输与媒体 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让站点设计文档能走条件请求与压缩，让页面编排里引用的图片对匿名访客可见。

**Architecture:** 三处独立的小改动，都不新增路由、不新增依赖：媒体读权限在 `media` 服务里加一条
「被站点设计文档引用」的分支（实现放 `sitestore`）；`GET /sites/{id}/customization` 加
`ETag` / `If-None-Match`；`gin` 引擎加一个标准库 gzip 中间件，并把媒体下载的缓存策略按用途分流。

**Tech Stack:** Go 1.2x + Gin + Ent；只用标准库（`compress/gzip`、`crypto/sha256`）。

**Spec:** `docs/superpowers/specs/2026-11-02-page-builder-v2-design.md`（§3.1、§4.6）

## Global Constraints

- 不新增任何 Go 依赖；只用标准库。
- **不新增路由**——`openapi_contract_test.go` 要求路由与 YAML 双向一致，本计划不动任何路径与 schema。
- 设计文档对服务端仍是不透明字节：新代码只做子串匹配，不解析 JSON 结构。
- 所有命令在仓库根目录执行；`go test ./apps/api/...` 必须全绿。
- 权限语义不变：members-only 站点对非成员返回 404 的行为必须保持（`site/handler.go:516-519`）。

---

### Task 1: 媒体匿名读覆盖站点设计文档

页面编排里的图片用的是 `purpose=content` 的资产，而匿名读只放行"被已发布文章正文提到过"的
资产（`contentstore/store.go:346-368`）。只被页面区块引用的图片，访客会拿到 404。

**Files:**
- Create: `apps/api/internal/infrastructure/sitestore/design_reference.go`
- Test: `apps/api/internal/infrastructure/sitestore/design_reference_test.go`
- Modify: `apps/api/internal/media/service.go:33-40,70-118,316-338`
- Modify: `apps/api/cmd/server/main.go:136-146`

**Interfaces:**
- Produces: `media.DesignReferenceChecker` 接口（`DesignAssetReference(ctx, siteID, assetID) (bool, error)`）。
- Produces: `media.ServiceConfig.Design` 字段（可选；nil 表示不启用）。
- Produces: `sitestore.NewDesignReferences(client *entgen.Client) *DesignReferences`，
  满足 `media.DesignReferenceChecker`。
- Produces: `sitestore.DocumentMentionsAsset(document []byte, assetID string) bool`——纯函数，单测入口。

- [ ] **Step 1: 写失败测试**

新建 `apps/api/internal/infrastructure/sitestore/design_reference_test.go`：

```go
package sitestore

import "testing"

func TestDocumentMentionsAsset(t *testing.T) {
	doc := []byte(`{"home":{"blocks":[{"type":"image","props":{"src":"/api/v1/media/01HX9"}}]}}`)

	if !DocumentMentionsAsset(doc, "01HX9") {
		t.Fatal("asset id present in the document must be reported as referenced")
	}
	if DocumentMentionsAsset(doc, "01HX8") {
		t.Fatal("unknown asset id must not be reported as referenced")
	}
	if DocumentMentionsAsset(nil, "01HX9") {
		t.Fatal("an empty document references nothing")
	}
	if DocumentMentionsAsset(doc, "") {
		t.Fatal("an empty asset id references nothing")
	}
}
```

- [ ] **Step 2: 跑测试确认失败**

```bash
go test ./apps/api/internal/infrastructure/sitestore/ -run TestDocumentMentionsAsset -v
```

Expected: FAIL —— `undefined: DocumentMentionsAsset`。

- [ ] **Step 3: 写实现**

新建 `apps/api/internal/infrastructure/sitestore/design_reference.go`：

```go
package sitestore

import (
	"bytes"
	"context"
	"sync"
	"time"

	entgen "github.com/practacu/practacu-press/apps/api/ent"
	"github.com/practacu/practacu-press/apps/api/ent/sitecustomization"
)

// designCacheTTL bounds how stale "is this asset in the site design" may be. The
// design document only changes when an administrator saves it, so a short window
// costs nothing and keeps a burst of page views from re-reading a 1 MiB blob.
const designCacheTTL = 30 * time.Second

// DocumentMentionsAsset reports whether the raw design document mentions the asset id.
//
// The server treats the document as opaque bytes everywhere else, so this stays a
// substring match on the same footing as the published-content rule. Asset ids are
// opaque ULIDs: no wildcards, no encoding surprises.
func DocumentMentionsAsset(document []byte, assetID string) bool {
	if len(document) == 0 || assetID == "" {
		return false
	}
	return bytes.Contains(document, []byte(assetID))
}

type cachedDesign struct {
	document  []byte
	revision  int
	expiresAt time.Time
}

// DesignReferences answers "does this site's saved design reference this asset".
//
// Media asks it on the anonymous read path for content-purpose assets that no
// published article mentions — an image used only by a page block still has to load
// for a logged-out visitor.
type DesignReferences struct {
	client *entgen.Client
	now    func() time.Time
	ttl    time.Duration

	mu    sync.Mutex
	cache map[string]cachedDesign
}

// NewDesignReferences returns a checker over the given Ent client.
func NewDesignReferences(client *entgen.Client) *DesignReferences {
	return &DesignReferences{
		client: client,
		now:    time.Now,
		ttl:    designCacheTTL,
		cache:  make(map[string]cachedDesign),
	}
}

// DesignAssetReference implements media.DesignReferenceChecker.
func (d *DesignReferences) DesignAssetReference(
	ctx context.Context,
	siteID string,
	assetID string,
) (bool, error) {
	if d == nil || d.client == nil || siteID == "" || assetID == "" {
		return false, nil
	}

	document, err := d.documentOf(ctx, siteID)
	if err != nil {
		return false, err
	}
	return DocumentMentionsAsset(document, assetID), nil
}

func (d *DesignReferences) documentOf(ctx context.Context, siteID string) ([]byte, error) {
	now := d.now()
	d.mu.Lock()
	if entry, ok := d.cache[siteID]; ok && now.Before(entry.expiresAt) {
		document := entry.document
		d.mu.Unlock()
		return document, nil
	}
	d.mu.Unlock()

	document, err := d.client.SiteCustomization.Query().
		Where(sitecustomization.SiteIDEQ(siteID)).
		Select(sitecustomization.FieldDocument).
		FirstDocument(ctx)
	if err != nil {
		if entgen.IsNotFound(err) {
			// 没有保存过设计的站点：缓存一个空文档，避免每次请求都打库。
			document = nil
		} else {
			return nil, err
		}
	}

	d.mu.Lock()
	d.cache[siteID] = cachedDesign{
		document:  document,
		expiresAt: now.Add(d.ttl),
	}
	d.mu.Unlock()
	return document, nil
}
```

> 若 `FirstDocument` 生成的方法名与 Ent 版本不符，用
> `Query().Only(ctx)` 后取 `row.Document`——语义相同，别为此引新依赖。

- [ ] **Step 4: 跑测试确认通过**

```bash
go test ./apps/api/internal/infrastructure/sitestore/ -run TestDocumentMentionsAsset -v
go build ./apps/api/...
```

Expected: 测试 PASS，编译通过。

- [ ] **Step 5: 接到 media 服务**

在 `apps/api/internal/media/service.go` 的 `PublishedReferenceChecker` 之后追加：

```go
// DesignReferenceChecker reports whether a site's saved page-builder design mentions
// the asset. A content asset used only by a page block is not in any article body,
// so the published rule above cannot see it; this is the second chance.
type DesignReferenceChecker interface {
	DesignAssetReference(ctx context.Context, siteID, assetID string) (bool, error)
}
```

`Service` 结构体加字段（`references` 之后）：`design DesignReferenceChecker`；
`ServiceConfig` 加（`References` 之后）：

```go
	// Design lets a content image referenced only by the page builder load for an
	// anonymous visitor. Nil keeps the previous behaviour.
	Design DesignReferenceChecker
```

`NewService` 的返回值里加 `design: cfg.Design,`。

把 `authorizeSharedAsset` 的 `PurposeContent` 分支替换为：

```go
	case PurposeContent:
		if s.references != nil {
			published, err := s.references.PublishedAssetReference(ctx, asset.SiteID, asset.ID)
			if err != nil {
				return err
			}
			if published {
				return nil
			}
		}
		if s.design != nil {
			referenced, err := s.design.DesignAssetReference(ctx, asset.SiteID, asset.ID)
			if err != nil {
				return err
			}
			if referenced {
				return nil
			}
		}
```

- [ ] **Step 6: 接线**

在 `apps/api/cmd/server/main.go` 的 `media.NewService(...)` 里加一行：

```go
		Design:     sitestore.NewDesignReferences(handle.Client),
```

import 区补 `"github.com/practacu/practacu-press/apps/api/internal/infrastructure/sitestore"`。

- [ ] **Step 7: 验证语义未变**

```bash
go test ./apps/api/internal/media/... ./apps/api/internal/site/... -v 2>&1 | tail -40
go build ./apps/api/...
```

Expected: 既有 media / site 测试全绿（`Design: nil` 的老路径行为不变），编译通过。

- [ ] **Step 8: 提交**

```bash
git add apps/api/internal/infrastructure/sitestore/design_reference.go \
  apps/api/internal/infrastructure/sitestore/design_reference_test.go \
  apps/api/internal/media/service.go apps/api/cmd/server/main.go
git commit -m "fix(api): let an anonymous reader fetch an image referenced by the site design"
```

---

### Task 2: 设计文档条件请求（ETag / 304）

**Files:**
- Modify: `apps/api/internal/site/handler.go:498-533`
- Test: `apps/api/internal/site/customization_etag_test.go`（新建）

**Interfaces:**
- Produces: `customizationETag(revision int, document []byte) string`——带引号的强 ETag。
- Produces: `ifNoneMatchHit(header, etag string) bool`——支持逗号分隔列表与 `*`。

- [ ] **Step 1: 写失败测试**

新建 `apps/api/internal/site/customization_etag_test.go`：

```go
package site

import "testing"

func TestCustomizationETag(t *testing.T) {
	a := customizationETag(3, []byte(`{"home":{"blocks":[]}}`))
	b := customizationETag(3, []byte(`{"home":{"blocks":[]}}`))
	c := customizationETag(4, []byte(`{"home":{"blocks":[]}}`))
	d := customizationETag(3, []byte(`{"home":{"blocks":[{"id":"x"}]}}`))

	if a != b {
		t.Fatal("the same revision and document must produce the same ETag")
	}
	if a == c || a == d {
		t.Fatal("a different revision or document must produce a different ETag")
	}
	if a[0] != '"' || a[len(a)-1] != '"' {
		t.Fatalf("ETag must be quoted, got %q", a)
	}
}

func TestIfNoneMatchHit(t *testing.T) {
	etag := `"abc"`
	cases := map[string]bool{
		`"abc"`:           true,
		`"zzz", "abc"`:    true,
		`W/"abc"`:         false,
		`*`:               true,
		``:                false,
		`"abcd"`:          false,
	}
	for header, want := range cases {
		if got := ifNoneMatchHit(header, etag); got != want {
			t.Fatalf("ifNoneMatchHit(%q) = %v, want %v", header, got, want)
		}
	}
}
```

- [ ] **Step 2: 跑测试确认失败**

```bash
go test ./apps/api/internal/site/ -run 'TestCustomizationETag|TestIfNoneMatchHit' -v
```

Expected: FAIL —— `undefined: customizationETag`。

- [ ] **Step 3: 写实现**

在 `apps/api/internal/site/handler.go` 的 `GetCustomization` 之前插入（import 补
`crypto/sha256`、`encoding/hex`、`strings`）：

```go
// customizationETag derives a strong ETag from the revision and the document bytes.
//
// The document is the whole design: theme, pages, blocks, custom CSS. Visitors fetch it
// on every page load, so a 304 is worth far more than caching a few hundred kilobytes.
func customizationETag(revision int, document []byte) string {
	sum := sha256.Sum256(document)
	fingerprint := hex.EncodeToString(sum[:16])
	return fmt.Sprintf("\"%d-%s\"", revision, fingerprint)
}

// ifNoneMatchHit reports whether the request already holds that ETag.
func ifNoneMatchHit(header, etag string) bool {
	header = strings.TrimSpace(header)
	if header == "" {
		return false
	}
	if header == "*" {
		return true
	}
	for _, candidate := range strings.Split(header, ",") {
		if strings.TrimSpace(candidate) == etag {
			return true
		}
	}
	return false
}
```

把 `GetCustomization` 里 `c.JSON(http.StatusOK, ...)` 之前的几行改成：

```go
	etag := customizationETag(customization.Revision, customization.Document)
	c.Header("Cache-Control", "no-cache")
	c.Header("ETag", etag)
	if ifNoneMatchHit(c.GetHeader("If-None-Match"), etag) {
		// 304 不带响应体：设计文档可能几百 KB，访客二次进站不该再看一遍。
		c.Status(http.StatusNotModified)
		return
	}

	c.JSON(http.StatusOK, customizationResponse{
		SiteID:        siteID,
		Revision:      customization.Revision,
		UpdatedAt:     customization.UpdatedAt,
		Customization: json.RawMessage(customization.Document),
	})
```

- [ ] **Step 4: 跑测试与编译**

```bash
go test ./apps/api/internal/site/ -run 'TestCustomizationETag|TestIfNoneMatchHit' -v
go build ./apps/api/...
```

Expected: PASS，编译通过。

- [ ] **Step 5: 确认契约没变**

```bash
go test ./apps/api/internal/transport/http/gin/ -run TestOpenAPI -v
```

Expected: PASS —— 只是加了响应头，没有新增路径或 schema。

- [ ] **Step 6: 提交**

```bash
git add apps/api/internal/site/handler.go apps/api/internal/site/customization_etag_test.go
git commit -m "perf(api): serve the site design document with an ETag and answer 304"
```

---

### Task 3: gzip 中间件与媒体缓存策略

**Files:**
- Create: `apps/api/internal/transport/http/gin/middleware/gzip.go`
- Test: `apps/api/internal/transport/http/gin/middleware/gzip_test.go`
- Modify: `apps/api/internal/transport/http/gin/router.go:34-41`
- Modify: `apps/api/internal/media/handler.go:182-185`

**Interfaces:**
- Produces: `middleware.Gzip()` gin 中间件。
- Produces: `media.cacheControlFor(purpose Purpose) string`。

- [ ] **Step 1: 写失败测试**

新建 `apps/api/internal/transport/http/gin/middleware/gzip_test.go`：

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
		c.JSON(http.StatusOK, gin.H{"body": strings.Repeat("设计", 500)})
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
	if !strings.Contains(string(body), "设计") {
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

- [ ] **Step 2: 跑测试确认失败**

```bash
go test ./apps/api/internal/transport/http/gin/middleware/ -run TestGzip -v
```

Expected: FAIL —— `undefined: Gzip`。

- [ ] **Step 3: 写中间件**

新建 `apps/api/internal/transport/http/gin/middleware/gzip.go`：

```go
package middleware

import (
	"compress/gzip"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
)

// streamingPrefixes 是长连接端点：压缩会缓冲，等于把事件流掐死。
var streamingPrefixes = []string{"/api/v1/events", "/api/v1/ws"}

// gzipWriter 只在真的写了 body 时才收尾；204 / 304 不允许带 body，
// 也就不允许带 gzip 帧。
type gzipWriter struct {
	gin.ResponseWriter
	writer *gzip.Writer
	skip   bool
	wrote  bool
}

func (w *gzipWriter) WriteHeader(code int) {
	// 必须在底层 Header 落盘之前删掉 Content-Encoding：304 带 gzip 头是协议错误。
	if code < http.StatusOK || code == http.StatusNoContent || code == http.StatusNotModified {
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

- [ ] **Step 4: 跑测试确认通过**

```bash
go test ./apps/api/internal/transport/http/gin/middleware/ -v
```

Expected: 三个 gzip 用例 PASS，既有中间件用例不回归。

- [ ] **Step 5: 挂到引擎**

在 `apps/api/internal/transport/http/gin/router.go` 的 `r.Use(...)` 列表里，
`middleware.SecurityHeaders(),` 之后加一行：

```go
		// Compression runs after the security headers so a 304 or an error still
		// carries them; it sits before handlers so every JSON body benefits.
		middleware.Gzip(),
```

- [ ] **Step 6: 媒体缓存策略按用途分流**

在 `apps/api/internal/media/handler.go` 的下载处理函数里，把：

```go
	c.Header("Cache-Control", "private, max-age=300")
```

换成：

```go
	c.Header("Cache-Control", cacheControlFor(asset.Purpose))
```

并在同文件底部加：

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

> 该处作用域里已有 `asset Asset`（同一函数刚用它取存储键与 MIME type）。若变量名不同，
> 按实际名字替换，不要为此改变函数签名。

- [ ] **Step 7: 全量验证**

```bash
go build ./apps/api/... && go test ./apps/api/... 2>&1 | tail -30
```

Expected: 全部 PASS（含 `openapi_contract_test.go`——本计划没有新增路由）。

- [ ] **Step 8: 手工确认 304 与 gzip**

```bash
go run ./apps/api/cmd/server/ 2>/dev/null &
sleep 2
curl -s -o /dev/null -D - -H 'Accept-Encoding: gzip' http://127.0.0.1:8080/api/v1/sites/1/customization | head -20
```

Expected: 响应头里同时有 `ETag:` 与 `Content-Encoding: gzip`（若此前从未保存过设计则返回 404，
先跑一遍安装指引再验证）。

- [ ] **Step 9: 提交**

```bash
git add apps/api/internal/transport/http/gin/middleware/gzip.go \
  apps/api/internal/transport/http/gin/middleware/gzip_test.go \
  apps/api/internal/transport/http/gin/router.go apps/api/internal/media/handler.go
git commit -m "perf(api): gzip JSON responses and cache public media at the edge"
```

---

## Self-Review

**Spec 覆盖检查**

| 规格条目 | 落在哪个 Task |
| --- | --- |
| §3.1 媒体匿名读覆盖站点设计 | Task 1 |
| §4.6-1 ETag / If-None-Match / 304 | Task 2 |
| §4.6-2 API 端 gzip | Task 3 |
| §4.6-3 媒体缓存按用途分流 | Task 3 |
| §4.6 「不新增依赖、不新增路由」 | 三个 Task 均满足 |

**占位符扫描**：无 TBD；Task 1 Step 3 的 `FirstDocument` 与 Task 3 Step 6 的变量名各有一处
「若与实际生成代码不符」的说明——这是 Ent 生成方法名与作用域变量的客观不确定性，
给了等价的替代写法，不是"以后再说"。

**类型一致性**：`DesignReferenceChecker` / `DesignAssetReference` / `NewDesignReferences` /
`DocumentMentionsAsset` / `customizationETag` / `ifNoneMatchHit` / `Gzip` / `cacheControlFor`
各自只定义一次，前后引用一致。
