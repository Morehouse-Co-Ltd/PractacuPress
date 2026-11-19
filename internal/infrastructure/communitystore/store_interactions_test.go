package communitystore_test

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/internal/community"
	"github.com/practacu/practacu-press/internal/content"
	"github.com/practacu/practacu-press/internal/site"
)

// TestInteractionReadModel exercises the personal read paths against the real
// schema: state, batch state, saved/liked lists, reading history and the follow
// lists. These queries join four tables, so a small integration test is worth more
// than mocking the store.
func TestInteractionReadModel(t *testing.T) {
	store, handle, siteID := newStore(t)
	ctx := context.Background()

	author, err := handle.Client.User.Create().SetDisplayName("Author").Save(ctx)
	require.NoError(t, err)
	viewer, err := handle.Client.User.Create().SetDisplayName("Viewer").Save(ctx)
	require.NoError(t, err)

	for _, userID := range []string{author.ID, viewer.ID} {
		_, memberErr := handle.Client.SiteMember.Create().
			SetSiteID(siteID).
			SetUserID(userID).
			SetRole(string(site.RoleMember)).
			SetStatus(site.MemberStatusActive).
			Save(ctx)
		require.NoError(t, memberErr)
	}

	article, err := handle.Client.ContentItem.Create().
		SetSiteID(siteID).
		SetAuthorID(author.ID).
		SetKind(string(content.KindArticle)).
		SetStatus(string(content.StatusPublished)).
		SetTitle("A published article").
		SetSlug("published").
		SetSummary("summary").
		SetSourceBody("body").
		Save(ctx)
	require.NoError(t, err)

	service, err := community.NewService(store, store)
	require.NoError(t, err)
	actor := community.Actor{UserID: viewer.ID, SiteID: siteID, Role: site.RoleMember}

	yes := true
	_, err = service.ToggleReaction(ctx, actor, community.TargetArticle, article.ID, "like", &yes)
	require.NoError(t, err)
	_, err = service.ToggleBookmark(ctx, actor, community.TargetArticle, article.ID, &yes)
	require.NoError(t, err)
	_, err = service.ToggleFollow(ctx, actor, author.ID, &yes)
	require.NoError(t, err)

	state, err := service.State(ctx, actor, community.TargetArticle, article.ID, author.ID)
	require.NoError(t, err)
	require.True(t, state.Liked)
	require.True(t, state.Bookmarked)
	require.True(t, state.Following)

	// A second viewer sees none of it.
	other := community.Actor{UserID: "someone-else", SiteID: siteID, Role: site.RoleMember}
	otherState, err := service.State(ctx, other, community.TargetArticle, article.ID, author.ID)
	require.NoError(t, err)
	require.False(t, otherState.Liked)
	require.False(t, otherState.Bookmarked)
	require.False(t, otherState.Following)

	items, follows, err := service.States(ctx, actor, community.TargetArticle,
		[]string{article.ID}, []string{author.ID})
	require.NoError(t, err)
	require.Len(t, items, 1)
	require.True(t, items[0].Liked)
	require.True(t, items[0].Bookmarked)
	require.Len(t, follows, 1)
	require.True(t, follows[0].Following)

	bookmarks, next, err := service.Bookmarks(ctx, actor, community.InteractionListFilter{})
	require.NoError(t, err)
	require.Empty(t, next)
	require.Len(t, bookmarks, 1)
	require.Equal(t, article.ID, bookmarks[0].TargetID)
	require.Equal(t, "A published article", bookmarks[0].Title)
	require.Equal(t, "Author", bookmarks[0].AuthorName)
	require.True(t, bookmarks[0].Available)

	likes, _, err := service.Likes(ctx, actor, community.InteractionListFilter{})
	require.NoError(t, err)
	require.Len(t, likes, 1)
	require.Equal(t, article.ID, likes[0].TargetID)

	// Two visits collapse into one history row with a counter.
	require.NoError(t, service.RecordReading(ctx, actor, community.TargetArticle, article.ID))
	require.NoError(t, service.RecordReading(ctx, actor, community.TargetArticle, article.ID))
	history, _, err := service.ReadingHistory(ctx, actor, community.InteractionListFilter{})
	require.NoError(t, err)
	require.Len(t, history, 1)
	require.Equal(t, 2, history[0].ViewCount)
	require.Equal(t, "A published article", history[0].Title)

	following, _, err := service.Following(ctx, actor, community.FollowListFilter{})
	require.NoError(t, err)
	require.Len(t, following, 1)
	require.Equal(t, author.ID, following[0].UserID)
	require.Equal(t, "Author", following[0].DisplayName)

	followers, _, err := service.Followers(ctx, community.Actor{
		UserID: author.ID, SiteID: siteID, Role: site.RoleMember,
	}, community.FollowListFilter{})
	require.NoError(t, err)
	require.Len(t, followers, 1)
	require.Equal(t, viewer.ID, followers[0].UserID)
}
