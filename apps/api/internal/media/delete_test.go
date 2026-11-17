package media

import (
	"context"
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/apps/api/internal/platform/errors"
	"github.com/practacu/practacu-press/apps/api/internal/site"
)

// deleteEngine mounts the media routes over a repository, a storage adapter and an
// optional reference checker. A nil actor makes every request anonymous, which is how
// the session guard around the delete route is exercised.
func deleteEngine(
	t *testing.T,
	repo Repository,
	storage Storage,
	usage AssetUsageChecker,
	actor *Actor,
) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)

	service, err := NewService(ServiceConfig{
		Repository: repo,
		Scanner:    cleanScanner{},
		Storage:    storage,
		Usage:      usage,
		Now:        func() time.Time { return time.Date(2026, 10, 18, 12, 0, 0, 0, time.UTC) },
	})
	require.NoError(t, err)

	principal := func(*gin.Context) (Actor, bool) { return Actor{}, false }
	if actor != nil {
		fixed := *actor
		principal = func(*gin.Context) (Actor, bool) { return fixed, true }
	}
	handler := NewHandler(service, HandlerConfig{Principal: principal})

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
	return r
}

// seedOwnedAsset stores one clean asset, so a delete test can point at a row that already
// exists instead of replaying the whole upload flow.
func seedOwnedAsset(t *testing.T, repo *fakeRepo, siteID, ownerID, fileName string) Asset {
	t.Helper()

	asset, err := repo.InsertAsset(context.Background(), Asset{
		SiteID:     siteID,
		OwnerID:    ownerID,
		FileName:   fileName,
		StorageKey: fmt.Sprintf("ab/%d.png", len(repo.assets)),
		MIME:       "image/png",
		Size:       10,
		ScanStatus: ScanClean,
		Purpose:    PurposeContent,
		CreatedAt:  time.Date(2026, 10, 18, 12, 0, 0, 0, time.UTC),
	})
	require.NoError(t, err)
	return asset
}

// fakeUsage stands in for the content store on the delete path: it answers from a set of
// asset ids some item still mentions, so a test can toggle "in use" without a query. It
// also records the last call, which proves the storage key travels along.
type fakeUsage struct {
	inUse      map[string]bool
	err        error
	calls      int
	siteID     string
	assetID    string
	storageKey string
}

func newFakeUsage() *fakeUsage { return &fakeUsage{inUse: map[string]bool{}} }

func (f *fakeUsage) AssetInUse(_ context.Context, siteID, assetID, storageKey string) (bool, error) {
	f.calls++
	f.siteID, f.assetID, f.storageKey = siteID, assetID, storageKey
	if f.err != nil {
		return false, f.err
	}
	return f.inUse[assetID], nil
}

// fakeDesign is the page-builder half of the delete guard.
type fakeDesign struct {
	referenced bool
	err        error
}

func (f fakeDesign) DesignAssetReference(context.Context, string, string) (bool, error) {
	return f.referenced, f.err
}

// TestDeleteAssetReturnsNoContent pins the wire contract of the endpoint that had no
// route at all: 204 with an empty body, the variants and the object gone from storage,
// and the row gone from the library.
func TestDeleteAssetReturnsNoContent(t *testing.T) {
	repo := newFakeRepo()
	storage := &recordingStorage{name: "global"}
	asset := seedOwnedAsset(t, repo, "s1", "u1", "photo.png")
	r := deleteEngine(t, repo, storage, nil, &Actor{UserID: "u1", SiteID: "s1"})

	w := do(r, http.MethodDelete, "/media/"+asset.ID, "")

	require.Equal(t, http.StatusNoContent, w.Code, w.Body.String())
	require.Empty(t, w.Body.String(), "204 carries no body")
	require.Equal(t, 1+len(VariantWidths), storage.deletes,
		"the image variants and the original are removed through the recorded adapter")

	_, err := repo.FindAsset(context.Background(), "s1", asset.ID)
	require.ErrorIs(t, err, ErrNotFound, "the record is removed after the object")
}

// TestDeleteAssetWithdrawsARejectedUpload keeps the cleanup path open: a file that failed
// inspection is never referenceable, so its uploader must be able to get rid of it instead
// of leaving dead bytes in the quota.
func TestDeleteAssetWithdrawsARejectedUpload(t *testing.T) {
	repo := newFakeRepo()
	storage := &recordingStorage{name: "global"}
	asset := seedOwnedAsset(t, repo, "s1", "u1", "payload.png")
	repo.assets[0].ScanStatus = ScanRejected
	r := deleteEngine(t, repo, storage, nil, &Actor{UserID: "u1", SiteID: "s1"})

	w := do(r, http.MethodDelete, "/media/"+asset.ID, "")

	require.Equal(t, http.StatusNoContent, w.Code, w.Body.String())
	_, err := repo.FindAsset(context.Background(), "s1", asset.ID)
	require.ErrorIs(t, err, ErrNotFound)
}

