### Task 1: 濯掍綋鍖垮悕璇昏鐩栫珯鐐硅璁℃枃妗?
椤甸潰缂栨帓閲岀殑鍥剧墖鐢ㄧ殑鏄?`purpose=content` 鐨勮祫浜э紝鑰屽尶鍚嶈鍙斁琛?琚凡鍙戝竷鏂囩珷姝ｆ枃鎻愬埌杩?鐨?璧勪骇锛坄contentstore/store.go:346-368`锛夈€傚彧琚〉闈㈠尯鍧楀紩鐢ㄧ殑鍥剧墖锛岃瀹細鎷垮埌 404銆?
**Files:**
- Create: `apps/api/internal/infrastructure/sitestore/design_reference.go`
- Test: `apps/api/internal/infrastructure/sitestore/design_reference_test.go`
- Modify: `apps/api/internal/media/service.go:33-40,70-118,316-338`
- Modify: `apps/api/cmd/server/main.go:136-146`

**Interfaces:**
- Produces: `media.DesignReferenceChecker` 鎺ュ彛锛坄DesignAssetReference(ctx, siteID, assetID) (bool, error)`锛夈€?- Produces: `media.ServiceConfig.Design` 瀛楁锛堝彲閫夛紱nil 琛ㄧず涓嶅惎鐢級銆?- Produces: `sitestore.NewDesignReferences(client *entgen.Client) *DesignReferences`锛?  婊¤冻 `media.DesignReferenceChecker`銆?- Produces: `sitestore.DocumentMentionsAsset(document []byte, assetID string) bool`鈥斺€旂函鍑芥暟锛屽崟娴嬪叆鍙ｃ€?
- [ ] **Step 1: 鍐欏け璐ユ祴璇?*

鏂板缓 `apps/api/internal/infrastructure/sitestore/design_reference_test.go`锛?
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

- [ ] **Step 2: 璺戞祴璇曠‘璁ゅけ璐?*

```bash
go test ./apps/api/internal/infrastructure/sitestore/ -run TestDocumentMentionsAsset -v
```

Expected: FAIL 鈥斺€?`undefined: DocumentMentionsAsset`銆?
- [ ] **Step 3: 鍐欏疄鐜?*

鏂板缓 `apps/api/internal/infrastructure/sitestore/design_reference.go`锛?
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
// published article mentions 鈥?an image used only by a page block still has to load
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
			// 娌℃湁淇濆瓨杩囪璁＄殑绔欑偣锛氱紦瀛樹竴涓┖鏂囨。锛岄伩鍏嶆瘡娆¤姹傞兘鎵撳簱銆?			document = nil
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

> 鑻?`FirstDocument` 鐢熸垚鐨勬柟娉曞悕涓?Ent 鐗堟湰涓嶇锛岀敤
> `Query().Only(ctx)` 鍚庡彇 `row.Document`鈥斺€旇涔夌浉鍚岋紝鍒负姝ゅ紩鏂颁緷璧栥€?
- [ ] **Step 4: 璺戞祴璇曠‘璁ら€氳繃**

```bash
go test ./apps/api/internal/infrastructure/sitestore/ -run TestDocumentMentionsAsset -v
go build ./apps/api/...
```

Expected: 娴嬭瘯 PASS锛岀紪璇戦€氳繃銆?
- [ ] **Step 5: 鎺ュ埌 media 鏈嶅姟**

鍦?`apps/api/internal/media/service.go` 鐨?`PublishedReferenceChecker` 涔嬪悗杩藉姞锛?
```go
// DesignReferenceChecker reports whether a site's saved page-builder design mentions
// the asset. A content asset used only by a page block is not in any article body,
// so the published rule above cannot see it; this is the second chance.
type DesignReferenceChecker interface {
	DesignAssetReference(ctx context.Context, siteID, assetID string) (bool, error)
}
```

`Service` 缁撴瀯浣撳姞瀛楁锛坄references` 涔嬪悗锛夛細`design DesignReferenceChecker`锛?`ServiceConfig` 鍔狅紙`References` 涔嬪悗锛夛細

```go
	// Design lets a content image referenced only by the page builder load for an
	// anonymous visitor. Nil keeps the previous behaviour.
	Design DesignReferenceChecker
```

`NewService` 鐨勮繑鍥炲€奸噷鍔?`design: cfg.Design,`銆?
鎶?`authorizeSharedAsset` 鐨?`PurposeContent` 鍒嗘敮鏇挎崲涓猴細

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

- [ ] **Step 6: 鎺ョ嚎**

鍦?`apps/api/cmd/server/main.go` 鐨?`media.NewService(...)` 閲屽姞涓€琛岋細

```go
		Design:     sitestore.NewDesignReferences(handle.Client),
```

import 鍖鸿ˉ `"github.com/practacu/practacu-press/apps/api/internal/infrastructure/sitestore"`銆?
- [ ] **Step 7: 楠岃瘉璇箟鏈彉**

```bash
go test ./apps/api/internal/media/... ./apps/api/internal/site/... -v 2>&1 | tail -40
go build ./apps/api/...
```

Expected: 鏃㈡湁 media / site 娴嬭瘯鍏ㄧ豢锛坄Design: nil` 鐨勮€佽矾寰勮涓轰笉鍙橈級锛岀紪璇戦€氳繃銆?
- [ ] **Step 8: 鎻愪氦**

```bash
git add apps/api/internal/infrastructure/sitestore/design_reference.go \
  apps/api/internal/infrastructure/sitestore/design_reference_test.go \
  apps/api/internal/media/service.go apps/api/cmd/server/main.go
git commit -m "fix(api): let an anonymous reader fetch an image referenced by the site design"
```

---

