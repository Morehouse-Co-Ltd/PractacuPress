package system

import (
	"context"
	"fmt"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	entgen "github.com/practacu/practacu-press/apps/api/ent"
	"github.com/practacu/practacu-press/apps/api/internal/infrastructure/db"
)

// newQueueStore builds a store over a fresh SQLite database with the schema
// applied. The queue projection is plain Ent queries, so the real schema is the
// right fixture: a hand-built fake would not catch a renamed column.
func newQueueStore(t *testing.T) (*EntQueueStore, *entgen.Client) {
	t.Helper()
	ctx := context.Background()
	handle, err := db.Open(ctx, "sqlite", db.SQLiteDSN(filepath.Join(t.TempDir(), "queue.db")))
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, handle.Close()) })
	require.NoError(t, handle.Client.Schema.Create(ctx))
	return NewEntQueueStore(handle.Client), handle.Client
}

// outboxFix describes one outbox row to insert.
type outboxFix struct {
	eventID  string
	siteID   string
	occurred time.Time
	pending  bool
	err      string
	attempts int
	retryAt  time.Time
	claimed  bool
}

// insertOutbox persists one outbox fixture.
func insertOutbox(t *testing.T, client *entgen.Client, fix outboxFix) *entgen.OutboxEvent {
	t.Helper()
	builder := client.OutboxEvent.Create().
		SetEventID(fix.eventID).
		SetSiteID(fix.siteID).
		SetEventType("content.published").
		SetAggregateType("content").
		SetAggregateID("content-1").
		SetOccurredAt(fix.occurred).
		SetAttempts(fix.attempts)
	if fix.err != "" {
		builder.SetLastError(fix.err)
	}
	if !fix.retryAt.IsZero() {
		builder.SetNextAttemptAt(fix.retryAt)
	}
	if fix.claimed {
		builder.SetClaimedAt(fix.occurred)
	}
	if !fix.pending {
		builder.SetPublishedAt(fix.occurred.Add(time.Second))
	}
	row, err := builder.Save(context.Background())
	require.NoError(t, err)
	return row
}

// insertMail persists one email_logs fixture.
func insertMail(t *testing.T, client *entgen.Client, siteID, status string) {
	t.Helper()
	_, err := client.EmailLog.Create().
		SetSiteID(siteID).
		SetToEmail("reader@example.com").
		SetStatus(status).
		Save(context.Background())
	require.NoError(t, err)
}

// TestQueueStatusCountsAndScopes covers the statistics, the recent window and
// the tenant filter of the monitored queues.
func TestQueueStatusCountsAndScopes(t *testing.T) {
	store, client := newQueueStore(t)
	ctx := context.Background()
	base := time.Date(2026, 11, 17, 10, 0, 0, 0, time.UTC)
	now := base.Add(2 * time.Hour)

	// site-a: one pending, one failed, one published.
	insertOutbox(t, client, outboxFix{eventID: "evt-a-pending", siteID: "site-a", occurred: base, pending: true})
	insertOutbox(t, client, outboxFix{
		eventID: "evt-a-failed", siteID: "site-a", occurred: base.Add(10 * time.Minute),
		pending: true, err: "smtp timeout", attempts: 3, retryAt: now.Add(-time.Minute),
	})
	insertOutbox(t, client, outboxFix{eventID: "evt-a-published", siteID: "site-a", occurred: base.Add(20 * time.Minute)})
	// site-b must never leak into site-a's view.
	insertOutbox(t, client, outboxFix{eventID: "evt-b-failed", siteID: "site-b", occurred: base, pending: true, err: "boom", attempts: 1})

	insertMail(t, client, "site-a", emailStatusQueued)
	insertMail(t, client, "site-a", emailStatusQueued)
	insertMail(t, client, "site-a", emailStatusFailed)
	insertMail(t, client, "site-b", emailStatusFailed)

	status, err := store.Status(ctx, "site-a", now)
	require.NoError(t, err)
	// Pending counts every unpublished row; failed is the subset whose last
	// attempt failed.
	require.Equal(t, 2, status.Outbox.Pending)
	require.Equal(t, 1, status.Outbox.Failed)
	require.Equal(t, int64(2*60*60), status.Outbox.OldestAgeSeconds)
	require.Equal(t, 2, status.Mail.Queued)
	require.Equal(t, 1, status.Mail.Failed)
	require.Len(t, status.Recent, 3)

	// Newest first; the published row maps onto "published", the error row onto
	// "failed" and the clean one onto "pending".
	require.Equal(t, "evt-a-published", status.Recent[0].EventID)
	require.Equal(t, QueueEventPublished, status.Recent[0].Status)
	require.Equal(t, "evt-a-failed", status.Recent[1].EventID)
	require.Equal(t, QueueEventFailed, status.Recent[1].Status)
	require.Equal(t, 3, status.Recent[1].Attempts)
	require.Equal(t, "smtp timeout", status.Recent[1].LastError)
	require.Equal(t, "evt-a-pending", status.Recent[2].EventID)
	require.Equal(t, QueueEventPending, status.Recent[2].Status)

	// The platform view has no tenant filter.
	platform, err := store.Status(ctx, "", now)
	require.NoError(t, err)
	require.Equal(t, 3, platform.Outbox.Pending)
	require.Equal(t, 2, platform.Outbox.Failed)

	// An empty site has empty, not zero-valued, summaries and a non-nil list.
	empty, err := store.Status(ctx, "site-missing", now)
	require.NoError(t, err)
	require.Equal(t, 0, empty.Outbox.Pending)
	require.NotNil(t, empty.Recent)
	require.Empty(t, empty.Recent)
}

