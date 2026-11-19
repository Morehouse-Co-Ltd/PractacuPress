package auth_test

import (
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/internal/auth"
)

// refreshPair sends a refresh request with independent cookie and header CSRF values,
// which is what a cookie-injection style attacker or a stale client would produce.
func refreshPair(
	t *testing.T,
	h *apiHarness,
	refresh, csrfCookie, csrfHeader string,
) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/token/refresh", nil)
	if refresh != "" {
		req.AddCookie(&http.Cookie{Name: auth.RefreshCookieName, Value: refresh})
	}
	if csrfCookie != "" {
		req.AddCookie(&http.Cookie{Name: auth.CSRFCookieName, Value: csrfCookie})
	}
	if csrfHeader != "" {
		req.Header.Set(auth.CSRFHeaderName, csrfHeader)
	}
	return h.do(t, req)
}

// TestRefreshCSRFIsBoundToRefreshToken is the V-27 regression: the double submit pair
// is only accepted together with the exact refresh token it was derived from.
func TestRefreshCSRFIsBoundToRefreshToken(t *testing.T) {
	h := newAPIHarness(t)
	registered := register(t, h, "alice@example.com")
	require.Equal(t, http.StatusCreated, registered.Code)

	refresh1 := cookieValue(registered, auth.RefreshCookieName)
	csrf1 := cookieValue(registered, auth.CSRFCookieName)
	require.NotEmpty(t, refresh1)
	require.Len(t, csrf1, 43, "derived CSRF is base64url HMAC-SHA256")
	require.Equal(t, csrf1, h.service.CSRFToken(refresh1),
		"the session's CSRF token must be the derivation of its refresh token")
	require.Equal(t, csrf1, decode(t, registered)["csrf_token"],
		"the body and the cookie carry the same derived value")

	// A fresh login starts a new family and therefore a new CSRF token.
	loggedIn := login(t, h, "alice@example.com", "correct horse battery")
	require.Equal(t, http.StatusOK, loggedIn.Code)
	loginRefresh := cookieValue(loggedIn, auth.RefreshCookieName)
	loginCSRF := cookieValue(loggedIn, auth.CSRFCookieName)
	require.Equal(t, h.service.CSRFToken(loginRefresh), loginCSRF)
	require.NotEqual(t, csrf1, loginCSRF, "a new session must not reuse the old CSRF token")

	// Any self-consistent pair that was not derived from this token is refused before
	// the session lookup; the session stays untouched.
	arbitrary := "attacker-chosen-pair-that-matches-itself"
	rejected := refreshPair(t, h, refresh1, arbitrary, arbitrary)
	require.Equal(t, http.StatusForbidden, rejected.Code)
	require.Equal(t, "csrf_mismatch", problemReason(t, rejected))

	// The legitimate pair still works and rotates both secrets.
	rotated := refreshWithHeaders(t, h, refresh1, csrf1, "", "")
	require.Equal(t, http.StatusOK, rotated.Code, rotated.Body.String())
	refresh2 := cookieValue(rotated, auth.RefreshCookieName)
	csrf2 := cookieValue(rotated, auth.CSRFCookieName)
	require.NotEqual(t, refresh1, refresh2)
	require.NotEqual(t, csrf1, csrf2, "rotation must change the derived CSRF token")
	require.Equal(t, csrf2, h.service.CSRFToken(refresh2))
	require.Equal(t, csrf2, decode(t, rotated)["csrf_token"])

	// The previous session's CSRF value paired with the new refresh cookie is refused.
	stale := refreshPair(t, h, refresh2, csrf1, csrf1)
	require.Equal(t, http.StatusForbidden, stale.Code)
	require.Equal(t, "csrf_mismatch", problemReason(t, stale))
	require.Equal(t, csrf2, h.service.CSRFToken(refresh2), "the stale attempt must not rotate")

	// A cookie/header mismatch is refused by the plain double submit check first.
	mismatch := refreshPair(t, h, refresh2, csrf2, csrf1)
	require.Equal(t, http.StatusForbidden, mismatch.Code)
	require.Equal(t, "csrf_mismatch", problemReason(t, mismatch))

	// The valid pair rotates again.
	rotated2 := refreshWithHeaders(t, h, refresh2, csrf2, "", "")
	require.Equal(t, http.StatusOK, rotated2.Code)
	refresh3 := cookieValue(rotated2, auth.RefreshCookieName)
	csrf3 := cookieValue(rotated2, auth.CSRFCookieName)

	// The derivation does not mask token replay: presenting the very first refresh token
	// with its own (derived) CSRF pair still reaches the reuse detection and burns the
	// family.
	replay := refreshWithHeaders(t, h, refresh1, csrf1, "", "")
	require.Equal(t, http.StatusUnauthorized, replay.Code)
	require.Equal(t, "refresh_reuse", problemReason(t, replay))

	after := refreshWithHeaders(t, h, refresh3, csrf3, "", "")
	require.Equal(t, http.StatusUnauthorized, after.Code)
	require.Equal(t, "session_revoked", problemReason(t, after))
}