// TestDeleteAssetHidesAnotherAccountsUpload keeps a member from confirming that someone
// else's object exists: the refusal is the same 404 a missing id produces.
func TestDeleteAssetHidesAnotherAccountsUpload(t *testing.T) {
	repo := newFakeRepo()
	storage := &recordingStorage{name: "global"}
	asset := seedOwnedAsset(t, repo, "s1", "u2", "theirs.png")
	r := deleteEngine(t, repo, storage, nil,
		&Actor{UserID: "u1", SiteID: "s1", Role: site.RoleMember})

	w := do(r, http.MethodDelete, "/media/"+asset.ID, "")

	require.Equal(t, http.StatusNotFound, w.Code, w.Body.String())
	require.Equal(t, "not_found", decodeBody(t, w)["code"])
	require.Zero(t, storage.deletes, "a refused delete touches no adapter")
	_, err := repo.FindAsset(context.Background(), "s1", asset.ID)
	require.NoError(t, err, "the row survives a refused delete")
}

// TestDeleteAssetRefusesEditorOnSomeoneElsesUpload draws the line between writing content
// and administering the site: write_content alone may not dispose of another account's
// upload, so an editor is answered exactly like a stranger.
func TestDeleteAssetRefusesEditorOnSomeoneElsesUpload(t *testing.T) {
	repo := newFakeRepo()
	storage := &recordingStorage{name: "global"}
	asset := seedOwnedAsset(t, repo, "s1", "u2", "theirs.png")
	r := deleteEngine(t, repo, storage, nil,
		&Actor{UserID: "u1", SiteID: "s1", Role: site.RoleEditor})

	w := do(r, http.MethodDelete, "/media/"+asset.ID, "")

	require.Equal(t, http.StatusNotFound, w.Code, w.Body.String())
	require.Zero(t, storage.deletes)
	_, err := repo.FindAsset(context.Background(), "s1", asset.ID)
	require.NoError(t, err)
}

// TestDeleteAssetAllowsSiteAdmin covers the administrative case: an administrator clears
// up media another account uploaded, which is the routine reason a library needs a delete
// button at all.
func TestDeleteAssetAllowsSiteAdmin(t *testing.T) {
	repo := newFakeRepo()
	storage := &recordingStorage{name: "global"}
	asset := seedOwnedAsset(t, repo, "s1", "u2", "theirs.png")
	r := deleteEngine(t, repo, storage, nil,
		&Actor{UserID: "admin-1", SiteID: "s1", Role: site.RoleSiteAdmin})

	w := do(r, http.MethodDelete, "/media/"+asset.ID, "")

	require.Equal(t, http.StatusNoContent, w.Code, w.Body.String())
	_, err := repo.FindAsset(context.Background(), "s1", asset.ID)
	require.ErrorIs(t, err, ErrNotFound)
}

// TestDeleteAssetHonoursLiveCapabilityMatrix pins which authority decides once the
// transport passes the caller's matrix along: the matrix, not the role. A group that
// grants both capabilities may delete another account's upload, and one that kept
// write_content but revoked manage_site may not.
func TestDeleteAssetHonoursLiveCapabilityMatrix(t *testing.T) {
	granted := site.PermissionSet{
		site.CapabilityWriteContent: true,
		site.CapabilityManageSite:   true,
	}
	revoked := site.PermissionSet{
		site.CapabilityWriteContent: true,
		site.CapabilityManageSite:   false,
	}

	t.Run("explicit grant", func(t *testing.T) {
		repo := newFakeRepo()
		storage := &recordingStorage{name: "global"}
		asset := seedOwnedAsset(t, repo, "s1", "u2", "theirs.png")
		r := deleteEngine(t, repo, storage, nil,
			&Actor{UserID: "u1", SiteID: "s1", Role: site.RoleEditor, Permissions: granted})

		w := do(r, http.MethodDelete, "/media/"+asset.ID, "")

		require.Equal(t, http.StatusNoContent, w.Code, w.Body.String())
	})

	t.Run("explicit revocation", func(t *testing.T) {
		repo := newFakeRepo()
		storage := &recordingStorage{name: "global"}
		asset := seedOwnedAsset(t, repo, "s1", "u2", "theirs.png")
		r := deleteEngine(t, repo, storage, nil,
			&Actor{UserID: "u1", SiteID: "s1", Role: site.RoleSiteAdmin, Permissions: revoked})

		w := do(r, http.MethodDelete, "/media/"+asset.ID, "")

		require.Equal(t, http.StatusNotFound, w.Code, w.Body.String())
		require.Zero(t, storage.deletes)
	})
}

// TestDeleteAssetScopesToTheCallersSite is the tenant boundary: an id belonging to another
// site is simply absent, not "present but forbidden".
func TestDeleteAssetScopesToTheCallersSite(t *testing.T) {
	repo := newFakeRepo()
	storage := &recordingStorage{name: "global"}
	foreign := seedOwnedAsset(t, repo, "s2", "u1", "elsewhere.png")
	r := deleteEngine(t, repo, storage, nil, &Actor{UserID: "u1", SiteID: "s1"})

	w := do(r, http.MethodDelete, "/media/"+foreign.ID, "")

	require.Equal(t, http.StatusNotFound, w.Code, w.Body.String())
	require.Zero(t, storage.deletes)
	_, err := repo.FindAsset(context.Background(), "s2", foreign.ID)
	require.NoError(t, err, "the other site's object is untouched")
}

