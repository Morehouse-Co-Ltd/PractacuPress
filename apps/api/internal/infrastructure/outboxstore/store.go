// Package outboxstore implements the outbox persistence port with Ent.
package outboxstore

import (
	"context"
	"time"

	"github.com/practacu/practacu-press/apps/api/internal/outbox"

	entgen "github.com/practacu/practacu-press/apps/api/ent"
	"github.com/practacu/practacu-press/apps/api/ent/outboxevent"
)

// Store is the Ent backed implementation of outbox.Repository.
type Store struct {
	client *entgen.Client
}

// New returns a Store over the given Ent client.
func New(client *entgen.Client) *Store { return &Store{client: client} }

var _ outbox.Repository = (*Store)(nil)

// Claim locks up to limit due events for this worker.
//
// Claiming is a conditional update per row rather than a "select then update": the
// second worker to run the same statement updates zero rows and therefore skips the
// event. That is what keeps two workers from delivering the same event in the same
// lease window without needing SELECT ... FOR UPDATE, which SQLite cannot do.
func (s *Store) Claim(ctx context.Context, limit int, now time.Time, lease time.Duration) ([]outbox.Event, error) {
	staleBefore := now.Add(-lease)

	candidates, err := s.client.OutboxEvent.Query().
		Where(
			outboxevent.PublishedAtIsNil(),
			outboxevent.Or(
				outboxevent.NextAttemptAtIsNil(),
				outboxevent.NextAttemptAtLTE(now),
			),
			outboxevent.Or(
				outboxevent.ClaimedAtIsNil(),
				outboxevent.ClaimedAtLT(staleBefore),
			),
		).
		Order(entgen.Asc(outboxevent.FieldEventID)).
		Limit(limit).
		All(ctx)
	if err != nil {
		return nil, err
	}

	claimed := make([]outbox.Event, 0, len(candidates))
	for _, row := range candidates {
		affected, err := s.client.OutboxEvent.Update().
			Where(
				outboxevent.IDEQ(row.ID),
				outboxevent.Or(
					outboxevent.ClaimedAtIsNil(),
					outboxevent.ClaimedAtLT(staleBefore),
				),
			).
			SetClaimedAt(now).
			Save(ctx)
		if err != nil {
			return nil, err
		}
		if affected == 0 {
			// Another worker won this event.
			continue
		}

		claimed = append(claimed, outbox.Event{
			ID:             row.ID,
			EventID:        row.EventID,
			SiteID:         row.SiteID,
			AudienceUserID: deref(row.AudienceUserID),
			Type:           row.EventType,
			AggregateID:    row.AggregateID,
			Payload:        row.Payload,
			Attempts:       row.Attempts,
		})
	}

	return claimed, nil
}

// MarkPublished records successful delivery and releases the claim.
func (s *Store) MarkPublished(ctx context.Context, eventID string, at time.Time) error {
	_, err := s.client.OutboxEvent.Update().
		Where(outboxevent.EventIDEQ(eventID), outboxevent.PublishedAtIsNil()).
		SetPublishedAt(at).
		ClearClaimedAt().
		Save(ctx)
	return err
}

// RescheduleAfterFailure records a failed attempt with its backoff.
func (s *Store) RescheduleAfterFailure(ctx context.Context, eventID string, nextAttempt time.Time, reason string) error {
	_, err := s.client.OutboxEvent.Update().
		Where(outboxevent.EventIDEQ(eventID), outboxevent.PublishedAtIsNil()).
		SetNextAttemptAt(nextAttempt).
		SetLastError(reason).
		ClearClaimedAt().
		AddAttempts(1).
		Save(ctx)
	return err
}

func deref(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}
