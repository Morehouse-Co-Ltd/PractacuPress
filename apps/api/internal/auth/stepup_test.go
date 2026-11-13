package auth_test

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"
)

// fakeStepUpConfig is a site-side reader that answers a fixed dedicated password
// hash, which is enough to prove the documented check order.
type fakeStepUpConfig struct {
	hash string
	err  error
}

// StepUpPasswordHash implements auth.StepUpConfigReader.
func (f fakeStepUpConfig) StepUpPasswordHash(context.Context, string) (string, error) {
	return f.hash, f.err
}

// postStepUp calls the verification endpoint with one password.
func postStepUp(t *testing.T, h *apiHarness, accessToken, password string) *httptest.ResponseRecorder {
	t.Helper()
	req := newJSONRequest(t, "/api/v1/auth/step-up", map[string]string{"password": password})
	if accessToken != "" {
		req.Header.Set("Authorization", "Bearer "+accessToken)
	}
	return h.do(t, req)
}

// registerSession registers one account and returns its access token and user id.
func registerSession(t *testing.T, h *apiHarness, email string) (string, string) {
	t.Helper()
	w := register(t, h, email)
	require.Equal(t, http.StatusCreated, w.Code, w.Body.String())
	payload := decode(t, w)
	token, _ := payload["access_token"].(string)
	require.NotEmpty(t, token)
	user, ok := payload["user"].(map[string]any)
	require.True(t, ok)
	userID, _ := user["id"].(string)
	require.NotEmpty(t, userID)
	return token, userID
}

// TestStepUpVerifyAcceptsAccountPassword is the default happy path: a site with no
// dedicated security password authorizes the step-up with the caller's login password.
func TestStepUpVerifyAcceptsAccountPassword(t *testing.T) {
	h := newAPIHarnessWithOptions(t, apiHarnessOptions{hasher: &fakeHasher{}, stepUp: true})
	token, userID := registerSession(t, h, "alice@example.com")

	w := postStepUp(t, h, token, "correct horse battery")
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())

	payload := decode(t, w)
	grant, _ := payload["token"].(string)
	require.NotEmpty(t, grant)
	require.Equal(t, float64(300), payload["expires_in"])

	// The grant is what the protected routes will accept: bound to this account and
	// this site, useless anywhere else.
	require.True(t, h.stepUpSigner.Verify(grant, userID, h.siteID))
	require.False(t, h.stepUpSigner.Verify(grant, userID, "another-site"))
	require.False(t, h.stepUpSigner.Verify(grant, "another-user", h.siteID))
	// It is not an access token.
	_, accessErr := h.issuer.VerifyAccess(grant)
	require.Error(t, accessErr, "a step-up grant must not authenticate a request")
}

// TestStepUpVerifyRejectsWrongPassword is the documented failure: 403 with
// details.reason step_up_password_rejected, never a 401 that would sign the SPA out.
func TestStepUpVerifyRejectsWrongPassword(t *testing.T) {
	h := newAPIHarnessWithOptions(t, apiHarnessOptions{hasher: &fakeHasher{}, stepUp: true})
	token, _ := registerSession(t, h, "alice@example.com")

	w := postStepUp(t, h, token, "not the password")
	require.Equal(t, http.StatusForbidden, w.Code, w.Body.String())
	require.Equal(t, "permission_denied", decode(t, w)["code"])
	require.Equal(t, "step_up_password_rejected", problemReason(t, w))
	// No grant leaked in the failure body.
	require.NotContains(t, w.Body.String(), "\"token\"")
}

// TestStepUpVerifyRejectsEmptyPassword keeps the endpoint from turning an empty body
// into a "no password needed" path.
func TestStepUpVerifyRejectsEmptyPassword(t *testing.T) {
	h := newAPIHarnessWithOptions(t, apiHarnessOptions{hasher: &fakeHasher{}, stepUp: true})
	token, _ := registerSession(t, h, "alice@example.com")

	w := postStepUp(t, h, token, "")
	require.Equal(t, http.StatusForbidden, w.Code, w.Body.String())
	require.Equal(t, "step_up_password_rejected", problemReason(t, w))
}

// TestStepUpVerifyRequiresSession: the grant is bound to an account, so there is
// nothing to mint for an anonymous caller.
func TestStepUpVerifyRequiresSession(t *testing.T) {
	h := newAPIHarnessWithOptions(t, apiHarnessOptions{hasher: &fakeHasher{}, stepUp: true})

	w := postStepUp(t, h, "", "correct horse battery")
	require.Equal(t, http.StatusUnauthorized, w.Code, w.Body.String())
}

// TestStepUpVerifyPrefersDedicatedPasswordAndFallsBackToAccountPassword pins the
// documented order: a matching dedicated site password is accepted; a mismatch falls
// back to the account login password; a wrong submission for both is rejected.
func TestStepUpVerifyPrefersDedicatedPasswordAndFallsBackToAccountPassword(t *testing.T) {
	h := newAPIHarnessWithOptions(t, apiHarnessOptions{
		hasher:       &fakeHasher{},
		stepUp:       true,
		stepUpConfig: fakeStepUpConfig{hash: fakeEncoding("site-secret")},
	})
	token, _ := registerSession(t, h, "alice@example.com")

	dedicated := postStepUp(t, h, token, "site-secret")
	require.Equal(t, http.StatusOK, dedicated.Code, dedicated.Body.String())

	// The site password does not match, but the account password does: accepted.
	fallback := postStepUp(t, h, token, "correct horse battery")
	require.Equal(t, http.StatusOK, fallback.Code, fallback.Body.String())

	rejected := postStepUp(t, h, token, "neither of them")
	require.Equal(t, http.StatusForbidden, rejected.Code, rejected.Body.String())
	require.Equal(t, "step_up_password_rejected", problemReason(t, rejected))
}

// TestStepUpVerifyFailsClosedWithoutSigner: an unwired deployment must not hand out
// a grant it cannot verify, and must not pretend the operation was authorized.
func TestStepUpVerifyFailsClosedWithoutSigner(t *testing.T) {
	h := newAPIHarnessWithOptions(t, apiHarnessOptions{hasher: &fakeHasher{}})
	token, _ := registerSession(t, h, "alice@example.com")

	w := postStepUp(t, h, token, "correct horse battery")
	require.Equal(t, http.StatusInternalServerError, w.Code, w.Body.String())
	require.Equal(t, "internal", decode(t, w)["code"])
}
