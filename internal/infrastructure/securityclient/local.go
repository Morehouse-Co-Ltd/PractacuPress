package securityclient

import (
	"context"
	"errors"
	"fmt"
	"time"

	securitygo "github.com/practacu/practacu-press/internal/security"
)

// Local implements the security contract with the Go security package inside
// the API process.
type Local struct {
	limits  securitygo.Limits
	permits chan struct{}
}

var _ Client = (*Local)(nil)

// NewLocal builds the in-process client using the configured Argon2 limits.
func NewLocal() *Local {
	limits := securitygo.ResolveLimits()
	return &Local{
		limits:  limits,
		permits: make(chan struct{}, limits.Concurrency),
	}
}

// Limits reports the Argon2 bounds in force.
func (l *Local) Limits() securitygo.Limits { return l.limits }

// HashPassword returns a PHC formatted Argon2id hash.
func (l *Local) HashPassword(ctx context.Context, plain string) (string, error) {
	var encoded string
	err := l.runArgon2(ctx, func() error {
		var hashErr error
		encoded, hashErr = securitygo.HashPassword(plain)
		return hashErr
	})
	if err != nil {
		return "", mapLocalError(err)
	}
	return encoded, nil
}

// VerifyPassword checks a password against a stored PHC hash.
func (l *Local) VerifyPassword(ctx context.Context, plain, encoded string) (bool, error) {
	var matches bool
	err := l.runArgon2(ctx, func() error {
		var verifyErr error
		matches, verifyErr = securitygo.VerifyPassword(plain, encoded)
		return verifyErr
	})
	if err != nil {
		return false, mapLocalError(err)
	}
	return matches, nil
}

// SanitizeContent applies the allow-list HTML policy in-process.
func (l *Local) SanitizeContent(_ context.Context, input ContentInput) (Sanitized, error) {
	result, err := securitygo.Sanitize(string(input.Format), input.Source)
	if err != nil {
		return Sanitized{}, err
	}
	return Sanitized{
		HTML:          result.HTML,
		PolicyVersion: result.PolicyVersion,
		Violations:    result.Violations,
	}, nil
}

// InspectUpload applies the upload policy in-process.
func (l *Local) InspectUpload(_ context.Context, input UploadInput) (ScanResult, error) {
	verdict, err := securitygo.InspectUpload(input.DeclaredMIME, input.Size, input.Content)
	if err != nil {
		return ScanResult{}, err
	}
	status := ScanNeedsManualReview
	switch verdict.Decision {
	case securitygo.ScanClean:
		status = ScanClean
	case securitygo.ScanRejected:
		status = ScanRejected
	case securitygo.ScanNeedsManualReview:
		status = ScanNeedsManualReview
	}
	return ScanResult{
		Status:        status,
		ReasonCode:    verdict.ReasonCode,
		PolicyVersion: securitygo.PolicyVersion,
	}, nil
}

// Ping always succeeds: the implementation is a compiled-in function, not a
// remote dependency.
func (*Local) Ping(context.Context) error { return nil }

// runArgon2 bounds concurrent Argon2 memory and enforces the configured deadline.
func (l *Local) runArgon2(ctx context.Context, work func() error) error {
	if l.limits.Concurrency <= 0 {
		l.limits.Concurrency = 1
	}
	if l.limits.Timeout <= 0 {
		l.limits.Timeout = securitygo.DefaultArgon2Timeout
	}

	select {
	case l.permits <- struct{}{}:
	case <-ctx.Done():
		return ctx.Err()
	}

	done := make(chan error, 1)
	go func() {
		defer func() { <-l.permits }()
		defer func() {
			if recovered := recover(); recovered != nil {
				done <- fmt.Errorf("security: password hashing task failed")
			}
		}()
		done <- work()
	}()

	timer := time.NewTimer(l.limits.Timeout)
	defer timer.Stop()
	select {
	case err := <-done:
		return err
	case <-timer.C:
		return fmt.Errorf("%w: password hashing timed out", ErrUnavailable)
	case <-ctx.Done():
		return ctx.Err()
	}
}

func mapLocalError(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
		return fmt.Errorf("%w: %w", ErrUnavailable, err)
	}
	return err
}
