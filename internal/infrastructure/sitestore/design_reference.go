package sitestore

import (
	"bytes"
	"context"
	"sync"
	"time"

	entgen "github.com/practacu/practacu-press/ent"
	"github.com/practacu/practacu-press/ent/sitecustomization"
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

// documentOf returns the site's stored design, cached for a short window.
//
// The document column is text, so the row is read through the client and converted
// once; a site that never saved a design caches an empty document instead of hitting
// the database on every request.
func (d *DesignReferences) documentOf(ctx context.Context, siteID string) ([]byte, error) {
	now := d.now()
	d.mu.Lock()
	if entry, ok := d.cache[siteID]; ok && now.Before(entry.expiresAt) {
		document := entry.document
		d.mu.Unlock()
		return document, nil
	}
	d.mu.Unlock()

	var document []byte
	row, err := d.client.SiteCustomization.Query().
		Where(sitecustomization.SiteIDEQ(siteID)).
		Only(ctx)
	if err != nil {
		if !entgen.IsNotFound(err) {
			return nil, err
		}
	} else {
		document = []byte(row.Document)
	}

	d.mu.Lock()
	d.cache[siteID] = cachedDesign{
		document:  document,
		expiresAt: now.Add(d.ttl),
	}
	d.mu.Unlock()
	return document, nil
}
