package messaging

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/internal/notifications"
)

// fakeNotifier records what the fan-out asked for.
type fakeNotifier struct {
	inputs []notifications.NewInput
	err    error
}

func (f *fakeNotifier) Notify(
	_ context.Context,
	in notifications.NewInput,
) (notifications.Notification, error) {
	if f.err != nil {
		return notifications.Notification{}, f.err
	}
	f.inputs = append(f.inputs, in)
	return notifications.Notification{ID: "n1", Type: in.Type}, nil
}

var _ Notifier = (*fakeNotifier)(nil)

func notifyService(t *testing.T, notifier Notifier) *Service {
	t.Helper()
	service, err := NewService(newFakeRepo(), WithNotifier(notifier))
	require.NoError(t, err)
	service.now = func() time.Time { return time.Date(2026, 11, 17, 12, 0, 0, 0, time.UTC) }
	return service
}

// TestSendNotifiesEveryOtherMember is contract B's happy path.
func TestSendNotifiesEveryOtherMember(t *testing.T) {
	notifier := &fakeNotifier{}
	service := notifyService(t, notifier)
	ctx := context.Background()

	conversation, err := service.StartConversation(ctx, memberActor("u1"), KindGroup, []string{"u2", "u3"})
	require.NoError(t, err)

	_, err = service.Send(ctx, memberActor("u1"), NewMessageInput{
		ConversationID: conversation.ID,
		Body:           "下周的审核排期要不要调整？\n第二行",
	})
	require.NoError(t, err)

	require.Len(t, notifier.inputs, 2, "the sender is skipped and both recipients are notified")
	notified := map[string]notifications.NewInput{}
	for _, in := range notifier.inputs {
		notified[in.UserID] = in
	}
	require.NotContains(t, notified, "u1", "nobody needs a notification for their own message")

	for _, userID := range []string{"u2", "u3"} {
		in := notified[userID]
		require.Equal(t, "s1", in.SiteID)
		require.Equal(t, notifications.TypeMessageDirect, in.Type)
		require.Equal(t, "u1", in.ActorID)
		require.Equal(t, conversation.ID, in.SubjectID)
		require.Equal(t, "message:"+conversation.ID+":"+userID, in.DedupeKey)
		require.Equal(t, MessageNotifyWindow, in.DedupeWindow)
		require.Equal(t, conversation.ID, in.Payload["conversation_id"])
		require.NotContains(t, in.Payload["excerpt"], "\n", "the inbox renders one line")
		require.NotEmpty(t, in.Payload["title"])
	}
}

// TestSendSkipsSuspendedRecipients keeps a suspended account from collecting
// messages it cannot read.
func TestSendSkipsSuspendedRecipients(t *testing.T) {
	notifier := &fakeNotifier{}
	service := notifyService(t, notifier)
	ctx := context.Background()

	conversation, err := service.StartConversation(ctx, memberActor("u1"), KindGroup, []string{"u2", "u3"})
	require.NoError(t, err)
	// The conversation was created before the suspension; the fan-out is what has to
	// notice a member that is no longer active.
	service.members = &fakeMembership{active: map[string]bool{"u1": true, "u2": true, "u3": false}}

	_, err = service.Send(ctx, memberActor("u1"), NewMessageInput{ConversationID: conversation.ID, Body: "hi"})
	require.NoError(t, err)

	require.Len(t, notifier.inputs, 1)
	require.Equal(t, "u2", notifier.inputs[0].UserID)
}

// TestSendSurvivesNotificationFailure pins the best effort contract: the message is
// already committed and must be reported as sent even when the inbox write fails.
func TestSendSurvivesNotificationFailure(t *testing.T) {
	notifier := &fakeNotifier{err: errors.New("inbox unavailable")}
	repo := newFakeRepo()
	service, err := NewService(repo, WithNotifier(notifier))
	require.NoError(t, err)
	ctx := context.Background()

	conversation, err := service.StartConversation(ctx, memberActor("u1"), KindDirect, []string{"u2"})
	require.NoError(t, err)
	_, err = service.Send(ctx, memberActor("u1"), NewMessageInput{ConversationID: conversation.ID, Body: "hi"})
	require.NoError(t, err)
	require.Len(t, repo.messages, 1, "the message itself is stored")
}

// TestSendWithoutNotifierStillWorks documents that the fan-out is optional wiring.
func TestSendWithoutNotifierStillWorks(t *testing.T) {
	service := newService(t, newFakeRepo())
	ctx := context.Background()

	conversation, err := service.StartConversation(ctx, memberActor("u1"), KindDirect, []string{"u2"})
	require.NoError(t, err)
	_, err = service.Send(ctx, memberActor("u1"), NewMessageInput{ConversationID: conversation.ID, Body: "hi"})
	require.NoError(t, err)
}

// TestMessageExcerptFitsPayloadBounds proves a long message cannot fail payload
// validation in the notifications module.
func TestMessageExcerptFitsPayloadBounds(t *testing.T) {
	body := strings.Repeat("很长的消息内容 ", 40)
	excerpt := messageExcerpt(body)

	require.LessOrEqual(t, len(excerpt), notifications.MaxPayloadValueLength)
	require.True(t, strings.HasSuffix(excerpt, "…"), "a cut excerpt is marked")
	require.NotContains(t, excerpt, "\n")
	require.True(t, utf8.ValidString(excerpt))
}

// TestMessageExcerptKeepsShortBody leaves a short message alone.
func TestMessageExcerptKeepsShortBody(t *testing.T) {
	require.Equal(t, "短的私信", messageExcerpt("  短的私信  "))
	require.Equal(t, "", messageExcerpt("   "))
}
