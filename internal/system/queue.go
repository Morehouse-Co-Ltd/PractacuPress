package system

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	entgen "github.com/practacu/practacu-press/internal/ent"
	"github.com/practacu/practacu-press/internal/ent/emaillog"
	"github.com/practacu/practacu-press/internal/ent/outboxevent"
	"github.com/practacu/practacu-press/internal/ent/predicate"
)

// Queue monitoring (Beta 1.2 contract K).
//
// The async queues are already persisted: outbox_events is the reliable domain
// event queue and email_logs is the outbound mail queue. This file is a read and
// recovery projection over those two tables, not a second queue: nothing is
// buffered in memory, so a restart never loses a pending item.
const (
	// QueueEventPending means the outbox row is not published yet.
	QueueEventPending = "pending"
	// QueueEventPublished means the outbox worker delivered the event.
	QueueEventPublished = "published"
	// QueueEventFailed means the last delivery attempt for the row failed. The
	// worker may still retry it on its own backoff, which is why the panel shows it
	// next to a one click manual retry.
	QueueEventFailed = "failed"

	// QueueRecentLimit is how many outbox rows the panel shows.
	QueueRecentLimit = 20
	// QueueRetryDefaultLimit is the documented "recent failed rows" batch size of
	// an empty retry request.
	QueueRetryDefaultLimit = 50
	// MaxQueueRetryIDs bounds one explicit retry request.
	MaxQueueRetryIDs = 100
)

// Mail delivery states as persisted in email_logs.status. They mirror the ent
// schema constants; the generated package does not re-export them, and importing
// the schema package (which exists for code generation) from a handler package
// would couple the transport to the generator input.
const (
	emailStatusQueued = "queued"
	emailStatusFailed = "failed"
)

// Sentinel errors of the queue store.
var (
	// ErrQueueUnavailable means the composition root did not provide a store.
	ErrQueueUnavailable = errors.New("system: queue store is not configured")
	// ErrTooManyRetryIDs means the caller asked to retry more ids than allowed.
	ErrTooManyRetryIDs = errors.New("system: too many queue event ids")
)

// QueueOutboxStats is the outbox backlog summary.
type QueueOutboxStats struct {
	// Pending is every unpublished row. Failed rows are a subset of pending.
	Pending int `json:"pending"`
	// Failed is every unpublished row whose last attempt failed.
	Failed int `json:"failed"`
	// OldestAgeSeconds is the age of the oldest unpublished row.
	OldestAgeSeconds int64 `json:"oldest_age_seconds"`
}

// QueueMailStats is the outbound mail backlog summary.
type QueueMailStats struct {
	Queued int `json:"queued"`
	Failed int `json:"failed"`
}

// QueueEvent is one recent outbox row.
type QueueEvent struct {
	EventID    string    `json:"event_id"`
	EventType  string    `json:"event_type"`
	Status     string    `json:"status"`
	Attempts   int       `json:"attempts"`
	LastError  string    `json:"last_error,omitempty"`
	OccurredAt time.Time `json:"occurred_at"`
}

// QueueStatus is the GET /system/queue payload.
type QueueStatus struct {
	Outbox QueueOutboxStats `json:"outbox"`
	Recent []QueueEvent     `json:"recent"`
	Mail   QueueMailStats   `json:"mail"`
}

// QueueStore is the narrow persistence port the handler needs. The Ent
// implementation lives below; tests use a fake so the handler can be exercised
// without a database.
type QueueStore interface {
	// Status summarises the queues of one site, or of every site when siteID is
	// empty (the platform administrator view).
	Status(ctx context.Context, siteID string, now time.Time) (QueueStatus, error)
	// RetryFailed makes unpublished rows deliverable again and returns how many
	// rows were reset. An empty eventIDs retries the newest failed rows.
	RetryFailed(ctx context.Context, siteID string, eventIDs []string, limit int) (int, error)
}

// EntQueueStore implements QueueStore over the generated Ent client.
type EntQueueStore struct {
	client *entgen.Client
}

// NewEntQueueStore builds a store over the shared Ent client.
func NewEntQueueStore(client *entgen.Client) *EntQueueStore {
	return &EntQueueStore{client: client}
}

var _ QueueStore = (*EntQueueStore)(nil)

// Status implements QueueStore.
func (s *EntQueueStore) Status(ctx context.Context, siteID string, now time.Time) (QueueStatus, error) {
	if s == nil || s.client == nil {
		return QueueStatus{}, ErrQueueUnavailable
	}
	if now.IsZero() {
		now = time.Now().UTC()
	}

	scope := outboxScope(siteID)
	pending, err := s.client.OutboxEvent.Query().
		Where(append(scope, outboxevent.PublishedAtIsNil())...).
		Count(ctx)
	if err != nil {
		return QueueStatus{}, fmt.Errorf("system: count pending events: %w", err)
	}
	failed, err := s.client.OutboxEvent.Query().
		Where(append(scope, outboxevent.PublishedAtIsNil(), outboxevent.LastErrorNotNil())...).
		Count(ctx)
	if err != nil {
		return QueueStatus{}, fmt.Errorf("system: count failed events: %w", err)
	}

	oldestAge := int64(0)
	oldest, err := s.client.OutboxEvent.Query().
		Where(append(scope, outboxevent.PublishedAtIsNil())...).
		Order(entgen.Asc(outboxevent.FieldOccurredAt)).
		First(ctx)
	if err != nil && !entgen.IsNotFound(err) {
		return QueueStatus{}, fmt.Errorf("system: read oldest pending event: %w", err)
	}
	if err == nil {
		age := now.Sub(oldest.OccurredAt).Seconds()
		if age > 0 {
			oldestAge = int64(age)
		}
	}

	recent, err := s.client.OutboxEvent.Query().
		Where(scope...).
		Order(entgen.Desc(outboxevent.FieldOccurredAt)).
		Limit(QueueRecentLimit).
		All(ctx)
	if err != nil {
		return QueueStatus{}, fmt.Errorf("system: list recent events: %w", err)
	}
	events := make([]QueueEvent, 0, len(recent))
	for _, row := range recent {
		events = append(events, toQueueEvent(row))
	}

	mailScope := emailScope(siteID)
	queued, err := s.client.EmailLog.Query().
		Where(append(mailScope, emaillog.StatusEQ(emailStatusQueued))...).
		Count(ctx)
	if err != nil {
		return QueueStatus{}, fmt.Errorf("system: count queued mail: %w", err)
	}
	failedMail, err := s.client.EmailLog.Query().
		Where(append(mailScope, emaillog.StatusEQ(emailStatusFailed))...).
		Count(ctx)
	if err != nil {
		return QueueStatus{}, fmt.Errorf("system: count failed mail: %w", err)
	}

	return QueueStatus{
		Outbox: QueueOutboxStats{Pending: pending, Failed: failed, OldestAgeSeconds: oldestAge},
		Recent: events,
		Mail:   QueueMailStats{Queued: queued, Failed: failedMail},
	}, nil
}

