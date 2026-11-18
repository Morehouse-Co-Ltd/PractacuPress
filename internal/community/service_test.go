package community

import (
	"context"
	"fmt"
	"sort"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/internal/site"
)

type fakeRepo struct {
	comments  map[string]Comment
	reactions map[string]bool
	bookmarks map[string]bool
	follows   map[string]bool
	writes    int
	seq       int
}

type fakeNotifier struct {
	items []Notification
}

func (f *fakeNotifier) NotifyInteraction(_ context.Context, in Notification) error {
	f.items = append(f.items, in)
	return nil
}

type fixedAuthors struct {
	author string
}

func (f fixedAuthors) AuthorOf(context.Context, string, TargetType, string) (string, error) {
	return f.author, nil
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

func newNotifiedService(t *testing.T, repo Repository, author string) (*Service, *fakeNotifier) {
	t.Helper()
	notifier := &fakeNotifier{}
	service, err := NewService(repo, fixedAuthors{author: author}, WithNotifier(notifier))
	require.NoError(t, err)
	return service, notifier
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

func TestReplyMustBelongToTheDeclaredTarget(t *testing.T) {
	repo := newFakeRepo()
	service := newService(t, repo)
	ctx := context.Background()
	author := Actor{UserID: "u1", SiteID: "s1", Role: site.RoleMember}

	first, err := service.AddComment(ctx, author, NewCommentInput{
		TargetType: TargetArticle, TargetID: "a1", Body: "first",
	})
	require.NoError(t, err)
	second, err := service.AddComment(ctx, author, NewCommentInput{
		TargetType: TargetArticle, TargetID: "a2", Body: "elsewhere",
	})
	require.NoError(t, err)

	// A reply that names another article while nesting under this comment would be
	// stored under the other article but keep a parent from this thread.
	_, err = service.AddComment(ctx, author, NewCommentInput{
		TargetType: TargetArticle, TargetID: "a2", ParentID: first.ID, Body: "cross thread",
	})
	require.ErrorIs(t, err, ErrInvalidInput)

	// The comment-target spelling must point at the parent itself.
	_, err = service.AddComment(ctx, author, NewCommentInput{
		TargetType: TargetComment, TargetID: second.ID, ParentID: first.ID, Body: "cross thread",
	})
	require.ErrorIs(t, err, ErrInvalidInput)

	// Naming the parent's root explicitly is still accepted.
	_, err = service.AddComment(ctx, author, NewCommentInput{
		TargetType: TargetArticle, TargetID: "a1", ParentID: first.ID, Body: "same thread",
	})
	require.NoError(t, err)
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

func TestCommentNotifiesTargetAuthor(t *testing.T) {
	repo := newFakeRepo()
	service, notifier := newNotifiedService(t, repo, "u2")
	ctx := context.Background()

	created, err := service.AddComment(ctx, Actor{UserID: "u1", SiteID: "s1"},
		NewCommentInput{TargetType: TargetArticle, TargetID: "a1", Body: "hello"})
	require.NoError(t, err)

	require.Len(t, notifier.items, 1)
	item := notifier.items[0]
	require.Equal(t, NotificationComment, item.Type)
	require.Equal(t, "u2", item.UserID)
	require.Equal(t, "u1", item.ActorID)
	require.Equal(t, created.ID, item.SubjectID)
	require.Equal(t, "article", item.Payload["target_type"])
	require.Equal(t, "a1", item.Payload["target_id"])
	require.Equal(t, "hello", item.Payload["excerpt"])
}

func TestReplyNotifiesParentAuthor(t *testing.T) {
	repo := newFakeRepo()
	service, notifier := newNotifiedService(t, repo, "u2")
	ctx := context.Background()

	root, err := service.AddComment(ctx, Actor{UserID: "u1", SiteID: "s1"},
		NewCommentInput{TargetType: TargetArticle, TargetID: "a1", Body: "root"})
	require.NoError(t, err)
	notifier.items = nil

	_, err = service.AddComment(ctx, Actor{UserID: "u3", SiteID: "s1"},
		NewCommentInput{TargetType: TargetComment, TargetID: root.ID, ParentID: root.ID, Body: "reply"})
	require.NoError(t, err)

	require.Len(t, notifier.items, 1)
	require.Equal(t, NotificationComment, notifier.items[0].Type)
	require.Equal(t, "1", notifier.items[0].Payload["reply"])
	require.Equal(t, root.ID, notifier.items[0].Payload["reply_to_comment_id"])
}

func TestSelfInteractionDoesNotNotify(t *testing.T) {
	repo := newFakeRepo()
	notifier := &fakeNotifier{}
	service, err := NewService(repo, fixedAuthors{author: "u1"}, WithNotifier(notifier))
	require.NoError(t, err)

	_, err = service.AddComment(context.Background(), Actor{UserID: "u1", SiteID: "s1"},
		NewCommentInput{TargetType: TargetArticle, TargetID: "a1", Body: "self"})
	require.NoError(t, err)
	require.Empty(t, notifier.items)
}

func TestReactionAndFollowNotify(t *testing.T) {
	repo := newFakeRepo()
	service, notifier := newNotifiedService(t, repo, "u2")
	ctx := context.Background()
	actor := Actor{UserID: "u1", SiteID: "s1"}

	active := true
	_, err := service.ToggleReaction(ctx, actor, TargetArticle, "a1", "like", &active)
	require.NoError(t, err)
	require.Len(t, notifier.items, 1)
	require.Equal(t, NotificationReaction, notifier.items[0].Type)
	require.Equal(t, "u2", notifier.items[0].UserID)
	require.Contains(t, notifier.items[0].DedupeKey, "reaction:u1:article:a1:like")

	_, err = service.ToggleFollow(ctx, actor, "u2", &active)
	require.NoError(t, err)
	require.Len(t, notifier.items, 2)
	require.Equal(t, NotificationFollow, notifier.items[1].Type)
	require.Equal(t, "u2", notifier.items[1].UserID)
	require.Equal(t, "follow:u1", notifier.items[1].DedupeKey)
}

func TestReviewNotifiesCommentAuthor(t *testing.T) {
	repo := newFakeRepo()
	repo.comments["c1"] = Comment{
		ID: "c1", SiteID: "s1", AuthorID: "u2", TargetType: TargetArticle,
		TargetID: "a1", Body: "pending body", Status: CommentStatusPending,
	}
	service, notifier := newNotifiedService(t, repo, "u9")
	ctx := context.Background()
	moderator := Actor{UserID: "m1", SiteID: "s1", Role: site.RoleEditor}

	_, err := service.ApproveComment(ctx, moderator, "c1")
	require.NoError(t, err)
	require.Len(t, notifier.items, 2, "the author learns the decision and the target author learns the comment is public")

	moderated := notifier.items[0]
	require.Equal(t, NotificationModeration, moderated.Type)
	require.Equal(t, "u2", moderated.UserID)
	require.Equal(t, CommentStatusVisible, moderated.Payload["status"])
	require.Equal(t, "pending body", moderated.Payload["excerpt"])

	published := notifier.items[1]
	require.Equal(t, NotificationComment, published.Type)
	require.Equal(t, "u9", published.UserID)
	require.Equal(t, "u2", published.ActorID)
}

// TestAddCommentStoresRiskAssessment is the reason scoring moved to the server: the
// queue needs a number on the stored row, not one computed by whichever browser opened
// the moderation page.
func TestAddCommentStoresRiskAssessment(t *testing.T) {
	repo := newFakeRepo()
	service := newService(t, repo)
	ctx := context.Background()
	author := Actor{UserID: "u1", SiteID: "s1", Role: site.RoleMember}

	spam, err := service.AddComment(ctx, author, NewCommentInput{
		TargetType: TargetArticle, TargetID: "a1",
		Body: "cheap tools https://a.example https://b.example https://c.example https://d.example",
	})
	require.NoError(t, err)
	require.GreaterOrEqual(t, spam.RiskScore, 50)
	require.Contains(t, spam.RiskFlags, RiskFlagLinks)

	stored, err := repo.FindComment(ctx, "s1", spam.ID)
	require.NoError(t, err)
	require.Equal(t, spam.RiskScore, stored.RiskScore, "the score is part of the write")
	require.Equal(t, spam.RiskFlags, stored.RiskFlags)

	clean, err := service.AddComment(ctx, author, NewCommentInput{
		TargetType: TargetArticle, TargetID: "a1",
		Body: "Good point about the cache, I hit the same thing last week.",
	})
	require.NoError(t, err)
	require.Less(t, clean.RiskScore, 20)
	require.Empty(t, clean.RiskFlags)
}

// TestEditCommentRescoresTheBody closes the gap an edit would otherwise open: a clean
// comment rewritten into spam has to move up the queue, which is the same reason an
// edit already runs through the word list.
func TestEditCommentRescoresTheBody(t *testing.T) {
	repo := newFakeRepo()
	service := newService(t, repo)
	ctx := context.Background()
	author := Actor{UserID: "u1", SiteID: "s1", Role: site.RoleMember}

	created, err := service.AddComment(ctx, author, NewCommentInput{
		TargetType: TargetArticle, TargetID: "a1", Body: "first thoughts, replying properly later",
	})
	require.NoError(t, err)
	require.Zero(t, created.RiskScore)

	edited, err := service.EditComment(ctx, author, created.ID,
		"READ THIS http://a.example http://b.example http://c.example http://d.example NOW")
	require.NoError(t, err)
	require.GreaterOrEqual(t, edited.RiskScore, 50)
	require.Contains(t, edited.RiskFlags, RiskFlagLinks)
}
