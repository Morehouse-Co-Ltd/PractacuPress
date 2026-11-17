package content

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	apperr "github.com/practacu/practacu-press/apps/api/internal/platform/errors"
	"github.com/practacu/practacu-press/apps/api/internal/site"
)

// clock is a mutable service clock, so the retention sweep can be tested without
// waiting thirty days for a row to expire.
type clock struct{ at time.Time }

func (c *clock) now() time.Time { return c.at }

func (c *clock) advance(d time.Duration) { c.at = c.at.Add(d) }

// newTrashService builds a service over the fake repository with a movable clock.
func newTrashService(t *testing.T, repo Repository) (*Service, *clock) {
	t.Helper()
	tick := &clock{at: time.Date(2026, 10, 18, 12, 0, 0, 0, time.UTC)}
	service, err := NewService(ServiceConfig{
		Repository: repo,
		Sanitizer:  okSanitizer(),
		PublishMode: func(context.Context, string) (site.PublishMode, error) {
			return site.PublishModeOpen, nil
		},
		Now: tick.now,
	})
	require.NoError(t, err)
	return service, tick
}

// publishedItem creates and publishes one article, which is the state a reader can
// see before it is trashed.
func publishedItem(t *testing.T, service *Service, author Actor) Content {
	t.Helper()
	ctx := context.Background()
	item, err := service.CreateDraft(ctx, author, KindArticle, sampleDraft())
	require.NoError(t, err)
	published, err := service.Apply(ctx, author, item.ID, ActionPublish, "")
	require.NoError(t, err)
	require.Equal(t, StatusPublished, published.Status)
	return published
}

func TestTrashHidesItemFromEveryReadPath(t *testing.T) {
	repo := newFakeRepo()
	service, _ := newTrashService(t, repo)
	author := actor("author", site.RoleMember)
	ctx := context.Background()

	item := publishedItem(t, service, author)

	trashed, err := service.Trash(ctx, author, item.ID)
	require.NoError(t, err)
	require.NotNil(t, trashed.DeletedAt)

	// Detail: hidden even from the author and an editor, so the recycle bin is the
	// only surface that can still name a deleted item.
	_, err = service.Get(ctx, author, item.ID)
	require.ErrorIs(t, err, ErrNotFound)
	_, err = service.Get(ctx, actor("editor", site.RoleEditor), item.ID)
	require.ErrorIs(t, err, ErrNotFound)

	// Listing, search and the leaderboard: all empty.
	listed, err := service.List(ctx, author, KindArticle, 20, ListFilter{})
	require.NoError(t, err)
	require.Empty(t, listed)

	found, err := service.Search(ctx, author, SearchQuery{Term: "hello"})
	require.NoError(t, err)
	require.Empty(t, found.Hits)

	popular, err := service.Popular(ctx, author, PopularQuery{})
	require.NoError(t, err)
	require.Empty(t, popular)

	// History: a trashed item has no readable revisions, which is what keeps the raw
	// source from leaking through the one path that returns it unrendered.
	_, err = service.ListRevisions(ctx, author, item.ID)
	require.ErrorIs(t, err, ErrNotFound)

	// Workflow actions no longer apply to a trashed row.
	_, err = service.Apply(ctx, author, item.ID, ActionArchive, "")
	require.ErrorIs(t, err, ErrNotFound)
}

func TestTrashIsIdempotentAndKeepsTheFirstMarker(t *testing.T) {
	repo := newFakeRepo()
	service, tick := newTrashService(t, repo)
	author := actor("author", site.RoleMember)
	ctx := context.Background()

	item := publishedItem(t, service, author)

	first, err := service.Trash(ctx, author, item.ID)
	require.NoError(t, err)
	firstMark := *first.DeletedAt

	// A second delete a day later must neither fail nor restart the retention window.
	tick.advance(24 * time.Hour)
	second, err := service.Trash(ctx, author, item.ID)
	require.NoError(t, err)
	require.Equal(t, firstMark, *second.DeletedAt)

	// Only the state change was audited.
	deletes := 0
	for _, audit := range repo.audits {
		if audit.Action == "content.delete" {
			deletes++
		}
	}
	require.Equal(t, 1, deletes)
}

