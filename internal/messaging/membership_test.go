package messaging

import (
	"context"
	"errors"
	"testing"

	"github.com/stretchr/testify/require"
)

// fakeMembership is the site membership port used by the V-14 regression tests.
type fakeMembership struct {
	active map[string]bool
	err    error
	calls  []string
}

func (f *fakeMembership) IsActiveMember(_ context.Context, siteID, userID string) (bool, error) {
	f.calls = append(f.calls, siteID+"/"+userID)
	if f.err != nil {
		return false, f.err
	}
	return f.active[userID], nil
}

func newServiceWithMembership(t *testing.T, repo Repository, members MembershipChecker) *Service {
	t.Helper()
	service, err := NewService(repo, WithMembershipChecker(members))
	require.NoError(t, err)
	return service
}

// TestStartConversationRejectsUserWhoIsNotAnActiveMember is the V-14 regression: a
// client must not be able to write a foreign or nonexistent user id into the member
// table.
func TestStartConversationRejectsUserWhoIsNotAnActiveMember(t *testing.T) {
	repo := newFakeRepo()
	members := &fakeMembership{active: map[string]bool{"u1": true}}
	service := newServiceWithMembership(t, repo, members)

	_, err := service.StartConversation(context.Background(), memberActor("u1"), KindDirect, []string{"ghost"})
	require.ErrorIs(t, err, ErrInvalidInput)
	require.Empty(t, repo.conversations, "a rejected conversation must not be stored")

	// A suspended member answers the same way; the response is not an account oracle.
	members.active["u2"] = false
	_, err = service.StartConversation(context.Background(), memberActor("u1"), KindDirect, []string{"u2"})
	require.ErrorIs(t, err, ErrInvalidInput)
	require.Empty(t, repo.conversations)
}

// TestStartConversationRejectsInactiveCreator closes the symmetric hole: a suspended
// user holding a still valid access token must not start new threads either.
func TestStartConversationRejectsInactiveCreator(t *testing.T) {
	repo := newFakeRepo()
	members := &fakeMembership{active: map[string]bool{"u2": true}}
	service := newServiceWithMembership(t, repo, members)

	_, err := service.StartConversation(context.Background(), memberActor("u1"), KindDirect, []string{"u2"})
	require.ErrorIs(t, err, ErrInvalidInput)
	require.Empty(t, repo.conversations)
}

// TestStartConversationChecksEveryMember covers group threads: one bad member rejects
// the whole creation, and the checker is asked about every id.
func TestStartConversationChecksEveryMember(t *testing.T) {
	repo := newFakeRepo()
	members := &fakeMembership{active: map[string]bool{"u1": true, "u2": true}}
	service := newServiceWithMembership(t, repo, members)

	_, err := service.StartConversation(context.Background(), memberActor("u1"), KindGroup, []string{"u2", "u9"})
	require.ErrorIs(t, err, ErrInvalidInput)
	require.Empty(t, repo.conversations)
	require.ElementsMatch(t, []string{"s1/u1", "s1/u2", "s1/u9"}, members.calls,
		"every supplied member id must be resolved on the actor's site")
}

// TestStartConversationAcceptsActiveMembers pins the positive path.
func TestStartConversationAcceptsActiveMembers(t *testing.T) {
	repo := newFakeRepo()
	members := &fakeMembership{active: map[string]bool{"u1": true, "u2": true}}
	service := newServiceWithMembership(t, repo, members)

	created, err := service.StartConversation(context.Background(), memberActor("u1"), KindDirect, []string{"u2"})
	require.NoError(t, err)
	require.Len(t, created.Members, 2)
	require.Len(t, repo.conversations, 1)
	require.Equal(t, []string{"s1/u1", "s1/u2"}, members.calls)
}

// TestStartConversationPropagatesCheckerFailure keeps an infrastructure outage from
// being reported as a bad member list.
func TestStartConversationPropagatesCheckerFailure(t *testing.T) {
	repo := newFakeRepo()
	boom := errors.New("membership store down")
	service := newServiceWithMembership(t, repo, &fakeMembership{err: boom})

	_, err := service.StartConversation(context.Background(), memberActor("u1"), KindDirect, []string{"u2"})
	require.ErrorIs(t, err, boom)
	require.Empty(t, repo.conversations)
}

// TestStartConversationWithoutCheckerKeepsLegacyBehaviour documents the degraded
// default: a deployment that has not wired the checker keeps the old behaviour, which
// is why main.go must pass WithMembershipChecker.
func TestStartConversationWithoutCheckerKeepsLegacyBehaviour(t *testing.T) {
	service := newService(t, newFakeRepo())

	created, err := service.StartConversation(context.Background(), memberActor("u1"), KindDirect, []string{"not-a-known-user"})
	require.NoError(t, err)
	require.Len(t, created.Members, 2)
}
