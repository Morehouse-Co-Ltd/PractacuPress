package media

import (
	"bytes"
	"context"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/internal/platform/errors"
	"github.com/practacu/practacu-press/internal/site"
)

// anonymousEngine mounts the media routes with no principal at all, which is what a
// logged-out reader of a published article looks like.
func anonymousEngine(resolved site.Site, hasSite bool) (*gin.Engine, Repository) {
	gin.SetMode(gin.TestMode)

	repo := newFakeRepo()
	dir := ""
	if hasSite {
		// storage is only touched when an asset is actually opened; the tests that need
		// bytes install their own local storage below.
		_ = dir
	}

	service, err := NewService(ServiceConfig{Repository: repo, Scanner: cleanScanner{}})
	if err != nil {
		panic(err)
	}

	handler := NewHandler(service, HandlerConfig{
		Principal: func(*gin.Context) (Actor, bool) { return Actor{}, false },
		Site: func(*gin.Context) (site.Site, bool) {
			return resolved, hasSite
		},
	})

	r := gin.New()
	r.Use(func(c *gin.Context) {
		c.Next()
		if len(c.Errors) > 0 {
			problem := apperr.FromError(c.Errors.Last().Err)
			c.Header("Content-Type", apperr.ContentType)
			c.JSON(problem.Status, problem)
		}
	})
	handler.Routes(r, func(c *gin.Context) { c.Next() }, func(c *gin.Context) { c.Next() })
	return r, repo
}

// TestDownloadRejectsAnonymousReaderOnMembersOnlySite keeps a closed site's media closed:
// a logged-out visitor must not reach images through a members-only hostname.
func TestDownloadRejectsAnonymousReaderOnMembersOnlySite(t *testing.T) {
	r, _ := anonymousEngine(site.Site{ID: "s1", VisibilityMode: site.VisibilityMembersOnly}, true)

	w := do(r, "GET", "/media/a1", "")

	require.Equal(t, 401, w.Code, w.Body.String())
	require.Contains(t, w.Body.String(), "members_only_site")
}

// TestDownloadWithoutResolvedSiteIsRefused covers the deployment mistake case: no site
// resolved means there is no tenant to scope the object to, so nothing is served.
func TestDownloadWithoutResolvedSiteIsRefused(t *testing.T) {
	r, _ := anonymousEngine(site.Site{}, false)

	w := do(r, "GET", "/media/a1", "")

	require.Equal(t, 404, w.Code, w.Body.String())
}

// TestOpenAssetInSiteScopesBySite is the service level guard behind the anonymous path:
// the resolved host picks the tenant, so an asset id from another site is simply absent.
func TestOpenAssetInSiteScopesBySite(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()

	store, err := NewLocalStorage(dir)
	require.NoError(t, err)
	key := NewStorageKey("photo.png")
	payload := []byte("\x89PNG\r\n\x1a\n0123456789")
	require.NoError(t, store.Put(ctx, key, bytes.NewReader(payload), int64(len(payload))))

	repo := newFakeRepo()
	repo.assets = append(repo.assets, Asset{
		ID:         "a1",
		SiteID:     "s1",
		StorageKey: key,
		MIME:       "image/png",
		Size:       int64(len(payload)),
		ScanStatus: ScanClean,
		Purpose:    PurposeContent,
	})

	refs := newFakeReferences()
	refs.mark("s1", "a1")
	service, err := NewService(ServiceConfig{Repository: repo, Scanner: cleanScanner{}, Storage: store, References: refs})
	require.NoError(t, err)

	// The owning site reads the bytes.
	asset, reader, err := service.OpenAssetInSite(ctx, "s1", "a1")
	require.NoError(t, err)
	defer reader.Close()
	require.Equal(t, "image/png", asset.MIME)

	// Another tenant sees nothing, not even that the asset exists.
	_, _, err = service.OpenAssetInSite(ctx, "s2", "a1")
	require.ErrorIs(t, err, ErrNotFound)

	// A clean-only rule still applies to the anonymous path.
	repo.assets[0].ScanStatus = ScanRejected
	_, _, err = service.OpenAssetInSite(ctx, "s1", "a1")
	require.ErrorIs(t, err, ErrNotFound)
}

// cleanScanner reports every upload as clean; only downloads are exercised here.
type cleanScanner struct{}

func (cleanScanner) Inspect(context.Context, ScanInput) (ScanResult, error) {
	return ScanResult{Status: ScanClean, ReasonCode: "ok"}, nil
}
