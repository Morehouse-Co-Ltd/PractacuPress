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
		if filter.Kind != "" && item.Kind != filter.Kind {
			continue
		}
		if filter.AuthorID != "" && item.AuthorID != filter.AuthorID {
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
		if len(filter.AccessModes) > 0 {
			allowed := false
			mode := item.AccessMode
			if mode == "" {
				mode = content.AccessPublic
			}
			for _, filterMode := range filter.AccessModes {
				if mode == filterMode {
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

func (s *stubRepo) Search(_ context.Context, filter content.SearchFilter) (content.SearchPage, error) {
	out := make([]content.Content, 0)
	for _, item := range s.items {
		if item.SiteID != filter.SiteID || item.Status != content.StatusPublished {
			continue
		}
		if item.AccessMode != "" && item.AccessMode != content.AccessPublic {
			continue
		}
		if filter.Kind != "" && item.Kind != filter.Kind {
			continue
		}
		if item.CategoryID != filter.CategoryID && filter.CategoryID != "" {
			continue
		}
		if filter.AuthorID != "" && item.AuthorID != filter.AuthorID {
			continue
		}
		if strings.Contains(strings.ToLower(item.Title+" "+item.Summary+" "+item.SourceBody), strings.ToLower(filter.Term)) {
			out = append(out, item)
		}
	}
	total := len(out)
	if filter.Limit > 0 && len(out) > filter.Limit {
		out = out[:filter.Limit]
	}
	return content.SearchPage{Items: out, Total: total}, nil
}
func (s *stubRepo) Transition(context.Context, content.Content, content.Status, site.AuditEntry) (content.Content, error) {
	return content.Content{}, content.ErrInvalidTransition
}

func (s *stubRepo) ListRevisions(context.Context, string, string, int) ([]content.Revision, error) {
	return nil, content.ErrNotFound
}

func (s *stubRepo) FindRevision(context.Context, string, string, string) (content.Revision, error) {
	return content.Revision{}, content.ErrNotFound
}

func (s *stubRepo) RestoreRevision(context.Context, content.Content, content.Revision, site.AuditEntry) (content.Content, error) {
	return content.Content{}, content.ErrInvalidTransition
}

func (s *stubRepo) DueSchedules(context.Context, time.Time, int) ([]content.Content, error) {
	return nil, nil
}

func (s *stubRepo) RecordScheduleFailure(context.Context, string, string, int, bool, site.AuditEntry) error {
	return content.ErrNotFound
}

// IncrementViewCount mirrors the store: only a published item of the site counts.
func (s *stubRepo) IncrementViewCount(_ context.Context, siteID, contentID string) error {
	for index, item := range s.items {
		if item.ID == contentID && item.SiteID == siteID && item.Status == content.StatusPublished {
			s.items[index].ViewCount++
		}
	}
	return nil
}

func (s *stubRepo) Popular(_ context.Context, filter content.PopularFilter) ([]content.Content, error) {
	out := make([]content.Content, 0, len(s.items))
	for _, item := range s.items {
		if item.SiteID != filter.SiteID || item.Status != content.StatusPublished {
			continue
		}
		if item.AccessMode != "" && item.AccessMode != content.AccessPublic {
			continue
		}
		if filter.Kind != "" && item.Kind != filter.Kind {
			continue
		}
		if filter.CategoryID != "" && item.CategoryID != filter.CategoryID {
			continue
		}
		if filter.Tag != "" {
			found := false
			for _, tag := range item.Tags {
				if tag == filter.Tag {
					found = true
					break
				}
			}
			if !found {
				continue
			}
		}
		out = append(out, item)
	}
	if filter.Limit > 0 && len(out) > filter.Limit {
		out = out[:filter.Limit]
	}
	return out, nil
}

type acceptingSanitizer struct{}

func (acceptingSanitizer) Sanitize(context.Context, content.SourceFormat, string) (content.Sanitized, error) {
	return content.Sanitized{HTML: "<p>safe</p>", PolicyVersion: "p1"}, nil
}

// anonymousEngine mounts only the read routes with an optional auth guard that never
// attaches a principal, which is exactly the anonymous case.
func anonymousEngine(t *testing.T, visibility site.VisibilityMode) *gin.Engine {
	t.Helper()
	return anonymousEngineWithRepo(t, &stubRepo{items: []content.Content{
		{ID: "pub", SiteID: "s1", AuthorID: "u1", Kind: content.KindArticle,
			Status: content.StatusPublished, Title: "Published", CreatedAt: time.Unix(0, 0).UTC()},
		{ID: "draft", SiteID: "s1", AuthorID: "u1", Kind: content.KindArticle,
			Status: content.StatusDraft, Title: "Draft", CreatedAt: time.Unix(0, 0).UTC()},
	}}, visibility)
}

func anonymousEngineWithRepo(t *testing.T, repo *stubRepo, visibility site.VisibilityMode) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)

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

// TestAnonymousAuthorArchiveFiltersPublishedByAuthor covers the query parameter the
// /u/{userID} archive sends: it narrows the page to one author without widening what
// an anonymous reader may see.
func TestAnonymousAuthorArchiveFiltersPublishedByAuthor(t *testing.T) {
	repo := &stubRepo{items: []content.Content{
		{ID: "alice-pub", SiteID: "s1", AuthorID: "alice", Kind: content.KindArticle,
			Status: content.StatusPublished, CreatedAt: time.Unix(1, 0).UTC()},
		{ID: "alice-draft", SiteID: "s1", AuthorID: "alice", Kind: content.KindArticle,
			Status: content.StatusDraft, CreatedAt: time.Unix(2, 0).UTC()},
		{ID: "bob-pub", SiteID: "s1", AuthorID: "bob", Kind: content.KindArticle,
			Status: content.StatusPublished, CreatedAt: time.Unix(3, 0).UTC()},
	}}
	r := anonymousEngineWithRepo(t, repo, site.VisibilityPublic)

	fetch := func(path string) (int, map[string]any) {
		w := httptest.NewRecorder()
		r.ServeHTTP(w, httptest.NewRequest(http.MethodGet, path, nil))
		var payload map[string]any
		require.NoError(t, json.Unmarshal(w.Body.Bytes(), &payload))
		return w.Code, payload
	}

	code, payload := fetch("/articles?author_id=alice")
	require.Equal(t, http.StatusOK, code)
	items, ok := payload["items"].([]any)
	require.True(t, ok)
	require.Len(t, items, 1, "only the author's published item is public")
	require.Equal(t, "alice-pub", items[0].(map[string]any)["id"])

	// The archive page is kind scoped: the same author has no posts.
	code, payload = fetch("/posts?author_id=alice")
	require.Equal(t, http.StatusOK, code)
	require.Empty(t, payload["items"])
	require.Equal(t, "", payload["next_cursor"])

	// An unknown author is an empty page, never a 400.
	code, payload = fetch("/articles?author_id=ghost")
	require.Equal(t, http.StatusOK, code)
	require.Empty(t, payload["items"])
}

func decodeCode(t *testing.T, w *httptest.ResponseRecorder) string {
	t.Helper()
	var payload map[string]any
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &payload))
	code, _ := payload["code"].(string)
	return code
}
