// Package logging builds the process wide structured logger.
package logging

import (
	"io"
	"log/slog"
	"os"

	"github.com/practacu/practacu-press/internal/platform/config"
)

// New returns the process logger writing JSON records to stdout.
//
// Production logs at Info and above; other environments log at Debug so local
// diagnosis does not require a restart. Every record carries app_env so a single
// collector can separate environments.
func New(cfg config.Config) *slog.Logger { return NewWithWriter(cfg, os.Stdout) }

// NewWithWriter is New with an explicit sink. It exists for tests.
func NewWithWriter(cfg config.Config, w io.Writer) *slog.Logger {
	level := slog.LevelDebug
	if cfg.AppEnv == config.EnvProduction {
		level = slog.LevelInfo
	}
	handler := slog.NewJSONHandler(w, &slog.HandlerOptions{Level: level})
	return slog.New(handler).With("app_env", cfg.AppEnv)
}
