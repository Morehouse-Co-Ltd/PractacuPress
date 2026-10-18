package communitystore_test

import (
	"context"
	"path/filepath"
	"time"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/apps/api/internal/community"
	"github.com/practacu/practacu-press/apps/api/internal/infrastructure/communitystore"
	"github.com/practacu/practacu-press/apps/api/internal/infrastructure/db"
	"github.com/practacu/practacu-press/apps/api/internal/site"
)

func newStore(t *testing.T) (*communitystore.Store, *db.DB, string) {
	t.Helper()
	ctx := context.Background()

	handle, err := db.Open(ctx, "sqlite", db.SQLiteDSN(filepath.Join(t.TempDir(), "community.db")))
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, handle.Close()) })
	require.NoError(t, handle.Client.Schema.Create(ctx))

	siteRow, err := handle.Client.Site.Create().SetSlug("main").SetName("Main").Save(ctx)
	require.NoError(t, err)

	return communitystore.New(handle.Client), handle, siteRow.ID
}

func TestCommentRoundTrip(t *testing.T) {
	store, handle, siteID := newStore(t)
	ctx := context.Background()
	now := time.Now().UTC()

	created, err := store.InsertComment(ctx, community.Comment{
		SiteID: siteID, AuthorID: "u1", TargetType: community.TargetArticle,
		TargetID: "a1", Body: "hello", Status: community.CommentStatusVisible,
		CreatedAt: now, UpdatedAt: now,
	}, site.AuditEntry{SiteID: siteID, ActorID: "u1", Action: "community.comment.created"})
	require.NoError(t, err)
	require.NotEmpty(t, created.ID)

	found, err := store.FindComment(ctx, siteID, created.ID)
	require.NoError(t, err)
	require.Equal(t, "hello", found.Body)
	require.Zero(t, found.Depth)

	_, err = store.FindComment(ctx, "other-site", created.ID)
	require.ErrorIs(t, err, community.ErrNotFound, "reads are site scoped")

	entries, err := handle.Client.AuditLog.Query().All(ctx)
	require.NoError(t, err)
	require.Len(t, entries, 1)
}

func TestReactionIsIdempotent(t *testing.T) {
	store, _, siteID := newStore(t)
	ctx := context.Background()
	item := community.Reaction{
		SiteID: siteID, UserID: "u1", TargetType: community.TargetArticle,
		TargetID: "a1", Kind: "like",
	}

	active, err := store.HasReaction(ctx, "u1", "article", "a1", "like")
	require.NoError(t, err)
	require.False(t, active)

	require.NoError(t, store.SetReaction(ctx, item, true))
	require.NoError(t, store.SetReaction(ctx, item, true), "a retried like must not fail")

	active, err = store.HasReaction(ctx, "u1", "article", "a1", "like")
	require.NoError(t, err)
	require.True(t, active)

	require.NoError(t, store.SetReaction(ctx, item, false))
	require.NoError(t, store.SetReaction(ctx, item, false), "removing twice must not fail")

	active, err = store.HasReaction(ctx, "u1", "article", "a1", "like")
	require.NoError(t, err)
	require.False(t, active)
}

func TestBookmarkAndFollowAreIdempotent(t *testing.T) {
	store, _, siteID := newStore(t)
	ctx := context.Background()

	require.NoError(t, store.SetBookmark(ctx, siteID, "u1", "article", "a1", true))
	require.NoError(t, store.SetBookmark(ctx, siteID, "u1", "article", "a1", true))

	active, err := store.HasBookmark(ctx, "u1", "article", "a1")
	require.NoError(t, err)
	require.True(t, active)

	require.NoError(t, store.SetFollow(ctx, siteID, "u1", "u2", true))
	require.NoError(t, store.SetFollow(ctx, siteID, "u1", "u2", true))

	active, err = store.HasFollow(ctx, siteID, "u1", "u2")
	require.NoError(t, err)
	require.True(t, active)

	require.NoError(t, store.SetFollow(ctx, siteID, "u1", "u2", false))
	active, err = store.HasFollow(ctx, siteID, "u1", "u2")
	require.NoError(t, err)
	require.False(t, active)
}

func TestServiceAgainstRealStore(t *testing.T) {
	store, _, siteID := newStore(t)
	ctx := context.Background()

	service, err := community.NewService(store)
	require.NoError(t, err)
	author := community.Actor{UserID: "u1", SiteID: siteID, Role: site.RoleMember}

	root, err := service.AddComment(ctx, author, community.NewCommentInput{
		TargetType: community.TargetArticle, TargetID: "a1", Body: "first",
	})
	require.NoError(t, err)

	reply, err := service.AddComment(ctx, author, community.NewCommentInput{
		TargetType: community.TargetComment, TargetID: root.ID, ParentID: root.ID, Body: "second",
	})
	require.NoError(t, err)
	require.Equal(t, 1, reply.Depth)

	want := true
	active, err := service.ToggleReaction(ctx, author, community.TargetArticle, "a1", "like", &want)
	require.NoError(t, err)
	require.True(t, active)

	// Same intent again is a no-op end to end.
	active, err = service.ToggleReaction(ctx, author, community.TargetArticle, "a1", "like", &want)
	require.NoError(t, err)
	require.True(t, active)
}
