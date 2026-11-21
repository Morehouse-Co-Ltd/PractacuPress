package auth_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/internal/auth"
	"github.com/practacu/practacu-press/internal/site"
)

// postJSONWithHeaders sends a JSON POST, optionally setting the Host and Origin the way
// a browser (or a proxy) would.
func postJSONWithHeaders(
	t *testing.T,
	h *apiHarness,
	path string,
	payload map[string]string,
	host, origin, contentType string,
) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, path, jsonBody(t, payload))
	if contentType == "" {
		contentType = "application/json"
	}
	req.Header.Set("Content-Type", contentType)
	// Model the socket peer as well as the Host header: the first-admin bootstrap
	// requires both to be loopback, so a loopback Host must also come from a
	// loopback peer in tests.
	req.RemoteAddr = "192.0.2.1:40000"
	if host != "" {
		req.Host = host
		if strings.HasPrefix(host, "127.0.0.1") ||
			strings.HasPrefix(host, "localhost") ||
			strings.HasPrefix(host, "[::1]") {
			req.RemoteAddr = "127.0.0.1:40000"
		}
	}
	if origin != "" {
		req.Header.Set("Origin", origin)
	}
	return h.do(t, req)
}

func refreshWithHeaders(
	t *testing.T,
	h *apiHarness,
	refresh, csrf, origin, contentType string,
) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/token/refresh", nil)
	req.AddCookie(&http.Cookie{Name: auth.RefreshCookieName, Value: refresh})
	req.AddCookie(&http.Cookie{Name: auth.CSRFCookieName, Value: csrf})
	req.Header.Set(auth.CSRFHeaderName, csrf)
	if origin != "" {
		req.Header.Set("Origin", origin)
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	return h.do(t, req)
}

func logoutWithHeaders(
	t *testing.T,
	h *apiHarness,
	refresh, csrfCookie, csrfHeader, origin, contentType string,
) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/logout", nil)
	if refresh != "" {
		req.AddCookie(&http.Cookie{Name: auth.RefreshCookieName, Value: refresh})
	}
	if csrfCookie != "" {
		req.AddCookie(&http.Cookie{Name: auth.CSRFCookieName, Value: csrfCookie})
	}
	if csrfHeader != "" {
		req.Header.Set(auth.CSRFHeaderName, csrfHeader)
	}
	if origin != "" {
		req.Header.Set("Origin", origin)
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	return h.do(t, req)
}

// TestAuthWriteEndpointsRejectForeignOrigin is the V-26 regression: a cookie-writing
// auth endpoint must refuse a request whose Origin names another site, and must not
// write a session cookie.
func TestAuthWriteEndpointsRejectForeignOrigin(t *testing.T) {
	h := newAPIHarness(t)

	crossSiteRegister := postJSONWithHeaders(t, h, "/api/v1/auth/register/email", map[string]string{
		"email": "attacker-chosen@example.com", "password": "Correct horse battery", "display_name": "X",
	}, "example.com", "http://evil.example", "")
	require.Equal(t, http.StatusForbidden, crossSiteRegister.Code)
	require.Equal(t, "permission_denied", decode(t, crossSiteRegister)["code"])
	require.Equal(t, "origin_mismatch", problemReason(t, crossSiteRegister))
	require.False(t, sessionCookieIssued(crossSiteRegister), "a cross-site attempt must not issue a session cookie")

	crossSiteLogin := postJSONWithHeaders(t, h, "/api/v1/auth/login/password", map[string]string{
		"email": "attacker-chosen@example.com", "password": "Correct horse battery",
	}, "example.com", "http://evil.example", "")
	require.Equal(t, http.StatusForbidden, crossSiteLogin.Code)
	require.Equal(t, "origin_mismatch", problemReason(t, crossSiteLogin))
	require.False(t, sessionCookieIssued(crossSiteLogin))

	// The Origin check runs before the handler, so the account was never created.
	created := register(t, h, "attacker-chosen@example.com")
	require.Equal(t, http.StatusCreated, created.Code,
		"the refused registration must not have created the account")

	// The password reset endpoints are guarded too: a cross-site reset request must not
	// reach the mail path.
	reset := postJSONWithHeaders(t, h, "/api/v1/auth/password-reset/request", map[string]string{
		"email": "alice@example.com",
	}, "example.com", "http://evil.example", "")
	require.Equal(t, http.StatusForbidden, reset.Code)
	require.Equal(t, "origin_mismatch", problemReason(t, reset))
}

