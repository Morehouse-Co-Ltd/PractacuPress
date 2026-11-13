package content_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/apps/api/internal/content"
	"github.com/practacu/practacu-press/apps/api/internal/platform/errors"
	"github.com/practacu/practacu-press/apps/api/internal/site"
)

type unlockTestHasher struct{}

func (unlockTestHasher) Hash(_ context.Context, plain string) (string, error) {
	return "hash:" + plain, nil
}

func (unlockTestHasher) Verify(_ context.Context, plain, encoded string) (bool, error) {
	return encoded == "hash:"+plain, nil
}

type unlockTestTokens struct{}

func (unlockTestTokens) IssueContentUnlock(
	_ context.Context, siteID, contentID string,
) (string, time.Time, error) {
	return "unlock:" + siteID + ":" + contentID, time.Unix(0, 0).Add(time.Hour), nil
}

func (unlockTestTokens) VerifyContentUnlock(_ context.Context, token, siteID, contentID string) bool {
	return token == "unlock:"+siteID+":"+contentID
}

// unlockEngine mounts the read and action routes for one password protected item.
func unlockEngine(t *testing.T) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)

	repo := &stubRepo{items: []content.Content{{
		ID: "secret", SiteID: "s1", AuthorID: "u1", Kind: content.KindArticle,
		Status: content.StatusPublished, Title: "Secret", Summary: "hidden",
		AccessMode: content.AccessPassword, AccessPasswordHash: "hash:s3cret",
		CreatedAt: time.Unix(0, 0).UTC(),
	}}}
	service, err := content.NewService(content.ServiceConfig{
		Repository:           repo,
		Sanitizer:            acceptingSanitizer{},
		AccessPasswordHasher: unlockTestHasher{},
		UnlockTokens:         unlockTestTokens{},
	})
	require.NoError(t, err)

	resolved := site.Site{ID: "s1", Slug: "main", VisibilityMode: site.VisibilityPublic}
	handler := content.NewHandler(service, content.HandlerConfig{
		Principal: func(*gin.Context) (content.Actor, bool) { return content.Actor{}, false },
		Site:      func(*gin.Context) (site.Site, bool) { return resolved, true },
	})

	r := gin.New()
	r.Use(func(c *gin.Context) {
		c.Next()
		if len(c.Errors) > 0 {
			problem := apperr.FromError(c.Errors.Last().Err)
			c.Header("Content-Type", apperr.ContentType)
			c.JSON(problem.Status, problem)
		}
	})
	anonymous := func(c *gin.Context) { c.Next() }
	handler.Routes(r, anonymous, anonymous)
	return r
}

// TestUnlockEndpointRequiresAndGrantsPassword is the HTTP level C-18 check: the read
// is refused with a reason the web UI can translate, a wrong password is a 403, and
// the right password sets the HttpOnly grant cookie the next read accepts.
func TestUnlockEndpointRequiresAndGrantsPassword(t *testing.T) {
	r := unlockEngine(t)

	// Reading a locked item discloses only that a password is required.
	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/articles/secret", nil))
	require.Equal(t, http.StatusForbidden, w.Code, w.Body.String())
	var problem struct {
		Code    string         `json:"code"`
		Details map[string]any `json:"details"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &problem))
	require.Equal(t, "permission_denied", problem.Code)
	require.Equal(t, "password_required", problem.Details["reason"])
	require.NotContains(t, w.Body.String(), "hidden")

	// A wrong password is refused.
	w = httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/articles/secret/unlock",
		strings.NewReader(`{"password":"wrong"}`))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusForbidden, w.Code, w.Body.String())
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &problem))
	require.Equal(t, "invalid_password", problem.Details["reason"])

	// The right password grants a cookie.
	w = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodPost, "/articles/secret/unlock",
		strings.NewReader(`{"password":"s3cret"}`))
	req.Header.Set("Content-Type", "application/json")
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.Contains(t, w.Body.String(), `"unlocked":true`)
	cookies := w.Result().Cookies()
	require.Len(t, cookies, 1)
	require.Equal(t, "pp_unlock_secret", cookies[0].Name)
	require.True(t, cookies[0].HttpOnly)

	// Replaying the cookie reads the item.
	w = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/articles/secret", nil)
	req.AddCookie(cookies[0])
	r.ServeHTTP(w, req)
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.Contains(t, w.Body.String(), `"title":"Secret"`)
}
