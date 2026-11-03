package auth_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/apps/api/internal/auth"
	"github.com/practacu/practacu-press/apps/api/internal/infrastructure/authstore"
	"github.com/practacu/practacu-press/apps/api/internal/infrastructure/db"
	"github.com/practacu/practacu-press/apps/api/internal/platform/config"
	"github.com/practacu/practacu-press/apps/api/internal/platform/mailer"
	"github.com/practacu/practacu-press/apps/api/internal/site"
	ginrouter "github.com/practacu/practacu-press/apps/api/internal/transport/http/gin"
	"github.com/practacu/practacu-press/apps/api/internal/transport/http/gin/middleware"
)

type apiHarness struct {
	router  *gin.Engine
	db      *db.DB
	siteID  string
	service *auth.Service
}

type staticResolver struct{ site site.Site }

func (s staticResolver) Resolve(context.Context, string) (site.Site, error) { return s.site, nil }

// apiHarnessOptions lets a test replace the pieces it needs to control (clock,
// hasher, bootstrap rule) while keeping the real Ent store, router and middleware.
type apiHarnessOptions struct {
	mailer              mailer.Sender
	hasher              auth.PasswordHasher
	now                 func() time.Time
	bootstrapFirstAdmin bool
	firstAdminAllowed   auth.FirstAdminFunc
	registrationPolicy  func(ctx context.Context, siteID string) (bool, error)
}

func newAPIHarness(t *testing.T) *apiHarness {
	t.Helper()
	return newAPIHarnessWithOptions(t, apiHarnessOptions{})
}

// newAPIHarnessWithMail is the harness variant used by the password reset tests: a
// nil sender is exactly the "no SMTP configured" deployment.
func newAPIHarnessWithMail(t *testing.T, sender mailer.Sender) *apiHarness {
	t.Helper()
	return newAPIHarnessWithOptions(t, apiHarnessOptions{mailer: sender})
}

func newAPIHarnessWithOptions(t *testing.T, opts apiHarnessOptions) *apiHarness {
	t.Helper()
	ctx := context.Background()

	handle, err := db.Open(ctx, "sqlite", db.SQLiteDSN(filepath.Join(t.TempDir(), "api.db")))
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, handle.Close()) })
	require.NoError(t, handle.Client.Schema.Create(ctx))

	siteRow, err := handle.Client.Site.Create().SetSlug("main").SetName("Main").Save(ctx)
	require.NoError(t, err)

	cfg := config.Config{
		AppEnv:        config.EnvTest,
		AuthJWTIssuer: "test-issuer",
		DefaultSiteID: siteRow.ID,
	}

	issuer, _, err := auth.NewTokenIssuer(cfg)
	require.NoError(t, err)

	hasher := opts.hasher
	if hasher == nil {
		hasher = auth.NewArgon2idHasher(auth.Argon2Params{
			Memory: 8 * 1024, Iterations: 1, Parallelism: 1, SaltLength: 16, KeyLength: 32,
		})
	}

	service, err := auth.NewService(auth.ServiceConfig{
		Repository:          authstore.New(handle.Client),
		Hasher:              hasher,
		Tokens:              issuer,
		Mailer:              opts.mailer,
		Now:                 opts.now,
		BootstrapFirstAdmin: opts.bootstrapFirstAdmin,
		RegistrationPolicy:  opts.registrationPolicy,
	})
	require.NoError(t, err)

	handler := auth.NewHandler(service, auth.HandlerConfig{
		SiteID: func(c *gin.Context) string {
			if resolved, ok := middleware.SiteFrom(c); ok {
				return resolved.ID
			}
			return cfg.DefaultSiteID
		},
		Principal:         middleware.PrincipalFrom,
		FirstAdminAllowed: opts.firstAdminAllowed,
	})

	router := ginrouter.New(ginrouter.Dependencies{
		Config:       cfg,
		SiteResolver: staticResolver{site: site.Site{ID: siteRow.ID, Slug: "main", Name: "Main"}},
		AccessTokens: issuer,
		Auth:         handler,
	})

	return &apiHarness{router: router, db: handle, siteID: siteRow.ID, service: service}
}

func (h *apiHarness) do(t *testing.T, req *http.Request) *httptest.ResponseRecorder {
	t.Helper()
	w := httptest.NewRecorder()
	h.router.ServeHTTP(w, req)
	return w
}

func jsonBody(t *testing.T, values map[string]string) *bytes.Buffer {
	t.Helper()
	raw, err := json.Marshal(values)
	require.NoError(t, err)
	return bytes.NewBuffer(raw)
}

func decode(t *testing.T, w *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var payload map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &payload))
	return payload
}

