package community

import (
	"context"
	"fmt"
	"sort"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/apps/api/internal/site"
)

type fakeRepo struct {
	comments  map[string]Comment
	reactions map[string]bool
	bookmarks map[string]bool
	follows   map[string]bool
	writes    int
	seq       int
}

func newFakeRepo() *fakeRepo {
	return &fakeRepo{
		comments:  map[string]Comment{},
		reactions: map[string]bool{},
		bookmarks: map[string]bool{},
		follows:   map[string]bool{},
	}
}

func (f *fakeRepo) FindComment(_ context.Context, siteID, commentID string) (Comment, error) {
	comment, ok := f.comments[commentID]
	if !ok || comment.SiteID != siteID {
		return Comment{}, ErrNotFound
	}
	return comment, nil
}

func (f *fakeRepo) ListComments(_ context.Context, filter CommentListFilter) ([]Comment, error) {
	statuses := map[string]bool{}
	for _, status := range filter.Statuses {
		statuses[status] = true
	}
	out := make([]Comment, 0, len(f.comments))
	for _, comment := range f.comments {
		if comment.SiteID != filter.SiteID {
			continue
		}
		if filter.TargetType != "" && comment.TargetType != filter.TargetType {
			continue
		}
		if filter.TargetID != "" && comment.TargetID != filter.TargetID {
			continue
		}
		if len(statuses) > 0 && !statuses[comment.Status] {
			continue
		}
		out = append(out, comment)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.After(out[j].CreatedAt) })
	if filter.Limit > 0 && len(out) > filter.Limit {
		out = out[:filter.Limit]
	}
	return out, nil
}

func (f *fakeRepo) InsertComment(_ context.Context, comment Comment, _ string, _ site.AuditEntry) (Comment, error) {
	f.seq++
	f.writes++
	comment.ID = fmt.Sprintf("c%d", f.seq)
	f.comments[comment.ID] = comment
	return comment, nil
}

func (f *fakeRepo) UpdateComment(_ context.Context, comment Comment, _ site.AuditEntry) (Comment, error) {
	f.writes++
	f.comments[comment.ID] = comment
	return comment, nil
}

func (f *fakeRepo) HasReaction(_ context.Context, userID, targetType, targetID, kind string) (bool, error) {
	return f.reactions[userID+targetType+targetID+kind], nil
}

func (f *fakeRepo) SetReaction(_ context.Context, reaction Reaction, active bool, _ string) error {
	f.writes++
	f.reactions[reaction.UserID+string(reaction.TargetType)+reaction.TargetID+reaction.Kind] = active
	return nil
}

func (f *fakeRepo) HasBookmark(_ context.Context, userID, targetType, targetID string) (bool, error) {
	return f.bookmarks[userID+targetType+targetID], nil
}

func (f *fakeRepo) SetBookmark(_ context.Context, _, userID, targetType, targetID string, active bool) error {
	f.writes++
	f.bookmarks[userID+targetType+targetID] = active
	return nil
}

func (f *fakeRepo) HasFollow(_ context.Context, _, followerID, followeeID string) (bool, error) {
	return f.follows[followerID+followeeID], nil
}

func (f *fakeRepo) SetFollow(_ context.Context, _, followerID, followeeID string, active bool) error {
	f.writes++
	f.follows[followerID+followeeID] = active
	return nil
}

func newService(t *testing.T, repo Repository) *Service {
	t.Helper()
	service, err := NewService(repo, nil)
	require.NoError(t, err)
	return service
}

func TestNewServiceRequiresRepository(t *testing.T) {
	_, err := NewService(nil, nil)
	require.Error(t, err)
}

func TestAddCommentAndReplyDepth(t *testing.T) {
	repo := newFakeRepo()
	service := newService(t, repo)
	ctx := context.Background()
	author := Actor{UserID: "u1", SiteID: "s1", Role: site.RoleMember}

	root, err := service.AddComment(ctx, author, NewCommentInput{
		TargetType: TargetArticle, TargetID: "a1", Body: "first",
	})
	require.NoError(t, err)
	require.Zero(t, root.Depth)
	require.Equal(t, CommentStatusVisible, root.Status)

	reply, err := service.AddComment(ctx, author, NewCommentInput{
		TargetType: TargetComment, TargetID: root.ID, ParentID: root.ID, Body: "second",
	})
	require.NoError(t, err)
	require.Equal(t, 1, reply.Depth)
}

