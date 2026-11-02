package media

import (
	"net/http"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

// TestCacheControlForPurpose pins the cache policy split: site images and avatars are
// part of the public design and may live in a shared cache, while content and attachment
// assets must stay private because a published article can be withdrawn.
func TestCacheControlForPurpose(t *testing.T) {
	for _, tc := range []struct {
		purpose Purpose
		want    string
	}{
		{PurposeSite, "public, max-age=31536000, immutable"},
		{PurposeAvatar, "public, max-age=31536000, immutable"},
		{PurposeContent, "private, max-age=300"},
		{PurposeAttachment, "private, max-age=300"},
		{Purpose(""), "private, max-age=300"},
		{Purpose("something-new"), "private, max-age=300"},
	} {
		require.Equal(t, tc.want, cacheControlFor(tc.purpose), string(tc.purpose))
	}
}

// downloadEngine serves one seeded asset through the download route for its owner.
func downloadEngine(t *testing.T, purpose Purpose) (*gin.Engine, string) {
	t.Helper()
	gin.SetMode(gin.TestMode)

	repo := newFakeRepo()
	storage := newTestStorage(t)
	asset := seedAssetWithBytes(t, repo, storage, "s1", "u1", purpose, ScanClean)
	service := newServiceWithReferences(t, repo, newFakeReferences(), storage)

	handler := NewHandler(service, HandlerConfig{
		Principal: func(*gin.Context) (Actor, bool) { return ownerActor(), true },
	})

	r := gin.New()
	handler.Routes(r, func(c *gin.Context) { c.Next() }, func(c *gin.Context) { c.Next() })
	return r, asset.ID
}

// TestDownloadAssetSendsThePurposeCachePolicy ties the header on the wire to the policy:
// a public site image is cacheable at the edge, an article image is not.
func TestDownloadAssetSendsThePurposeCachePolicy(t *testing.T) {
	for _, tc := range []struct {
		purpose Purpose
		want    string
	}{
		{PurposeSite, "public, max-age=31536000, immutable"},
		{PurposeAvatar, "public, max-age=31536000, immutable"},
		{PurposeContent, "private, max-age=300"},
	} {
		r, id := downloadEngine(t, tc.purpose)

		w := do(r, http.MethodGet, "/media/"+id, "")

		require.Equal(t, http.StatusOK, w.Code, w.Body.String())
		require.Equal(t, tc.want, w.Header().Get("Cache-Control"), string(tc.purpose))
		// The download is still private data for the owner: the type is fixed by the
		// stored asset and the browser must not sniff another one.
		require.Equal(t, "nosniff", w.Header().Get("X-Content-Type-Options"))
	}
}
