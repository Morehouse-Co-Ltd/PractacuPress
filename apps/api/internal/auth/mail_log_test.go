package auth_test

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/apps/api/internal/auth"
	"github.com/practacu/practacu-press/apps/api/internal/platform/mailer"
)

// loggedMail is one email_logs row as the fake mail log saw it.
type loggedMail struct {
	ID                string
	Entry             auth.MailLogEntry
	Status            string
	Reason            string
	ProviderMessageID string
}

// fakeMailLog is an in-memory auth.MailLog: it keeps the row Record created and
// applies the Mark* calls to it, which is exactly the lifecycle the real store has.
type fakeMailLog struct {
	mu        sync.Mutex
	rows      []*loggedMail
	seq       int
	recordErr error
	markErr   error
}

var _ auth.MailLog = (*fakeMailLog)(nil)

func (f *fakeMailLog) Record(_ context.Context, entry auth.MailLogEntry) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.recordErr != nil {
		return "", f.recordErr
	}
	f.seq++
	row := &loggedMail{ID: fmt.Sprintf("log-%d", f.seq), Entry: entry, Status: "queued"}
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

// snapshot copies the recorded rows so a test can read them without holding the lock.
func (f *fakeMailLog) snapshot() []loggedMail {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]loggedMail, 0, len(f.rows))
	for _, row := range f.rows {
		out = append(out, *row)
	}
	return out
}

// rowsFor returns every row written for one template key.
func (f *fakeMailLog) rowsFor(templateKey string) []loggedMail {
	var out []loggedMail
	for _, row := range f.snapshot() {
		if row.Entry.TemplateKey == templateKey {
			out = append(out, row)
		}
	}
	return out
}

// onlyFor is rowsFor with the package's one-row-per-flow expectation.
func (f *fakeMailLog) onlyFor(t *testing.T, templateKey string) loggedMail {
	t.Helper()
	rows := f.rowsFor(templateKey)
	require.Len(t, rows, 1, "expected exactly one %s row", templateKey)
	return rows[0]
}

// newAPIHarnessWithMailLog wires a capturing mail log next to the mail relay.
func newAPIHarnessWithMailLog(t *testing.T, sender mailer.Sender, log *fakeMailLog) *apiHarness {
	t.Helper()
	return newAPIHarnessWithOptions(t, apiHarnessOptions{mailer: sender, mailLog: log})
}

// TestPasswordResetMailIsLoggedAsSent proves the happy path leaves a completed row:
// queued before the relay was touched, then sent, with the site and the flow it belongs
// to recorded as they are.
func TestPasswordResetMailIsLoggedAsSent(t *testing.T) {
	sender := &recordingMailer{}
	log := &fakeMailLog{}
	h := newAPIHarnessWithMailLog(t, sender, log)

	require.Equal(t, http.StatusCreated, register(t, h, "alice@example.com").Code)
	require.Equal(t, http.StatusAccepted, requestReset(t, h, "alice@example.com").Code)

	reset := log.onlyFor(t, auth.MailLogTemplatePasswordReset)
	require.Equal(t, "sent", reset.Status)
	require.Equal(t, auth.MailLogKindSystem, reset.Entry.Kind)
	require.Equal(t, "system", reset.Entry.Kind)
	require.Equal(t, "alice@example.com", reset.Entry.ToEmail)
	require.Equal(t, h.siteID, reset.Entry.SiteID)
	require.Equal(t, "重置你的账户密码", reset.Entry.Subject)
	require.Empty(t, reset.ProviderMessageID, "the SMTP sender reports no message id")

	// The registration mail of the same account is recorded under its own key, so the
	// dashboard can tell a reset link from a verification link.
	verify := log.onlyFor(t, auth.MailLogTemplateEmailVerify)
	require.Equal(t, "sent", verify.Status)
	require.Equal(t, h.siteID, verify.Entry.SiteID)
	require.Equal(t, "验证你的邮箱地址", verify.Entry.Subject)
}

// TestEmailVerificationMailIsLoggedWhenResent covers the second system mail path
// (the caller asks for a fresh verification link after the cooldown).
func TestEmailVerificationMailIsLoggedWhenResent(t *testing.T) {
	sender := &recordingMailer{}
	log := &fakeMailLog{}
	clock := newTestClock(time.Now().UTC())
	h := newAPIHarnessWithOptions(t, apiHarnessOptions{
		mailer: sender, mailLog: log, now: clock.Now,
	})

	session := register(t, h, "alice@example.com")
	require.Equal(t, http.StatusCreated, session.Code)

	// A resend inside the cooldown is dropped, so the test has to leave it first.
	clock.Advance(2 * time.Minute)
	resend := httptest.NewRequest(http.MethodPost, "/api/v1/me/email/verification", nil)
	bearer(resend, sessionToken(t, session))
	require.Equal(t, http.StatusAccepted, h.do(t, resend).Code)

	rows := log.rowsFor(auth.MailLogTemplateEmailVerify)
	require.Len(t, rows, 2, "registration plus the explicit resend")
	for _, row := range rows {
		require.Equal(t, "sent", row.Status)
		require.Equal(t, h.siteID, row.Entry.SiteID)
		require.Equal(t, "alice@example.com", row.Entry.ToEmail)
	}
}

