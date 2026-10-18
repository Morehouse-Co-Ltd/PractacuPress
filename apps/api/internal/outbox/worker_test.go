package outbox

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

type fakeRepo struct {
	events    []Event
	published []string
	failed    map[string]time.Time
	reasons   map[string]string
}

func newFakeRepo(events ...Event) *fakeRepo {
	return &fakeRepo{events: events, failed: map[string]time.Time{}, reasons: map[string]string{}}
}

func (f *fakeRepo) Claim(_ context.Context, limit int, _ time.Time, _ time.Duration) ([]Event, error) {
	if len(f.events) > limit {
		return f.events[:limit], nil
	}
	return f.events, nil
}

func (f *fakeRepo) MarkPublished(_ context.Context, eventID string, _ time.Time) error {
	f.published = append(f.published, eventID)
	return nil
}

func (f *fakeRepo) RescheduleAfterFailure(_ context.Context, eventID string, next time.Time, reason string) error {
	f.failed[eventID] = next
	f.reasons[eventID] = reason
	return nil
}

type failingHandler struct{ failIDs map[string]bool }

func (h failingHandler) Handle(_ context.Context, event Event) error {
	if h.failIDs[event.EventID] {
		return errors.New("handler failed")
	}
	return nil
}

func fixedClock() func() time.Time {
	at := time.Date(2026, 10, 20, 12, 0, 0, 0, time.UTC)
	return func() time.Time { return at }
}

func TestNewWorkerRequiresDependencies(t *testing.T) {
	_, err := NewWorker(Config{})
	require.Error(t, err)

	_, err = NewWorker(Config{Repository: newFakeRepo()})
	require.Error(t, err, "a handler is mandatory")
}

func TestRunOncePublishesSuccessfulEvents(t *testing.T) {
	repo := newFakeRepo(
		Event{ID: "1", EventID: "e1", SiteID: "s1", Type: "comment.created"},
		Event{ID: "2", EventID: "e2", SiteID: "s1", Type: "reaction.created"},
	)
	worker, err := NewWorker(Config{
		Repository: repo,
		Handler:    failingHandler{}, // never fails
		Now:        fixedClock(),
	})
	require.NoError(t, err)

	result, err := worker.RunOnce(context.Background(), 10)
	require.NoError(t, err)
	require.Equal(t, 2, result.Claimed)
	require.Equal(t, 2, result.Published)
	require.Zero(t, result.Failed)
	require.ElementsMatch(t, []string{"e1", "e2"}, repo.published)
}

// TestFailureDoesNotBlockTheBatch is the property that keeps one poison event from
// stalling every notification behind it.
func TestFailureDoesNotBlockTheBatch(t *testing.T) {
	repo := newFakeRepo(
		Event{ID: "1", EventID: "bad", SiteID: "s1", Type: "x"},
		Event{ID: "2", EventID: "good", SiteID: "s1", Type: "y"},
	)
	worker, err := NewWorker(Config{
		Repository: repo,
		Handler:    failingHandler{failIDs: map[string]bool{"bad": true}},
		Now:        fixedClock(),
	})
	require.NoError(t, err)

	result, err := worker.RunOnce(context.Background(), 10)
	require.NoError(t, err)
	require.Equal(t, 1, result.Published)
	require.Equal(t, 1, result.Failed)
	require.Equal(t, []string{"good"}, repo.published)
	require.Contains(t, repo.reasons, "bad")
}

func TestFailureSchedulesRetryWithBackoff(t *testing.T) {
	repo := newFakeRepo(Event{ID: "1", EventID: "e1", SiteID: "s1", Attempts: 1})
	worker, err := NewWorker(Config{
		Repository: repo,
		Handler:    failingHandler{failIDs: map[string]bool{"e1": true}},
		Now:        fixedClock(),
	})
	require.NoError(t, err)

	_, err = worker.RunOnce(context.Background(), 10)
	require.NoError(t, err)

	retryAt := repo.failed["e1"]
	require.Equal(t, fixedClock()().Add(Backoff(2)), retryAt)
}

func TestPoisonEventIsAbandonedAtMaxAttempts(t *testing.T) {
	repo := newFakeRepo(Event{ID: "1", EventID: "e1", Attempts: MaxAttempts - 1})
	worker, err := NewWorker(Config{
		Repository: repo,
		Handler:    failingHandler{failIDs: map[string]bool{"e1": true}},
		Now:        fixedClock(),
	})
	require.NoError(t, err)

	result, err := worker.RunOnce(context.Background(), 10)
	require.NoError(t, err)
	require.Equal(t, 1, result.Failed)
	require.Contains(t, repo.reasons["e1"], "abandoned")
	require.Empty(t, repo.published)
}

func TestBackoffGrowsAndIsCapped(t *testing.T) {
	require.Equal(t, baseBackoff, Backoff(0))
	require.Equal(t, baseBackoff, Backoff(1))
	require.Equal(t, 2*baseBackoff, Backoff(2))
	require.Equal(t, 4*baseBackoff, Backoff(3))
	require.Equal(t, maxBackoff, Backoff(50), "the delay is capped")
}

func TestRunOnceClampsBatchSize(t *testing.T) {
	events := make([]Event, 0, DefaultBatch+10)
	for i := 0; i < DefaultBatch+10; i++ {
		events = append(events, Event{ID: string(rune('a' + i%26)), EventID: string(rune('a' + i%26))})
	}

	repo := newFakeRepo(events...)
	worker, err := NewWorker(Config{Repository: repo, Handler: failingHandler{}, Now: fixedClock()})
	require.NoError(t, err)

	result, err := worker.RunOnce(context.Background(), 10_000)
	require.NoError(t, err)
	require.LessOrEqual(t, result.Claimed, DefaultBatch)
}

func TestHandlerFuncAdaptsFunctions(t *testing.T) {
	called := 0
	repo := newFakeRepo(Event{EventID: "e1"})
	worker, err := NewWorker(Config{
		Repository: repo,
		Handler:    HandlerFunc(func(context.Context, Event) error { called++; return nil }),
		Now:        fixedClock(),
	})
	require.NoError(t, err)

	_, err = worker.RunOnce(context.Background(), 10)
	require.NoError(t, err)
	require.Equal(t, 1, called)
}
