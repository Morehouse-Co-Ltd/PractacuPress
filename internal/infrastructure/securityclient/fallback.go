package securityclient

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"sync/atomic"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// ServedPath names which implementation served a call.
type ServedPath string

const (
	// ServedByGo means the Go security service answered.
	ServedByGo ServedPath = "go"
	// ServedByRust means the Rust security service answered.
	ServedByRust ServedPath = "rust"
)

// Fallback routes every security call to the preferred (Go) client and retries
// the same call on the fallback (Rust) client when — and only when — the
// preferred call failed with a transport or availability error.
//
// A successful validation rejection is authoritative: an invalid password, a
// malformed stored hash, rejected content or a rejected upload came from a
// working service that made a decision, so the call is not retried.
//
// Callers keep using the Client interface; which implementation answered is
// logged at debug level and available from ServedPath for diagnostics and
// tests.
type Fallback struct {
	primary      Client
	fallback     Client
	logger       *slog.Logger
	primaryName  string
	fallbackName string

	warnOnce sync.Once
	served   atomic.Value // ServedPath

	primaryCalls  atomic.Int64
	fallbackCalls atomic.Int64
}

var _ Client = (*Fallback)(nil)

// NewFallback builds a Go-first client with a Rust fallback.
//
// Either client may be nil, in which case the other one serves every call.
// logger may be nil; when set, the serving path is logged at debug level and
// the first fallback is logged at warn level.
func NewFallback(primary, fallback Client, logger *slog.Logger) *Fallback {
	return &Fallback{
		primary:      primary,
		fallback:     fallback,
		logger:       logger,
		primaryName:  string(ServedByGo),
		fallbackName: string(ServedByRust),
	}
}

// ServedPath reports which implementation served the most recent call, or an
// empty string when no call has completed yet.
func (f *Fallback) ServedPath() ServedPath {
	value, _ := f.served.Load().(ServedPath)
	return value
}

// Counts reports how many calls each implementation has served.
func (f *Fallback) Counts() (primary, fallback int64) {
	return f.primaryCalls.Load(), f.fallbackCalls.Load()
}

// IsAvailabilityError reports whether err means the service could not answer,
// as opposed to answering with a rejection.
//
// ErrUnavailable is what the gRPC client produces for transport failures; the
// raw gRPC codes are accepted too so a caller that passes an unmapped status
// still gets the fallback policy applied.
func IsAvailabilityError(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, ErrUnavailable) || errors.Is(err, context.DeadlineExceeded) {
		return true
	}
	switch status.Code(err) {
	case codes.Unavailable, codes.DeadlineExceeded, codes.Internal:
		return true
	default:
		return false
	}
}

// call invokes one method on the preferred client, falling back on an
// availability error.
func call[T any](f *Fallback, ctx context.Context, op string, invoke func(Client) (T, error)) (T, error) {
	var zero T
	if f.primary == nil && f.fallback == nil {
		return zero, ErrUnavailable
	}
	if f.primary == nil {
		value, err := invoke(f.fallback)
		if err == nil {
			f.recordServed(op, ServedByRust)
		}
		return value, err
	}

	value, err := invoke(f.primary)
	if err == nil {
		f.recordServed(op, ServedByGo)
		return value, nil
	}
	if !IsAvailabilityError(err) {
		// The Go service answered: its rejection is authoritative.
		return value, err
	}

	f.recordFallback(op, err)
	if f.fallback == nil {
		return value, err
	}

	fallbackValue, fallbackErr := invoke(f.fallback)
	if fallbackErr == nil {
		f.recordServed(op, ServedByRust)
		return fallbackValue, nil
	}
	if !IsAvailabilityError(fallbackErr) {
		// The Rust service answered: its rejection is authoritative.
		return fallbackValue, fallbackErr
	}
	return fallbackValue, fmt.Errorf("%w: %s: %v; %s: %w",
		ErrUnavailable, f.primaryName, err, f.fallbackName, fallbackErr)
}

// recordServed records and logs the implementation that answered.
func (f *Fallback) recordServed(op string, path ServedPath) {
	f.served.Store(path)
	if path == ServedByGo {
		f.primaryCalls.Add(1)
	} else {
		f.fallbackCalls.Add(1)
	}
	if f.logger != nil {
		f.logger.Debug("security call served", "op", op, "path", string(path))
	}
}

// recordFallback logs the transition from the preferred client to the fallback.
func (f *Fallback) recordFallback(op string, cause error) {
	if f.logger == nil {
		return
	}
	f.logger.Debug("security go service unavailable; trying rust fallback",
		"op", op, "error", cause)
	f.warnOnce.Do(func() {
		f.logger.Warn("security go service unavailable; falling back to rust",
			"op", op, "error", cause)
	})
}

// HashPassword returns a PHC formatted Argon2id hash.
func (f *Fallback) HashPassword(ctx context.Context, plain string) (string, error) {
	return call(f, ctx, "HashPassword", func(client Client) (string, error) {
		return client.HashPassword(ctx, plain)
	})
}

// VerifyPassword checks a password against a stored hash.
func (f *Fallback) VerifyPassword(ctx context.Context, plain, encoded string) (bool, error) {
	return call(f, ctx, "VerifyPassword", func(client Client) (bool, error) {
		return client.VerifyPassword(ctx, plain, encoded)
	})
}

// SanitizeContent turns source content into allow-listed HTML.
func (f *Fallback) SanitizeContent(ctx context.Context, input ContentInput) (Sanitized, error) {
	return call(f, ctx, "SanitizeContent", func(client Client) (Sanitized, error) {
		return client.SanitizeContent(ctx, input)
	})
}

// InspectUpload inspects a stored object.
func (f *Fallback) InspectUpload(ctx context.Context, input UploadInput) (ScanResult, error) {
	return call(f, ctx, "InspectUpload", func(client Client) (ScanResult, error) {
		return client.InspectUpload(ctx, input)
	})
}

// Ping reports whether the service answers at all, preferring the Go service.
func (f *Fallback) Ping(ctx context.Context) error {
	_, err := call(f, ctx, "Ping", func(client Client) (struct{}, error) {
		return struct{}{}, client.Ping(ctx)
	})
	return err
}
