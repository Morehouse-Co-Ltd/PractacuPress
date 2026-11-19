package community

import (
	"context"
	"errors"
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/internal/site"
)

// fakeTargets is the content target port used by the V-15 regression tests.
type fakeTargets struct {
	targets map[string]Target
	err     error
	calls   []string
}

func targetKey(targetType TargetType, targetID string) string {
	return string(targetType) + "/" + targetID
}

func (f *fakeTargets) TargetOf(_ context.Context, siteID string, targetType TargetType, targetID string) (Target, error) {
	f.calls = append(f.calls, siteID+"/"+targetKey(targetType, targetID))
	if f.err != nil {
		return Target{}, f.err
	}
	target, ok := f.targets[targetKey(targetType, targetID)]
	if !ok {
		return Target{}, ErrTargetNotFound
	}
	return target, nil
}

// fakeMembership is the active member port used by the follow tests.
type fakeMembership struct {
	active map[string]bool
	err    error
}

func (f *fakeMembership) IsActiveMember(_ context.Context, _ /*siteID*/, userID string) (bool, error) {
	if f.err != nil {
		return false, f.err
	}
	return f.active[userID], nil
}

func newServiceWithPorts(
	t *testing.T,
	repo Repository,
	targets ContentTargetChecker,
	members UserMembershipChecker,
) *Service {
	t.Helper()
	service, err := NewService(repo, nil,
		WithTargetChecker(targets),
		WithMembershipChecker(members),
	)
	require.NoError(t, err)
	return service
}

func publishedArticle(authorID string) map[string]Target {
	return map[string]Target{
		targetKey(TargetArticle, "a1"): {AuthorID: authorID, Published: true},
	}
}

// TestAddCommentRejectsMissingContentTarget is the V-15 regression: a client cannot
// create a comment row that points at an article which does not exist.
func TestAddCommentRejectsMissingContentTarget(t *testing.T) {
	repo := newFakeRepo()
	service := newServiceWithPorts(t, repo, &fakeTargets{targets: map[string]Target{}}, nil)

	_, err := service.AddComment(context.Background(), memberActor(), NewCommentInput{
		TargetType: TargetArticle,
		TargetID:   "ghost",
		Body:       "hello",
	})
	require.ErrorIs(t, err, ErrTargetNotFound)
	require.Zero(t, repo.writes, "a rejected comment must not be stored")
}

// TestAddCommentRejectsOtherAuthorsDraft covers the confidentiality half: commenting on
// someone else's unpublished id must fail exactly like a missing id.
func TestAddCommentRejectsOtherAuthorsDraft(t *testing.T) {
	repo := newFakeRepo()
	targets := &fakeTargets{targets: map[string]Target{
		targetKey(TargetArticle, "draft"): {AuthorID: "u2", Published: false},
	}}
	service := newServiceWithPorts(t, repo, targets, nil)

	_, err := service.AddComment(context.Background(), memberActor(), NewCommentInput{
		TargetType: TargetArticle,
		TargetID:   "draft",
		Body:       "hello",
	})
	require.ErrorIs(t, err, ErrTargetNotFound)
	require.Zero(t, repo.writes)
}

// TestAddCommentAllowsOwnDraftAndPublishedTarget pins the positive rules: an author may
// discuss their own draft, and everyone may comment on published content.
func TestAddCommentAllowsOwnDraftAndPublishedTarget(t *testing.T) {
	repo := newFakeRepo()
	targets := &fakeTargets{targets: map[string]Target{
		targetKey(TargetArticle, "my-draft"):  {AuthorID: "u1", Published: false},
		targetKey(TargetArticle, "published"): {AuthorID: "u2", Published: true},
	}}
	service := newServiceWithPorts(t, repo, targets, nil)
	ctx := context.Background()

	_, err := service.AddComment(ctx, memberActor(), NewCommentInput{
		TargetType: TargetArticle, TargetID: "my-draft", Body: "notes",
	})
	require.NoError(t, err)
	require.Equal(t, 1, repo.writes)

	_, err = service.AddComment(ctx, memberActor(), NewCommentInput{
		TargetType: TargetArticle, TargetID: "published", Body: "nice",
	})
	require.NoError(t, err)
	require.Equal(t, 2, repo.writes)
}

// TestAddCommentWithoutTargetCheckerKeepsLegacyBehaviour documents the degraded default
// for deployments that have not wired the checker.
func TestAddCommentWithoutTargetCheckerKeepsLegacyBehaviour(t *testing.T) {
	repo := newFakeRepo()
	service := newService(t, repo)

	_, err := service.AddComment(context.Background(), memberActor(), NewCommentInput{
		TargetType: TargetArticle, TargetID: "ghost", Body: "hello",
	})
	require.NoError(t, err)
}

