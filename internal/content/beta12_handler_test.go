package content

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"

	apperr "github.com/practacu/practacu-press/internal/platform/errors"
	"github.com/practacu/practacu-press/internal/platform/preview"
	"github.com/practacu/practacu-press/internal/site"
)

// betaHTTP is a mounted content handler over the in-memory repository, used to assert
// the Beta 1.2 HTTP surface: routes, status codes and the response shapes the contract
// fixes.
type betaHTTP struct {
	engine  *gin.Engine
	service *Service
	repo    *fakeRepo
	actor   *Actor
	clock   *betaClock
}

func newBetaHTTP(t *testing.T, tweak func(*ServiceConfig)) *betaHTTP {
	t.Helper()
	gin.SetMode(gin.TestMode)

	harness := &betaHTTP{repo: newFakeRepo(), clock: &betaClock{at: betaNow()}}
	cfg := ServiceConfig{
		Repository: harness.repo,
		Sanitizer:  okSanitizer(),
		PublishMode: func(context.Context, string) (site.PublishMode, error) {
			return site.PublishModeOpen, nil
		},
		Now: harness.clock.now,
	}
	if tweak != nil {
		tweak(&cfg)
	}
	service, err := NewService(cfg)
	require.NoError(t, err)
	harness.service = service

	resolved := site.Site{ID: "site-1", Slug: "main", VisibilityMode: site.VisibilityPublic}
	handler := NewHandler(service, HandlerConfig{
		Principal: func(*gin.Context) (Actor, bool) {
			if harness.actor == nil {
				return Actor{}, false
			}
			return *harness.actor, true
		},
		Site: func(*gin.Context) (site.Site, bool) { return resolved, true },
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
	handler.Routes(engine, noop, noop)
	harness.engine = engine
	return harness
}

// request performs one request, optionally with a JSON body.
func (h *betaHTTP) request(t *testing.T, method, path string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var reader *bytes.Reader
	if body == nil {
		reader = bytes.NewReader(nil)
	} else {
		raw, err := json.Marshal(body)
		require.NoError(t, err)
		reader = bytes.NewReader(raw)
	}
	req := httptest.NewRequest(method, path, reader)
	req.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	h.engine.ServeHTTP(recorder, req)
	return recorder
}

func (h *betaHTTP) author() *Actor {
	return &Actor{UserID: "author", SiteID: "site-1", Role: site.RoleMember}
}

func decodeJSON[T any](t *testing.T, recorder *httptest.ResponseRecorder) T {
	t.Helper()
	var out T
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &out), recorder.Body.String())
	return out
}

func TestHandlerDiffReturnsContractShape(t *testing.T) {
	harness := newBetaHTTP(t, nil)
	harness.actor = harness.author()

	ctx := context.Background()
	item, err := harness.service.CreateDraft(ctx, *harness.actor, KindArticle, DraftInput{
		Title:        "Hello",
		SourceFormat: FormatMarkdown,
		SourceBody:   "first",
	})
	require.NoError(t, err)
	_, err = harness.service.UpdateDraft(ctx, *harness.actor, item.ID, DraftInput{
		Title:        "Hello",
		SourceFormat: FormatMarkdown,
		SourceBody:   "second",
	})
	require.NoError(t, err)

	recorder := harness.request(t, http.MethodGet, "/articles/"+item.ID+"/diff?from=1&to=current", nil)
	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())

	var body struct {
		FromVersion int `json:"from_version"`
		ToVersion   int `json:"to_version"`
		Stats       struct {
			Added   int `json:"added"`
			Removed int `json:"removed"`
		} `json:"stats"`
		Hunks []struct {
			Op       string `json:"op"`
			FromLine int    `json:"from_line"`
			ToLine   int    `json:"to_line"`
			Text     string `json:"text"`
		} `json:"hunks"`
		Truncated *bool `json:"truncated"`
	}
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &body))
	require.Equal(t, 1, body.FromVersion)
	require.Equal(t, 2, body.ToVersion)
	require.Equal(t, 1, body.Stats.Added)
	require.Equal(t, 1, body.Stats.Removed)
	require.NotEmpty(t, body.Hunks)
	require.Nil(t, body.Truncated, "truncated is omitted for a short document")
	for _, hunk := range body.Hunks {
		require.Contains(t, []string{"equal", "insert", "delete"}, hunk.Op)
	}

	// from is required.
	missing := harness.request(t, http.MethodGet, "/articles/"+item.ID+"/diff", nil)
	require.Equal(t, http.StatusBadRequest, missing.Code)

	// The history permission rule: a stranger sees 404.
	harness.actor = &Actor{UserID: "stranger", SiteID: "site-1", Role: site.RoleMember}
	forbidden := harness.request(t, http.MethodGet, "/articles/"+item.ID+"/diff?from=1", nil)
	require.Equal(t, http.StatusNotFound, forbidden.Code)
}

