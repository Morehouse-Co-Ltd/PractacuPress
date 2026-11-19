package observability_test

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/internal/observability"
)

// entry builds one valid record with an explicit, distinguishable value set.
func entry(index int, status int) observability.Entry {
	return observability.Entry{
		Time:       time.Date(2026, 11, 17, 10, 0, 0, index, time.UTC),
		RequestID:  fmt.Sprintf("req-%d", index),
		Method:     http.MethodGet,
		Path:       "/api/v1/articles",
		Status:     status,
		DurationMS: int64(index),
		SiteID:     "site-a",
		UserID:     "user-a",
	}
}

// TestRingKeepsOnlyTheNewestEntries proves the buffer is bounded and ordered.
func TestRingKeepsOnlyTheNewestEntries(t *testing.T) {
	recorder := observability.NewRecorderWithCapacity(4)
	for index := 0; index < 10; index++ {
		recorder.Append(entry(index, http.StatusOK))
	}
	require.Equal(t, 4, recorder.Len())
	require.Equal(t, 4, recorder.Capacity())

	items := recorder.List(observability.Filter{})
	require.Len(t, items, 4)
	// Newest first: 9, 8, 7, 6.
	for index, item := range items {
		require.Equal(t, fmt.Sprintf("req-%d", 9-index), item.RequestID)
	}
	require.Equal(t, time.UTC, items[0].Time.Location())
}

// TestAppendNormalizesFieldBounds keeps one hostile request from growing a slot.
func TestAppendNormalizesFieldBounds(t *testing.T) {
	recorder := observability.NewRecorder()
	recorder.Append(observability.Entry{
		Method:     "  get  ",
		Path:       "/api/v1/" + strings.Repeat("x", observability.MaxPathLength*2),
		RequestID:  strings.Repeat("r", observability.MaxRequestIDLength*2),
		Status:     -1,
		DurationMS: -5,
	})

	item := recorder.List(observability.Filter{})[0]
	require.Equal(t, http.MethodGet, item.Method)
	require.LessOrEqual(t, len([]rune(item.Path)), observability.MaxPathLength)
	require.LessOrEqual(t, len(item.RequestID), observability.MaxRequestIDLength)
	require.Equal(t, 0, item.Status)
	require.Equal(t, int64(0), item.DurationMS)
	require.False(t, item.Time.IsZero(), "an entry without a time is stamped")
}

// TestFilterNarrowsByStatusMethodPathAndSite covers the query vocabulary.
func TestFilterNarrowsByStatusMethodPathAndSite(t *testing.T) {
	recorder := observability.NewRecorder()
	recorder.Append(observability.Entry{Method: "GET", Path: "/api/v1/articles", Status: 200, SiteID: "site-a"})
	recorder.Append(observability.Entry{Method: "POST", Path: "/api/v1/articles", Status: 201, SiteID: "site-a"})
	recorder.Append(observability.Entry{Method: "GET", Path: "/api/v1/media/1", Status: 500, SiteID: "site-b"})
	recorder.Append(observability.Entry{Method: "GET", Path: "/api/v1/articles/42", Status: 200, SiteID: "site-a"})

	byStatus := recorder.List(observability.Filter{Status: http.StatusInternalServerError})
	require.Len(t, byStatus, 1)
	require.Equal(t, "/api/v1/media/1", byStatus[0].Path)

	byMethod := recorder.List(observability.Filter{Method: "post"})
	require.Len(t, byMethod, 1)
	require.Equal(t, "POST", byMethod[0].Method)

	byPath := recorder.List(observability.Filter{Path: "articles"})
	require.Len(t, byPath, 3)

	bySite := recorder.List(observability.Filter{SiteID: "site-b"})
	require.Len(t, bySite, 1)
	require.Equal(t, "site-b", bySite[0].SiteID)

	limited := recorder.List(observability.Filter{Limit: 2})
	require.Len(t, limited, 2)

	// A limit larger than the ring reads the whole ring, never more.
	require.Len(t, recorder.List(observability.Filter{Limit: 1000}), 4)
}