// TestLogoutRejectsForeignOrigin is the V-29/AUTH-7 regression: a cross-site request
// must not force a logout.
func TestLogoutRejectsForeignOrigin(t *testing.T) {
	h := newAPIHarness(t)
	registered := register(t, h, "alice@example.com")
	require.Equal(t, http.StatusCreated, registered.Code)
	refresh := cookieValue(registered, auth.RefreshCookieName)
	csrf := cookieValue(registered, auth.CSRFCookieName)
	require.NotEmpty(t, refresh)

	crossSite := logoutWithHeaders(t, h, refresh, csrf, csrf, "http://evil.example", "")
	require.Equal(t, http.StatusForbidden, crossSite.Code)
	require.Equal(t, "origin_mismatch", problemReason(t, crossSite))
	require.Empty(t, crossSite.Result().Cookies(),
		"a refused logout must not clear cookies")

	// The session is still usable: the forced logout did not happen.
	stillAlive := refreshWithHeaders(t, h, refresh, csrf, "", "")
	require.Equal(t, http.StatusOK, stillAlive.Code)
}

// TestAuthWriteEndpointsRequireJSONContentType is the other half of V-26: text/plain is
// the only content type a cross-site simple request can carry, so it must be refused.
func TestAuthWriteEndpointsRequireJSONContentType(t *testing.T) {
	h := newAPIHarness(t)

	plainRegister := postJSONWithHeaders(t, h, "/api/v1/auth/register/email", map[string]string{
		"email": "plain@example.com", "password": "Correct horse battery", "display_name": "X",
	}, "example.com", "", "text/plain")
	require.Equal(t, http.StatusForbidden, plainRegister.Code)
	require.Equal(t, "unsupported_content_type", problemReason(t, plainRegister))
	require.False(t, sessionCookieIssued(plainRegister))

	plainLogin := postJSONWithHeaders(t, h, "/api/v1/auth/login/password", map[string]string{
		"email": "plain@example.com", "password": "Correct horse battery",
	}, "example.com", "", "text/plain")
	require.Equal(t, http.StatusForbidden, plainLogin.Code)
	require.Equal(t, "unsupported_content_type", problemReason(t, plainLogin))
	require.False(t, sessionCookieIssued(plainLogin))

	plainReset := postJSONWithHeaders(t, h, "/api/v1/auth/password-reset/confirm", map[string]string{
		"token": "some-token", "password": "Correct horse battery",
	}, "example.com", "", "text/plain")
	require.Equal(t, http.StatusForbidden, plainReset.Code)
	require.Equal(t, "unsupported_content_type", problemReason(t, plainReset))

	// The body-less endpoints accept a missing Content-Type (the SPA sends none) but
	// still reject a non-JSON value that is present.
	registered := register(t, h, "alice@example.com")
	require.Equal(t, http.StatusCreated, registered.Code)
	refresh := cookieValue(registered, auth.RefreshCookieName)
	csrf := cookieValue(registered, auth.CSRFCookieName)
	require.NotEmpty(t, refresh)

	refreshTextPlain := refreshWithHeaders(t, h, refresh, csrf, "", "text/plain")
	require.Equal(t, http.StatusForbidden, refreshTextPlain.Code)
	require.Equal(t, "unsupported_content_type", problemReason(t, refreshTextPlain))

	logoutTextPlain := logoutWithHeaders(t, h, refresh, csrf, csrf, "", "text/plain")
	require.Equal(t, http.StatusForbidden, logoutTextPlain.Code)
	require.Equal(t, "unsupported_content_type", problemReason(t, logoutTextPlain))
}

