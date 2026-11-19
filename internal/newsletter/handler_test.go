package newsletter_test

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/internal/newsletter"
	apperr "github.com/practacu/practacu-press/internal/platform/errors"
	"github.com/practacu/practacu-press/internal/site"
)

// handlerFixture wires a handler with a controllable caller.
type handlerFixture struct {
	engine    *gin.Engine
	repo      *fakeRepo
	gateway   *fakeGateway
	service   *newsletter.Service
	principal newsletter.Principal
	authed    bool
}

func newHandlerFixture(t *testing.T) *handlerFixture {
	t.Helper()
	gin.SetMode(gin.TestMode)

	repo := newFakeRepo()
	gateway := newFakeGateway(repo, true)
	service := serviceWith(t, repo, gateway)

	fixture := &handlerFixture{repo: repo, gateway: gateway, service: service}

	handler := newsletter.NewHandler(service, newsletter.HandlerConfig{
		Principal: func(*gin.Context) (newsletter.Principal, bool) {
			if !fixture.authed {
				return newsletter.Principal{}, false
			}
			return fixture.principal, true
		},
		Site: func(*gin.Context) (site.Site, bool) {
			return site.Site{ID: testSite().ID, Name: testSite().Name, Domain: testSite().Domain}, true
		},
		PublicBaseURL: "https://press.example.com",
	})

	r := gin.New()
	// Mirror the production error translator so c.Error becomes a response.
	r.Use(func(c *gin.Context) {
		c.Next()
		if len(c.Errors) > 0 {
			problem := apperr.FromError(c.Errors.Last().Err)
			c.Header("Content-Type", apperr.ContentType)
			c.JSON(problem.Status, problem)
		}
	})
	handler.Routes(r, func(c *gin.Context) { c.Next() })
	fixture.engine = r
	return fixture
}

func (f *handlerFixture) asSiteAdmin() {
	f.authed = true
	f.principal = newsletter.Principal{UserID: "user-admin", SiteID: testSite().ID, Role: site.RoleSiteAdmin, CanManageSite: true}
}

func (f *handlerFixture) asMember() {
	f.authed = true
	f.principal = newsletter.Principal{UserID: "user-member", SiteID: testSite().ID, Role: site.RoleMember}
}

func (f *handlerFixture) do(method, path, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, bytes.NewReader([]byte(body)))
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	w := httptest.NewRecorder()
	f.engine.ServeHTTP(w, req)
	return w
}

func TestPublicSubscribeAndConfirmEndpoints(t *testing.T) {
	fixture := newHandlerFixture(t)

	subscribed := fixture.do(http.MethodPost, "/newsletter/subscribe", `{"email":"Reader@Example.com"}`)
	require.Equal(t, http.StatusAccepted, subscribed.Code, subscribed.Body.String())
	var subscribeBody struct {
		Status string `json:"status"`
	}
	require.NoError(t, json.Unmarshal(subscribed.Body.Bytes(), &subscribeBody))
	require.Equal(t, newsletter.StatusPending, subscribeBody.Status)

	invalid := fixture.do(http.MethodPost, "/newsletter/subscribe", `{"email":"not-an-email"}`)
	require.Equal(t, http.StatusBadRequest, invalid.Code)

	require.Len(t, fixture.gateway.sends, 1)
	token := confirmToken(t, fixture.gateway.sends[0].Text)

	confirmed := fixture.do(http.MethodGet, "/newsletter/confirm?token="+token, "")
	require.Equal(t, http.StatusOK, confirmed.Code, confirmed.Body.String())
	require.Contains(t, confirmed.Body.String(), `"status":"confirmed"`)

	unsubscribed := fixture.do(http.MethodGet, "/newsletter/unsubscribe?token="+token, "")
	require.Equal(t, http.StatusOK, unsubscribed.Code, unsubscribed.Body.String())
	require.Contains(t, unsubscribed.Body.String(), `"status":"unsubscribed"`)

	invalidToken := fixture.do(http.MethodGet, "/newsletter/confirm?token=nope", "")
	require.Equal(t, http.StatusNotFound, invalidToken.Code)
}

func TestAdminEndpointsRequireManageSite(t *testing.T) {
	fixture := newHandlerFixture(t)

	anonymous := fixture.do(http.MethodGet, "/sites/site-1/subscribers", "")
	require.Equal(t, http.StatusUnauthorized, anonymous.Code)

	fixture.asMember()
	member := fixture.do(http.MethodGet, "/sites/site-1/subscribers", "")
	require.Equal(t, http.StatusForbidden, member.Code)

	fixture.asSiteAdmin()
	admin := fixture.do(http.MethodGet, "/sites/site-1/subscribers", "")
	require.Equal(t, http.StatusOK, admin.Code, admin.Body.String())
}

func TestAdminRejectsCrossSitePath(t *testing.T) {
	fixture := newHandlerFixture(t)
	fixture.asSiteAdmin()

	crossSite := fixture.do(http.MethodGet, "/sites/another-site/subscribers", "")
	require.Equal(t, http.StatusForbidden, crossSite.Code)
}

