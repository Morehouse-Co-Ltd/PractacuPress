package securityclient

import (
	"context"
	"net"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"
	"google.golang.org/grpc/test/bufconn"

	securityv1 "github.com/practacu/practacu-press/packages/contracts/security/v1/gen"
)

// stubSecurity stands in for the Rust service so the client can be exercised without
// spawning a process.
type stubSecurity struct {
	securityv1.UnimplementedSecurityServiceServer
	down bool
}

func (s *stubSecurity) HashPassword(context.Context, *securityv1.HashPasswordRequest) (*securityv1.HashPasswordResponse, error) {
	if s.down {
		return nil, status.Error(codes.Unavailable, "service down")
	}
	return &securityv1.HashPasswordResponse{Encoded: "$argon2id$v=19$stub", PolicyVersion: "p1"}, nil
}

func (s *stubSecurity) VerifyPassword(_ context.Context, req *securityv1.VerifyPasswordRequest) (*securityv1.VerifyPasswordResponse, error) {
	if s.down {
		return nil, status.Error(codes.Unavailable, "service down")
	}
	return &securityv1.VerifyPasswordResponse{Matches: req.Plain == "correct horse battery"}, nil
}

func (s *stubSecurity) SanitizeContent(context.Context, *securityv1.SanitizeContentRequest) (*securityv1.SanitizeContentResponse, error) {
	if s.down {
		return nil, status.Error(codes.Unavailable, "service down")
	}
	return &securityv1.SanitizeContentResponse{
		Html:          "<p>safe</p>",
		PolicyVersion: "p1",
		Violations:    []string{"script"},
	}, nil
}

func (s *stubSecurity) InspectUpload(context.Context, *securityv1.InspectUploadRequest) (*securityv1.InspectUploadResponse, error) {
	if s.down {
		return nil, status.Error(codes.Unavailable, "service down")
	}
	return &securityv1.InspectUploadResponse{
		Status:        securityv1.ScanStatus_SCAN_STATUS_REJECTED,
		ReasonCode:    "magic_mismatch",
		PolicyVersion: "p1",
	}, nil
}

func (s *stubSecurity) ValidateSecurityPolicy(context.Context, *securityv1.ValidateSecurityPolicyRequest) (*securityv1.ValidateSecurityPolicyResponse, error) {
	if s.down {
		return nil, status.Error(codes.Unavailable, "service down")
	}
	return &securityv1.ValidateSecurityPolicyResponse{PolicyVersion: "p1"}, nil
}

// startStub runs the stub server over an in-process listener.
func startStub(t *testing.T, down bool) *GRPC {
	t.Helper()

	listener := bufconn.Listen(1024 * 1024)
	server := grpc.NewServer()
	securityv1.RegisterSecurityServiceServer(server, &stubSecurity{down: down})

	go func() {
		_ = server.Serve(listener)
	}()
	t.Cleanup(server.Stop)

	client, err := Dial(context.Background(), GRPCConfig{
		Addr:    "passthrough:///bufconn",
		Timeout: 2 * time.Second,
		DialOptions: []grpc.DialOption{
			grpc.WithContextDialer(func(ctx context.Context, _ string) (net.Conn, error) {
				return listener.DialContext(ctx)
			}),
			grpc.WithTransportCredentials(insecure.NewCredentials()),
		},
	})
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, client.Close()) })

	return client
}

func TestDialRequiresAddress(t *testing.T) {
	_, err := Dial(context.Background(), GRPCConfig{})
	require.Error(t, err)
}

func TestGRPCRoundTrip(t *testing.T) {
	client := startStub(t, false)
	ctx := context.Background()

	hash, err := client.HashPassword(ctx, "correct horse battery")
	require.NoError(t, err)
	require.Equal(t, "$argon2id$v=19$stub", hash)

	matches, err := client.VerifyPassword(ctx, "correct horse battery", hash)
	require.NoError(t, err)
	require.True(t, matches)

	matches, err = client.VerifyPassword(ctx, "wrong", hash)
	require.NoError(t, err)
	require.False(t, matches)

	sanitized, err := client.SanitizeContent(ctx, ContentInput{
		Format: FormatMarkdown,
		Source: "<script>x</script>",
	})
	require.NoError(t, err)
	require.Equal(t, "<p>safe</p>", sanitized.HTML)
	require.Equal(t, "p1", sanitized.PolicyVersion)
	require.Equal(t, []string{"script"}, sanitized.Violations)

	scan, err := client.InspectUpload(ctx, UploadInput{
		FileName: "a.png", DeclaredMIME: "image/png", Size: 10, Content: []byte("MZ"),
	})
	require.NoError(t, err)
	require.Equal(t, ScanRejected, scan.Status)
	require.Equal(t, "magic_mismatch", scan.ReasonCode)

	require.NoError(t, client.Ping(ctx))
}

// TestTransportFailureIsUnavailable is what makes the caller's fail closed branch
// reachable: a dead service must look like ErrUnavailable, not like a generic error.
func TestTransportFailureIsUnavailable(t *testing.T) {
	client := startStub(t, true)
	ctx := context.Background()

	_, err := client.HashPassword(ctx, "correct horse battery")
	require.ErrorIs(t, err, ErrUnavailable)

	_, err = client.SanitizeContent(ctx, ContentInput{Format: FormatMarkdown, Source: "x"})
	require.ErrorIs(t, err, ErrUnavailable)

	_, err = client.InspectUpload(ctx, UploadInput{FileName: "a.png"})
	require.ErrorIs(t, err, ErrUnavailable)

	require.ErrorIs(t, client.Ping(ctx), ErrUnavailable)
}

func TestMapErrorKeepsApplicationErrors(t *testing.T) {
	appErr := status.Error(codes.InvalidArgument, "bad format")
	require.Equal(t, appErr, mapError(appErr), "a rejected request is not an outage")

	require.ErrorIs(t, mapError(status.Error(codes.Unavailable, "down")), ErrUnavailable)
	require.NoError(t, mapError(nil))
}
