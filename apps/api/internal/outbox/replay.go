package outbox

import (
	"context"
	"errors"
	"time"
)

// ReplayRepository serves the authoritative catch-up query.
//
// WebSocket delivery is best effort; this endpoint is what a client uses after a
// reconnect, so it must be complete and it must never return another user's events.
type ReplayRepository interface {
	Replay(ctx context.Context, siteID, userID, afterEventID string, limit int) ([]Event, error)
}

// ReplayLimit bounds one catch-up page.
const (
	// DefaultReplayLimit is used when the client does not ask.
	DefaultReplayLimit = 100
	// MaxReplayLimit caps the page size.
	MaxReplayLimit = 200
)

// Replayer answers catch-up queries.
type Replayer struct {
	repo ReplayRepository
}

// NewReplayer builds a Replayer.
func NewReplayer(repo ReplayRepository) (*Replayer, error) {
	if repo == nil {
		return nil, errors.New("outbox: replay repository is required")
	}
	return &Replayer{repo: repo}, nil
}

// After returns the events a user may observe after a cursor.
//
// The audience rule is applied by the repository because it is a query condition, not
// a post filter: filtering after loading would mean reading rows the caller must not
// see, and a bug in the filter would leak them.
func (r *Replayer) After(ctx context.Context, siteID, userID, afterEventID string, limit int) ([]Event, error) {
	if siteID == "" || userID == "" {
		return nil, errors.New("outbox: site and user are required")
	}
	if limit <= 0 || limit > MaxReplayLimit {
		limit = DefaultReplayLimit
	}
	return r.repo.Replay(ctx, siteID, userID, afterEventID, limit)
}

// Envelope is the wire shape of an event.
type Envelope struct {
	ID         string         `json:"id"`
	Type       string         `json:"type"`
	OccurredAt time.Time      `json:"occurred_at"`
	SiteID     string         `json:"site_id"`
	Payload    map[string]any `json:"payload"`
}

// ToEnvelope projects an event for the client.
//
// OccurredAt is carried on the event payload when present; the wire contract keeps it
// at the top level so a client never has to dig into payload for ordering.
func ToEnvelope(event Event) Envelope {
	envelope := Envelope{
		ID:      event.EventID,
		Type:    event.Type,
		SiteID:  event.SiteID,
		Payload: event.Payload,
	}
	if event.Payload != nil {
		if raw, ok := event.Payload["occurred_at"].(string); ok {
			if parsed, err := time.Parse(time.RFC3339Nano, raw); err == nil {
				envelope.OccurredAt = parsed
			}
		}
	}
	return envelope
}
