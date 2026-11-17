package communitystore_test

import (
	"context"
	"path/filepath"
	"testing"
	"time"

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
	}, "", site.AuditEntry{SiteID: siteID, ActorID: "u1", Action: "community.comment.created"})
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

	require.NoError(t, store.SetReaction(ctx, item, true, ""))
	require.NoError(t, store.SetReaction(ctx, item, true, ""), "a retried like must not fail")

	active, err = store.HasReaction(ctx, "u1", "article", "a1", "like")
	require.NoError(t, err)
	require.True(t, active)

	require.NoError(t, store.SetReaction(ctx, item, false, ""))
	require.NoError(t, store.SetReaction(ctx, item, false, ""), "removing twice must not fail")

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

	service, err := community.NewService(store, store)
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

// TestReplyNotifiesParentAuthor is the end to end reason the notification wiring exists:
// replying to a comment must leave exactly one outbox event addressed to its author.
func TestReplyNotifiesParentAuthor(t *testing.T) {
	store, handle, siteID := newStore(t)
	ctx := context.Background()
	now := time.Now().UTC()

	parent, err := store.InsertComment(ctx, community.Comment{
		SiteID: siteID, AuthorID: "alice", TargetType: community.TargetArticle,
		TargetID: "a1", Body: "root", Status: community.CommentStatusVisible,
		CreatedAt: now, UpdatedAt: now,
	}, "", site.AuditEntry{SiteID: siteID, Action: "community.comment.created"})
	require.NoError(t, err)

	author, err := store.AuthorOf(ctx, siteID, community.TargetComment, parent.ID)
	require.NoError(t, err)
	require.Equal(t, "alice", author)

	// Bob replies through the service, which resolves the parent author for him.
	service, err := community.NewService(store, store)
	require.NoError(t, err)

	_, err = service.AddComment(ctx, community.Actor{UserID: "bob", SiteID: siteID},
		community.NewCommentInput{
			TargetType: community.TargetComment, TargetID: parent.ID, ParentID: parent.ID, Body: "reply",
		})
	require.NoError(t, err)

	events, err := handle.Client.OutboxEvent.Query().All(ctx)
	require.NoError(t, err)
	require.Len(t, events, 1)
	require.Equal(t, "comment.created", events[0].EventType)
	require.NotNil(t, events[0].AudienceUserID)
	require.Equal(t, "alice", *events[0].AudienceUserID, "the parent author is the audience")
}

// TestSelfReplyDoesNotNotify keeps a user from being told about their own comment.
func TestSelfReplyDoesNotNotify(t *testing.T) {
	store, handle, siteID := newStore(t)
	ctx := context.Background()
	now := time.Now().UTC()

	parent, err := store.InsertComment(ctx, community.Comment{
		SiteID: siteID, AuthorID: "alice", TargetType: community.TargetArticle,
		TargetID: "a1", Body: "root", Status: community.CommentStatusVisible,
		CreatedAt: now, UpdatedAt: now,
	}, "", site.AuditEntry{SiteID: siteID, Action: "community.comment.created"})
	require.NoError(t, err)

	ensureNoEvents(t, handle)

	service, err := community.NewService(store, store)
	require.NoError(t, err)

	_, err = service.AddComment(ctx, community.Actor{UserID: "alice", SiteID: siteID},
		community.NewCommentInput{
			TargetType: community.TargetComment, TargetID: parent.ID, ParentID: parent.ID, Body: "self",
		})
	require.NoError(t, err)
	ensureNoEvents(t, handle)
}

