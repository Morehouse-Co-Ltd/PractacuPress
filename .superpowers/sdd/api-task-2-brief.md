### Task 2: 璁捐鏂囨。鏉′欢璇锋眰锛圗Tag / 304锛?
**Files:**
- Modify: `apps/api/internal/site/handler.go:498-533`
- Test: `apps/api/internal/site/customization_etag_test.go`锛堟柊寤猴級

**Interfaces:**
- Produces: `customizationETag(revision int, document []byte) string`鈥斺€斿甫寮曞彿鐨勫己 ETag銆?- Produces: `ifNoneMatchHit(header, etag string) bool`鈥斺€旀敮鎸侀€楀彿鍒嗛殧鍒楄〃涓?`*`銆?
- [ ] **Step 1: 鍐欏け璐ユ祴璇?*

鏂板缓 `apps/api/internal/site/customization_etag_test.go`锛?
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

- [ ] **Step 2: 璺戞祴璇曠‘璁ゅけ璐?*

```bash
go test ./apps/api/internal/site/ -run 'TestCustomizationETag|TestIfNoneMatchHit' -v
```

Expected: FAIL 鈥斺€?`undefined: customizationETag`銆?
- [ ] **Step 3: 鍐欏疄鐜?*

鍦?`apps/api/internal/site/handler.go` 鐨?`GetCustomization` 涔嬪墠鎻掑叆锛坕mport 琛?`crypto/sha256`銆乣encoding/hex`銆乣strings`锛夛細

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

鎶?`GetCustomization` 閲?`c.JSON(http.StatusOK, ...)` 涔嬪墠鐨勫嚑琛屾敼鎴愶細

```go
	etag := customizationETag(customization.Revision, customization.Document)
	c.Header("Cache-Control", "no-cache")
	c.Header("ETag", etag)
	if ifNoneMatchHit(c.GetHeader("If-None-Match"), etag) {
		// 304 涓嶅甫鍝嶅簲浣擄細璁捐鏂囨。鍙兘鍑犵櫨 KB锛岃瀹簩娆¤繘绔欎笉璇ュ啀鐪嬩竴閬嶃€?		c.Status(http.StatusNotModified)
		return
	}

	c.JSON(http.StatusOK, customizationResponse{
		SiteID:        siteID,
		Revision:      customization.Revision,
		UpdatedAt:     customization.UpdatedAt,
		Customization: json.RawMessage(customization.Document),
	})
```

- [ ] **Step 4: 璺戞祴璇曚笌缂栬瘧**

```bash
go test ./apps/api/internal/site/ -run 'TestCustomizationETag|TestIfNoneMatchHit' -v
go build ./apps/api/...
```

Expected: PASS锛岀紪璇戦€氳繃銆?
- [ ] **Step 5: 纭濂戠害娌″彉**

```bash
go test ./apps/api/internal/transport/http/gin/ -run TestOpenAPI -v
```

Expected: PASS 鈥斺€?鍙槸鍔犱簡鍝嶅簲澶达紝娌℃湁鏂板璺緞鎴?schema銆?
- [ ] **Step 6: 鎻愪氦**

```bash
git add apps/api/internal/site/handler.go apps/api/internal/site/customization_etag_test.go
git commit -m "perf(api): serve the site design document with an ETag and answer 304"
```

---

