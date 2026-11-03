package auth_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/apps/api/internal/auth"
)

// fakeHasher is a deterministic, cheap PasswordHasher used to observe what the auth
// service hands to the hash/verify path. It records every encoded hash it is asked to
// verify so tests can prove the dummy verification really happened.
type fakeHasher struct {
	mu        sync.Mutex
	hashCalls int
	verified  []string
}

// fakeEncoding is the reversible encoding this fake uses: the "stored hash" is just a
// prefixed plaintext, which is enough to compare against in a test.
func fakeEncoding(plain string) string { return "fake$argon2id$" + plain }

func (f *fakeHasher) Hash(_ context.Context, plain string) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.hashCalls++
	return fakeEncoding(plain), nil
}

func (f *fakeHasher) Verify(_ context.Context, plain, encoded string) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.verified = append(f.verified, encoded)
	return encoded == fakeEncoding(plain), nil
}

func (f *fakeHasher) verifyCalls() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.verified...)
}

func (f *fakeHasher) hashes() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.hashCalls
}

var _ auth.PasswordHasher = (*fakeHasher)(nil)

// sleepingHasher makes the verify step measurably expensive, so a test can prove the
// unknown-account path pays the same cost as a real check.
type sleepingHasher struct{ delay time.Duration }

func (h *sleepingHasher) Hash(_ context.Context, plain string) (string, error) {
	return fakeEncoding(plain), nil
}

func (h *sleepingHasher) Verify(_ context.Context, plain, encoded string) (bool, error) {
	time.Sleep(h.delay)
	return encoded == fakeEncoding(plain), nil
}

var _ auth.PasswordHasher = (*sleepingHasher)(nil)

// testClock is a controllable time source for the service.
type testClock struct {
	mu sync.Mutex
	at time.Time
}

func newTestClock(at time.Time) *testClock { return &testClock{at: at} }

func (c *testClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.at
}

func (c *testClock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.at = c.at.Add(d)
}

// problemReason returns details.reason from a problem response.
func problemReason(t *testing.T, w *httptest.ResponseRecorder) string {
	t.Helper()
	payload := decode(t, w)
	details, ok := payload["details"].(map[string]any)
	require.True(t, ok, "problem response has no details: %s", w.Body.String())
	reason, _ := details["reason"].(string)
	return reason
}

// sessionCookieIssued reports whether the response wrote a non-empty session cookie.
func sessionCookieIssued(w *httptest.ResponseRecorder) bool {
	for _, cookie := range w.Result().Cookies() {
		if (cookie.Name == auth.RefreshCookieName || cookie.Name == auth.CSRFCookieName) && cookie.Value != "" {
			return true
		}
	}
	return false
}

// newJSONRequest builds a POST with an application/json content type, the shape a
// first party SPA sends.
func newJSONRequest(t *testing.T, path string, payload map[string]string) *http.Request {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, path, jsonBody(t, payload))
	req.Header.Set("Content-Type", "application/json")
	return req
}