// TestDeleteAssetRefusesReferencedAsset is the guard that keeps a draft or an article from
// losing its image: the request fails as a conflict and the object stays where it is.
func TestDeleteAssetRefusesReferencedAsset(t *testing.T) {
	repo := newFakeRepo()
	storage := &recordingStorage{name: "global"}
	asset := seedOwnedAsset(t, repo, "s1", "u1", "in-use.png")
	usage := newFakeUsage()
	usage.inUse[asset.ID] = true
	r := deleteEngine(t, repo, storage, usage, &Actor{UserID: "u1", SiteID: "s1"})

	w := do(r, http.MethodDelete, "/media/"+asset.ID, "")

	require.Equal(t, http.StatusConflict, w.Code, w.Body.String())
	payload := decodeBody(t, w)
	require.Equal(t, "conflict", payload["code"])
	details, ok := payload["details"].(map[string]any)
	require.True(t, ok, "the problem body carries structured details")
	require.Equal(t, "asset_in_use", details["reason"])

	require.Equal(t, 1, usage.calls, "the reference question is asked once")
	require.Equal(t, "s1", usage.siteID)
	require.Equal(t, asset.StorageKey, usage.storageKey, "the storage key is matched too")
	require.Zero(t, storage.deletes, "a referenced object must not lose its bytes")
	_, err := repo.FindAsset(context.Background(), "s1", asset.ID)
	require.NoError(t, err)
}

// TestDeleteAssetRefusesAssetEmbeddedInTheSiteDesign covers the second reference source: a
// logo or page-block image is in no article body, so only the design document names it.
func TestDeleteAssetRefusesAssetEmbeddedInTheSiteDesign(t *testing.T) {
	repo := newFakeRepo()
	storage := &recordingStorage{name: "global"}
	asset := seedOwnedAsset(t, repo, "s1", "u1", "logo.png")
	service, err := NewService(ServiceConfig{
		Repository: repo,
		Scanner:    cleanScanner{},
		Storage:    storage,
		Design:     fakeDesign{referenced: true},
	})
	require.NoError(t, err)

	err = service.DeleteAsset(context.Background(), Actor{UserID: "u1", SiteID: "s1"}, asset.ID)

	require.ErrorIs(t, err, ErrAssetInUse)
	require.Zero(t, storage.deletes)
}

// TestDeleteAssetFailsClosedWhenUsageIsUnknown keeps "I could not tell" from becoming "go
// ahead": a broken reference query refuses the delete instead of losing the object.
func TestDeleteAssetFailsClosedWhenUsageIsUnknown(t *testing.T) {
	repo := newFakeRepo()
	storage := &recordingStorage{name: "global"}
	asset := seedOwnedAsset(t, repo, "s1", "u1", "photo.png")
	usage := newFakeUsage()
	usage.err = context.DeadlineExceeded
	r := deleteEngine(t, repo, storage, usage, &Actor{UserID: "u1", SiteID: "s1"})

	w := do(r, http.MethodDelete, "/media/"+asset.ID, "")

	require.Equal(t, http.StatusInternalServerError, w.Code, w.Body.String())
	require.Zero(t, storage.deletes)
	_, err := repo.FindAsset(context.Background(), "s1", asset.ID)
	require.NoError(t, err)
}

// TestDeleteAssetRequiresSession keeps the destructive route out of reach of a reader who
// only holds a download URL.
func TestDeleteAssetRequiresSession(t *testing.T) {
	repo := newFakeRepo()
	storage := &recordingStorage{name: "global"}
	asset := seedOwnedAsset(t, repo, "s1", "u1", "photo.png")
	r := deleteEngine(t, repo, storage, nil, nil)

	w := do(r, http.MethodDelete, "/media/"+asset.ID, "")

	require.Equal(t, http.StatusUnauthorized, w.Code, w.Body.String())
	require.Equal(t, "unauthenticated", decodeBody(t, w)["code"])
	require.Zero(t, storage.deletes)
}

// TestCompleteUploadKeepsTheDeclaredFileName carries the display name from the session to
// the asset, and proves it never reaches the storage key.
func TestCompleteUploadKeepsTheDeclaredFileName(t *testing.T) {
	repo := newFakeRepo()
	service := newService(t, repo, &fakeScanner{result: ScanResult{Status: ScanClean}})
	ctx := context.Background()

	upload, err := service.CreateUpload(ctx, owner(), imageRequest())
	require.NoError(t, err)
	asset, err := service.CompleteUpload(ctx, owner(), upload.ID)
	require.NoError(t, err)

	require.Equal(t, "photo.png", asset.FileName)
	require.NotContains(t, asset.StorageKey, "photo",
		"the declared name is display only and must not shape the object key")
}