// RetryFailed implements QueueStore.
//
// Retry semantics are an operator override, so the row is reset to a genuinely
// fresh state: next_attempt_at and claimed_at are cleared (the worker otherwise
// treats it as still backing off or still claimed) and attempts is reset to 0
// with the last error cleared. Keeping attempts would be unsafe here: the worker
// abandons a row once its attempt count reaches its own ceiling, so a retried
// event with a high counter would be abandoned again on its first new failure
// instead of actually being retried. The trade-off is documented in the API
// response: the panel shows attempt counts for the new delivery only.
func (s *EntQueueStore) RetryFailed(
	ctx context.Context,
	siteID string,
	eventIDs []string,
	limit int,
) (int, error) {
	if s == nil || s.client == nil {
		return 0, ErrQueueUnavailable
	}
	scope := outboxScope(siteID)

	ids := normalizeEventIDs(eventIDs)
	if len(ids) > 0 {
		if len(ids) > MaxQueueRetryIDs {
			return 0, ErrTooManyRetryIDs
		}
		affected, err := s.client.OutboxEvent.Update().
			Where(append(scope,
				outboxevent.PublishedAtIsNil(),
				outboxevent.EventIDIn(ids...),
			)...).
			SetAttempts(0).
			ClearLastError().
			ClearNextAttemptAt().
			ClearClaimedAt().
			Save(ctx)
		if err != nil {
			return 0, fmt.Errorf("system: retry queue events: %w", err)
		}
		return affected, nil
	}

	if limit <= 0 || limit > QueueRetryDefaultLimit {
		limit = QueueRetryDefaultLimit
	}
	candidates, err := s.client.OutboxEvent.Query().
		Where(append(scope,
			outboxevent.PublishedAtIsNil(),
			outboxevent.LastErrorNotNil(),
		)...).
		Order(entgen.Desc(outboxevent.FieldOccurredAt)).
		Limit(limit).
		All(ctx)
	if err != nil {
		return 0, fmt.Errorf("system: list failed queue events: %w", err)
	}
	if len(candidates) == 0 {
		return 0, nil
	}
	retryIDs := make([]string, 0, len(candidates))
	for _, row := range candidates {
		retryIDs = append(retryIDs, row.EventID)
	}
	affected, err := s.client.OutboxEvent.Update().
		Where(append(scope,
			outboxevent.PublishedAtIsNil(),
			outboxevent.EventIDIn(retryIDs...),
		)...).
		SetAttempts(0).
		ClearLastError().
		ClearNextAttemptAt().
		ClearClaimedAt().
		Save(ctx)
	if err != nil {
		return 0, fmt.Errorf("system: retry failed queue events: %w", err)
	}
	return affected, nil
}

// outboxScope builds the site filter. An empty site means "the whole deployment",
// which is only ever passed by a platform administrator.
func outboxScope(siteID string) []predicate.OutboxEvent {
	if siteID == "" {
		return nil
	}
	return []predicate.OutboxEvent{outboxevent.SiteIDEQ(siteID)}
}

// emailScope is outboxScope for the mail table.
func emailScope(siteID string) []predicate.EmailLog {
	if siteID == "" {
		return nil
	}
	return []predicate.EmailLog{emaillog.SiteIDEQ(siteID)}
}

// toQueueEvent maps one row onto the contract's status vocabulary.
func toQueueEvent(row *entgen.OutboxEvent) QueueEvent {
	status := QueueEventPending
	switch {
	case row.PublishedAt != nil:
		status = QueueEventPublished
	case row.LastError != nil:
		status = QueueEventFailed
	}
	event := QueueEvent{
		EventID:    row.EventID,
		EventType:  row.EventType,
		Status:     status,
		Attempts:   row.Attempts,
		OccurredAt: row.OccurredAt.UTC(),
	}
	if row.LastError != nil {
		event.LastError = *row.LastError
	}
	return event
}

// normalizeEventIDs trims, drops empty entries and removes duplicates while
// keeping the caller's order, so a retried id is counted once.
func normalizeEventIDs(raw []string) []string {
	seen := make(map[string]struct{}, len(raw))
	out := make([]string, 0, len(raw))
	for _, value := range raw {
		id := strings.TrimSpace(value)
		if id == "" {
			continue
		}
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		out = append(out, id)
	}
	return out
}