// TestQueueRetryResetsDeliveryState covers the documented retry semantics:
// published_at stays NULL, next_attempt_at/claimed_at are cleared, attempts and
// the last error are reset so the event really gets a fresh delivery budget.
func TestQueueRetryResetsDeliveryState(t *testing.T) {
	store, client := newQueueStore(t)
	ctx := context.Background()
	base := time.Date(2026, 11, 17, 10, 0, 0, 0, time.UTC)

	failed := insertOutbox(t, client, outboxFix{
		eventID: "evt-a-failed", siteID: "site-a", occurred: base,
		pending: true, err: "relay rejected", attempts: 8, retryAt: base.Add(time.Hour),
		// A claimed row must be released too, or a worker keeps seeing the lease.
		claimed: true,
	})
	published := insertOutbox(t, client, outboxFix{
		eventID: "evt-a-published", siteID: "site-a", occurred: base})

	retried, err := store.RetryFailed(ctx, "site-a", []string{failed.EventID}, 50)
	require.NoError(t, err)
	require.Equal(t, 1, retried)

	reloaded, err := client.OutboxEvent.Get(ctx, failed.ID)
	require.NoError(t, err)
	require.Nil(t, reloaded.PublishedAt)
	require.Nil(t, reloaded.NextAttemptAt)
	require.Nil(t, reloaded.ClaimedAt)
	require.Nil(t, reloaded.LastError)
	require.Equal(t, 0, reloaded.Attempts)

	// A published row is never requeued by an explicit id.
	retried, err = store.RetryFailed(ctx, "site-a", []string{published.EventID}, 50)
	require.NoError(t, err)
	require.Equal(t, 0, retried)
}

// TestQueueRetryDefaultsToTheNewestFailedRows covers the empty request shape and
// the tenant boundary.
func TestQueueRetryDefaultsToTheNewestFailedRows(t *testing.T) {
	store, client := newQueueStore(t)
	ctx := context.Background()
	base := time.Date(2026, 11, 17, 10, 0, 0, 0, time.UTC)

	insertOutbox(t, client, outboxFix{eventID: "evt-a-old", siteID: "site-a", occurred: base, pending: true, err: "old", attempts: 1})
	insertOutbox(t, client, outboxFix{eventID: "evt-a-new", siteID: "site-a", occurred: base.Add(time.Hour), pending: true, err: "new", attempts: 2})
	insertOutbox(t, client, outboxFix{eventID: "evt-a-pending", siteID: "site-a", occurred: base.Add(2 * time.Hour), pending: true})
	insertOutbox(t, client, outboxFix{eventID: "evt-b-failed", siteID: "site-b", occurred: base, pending: true, err: "other", attempts: 1})

	retried, err := store.RetryFailed(ctx, "site-a", nil, 1)
	require.NoError(t, err)
	require.Equal(t, 1, retried, "limit bounds the default batch")

	status, err := store.Status(ctx, "site-a", base.Add(3*time.Hour))
	require.NoError(t, err)
	require.Equal(t, 1, status.Outbox.Failed)
	var stillFailed string
	for _, event := range status.Recent {
		if event.Status == QueueEventFailed {
			stillFailed = event.EventID
		}
	}
	require.Equal(t, "evt-a-old", stillFailed)

	// site-b's failed row was outside the tenant scope.
	other, err := store.Status(ctx, "site-b", base.Add(3*time.Hour))
	require.NoError(t, err)
	require.Equal(t, 1, other.Outbox.Failed)

	// The platform administrator can drain the whole deployment.
	retried, err = store.RetryFailed(ctx, "", nil, 50)
	require.NoError(t, err)
	require.Equal(t, 2, retried)
	all, err := store.Status(ctx, "", base.Add(3*time.Hour))
	require.NoError(t, err)
	require.Equal(t, 0, all.Outbox.Failed)
}

// TestQueueRetryRejectsTooManyIDs keeps one request bounded.
func TestQueueRetryRejectsTooManyIDs(t *testing.T) {
	store, _ := newQueueStore(t)
	ids := make([]string, MaxQueueRetryIDs+1)
	for index := range ids {
		ids[index] = fmt.Sprintf("evt-x-%d", index)
	}
	_, err := store.RetryFailed(context.Background(), "site-a", ids, 50)
	require.ErrorIs(t, err, ErrTooManyRetryIDs)
}
