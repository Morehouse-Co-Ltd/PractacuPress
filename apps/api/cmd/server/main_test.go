package main

import (
	"bytes"
	"log/slog"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/apps/api/internal/platform/config"
)

// The startup warning is the only place an operator learns that absolute links
// default to https. It has to fire without third party login configured too, and
// it has to name the http form a desktop or localhost install needs.
func TestWarnUnsetPublicBaseURL(t *testing.T) {
	cases := []struct {
		name         string
		cfg          config.Config
		wantContains []string
		wantEmpty    bool
	}{
		{
			name:         "desktop install over http",
			cfg:          config.Config{DesktopMode: true},
			wantContains: []string{"PUBLIC_BASE_URL is not set", "desktop", "http://127.0.0.1:<port>"},
		},
		{
			name:         "development install without a provider",
			cfg:          config.Config{},
			wantContains: []string{"PUBLIC_BASE_URL is not set", "assume https", "http://127.0.0.1:<port>"},
		},
		{
			name:      "configured origin stays quiet",
			cfg:       config.Config{PublicBaseURL: "https://press.example.com"},
			wantEmpty: true,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var out bytes.Buffer
			logger := slog.New(slog.NewTextHandler(&out, nil))

			warnUnsetPublicBaseURL(tc.cfg, logger)

			if tc.wantEmpty {
				require.Empty(t, out.String())
				return
			}
			require.Contains(t, out.String(), "level=WARN")
			for _, want := range tc.wantContains {
				require.Contains(t, out.String(), want)
			}
		})
	}
}