// TestConcurrentAppendAndList is the concurrency check: many writers and readers
// on one ring must neither race nor lose the bound.
func TestConcurrentAppendAndList(t *testing.T) {
	recorder := observability.NewRecorderWithCapacity(64)

	const writers = 8
	const perWriter = 250
	var wait sync.WaitGroup
	wait.Add(writers + 2)

	for writer := 0; writer < writers; writer++ {
		go func(writer int) {
			defer wait.Done()
			for index := 0; index < perWriter; index++ {
				recorder.Append(observability.Entry{
					RequestID: fmt.Sprintf("w%d-%d", writer, index),
					Method:    "GET",
					Path:      "/api/v1/ping",
					Status:    200,
					SiteID:    "site-a",
				})
			}
		}(writer)
	}
	for reader := 0; reader < 2; reader++ {
		go func() {
			defer wait.Done()
			for index := 0; index < perWriter; index++ {
				items := recorder.List(observability.Filter{Limit: 16})
				if len(items) > 16 {
					t.Errorf("list returned %d items, more than the requested limit", len(items))
					return
				}
				for _, item := range items {
					if item.Method != "GET" || item.Path != "/api/v1/ping" {
						t.Errorf("corrupted entry: %+v", item)
						return
					}
				}
			}
		}()
	}
	wait.Wait()

	require.Equal(t, 64, recorder.Len())
	items := recorder.List(observability.Filter{})
	require.Len(t, items, 64)
}

// TestMiddlewareRecordsMetadataOnly proves the middleware never records a body,
// a header, a cookie or the query string.
func TestMiddlewareRecordsMetadataOnly(t *testing.T) {
	gin.SetMode(gin.TestMode)
	recorder := observability.NewRecorder()
	engine := gin.New()
	engine.Use(recorder.Middleware(observability.MiddlewareConfig{
		Now:       func() time.Time { return time.Date(2026, 11, 17, 10, 30, 0, 0, time.UTC) },
		RequestID: func(*gin.Context) string { return "req-1" },
		SiteID:    func(*gin.Context) string { return "site-a" },
		UserID:    func(*gin.Context) string { return "user-a" },
	}))
	engine.POST("/api/v1/articles", func(c *gin.Context) {
		_ = c.Request.ParseForm()
		c.Status(http.StatusCreated)
	})

	request := httptest.NewRequest(http.MethodPost, "/api/v1/articles?token=super-secret", strings.NewReader("body-secret"))
	request.Header.Set("Authorization", "Bearer super-secret")
	request.Header.Set("Cookie", "session=super-secret")
	response := httptest.NewRecorder()
	engine.ServeHTTP(response, request)

	items := recorder.List(observability.Filter{})
	require.Len(t, items, 1)
	item := items[0]
	require.Equal(t, "req-1", item.RequestID)
	require.Equal(t, http.MethodPost, item.Method)
	require.Equal(t, "/api/v1/articles", item.Path, "the query string must never be recorded")
	require.Equal(t, http.StatusCreated, item.Status)
	require.Equal(t, "site-a", item.SiteID)
	require.Equal(t, "user-a", item.UserID)

	raw, err := json.Marshal(item)
	require.NoError(t, err)
	require.NotContains(t, string(raw), "super-secret")
	require.NotContains(t, string(raw), "body-secret")
	require.NotContains(t, string(raw), "token=")
}

// TestMiddlewareFallsBackToRawPathWhenNoRouteMatches keeps 404 traffic visible.
func TestMiddlewareFallsBackToRawPathWhenNoRouteMatches(t *testing.T) {
	gin.SetMode(gin.TestMode)
	recorder := observability.NewRecorder()
	engine := gin.New()
	engine.Use(recorder.Middleware(observability.MiddlewareConfig{
		RequestID: func(*gin.Context) string { return "req-404" },
	}))
	engine.GET("/api/v1/articles", func(c *gin.Context) { c.Status(http.StatusOK) })

	request := httptest.NewRequest(http.MethodGet, "/api/v1/missing", nil)
	response := httptest.NewRecorder()
	engine.ServeHTTP(response, request)

	items := recorder.List(observability.Filter{})
	require.Len(t, items, 1)
	require.Equal(t, "/api/v1/missing", items[0].Path)
	require.Equal(t, http.StatusNotFound, items[0].Status)
	require.Empty(t, items[0].SiteID)
	require.Empty(t, items[0].UserID)
}
