// Package outbox delivers domain events reliably.
//
// Business changes and their events are written in one transaction, so an event that
// exists always corresponds to a committed change. The worker then delivers it with
// bounded retries: at-least-once delivery is acceptable because handlers are
// idempotent, at-most-once is not, because a lost event is unrecoverable.
package outbox

import (
	"context"
	"errors"
	"fmt"
	"time"
)

// Event is one pending domain event.
type Event struct {
	// ID is the row id.
	ID string
	// EventID is the UUIDv7 clients use for resume.
	EventID string
	SiteID  string
	// AudienceUserID empty means the whole site may observe the event.
	AudienceUserID string
	Type           string
	AggregateID    string
	Payload        map[string]any
	Attempts       int
}

// Repository is the persistence contract for the outbox.
type Repository interface {
	// Claim locks up to limit due events for this worker.
	Claim(ctx context.Context, limit int, now time.Time, lease time.Duration) ([]Event, error)
	// MarkPublished records successful delivery.
	MarkPublished(ctx context.Context, eventID string, at time.Time) error
	// RescheduleAfterFailure records a failed attempt.
	RescheduleAfterFailure(ctx context.Context, eventID string, nextAttempt time.Time, reason string) error
}

// Handler delivers one event. It must be idempotent.
type Handler interface {
	Handle(ctx context.Context, event Event) error
}

// HandlerFunc adapts a function to Handler.
type HandlerFunc func(ctx context.Context, event Event) error

// Handle implements Handler.
func (f HandlerFunc) Handle(ctx context.Context, event Event) error { return f(ctx, event) }

// Bounds.
const (
	// DefaultBatch is how many events one pass claims.
	DefaultBatch = 50
	// ClaimLease is how long a claimed event stays invisible to other workers.
	ClaimLease = 2 * time.Minute
	// MaxAttempts is where an event is abandoned for manual handling.
	MaxAttempts = 8
	// baseBackoff is the first retry delay; it doubles per attempt.
	baseBackoff = 2 * time.Second
	// maxBackoff caps the exponential growth.
	maxBackoff = 10 * time.Minute
)

// Result summarises one pass.
type Result struct {
	Claimed   int
	Published int
	Failed    int
	Abandoned int
}

// Worker delivers pending events.
type Worker struct {
	repo        Repository
	handler     Handler
	now         func() time.Time
	maxAttempts int
}

// Config configures a Worker.
type Config struct {
	Repository Repository
	Handler    Handler
	Now        func() time.Time
	MaxAttempts int
}

// NewWorker builds a Worker.
func NewWorker(cfg Config) (*Worker, error) {
	if cfg.Repository == nil {
		return nil, errors.New("outbox: repository is required")
	}
	if cfg.Handler == nil {
		return nil, errors.New("outbox: handler is required")
	}

	worker := &Worker{
		repo:        cfg.Repository,
		handler:     cfg.Handler,
		now:         cfg.Now,
		maxAttempts: cfg.MaxAttempts,
	}
	if worker.now == nil {
		worker.now = func() time.Time { return time.Now().UTC() }
	}
	if worker.maxAttempts <= 0 {
		worker.maxAttempts = MaxAttempts
	}
	return worker, nil
}

// RunOnce claims and delivers one batch.
//
// A delivery failure does not abort the batch: one poison event must not block every
// later event, which is why each outcome is recorded independently.
func (w *Worker) RunOnce(ctx context.Context, limit int) (Result, error) {
	if limit <= 0 || limit > DefaultBatch {
		limit = DefaultBatch
	}

	now := w.now()
	events, err := w.repo.Claim(ctx, limit, now, ClaimLease)
	if err != nil {
		return Result{}, err
	}

	result := Result{Claimed: len(events)}
	for _, event := range events {
		if err := w.handler.Handle(ctx, event); err != nil {
			result.Failed++
			if abandonErr := w.recordFailure(ctx, event, err); abandonErr != nil {
				return result, abandonErr
			}
			continue
		}

		if err := w.repo.MarkPublished(ctx, event.EventID, w.now()); err != nil {
			return result, err
		}
		result.Published++
	}

	return result, nil
}

func (w *Worker) recordFailure(ctx context.Context, event Event, cause error) error {
	attempts := event.Attempts + 1
	if attempts >= w.maxAttempts {
		// Give up: leave the row unpublished with the reason so an operator can see it
		// instead of the worker retrying a poison event forever.
		_ = w.repo.RescheduleAfterFailure(ctx, event.EventID,
			w.now().Add(maxBackoff), fmt.Sprintf("abandoned after %d attempts: %v", attempts, cause))
		return nil
	}

	return w.repo.RescheduleAfterFailure(ctx, event.EventID,
		w.now().Add(Backoff(attempts)), truncate(cause.Error(), 400))
}

// Backoff returns the delay before the next attempt.
//
// It is exported so tests and operators can reason about retry timing without
// reproducing the worker's internals.
func Backoff(attempts int) time.Duration {
	if attempts <= 0 {
		return baseBackoff
	}
	delay := baseBackoff
	for i := 1; i < attempts; i++ {
		delay *= 2
		if delay >= maxBackoff {
			return maxBackoff
		}
	}
	return delay
}

func truncate(value string, limit int) string {
	if len(value) <= limit {
		return value
	}
	return value[:limit]
}