func TestHandlerPatchStaleRevisionIsAConflict(t *testing.T) {
	harness := newBetaHTTP(t, nil)
	harness.actor = harness.author()
	ctx := context.Background()

	item, err := harness.service.CreateDraft(ctx, *harness.actor, KindArticle, sampleDraft())
	require.NoError(t, err)

	body := map[string]any{
		"title":         "Hello World",
		"source_format": "markdown",
		"source_body":   "# Edited",
		"revision":      99,
	}
	recorder := harness.request(t, http.MethodPatch, "/articles/"+item.ID, body)
	require.Equal(t, http.StatusConflict, recorder.Code, recorder.Body.String())

	var problem struct {
		Code    string         `json:"code"`
		Details map[string]any `json:"details"`
	}
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &problem))
	require.Equal(t, string(apperr.CodeContentVersionConflict), problem.Code)
	require.Equal(t, float64(item.Revision), problem.Details["current_revision"])

	// The matching token is accepted.
	body["revision"] = item.Revision
	accepted := harness.request(t, http.MethodPatch, "/articles/"+item.ID, body)
	require.Equal(t, http.StatusOK, accepted.Code, accepted.Body.String())
	updated := decodeJSON[contentResponse](t, accepted)
	require.Equal(t, item.Revision+1, updated.Revision)

	// Omitting the token keeps last-write-wins.
	delete(body, "revision")
	override := harness.request(t, http.MethodPatch, "/articles/"+item.ID, body)
	require.Equal(t, http.StatusOK, override.Code, override.Body.String())
}

func TestHandlerBulkPartialSuccess(t *testing.T) {
	harness := newBetaHTTP(t, nil)
	harness.actor = harness.author()
	ctx := context.Background()

	mine, err := harness.service.CreateDraft(ctx, *harness.actor, KindArticle, sampleDraft())
	require.NoError(t, err)
	otherActor := Actor{UserID: "other", SiteID: "site-1", Role: site.RoleMember}
	theirs, err := harness.service.CreateDraft(ctx, otherActor, KindArticle, sampleDraft())
	require.NoError(t, err)

	recorder := harness.request(t, http.MethodPost, "/articles/bulk", map[string]any{
		"ids":    []string{mine.ID, theirs.ID, "missing"},
		"action": "publish",
	})
	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())

	var result struct {
		Results []struct {
			ID    string `json:"id"`
			OK    bool   `json:"ok"`
			Error string `json:"error"`
		} `json:"results"`
		Succeeded int `json:"succeeded"`
		Failed    int `json:"failed"`
	}
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &result))
	require.Equal(t, 1, result.Succeeded)
	require.Equal(t, 2, result.Failed)
	require.Len(t, result.Results, 3)
	require.True(t, result.Results[0].OK)
	require.Empty(t, result.Results[0].Error)
	require.Equal(t, "permission_denied", result.Results[1].Error)
	require.Equal(t, "not_found", result.Results[2].Error)

	// An unknown batch action is a request level 400, never a partial success.
	invalid := harness.request(t, http.MethodPost, "/articles/bulk", map[string]any{
		"ids": []string{mine.ID}, "action": "reject",
	})
	require.Equal(t, http.StatusBadRequest, invalid.Code)
}

func TestHandlerPreviewLinkOpensDraft(t *testing.T) {
	harness := newBetaHTTP(t, func(cfg *ServiceConfig) {
		signer, err := preview.New(preview.Options{
			Key: []byte("0123456789abcdef0123456789abcdef"),
			Now: func() time.Time { return betaNow() },
		})
		require.NoError(t, err)
		cfg.PreviewSigner = signer
	})
	harness.actor = harness.author()
	ctx := context.Background()

	draft, err := harness.service.CreateDraft(ctx, *harness.actor, KindArticle, DraftInput{
		Title:        "Secret",
		Slug:         "secret",
		SourceFormat: FormatMarkdown,
		SourceBody:   "# secret",
	})
	require.NoError(t, err)

	recorder := harness.request(t, http.MethodPost, "/articles/"+draft.ID+"/preview", nil)
	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
	var grant struct {
		Token     string `json:"token"`
		ExpiresAt string `json:"expires_at"`
		Path      string `json:"path"`
	}
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &grant))
	require.NotEmpty(t, grant.Token)
	require.NotEmpty(t, grant.ExpiresAt)
	require.Equal(t, "/secret?preview_token="+url.QueryEscape(grant.Token), grant.Path)

	// Without a session and without the token the draft stays hidden.
	harness.actor = nil
	hidden := harness.request(t, http.MethodGet, "/articles/"+draft.ID, nil)
	require.Equal(t, http.StatusNotFound, hidden.Code)

	// With the token the draft is served.
	served := harness.request(
		t, http.MethodGet,
		"/articles/"+draft.ID+"?preview_token="+url.QueryEscape(grant.Token), nil,
	)
	require.Equal(t, http.StatusOK, served.Code, served.Body.String())
	view := decodeJSON[contentResponse](t, served)
	require.Equal(t, draft.ID, view.ID)
	require.Equal(t, string(StatusDraft), view.Status)

	// The token is scoped to one item.
	other, err := harness.service.CreateDraft(ctx, *harness.author(), KindArticle, sampleDraft())
	require.NoError(t, err)
	crossed := harness.request(
		t, http.MethodGet,
		"/articles/"+other.ID+"?preview_token="+url.QueryEscape(grant.Token), nil,
	)
	require.Equal(t, http.StatusNotFound, crossed.Code)
}

