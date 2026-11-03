package content

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/apps/api/internal/platform/errors"
	"github.com/practacu/practacu-press/apps/api/internal/site"
)

// fakeQuota is the optional draft quota port used by the V-06 regression tests.
type fakeQuota struct {
	count int
	bytes int64
	err   error
	calls []string
}

func (f *fakeQuota) CountActiveDraftsByAuthor(_ context.Context, siteID, authorID string) (int, error) {
	f.calls = append(f.calls, "count/"+siteID+"/"+authorID)
	if f.err != nil {
		return 0, f.err
	}
	return f.count, nil
}

func (f *fakeQuota) SumActiveDraftBytesByAuthor(_ context.Context, siteID, authorID string) (int64, error) {
	f.calls = append(f.calls, "bytes/"+siteID+"/"+authorID)
	if f.err != nil {
		return 0, f.err
	}
	return f.bytes, nil
}

func newQuotaService(t *testing.T, repo Repository, quota DraftQuotaStore) *Service {
	t.Helper()
	service, err := NewService(ServiceConfig{
		Repository: repo,
		Sanitizer:  okSanitizer(),
		PublishMode: func(context.Context, string) (site.PublishMode, error) {
			return site.PublishModeOpen, nil
		},
		DraftQuota: quota,
		Now:        func() time.Time { return time.Date(2026, 10, 18, 12, 0, 0, 0, time.UTC) },
	})
	require.NoError(t, err)
	return service
}

// TestCreateDraftRejectsAtDraftCountQuota is the V-06 regression: an account that
// already holds the maximum number of active drafts cannot create another, and the
// check runs before the more expensive rendering/sanitization step.
func TestCreateDraftRejectsAtDraftCountQuota(t *testing.T) {
	repo := newFakeRepo()
	quota := &fakeQuota{count: MaxActiveDraftsPerAuthor}
	service := newQuotaService(t, repo, quota)

	_, err := service.CreateDraft(context.Background(), actor("author", site.RoleMember), KindArticle, sampleDraft())
	require.ErrorIs(t, err, ErrQuotaExceeded)
	require.Empty(t, repo.items, "a rejected draft must not be stored")
	require.Equal(t, 0, repo.seq)
}

// TestCreateDraftRejectsAtByteQuota bounds total source bytes: the incoming body counts
// against the limit, so the check bounds the result instead of the stored state only.
func TestCreateDraftRejectsAtByteQuota(t *testing.T) {
	repo := newFakeRepo()
	body := strings.Repeat("a", 100)
	quota := &fakeQuota{bytes: MaxActiveDraftBytesPerAuthor - int64(len(body)) + 1}
	service := newQuotaService(t, repo, quota)

	_, err := service.CreateDraft(context.Background(), actor("author", site.RoleMember), KindArticle, DraftInput{
		Title: "Big", SourceFormat: FormatMarkdown, SourceBody: body,
	})
	require.ErrorIs(t, err, ErrQuotaExceeded)
	require.Empty(t, repo.items)
}

// TestCreateDraftAllowsExactlyAtByteLimit keeps the boundary honest: used + incoming
// equal to the limit is allowed, one byte over is not.
func TestCreateDraftAllowsExactlyAtByteLimit(t *testing.T) {
	repo := newFakeRepo()
	body := strings.Repeat("a", 100)
	quota := &fakeQuota{bytes: MaxActiveDraftBytesPerAuthor - int64(len(body))}
	service := newQuotaService(t, repo, quota)

	item, err := service.CreateDraft(context.Background(), actor("author", site.RoleMember), KindArticle, DraftInput{
		Title: "Exactly at the limit", SourceFormat: FormatMarkdown, SourceBody: body,
	})
	require.NoError(t, err)
	require.Equal(t, StatusDraft, item.Status)
	require.Len(t, repo.items, 1)
}

// TestCreateDraftAllowsJustUnderDraftCountQuota pins the count boundary: 199 stored
// drafts still accept the 200th, which is what the config implies.
func TestCreateDraftAllowsJustUnderDraftCountQuota(t *testing.T) {
	repo := newFakeRepo()
	quota := &fakeQuota{count: MaxActiveDraftsPerAuthor - 1}
	service := newQuotaService(t, repo, quota)

	_, err := service.CreateDraft(context.Background(), actor("author", site.RoleMember), KindArticle, sampleDraft())
	require.NoError(t, err)
}

// TestCreateDraftWithoutQuotaWiringKeepsLegacyBehaviour documents the degraded default:
// an unwired deployment is not silently locked out, which is why main.go must set
// ServiceConfig.DraftQuota.
func TestCreateDraftWithoutQuotaWiringKeepsLegacyBehaviour(t *testing.T) {
	repo := newFakeRepo()
	service := newService(t, repo, okSanitizer(), site.PublishModeOpen)

	_, err := service.CreateDraft(context.Background(), actor("author", site.RoleMember), KindArticle, sampleDraft())
	require.NoError(t, err)
}

