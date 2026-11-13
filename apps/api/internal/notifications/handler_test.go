package notifications

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

func newPreferencesRouter(t *testing.T, repo *prefsRepo) (*gin.Engine, *Service) {
	t.Helper()
	gin.SetMode(gin.TestMode)
	service, err := NewService(repo)
	require.NoError(t, err)
	handler := NewHandler(service, HandlerConfig{
		Principal: func(*gin.Context) (Actor, bool) {
			return Actor{UserID: "u2", SiteID: "s1"}, true
		},
	})
	router := gin.New()
	handler.Routes(router, func(*gin.Context) {})
	return router, service
}

func TestPreferencesHandlerReadsDefaults(t *testing.T) {
	router, _ := newPreferencesRouter(t, newPrefsRepo())

	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/notifications/preferences", nil)
	router.ServeHTTP(recorder, request)
	require.Equal(t, http.StatusOK, recorder.Code)

	var body struct {
		InApp           channelPreferences `json:"in_app"`
		Email           channelPreferences `json:"email"`
		EmailConfigured bool               `json:"email_configured"`
	}
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &body))
	require.True(t, body.InApp.Enabled)
	require.True(t, body.InApp.Comments)
	require.False(t, body.Email.Enabled)
	require.False(t, body.EmailConfigured)
}

func TestPreferencesHandlerWritesChoices(t *testing.T) {
	repo := newPrefsRepo()
	router, _ := newPreferencesRouter(t, repo)

	payload := `{
		"in_app": {"enabled": true, "comments": false, "reactions": true, "follows": true, "moderation": false},
		"email": {"enabled": true, "comments": true, "reactions": false, "follows": true, "moderation": true},
		"email_configured": true
	}`
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPut, "/notifications/preferences",
		bytes.NewBufferString(payload))
	request.Header.Set("Content-Type", "application/json")
	router.ServeHTTP(recorder, request)
	require.Equal(t, http.StatusOK, recorder.Code)

	require.False(t, repo.prefs.InApp.Comments)
	require.False(t, repo.prefs.InApp.Moderation)
	require.True(t, repo.prefs.Email.Enabled)
	require.False(t, repo.prefs.Email.Reactions)
}