func TestTrashRequiresAuthorOrEditor(t *testing.T) {
	repo := newFakeRepo()
	service, _ := newTrashService(t, repo)
	author := actor("author", site.RoleMember)
	ctx := context.Background()

	item := publishedItem(t, service, author)

	// Another member has write_content but is neither the author nor an editor.
	_, err := service.Trash(ctx, actor("stranger", site.RoleMember), item.ID)
	require.ErrorIs(t, err, ErrPermissionDenied)

	// An anonymous reader holds no capability at all.
	_, err = service.Trash(ctx, Actor{SiteID: author.SiteID}, item.ID)
	require.ErrorIs(t, err, ErrPermissionDenied)

	// An editor may clean up somebody else's work.
	_, err = service.Trash(ctx, actor("editor", site.RoleEditor), item.ID)
	require.NoError(t, err)
}

func TestUndeleteRestoresTheItem(t *testing.T) {
	repo := newFakeRepo()
	service, _ := newTrashService(t, repo)
	author := actor("author", site.RoleMember)
	ctx := context.Background()

	item := publishedItem(t, service, author)
	_, err := service.Trash(ctx, author, item.ID)
	require.NoError(t, err)

	restored, err := service.Undelete(ctx, author, item.ID)
	require.NoError(t, err)
	require.Nil(t, restored.DeletedAt)

	readable, err := service.Get(ctx, author, item.ID)
	require.NoError(t, err)
	require.Equal(t, item.ID, readable.ID)

	// Restoring a live item is the same no-op as deleting a trashed one.
	again, err := service.Undelete(ctx, author, item.ID)
	require.NoError(t, err)
	require.Nil(t, again.DeletedAt)
}

func TestPurgeRequiresTheRecycleBin(t *testing.T) {
	repo := newFakeRepo()
	service, _ := newTrashService(t, repo)
	author := actor("author", site.RoleMember)
	ctx := context.Background()

	item := publishedItem(t, service, author)

	// A live item is refused: destruction is always two deliberate steps.
	require.ErrorIs(t, service.Purge(ctx, author, item.ID), ErrInvalidTransition)

	_, err := service.Trash(ctx, author, item.ID)
	require.NoError(t, err)
	require.NoError(t, service.Purge(ctx, author, item.ID))

	_, err = service.Get(ctx, author, item.ID)
	require.ErrorIs(t, err, ErrNotFound)
	require.Empty(t, repo.revisions, "the history goes with the item")

	// Purging what is already gone is a not found, not a second success.
	require.ErrorIs(t, service.Purge(ctx, author, item.ID), ErrNotFound)
}

func TestTrashedListingVisibility(t *testing.T) {
	repo := newFakeRepo()
	service, _ := newTrashService(t, repo)
	ctx := context.Background()

	author := actor("author", site.RoleMember)
	other := actor("other", site.RoleMember)
	editor := actor("editor", site.RoleEditor)

	mine := publishedItem(t, service, author)
	theirs := publishedItem(t, service, other)
	for _, item := range []Content{mine, theirs} {
		_, err := service.Trash(ctx, editor, item.ID)
		require.NoError(t, err)
	}

	// An anonymous caller is answered with the empty page a site with nothing trashed
	// would produce: a 403 would confirm that the bin exists.
	empty, err := service.List(ctx, Actor{SiteID: author.SiteID}, KindArticle, 20, ListFilter{Trashed: true})
	require.NoError(t, err)
	require.Empty(t, empty)

	// A member sees only their own trashed rows, exactly like the live listing.
	own, err := service.List(ctx, author, KindArticle, 20, ListFilter{Trashed: true})
	require.NoError(t, err)
	require.Len(t, own, 1)
	require.Equal(t, mine.ID, own[0].ID)

	// An editor sees the site's whole bin.
	all, err := service.List(ctx, editor, KindArticle, 20, ListFilter{Trashed: true})
	require.NoError(t, err)
	require.Len(t, all, 2)

	// The default listing still excludes them for everybody.
	live, err := service.List(ctx, editor, KindArticle, 20, ListFilter{})
	require.NoError(t, err)
	require.Empty(t, live)
}