func cookieValue(w *httptest.ResponseRecorder, name string) string {
	for _, cookie := range w.Result().Cookies() {
		if cookie.Name == name {
			return cookie.Value
		}
	}
	return ""
}

func register(t *testing.T, h *apiHarness, email string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/register/email", jsonBody(t, map[string]string{
		"email":        email,
		"password":     "correct horse battery",
		"display_name": "Alice",
	}))
	req.Header.Set("Content-Type", "application/json")
	return h.do(t, req)
}

func TestRegisterReturnsSessionAndCookies(t *testing.T) {
	h := newAPIHarness(t)
	w := register(t, h, "alice@example.com")

	require.Equal(t, http.StatusCreated, w.Code)

	payload := decode(t, w)
	require.NotEmpty(t, payload["access_token"])
	require.NotEmpty(t, payload["csrf_token"])
	require.Equal(t, "Bearer", payload["token_type"])
	require.NotNil(t, payload["user"])

	// The refresh token must never appear in the body: it lives in an HttpOnly cookie.
	require.NotContains(t, w.Body.String(), "refresh_token")

	refreshCookie := w.Result().Cookies()
	var found bool
	for _, cookie := range refreshCookie {
		if cookie.Name == auth.RefreshCookieName {
			found = true
			require.True(t, cookie.HttpOnly, "refresh cookie must be HttpOnly")
			require.Equal(t, auth.RefreshCookiePath, cookie.Path)
			require.NotEmpty(t, cookie.Value)
		}
		if cookie.Name == auth.CSRFCookieName {
			require.False(t, cookie.HttpOnly, "CSRF cookie must be readable by the client")
		}
	}
	require.True(t, found, "refresh cookie missing")
}

func TestRegisterRejectsDuplicateEmail(t *testing.T) {
	h := newAPIHarness(t)
	require.Equal(t, http.StatusCreated, register(t, h, "alice@example.com").Code)

	w := register(t, h, "alice@example.com")
	require.Equal(t, http.StatusConflict, w.Code)
	require.Equal(t, "conflict", decode(t, w)["code"])
}

func TestRegisterRejectsShortPassword(t *testing.T) {
	h := newAPIHarness(t)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/register/email", jsonBody(t, map[string]string{
		"email": "bob@example.com", "password": "short", "display_name": "Bob",
	}))
	req.Header.Set("Content-Type", "application/json")
	w := h.do(t, req)

	require.Equal(t, http.StatusBadRequest, w.Code)
	require.Equal(t, "validation_failed", decode(t, w)["code"])
}

// TestRegisterWeakPasswordNamesFieldAndRule is the client's side of the contract: a form
// can translate "password -> too_weak" without parsing english, while the message stays
// the one generic string the API has always returned.
func TestRegisterWeakPasswordNamesFieldAndRule(t *testing.T) {
	h := newAPIHarness(t)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/register/email", jsonBody(t, map[string]string{
		"email": "weak@example.com", "password": "password", "display_name": "Weak",
	}))
	req.Header.Set("Content-Type", "application/json")
	w := h.do(t, req)

	require.Equal(t, http.StatusBadRequest, w.Code)

	payload := decode(t, w)
	require.Equal(t, "validation_failed", payload["code"])
	require.Equal(t, "请求参数不符合要求", payload["message"], "the message must stay unchanged")

	details, ok := payload["details"].(map[string]any)
	require.True(t, ok, "details must be an object")
	require.Equal(t, "password", details["field"])
	require.Equal(t, "too_weak", details["rule"])
	require.NotEmpty(t, details["reason"])
}

func TestLoginAndMe(t *testing.T) {
	h := newAPIHarness(t)
	require.Equal(t, http.StatusCreated, register(t, h, "alice@example.com").Code)

	loginReq := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login/password", jsonBody(t, map[string]string{
		"email": "alice@example.com", "password": "correct horse battery",
	}))
	loginReq.Header.Set("Content-Type", "application/json")
	login := h.do(t, loginReq)
	require.Equal(t, http.StatusOK, login.Code)

	token, _ := decode(t, login)["access_token"].(string)
	require.NotEmpty(t, token)

	meReq := httptest.NewRequest(http.MethodGet, "/api/v1/me", nil)
	meReq.Header.Set("Authorization", "Bearer "+token)
	me := h.do(t, meReq)

	require.Equal(t, http.StatusOK, me.Code)
	payload := decode(t, me)
	require.Equal(t, "member", payload["role"])
	require.Equal(t, h.siteID, payload["site_id"])
}

func TestMeRequiresAuthentication(t *testing.T) {
	h := newAPIHarness(t)

	w := h.do(t, httptest.NewRequest(http.MethodGet, "/api/v1/me", nil))

	require.Equal(t, http.StatusUnauthorized, w.Code)
	require.Equal(t, "unauthenticated", decode(t, w)["code"])
}

