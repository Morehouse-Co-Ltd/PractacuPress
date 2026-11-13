package notifications

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"
)

type recordingPublisher struct {
	events []LiveEvent
}

func (p *recordingPublisher) Publish(_ context.Context, event LiveEvent) {
	p.events = append(p.events, event)
}

// TestNotifyPublishesLiveEvent pins the realtime contract: the push happens after
// the row is stored, is addressed to the recipient only, and carries a flat
// payload with the notification id so the browser can dedupe against the inbox.
func TestNotifyPublishesLiveEvent(t *testing.T) {
	repo := newFakeRepo()
	publisher := &recordingPublisher{}
	service, err := NewService(repo, WithPublisher(publisher))
	require.NoError(t, err)

	created, err := service.Notify(context.Background(), NewInput{
		SiteID:    "s1",
		UserID:    "u2",
		Type:      TypeComment,
		ActorID:   "u1",
		SubjectID: "c1",
		Payload:   map[string]string{"excerpt": "hi"},
	})
	require.NoError(t, err)

	require.Len(t, publisher.events, 1)
	event := publisher.events[0]
	require.Equal(t, "notification.created", event.Type)
	require.Equal(t, "s1", event.SiteID)
	require.Equal(t, "u2", event.AudienceUserID)
	// The push has no replay id on purpose; the stored id travels in the payload.
	require.Equal(t, created.ID, event.Payload["notification_id"])
	require.Equal(t, string(TypeComment), event.Payload["notification_type"])
	require.Equal(t, "u1", event.Payload["actor_id"])
	require.Equal(t, "c1", event.Payload["subject_id"])
	require.Equal(t, "hi", event.Payload["excerpt"])
}

// TestNotifyWithoutPublisherStillStores keeps the optional port honest: a
// deployment without a live transport must not lose the inbox row.
func TestNotifyWithoutPublisherStillStores(t *testing.T) {
	repo := newFakeRepo()
	service, err := NewService(repo)
	require.NoError(t, err)

	created, err := service.Notify(context.Background(), NewInput{
		SiteID: "s1", UserID: "u2", Type: TypeFollow, ActorID: "u1",
	})
	require.NoError(t, err)
	require.NotEmpty(t, created.ID)
	require.Len(t, repo.items, 1)
}
