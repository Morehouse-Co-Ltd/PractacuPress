package sms_test

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/apps/api/internal/platform/sms"
)

var testMessage = sms.Message{Phone: "13800138000", Code: "123456", Purpose: "login", TTL: 5 * time.Minute}

func TestNewReturnsNilForOffProvision(t *testing.T) {
	for _, provider := range []string{"", "off", "OFF", "  off  "} {
		sender, err := sms.New(sms.Config{Provider: provider})
		require.NoError(t, err, "provider %q", provider)
		require.Nil(t, sender, "provider %q must disable the feature", provider)
	}
}

func TestNewRejectsUnknownProvider(t *testing.T) {
	_, err := sms.New(sms.Config{Provider: "carrier-pigeon"})
	require.Error(t, err)
	require.Contains(t, err.Error(), "unsupported provider")
}

func TestNewHTTPRequiresURL(t *testing.T) {
	_, err := sms.New(sms.Config{Provider: sms.ProviderHTTP})
	require.Error(t, err)
	require.Contains(t, err.Error(), "SMS_HTTP_URL")

	_, err = sms.New(sms.Config{Provider: sms.ProviderHTTP, URL: "not a url"})
	require.Error(t, err)

	_, err = sms.New(sms.Config{Provider: sms.ProviderHTTP, URL: "ftp://gateway.example.com"})
	require.Error(t, err)
}

func TestNewHTTPBuildsConfiguredSender(t *testing.T) {
	sender, err := sms.New(sms.Config{
		Provider: sms.ProviderHTTP,
		URL:      "https://gateway.example.com/send",
		Token:    "token",
		Timeout:  time.Second,
	})
	require.NoError(t, err)
	require.NotNil(t, sender)
	require.True(t, sender.Configured())
}

func TestLogSenderWritesCodeToLog(t *testing.T) {
	var buf bytes.Buffer
	handler := slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug})
	sender, err := sms.New(sms.Config{Provider: sms.ProviderLog, Logger: slog.New(handler)})
	require.NoError(t, err)
	require.True(t, sender.Configured())

	require.NoError(t, sender.Send(context.Background(), testMessage))

	logged := buf.String()
	require.Contains(t, logged, "123456", "the developer must be able to read the code")
	require.Contains(t, logged, "138****8000", "the phone number is masked in logs")
	require.NotContains(t, logged, "13800138000", "the raw number must not reach the log")
}

func TestLogSenderRejectsEmptyMessage(t *testing.T) {
	var buf bytes.Buffer
	sender, err := sms.New(sms.Config{
		Provider: sms.ProviderLog,
		Logger:   slog.New(slog.NewTextHandler(&buf, nil)),
	})
	require.NoError(t, err)
	require.Error(t, sender.Send(context.Background(), sms.Message{}))
}

// recordingGateway is the operator side of the http provider.
type recordingGateway struct {
	mu       sync.Mutex
	requests int
	header   http.Header
	body     map[string]any
	status   int
	response string
}

func (g *recordingGateway) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.requests++
	g.header = r.Header.Clone()
	raw, _ := io.ReadAll(r.Body)
	_ = json.Unmarshal(raw, &g.body)
	status := g.status
	if status == 0 {
		status = http.StatusOK
	}
	w.WriteHeader(status)
	_, _ = w.Write([]byte(g.response))
}

func TestHTTPSenderPostsContractPayload(t *testing.T) {
	gateway := &recordingGateway{}
	server := httptest.NewServer(gateway)
	t.Cleanup(server.Close)

	sender, err := sms.New(sms.Config{
		Provider: sms.ProviderHTTP,
		URL:      server.URL,
		Token:    "s3cret-token",
		Timeout:  2 * time.Second,
	})
	require.NoError(t, err)

	require.NoError(t, sender.Send(context.Background(), testMessage))

	gateway.mu.Lock()
	defer gateway.mu.Unlock()
	require.Equal(t, 1, gateway.requests)
	require.Equal(t, "Bearer s3cret-token", gateway.header.Get("Authorization"))
	require.Equal(t, "application/json", gateway.header.Get("Content-Type"))
	require.Equal(t, "13800138000", gateway.body["phone"])
	require.Equal(t, "123456", gateway.body["code"])
	require.Equal(t, "login", gateway.body["purpose"])
	require.EqualValues(t, 300, gateway.body["ttl"])
}

func TestHTTPSenderOmitsBearerWithoutToken(t *testing.T) {
	gateway := &recordingGateway{}
	server := httptest.NewServer(gateway)
	t.Cleanup(server.Close)

	sender, err := sms.New(sms.Config{Provider: sms.ProviderHTTP, URL: server.URL})
	require.NoError(t, err)
	require.NoError(t, sender.Send(context.Background(), testMessage))

	gateway.mu.Lock()
	defer gateway.mu.Unlock()
	require.Empty(t, gateway.header.Get("Authorization"))
}

func TestHTTPSenderReportsGatewayFailure(t *testing.T) {
	gateway := &recordingGateway{status: http.StatusBadGateway, response: "carrier down"}
	server := httptest.NewServer(gateway)
	t.Cleanup(server.Close)

	sender, err := sms.New(sms.Config{Provider: sms.ProviderHTTP, URL: server.URL})
	require.NoError(t, err)

	sendErr := sender.Send(context.Background(), testMessage)
	require.Error(t, sendErr)
	require.Contains(t, sendErr.Error(), "502")
	require.Contains(t, sendErr.Error(), "carrier down")
}

func TestHTTPSenderRejectsEmptyMessage(t *testing.T) {
	gateway := &recordingGateway{}
	server := httptest.NewServer(gateway)
	t.Cleanup(server.Close)

	sender, err := sms.New(sms.Config{Provider: sms.ProviderHTTP, URL: server.URL})
	require.NoError(t, err)
	require.Error(t, sender.Send(context.Background(), sms.Message{Code: "123456"}))

	gateway.mu.Lock()
	defer gateway.mu.Unlock()
	require.Zero(t, gateway.requests, "an invalid message must not reach the gateway")
}

func TestMaskPhone(t *testing.T) {
	// The exact presentation is cosmetic; what matters is that the middle is hidden
	// and short values are not leaked verbatim.
	require.Equal(t, "138****8000", sms.MaskPhone("13800138000"))
	require.NotContains(t, sms.MaskPhone("12345"), "12345")
	require.True(t, strings.Contains(sms.MaskPhone("+8613800138000"), "*"))
}
