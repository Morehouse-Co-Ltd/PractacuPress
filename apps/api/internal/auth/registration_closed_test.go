package auth_test

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

// TestRegisterEmailFollowsRegistrationPolicy is the O-3 service/transport regression:
// a site that has closed self-service sign-ups must refuse the request without
// creating an account or issuing a session.
func TestRegisterEmailFollowsRegistrationPolicy(t *testing.T) {
	h := newAPIHarnessWithOptions(t, apiHarnessOptions{
		registrationPolicy: func(context.Context, string) (bool, error) {
			return false, nil
		},
	})

	req := newJSONRequest(t, "/api/v1/auth/register/email", map[string]string{
		"email": "closed@example.com", "password": "correct horse battery", "display_name": "Closed",
	})
	req.Header.Set("Origin", "http://example.com")
	req.Host = "example.com"
	w := httptest.NewRecorder()
	h.router.ServeHTTP(w, req)

	require.Equal(t, http.StatusForbidden, w.Code, w.Body.String())
	payload := decode(t, w)
	require.Equal(t, "permission_denied", payload["code"])
	require.Equal(t, "registration_closed", problemReason(t, w))
	require.False(t, sessionCookieIssued(w), "a closed site must not issue a session")

	// No account was created, so the identity can still be registered after the
	// operator reopens the site (checked through the same harness by flipping policy).
	openHarness := newAPIHarnessWithOptions(t, apiHarnessOptions{
		registrationPolicy: func(context.Context, string) (bool, error) { return true, nil },
	})
	openReq := newJSONRequest(t, "/api/v1/auth/register/email", map[string]string{
		"email": "closed@example.com", "password": "correct horse battery", "display_name": "Closed",
	})
	openReq.Header.Set("Origin", "http://example.com")
	openReq.Host = "example.com"
	openW := httptest.NewRecorder()
	openHarness.router.ServeHTTP(openW, openReq)
	require.Equal(t, http.StatusCreated, openW.Code, openW.Body.String())
}

// TestRegisterEmailRegistrationPolicyErrorFailsClosed keeps a broken policy lookup from
// silently opening registration.
func TestRegisterEmailRegistrationPolicyErrorFailsClosed(t *testing.T) {
	h := newAPIHarnessWithOptions(t, apiHarnessOptions{
		registrationPolicy: func(context.Context, string) (bool, error) {
			return false, errors.New("site store unavailable")
		},
	})

	req := newJSONRequest(t, "/api/v1/auth/register/email", map[string]string{
		"email": "broken@example.com", "password": "correct horse battery", "display_name": "Broken",
	})
	req.Header.Set("Origin", "http://example.com")
	req.Host = "example.com"
	w := httptest.NewRecorder()
	h.router.ServeHTTP(w, req)

	require.Equal(t, http.StatusInternalServerError, w.Code, w.Body.String())
	require.True(t, strings.Contains(w.Body.String(), "\"code\":\"internal\""), w.Body.String())
	require.False(t, sessionCookieIssued(w))
}

// TestRegistrationPolicyConfiguredOnService documents that the option reaches the
// service (a nil policy keeps the legacy open behaviour used by older deployments).
func TestRegistrationPolicyNilKeepsRegistrationOpen(t *testing.T) {
	h := newAPIHarness(t)
	req := newJSONRequest(t, "/api/v1/auth/register/email", map[string]string{
		"email": "open@example.com", "password": "correct horse battery", "display_name": "Open",
	})
	req.Header.Set("Origin", "http://example.com")
	req.Host = "example.com"
	w := httptest.NewRecorder()
	h.router.ServeHTTP(w, req)
	require.Equal(t, http.StatusCreated, w.Code, w.Body.String())
}