// TestSameOriginRequestIsAccepted proves the guard does not break the first party SPA:
// an Origin equal to the request host (ignoring scheme and port) is allowed.
func TestSameOriginRequestIsAccepted(t *testing.T) {
	h := newAPIHarness(t)

	w := postJSONWithHeaders(t, h, "/api/v1/auth/register/email", map[string]string{
		"email": "same-origin@example.com", "password": "Correct horse battery", "display_name": "X",
	}, "example.com", "https://example.com:443", "")
	require.Equal(t, http.StatusCreated, w.Code, w.Body.String())
	require.True(t, sessionCookieIssued(w))
}

// TestRefreshAndLogoutWithoutContentTypeStillWork keeps the session lifecycle that the
// SPA relies on: both calls are body-less and send no Content-Type.
func TestRefreshAndLogoutWithoutContentTypeStillWork(t *testing.T) {
	h := newAPIHarness(t)
	registered := register(t, h, "alice@example.com")
	refresh := cookieValue(registered, auth.RefreshCookieName)
	csrf := cookieValue(registered, auth.CSRFCookieName)

	rotated := refreshWithHeaders(t, h, refresh, csrf, "", "")
	require.Equal(t, http.StatusOK, rotated.Code)

	newRefresh := cookieValue(rotated, auth.RefreshCookieName)
	newCSRF := cookieValue(rotated, auth.CSRFCookieName)
	loggedOut := logoutWithHeaders(t, h, newRefresh, newCSRF, newCSRF, "", "")
	require.Equal(t, http.StatusNoContent, loggedOut.Code)
}

// TestRegisterRejectsOverlongEmailAsValidationError is the V-28 regression: an address
// beyond the persistence bound must be a 400, never a schema failure surfacing as 500.
func TestRegisterRejectsOverlongEmailAsValidationError(t *testing.T) {
	h := newAPIHarness(t)

	overLong := strings.Repeat("a", 243) + "@example.com" // 255 octets
	w := postJSONWithHeaders(t, h, "/api/v1/auth/register/email", map[string]string{
		"email": overLong, "password": "Correct horse battery", "display_name": "X",
	}, "", "", "")
	require.Equal(t, http.StatusBadRequest, w.Code, w.Body.String())
	require.Equal(t, "validation_failed", decode(t, w)["code"])
}

// TestRegisterRejectsBlankWeakAndCommonPasswords pins the V-30 endpoint regression at
// the new 12 character minimum: each fixture is long enough for the length rule, so a
// regression in the rule it exercises surfaces as the wrong details.rule.
func TestRegisterRejectsBlankWeakAndCommonPasswords(t *testing.T) {
	h := newAPIHarness(t)

	cases := map[string]struct{ password, rule string }{
		"twelve spaces":   {strings.Repeat(" ", 12), "blank"},
		"one class":       {"passwordpassword", "too_weak"},
		"only symbols":    {"!@#$%^&*!@#$", "too_weak"},
		"common password": {"Password1234", "too_common"},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			w := postJSONWithHeaders(t, h, "/api/v1/auth/register/email", map[string]string{
				"email": "weak@example.com", "password": tc.password, "display_name": "X",
			}, "", "", "")
			require.Equal(t, http.StatusBadRequest, w.Code, w.Body.String())
			payload := decode(t, w)
			require.Equal(t, "validation_failed", payload["code"])
			details := payload["details"].(map[string]any)
			require.Equal(t, "password", details["field"])
			require.Equal(t, tc.rule, details["rule"])
		})
	}
}

