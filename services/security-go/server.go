package securitygo

import (
	"context"
	"os"
	"runtime"
	"strconv"
	"strings"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	securityv1 "github.com/practacu/practacu-press/packages/contracts/security/v1/gen"
)

// Argon2 resource-limit defaults, matching the Rust transport.
//
// Argon2id costs 64 MiB and three iterations per computation, and HashPassword
// / VerifyPassword are reachable without authentication. Running that without a
// bound would let a burst of login attempts pin gigabytes, so every computation
// goes through a process-wide permit and a deadline.
const (
	// Argon2ConcurrencyMin and Argon2ConcurrencyMax bound the override.
	Argon2ConcurrencyMin = 1
	Argon2ConcurrencyMax = 32
	// Argon2ConcurrencyCPUCap caps the CPU-derived default so a large host does
	// not multiply peak memory by its core count.
	Argon2ConcurrencyCPUCap = 4
	// Argon2ConcurrencyFallback is used when the platform cannot report a CPU
	// count.
	Argon2ConcurrencyFallback = 2

	// DefaultArgon2Timeout is the default deadline for one computation.
	DefaultArgon2Timeout = 10 * time.Second
	// MinArgon2Timeout and MaxArgon2Timeout bound the override.
	MinArgon2Timeout = 100 * time.Millisecond
	MaxArgon2Timeout = 60 * time.Second
)

// Limits are the Argon2 resource bounds that are actually in force.
type Limits struct {
	// Concurrency is the maximum number of Argon2 computations running at once.
	Concurrency int
	// Timeout is the deadline applied to a single computation.
	Timeout time.Duration
}

// ResolveLimits reads the environment and returns the effective limits.
//
// SECURITY_ARGON2_CONCURRENCY and SECURITY_ARGON2_TIMEOUT_MS are the same
// variables the Rust service reads, so both implementations can be tuned the
// same way.
func ResolveLimits() Limits {
	return Limits{
		Concurrency: resolveConcurrency(os.Getenv("SECURITY_ARGON2_CONCURRENCY"), runtime.NumCPU()),
		Timeout:     resolveTimeout(os.Getenv("SECURITY_ARGON2_TIMEOUT_MS")),
	}
}

// parseConcurrency parses an explicit concurrency override.
//
// The second result is false for "no usable override": unset, unparsable or
// outside 1..=32.
func parseConcurrency(raw string) (int, bool) {
	value, err := strconv.Atoi(strings.TrimSpace(raw))
	if err != nil {
		return 0, false
	}
	if value < Argon2ConcurrencyMin || value > Argon2ConcurrencyMax {
		return 0, false
	}
	return value, true
}

// fallbackConcurrency derives a limit from a CPU count.
//
// A missing or zero CPU count yields Argon2ConcurrencyFallback; anything else is
// clamped to 1..=4.
func fallbackConcurrency(cpus int) int {
	if cpus <= 0 {
		return Argon2ConcurrencyFallback
	}
	if cpus > Argon2ConcurrencyCPUCap {
		return Argon2ConcurrencyCPUCap
	}
	if cpus < Argon2ConcurrencyMin {
		return Argon2ConcurrencyMin
	}
	return cpus
}

// resolveConcurrency returns the effective concurrency limit.
func resolveConcurrency(raw string, cpus int) int {
	if value, ok := parseConcurrency(raw); ok {
		return value
	}
	return fallbackConcurrency(cpus)
}

// resolveTimeout returns the effective deadline.
func resolveTimeout(raw string) time.Duration {
	milliseconds, err := strconv.ParseUint(strings.TrimSpace(raw), 10, 64)
	if err == nil {
		timeout := time.Duration(milliseconds) * time.Millisecond
		if timeout >= MinArgon2Timeout && timeout <= MaxArgon2Timeout {
			return timeout
		}
	}
	return DefaultArgon2Timeout
}

// ServerConfig configures the gRPC service.
type ServerConfig struct {
	// Limits bounds Argon2 work. The zero value uses ResolveLimits.
	Limits Limits
}

// Server implements securityv1.SecurityServiceServer.
type Server struct {
	securityv1.UnimplementedSecurityServiceServer

	limits Limits
	// permits is the process-wide bound on concurrent Argon2 memory. A permit
	// is held by the goroutine doing the work, not by the request goroutine, so
	// a deadline does not release memory that is still allocated.
	permits chan struct{}
}

// NewServer builds a server with the supplied configuration.
func NewServer(cfg ServerConfig) *Server {
	limits := cfg.Limits
	if limits.Concurrency <= 0 {
		limits.Concurrency = ResolveLimits().Concurrency
	}
	if limits.Timeout <= 0 {
		limits.Timeout = ResolveLimits().Timeout
	}
	return &Server{
		limits:  limits,
		permits: make(chan struct{}, limits.Concurrency),
	}
}

// NewServerFromEnv builds a server from the process environment.
func NewServerFromEnv() *Server {
	return NewServer(ServerConfig{Limits: ResolveLimits()})
}

// Limits reports the limits in force, so the entrypoint can log them.
func (s *Server) Limits() Limits { return s.limits }

