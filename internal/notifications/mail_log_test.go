package notifications

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/internal/platform/mailer"
)

// loggedMail is one email_logs row as the fake mail log saw it.
type loggedMail struct {
	ID                string
	Entry             MailLogEntry
	Status            string
	Reason            string
	ProviderMessageID string
}

// fakeMailLog is an in-memory MailLog: Record creates the queued row and the Mark*
// calls finalise it, which is the lifecycle the real store has.
type fakeMailLog struct {
	mu        sync.Mutex
	rows      []*loggedMail
	recordErr error
	markErr   error
}

var _ MailLog = (*fakeMailLog)(nil)

func (f *fakeMailLog) Record(_ context.Context, entry MailLogEntry) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.recordErr != nil {
		return "", f.recordErr
	}
	row := &loggedMail{
		ID:    fmt.Sprintf("log-%d", len(f.rows)+1),
		Entry: entry,
		// The real store writes the row as queued; the fake mirrors that so a missing
		// Mark call is visible in a test.
		Status: "queued",
	}
	f.rows = append(f.rows, row)
	return row.ID, nil
}

func (f *fakeMailLog) MarkSent(_ context.Context, id, providerMessageID string) error {
	return f.mark(id, "sent", providerMessageID)
}

func (f *fakeMailLog) MarkFailed(_ context.Context, id, reason string) error {
	return f.mark(id, "failed", reason)
}

func (f *fakeMailLog) MarkSkipped(_ context.Context, id, reason string) error {
	return f.mark(id, "skipped", reason)
}

func (f *fakeMailLog) mark(id, status, detail string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.markErr != nil {
		return f.markErr
	}
	for _, row := range f.rows {
		if row.ID != id {
			continue
		}
		row.Status = status
		if status == "sent" {
			row.ProviderMessageID = detail
		} else {
			row.Reason = detail
		}
		return nil
	}
	return errors.New("fake mail log: unknown row " + id)
}

// snapshot copies the rows so a test can read them without holding the lock.
func (f *fakeMailLog) snapshot() []loggedMail {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]loggedMail, 0, len(f.rows))
	for _, row := range f.rows {
		out = append(out, *row)
	}
	return out
}

// errorMailer fails every delivery, which is how a rejected message looks to the
// service.
type errorMailer struct {
	err    error
	sent   int
	lastID string
}

func (m *errorMailer) Send(_ context.Context, _ mailer.Message) error {
	m.sent++
	return m.err
}

func (m *errorMailer) Configured() bool { return true }

// LastMessageID makes the fake report a provider id, so a test can prove the id lands
// on the row.
func (m *errorMailer) LastMessageID() string { return m.lastID }

func newLoggedEmailService(
	t *testing.T,
	repo *prefsRepo,
	sender mailer.Sender,
	log MailLog,
) *Service {
	t.Helper()
	service, err := NewService(repo,
		WithMailer(sender),
		WithMailLog(log),
		WithSynchronousEmail(),
		WithBaseURL("https://press.example/"),
	)
	require.NoError(t, err)
	service.now = func() time.Time { return time.Date(2026, 11, 7, 12, 0, 0, 0, time.UTC) }
	return service
}

// emailOnlyRepo is a recipient who switched the inbox off and comments email on, which
// is the smallest setup that reaches the send path.
func emailOnlyRepo() *prefsRepo {
	repo := newPrefsRepo()
	repo.prefs.InApp.Enabled = false
	repo.prefs.Email.Enabled = true
	repo.prefs.Email.Comments = true
	repo.emails["u2"] = "u2@example.com"
	return repo
}

// TestNotificationMailIsLoggedAsSent proves a delivered notification leaves a complete
// system row: the try started queued, ended sent, and names the site and template.
func TestNotificationMailIsLoggedAsSent(t *testing.T) {
	repo := emailOnlyRepo()
	log := &fakeMailLog{}
	sender := &fakeMailer{configured: true}
	service := newLoggedEmailService(t, repo, sender, log)

	_, err := service.Notify(context.Background(), NewInput{
		SiteID: "s1", UserID: "u2", Type: TypeComment, ActorID: "u1",
		Payload: map[string]string{"title": "hello"},
	})
	require.NoError(t, err)
	require.Len(t, sender.sent, 1)

	rows := log.snapshot()
	require.Len(t, rows, 1)
	require.Equal(t, "sent", rows[0].Status)
	require.Equal(t, MailLogKindSystem, rows[0].Entry.Kind)
	require.Equal(t, MailLogTemplateNotification, rows[0].Entry.TemplateKey)
	require.Equal(t, "s1", rows[0].Entry.SiteID)
	require.Equal(t, "u2@example.com", rows[0].Entry.ToEmail)
	require.Equal(t, sender.sent[0].Subject, rows[0].Entry.Subject)
	require.NotEmpty(t, rows[0].Entry.Subject)
}