func ensureNoEvents(t *testing.T, handle *db.DB) {
	t.Helper()
	count, err := handle.Client.OutboxEvent.Query().Count(context.Background())
	require.NoError(t, err)
	require.Zero(t, count, "no notification event must be written")
}
func TestListCommentsJoinsAuthorsAndFilters(t *testing.T) {
	store, handle, siteID := newStore(t)
	ctx := context.Background()
	now := time.Now().UTC()

	author, err := handle.Client.User.Create().SetDisplayName("林知远").Save(ctx)
	require.NoError(t, err)

	bodies := []string{"first", "second", "third"}
	for index, body := range bodies {
		status := community.CommentStatusVisible
		if body == "second" {
			status = community.CommentStatusHidden
		}
		_, insertErr := store.InsertComment(ctx, community.Comment{
			SiteID: siteID, AuthorID: author.ID, TargetType: community.TargetArticle,
			TargetID: "a1", Body: body, Status: status,
			CreatedAt: now.Add(time.Duration(index) * time.Second), UpdatedAt: now,
		}, "", site.AuditEntry{SiteID: siteID, ActorID: author.ID, Action: "community.comment.created"})
		require.NoError(t, insertErr)
	}

	items, err := store.ListComments(ctx, community.CommentListFilter{
		SiteID: siteID, TargetType: community.TargetArticle, TargetID: "a1",
		Statuses: []string{community.CommentStatusVisible}, Limit: 10,
	})
	require.NoError(t, err)
	require.Len(t, items, 2)
	require.Equal(t, "third", items[0].Body, "newest first")
	require.Equal(t, "林知远", items[0].AuthorName, "author names are joined for listing")

	all, err := store.ListComments(ctx, community.CommentListFilter{
		SiteID: siteID, TargetType: community.TargetArticle, TargetID: "a1", Limit: 10,
	})
	require.NoError(t, err)
	require.Len(t, all, 3)
}

// TestCommentRiskRoundTrip proves the assessment survives the database. The queue reads
// rows, not the comment value that was just written, so a score that only lived in
// memory would rank every page the same way.
func TestCommentRiskRoundTrip(t *testing.T) {
	store, handle, siteID := newStore(t)
	ctx := context.Background()
	now := time.Now().UTC()

	risky := []string{community.RiskFlagLinks, community.RiskFlagShouty}
	created, err := store.InsertComment(ctx, community.Comment{
		SiteID: siteID, AuthorID: "u1", TargetType: community.TargetArticle,
		TargetID: "a1", Body: "BUY http://a.example http://b.example http://c.example",
		Status: community.CommentStatusVisible, RiskScore: 65, RiskFlags: risky,
		CreatedAt: now, UpdatedAt: now,
	}, "", site.AuditEntry{SiteID: siteID, ActorID: "u1", Action: "community.comment.created"})
	require.NoError(t, err)
	require.Equal(t, 65, created.RiskScore)
	require.Equal(t, risky, created.RiskFlags)

	found, err := store.FindComment(ctx, siteID, created.ID)
	require.NoError(t, err)
	require.Equal(t, 65, found.RiskScore)
	require.Equal(t, risky, found.RiskFlags)

	listed, err := store.ListComments(ctx, community.CommentListFilter{SiteID: siteID, Limit: 10})
	require.NoError(t, err)
	require.Len(t, listed, 1)
	require.Equal(t, 65, listed[0].RiskScore, "the queue reads the stored score")
	require.Equal(t, risky, listed[0].RiskFlags)

	// A comment nobody flagged still has to read back cleanly: the column defaults to
	// "[]" and decoding must not turn that into an error or a nil page.
	clean, err := store.InsertComment(ctx, community.Comment{
		SiteID: siteID, AuthorID: "u1", TargetType: community.TargetArticle,
		TargetID: "a1", Body: "a perfectly ordinary reply", Status: community.CommentStatusVisible,
		CreatedAt: now.Add(time.Second), UpdatedAt: now,
	}, "", site.AuditEntry{SiteID: siteID, ActorID: "u1", Action: "community.comment.created"})
	require.NoError(t, err)
	require.Zero(t, clean.RiskScore)
	require.Empty(t, clean.RiskFlags)

	// The write that follows an edit carries the rescored value with it.
	clean.Body = "UPDATED http://a.example http://b.example http://c.example http://d.example"
	clean.RiskScore = 80
	clean.RiskFlags = []string{community.RiskFlagLinks}
	updated, err := store.UpdateComment(ctx, clean, site.AuditEntry{
		SiteID: siteID, ActorID: "u1", Action: "community.comment.edited",
	})
	require.NoError(t, err)
	require.Equal(t, 80, updated.RiskScore)
	require.Equal(t, []string{community.RiskFlagLinks}, updated.RiskFlags)

	count, err := handle.Client.Comment.Query().Count(ctx)
	require.NoError(t, err)
	require.Equal(t, 2, count)
}