func TestCustomPermissionGroupCanManageTheList(t *testing.T) {
	fixture := newHandlerFixture(t)
	// A custom group may grant manage_site to a member role; the live capability is
	// what decides, not the role name.
	fixture.authed = true
	fixture.principal = newsletter.Principal{
		UserID:        "user-member",
		SiteID:        testSite().ID,
		Role:          site.RoleMember,
		CanManageSite: true,
	}

	allowed := fixture.do(http.MethodGet, "/sites/site-1/subscribers", "")
	require.Equal(t, http.StatusOK, allowed.Code, allowed.Body.String())
}

func TestMemberNewsletterPreferenceEndpoints(t *testing.T) {
	fixture := newHandlerFixture(t)

	anonymous := fixture.do(http.MethodGet, "/me/newsletter", "")
	require.Equal(t, http.StatusUnauthorized, anonymous.Code)

	fixture.asMember()
	read := fixture.do(http.MethodGet, "/me/newsletter", "")
	require.Equal(t, http.StatusOK, read.Code, read.Body.String())
	var preference struct {
		Subscribed bool   `json:"subscribed"`
		Email      string `json:"email"`
		Status     string `json:"status"`
	}
	require.NoError(t, json.Unmarshal(read.Body.Bytes(), &preference))
	require.False(t, preference.Subscribed)
	require.Equal(t, "reader@example.com", preference.Email)

	updated := fixture.do(http.MethodPut, "/me/newsletter", `{"enabled":true}`)
	require.Equal(t, http.StatusOK, updated.Code, updated.Body.String())
	require.Contains(t, updated.Body.String(), `"status":"pending"`)

	missingField := fixture.do(http.MethodPut, "/me/newsletter", `{}`)
	require.Equal(t, http.StatusBadRequest, missingField.Code)
}

func TestSubscriberListAndDelete(t *testing.T) {
	fixture := newHandlerFixture(t)
	fixture.asSiteAdmin()
	addConfirmedSubscriber(t, fixture.repo, "one@example.com", "sub-one")

	listed := fixture.do(http.MethodGet, "/sites/site-1/subscribers?status=confirmed&q=one", "")
	require.Equal(t, http.StatusOK, listed.Code, listed.Body.String())
	var page struct {
		Items []struct {
			ID     string `json:"id"`
			Email  string `json:"email"`
			Status string `json:"status"`
			Source string `json:"source"`
		} `json:"items"`
		NextCursor string `json:"next_cursor"`
		HasMore    bool   `json:"has_more"`
	}
	require.NoError(t, json.Unmarshal(listed.Body.Bytes(), &page))
	require.Len(t, page.Items, 1)
	require.Equal(t, "one@example.com", page.Items[0].Email)
	require.Empty(t, page.NextCursor)
	require.False(t, page.HasMore)

	removed := fixture.do(http.MethodDelete, "/sites/site-1/subscribers/sub-one", "")
	require.Equal(t, http.StatusNoContent, removed.Code)
	require.Empty(t, fixture.repo.subscribers)

	missing := fixture.do(http.MethodDelete, "/sites/site-1/subscribers/sub-missing", "")
	require.Equal(t, http.StatusNotFound, missing.Code)

	badFilter := fixture.do(http.MethodGet, "/sites/site-1/subscribers?status=nope", "")
	require.Equal(t, http.StatusBadRequest, badFilter.Code)
}

func TestTemplateCRUDMergesDefaultsWithOverrides(t *testing.T) {
	fixture := newHandlerFixture(t)
	fixture.asSiteAdmin()

	listed := fixture.do(http.MethodGet, "/sites/site-1/email-templates", "")
	require.Equal(t, http.StatusOK, listed.Code, listed.Body.String())
	var page struct {
		Items []struct {
			Key     string `json:"key"`
			Subject string `json:"subject"`
			Builtin bool   `json:"builtin"`
			Enabled bool   `json:"enabled"`
		} `json:"items"`
	}
	require.NoError(t, json.Unmarshal(listed.Body.Bytes(), &page))
	require.Len(t, page.Items, 5)
	for _, item := range page.Items {
		require.True(t, item.Builtin)
		require.True(t, item.Enabled)
		require.NotEmpty(t, item.Subject)
	}

	saved := fixture.do(http.MethodPut, "/sites/site-1/email-templates/subscriber_confirm",
		`{"subject":"自定义确认","body_html":"<p>{{confirm_url}}</p>","body_text":"{{confirm_url}}","enabled":true}`)
	require.Equal(t, http.StatusOK, saved.Code, saved.Body.String())
	require.Contains(t, saved.Body.String(), `"builtin":false`)

	listed = fixture.do(http.MethodGet, "/sites/site-1/email-templates", "")
	require.NoError(t, json.Unmarshal(listed.Body.Bytes(), &page))
	require.Len(t, page.Items, 5)
	for _, item := range page.Items {
		if item.Key == newsletter.KeySubscriberConfirm {
			require.False(t, item.Builtin)
			require.Equal(t, "自定义确认", item.Subject)
		}
	}

	reset := fixture.do(http.MethodDelete, "/sites/site-1/email-templates/subscriber_confirm", "")
	require.Equal(t, http.StatusNoContent, reset.Code)

	listed = fixture.do(http.MethodGet, "/sites/site-1/email-templates", "")
	require.NoError(t, json.Unmarshal(listed.Body.Bytes(), &page))
	for _, item := range page.Items {
		if item.Key == newsletter.KeySubscriberConfirm {
			require.True(t, item.Builtin, "deleting the override restores the shipped default")
		}
	}

	badKey := fixture.do(http.MethodPut, "/sites/site-1/email-templates/campaign:1", `{"subject":"x","body_html":"y"}`)
	require.Equal(t, http.StatusBadRequest, badKey.Code)
}

