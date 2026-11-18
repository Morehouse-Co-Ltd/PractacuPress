package community

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/internal/site"
)

type fakeCommentPolicy struct {
	enabled bool
	review  bool
	err     error
}

func (f fakeCommentPolicy) CommentPolicy(context.Context, string) (bool, bool, error) {
	return f.enabled, f.review, f.err
}

func newPolicyService(t *testing.T, repo Repository, policy CommentPolicyResolver) *Service {
	t.Helper()
	service, err := NewService(repo, nil, WithCommentPolicy(policy))
	require.NoError(t, err)
	return service
}

var commentAuthor = Actor{UserID: "u1", SiteID: "s1", Role: site.RoleMember}

func sampleComment() NewCommentInput {
	return NewCommentInput{TargetType: TargetArticle, TargetID: "a1", Body: "hello"}
}

func TestClosedCommentsRefuseWrites(t *testing.T) {
	repo := newFakeRepo()
	service := newPolicyService(t, repo, fakeCommentPolicy{enabled: false})

	_, err := service.AddComment(context.Background(), commentAuthor, sampleComment())
	require.ErrorIs(t, err, ErrCommentsClosed)
	require.Zero(t, repo.writes, "a closed thread must not reach storage")
}

func TestReviewPolicyFilesPending(t *testing.T) {
	repo := newFakeRepo()
	service := newPolicyService(t, repo, fakeCommentPolicy{enabled: true, review: true})

	comment, err := service.AddComment(context.Background(), commentAuthor, sampleComment())
	require.NoError(t, err)
	require.Equal(t, CommentStatusPending, comment.Status)
}

func TestOpenPolicyPublishesImmediately(t *testing.T) {
	repo := newFakeRepo()
	service := newPolicyService(t, repo, fakeCommentPolicy{enabled: true, review: false})

	comment, err := service.AddComment(context.Background(), commentAuthor, sampleComment())
	require.NoError(t, err)
	require.Equal(t, CommentStatusVisible, comment.Status)
}

func TestApproveAndRejectRequireModerator(t *testing.T) {
	repo := newFakeRepo()
	service := newPolicyService(t, repo, fakeCommentPolicy{enabled: true, review: true})
	ctx := context.Background()

	pending, err := service.AddComment(ctx, commentAuthor, sampleComment())
	require.NoError(t, err)

	_, err = service.ApproveComment(ctx, commentAuthor, pending.ID)
	require.ErrorIs(t, err, ErrPermissionDenied)

	editor := Actor{UserID: "mod1", SiteID: "s1", Role: site.RoleEditor}
	approved, err := service.ApproveComment(ctx, editor, pending.ID)
	require.NoError(t, err)
	require.Equal(t, CommentStatusVisible, approved.Status)

	other, err := service.AddComment(ctx, commentAuthor, sampleComment())
	require.NoError(t, err)
	rejected, err := service.RejectComment(ctx, editor, other.ID)
	require.NoError(t, err)
	require.Equal(t, CommentStatusHidden, rejected.Status)
}