// runArgon2 runs one Argon2 computation under the limiter and a deadline.
func (s *Server) runArgon2(ctx context.Context, work func() error) error {
	select {
	case s.permits <- struct{}{}:
	case <-ctx.Done():
		return status.FromContextError(ctx.Err()).Err()
	}

	done := make(chan error, 1)
	go func() {
		defer func() { <-s.permits }()
		defer func() {
			if recovered := recover(); recovered != nil {
				done <- status.Error(codes.Internal, "password hashing task failed")
			}
		}()
		done <- work()
	}()

	timer := time.NewTimer(s.limits.Timeout)
	defer timer.Stop()

	select {
	case err := <-done:
		return err
	case <-timer.C:
		return status.Error(codes.DeadlineExceeded, "password hashing timed out")
	case <-ctx.Done():
		return status.FromContextError(ctx.Err()).Err()
	}
}

// ValidateSecurityPolicy reports the active policy version and limits.
func (s *Server) ValidateSecurityPolicy(
	context.Context,
	*securityv1.ValidateSecurityPolicyRequest,
) (*securityv1.ValidateSecurityPolicyResponse, error) {
	return &securityv1.ValidateSecurityPolicyResponse{
		PolicyVersion:     PolicyVersion,
		MaxSourceChars:    MaxSourceChars,
		MinPasswordLength: MinPasswordLength,
		MaxPasswordLength: MaxPasswordLength,
	}, nil
}

// HashPassword returns a PHC formatted Argon2id hash.
func (s *Server) HashPassword(
	ctx context.Context,
	request *securityv1.HashPasswordRequest,
) (*securityv1.HashPasswordResponse, error) {
	plain := request.GetPlain()

	// Bound the input before a permit is spent: a rejected request must not take
	// hashing capacity away from a legitimate one. The message is the same one
	// HashPassword produces, so the client sees no change.
	if !PlaintextWithinBounds(plain) {
		return nil, status.Error(codes.InvalidArgument, ErrInvalidLength.Error())
	}

	var encoded string
	err := s.runArgon2(ctx, func() error {
		value, hashErr := HashPassword(plain)
		encoded = value
		return hashErr
	})
	if err != nil {
		return nil, mapPasswordError(err)
	}

	return &securityv1.HashPasswordResponse{
		Encoded:       encoded,
		PolicyVersion: PolicyVersion,
	}, nil
}

// VerifyPassword checks a password against a stored hash.
func (s *Server) VerifyPassword(
	ctx context.Context,
	request *securityv1.VerifyPasswordRequest,
) (*securityv1.VerifyPasswordResponse, error) {
	plain := request.GetPlain()
	encoded := request.GetEncoded()

	// Same bounds as hashing, checked before a permit is spent. An out-of-range
	// plaintext cannot match a stored hash, so the answer is a plain mismatch
	// without touching Argon2.
	if !PlaintextWithinBounds(plain) {
		return &securityv1.VerifyPasswordResponse{
			Matches:       false,
			PolicyVersion: PolicyVersion,
		}, nil
	}
	if !EncodedWithinBounds(encoded) {
		return nil, status.Error(codes.InvalidArgument, "password hash is unusable")
	}

	var matches bool
	err := s.runArgon2(ctx, func() error {
		value, verifyErr := VerifyPassword(plain, encoded)
		matches = value
		return verifyErr
	})
	if err != nil {
		// A malformed stored hash is reported with the same message the Rust
		// service uses; transport/deadline failures keep their status.
		if _, ok := status.FromError(err); ok {
			return nil, err
		}
		return nil, status.Error(codes.InvalidArgument, "password hash is unusable")
	}

	return &securityv1.VerifyPasswordResponse{
		Matches:       matches,
		PolicyVersion: PolicyVersion,
	}, nil
}

// SanitizeContent turns source content into allow-listed HTML.
func (s *Server) SanitizeContent(
	_ context.Context,
	request *securityv1.SanitizeContentRequest,
) (*securityv1.SanitizeContentResponse, error) {
	result, err := Sanitize(request.GetFormat(), request.GetSource())
	if err != nil {
		return nil, status.Error(codes.InvalidArgument, err.Error())
	}

	return &securityv1.SanitizeContentResponse{
		Html:          result.HTML,
		PolicyVersion: result.PolicyVersion,
		Violations:    result.Violations,
	}, nil
}

// InspectUpload inspects a stored object before it becomes referenceable.
func (s *Server) InspectUpload(
	_ context.Context,
	request *securityv1.InspectUploadRequest,
) (*securityv1.InspectUploadResponse, error) {
	verdict, err := InspectUpload(
		request.GetDeclaredMime(),
		request.GetSize(),
		request.GetHead(),
	)
	if err != nil {
		return nil, status.Error(codes.InvalidArgument, err.Error())
	}

	return &securityv1.InspectUploadResponse{
		Status:        scanStatusProto(verdict.Decision),
		ReasonCode:    verdict.ReasonCode,
		PolicyVersion: PolicyVersion,
	}, nil
}

// mapPasswordError turns an internal hashing failure into the same gRPC status
// the Rust service returns.
func mapPasswordError(err error) error {
	if err == nil {
		return nil
	}
	if _, ok := status.FromError(err); ok {
		return err
	}
	return status.Error(codes.InvalidArgument, err.Error())
}

// scanStatusProto maps a decision to the wire enum.
func scanStatusProto(decision ScanDecision) securityv1.ScanStatus {
	switch decision {
	case ScanClean:
		return securityv1.ScanStatus_SCAN_STATUS_CLEAN
	case ScanRejected:
		return securityv1.ScanStatus_SCAN_STATUS_REJECTED
	case ScanNeedsManualReview:
		return securityv1.ScanStatus_SCAN_STATUS_NEEDS_MANUAL_REVIEW
	default:
		return securityv1.ScanStatus_SCAN_STATUS_UNSPECIFIED
	}
}