func TestProcessTrashRetentionRemovesOnlyExpiredRows(t *testing.T) {
	repo := newFakeRepo()
	service, tick := newTrashService(t, repo)
	author := actor("author", site.RoleMember)
	ctx := context.Background()

	old := publishedItem(t, service, author)
	_, err := service.Trash(ctx, author, old.ID)
	require.NoError(t, err)

	// A row trashed recently must survive the sweep that removes the old one.
	tick.advance(TrashRetentionDays * 24 * time.Hour)
	recent := publishedItem(t, service, author)
	_, err = service.Trash(ctx, author, recent.ID)
	require.NoError(t, err)

	removed, err := service.ProcessTrashRetention(ctx)
	require.NoError(t, err)
	require.Equal(t, 1, removed)

	_, err = repo.FindByIDIncludingTrashed(ctx, author.SiteID, old.ID)
	require.ErrorIs(t, err, ErrNotFound)
	_, err = repo.FindByIDIncludingTrashed(ctx, author.SiteID, recent.ID)
	require.NoError(t, err)
}

func TestTrashedItemOffersOnlyTheLifecycleActions(t *testing.T) {
	repo := newFakeRepo()
	service, _ := newTrashService(t, repo)
	author := actor("author", site.RoleMember)
	ctx := context.Background()

	item := publishedItem(t, service, author)
	trashed, err := service.Trash(ctx, author, item.ID)
	require.NoError(t, err)

	actions, err := service.Actions(ctx, author, trashed)
	require.NoError(t, err)
	require.Equal(t, []Action{ActionUndelete, ActionPurge}, actions)

	// No lifecycle affordance is offered to somebody who may not act on the item.
	stranger := actor("stranger", site.RoleMember)
	actions, err = service.Actions(ctx, stranger, trashed)
	require.NoError(t, err)
	require.Empty(t, actions)
}

func TestDraftRoundTripsSeoAndCoverFields(t *testing.T) {
	repo := newFakeRepo()
	service, _ := newTrashService(t, repo)
	author := actor("author", site.RoleMember)
	ctx := context.Background()

	input := sampleDraft()
	input.SeoTitle = "  Better title  "
	input.SeoDescription = "A description"
	input.SeoKeywords = "go, cms"
	input.CanonicalURL = "https://example.com/canonical"
	input.OgImage = "data:image/png;base64,AAAA"
	input.Robots = RobotsNoIndex
	input.CoverURL = "https://example.com/cover.png"
	input.CoverAlt = "A cover"
	input.CoverPosition = CoverTop
	input.CoverHidden = true

	item, err := service.CreateDraft(ctx, author, KindArticle, input)
	require.NoError(t, err)
	require.Equal(t, "Better title", item.SeoTitle, "the value is trimmed")
	require.Equal(t, RobotsNoIndex, item.Robots)
	require.Equal(t, CoverTop, item.CoverPosition)
	require.True(t, item.CoverHidden)

	// The update carries the whole table: an empty value clears the override.
	update := sampleDraft()
	update.CoverPosition = ""
	updated, err := service.UpdateDraft(ctx, author, item.ID, update)
	require.NoError(t, err)
	require.Empty(t, updated.SeoTitle)
	require.Empty(t, updated.OgImage)
	require.Equal(t, RobotsInherit, updated.Robots)
	require.Equal(t, CoverCenter, updated.CoverPosition, "an empty focal point is the default crop")
	require.False(t, updated.CoverHidden)
}

func TestValidateDraftRejectsUnknownSeoAndCoverValues(t *testing.T) {
	base := sampleDraft()

	fieldOf := func(t *testing.T, in DraftInput) string {
		t.Helper()
		_, err := ValidateDraft(in)
		require.ErrorIs(t, err, ErrInvalidInput)
		var fieldErr *apperr.FieldError
		require.ErrorAs(t, err, &fieldErr)
		return fieldErr.Field
	}

	invalidRobots := base
	invalidRobots.Robots = Robots("sometimes")
	require.Equal(t, "robots", fieldOf(t, invalidRobots))

	invalidPosition := base
	invalidPosition.CoverPosition = CoverPosition("middle")
	require.Equal(t, "cover_position", fieldOf(t, invalidPosition))

	tooLongTitle := base
	tooLongTitle.SeoTitle = strings.Repeat("a", MaxTitleLength+1)
	require.Equal(t, "seo_title", fieldOf(t, tooLongTitle))
}