func TestReplyBeyondDepthLimitIsRefused(t *testing.T) {
	repo := newFakeRepo()
	service := newService(t, repo)
	ctx := context.Background()
	author := Actor{UserID: "u1", SiteID: "s1", Role: site.RoleMember}

	parentID := ""
	for depth := 0; depth <= MaxReplyDepth; depth++ {
		in := NewCommentInput{TargetType: TargetArticle, TargetID: "a1", Body: "x"}
		if parentID != "" {
			in = NewCommentInput{TargetType: TargetComment, TargetID: parentID, ParentID: parentID, Body: "x"}
		}
		created, err := service.AddComment(ctx, author, in)
		require.NoError(t, err, "depth %d must be allowed", depth)
		parentID = created.ID
	}

	_, err := service.AddComment(ctx, author, NewCommentInput{
		TargetType: TargetComment, TargetID: parentID, ParentID: parentID, Body: "too deep",
	})
	require.ErrorIs(t, err, ErrDepthExceeded)
}

func TestEditAndDeletePermissions(t *testing.T) {
	repo := newFakeRepo()
	service := newService(t, repo)
	ctx := context.Background()
	author := Actor{UserID: "u1", SiteID: "s1", Role: site.RoleMember}
	other := Actor{UserID: "u2", SiteID: "s1", Role: site.RoleMember}
	moderator := Actor{UserID: "m1", SiteID: "s1", Role: site.RoleEditor}

	created, err := service.AddComment(ctx, author, NewCommentInput{
		TargetType: TargetArticle, TargetID: "a1", Body: "hello",
	})
	require.NoError(t, err)

	_, err = service.EditComment(ctx, other, created.ID, "hijacked")
	require.ErrorIs(t, err, ErrPermissionDenied)

	edited, err := service.EditComment(ctx, author, created.ID, "  hello again  ")
	require.NoError(t, err)
	require.Equal(t, "hello again", edited.Body)

	_, err = service.DeleteComment(ctx, other, created.ID)
	require.ErrorIs(t, err, ErrPermissionDenied)

	deleted, err := service.DeleteComment(ctx, moderator, created.ID)
	require.NoError(t, err)
	require.Equal(t, CommentStatusDeleted, deleted.Status)

	// Deleting again is not an error and must not write.
	before := repo.writes
	_, err = service.DeleteComment(ctx, moderator, created.ID)
	require.ErrorIs(t, err, ErrPermissionDenied)
	require.Equal(t, before, repo.writes)
}

// TestListCommentsHidesNonVisibleFromReaders pins the read model: a reader without
// moderation rights never receives hidden or pending comments, even when the query
// does not ask for a status.
func TestListCommentsHidesNonVisibleFromReaders(t *testing.T) {
	repo := newFakeRepo()
	service := newService(t, repo)
	ctx := context.Background()
	author := Actor{UserID: "u1", SiteID: "s1", Role: site.RoleMember}
	moderator := Actor{UserID: "m1", SiteID: "s1", Role: site.RoleEditor}

	visible, err := service.AddComment(ctx, author, NewCommentInput{
		TargetType: TargetArticle, TargetID: "a1", Body: "visible",
	})
	require.NoError(t, err)
	pending, err := service.AddComment(ctx, author, NewCommentInput{
		TargetType: TargetArticle, TargetID: "a1", Body: "pending",
	})
	require.NoError(t, err)
	_, err = service.ModerateComment(ctx, moderator, pending.ID, CommentStatusHidden)
	require.NoError(t, err)

	reader := Actor{SiteID: "s1"}
	items, _, err := service.ListComments(ctx, reader, CommentListFilter{
		TargetType: TargetArticle, TargetID: "a1",
	})
	require.NoError(t, err)
	require.Len(t, items, 1)
	require.Equal(t, visible.ID, items[0].ID)

	moderated, _, err := service.ListComments(ctx, moderator, CommentListFilter{
		TargetType: TargetArticle, TargetID: "a1",
	})
	require.NoError(t, err)
	require.Len(t, moderated, 2)
}