// TestNotificationMailFailureIsLoggedAsFailed keeps the row honest when the relay
// rejects the message: failed, with the reason truncated to the column limit.
func TestNotificationMailFailureIsLoggedAsFailed(t *testing.T) {
	repo := emailOnlyRepo()
	log := &fakeMailLog{}
	reason := strings.Repeat("relay said no ", 60)
	require.Greater(t, len(reason), MailLogMaxErrorLength)
	service := newLoggedEmailService(t, repo, &errorMailer{err: errors.New(reason)}, log)

	_, err := service.Notify(context.Background(), NewInput{
		SiteID: "s1", UserID: "u2", Type: TypeComment, ActorID: "u1",
		Payload: map[string]string{"title": "hello"},
	})
	require.NoError(t, err, "a delivery failure never fails the notification")

	rows := log.snapshot()
	require.Len(t, rows, 1)
	require.Equal(t, "failed", rows[0].Status)
	require.Len(t, rows[0].Reason, MailLogMaxErrorLength)
	require.Len(t, rows[0].Reason, 500, "email_logs.error is a 500 byte column")
	require.Equal(t, reason[:MailLogMaxErrorLength], rows[0].Reason)
}

// TestNotificationMailIsLoggedAsSkippedWithoutRelay covers the deployment that never
// configured SMTP: the notification stays in the inbox, and the dashboard now shows why
// no mail went out.
func TestNotificationMailIsLoggedAsSkippedWithoutRelay(t *testing.T) {
	repo := emailOnlyRepo()
	log := &fakeMailLog{}
	service := newLoggedEmailService(t, repo, nil, log)

	_, err := service.Notify(context.Background(), NewInput{
		SiteID: "s1", UserID: "u2", Type: TypeFollow, ActorID: "u1",
	})
	require.NoError(t, err, "an unconfigured relay is not an error")
	require.False(t, service.EmailConfigured())

	rows := log.snapshot()
	require.Len(t, rows, 1)
	require.Equal(t, "skipped", rows[0].Status)
	require.Equal(t, "s1", rows[0].Entry.SiteID)
	require.Equal(t, "u2@example.com", rows[0].Entry.ToEmail)
	require.Equal(t, MailLogTemplateNotification, rows[0].Entry.TemplateKey)
	require.NotEmpty(t, rows[0].Reason)
}

// TestNotificationMailIsDeliveredWhenTheLogWriteFails is the "logging is best effort"
// rule: a log store that is down must not stop the mail.
func TestNotificationMailIsDeliveredWhenTheLogWriteFails(t *testing.T) {
	repo := emailOnlyRepo()
	log := &fakeMailLog{recordErr: errors.New("log store is down")}
	sender := &fakeMailer{configured: true}
	service := newLoggedEmailService(t, repo, sender, log)

	_, err := service.Notify(context.Background(), NewInput{
		SiteID: "s1", UserID: "u2", Type: TypeComment, ActorID: "u1",
		Payload: map[string]string{"title": "hello"},
	})
	require.NoError(t, err)
	require.Len(t, sender.sent, 1, "the message is delivered even though the row was not written")
	require.Empty(t, log.snapshot())
}

// TestNotificationMailIsNotLoggedWithoutRecipient keeps the log free of rows it could
// not honestly describe: email_logs.to_email is mandatory, so a missing identity means
// no row at all.
func TestNotificationMailIsNotLoggedWithoutRecipient(t *testing.T) {
	repo := newPrefsRepo()
	repo.prefs.InApp.Enabled = false
	repo.prefs.Email.Enabled = true
	log := &fakeMailLog{}
	sender := &fakeMailer{configured: true}
	service := newLoggedEmailService(t, repo, sender, log)

	_, err := service.Notify(context.Background(), NewInput{
		SiteID: "s1", UserID: "u2", Type: TypeFollow, ActorID: "u1",
	})
	require.NoError(t, err)
	require.Empty(t, sender.sent)
	require.Empty(t, log.snapshot())
}

// TestNotificationMailRecordsProviderMessageID proves the id a sender can report lands
// on the row, so the operator can match it against the relay's log.
func TestNotificationMailRecordsProviderMessageID(t *testing.T) {
	repo := emailOnlyRepo()
	log := &fakeMailLog{}
	// A sender with no error delivers and still reports an id: that is the shape the
	// optional LastMessageID extension has.
	sender := &errorMailer{lastID: "<abc@relay.example>"}
	service := newLoggedEmailService(t, repo, sender, log)

	_, err := service.Notify(context.Background(), NewInput{
		SiteID: "s1", UserID: "u2", Type: TypeFollow, ActorID: "u1",
	})
	require.NoError(t, err)
	require.Equal(t, 1, sender.sent, "the message went through the fake relay")

	rows := log.snapshot()
	require.Len(t, rows, 1)
	require.Equal(t, "sent", rows[0].Status)
	require.Equal(t, "<abc@relay.example>", rows[0].ProviderMessageID)
}
