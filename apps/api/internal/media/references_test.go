package media

import (
	"bytes"
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/apps/api/internal/site"
)

// fakeReferences stands in for the content store on the media read path.
type fakeReferences struct {
	published map[string]bool
	err       error
	calls     int
}

func newFakeReferences() *fakeReferences {
	return &fakeReferences{published: map[string]bool{}}
}

func (f *fakeReferences) mark(siteID, assetID string) {
	f.published[siteID+"/"+assetID] = true
}

func (f *fakeReferences) PublishedAssetReference(_ context.Context, siteID, assetID string) (bool, error) {
	f.calls++
	if f.err != nil {
		return false, f.err
	}
	return f.published[siteID+"/"+assetID], nil
}

func newTestStorage(t *testing.T) *LocalStorage {
	t.Helper()
	storage, err := NewLocalStorage(t.TempDir())
	require.NoError(t, err)
	return storage
}

func newServiceWithReferences(t *testing.T, repo Repository, refs PublishedReferenceChecker, storage Storage) *Service {
	t.Helper()
	service, err := NewService(ServiceConfig{
		Repository: repo,
		Scanner:    cleanScanner{},
		Storage:    storage,
		References: refs,
		Now:        func() time.Time { return time.Date(2026, 10, 18, 12, 0, 0, 0, time.UTC) },
	})
	require.NoError(t, err)
	return service
}

// seedAssetWithBytes stores a clean asset and writes its bytes to the local adapter, so
// the read path can actually return a reader.
func seedAssetWithBytes(
	t *testing.T,
	repo *fakeRepo,
	storage Storage,
	siteID, ownerID string,
	purpose Purpose,
	status ScanStatus,
) Asset {
	t.Helper()
	payload := []byte("\x89PNG\r\n\x1a\n0123456789")
	key := fmt.Sprintf("ab/%d-%s.png", len(repo.assets), purpose)
	require.NoError(t, storage.Put(context.Background(), key, bytes.NewReader(payload), int64(len(payload))))

	asset, err := repo.InsertAsset(context.Background(), Asset{
		SiteID:     siteID,
		OwnerID:    ownerID,
		StorageKey: key,
		MIME:       "image/png",
		Size:       int64(len(payload)),
		ScanStatus: status,
		Purpose:    purpose,
		CreatedAt:  time.Date(2026, 10, 18, 12, 0, 0, 0, time.UTC),
	})
	require.NoError(t, err)
	return asset
}

// TestOpenAssetInSiteContentNeedsPublishedReference is the regression test for the media
// BOLA: an anonymous reader may load an article image once it appears in published
// content, and never before.
func TestOpenAssetInSiteContentNeedsPublishedReference(t *testing.T) {
	ctx := context.Background()
	repo := newFakeRepo()
	storage := newTestStorage(t)
	refs := newFakeReferences()

	asset := seedAssetWithBytes(t, repo, storage, "s1", "u1", PurposeContent, ScanClean)
	service := newServiceWithReferences(t, repo, refs, storage)

	_, _, err := service.OpenAssetInSite(ctx, "s1", asset.ID)
	require.ErrorIs(t, err, ErrNotFound, "an unreferenced draft image must stay private")

	refs.mark("s1", asset.ID)
	_, reader, err := service.OpenAssetInSite(ctx, "s1", asset.ID)
	require.NoError(t, err, "a published article image must load for anonymous readers")
	require.NoError(t, reader.Close())
	require.Equal(t, 2, refs.calls, "both the private and the published read consult the checker")
}

// TestOpenAssetInSiteSharesSiteImagesAndAvatars keeps the public site assets usable
// without a published content reference: they are part of the public design.
func TestOpenAssetInSiteSharesSiteImagesAndAvatars(t *testing.T) {
	ctx := context.Background()

	for _, purpose := range []Purpose{PurposeSite, PurposeAvatar} {
		repo := newFakeRepo()
		storage := newTestStorage(t)
		asset := seedAssetWithBytes(t, repo, storage, "s1", "u1", purpose, ScanClean)
		service := newServiceWithReferences(t, repo, newFakeReferences(), storage)

		_, reader, err := service.OpenAssetInSite(ctx, "s1", asset.ID)
		require.NoError(t, err, "purpose %s is public", purpose)
		require.NoError(t, reader.Close())
	}
}

// TestOpenAssetHidesOtherMembersPrivateAsset is the authenticated half of the fix: a
// member may not read someone else's attachment or unreferenced content, but the owner
// and any editor still can.
func TestOpenAssetHidesOtherMembersPrivateAsset(t *testing.T) {
	ctx := context.Background()
	repo := newFakeRepo()
	storage := newTestStorage(t)
	refs := newFakeReferences()

	attachment := seedAssetWithBytes(t, repo, storage, "s1", "someone-else", PurposeAttachment, ScanClean)
	draftImage := seedAssetWithBytes(t, repo, storage, "s1", "someone-else", PurposeContent, ScanClean)
	service := newServiceWithReferences(t, repo, refs, storage)
	readerActor := memberActor("u1")
	editorActorValue := editorActor("u1")

	for _, assetID := range []string{attachment.ID, draftImage.ID} {
		_, _, err := service.OpenAsset(ctx, readerActor, assetID)
		require.ErrorIs(t, err, ErrNotFound, "member must not read another owner's asset")
	}

	for _, assetID := range []string{attachment.ID, draftImage.ID} {
		_, rc, err := service.OpenAsset(ctx, editorActorValue, assetID)
		require.NoError(t, err, "editor reads the site library")
		require.NoError(t, rc.Close())
	}

	// Once the article is published the member may load its image, but the attachment
	// stays private: article references never publish user data files.
	refs.mark("s1", draftImage.ID)
	_, rc, err := service.OpenAsset(ctx, readerActor, draftImage.ID)
	require.NoError(t, err)
	require.NoError(t, rc.Close())
	_, _, err = service.OpenAsset(ctx, readerActor, attachment.ID)
	require.ErrorIs(t, err, ErrNotFound)
}

// TestOpenAssetInSiteRejectsUnpublishedContentWithCheckerError documents fail-closed:
// a broken reference check never turns into a public read.
func TestOpenAssetInSiteRejectsUnpublishedContentWithCheckerError(t *testing.T) {
	ctx := context.Background()
	repo := newFakeRepo()
	storage := newTestStorage(t)
	refs := newFakeReferences()
	refs.err = context.DeadlineExceeded
	asset := seedAssetWithBytes(t, repo, storage, "s1", "u1", PurposeContent, ScanClean)
	service := newServiceWithReferences(t, repo, refs, storage)

	_, _, err := service.OpenAssetInSite(ctx, "s1", asset.ID)
	require.ErrorIs(t, err, context.DeadlineExceeded)
}

func memberActor(userID string) Actor {
	return Actor{UserID: userID, SiteID: "s1", Role: site.RoleMember}
}

func editorActor(userID string) Actor {
	return Actor{UserID: userID, SiteID: "s1", Role: site.RoleEditor}
}
