package securityclient

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	securityv1 "github.com/practacu/practacu-press/packages/contracts/security/v1/gen"
)

// DefaultTimeout bounds every call. A hanging security service must not turn a
// publish request into an indefinite wait.
const DefaultTimeout = 3 * time.Second

// GRPCConfig configures a GRPC client.
type GRPCConfig struct {
	// Addr is the security service endpoint, for example "127.0.0.1:9001".
	Addr string
	// Timeout defaults to DefaultTimeout.
	Timeout time.Duration
	// DialOptions are appended for tests, which inject an in-process transport.
	DialOptions []grpc.DialOption
}

// GRPC is the Client backed by the Rust security service.
type GRPC struct {
	conn    *grpc.ClientConn
	client  securityv1.SecurityServiceClient
	timeout time.Duration
}

var _ Client = (*GRPC)(nil)

// Dial connects to the security service.
//
// A plaintext connection is intentional: the service is expected to sit on the same
// private network as the API, and TLS between them is terminated by the deployment.
func Dial(ctx context.Context, cfg GRPCConfig) (*GRPC, error) {
	if strings.TrimSpace(cfg.Addr) == "" {
		return nil, errors.New("securityclient: address is required")
	}

	timeout := cfg.Timeout
	if timeout <= 0 {
		timeout = DefaultTimeout
	}

	options := cfg.DialOptions
	if len(options) == 0 {
		options = []grpc.DialOption{grpc.WithTransportCredentials(insecure.NewCredentials())}
	}

	conn, err := grpc.NewClient(cfg.Addr, options...)
	if err != nil {
		return nil, fmt.Errorf("securityclient: dial %s: %w", cfg.Addr, err)
	}

	return &GRPC{
		conn:    conn,
		client:  securityv1.NewSecurityServiceClient(conn),
		timeout: timeout,
	}, nil
}

// Close releases the connection.
func (g *GRPC) Close() error {
	if g.conn == nil {
		return nil
	}
	return g.conn.Close()
}

// HashPassword returns a PHC formatted Argon2id hash.
func (g *GRPC) HashPassword(ctx context.Context, plain string) (string, error) {
	ctx, cancel := g.callContext(ctx)
	defer cancel()

	response, err := g.client.HashPassword(ctx, &securityv1.HashPasswordRequest{Plain: plain})
	if err != nil {
		return "", mapError(err)
	}
	return response.GetEncoded(), nil
}

// VerifyPassword checks a password against a stored hash.
func (g *GRPC) VerifyPassword(ctx context.Context, plain, encoded string) (bool, error) {
	ctx, cancel := g.callContext(ctx)
	defer cancel()

	response, err := g.client.VerifyPassword(ctx, &securityv1.VerifyPasswordRequest{
		Plain:   plain,
		Encoded: encoded,
	})
	if err != nil {
		return false, mapError(err)
	}
	return response.GetMatches(), nil
}

// SanitizeContent turns source content into allow-listed HTML.
func (g *GRPC) SanitizeContent(ctx context.Context, input ContentInput) (Sanitized, error) {
	ctx, cancel := g.callContext(ctx)
	defer cancel()

	response, err := g.client.SanitizeContent(ctx, &securityv1.SanitizeContentRequest{
		Format: string(input.Format),
		Source: input.Source,
	})
	if err != nil {
		return Sanitized{}, mapError(err)
	}

	return Sanitized{
		HTML:          response.GetHtml(),
		PolicyVersion: response.GetPolicyVersion(),
		Violations:    response.GetViolations(),
	}, nil
}

// InspectUpload inspects a stored object.
func (g *GRPC) InspectUpload(ctx context.Context, input UploadInput) (ScanResult, error) {
	ctx, cancel := g.callContext(ctx)
	defer cancel()

	response, err := g.client.InspectUpload(ctx, &securityv1.InspectUploadRequest{
		FileName:     input.FileName,
		DeclaredMime: input.DeclaredMIME,
		Size:         input.Size,
		StorageKey:   input.StorageKey,
		Head:         input.Content,
	})
	if err != nil {
		return ScanResult{}, mapError(err)
	}

	result := ScanResult{
		Status:        scanStatusFromProto(response.GetStatus()),
		ReasonCode:    response.GetReasonCode(),
		PolicyVersion: response.GetPolicyVersion(),
	}
	// An unspecified verdict is never clean: an unknown answer must not unlock a file.
	if result.Status == "" {
		result.Status = ScanNeedsManualReview
	}
	return result, nil
}

// Ping reports whether the service answers at all.
func (g *GRPC) Ping(ctx context.Context) error {
	ctx, cancel := g.callContext(ctx)
	defer cancel()

	if _, err := g.client.ValidateSecurityPolicy(ctx, &securityv1.ValidateSecurityPolicyRequest{}); err != nil {
		return mapError(err)
	}
	return nil
}

func (g *GRPC) callContext(ctx context.Context) (context.Context, context.CancelFunc) {
	if g.timeout <= 0 {
		return context.WithCancel(ctx)
	}
	return context.WithTimeout(ctx, g.timeout)
}

func scanStatusFromProto(value securityv1.ScanStatus) ScanStatus {
	switch value {
	case securityv1.ScanStatus_SCAN_STATUS_CLEAN:
		return ScanClean
	case securityv1.ScanStatus_SCAN_STATUS_REJECTED:
		return ScanRejected
	case securityv1.ScanStatus_SCAN_STATUS_NEEDS_MANUAL_REVIEW:
		return ScanNeedsManualReview
	default:
		return ""
	}
}

// mapError turns transport failures into ErrUnavailable so callers can apply their
// fail closed policy without inspecting gRPC status codes themselves.
func mapError(err error) error {
	if err == nil {
		return nil
	}
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
		return fmt.Errorf("%w: %w", ErrUnavailable, err)
	}

	switch status.Code(err) {
	case codes.Unavailable, codes.DeadlineExceeded, codes.Canceled:
		return fmt.Errorf("%w: %w", ErrUnavailable, err)
	default:
		return err
	}
}