func TestLoginRejectsWrongPassword(t *testing.T) {
	h := newAPIHarness(t)
	require.Equal(t, http.StatusCreated, register(t, h, "alice@example.com").Code)

	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/login/password", jsonBody(t, map[string]string{
		"email": "alice@example.com", "password": "definitely wrong",
	}))
	req.Header.Set("Content-Type", "application/json")
	w := h.do(t, req)

	require.Equal(t, http.StatusUnauthorized, w.Code)
	require.Equal(t, "unauthenticated", decode(t, w)["code"])
}

func refreshRequest(h *apiHarness, t *testing.T, refresh, csrf, headerCSRF string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/token/refresh", nil)
	if refresh != "" {
		req.AddCookie(&http.Cookie{Name: auth.RefreshCookieName, Value: refresh})
	}
	if csrf != "" {
		req.AddCookie(&http.Cookie{Name: auth.CSRFCookieName, Value: csrf})
	}
	if headerCSRF != "" {
		req.Header.Set(auth.CSRFHeaderName, headerCSRF)
	}
	return h.do(t, req)
}

func TestRefreshRotatesAndRequiresCSRF(t *testing.T) {
	h := newAPIHarness(t)
	registered := register(t, h, "alice@example.com")
	require.Equal(t, http.StatusCreated, registered.Code)

	refresh := cookieValue(registered, auth.RefreshCookieName)
	csrf := cookieValue(registered, auth.CSRFCookieName)
	require.NotEmpty(t, refresh)
	require.NotEmpty(t, csrf)

	// Missing CSRF header is refused before any session state is touched.
	noHeader := refreshRequest(h, t, refresh, csrf, "")
	require.Equal(t, http.StatusForbidden, noHeader.Code)
	require.Equal(t, "permission_denied", decode(t, noHeader)["code"])

	// Mismatched header is refused too.
	mismatch := refreshRequest(h, t, refresh, csrf, "not-the-token")
	require.Equal(t, http.StatusForbidden, mismatch.Code)

	// A correct double submit rotates the session.
	ok := refreshRequest(h, t, refresh, csrf, csrf)
	require.Equal(t, http.StatusOK, ok.Code)
	newRefresh := cookieValue(ok, auth.RefreshCookieName)
	require.NotEmpty(t, newRefresh)
	require.NotEqual(t, refresh, newRefresh, "refresh token must rotate")
	require.NotEmpty(t, decode(t, ok)["access_token"])

	// The rotated token is dead; replaying it burns the family.
	replay := refreshRequest(h, t, refresh, csrf, csrf)
	require.Equal(t, http.StatusUnauthorized, replay.Code)
	require.Equal(t, "refresh_reuse", decode(t, replay)["details"].(map[string]any)["reason"])

	// The legitimate successor is revoked by the replay detection.
	afterReplay := refreshRequest(h, t, newRefresh, cookieValue(ok, auth.CSRFCookieName),
		cookieValue(ok, auth.CSRFCookieName))
	require.Equal(t, http.StatusUnauthorized, afterReplay.Code)
}

func TestRefreshWithoutCookieIsUnauthenticated(t *testing.T) {
	h := newAPIHarness(t)

	w := refreshRequest(h, t, "", "", "")

	require.Equal(t, http.StatusUnauthorized, w.Code)
	require.Equal(t, "missing_refresh_cookie", decode(t, w)["details"].(map[string]any)["reason"])
}

func TestLogoutClearsCookiesAndRevokes(t *testing.T) {
	h := newAPIHarness(t)
	registered := register(t, h, "alice@example.com")
	refresh := cookieValue(registered, auth.RefreshCookieName)
	csrf := cookieValue(registered, auth.CSRFCookieName)

	logoutReq := httptest.NewRequest(http.MethodPost, "/api/v1/auth/logout", nil)
	logoutReq.AddCookie(&http.Cookie{Name: auth.RefreshCookieName, Value: refresh})
	logoutReq.AddCookie(&http.Cookie{Name: auth.CSRFCookieName, Value: csrf})
	logoutReq.Header.Set(auth.CSRFHeaderName, csrf)
	logout := h.do(t, logoutReq)

	require.Equal(t, http.StatusNoContent, logout.Code)

	// Cookies are cleared.
	for _, cookie := range logout.Result().Cookies() {
		if cookie.Name == auth.RefreshCookieName {
			require.Equal(t, -1, cookie.MaxAge)
			require.Empty(t, cookie.Value)
		}
	}

	// The session behind the cleared cookie no longer refreshes.
	after := refreshRequest(h, t, refresh, csrf, csrf)
	require.Equal(t, http.StatusUnauthorized, after.Code)
}