func TestHandlerPostRoutesMirrorArticleRoutes(t *testing.T) {
	harness := newBetaHTTP(t, func(cfg *ServiceConfig) {
		signer, err := preview.New(preview.Options{
			Key: []byte("0123456789abcdef0123456789abcdef"),
			Now: betaNow,
		})
		require.NoError(t, err)
		cfg.PreviewSigner = signer
	})
	harness.actor = harness.author()
	ctx := context.Background()

	post, err := harness.service.CreateDraft(ctx, *harness.actor, KindPost, DraftInput{
		Title:        "A Post",
		Slug:         "a-post",
		SourceFormat: FormatMarkdown,
		SourceBody:   "# post",
	})
	require.NoError(t, err)

	require.Equal(t, http.StatusOK,
		harness.request(t, http.MethodGet, "/posts/"+post.ID+"/diff?from=1&to=current", nil).Code)
	require.Equal(t, http.StatusOK,
		harness.request(t, http.MethodPost, "/posts/"+post.ID+"/preview", nil).Code)

	bulk := harness.request(t, http.MethodPost, "/posts/bulk", map[string]any{
		"ids": []string{post.ID}, "action": "publish",
	})
	require.Equal(t, http.StatusOK, bulk.Code, bulk.Body.String())
	result := decodeJSON[struct {
		Succeeded int `json:"succeeded"`
	}](t, bulk)
	require.Equal(t, 1, result.Succeeded)
}

func TestHandlerReadsAndActsBySlug(t *testing.T) {
	harness := newBetaHTTP(t, nil)
	harness.actor = harness.author()
	ctx := context.Background()

	item, err := harness.service.CreateDraft(ctx, *harness.actor, KindArticle, DraftInput{
		Title:        "Hello",
		Slug:         "hello-world",
		SourceFormat: FormatMarkdown,
		SourceBody:   "# hello",
	})
	require.NoError(t, err)

	// The action route accepts the slug: publish the draft through it.
	published := harness.request(t, http.MethodPost, "/articles/hello-world/publish", map[string]any{})
	require.Equal(t, http.StatusOK, published.Code, published.Body.String())
	view := decodeJSON[contentResponse](t, published)
	require.Equal(t, string(StatusPublished), view.Status)
	require.Contains(t, view.Actions, "unpublish", "contract I advertises the withdraw action")

	// Anonymous readers can open both spellings of the address.
	harness.actor = nil
	bySlug := harness.request(t, http.MethodGet, "/articles/hello-world", nil)
	require.Equal(t, http.StatusOK, bySlug.Code, bySlug.Body.String())
	byID := harness.request(t, http.MethodGet, "/articles/"+item.ID, nil)
	require.Equal(t, http.StatusOK, byID.Code, byID.Body.String())

	// An unknown key is a 404, and so is a post route naming an article slug.
	require.Equal(t, http.StatusNotFound,
		harness.request(t, http.MethodGet, "/articles/no-such-post", nil).Code)
	require.Equal(t, http.StatusNotFound,
		harness.request(t, http.MethodGet, "/posts/hello-world", nil).Code)

	// The delete route accepts the slug too, and undelete by id resolves the bin.
	harness.actor = harness.author()
	require.Equal(t, http.StatusOK,
		harness.request(t, http.MethodDelete, "/articles/hello-world", nil).Code)
	restored := harness.request(t, http.MethodPost, "/articles/"+item.ID+"/undelete", nil)
	require.Equal(t, http.StatusOK, restored.Code, restored.Body.String())
}

func TestHandlerUnpublishAction(t *testing.T) {
	harness := newBetaHTTP(t, nil)
	harness.actor = harness.author()
	ctx := context.Background()

	item, err := harness.service.CreateDraft(ctx, *harness.actor, KindArticle, sampleDraft())
	require.NoError(t, err)
	published, err := harness.service.Apply(ctx, *harness.actor, item.ID, ActionPublish, "")
	require.NoError(t, err)
	require.NotNil(t, published.PublishedAt)

	recorder := harness.request(t, http.MethodPost, "/articles/"+item.ID+"/unpublish", nil)
	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
	view := decodeJSON[contentResponse](t, recorder)
	require.Equal(t, string(StatusDraft), view.Status)
	require.Nil(t, view.PublishedAt)

	// The move is only available from published.
	again := harness.request(t, http.MethodPost, "/articles/"+item.ID+"/unpublish", nil)
	require.Equal(t, http.StatusConflict, again.Code)
}