// TestToggleReactionRequiresPublishedTarget covers reactions: adding one needs a
// published target, removing a stale one must still work after archival.
func TestToggleReactionRequiresPublishedTarget(t *testing.T) {
	repo := newFakeRepo()
	targets := &fakeTargets{targets: map[string]Target{
		targetKey(TargetArticle, "draft"):     {AuthorID: "u2", Published: false},
		targetKey(TargetArticle, "published"): {AuthorID: "u2", Published: true},
	}}
	service := newServiceWithPorts(t, repo, targets, nil)
	ctx := context.Background()
	active := true

	_, err := service.ToggleReaction(ctx, memberActor(), TargetArticle, "draft", "like", &active)
	require.ErrorIs(t, err, ErrTargetNotFound)
	require.Zero(t, repo.writes)

	_, err = service.ToggleReaction(ctx, memberActor(), TargetArticle, "missing", "like", &active)
	require.ErrorIs(t, err, ErrTargetNotFound)

	on, err := service.ToggleReaction(ctx, memberActor(), TargetArticle, "published", "like", &active)
	require.NoError(t, err)
	require.True(t, on)

	// Removing the same reaction on a now unpublished target stays possible: seed the
	// stored state by flipping the target out of publication.
	targets.targets[targetKey(TargetArticle, "published")] = Target{AuthorID: "u2", Published: false}
	off := false
	activeNow, err := service.ToggleReaction(ctx, memberActor(), TargetArticle, "published", "like", &off)
	require.NoError(t, err)
	require.False(t, activeNow)
}

// TestToggleBookmarkRequiresPublishedTarget pins the same rule for bookmarks.
func TestToggleBookmarkRequiresPublishedTarget(t *testing.T) {
	repo := newFakeRepo()
	targets := &fakeTargets{targets: publishedArticle("u2")}
	service := newServiceWithPorts(t, repo, targets, nil)
	ctx := context.Background()
	active := true

	_, err := service.ToggleBookmark(ctx, memberActor(), TargetArticle, "missing", &active)
	require.ErrorIs(t, err, ErrTargetNotFound)
	require.Zero(t, repo.writes)

	on, err := service.ToggleBookmark(ctx, memberActor(), TargetArticle, "a1", &active)
	require.NoError(t, err)
	require.True(t, on)
	require.Equal(t, 1, repo.writes)
}

// TestToggleFollowRequiresActiveMember is the follow half of V-15: following a user who
// does not exist on this site (or is suspended) must fail.
func TestToggleFollowRequiresActiveMember(t *testing.T) {
	repo := newFakeRepo()
	members := &fakeMembership{active: map[string]bool{"u2": true}}
	service := newServiceWithPorts(t, repo, nil, members)
	ctx := context.Background()
	active := true

	_, err := service.ToggleFollow(ctx, memberActor(), "ghost", &active)
	require.ErrorIs(t, err, ErrTargetNotFound)
	require.Zero(t, repo.writes)

	on, err := service.ToggleFollow(ctx, memberActor(), "u2", &active)
	require.NoError(t, err)
	require.True(t, on)

	// Unfollowing an account that has since been suspended must stay possible.
	members.active["u2"] = false
	off := false
	activeNow, err := service.ToggleFollow(ctx, memberActor(), "u2", &off)
	require.NoError(t, err)
	require.False(t, activeNow)
}

// TestInteractionChecksPropagateLookupFailure keeps an outage from being reported as a
// missing target.
func TestInteractionChecksPropagateLookupFailure(t *testing.T) {
	repo := newFakeRepo()
	boom := errors.New("target store down")
	service := newServiceWithPorts(t, repo, &fakeTargets{err: boom}, nil)

	_, err := service.AddComment(context.Background(), memberActor(), NewCommentInput{
		TargetType: TargetArticle, TargetID: "a1", Body: "hello",
	})
	require.ErrorIs(t, err, boom)

	_, err = service.ToggleReaction(context.Background(), memberActor(), TargetArticle, "a1", "like", nil)
	require.ErrorIs(t, err, boom)
}

// TestHandlerMapsInvisibleTargetToNotFound pins the wire contract of the new sentinel.
func TestHandlerMapsInvisibleTargetToNotFound(t *testing.T) {
	repo := newFakeRepo()
	targets := &fakeTargets{targets: map[string]Target{
		targetKey(TargetArticle, "draft"): {AuthorID: "u2", Published: false},
	}}
	service := newServiceWithPorts(t, repo, targets, nil)
	engine := newEngineWithService(service, memberActor())

	response := do(engine, http.MethodPost, "/comments",
		`{"target_type":"article","target_id":"draft","body":"hello"}`)
	require.Equal(t, http.StatusNotFound, response.Code)
	var payload map[string]any
	require.NoError(t, decodeJSON(response.Body.Bytes(), &payload))
	require.Equal(t, "not_found", payload["code"])
}

// TestServiceOptionInterfacesKeepLegacyCallSitesCompilable is a compile-time style
// guard: NewService with only its historical arguments must remain valid.
func TestServiceOptionInterfacesKeepLegacyCallSitesCompilable(t *testing.T) {
	service, err := NewService(newFakeRepo(), nil)
	require.NoError(t, err)
	require.NotNil(t, service)

	// Actor roles still flow through use cases untouched.
	require.Equal(t, site.RoleMember, memberActor().Role)
}