func TestListCommentsRejectsNonVisibleFilterForReader(t *testing.T) {
	repo := newFakeRepo()
	service := newService(t, repo)
	reader := Actor{SiteID: "s1"}

	_, _, err := service.ListComments(context.Background(), reader, CommentListFilter{
		Statuses: []string{CommentStatusHidden},
	})
	require.ErrorIs(t, err, ErrPermissionDenied)
}

func TestModerateCommentRequiresModerator(t *testing.T) {
	repo := newFakeRepo()
	service := newService(t, repo)
	ctx := context.Background()
	author := Actor{UserID: "u1", SiteID: "s1", Role: site.RoleMember}

	created, err := service.AddComment(ctx, author, NewCommentInput{
		TargetType: TargetArticle, TargetID: "a1", Body: "hello",
	})
	require.NoError(t, err)

	_, err = service.ModerateComment(ctx, author, created.ID, CommentStatusHidden)
	require.ErrorIs(t, err, ErrPermissionDenied)

	_, err = service.ModerateComment(ctx, Actor{UserID: "m1", SiteID: "s1", Role: site.RoleEditor}, created.ID, "deleted")
	require.ErrorIs(t, err, ErrInvalidInput)
}

// TestRetriedReactionDoesNotWrite is what keeps retries from double notifying.
func TestRetriedReactionDoesNotWrite(t *testing.T) {
	repo := newFakeRepo()
	service := newService(t, repo)
	ctx := context.Background()
	actor := Actor{UserID: "u1", SiteID: "s1", Role: site.RoleMember}
	want := true

	active, err := service.ToggleReaction(ctx, actor, TargetArticle, "a1", "like", &want)
	require.NoError(t, err)
	require.True(t, active)
	require.Equal(t, 1, repo.writes)

	// The same intent again changes nothing and writes nothing.
	active, err = service.ToggleReaction(ctx, actor, TargetArticle, "a1", "like", &want)
	require.NoError(t, err)
	require.True(t, active)
	require.Equal(t, 1, repo.writes, "a retried like must not write again")

	// Without an explicit intent the state flips.
	active, err = service.ToggleReaction(ctx, actor, TargetArticle, "a1", "like", nil)
	require.NoError(t, err)
	require.False(t, active)
	require.Equal(t, 2, repo.writes)
}

func TestToggleReactionValidatesKind(t *testing.T) {
	service := newService(t, newFakeRepo())
	actor := Actor{UserID: "u1", SiteID: "s1", Role: site.RoleMember}

	_, err := service.ToggleReaction(context.Background(), actor, TargetArticle, "a1", "clap", nil)
	require.ErrorIs(t, err, ErrInvalidInput)
}

func TestToggleFollowRejectsSelfFollow(t *testing.T) {
	repo := newFakeRepo()
	service := newService(t, repo)
	actor := Actor{UserID: "u1", SiteID: "s1", Role: site.RoleMember}

	_, err := service.ToggleFollow(context.Background(), actor, "u1", nil)
	require.ErrorIs(t, err, ErrSelfTarget)
	require.Zero(t, repo.writes)
}

func TestToggleBookmarkIsIdempotent(t *testing.T) {
	repo := newFakeRepo()
	service := newService(t, repo)
	ctx := context.Background()
	actor := Actor{UserID: "u1", SiteID: "s1", Role: site.RoleMember}

	active, err := service.ToggleBookmark(ctx, actor, TargetArticle, "a1", nil)
	require.NoError(t, err)
	require.True(t, active)

	want := true
	active, err = service.ToggleBookmark(ctx, actor, TargetArticle, "a1", &want)
	require.NoError(t, err)
	require.True(t, active)
	require.Equal(t, 1, repo.writes, "repeating the intent must not write")
}
