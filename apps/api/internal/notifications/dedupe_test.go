package notifications

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// ExistsRecent implements DedupeChecker on the shared fake repository.
//
// The method lives here (not in service_test.go) because the dedupe window is a
// contract B behaviour and its fake should stay next to what it proves.
func (f *fakeRepo) ExistsRecent(
	_ context.Context,
	siteID, userID, dedupeKey string,
	since time.Time,
) (bool, error) {
	for _, item := range f.items {
		if item.SiteID != siteID || item.UserID != userID {
			continue
		}
		if item.DedupeKey != dedupeKey {
			continue
		}
		if !item.CreatedAt.Before(since) {
			return true, nil
		}
	}
	return false, nil
}

var _ DedupeChecker = (*fakeRepo)(nil)

// messageInput is contract B's producer input.
func messageInput() NewInput {
	return NewInput{
		SiteID:       "s1",
		UserID:       "u2",
		Type:         TypeMessageDirect,
		ActorID:      "u1",
		SubjectID:    "c1",
		Payload:      map[string]string{"title": "私信", "excerpt": "hi", "conversation_id": "c1"},
		DedupeKey:    "message:c1:u2",
		DedupeWindow: 10 * time.Minute,
	}
}

// TestNotifyCollapsesMessageBurstInsideTenMinutes is contract B: a repeated message
// inside the window does not add an inbox row, a later one does.
func TestNotifyCollapsesMessageBurstInsideTenMinutes(t *testing.T) {
	repo := newFakeRepo()
	service := newService(t, repo)
	ctx := context.Background()

	now := time.Date(2026, 11, 17, 12, 0, 0, 0, time.UTC)
	service.now = func() time.Time { return now }

	_, err := service.Notify(ctx, messageInput())
	require.NoError(t, err)
	require.Len(t, repo.items, 1)

	// A second message two minutes later is the same burst.
	now = now.Add(2 * time.Minute)
	_, err = service.Notify(ctx, messageInput())
	require.NoError(t, err)
	require.Len(t, repo.items, 1, "a repeated message inside the window collapses")

	// Eleven minutes after the first row the window has passed.
	now = now.Add(11 * time.Minute)
	_, err = service.Notify(ctx, messageInput())
	require.NoError(t, err)
	require.Len(t, repo.items, 2, "a message after the window notifies again")
}

// TestNotifyDedupeIsPerRecipient keeps one member's burst from silencing another's.
func TestNotifyDedupeIsPerRecipient(t *testing.T) {
	repo := newFakeRepo()
	service := newService(t, repo)
	ctx := context.Background()

	first := messageInput()
	second := messageInput()
	second.UserID = "u3"
	second.DedupeKey = "message:c1:u3"

	_, err := service.Notify(ctx, first)
	require.NoError(t, err)
	_, err = service.Notify(ctx, second)
	require.NoError(t, err)
	require.Len(t, repo.items, 2, "the dedupe key includes the recipient")
}

// TestMessageDirectTypeIsAccepted pins the contract B wire value.
func TestMessageDirectTypeIsAccepted(t *testing.T) {
	require.Equal(t, "message.created", string(TypeMessageDirect))

	validated, err := Validate(messageInput())
	require.NoError(t, err)
	require.Equal(t, TypeMessageDirect, validated.Type)

	service := newService(t, newFakeRepo())
	created, err := service.Notify(context.Background(), messageInput())
	require.NoError(t, err)
	require.Equal(t, Type("message.created"), created.Type)
}

// TestNotifyRejectsNegativeDedupeWindow keeps a producer bug from becoming a window
// that never expires (or one that is silently ignored).
func TestNotifyRejectsNegativeDedupeWindow(t *testing.T) {
	in := messageInput()
	in.DedupeWindow = -time.Minute

	_, err := Validate(in)
	require.ErrorIs(t, err, ErrInvalidInput)
}

// TestDefaultDedupeWindowStillApplies keeps the pre-contract producers working.
func TestDefaultDedupeWindowStillApplies(t *testing.T) {
	repo := newFakeRepo()
	service := newService(t, repo)
	ctx := context.Background()

	now := time.Date(2026, 11, 17, 12, 0, 0, 0, time.UTC)
	service.now = func() time.Time { return now }

	in := messageInput()
	in.Type = TypeReaction
	in.DedupeWindow = 0
	in.DedupeKey = "reaction:p1:u2"

	_, err := service.Notify(ctx, in)
	require.NoError(t, err)
	now = now.Add(time.Hour)
	_, err = service.Notify(ctx, in)
	require.NoError(t, err)
	require.Len(t, repo.items, 1, "the 24 hour default window still collapses a repeat")
}
