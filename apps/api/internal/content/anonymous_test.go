package content_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"time"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/apps/api/internal/content"
	"github.com/practacu/practacu-press/apps/api/internal/platform/errors"
	"github.com/practacu/practacu-press/apps/api/internal/site"
)

// stubRepo serves a fixed catalogue so the visibility rules can be exercised without a
// database.
type stubRepo struct {
	items []content.Content
}

func (s *stubRepo) Insert(context.Context, content.Content, site.AuditEntry) (content.Content, error) {
	return content.Content{}, content.ErrInvalidInput
}

func (s *stubRepo) SaveDraft(context.Context, content.Content, site.AuditEntry) (content.Content, error) {
	return content.Content{}, content.ErrInvalidInput
}

func (s *stubRepo) FindByID(_ context.Context, siteID, contentID string) (content.Content, error) {
	for _, item := range s.items {
		if item.ID == contentID && item.SiteID == siteID {
			return item, nil
		}
	}
	return content.Content{}, content.ErrNotFound
}

func (s *stubRepo) List(_ context.Context, filter content.ListFilter) ([]content.Content, error) {
	out := make([]content.Content, 0, len(s.items))
	for _, item := range s.items {
		if item.SiteID != filter.SiteID {
			continue
		}
		if len(filter.Statuses) > 0 {
			allowed := false
			for _, status := range filter.Statuses {
				if item.Status == status {
					allowed = true
				}
			}
			if !allowed {
				continue
			}
		}
		out = append(out, item)
	}
	return out, nil
}

func (s *stubRepo) Transition(context.Context, content.Content, content.Status, site.AuditEntry) (content.Content, error) {
	return content.Content{}, content.ErrInvalidTransition
}

type acceptingSanitizer struct{}

func (acceptingSanitizer) Sanitize(context.Context, content.SourceFormat, string) (content.Sanitized, error) {
	return content.Sanitized{HTML: "<p>safe</p>", PolicyVersion: "p1"}, nil
}

// anonymousEngine mounts only the read routes with an optional auth guard that never
// attaches a principal, which is exactly the anonymous case.
func anonymousEngine(t *testing.T, visibility site.VisibilityMode) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)

	repo := &stubRepo{items: []content.Content{
		{ID: "pub", SiteID: "s1", AuthorID: "u1", Kind: content.KindArticle,
			Status: content.StatusPublished, Title: "Published", CreatedAt: time.Unix(0, 0).UTC()},
		{ID: "draft", SiteID: "s1", AuthorID: "u1", Kind: content.KindArticle,
			Status: content.StatusDraft, Title: "Draft", CreatedAt: time.Unix(0, 0).UTC()},
	}}

	service, err := content.NewService(content.ServiceConfig{
		Repository: repo,
		Sanitizer:  acceptingSanitizer{},
	})
	require.NoError(t, err)

	resolved := site.Site{ID: "s1", Slug: "main", VisibilityMode: visibility}
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



func TestAnonymousReadOnPublicSite(t *testing.T) {
	r := anonymousEngine(t, site.VisibilityPublic)

	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/articles", nil))

	require.Equal(t, http.StatusOK, w.Code, w.Body.String())

	var payload struct {
		Items []struct {
			ID     string `json:"id"`
			Status string `json:"status"`
		} `json:"items"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &payload))
	require.Len(t, payload.Items, 1, "an anonymous reader sees published items only")
	require.Equal(t, "pub", payload.Items[0].ID)
}

func TestAnonymousReadOnMembersOnlySiteIsRefused(t *testing.T) {
	r := anonymousEngine(t, site.VisibilityMembersOnly)

	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/articles", nil))

	require.Equal(t, http.StatusUnauthorized, w.Code)
	require.Equal(t, "unauthenticated", decodeCode(t, w))
}

func TestAnonymousCannotReadDraftByID(t *testing.T) {
	r := anonymousEngine(t, site.VisibilityPublic)

	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/articles/draft", nil))

	require.Equal(t, http.StatusNotFound, w.Code, "an unpublished item is not disclosed")
}

func TestAnonymousCanReadPublishedByID(t *testing.T) {
	r := anonymousEngine(t, site.VisibilityPublic)

	w := httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/articles/pub", nil))

	require.Equal(t, http.StatusOK, w.Code)
}

func decodeCode(t *testing.T, w *httptest.ResponseRecorder) string {
	t.Helper()
	var payload map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &payload))
	code, _ := payload["code"].(string)
	return code
}
