package media

import (
	"net/http"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/internal/platform/page"
	"github.com/practacu/practacu-press/internal/site"
)

// TestListAssetsReturnsPage pins the wire shape the frontend was built against: a page
// object with items, a cursor and a has_more flag, where every item carries its
// download url and no field is missing or renamed.
func TestListAssetsReturnsPage(t *testing.T) {
	repo := newFakeRepo()
	now := time.Date(2026, 10, 18, 12, 0, 0, 0, time.UTC)
	seedAsset(t, repo, "s1", PurposeContent, ScanClean, now)
	seedAsset(t, repo, "s1", PurposeAvatar, ScanRejected, now.Add(-time.Minute))
	seedAsset(t, repo, "s1", PurposeContent, ScanClean, now.Add(-2*time.Minute))

	r := newEngine(repo, &fakeScanner{}, ownerActor())

	w := do(r, http.MethodGet, "/media?limit=2", "")

	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	payload := decodeBody(t, w)
	require.Equal(t, true, payload["has_more"])
	require.NotEmpty(t, payload["next_cursor"])

	items, ok := payload["items"].([]any)
	require.True(t, ok)
	require.Len(t, items, 2)

	first, ok := items[0].(map[string]any)
	require.True(t, ok)
	require.NotEmpty(t, first["id"])
	require.NotEmpty(t, first["storage_key"])
	require.Equal(t, "image/png", first["mime_type"])
	require.Equal(t, float64(10), first["size"])
	require.Equal(t, "clean", first["scan_status"])
	require.Equal(t, "content", first["purpose"])
	require.Equal(t, "2026-10-18T12:00:00Z", first["created_at"], "newest first")
	require.Equal(t, "/api/v1/media/"+first["id"].(string), first["url"])
	require.Equal(t, "photo.png", first["file_name"],
		"the listing carries the declared display name, not the storage key")
}

// TestListAssetsLastPageCarriesNoCursor keeps the client from requesting an empty page
// at the end of the listing.
func TestListAssetsLastPageCarriesNoCursor(t *testing.T) {
	repo := newFakeRepo()
	seedAsset(t, repo, "s1", PurposeContent, ScanClean, time.Date(2026, 10, 18, 12, 0, 0, 0, time.UTC))

	r := newEngine(repo, &fakeScanner{}, ownerActor())

	w := do(r, http.MethodGet, "/media", "")

	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	payload := decodeBody(t, w)
	require.Equal(t, false, payload["has_more"])
	require.Equal(t, "", payload["next_cursor"])
	require.Len(t, payload["items"], 1)
}

// TestListAssetsScopesToCallerSite is the tenant boundary: a filter cannot widen the
// listing to another site's media.
func TestListAssetsScopesToCallerSite(t *testing.T) {
	repo := newFakeRepo()
	now := time.Date(2026, 10, 18, 12, 0, 0, 0, time.UTC)
	mine := seedAsset(t, repo, "s1", PurposeContent, ScanClean, now)
	seedAsset(t, repo, "s2", PurposeContent, ScanClean, now)

	r := newEngine(repo, &fakeScanner{}, ownerActor())

	w := do(r, http.MethodGet, "/media", "")

	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	items, ok := decodeBody(t, w)["items"].([]any)
	require.True(t, ok)
	require.Len(t, items, 1)
	require.Equal(t, mine.ID, items[0].(map[string]any)["id"])
}

// TestListAssetsFiltersNarrowThePage covers both filters and the AND between them: a
// filter that matches nothing yields an empty page rather than the whole library.
func TestListAssetsFiltersNarrowThePage(t *testing.T) {
	repo := newFakeRepo()
	now := time.Date(2026, 10, 18, 12, 0, 0, 0, time.UTC)
	content := seedAsset(t, repo, "s1", PurposeContent, ScanClean, now)
	avatar := seedAsset(t, repo, "s1", PurposeAvatar, ScanRejected, now.Add(-time.Minute))

	r := newEngine(repo, &fakeScanner{}, ownerActor())

	byPurpose := do(r, http.MethodGet, "/media?purpose=avatar", "")
	require.Equal(t, http.StatusOK, byPurpose.Code, byPurpose.Body.String())
	items, ok := decodeBody(t, byPurpose)["items"].([]any)
	require.True(t, ok)
	require.Len(t, items, 1)
	require.Equal(t, avatar.ID, items[0].(map[string]any)["id"])

	byStatus := do(r, http.MethodGet, "/media?scan_status=clean", "")
	require.Equal(t, http.StatusOK, byStatus.Code, byStatus.Body.String())
	items, ok = decodeBody(t, byStatus)["items"].([]any)
	require.True(t, ok)
	require.Len(t, items, 1)
	require.Equal(t, content.ID, items[0].(map[string]any)["id"])

	both := do(r, http.MethodGet, "/media?purpose=content&scan_status=rejected", "")
	require.Equal(t, http.StatusOK, both.Code, both.Body.String())
	items, ok = decodeBody(t, both)["items"].([]any)
	require.True(t, ok)
	require.Empty(t, items)
	require.Equal(t, false, decodeBody(t, both)["has_more"])
}

// TestListAssetsRejectsBadParameters is the contract's 400 list: a refused parameter is
// reported with its own code, never silently corrected.
func TestListAssetsRejectsBadParameters(t *testing.T) {
	cases := []struct {
		name  string
		query string
		code  string
	}{
		{name: "limit is not a number", query: "?limit=abc", code: "validation_failed"},
		{name: "limit is zero", query: "?limit=0", code: "validation_failed"},
		{name: "limit is negative", query: "?limit=-1", code: "validation_failed"},
		{name: "limit is above the ceiling", query: "?limit=101", code: "validation_failed"},
		{name: "unknown purpose", query: "?purpose=video", code: "validation_failed"},
		{name: "unknown scan status", query: "?scan_status=infected", code: "validation_failed"},
		{name: "malformed cursor", query: "?cursor=!!!", code: "invalid_cursor"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := newEngine(newFakeRepo(), &fakeScanner{}, ownerActor())

			w := do(r, http.MethodGet, "/media"+tc.query, "")

			require.Equal(t, http.StatusBadRequest, w.Code, w.Body.String())
			require.Equal(t, tc.code, decodeBody(t, w)["code"])
		})
	}
}

// TestListAssetsRejectsCursorWithoutTimestamp covers a cursor that decodes but cannot be
// used: answering with the first page instead would loop an infinite scroll forever.
func TestListAssetsRejectsCursorWithoutTimestamp(t *testing.T) {
	r := newEngine(newFakeRepo(), &fakeScanner{}, ownerActor())
	cursor := page.Cursor{Key: "yesterday", ID: "a1"}.Encode()

	w := do(r, http.MethodGet, "/media?cursor="+cursor, "")

	require.Equal(t, http.StatusBadRequest, w.Code, w.Body.String())
	require.Equal(t, "invalid_cursor", decodeBody(t, w)["code"])
}

// TestListAssetsRequiresSession keeps the library private: unlike a download, listing is
// never served to a reader without a session.
func TestListAssetsRequiresSession(t *testing.T) {
	r, _ := anonymousEngine(site.Site{}, false)

	w := do(r, http.MethodGet, "/media", "")

	require.Equal(t, http.StatusUnauthorized, w.Code, w.Body.String())
	require.Equal(t, "unauthenticated", decodeBody(t, w)["code"])
}
