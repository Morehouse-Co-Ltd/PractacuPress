package content_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/apps/api/internal/content"
	"github.com/practacu/practacu-press/apps/api/internal/site"
)

// searchRepo has one published item whose title, summary and body all mention the
// term, so the handler test can assert both the page fields and the snippet.
//
// RenderedHTML carries the sanitized body, exactly as the publish path stores it;
// the snippet is derived from it, which is what keeps markup out of the excerpt.
func searchRepo() *stubRepo {
	return &stubRepo{items: []content.Content{{
		ID:            "art_1",
		SiteID:        "s1",
		AuthorID:      "u1",
		Kind:          content.KindArticle,
		Status:        content.StatusPublished,
		Title:         "排版指南",
		Summary:       "关于字距与行距",
		SourceFormat:  content.FormatMarkdown,
		SourceBody:    "排版是一门手艺 <b>不是</b>装饰",
		RenderedHTML:  "<p>排版是一门手艺 <b>不是</b>装饰</p>",
		PolicyVersion: "policy-1",
		CreatedAt:     time.Unix(1, 0).UTC(),
	}}}
}

func searchGet(t *testing.T, engine http.Handler, query string) *httptest.ResponseRecorder {
	t.Helper()
	w := httptest.NewRecorder()
	engine.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/search?"+query, nil))
	return w
}

// TestSearchEndpointReturnsCursorPage pins the response shape the web client and the
// OpenAPI document both depend on: an items array, the cross-page total, the opaque
// cursor, has_more and a plain text snippet that is never markup.
func TestSearchEndpointReturnsCursorPage(t *testing.T) {
	engine := anonymousEngineWithRepo(t, searchRepo(), site.VisibilityPublic)

	w := searchGet(t, engine, "q="+url.QueryEscape("排版")+"&limit=5")
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())

	var body struct {
		Items []struct {
			ID      string  `json:"id"`
			Title   string  `json:"title"`
			Snippet *string `json:"snippet"`
		} `json:"items"`
		Total      int    `json:"total"`
		NextCursor string `json:"next_cursor"`
		HasMore    bool   `json:"has_more"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
	require.Equal(t, 1, body.Total)
	require.Len(t, body.Items, 1)
	require.Equal(t, "art_1", body.Items[0].ID)
	require.NotNil(t, body.Items[0].Snippet, "highlight defaults on")
	require.Contains(t, *body.Items[0].Snippet, "排版")
	require.NotContains(t, *body.Items[0].Snippet, "<", "a snippet is plain text, never markup")
	require.Empty(t, body.NextCursor)
	require.False(t, body.HasMore)
	require.NotContains(t, w.Body.String(), `"degraded":true`, "a real index is not degraded")

	// highlight=false keeps the same page but drops the snippet entirely.
	w = searchGet(t, engine, "q="+url.QueryEscape("排版")+"&highlight=false")
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())
	require.NotContains(t, w.Body.String(), `"snippet"`)
}

// TestSearchEndpointRejectsMalformedFilters proves a bad narrowing value is a 400,
// never a silently dropped filter: dropping one would widen the result set.
func TestSearchEndpointRejectsMalformedFilters(t *testing.T) {
	engine := anonymousEngineWithRepo(t, searchRepo(), site.VisibilityPublic)

	cases := []struct {
		name  string
		query string
		code  string
	}{
		{name: "term too short", query: "q=a", code: "validation_failed"},
		{name: "unknown kind", query: "q=" + url.QueryEscape("排版") + "&kind=page", code: "validation_failed"},
		{name: "limit not a number", query: "q=" + url.QueryEscape("排版") + "&limit=many", code: "validation_failed"},
		{name: "bad since", query: "q=" + url.QueryEscape("排版") + "&since=yesterday", code: "validation_failed"},
		{
			name:  "until before since",
			query: "q=" + url.QueryEscape("排版") + "&since=2026-11-02T00:00:00Z&until=2026-11-01T00:00:00Z",
			code:  "validation_failed",
		},
		{name: "malformed cursor", query: "q=" + url.QueryEscape("排版") + "&cursor=not-a-cursor", code: "invalid_cursor"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			w := searchGet(t, engine, tc.query)
			require.Equal(t, http.StatusBadRequest, w.Code, w.Body.String())
			var problem struct {
				Code string `json:"code"`
			}
			require.NoError(t, json.Unmarshal(w.Body.Bytes(), &problem))
			require.Equal(t, tc.code, problem.Code)
		})
	}
}

// TestSearchEndpointTreatsWildcardsLiterally keeps the documented promise that a
// term is matched as text: a LIKE wildcard cannot turn one item into every item.
func TestSearchEndpointTreatsWildcardsLiterally(t *testing.T) {
	engine := anonymousEngineWithRepo(t, searchRepo(), site.VisibilityPublic)

	w := searchGet(t, engine, "q="+url.QueryEscape("%%")+"&limit=5")
	require.Equal(t, http.StatusOK, w.Code, w.Body.String())

	var body struct {
		Items []any `json:"items"`
		Total int   `json:"total"`
	}
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &body))
	require.Zero(t, body.Total, "a punctuation-only term has no searchable token")
	require.Empty(t, body.Items)
}
