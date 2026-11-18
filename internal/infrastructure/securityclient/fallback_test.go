package securityclient

import (
	"bytes"
	"context"
	"log/slog"
	"testing"

	"github.com/stretchr/testify/require"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// stubClient records how often it was called and returns canned results.
type stubClient struct {
	name  string
	calls int
	down  bool

	hash        string
	hashErr     error
	matches     bool
	verifyErr   error
	sanitized   Sanitized
	sanitizeErr error
	scan        ScanResult
	scanErr     error
	pingErr     error
}

var _ Client = (*stubClient)(nil)

func (c *stubClient) HashPassword(context.Context, string) (string, error) {
	c.calls++
	if c.down {
		return "", ErrUnavailable
	}
	return c.hash, c.hashErr
}

func (c *stubClient) VerifyPassword(context.Context, string, string) (bool, error) {
	c.calls++
	if c.down {
		return false, ErrUnavailable
	}
	return c.matches, c.verifyErr
}

func (c *stubClient) SanitizeContent(context.Context, ContentInput) (Sanitized, error) {
	c.calls++
	if c.down {
		return Sanitized{}, ErrUnavailable
	}
	return c.sanitized, c.sanitizeErr
}

func (c *stubClient) InspectUpload(context.Context, UploadInput) (ScanResult, error) {
	c.calls++
	if c.down {
		return ScanResult{}, ErrUnavailable
	}
	return c.scan, c.scanErr
}

func (c *stubClient) Ping(context.Context) error {
	c.calls++
	if c.down {
		return ErrUnavailable
	}
	return c.pingErr
}

func TestFallbackPrefersGoWhenHealthy(t *testing.T) {
	goClient := &stubClient{name: "go", hash: "$argon2id$go"}
	rustClient := &stubClient{name: "rust", hash: "$argon2id$rust"}

	client := NewFallback(goClient, rustClient, nil)
	hash, err := client.HashPassword(context.Background(), "correct horse battery")
	require.NoError(t, err)
	require.Equal(t, "$argon2id$go", hash)
	require.Equal(t, 1, goClient.calls)
	require.Zero(t, rustClient.calls, "the fallback must not be called when Go works")
	require.Equal(t, ServedByGo, client.ServedPath())
	primary, fallback := client.Counts()
	require.Equal(t, int64(1), primary)
	require.Zero(t, fallback)
}

func TestFallbackOnAvailabilityErrors(t *testing.T) {
	cases := map[string]error{
		"err unavailable":  ErrUnavailable,
		"grpc unavailable": status.Error(codes.Unavailable, "down"),
		"grpc deadline":    status.Error(codes.DeadlineExceeded, "slow"),
		"grpc internal":    status.Error(codes.Internal, "boom"),
		"context deadline": context.DeadlineExceeded,
	}

	for name, primaryErr := range cases {
		t.Run(name, func(t *testing.T) {
			goClient := &stubClient{name: "go", hashErr: primaryErr}
			rustClient := &stubClient{name: "rust", hash: "$argon2id$rust"}

			client := NewFallback(goClient, rustClient, nil)
			hash, err := client.HashPassword(context.Background(), "correct horse battery")
			require.NoError(t, err)
			require.Equal(t, "$argon2id$rust", hash)
			require.Equal(t, 1, goClient.calls)
			require.Equal(t, 1, rustClient.calls)
			require.Equal(t, ServedByRust, client.ServedPath())
		})
	}
}

func TestFallbackDoesNotRetryAuthoritativeRejection(t *testing.T) {
	rejection := status.Error(codes.InvalidArgument, "password length is out of range")
	goClient := &stubClient{name: "go", hashErr: rejection}
	rustClient := &stubClient{name: "rust", hash: "$argon2id$rust"}

	client := NewFallback(goClient, rustClient, nil)
	_, err := client.HashPassword(context.Background(), "short")
	require.Error(t, err)
	require.Equal(t, codes.InvalidArgument, status.Code(err),
		"a rejection from a working service is authoritative")
	require.Equal(t, rejection.Error(), "rpc error: code = InvalidArgument desc = password length is out of range")
	require.Equal(t, "password length is out of range", status.Convert(err).Message())
	require.Zero(t, rustClient.calls, "a validation rejection must not be retried")
}

func TestFallbackBothUnavailableIsErrUnavailable(t *testing.T) {
	goClient := &stubClient{name: "go", hashErr: status.Error(codes.Unavailable, "go down")}
	rustClient := &stubClient{name: "rust", hashErr: status.Error(codes.Unavailable, "rust down")}

	client := NewFallback(goClient, rustClient, nil)
	_, err := client.HashPassword(context.Background(), "correct horse battery")
	require.ErrorIs(t, err, ErrUnavailable)
	require.Equal(t, 1, goClient.calls)
	require.Equal(t, 1, rustClient.calls)
}

func TestFallbackRustRejectionIsAuthoritative(t *testing.T) {
	rejection := status.Error(codes.InvalidArgument, "unknown source format")
	goClient := &stubClient{name: "go", sanitizeErr: ErrUnavailable}
	rustClient := &stubClient{name: "rust", sanitizeErr: rejection}

	client := NewFallback(goClient, rustClient, nil)
	_, err := client.SanitizeContent(context.Background(), ContentInput{Format: "excel", Source: "x"})
	require.Error(t, err)
	require.Equal(t, codes.InvalidArgument, status.Code(err))
	require.NotErrorIs(t, err, ErrUnavailable)
}

func TestFallbackRoutesEveryMethod(t *testing.T) {
	goClient := &stubClient{name: "go", down: true}
	rustClient := &stubClient{
		name:      "rust",
		hash:      "$argon2id$rust",
		matches:   true,
		sanitized: Sanitized{HTML: "<p>safe</p>", PolicyVersion: "p1"},
		scan:      ScanResult{Status: ScanClean, ReasonCode: "ok", PolicyVersion: "p1"},
	}
	client := NewFallback(goClient, rustClient, nil)
	ctx := context.Background()

	hash, err := client.HashPassword(ctx, "correct horse battery")
	require.NoError(t, err)
	require.Equal(t, "$argon2id$rust", hash)

	matches, err := client.VerifyPassword(ctx, "correct horse battery", hash)
	require.NoError(t, err)
	require.True(t, matches)

	sanitized, err := client.SanitizeContent(ctx, ContentInput{Format: FormatHTML, Source: "<p>x</p>"})
	require.NoError(t, err)
	require.Equal(t, "<p>safe</p>", sanitized.HTML)

	scan, err := client.InspectUpload(ctx, UploadInput{DeclaredMIME: "image/png"})
	require.NoError(t, err)
	require.Equal(t, ScanClean, scan.Status)

	require.NoError(t, client.Ping(ctx))
}

func TestFallbackPingFallsBack(t *testing.T) {
	goClient := &stubClient{name: "go", pingErr: ErrUnavailable}
	rustClient := &stubClient{name: "rust"}

	client := NewFallback(goClient, rustClient, nil)
	require.NoError(t, client.Ping(context.Background()))
	require.Equal(t, 1, rustClient.calls)
	require.Equal(t, ServedByRust, client.ServedPath())
}

func TestFallbackWithoutRustReturnsGoError(t *testing.T) {
	goClient := &stubClient{name: "go", hashErr: ErrUnavailable}
	client := NewFallback(goClient, nil, nil)

	_, err := client.HashPassword(context.Background(), "correct horse battery")
	require.ErrorIs(t, err, ErrUnavailable)
}

func TestFallbackWithoutGoUsesRust(t *testing.T) {
	rustClient := &stubClient{name: "rust", hash: "$argon2id$rust"}
	client := NewFallback(nil, rustClient, nil)

	hash, err := client.HashPassword(context.Background(), "correct horse battery")
	require.NoError(t, err)
	require.Equal(t, "$argon2id$rust", hash)
	require.Equal(t, ServedByRust, client.ServedPath())
}

func TestFallbackWithoutEitherIsUnavailable(t *testing.T) {
	client := NewFallback(nil, nil, nil)
	_, err := client.HashPassword(context.Background(), "correct horse battery")
	require.ErrorIs(t, err, ErrUnavailable)
}

func TestFallbackLogsServingPath(t *testing.T) {
	var buffer bytes.Buffer
	logger := slog.New(slog.NewTextHandler(&buffer, &slog.HandlerOptions{Level: slog.LevelDebug}))

	goClient := &stubClient{name: "go", hashErr: ErrUnavailable}
	rustClient := &stubClient{name: "rust", hash: "$argon2id$rust"}

	client := NewFallback(goClient, rustClient, logger)
	_, err := client.HashPassword(context.Background(), "correct horse battery")
	require.NoError(t, err)

	logged := buffer.String()
	require.Contains(t, logged, "security go service unavailable; falling back to rust")
	require.Contains(t, logged, "path=rust")
}

func TestIsAvailabilityError(t *testing.T) {
	availability := []error{
		ErrUnavailable,
		status.Error(codes.Unavailable, "down"),
		status.Error(codes.DeadlineExceeded, "slow"),
		status.Error(codes.Internal, "boom"),
		context.DeadlineExceeded,
	}
	for _, err := range availability {
		require.True(t, IsAvailabilityError(err), err)
	}

	authoritative := []error{
		nil,
		status.Error(codes.InvalidArgument, "bad input"),
		status.Error(codes.NotFound, "gone"),
		status.Error(codes.ResourceExhausted, "busy"),
		context.Canceled,
	}
	for _, err := range authoritative {
		require.False(t, IsAvailabilityError(err), err)
	}
}