// TestLogoutRequiresBoundCSRFPair is the logout half of V-27 (and the CSRF half of
// V-29): a cross-site forced logout must not be possible, and a stolen cookie alone
// must not be enough to revoke or clear a session.
func TestLogoutRequiresBoundCSRFPair(t *testing.T) {
	h := newAPIHarness(t)
	registered := register(t, h, "alice@example.com")
	refresh1 := cookieValue(registered, auth.RefreshCookieName)
	csrf1 := cookieValue(registered, auth.CSRFCookieName)
	require.NotEmpty(t, refresh1)
	require.NotEmpty(t, csrf1)

	// No CSRF pair at all: refused, and the session survives.
	missing := logoutWithHeaders(t, h, refresh1, "", "", "", "")
	require.Equal(t, http.StatusForbidden, missing.Code)
	require.Equal(t, "csrf_mismatch", problemReason(t, missing))
	require.Empty(t, missing.Result().Cookies(), "a refused logout must not clear cookies")

	alive := refreshWithHeaders(t, h, refresh1, csrf1, "", "")
	require.Equal(t, http.StatusOK, alive.Code, "the refused forced logout must not revoke the session")
	refresh2 := cookieValue(alive, auth.RefreshCookieName)
	csrf2 := cookieValue(alive, auth.CSRFCookieName)

	// A self-consistent pair that is not derived from the refresh token is refused.
	arbitrary := "not-the-derived-token"
	rejected := logoutWithHeaders(t, h, refresh2, arbitrary, arbitrary, "", "")
	require.Equal(t, http.StatusForbidden, rejected.Code)
	require.Equal(t, "csrf_mismatch", problemReason(t, rejected))

	alive2 := refreshWithHeaders(t, h, refresh2, csrf2, "", "")
	require.Equal(t, http.StatusOK, alive2.Code)
	refresh3 := cookieValue(alive2, auth.RefreshCookieName)
	csrf3 := cookieValue(alive2, auth.CSRFCookieName)

	// Cookie/header mismatch is refused too.
	mismatch := logoutWithHeaders(t, h, refresh3, csrf3, csrf2, "", "")
	require.Equal(t, http.StatusForbidden, mismatch.Code)
	require.Equal(t, "csrf_mismatch", problemReason(t, mismatch))

	// The correct bound pair logs out and clears the cookies.
	good := logoutWithHeaders(t, h, refresh3, csrf3, csrf3, "", "")
	require.Equal(t, http.StatusNoContent, good.Code)
	cleared := false
	for _, cookie := range good.Result().Cookies() {
		if cookie.Name == auth.RefreshCookieName {
			cleared = true
			require.Equal(t, -1, cookie.MaxAge)
			require.Empty(t, cookie.Value)
		}
	}
	require.True(t, cleared, "a successful logout must clear the refresh cookie")

	// The revoked session no longer refreshes.
	after := refreshWithHeaders(t, h, refresh3, csrf3, "", "")
	require.Equal(t, http.StatusUnauthorized, after.Code)
	require.Equal(t, "session_revoked", problemReason(t, after))

	// Without a refresh cookie there is nothing to revoke: the CLI path keeps the
	// tolerant clear-and-204 behaviour.
	cli := logoutWithHeaders(t, h, "", "", "", "", "")
	require.Equal(t, http.StatusNoContent, cli.Code)
}

// TestConcurrentRefreshWithBoundCSRF proves the derived check is stateless: two racing
// refreshes both pass it, and the loser still burns the family (V-25 + V-27 together).
func TestConcurrentRefreshWithBoundCSRF(t *testing.T) {
	h := newAPIHarness(t)
	registered := register(t, h, "alice@example.com")
	refresh := cookieValue(registered, auth.RefreshCookieName)
	csrf := cookieValue(registered, auth.CSRFCookieName)
	require.NotEmpty(t, refresh)

	newRefreshRequest := func() *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/token/refresh", nil)
		req.AddCookie(&http.Cookie{Name: auth.RefreshCookieName, Value: refresh})
		req.AddCookie(&http.Cookie{Name: auth.CSRFCookieName, Value: csrf})
		req.Header.Set(auth.CSRFHeaderName, csrf)
		return h.do(t, req)
	}

	responses := make([]*httptest.ResponseRecorder, 2)
	var wg sync.WaitGroup
	for i := range responses {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			responses[i] = newRefreshRequest()
		}(i)
	}
	wg.Wait()

	var winner *httptest.ResponseRecorder
	reuseCount := 0
	for _, response := range responses {
		switch response.Code {
		case http.StatusOK:
			require.Nil(t, winner, "at most one concurrent rotation may succeed")
			winner = response
		case http.StatusUnauthorized:
			require.Equal(t, "refresh_reuse", problemReason(t, response))
			reuseCount++
		default:
			t.Fatalf("unexpected refresh status %d: %s", response.Code, response.Body.String())
		}
	}
	require.NotNil(t, winner, "exactly one concurrent rotation must succeed")
	require.Equal(t, 1, reuseCount, "the losing request must be reported as token reuse")

	// The loser revoked the family, so the winner's freshly derived pair is dead too.
	winnerRefresh := cookieValue(winner, auth.RefreshCookieName)
	winnerCSRF := cookieValue(winner, auth.CSRFCookieName)
	require.Equal(t, h.service.CSRFToken(winnerRefresh), winnerCSRF)
	after := refreshWithHeaders(t, h, winnerRefresh, winnerCSRF, "", "")
	require.Equal(t, http.StatusUnauthorized, after.Code)
	require.Equal(t, "session_revoked", problemReason(t, after))
}
