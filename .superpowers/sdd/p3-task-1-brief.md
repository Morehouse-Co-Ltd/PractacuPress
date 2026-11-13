### Task 1: 鏈嶅姟绔垪琛ㄧ瓫閫夊弬鏁?
**Files:**
- Modify: `apps/api/internal/content/service.go`锛坄ListFilter` 鎵╁睍锛?- Modify: `apps/api/internal/infrastructure/contentstore/store.go`锛坄List` 鏌ヨ锛?- Modify: `apps/api/internal/content/handler.go`锛坄list` 瑙ｆ瀽 query锛?- Modify: `packages/contracts/openapi/openapi.yaml`锛坄/articles` 涓?`/posts` 鐨?parameters锛?- Test: `apps/api/internal/content/listfilter_test.go`锛堟柊寤猴級銆乣apps/api/internal/infrastructure/contentstore/store_list_test.go`锛堣嫢宸叉湁鍚岀被娴嬭瘯鍒欒拷鍔狅級

**Interfaces:**
- Produces: `ListFilter` 澧炲姞鍥涗釜瀛楁锛?
```go
type ListFilter struct {
	// 鈥︽棦鏈?SiteID / Kind / Statuses / AuthorID / After / Limit
	// CategoryID restricts the result to one category. Empty means any.
	CategoryID string
	// Tag restricts the result to items carrying this tag.
	Tag string
	// Since keeps items created at or after this instant. Zero means unbounded.
	Since time.Time
	// Sort picks the ordering: "newest" (default) or "oldest".
	Sort string
}
```

- Produces: `parseListFilter(c *gin.Context) (content.ListFilter, error)`锛坔andler 鍐呴儴锛岀函鍑芥暟鍙祴锛氭妸 query 瑙ｆ瀽鎴愮瓫閫夋潯浠讹紝闈炴硶鍊艰繑鍥?`ErrInvalidInput`锛夈€?- Produces: `content.NormalizeTag(raw string) string`鈥斺€旀爣绛惧悕褰掍竴鍖栵紙trim銆侀暱搴?鈮?40銆佹嫆缁濆惈 `"` 涓?`\` 鐨勫悕瀛楋紝杩斿洖绌轰覆琛ㄧず闈炴硶锛夈€?
- [ ] **Step 1: 鍐欏け璐ユ祴璇?*

鏂板缓 `apps/api/internal/content/listfilter_test.go`锛?
```go
package content

import (
	"testing"
	"time"
)

func TestNormalizeTag(t *testing.T) {
	cases := map[string]string{
		"  Go  ":   "Go",
		"a":        "a",
		`bad"tag`:  "",
		`bad\tag`:  "",
		"":         "",
	}
	for in, want := range cases {
		if got := NormalizeTag(in); got != want {
			t.Fatalf("NormalizeTag(%q) = %q, want %q", in, got, want)
		}
	}
	long := make([]byte, 60)
	for i := range long {
		long[i] = 'a'
	}
	if got := NormalizeTag(string(long)); len(got) > 40 {
		t.Fatalf("NormalizeTag kept %d bytes, want <= 40", len(got))
	}
}

func TestListFilterSortValidation(t *testing.T) {
	if _, err := ValidateSort("newest"); err != nil {
		t.Fatalf("newest must be valid: %v", err)
	}
	if _, err := ValidateSort(""); err != nil {
		t.Fatalf("empty must default, not fail: %v", err)
	}
	if _, err := ValidateSort("popular"); err == nil {
		t.Fatal("unsupported sort must be rejected")
	}
	_ = time.Now()
}
```

锛坄ValidateSort` 涓?`NormalizeTag` 閮芥斁 `content` 鍖咃紝鍓嶈€呰繑鍥炲綊涓€鍖栧悗鐨勬帓搴忓悕銆傦級

- [ ] **Step 2: 璺戞祴璇曠‘璁ゅけ璐?*

```bash
go test ./apps/api/internal/content/ -run 'TestNormalizeTag|TestListFilterSortValidation' -v
```

Expected: FAIL 鈥斺€?`undefined: NormalizeTag` / `ValidateSort`銆?
- [ ] **Step 3: 瀹炵幇**

- `content/service.go`锛氬姞 `NormalizeTag`銆乣ValidateSort`銆乣ListFilter` 鐨勫洓涓柊瀛楁锛沗List` 涓?  `ListAfter` 鎶婂畠浠€忎紶缁欎粨鍌ㄣ€?- `contentstore/store.go` 鐨?`List`锛歚CategoryID` 闈炵┖ 鈫?`contentitem.CategoryIDEQ(...)`锛?  `Tag` 闈炵┖ 鈫?`contentitem.TagsContains("\"" + tag + "\"")`锛堝簱閲屾槸 JSON 鏁扮粍鏂囨湰锛岀敤甯﹀紩鍙风殑绮剧‘
  token 鍖归厤锛沗NormalizeTag` 宸茬鎺夊紩鍙蜂笌鍙嶆枩鏉狅紝涓嶄細璇厤锛夛紱`Since` 闈為浂 鈫?  `contentitem.CreatedAtGTE(since)`锛沗Sort == "oldest"` 鈫?鏀规垚 `Asc`锛屽惁鍒欎繚鎸?`Desc`銆?  鍦ㄦ敞閲婇噷鍐欐槑锛歚tags` 鏄?JSON 鏂囨湰锛岀簿纭?token 鍖归厤鏄负浜嗚法 SQLite / MySQL / PostgreSQL 鍙Щ妞嶃€?- `handler.go` 鐨?`list`锛氳В鏋?`category_id`锛堚墹36 瀛楃锛夈€乣tag`锛堣蛋 `NormalizeTag`锛岄潪娉曠洿鎺?400锛夈€?  `since`锛圧FC3339锛岄潪娉?400锛夈€乣sort`锛坄ValidateSort`锛岄潪娉?400锛夛紝濉炶繘 `ListFilter`銆?
- [ ] **Step 4: 濂戠害鍚屾**

`packages/contracts/openapi/openapi.yaml` 鐨?`/articles` 涓?`/posts`锛堜袱涓?`get`锛夊悇鍔犲洓涓?query
鍙傛暟锛屽啓娉曚笌鏃㈡湁 `Limit` / `Cursor` / `AuthorID` 涓€鑷达細

```yaml
        - name: category_id
          in: query
          required: false
          description: Narrow the page to one category.
          schema: { type: string, maxLength: 36 }
        - name: tag
          in: query
          required: false
          description: Narrow the page to items carrying this tag (exact match).
          schema: { type: string, maxLength: 40 }
        - name: since
          in: query
          required: false
          description: Only items created at or after this instant (RFC 3339).
          schema: { type: string, format: date-time }
        - name: sort
          in: query
          required: false
          description: Ordering. `newest` (default) or `oldest`.
          schema: { type: string, enum: [newest, oldest] }
```

- [ ] **Step 5: 楠屾敹骞舵彁浜?*

```bash
go build ./apps/api/... && go test ./apps/api/internal/content/ ./apps/api/internal/infrastructure/contentstore/ \
  ./apps/api/internal/transport/http/gin/ 2>&1 | tail -20
git add <exact paths>
git commit -m "feat(api): filter the content list by category, tag, since and sort"
```

---

