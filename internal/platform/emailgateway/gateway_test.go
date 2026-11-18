package emailgateway_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/internal/platform/emailgateway"
	"github.com/practacu/practacu-press/internal/platform/mailer"
)

// memoryStore is an in-memory emailgateway.Store.
type memoryStore struct {
	rows   []emailgateway.Log
	nextID int
}

func (s *memoryStore) InsertEmailLog(_ context.Context, entry emailgateway.Log) (emailgateway.Log, error) {
	s.nextID++
	entry.ID = "log-" + string(rune('0'+s.nextID))
	entry.CreatedAt = entry.CreatedAt.UTC()
	s.rows = append(s.rows, entry)
	return entry, nil
}

func (s *memoryStore) mark(id, status, reason, providerID string, at time.Time) {
	for index := range s.rows {
		if s.rows[index].ID != id {
			continue
		}
		s.rows[index].Status = status
		s.rows[index].Error = reason
		s.rows[index].ProviderMessageID = providerID
		s.rows[index].SentAt = &at
	}
}

func (s *memoryStore) MarkEmailLogSent(_ context.Context, id, providerMessageID string, at time.Time) error {
	s.mark(id, emailgateway.StatusSent, "", providerMessageID, at)
	return nil
}

func (s *memoryStore) MarkEmailLogFailed(_ context.Context, id, reason string, at time.Time) error {
	s.mark(id, emailgateway.StatusFailed, reason, "", at)
	return nil
}

func (s *memoryStore) MarkEmailLogSkipped(_ context.Context, id string, at time.Time) error {
	s.mark(id, emailgateway.StatusSkipped, "", "", at)
	return nil
}

// fakeSender is a mailer.Sender controlled by the test.
type fakeSender struct {
	configured bool
	err        error
	sent       []mailer.Message
}

func (f *fakeSender) Send(_ context.Context, msg mailer.Message) error {
	if f.err != nil {
		return f.err
	}
	f.sent = append(f.sent, msg)
	return nil
}

func (f *fakeSender) Configured() bool { return f.configured }

func fixedClock() time.Time { return time.Date(2026, 11, 17, 10, 0, 0, 0, time.UTC) }

func TestSendRecordsQueuedThenSent(t *testing.T) {
	store := &memoryStore{}
	sender := &fakeSender{configured: true}
	gateway := emailgateway.New(store, sender, emailgateway.WithClock(fixedClock))

	err := gateway.Send(context.Background(), emailgateway.Request{
		SiteID:      "site-1",
		Kind:        emailgateway.KindSystem,
		TemplateKey: "subscriber_confirm",
		To:          "reader@example.com",
		Subject:     "请确认订阅",
		HTML:        "<p>hi</p>",
		Text:        "hi",
	})
	require.NoError(t, err)

	require.Len(t, store.rows, 1)
	require.Equal(t, emailgateway.StatusSent, store.rows[0].Status)
	require.Equal(t, "reader@example.com", store.rows[0].ToEmail)
	require.Equal(t, "subscriber_confirm", store.rows[0].TemplateKey)
	require.NotNil(t, store.rows[0].SentAt)
	require.Len(t, sender.sent, 1)
	require.Equal(t, "请确认订阅", sender.sent[0].Subject)
	require.Equal(t, []string{"reader@example.com"}, sender.sent[0].To)
}

func TestSendWithoutRelayRecordsSkippedAndReturnsNil(t *testing.T) {
	store := &memoryStore{}

	// A nil sender is the "SMTP not configured" case.
	gateway := emailgateway.New(store, nil, emailgateway.WithClock(fixedClock))
	require.False(t, gateway.Configured())

	err := gateway.Send(context.Background(), emailgateway.Request{
		SiteID:  "site-1",
		Kind:    emailgateway.KindSystem,
		To:      "reader@example.com",
		Subject: "确认订阅",
		Text:    "hi",
	})
	require.NoError(t, err, "an unconfigured relay must not fail the caller's workflow")

	require.Len(t, store.rows, 1)
	require.Equal(t, emailgateway.StatusSkipped, store.rows[0].Status)
}

func TestSendRecordsTruncatedFailure(t *testing.T) {
	store := &memoryStore{}
	longErr := errors.New("smtp: " + repeat('x', 800))
	gateway := emailgateway.New(store, &fakeSender{configured: true, err: longErr}, emailgateway.WithClock(fixedClock))

	err := gateway.Send(context.Background(), emailgateway.Request{
		SiteID:  "site-1",
		To:      "reader@example.com",
		Subject: "确认订阅",
	})
	require.Error(t, err)

	require.Len(t, store.rows, 1)
	require.Equal(t, emailgateway.StatusFailed, store.rows[0].Status)
	require.Len(t, store.rows[0].Error, emailgateway.MaxErrorLength)
}

func TestSendValidatesRecipientAndSubject(t *testing.T) {
	store := &memoryStore{}
	gateway := emailgateway.New(store, &fakeSender{configured: true})

	require.Error(t, gateway.Send(context.Background(), emailgateway.Request{Subject: "x"}))
	require.Error(t, gateway.Send(context.Background(), emailgateway.Request{To: "a@b.c"}))
	require.Empty(t, store.rows, "invalid input must not create a log row")
}

func TestDeliverUpdatesExistingRowWithoutInserting(t *testing.T) {
	store := &memoryStore{}
	store.rows = append(store.rows, emailgateway.Log{ID: "queued-1", Status: emailgateway.StatusQueued})
	sender := &fakeSender{configured: true}
	gateway := emailgateway.New(store, sender, emailgateway.WithClock(fixedClock))

	outcome, err := gateway.Deliver(context.Background(), "queued-1", mailer.Message{
		To:      []string{"reader@example.com"},
		Subject: "本周文章",
		Text:    "hi",
	})
	require.NoError(t, err)
	require.Equal(t, emailgateway.OutcomeSent, outcome)
	require.Len(t, store.rows, 1, "Deliver must not insert a second row")
	require.Equal(t, emailgateway.StatusSent, store.rows[0].Status)
}

func repeat(value byte, count int) string {
	raw := make([]byte, count)
	for index := range raw {
		raw[index] = value
	}
	return string(raw)
}
