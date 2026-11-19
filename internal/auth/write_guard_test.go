package auth

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"
)

func guardContext(method, target, host, origin, contentType string) *gin.Context {
	req := httptest.NewRequest(method, target, nil)
	req.Host = host
	if origin != "" {
		req.Header.Set("Origin", origin)
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	c, _ := gin.CreateTestContext(httptest.NewRecorder())
	c.Request = req
	return c
}

// TestValidateSameOrigin covers the V-26 origin rule: a present Origin must name the
// request host, while a missing Origin (CLI, native client) is allowed.
func TestValidateSameOrigin(t *testing.T) {
	tests := []struct {
		name        string
		host        string
		origin      string
		wantProblem bool
	}{
		{name: "no origin is allowed for native clients", host: "example.com"},
		{name: "same host", host: "example.com", origin: "http://example.com"},
		{name: "same host with https", host: "example.com", origin: "https://example.com"},
		{name: "scheme and port are ignored", host: "127.0.0.1:8792", origin: "http://127.0.0.1:18081"},
		{name: "host comparison is case insensitive", host: "Example.COM:8080", origin: "https://example.com"},
		{name: "ipv6 loopback", host: "[::1]:8080", origin: "http://[::1]:18081"},
		{name: "different host", host: "example.com", origin: "http://evil.example", wantProblem: true},
		{name: "subdomain is a different host", host: "example.com", origin: "http://app.example.com", wantProblem: true},
		{name: "null origin", host: "example.com", origin: "null", wantProblem: true},
		{name: "origin without host", host: "example.com", origin: "file:///tmp/page.html", wantProblem: true},
		{name: "unparsable origin", host: "example.com", origin: "://broken", wantProblem: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			c := guardContext(http.MethodPost, "/api/v1/auth/login/password", tt.host, tt.origin, "")
			problem := validateSameOrigin(c)
			if !tt.wantProblem {
				require.Nil(t, problem)
				return
			}
			require.NotNil(t, problem)
			require.Equal(t, "origin_mismatch", problem.Details["reason"])
		})
	}
}

// TestValidateWriteContentType covers the JSON media type rule. Endpoints that parse a
// body require it; body-less endpoints only reject a wrong value if one is present.
func TestValidateWriteContentType(t *testing.T) {
	tests := []struct {
		name        string
		contentType string
		requireJSON bool
		wantProblem bool
	}{
		{name: "plain json", contentType: "application/json", requireJSON: true},
		{name: "json with charset", contentType: "application/json; charset=utf-8", requireJSON: true},
		{name: "media type is case insensitive", contentType: "Application/JSON", requireJSON: true},
		{name: "text/plain simple request", contentType: "text/plain", requireJSON: true, wantProblem: true},
		{name: "urlencoded form", contentType: "application/x-www-form-urlencoded", requireJSON: true, wantProblem: true},
		{name: "multipart form", contentType: "multipart/form-data; boundary=x", requireJSON: true, wantProblem: true},
		{name: "missing on a body endpoint", contentType: "", requireJSON: true, wantProblem: true},
		{name: "bodyless endpoint without content type", contentType: "", requireJSON: false},
		{name: "bodyless endpoint rejects text/plain", contentType: "text/plain", requireJSON: false, wantProblem: true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			c := guardContext(http.MethodPost, "/api/v1/auth/token/refresh", "example.com", "", tt.contentType)
			problem := validateWriteContentType(c, tt.requireJSON)
			if !tt.wantProblem {
				require.Nil(t, problem)
				return
			}
			require.NotNil(t, problem)
			require.Equal(t, "unsupported_content_type", problem.Details["reason"])
		})
	}
}

func TestHostOnly(t *testing.T) {
	tests := map[string]string{
		"example.com":      "example.com",
		"example.com:8080": "example.com",
		"LocalHost:18081":  "localhost",
		"[::1]:8080":       "::1",
		"[::1]":            "::1",
		"127.0.0.1":        "127.0.0.1",
		"127.0.0.1:8792":   "127.0.0.1",
		"":                 "",
	}
	for input, want := range tests {
		require.Equal(t, want, hostOnly(input), "input %q", input)
	}
}

// TestIsLoopbackHost covers the V-16 gate: only names that point at this machine count.
func TestIsLoopbackHost(t *testing.T) {
	loopback := []string{
		"localhost", "localhost:18081", "LOCALHOST:80",
		"127.0.0.1", "127.0.0.1:8792", "127.0.0.2",
		"[::1]:8080", "::1",
	}
	for _, host := range loopback {
		require.True(t, isLoopbackHost(host), "%q must be loopback", host)
	}

	remote := []string{
		"example.com", "example.com:443", "192.168.1.10", "10.0.0.5:8080",
		"127.0.0.1.evil.example", "localhost.evil.example", "", "[::2]:8080",
	}
	for _, host := range remote {
		require.False(t, isLoopbackHost(host), "%q must not be loopback", host)
	}
}