// TestCreateDraftPropagatesQuotaStoreFailure keeps a database outage from being
// reported as an exhausted quota.
func TestCreateDraftPropagatesQuotaStoreFailure(t *testing.T) {
	repo := newFakeRepo()
	boom := errors.New("content store down")
	service := newQuotaService(t, repo, &fakeQuota{err: boom})

	_, err := service.CreateDraft(context.Background(), actor("author", site.RoleMember), KindArticle, sampleDraft())
	require.ErrorIs(t, err, boom)
	require.Empty(t, repo.items)
}

// TestUpdateDraftGrowthIsBoundedByTheSameQuota closes the obvious bypass: creating
// small drafts and then inflating them through PATCH must hit the same byte limit.
func TestUpdateDraftGrowthIsBoundedByTheSameQuota(t *testing.T) {
	repo := newFakeRepo()
	quota := &fakeQuota{}
	service := newQuotaService(t, repo, quota)
	author := actor("author", site.RoleMember)
	ctx := context.Background()

	created, err := service.CreateDraft(ctx, author, KindArticle, DraftInput{
		Title: "Small", SourceFormat: FormatMarkdown, SourceBody: "hi",
	})
	require.NoError(t, err)

	quota.bytes = MaxActiveDraftBytesPerAuthor - 1
	_, err = service.UpdateDraft(ctx, author, created.ID, DraftInput{
		Title: "Small", SourceFormat: FormatMarkdown, SourceBody: strings.Repeat("x", 100),
	})
	require.ErrorIs(t, err, ErrQuotaExceeded)

	stored, err := repo.FindByID(ctx, "s1", created.ID)
	require.NoError(t, err)
	require.Equal(t, "hi", stored.SourceBody, "a refused update must not be stored")
}

// TestUpdateDraftShrinkIsAlwaysAllowed lets an author recover from a full or
// over-quota state by editing a draft down.
func TestUpdateDraftShrinkIsAlwaysAllowed(t *testing.T) {
	repo := newFakeRepo()
	quota := &fakeQuota{}
	service := newQuotaService(t, repo, quota)
	author := actor("author", site.RoleMember)
	ctx := context.Background()

	created, err := service.CreateDraft(ctx, author, KindArticle, DraftInput{
		Title: "Large", SourceFormat: FormatMarkdown, SourceBody: strings.Repeat("x", 100),
	})
	require.NoError(t, err)

	quota.bytes = MaxActiveDraftBytesPerAuthor * 2 // legacy data already over the limit
	updated, err := service.UpdateDraft(ctx, author, created.ID, DraftInput{
		Title: "Large", SourceFormat: FormatMarkdown, SourceBody: "ok",
	})
	require.NoError(t, err)
	require.Equal(t, "ok", updated.SourceBody)
}

// newQuotaEngine mounts the write routes with an authenticated member, mirroring the
// production error translation so a handler mapping failure is observable.
func newQuotaEngine(t *testing.T, repo Repository, quota DraftQuotaStore) *gin.Engine {
	t.Helper()
	gin.SetMode(gin.TestMode)

	service := newQuotaService(t, repo, quota)
	handler := NewHandler(service, HandlerConfig{
		Principal: func(*gin.Context) (Actor, bool) {
			return actor("author", site.RoleMember), true
		},
		Site: func(*gin.Context) (site.Site, bool) {
			return site.Site{ID: "s1", VisibilityMode: site.VisibilityPublic}, true
		},
	})

	engine := gin.New()
	engine.Use(func(c *gin.Context) {
		c.Next()
		if len(c.Errors) > 0 {
			problem := apperr.FromError(c.Errors.Last().Err)
			c.Header("Content-Type", apperr.ContentType)
			c.JSON(problem.Status, problem)
		}
	})
	noop := func(c *gin.Context) { c.Next() }
	handler.Routes(engine.Group("/api/v1"), noop, noop)
	return engine
}

// TestCreateDraftQuotaHandlerReturns429 pins the wire contract: status 429 and the
// stable machine readable code quota_exceeded.
func TestCreateDraftQuotaHandlerReturns429(t *testing.T) {
	engine := newQuotaEngine(t, newFakeRepo(), &fakeQuota{count: MaxActiveDraftsPerAuthor})

	body := []byte(`{"title":"Over quota","source_format":"markdown","source_body":"hello"}`)
	request := httptest.NewRequest(http.MethodPost, "/api/v1/articles", bytes.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	engine.ServeHTTP(recorder, request)

	require.Equal(t, http.StatusTooManyRequests, recorder.Code, recorder.Body.String())
	var payload map[string]any
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &payload))
	require.Equal(t, "quota_exceeded", payload["code"])
	require.Equal(t, float64(http.StatusTooManyRequests), payload["status"])
}

// TestCreateDraftHandlerStillCreatesUnderQuota keeps the positive path wired end to end.
func TestCreateDraftHandlerStillCreatesUnderQuota(t *testing.T) {
	engine := newQuotaEngine(t, newFakeRepo(), &fakeQuota{count: 1})

	body := []byte(`{"title":"Fine","source_format":"markdown","source_body":"hello"}`)
	request := httptest.NewRequest(http.MethodPost, "/api/v1/articles", bytes.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	engine.ServeHTTP(recorder, request)

	require.Equal(t, http.StatusCreated, recorder.Code, recorder.Body.String())
}
