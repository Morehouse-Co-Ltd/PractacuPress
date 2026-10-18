package outboxstore_test

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/apps/api/internal/infrastructure/db"
	"github.com/practacu/practacu-press/apps/api/internal/infrastructure/outboxstore"
	"github.com/practacu/practacu-press/apps/api/internal/outbox"
)

func newStore(t *testing.T) (*outboxstore.Store, *db.DB, string) {
	t.Helper()
	ctx := context.Background()

	handle, err := db.Open(ctx, "sqlite", db.SQLiteDSN(filepath.Join(t.TempDir(), "outbox.db")))
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, handle.Close()) })
	require.NoError(t, handle.Client.Schema.Create(ctx))

	siteRow, err := handle.Client.Site.Create().SetSlug("main").SetName("Main").Save(ctx)
	require.NoError(t, err)

	return outboxstore.New(handle.Client), handle, siteRow.ID
}

func seed(t *testing.T, handle *db.DB, siteID, eventID string) string {
	t.Helper()
	row, err := handle.Client.OutboxEvent.Create().
		SetEventID(eventID).
		SetSiteID(siteID).
		SetEventType("comment.created").
		SetAggregateType("comment").
		SetAggregateID("c1").
		Save(context.Background())
	require.NoError(t, err)
	return row.ID
}

func TestClaimMarksEventsInvisible(t *testing.T) {
	store, handle, siteID := newStore(t)
	ctx := context.Background()
	now := time.Now().UTC()

	seed(t, handle, siteID, "e1")
	seed(t, handle, siteID, "e2")

	first, err := store.Claim(ctx, 10, now, time.Minute)
	require.NoError(t, err)
	require.Len(t, first, 2)

	// A second worker inside the lease window sees nothing: the claim is exclusive.
	second, err := store.Claim(ctx, 10, now, time.Minute)
	require.NoError(t, err)
	require.Empty(t, second)

	// After the lease expires the event becomes claimable again.
	third, err := store.Claim(ctx, 10, now.Add(2*time.Minute), time.Minute)
	require.NoError(t, err)
	require.Len(t, third, 2, "an abandoned claim must be reclaimable")
}

func TestMarkPublishedRemovesFromQueue(t *testing.T) {
	store, handle, siteID := newStore(t)
	ctx := context.Background()
	now := time.Now().UTC()

	seed(t, handle, siteID, "e1")
	claimed, err := store.Claim(ctx, 10, now, time.Minute)
	require.NoError(t, err)
	require.Len(t, claimed, 1)

	require.NoError(t, store.MarkPublished(ctx, "e1", now.Add(time.Second)))

	after, err := store.Claim(ctx, 10, now.Add(5*time.Minute), time.Minute)
	require.NoError(t, err)
	require.Empty(t, after, "a published event is never claimed again")
}

func TestRescheduleBacksOffAndCountsAttempts(t *testing.T) {
	store, handle, siteID := newStore(t)
	ctx := context.Background()
	now := time.Now().UTC()

	seed(t, handle, siteID, "e1")
	_, err := store.Claim(ctx, 10, now, time.Minute)
	require.NoError(t, err)

	require.NoError(t, store.RescheduleAfterFailure(ctx, "e1", now.Add(time.Minute), "boom"))

	// Not due yet.
	pending, err := store.Claim(ctx, 10, now.Add(30*time.Second), time.Minute)
	require.NoError(t, err)
	require.Empty(t, pending)

	// Due after the backoff.
	due, err := store.Claim(ctx, 10, now.Add(2*time.Minute), time.Minute)
	require.NoError(t, err)
	require.Len(t, due, 1)
	require.Equal(t, 1, due[0].Attempts, "the attempt counter moved")

	row, err := handle.Client.OutboxEvent.Query().All(ctx)
	require.NoError(t, err)
	require.Equal(t, "boom", *row[0].LastError)
}

func TestWorkerAgainstRealStore(t *testing.T) {
	store, handle, siteID := newStore(t)
	ctx := context.Background()

	seed(t, handle, siteID, "e1")
	seed(t, handle, siteID, "e2")

	delivered := 0
	worker, err := outbox.NewWorker(outbox.Config{
		Repository: store,
		Handler: outbox.HandlerFunc(func(context.Context, outbox.Event) error {
			delivered++
			return nil
		}),
	})
	require.NoError(t, err)

	result, err := worker.RunOnce(ctx, 10)
	require.NoError(t, err)
	require.Equal(t, 2, result.Published)
	require.Equal(t, 2, delivered)

	// Nothing left to do.
	result, err = worker.RunOnce(ctx, 10)
	require.NoError(t, err)
	require.Zero(t, result.Claimed)
}

// TestReplayHidesOtherUsersEvents is the review P0-2 regression: a site wide query must
// not hand a user another user's private events.
func TestReplayHidesOtherUsersEvents(t *testing.T) {
	store, handle, siteID := newStore(t)
	ctx := context.Background()
	now := time.Now().UTC()

	broadcast := seed(t, handle, siteID, "e1")
	_, err := handle.Client.OutboxEvent.UpdateOneID(broadcast).SetPublishedAt(now).Save(ctx)
	require.NoError(t, err)

	addressed, err := handle.Client.OutboxEvent.Create().
		SetEventID("e2").SetSiteID(siteID).SetEventType("message.created").
		SetAggregateType("message").SetAggregateID("m1").
		SetAudienceUserID("u2").SetPublishedAt(now).Save(ctx)
	require.NoError(t, err)
	require.NotEmpty(t, addressed.ID)

	replayer, err := outbox.NewReplayer(store)
	require.NoError(t, err)

	mine, err := replayer.After(ctx, siteID, "u1", "", 100)
	require.NoError(t, err)
	require.Len(t, mine, 1, "a message addressed to u2 must not appear for u1")
	require.Equal(t, "e1", mine[0].EventID)

	theirs, err := replayer.After(ctx, siteID, "u2", "", 100)
	require.NoError(t, err)
	require.Len(t, theirs, 2)

	// The cursor resumes strictly after the given id.
	after, err := replayer.After(ctx, siteID, "u2", "e1", 100)
	require.NoError(t, err)
	require.Len(t, after, 1)
	require.Equal(t, "e2", after[0].EventID)
}

func TestReplayOnlyReturnsPublishedEvents(t *testing.T) {
	store, handle, siteID := newStore(t)
	ctx := context.Background()

	seed(t, handle, siteID, "e1") // stays unpublished

	replayer, err := outbox.NewReplayer(store)
	require.NoError(t, err)

	events, err := replayer.After(ctx, siteID, "u1", "", 100)
	require.NoError(t, err)
	require.Empty(t, events, "undelivered events are not replayable")
}