func TestStatsEmailLogsAndSendNewsletterEndpoints(t *testing.T) {
	fixture := newHandlerFixture(t)
	fixture.asSiteAdmin()
	addConfirmedSubscriber(t, fixture.repo, "one@example.com", "sub-one")
	addConfirmedSubscriber(t, fixture.repo, "two@example.com", "sub-two")

	stats := fixture.do(http.MethodGet, "/sites/site-1/newsletter-stats", "")
	require.Equal(t, http.StatusOK, stats.Code, stats.Body.String())
	require.Contains(t, stats.Body.String(), `"confirmed":2`)

	sent := fixture.do(http.MethodPost, "/sites/site-1/newsletters",
		`{"subject":"周报","body_html":"<p>更新</p>","body_text":"更新"}`)
	require.Equal(t, http.StatusOK, sent.Code, sent.Body.String())
	require.Contains(t, sent.Body.String(), `"queued":2`)

	logs := fixture.do(http.MethodGet, "/sites/site-1/email-logs?kind=newsletter&status=queued", "")
	require.Equal(t, http.StatusOK, logs.Code, logs.Body.String())
	var page struct {
		Items []struct {
			ID          string `json:"id"`
			ToEmail     string `json:"to_email"`
			Kind        string `json:"kind"`
			TemplateKey string `json:"template_key"`
			Subject     string `json:"subject"`
			Status      string `json:"status"`
		} `json:"items"`
		HasMore bool `json:"has_more"`
	}
	require.NoError(t, json.Unmarshal(logs.Body.Bytes(), &page))
	require.Len(t, page.Items, 2)
	require.Equal(t, "newsletter", page.Items[0].Kind)
	require.Equal(t, "queued", page.Items[0].Status)
	require.Equal(t, "周报", page.Items[0].Subject)
	require.False(t, page.HasMore)

	invalidKind := fixture.do(http.MethodGet, "/sites/site-1/email-logs?kind=nope", "")
	require.Equal(t, http.StatusBadRequest, invalidKind.Code)

	invalidCursor := fixture.do(http.MethodGet, "/sites/site-1/email-logs?cursor=not-a-cursor", "")
	require.Equal(t, http.StatusBadRequest, invalidCursor.Code)
}

func TestSubscribeRateLimitReturns429(t *testing.T) {
	fixture := newHandlerFixture(t)

	for index := 0; index < newsletter.SubscribeRateLimit; index++ {
		w := fixture.do(http.MethodPost, "/newsletter/subscribe",
			`{"email":"reader`+itoa(index)+`@example.com"}`)
		require.Equal(t, http.StatusAccepted, w.Code, w.Body.String())
	}
	limited := fixture.do(http.MethodPost, "/newsletter/subscribe", `{"email":"late@example.com"}`)
	require.Equal(t, http.StatusTooManyRequests, limited.Code)
	require.NotEmpty(t, limited.Header().Get("Retry-After"))
}

// TestRoutesMatchTheContract pins the exact route set the composition root has to
// mount. The paths are the ones the OpenAPI document describes under /api/v1.
func TestRoutesMatchTheContract(t *testing.T) {
	fixture := newHandlerFixture(t)

	registered := make([]string, 0, 13)
	for _, route := range fixture.engine.Routes() {
		registered = append(registered, route.Method+" "+route.Path)
	}

	require.ElementsMatch(t, []string{
		http.MethodPost + " /newsletter/subscribe",
		http.MethodGet + " /newsletter/confirm",
		http.MethodGet + " /newsletter/unsubscribe",
		http.MethodGet + " /me/newsletter",
		http.MethodPut + " /me/newsletter",
		http.MethodGet + " /sites/:siteID/subscribers",
		http.MethodDelete + " /sites/:siteID/subscribers/:subscriberID",
		http.MethodGet + " /sites/:siteID/newsletter-stats",
		http.MethodGet + " /sites/:siteID/email-templates",
		http.MethodPut + " /sites/:siteID/email-templates/:key",
		http.MethodDelete + " /sites/:siteID/email-templates/:key",
		http.MethodGet + " /sites/:siteID/email-logs",
		http.MethodPost + " /sites/:siteID/newsletters",
	}, registered)
}