// TestAccountCreationPathsSharePasswordPolicy proves the policy is wired into every
// path that sets a password, not just self service registration.
func TestAccountCreationPathsSharePasswordPolicy(t *testing.T) {
	h := newAPIHarness(t)
	ctx := context.Background()

	_, err := h.service.RegisterEmail(ctx, h.siteID, auth.RegisterEmailInput{
		Email: "weak@example.com", Password: strings.Repeat(" ", 12), DisplayName: "Weak",
	})
	require.ErrorIs(t, err, auth.ErrInvalidInput)

	// A password reset validates the password before the token, so a weak password can
	// never consume or probe a reset token.
	err = h.service.ResetPassword(ctx, "some-token", "passwordpassword", false)
	require.ErrorIs(t, err, auth.ErrInvalidInput)

	_, err = h.service.CreateMember(ctx, auth.Principal{
		UserID: "admin", SiteID: h.siteID, Role: site.RolePlatformAdmin,
	}, h.siteID, auth.CreateMemberInput{
		Email: "member@example.com", DisplayName: "Member", Password: "Aa1!Aa1!Aa1", // 11 runes
	})
	require.ErrorIs(t, err, auth.ErrInvalidInput)
}

// TestFirstAdminBootstrapRequiresLoopback is the V-16 regression: on a fresh install
// only a loopback request may claim the owner account.
func TestFirstAdminBootstrapRequiresLoopback(t *testing.T) {
	h := newAPIHarnessWithOptions(t, apiHarnessOptions{
		hasher:              &fakeHasher{},
		bootstrapFirstAdmin: true,
		firstAdminAllowed:   auth.AllowFirstAdminFromLoopback,
	})

	remote := postJSONWithHeaders(t, h, "/api/v1/auth/register/email", map[string]string{
		"email": "attacker@example.com", "password": "Correct horse battery", "display_name": "Attacker",
	}, "evil.example", "", "")
	require.Equal(t, http.StatusForbidden, remote.Code)
	require.Equal(t, "install_requires_local_access", problemReason(t, remote))
	require.False(t, sessionCookieIssued(remote))

	members, err := h.db.Client.SiteMember.Query().Count(context.Background())
	require.NoError(t, err)
	require.Zero(t, members, "a refused first administrator must not create an account")

	owner := postJSONWithHeaders(t, h, "/api/v1/auth/register/email", map[string]string{
		"email": "owner@example.com", "password": "Correct horse battery", "display_name": "Owner",
	}, "127.0.0.1:8792", "", "")
	require.Equal(t, http.StatusCreated, owner.Code, owner.Body.String())
	require.Equal(t, "platform_admin", roleOf(t, h, owner))

	// Once an owner exists, remote registration is just a plain member.
	member := postJSONWithHeaders(t, h, "/api/v1/auth/register/email", map[string]string{
		"email": "member@example.com", "password": "Correct horse battery", "display_name": "Member",
	}, "evil.example", "", "")
	require.Equal(t, http.StatusCreated, member.Code, member.Body.String())
	require.Equal(t, "member", roleOf(t, h, member))
}

// TestFirstAdminBootstrapDeniesByDefault proves the handler is fail closed: a
// deployment that forgets the FirstAdminAllowed wiring cannot hand out platform_admin.
func TestFirstAdminBootstrapDeniesByDefault(t *testing.T) {
	h := newAPIHarnessWithOptions(t, apiHarnessOptions{
		hasher:              &fakeHasher{},
		bootstrapFirstAdmin: true,
	})

	w := postJSONWithHeaders(t, h, "/api/v1/auth/register/email", map[string]string{
		"email": "owner@example.com", "password": "Correct horse battery", "display_name": "Owner",
	}, "127.0.0.1:8792", "", "")
	require.Equal(t, http.StatusForbidden, w.Code)
	require.Equal(t, "install_requires_local_access", problemReason(t, w))
}

// roleOf reads the role the API reports for the session in w.
func roleOf(t *testing.T, h *apiHarness, w *httptest.ResponseRecorder) string {
	t.Helper()
	accessToken, _ := decode(t, w)["access_token"].(string)
	require.NotEmpty(t, accessToken)

	req := httptest.NewRequest(http.MethodGet, "/api/v1/me", nil)
	req.Header.Set("Authorization", "Bearer "+accessToken)
	me := h.do(t, req)
	require.Equal(t, http.StatusOK, me.Code)
	role, _ := decode(t, me)["role"].(string)
	return role
}
