package analytics

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/internal/site"
)

// TestHandlerRecordVisitDerivesSignalsFromHeaderFallback pins the fallback of the
// write side: a client that omits the body referrer is still classified from the
// Referer header and the User-Agent.
func TestHandlerRecordVisitDerivesSignalsFromHeaderFallback(t *testing.T) {
	now := time.Date(2026, 10, 24, 12, 0, 0, 0, time.UTC)
	repo := &fakeRepo{}
	engine := newHandlerEngineWithSite(t, repo, now, site.Site{ID: "site_1", Domain: "example.test"})

	body := []byte(`{"path":"/a/cnt_1","title":"Hello","session":"vs_1","surface":"site"}`)
	request := httptest.NewRequest(http.MethodPost, "/api/v1/analytics/visits", bytes.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Referer", "https://www.google.com/search?q=hello")
	request.Header.Set("User-Agent", "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1")
	recorder := httptest.NewRecorder()
	engine.ServeHTTP(recorder, request)

	require.Equal(t, http.StatusNoContent, recorder.Code)
	require.Len(t, repo.visits, 1)
	stored := repo.visits[0]
	require.Equal(t, "www.google.com", stored.ReferrerHost)
	require.Equal(t, SourceSearch, stored.Source)
	require.Equal(t, DeviceMobile, stored.Device)
}

// TestHandlerRecordVisitPrefersBodyReferrer is the beta 1.2 source-data regression.
// The beacon's Referer header is the tracked page itself (same origin), so the body
// referrer must decide the source: a body referrer pointing at a search engine while
// the header points at the site is a search visit, and the external host must reach
// the report's top_referrers block.
func TestHandlerRecordVisitPrefersBodyReferrer(t *testing.T) {
	now := time.Date(2026, 10, 24, 12, 0, 0, 0, time.UTC)
	repo := &fakeRepo{}
	engine := newHandlerEngineWithSite(t, repo, now, site.Site{ID: "site_1", Domain: "example.test"})

	body := []byte(`{"path":"/a/cnt_1","title":"Hello","referrer":"https://www.google.com/search?q=hello","session":"vs_1","surface":"site"}`)
	request := httptest.NewRequest(http.MethodPost, "/api/v1/analytics/visits", bytes.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	// The browser automatically sends the tracked page as the beacon referrer.
	request.Header.Set("Referer", "https://example.com/a/cnt_1")
	request.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36")
	recorder := httptest.NewRecorder()
	engine.ServeHTTP(recorder, request)

	require.Equal(t, http.StatusNoContent, recorder.Code)
	require.Len(t, repo.visits, 1)
	stored := repo.visits[0]
	require.Equal(t, "www.google.com", stored.ReferrerHost, "the body referrer wins over the same site header")
	require.Equal(t, SourceSearch, stored.Source)
	require.Equal(t, DeviceDesktop, stored.Device)

	// Feed what was written into a report and check the external host reaches
	// top_referrers instead of being swallowed as an internal visit.
	repo.aggregate = Aggregate{
		Views:          1,
		Sessions:       1,
		SourceCounts:   []SourceCount{{Source: stored.Source, Visits: 1, Sessions: 1}},
		DeviceCounts:   []DeviceCount{{Device: stored.Device, Visits: 1, Sessions: 1}},
		ReferrerCounts: []ReferrerCount{{Host: stored.ReferrerHost, Visits: 1}},
	}
	reportRequest := httptest.NewRequest(http.MethodGet, "/api/v1/sites/site_1/analytics?range=24h", nil)
	reportRequest.Header.Set("X-Test-Principal", "1")
	reportRecorder := httptest.NewRecorder()
	engine.ServeHTTP(reportRecorder, reportRequest)
	require.Equal(t, http.StatusOK, reportRecorder.Code)

	var payload struct {
		Sources []struct {
			Source string `json:"source"`
		} `json:"sources"`
		TopReferrers []struct {
			Host string `json:"host"`
		} `json:"top_referrers"`
	}
	require.NoError(t, json.Unmarshal(reportRecorder.Body.Bytes(), &payload))
	require.Len(t, payload.Sources, 1)
	require.Equal(t, "search", payload.Sources[0].Source)
	require.Len(t, payload.TopReferrers, 1)
	require.Equal(t, "www.google.com", payload.TopReferrers[0].Host)
}

// TestHandlerRecordVisitSameSiteRefererIsInternal checks the host comparison uses the
// request host as well as the configured domain.
func TestHandlerRecordVisitSameSiteRefererIsInternal(t *testing.T) {
	now := time.Date(2026, 10, 24, 12, 0, 0, 0, time.UTC)
	repo := &fakeRepo{}
	engine := newHandlerEngineWithSite(t, repo, now, site.Site{ID: "site_1", Domain: "example.test"})

	body := []byte(`{"path":"/a/cnt_1","session":"vs_1","surface":"site"}`)
	send := func(referer, session string) Visit {
		t.Helper()
		payload := bytes.ReplaceAll(body, []byte(`"vs_1"`), []byte(`"`+session+`"`))
		request := httptest.NewRequest(http.MethodPost, "/api/v1/analytics/visits", bytes.NewReader(payload))
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Referer", referer)
		recorder := httptest.NewRecorder()
		engine.ServeHTTP(recorder, request)
		require.Equal(t, http.StatusNoContent, recorder.Code)
		return repo.visits[len(repo.visits)-1]
	}

	// httptest.NewRequest defaults the request host to example.com.
	internal := send("https://example.com/a/previous", "vs_internal")
	require.Equal(t, "", internal.ReferrerHost)
	require.Equal(t, SourceInternal, internal.Source)

	byDomain := send("https://www.example.test/a/previous", "vs_domain")
	require.Equal(t, "", byDomain.ReferrerHost)
	require.Equal(t, SourceInternal, byDomain.Source)

	external := send("https://news.example.org/a", "vs_external")
	require.Equal(t, "news.example.org", external.ReferrerHost)
	require.Equal(t, SourceReferral, external.Source)
}

// TestHandlerRecordVisitUnknownHeadersDeriveDirectAndUnknown keeps the derivation
// total: a beacon without headers is still a valid visit.
func TestHandlerRecordVisitUnknownHeadersDeriveDirectAndUnknown(t *testing.T) {
	now := time.Date(2026, 10, 24, 12, 0, 0, 0, time.UTC)
	repo := &fakeRepo{}
	engine := newHandlerEngine(t, repo, now)

	body := []byte(`{"path":"/","session":"vs_1","surface":"site"}`)
	request := httptest.NewRequest(http.MethodPost, "/api/v1/analytics/visits", bytes.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	engine.ServeHTTP(recorder, request)

	require.Equal(t, http.StatusNoContent, recorder.Code)
	require.Equal(t, SourceDirect, repo.visits[0].Source)
	require.Equal(t, DeviceUnknown, repo.visits[0].Device)
}

// TestHandlerReportGrowthBlocks pins the new response fields and confirms the
// existing fields are still emitted unchanged.
func TestHandlerReportGrowthBlocks(t *testing.T) {
	now := time.Date(2026, 10, 24, 12, 0, 0, 0, time.UTC)
	repo := &fakeRepo{aggregate: Aggregate{
		Views:      3,
		Sessions:   2,
		Online:     1,
		Timestamps: []time.Time{now},
		SourceCounts: []SourceCount{
			{Source: SourceSearch, Visits: 2, Sessions: 1},
			{Source: SourceDirect, Visits: 1, Sessions: 1},
		},
		DeviceCounts: []DeviceCount{
			{Device: DeviceMobile, Visits: 2, Sessions: 1},
			{Device: DeviceDesktop, Visits: 1, Sessions: 1},
		},
		ReferrerCounts: []ReferrerCount{{Host: "www.google.com", Visits: 2}},
		SessionVisits: []SessionVisit{
			{Session: "s1", At: now.Add(-time.Hour)},
			{Session: "s2", At: now},
		},
		SessionFirstSeen: []SessionFirstSeen{
			{Session: "s1", FirstAt: now.Add(-time.Hour)},
			{Session: "s2", FirstAt: now.Add(-48 * time.Hour)},
		},
	}}
	engine := newHandlerEngine(t, repo, now)

	request := httptest.NewRequest(http.MethodGet, "/api/v1/sites/site_1/analytics?range=24h", nil)
	request.Header.Set("X-Test-Principal", "1")
	recorder := httptest.NewRecorder()
	engine.ServeHTTP(recorder, request)

	require.Equal(t, http.StatusOK, recorder.Code)
	var payload struct {
		Range  string `json:"range"`
		Totals struct {
			Views int `json:"views"`
		} `json:"totals"`
		Series     []map[string]any `json:"series"`
		TopPages   []map[string]any `json:"top_pages"`
		TopContent []map[string]any `json:"top_content"`
		Recent     []map[string]any `json:"recent"`
		Sources    []struct {
			Source   string `json:"source"`
			Visits   int    `json:"visits"`
			Sessions int    `json:"sessions"`
		} `json:"sources"`
		Devices []struct {
			Device   string `json:"device"`
			Visits   int    `json:"visits"`
			Sessions int    `json:"sessions"`
		} `json:"devices"`
		TopReferrers []struct {
			Host   string `json:"host"`
			Visits int    `json:"visits"`
		} `json:"top_referrers"`
		Retention []struct {
			Date              string `json:"date"`
			NewSessions       int    `json:"new_sessions"`
			ReturningSessions int    `json:"returning_sessions"`
		} `json:"retention"`
	}
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &payload))

	require.Equal(t, "24h", payload.Range)
	require.Equal(t, 3, payload.Totals.Views)
	require.Len(t, payload.Series, 24)
	require.NotNil(t, payload.TopPages)
	require.NotNil(t, payload.TopContent)
	require.NotNil(t, payload.Recent)

	require.Equal(t, []struct {
		Source   string `json:"source"`
		Visits   int    `json:"visits"`
		Sessions int    `json:"sessions"`
	}{
		{Source: "search", Visits: 2, Sessions: 1},
		{Source: "direct", Visits: 1, Sessions: 1},
	}, payload.Sources)

	require.Equal(t, "mobile", payload.Devices[0].Device)
	require.Equal(t, 2, payload.Devices[0].Visits)
	require.Equal(t, 1, payload.Devices[0].Sessions)

	require.Len(t, payload.TopReferrers, 1)
	require.Equal(t, "www.google.com", payload.TopReferrers[0].Host)
	require.Equal(t, 2, payload.TopReferrers[0].Visits)

	// The retention series carries every calendar day of the 24h window; today has
	// one new session and the other was first seen two days ago.
	retention := map[string]struct {
		New       int
		Returning int
	}{}
	for _, point := range payload.Retention {
		require.NotEmpty(t, point.Date)
		retention[point.Date] = struct {
			New       int
			Returning int
		}{New: point.NewSessions, Returning: point.ReturningSessions}
	}
	require.NotEmpty(t, retention)
	require.Equal(t, 0, retention["2026-10-23"].New)
	require.Equal(t, 1, retention["2026-10-24"].New)
	require.Equal(t, 1, retention["2026-10-24"].Returning)
}

// TestHandlerReportRejectsInvalidRange pins the 400 the contract asks for.
func TestHandlerReportRejectsInvalidRange(t *testing.T) {
	repo := &fakeRepo{}
	engine := newHandlerEngine(t, repo, time.Date(2026, 10, 24, 12, 0, 0, 0, time.UTC))

	request := httptest.NewRequest(http.MethodGet, "/api/v1/sites/site_1/analytics?range=90d", nil)
	request.Header.Set("X-Test-Principal", "1")
	recorder := httptest.NewRecorder()
	engine.ServeHTTP(recorder, request)

	require.Equal(t, http.StatusBadRequest, recorder.Code)
	require.Equal(t, "validation_failed", problemCode(t, recorder))
	require.Zero(t, repo.query, "an invalid range must not reach the store")
}
