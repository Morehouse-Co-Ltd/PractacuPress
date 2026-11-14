package main

import (
	"context"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/apps/api/internal/infrastructure/securityclient"
	"github.com/practacu/practacu-press/apps/api/internal/platform/config"
)

// TestDialSecuritySelection pins the Go-first wiring rule: both addresses means
// a fallback wrapper, one address means that backend alone, no address means the
// fail-closed stub. The addresses point at closed ports on purpose: dialling is
// lazy, so the returned types are still built even though no service answers.
func TestDialSecuritySelection(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	t.Run("both addresses build the Go-first fallback", func(t *testing.T) {
		client, closeClient := dialSecurity(ctx, config.Config{
			SecurityGoGRPCAddr: "127.0.0.1:59993",
			SecurityGRPCAddr:   "127.0.0.1:59994",
		}, logger)
		defer closeClient()

		_, ok := client.(*securityclient.Fallback)
		require.True(t, ok, "both addresses must be wired through the fallback wrapper")

		// Both services are down, so a call fails closed as ErrUnavailable.
		require.ErrorIs(t, client.Ping(ctx), securityclient.ErrUnavailable)
	})

	t.Run("only the Go address uses it alone", func(t *testing.T) {
		client, closeClient := dialSecurity(ctx, config.Config{
			SecurityGoGRPCAddr: "127.0.0.1:59993",
		}, logger)
		defer closeClient()

		_, ok := client.(*securityclient.GRPC)
		require.True(t, ok, "a single address must not be wrapped")
		_, wrapped := client.(*securityclient.Fallback)
		require.False(t, wrapped)
	})

	t.Run("only the Rust address uses it alone", func(t *testing.T) {
		client, closeClient := dialSecurity(ctx, config.Config{
			SecurityGRPCAddr: "127.0.0.1:59994",
		}, logger)
		defer closeClient()

		_, ok := client.(*securityclient.GRPC)
		require.True(t, ok, "a single address must not be wrapped")
	})

	t.Run("no address is the fail-closed stub", func(t *testing.T) {
		client, closeClient := dialSecurity(ctx, config.Config{}, logger)
		defer closeClient()

		_, ok := client.(securityclient.Unavailable)
		require.True(t, ok)
		require.ErrorIs(t, client.Ping(ctx), securityclient.ErrUnavailable)
	})
}