// TestPasswordResetMailFailureIsLoggedAsFailed keeps the row honest when the relay
// rejects the message: status failed and the reason truncated to the column limit.
func TestPasswordResetMailFailureIsLoggedAsFailed(t *testing.T) {
	reason := strings.Repeat("relay said no ", 60)
	require.Greater(t, len(reason), auth.MailLogMaxErrorLength)

	sender := &recordingMailer{err: errors.New(reason)}
	log := &fakeMailLog{}
	h := newAPIHarnessWithMailLog(t, sender, log)

	require.Equal(t, http.StatusCreated, register(t, h, "alice@example.com").Code)
	require.Equal(t, http.StatusAccepted, requestReset(t, h, "alice@example.com").Code)

	reset := log.onlyFor(t, auth.MailLogTemplatePasswordReset)
	require.Equal(t, "failed", reset.Status)
	require.Len(t, reset.Reason, auth.MailLogMaxErrorLength)
	require.Len(t, reset.Reason, 500, "email_logs.error is a 500 byte column")
	require.Equal(t, reason[:auth.MailLogMaxErrorLength], reset.Reason)
}

// TestPasswordResetMailIsLoggedAsSkippedWithoutRelay covers the deployment that never
// configured SMTP: the endpoint still refuses (503), but the dashboard now shows why
// nothing was delivered.
func TestPasswordResetMailIsLoggedAsSkippedWithoutRelay(t *testing.T) {
	log := &fakeMailLog{}
	h := newAPIHarnessWithOptions(t, apiHarnessOptions{mailLog: log})

	require.Equal(t, http.StatusServiceUnavailable, requestReset(t, h, "alice@example.com").Code)

	skipped := log.onlyFor(t, auth.MailLogTemplatePasswordReset)
	require.Equal(t, "skipped", skipped.Status)
	require.Equal(t, auth.MailLogKindSystem, skipped.Entry.Kind)
	require.Equal(t, "alice@example.com", skipped.Entry.ToEmail)
	require.Equal(t, h.siteID, skipped.Entry.SiteID)
	require.Equal(t, "重置你的账户密码", skipped.Entry.Subject)
	require.NotEmpty(t, skipped.Reason)
}

// TestEmailVerificationMailIsLoggedAsSkippedWithoutRelay is the same trace for the
// verification path, where the address comes from the caller's own identity.
func TestEmailVerificationMailIsLoggedAsSkippedWithoutRelay(t *testing.T) {
	log := &fakeMailLog{}
	h := newAPIHarnessWithOptions(t, apiHarnessOptions{mailLog: log})

	// Without a relay the account is created verified, but the endpoint reports the
	// missing capability before it looks at the identity, exactly as it did before.
	session := register(t, h, "alice@example.com")
	require.Equal(t, http.StatusCreated, session.Code)

	resend := httptest.NewRequest(http.MethodPost, "/api/v1/me/email/verification", nil)
	bearer(resend, sessionToken(t, session))
	require.Equal(t, http.StatusServiceUnavailable, h.do(t, resend).Code)

	skipped := log.onlyFor(t, auth.MailLogTemplateEmailVerify)
	require.Equal(t, "skipped", skipped.Status)
	require.Equal(t, "alice@example.com", skipped.Entry.ToEmail)
	require.Equal(t, h.siteID, skipped.Entry.SiteID)
	require.NotEmpty(t, skipped.Reason)
}

// TestMailLogFailureDoesNotBlockSystemMail is the "logging is best effort" rule: a log
// store that is down must not stop a reset link from being delivered.
func TestMailLogFailureDoesNotBlockSystemMail(t *testing.T) {
	sender := &recordingMailer{}
	log := &fakeMailLog{recordErr: errors.New("log store is down")}
	h := newAPIHarnessWithMailLog(t, sender, log)

	require.Equal(t, http.StatusCreated, register(t, h, "alice@example.com").Code)
	require.Equal(t, http.StatusAccepted, requestReset(t, h, "alice@example.com").Code)

	require.Equal(t, 1, resetMailCount(sender), "the reset link is still delivered")
	require.Equal(t, []string{"alice@example.com"}, resetMail(t, sender).To)
	require.Empty(t, log.snapshot())
}

// TestMarkSentFailureDoesNotBreakDelivery is the mirror image: the relay accepted the
// message, so a failing bookkeeping update must not turn it into a delivery failure.
func TestMarkSentFailureDoesNotBreakDelivery(t *testing.T) {
	sender := &recordingMailer{}
	log := &fakeMailLog{markErr: errors.New("log store is down")}
	h := newAPIHarnessWithMailLog(t, sender, log)

	require.Equal(t, http.StatusCreated, register(t, h, "alice@example.com").Code)
	require.Equal(t, http.StatusAccepted, requestReset(t, h, "alice@example.com").Code)

	require.Equal(t, 1, resetMailCount(sender))
	reset := log.onlyFor(t, auth.MailLogTemplatePasswordReset)
	require.Equal(t, "queued", reset.Status, "the mark did not land, the row stays queued")
}

// TestMailLogTemplateKeysMatchVerificationKinds pins the dashboard filter keys to the
// verification token kinds they mirror, so a rename on one side cannot silently break
// the grouping an operator relies on.
func TestMailLogTemplateKeysMatchVerificationKinds(t *testing.T) {
	require.Equal(t, auth.VerificationKindPasswordReset, auth.MailLogTemplatePasswordReset)
	require.Equal(t, auth.VerificationKindEmailVerify, auth.MailLogTemplateEmailVerify)
}
