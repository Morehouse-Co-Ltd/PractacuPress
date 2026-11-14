package securitygo

import (
	"context"
	"net"
	"strings"
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

// testLimits keep the tests fast while still exercising the real code paths.
var testLimits = Limits{Concurrency: 2, Timeout: 30 * time.Second}

// startTestService runs the gRPC server over an in-process listener.
func startTestService(t *testing.T, limits Limits) securityv1.SecurityServiceClient {
	t.Helper()

	listener := bufconn.Listen(1024 * 1024)
	server := grpc.NewServer()
	securityv1.RegisterSecurityServiceServer(server, NewServer(ServerConfig{Limits: limits}))

	go func() { _ = server.Serve(listener) }()
	t.Cleanup(server.Stop)

	conn, err := grpc.NewClient(
		"passthrough:///bufconn",
		grpc.WithContextDialer(func(ctx context.Context, _ string) (net.Conn, error) {
			return listener.DialContext(ctx)
		}),
		grpc.WithTransportCredentials(insecure.NewCredentials()),
	)
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, conn.Close()) })

	return securityv1.NewSecurityServiceClient(conn)
}

func TestServiceValidateSecurityPolicy(t *testing.T) {
	client := startTestService(t, testLimits)

	response, err := client.ValidateSecurityPolicy(context.Background(), &securityv1.ValidateSecurityPolicyRequest{})
	require.NoError(t, err)
	require.Equal(t, PolicyVersion, response.GetPolicyVersion())
	require.Equal(t, uint32(MaxSourceChars), response.GetMaxSourceChars())
	require.Equal(t, uint32(MinPasswordLength), response.GetMinPasswordLength())
	require.Equal(t, uint32(MaxPasswordLength), response.GetMaxPasswordLength())
}

func TestServicePasswordRoundTrip(t *testing.T) {
	client := startTestService(t, testLimits)
	ctx := context.Background()

	hashed, err := client.HashPassword(ctx, &securityv1.HashPasswordRequest{Plain: "correct horse battery"})
	require.NoError(t, err)
	require.True(t, strings.HasPrefix(hashed.GetEncoded(), "$argon2id$v=19$m=65536,t=3,p=2$"))
	require.Equal(t, PolicyVersion, hashed.GetPolicyVersion())

	verified, err := client.VerifyPassword(ctx, &securityv1.VerifyPasswordRequest{
		Plain:   "correct horse battery",
		Encoded: hashed.GetEncoded(),
	})
	require.NoError(t, err)
	require.True(t, verified.GetMatches())

	verified, err = client.VerifyPassword(ctx, &securityv1.VerifyPasswordRequest{
		Plain:   "wrong password",
		Encoded: hashed.GetEncoded(),
	})
	require.NoError(t, err)
	require.False(t, verified.GetMatches())
}

func TestServiceHashPasswordRejectsShortPlaintext(t *testing.T) {
	client := startTestService(t, testLimits)

	_, err := client.HashPassword(context.Background(), &securityv1.HashPasswordRequest{Plain: "short"})
	require.Error(t, err)
	require.Equal(t, codes.InvalidArgument, status.Code(err))
	require.Contains(t, status.Convert(err).Message(), "password length is out of range")
}

func TestServiceVerifyPasswordShortPlaintextIsMismatch(t *testing.T) {
	client := startTestService(t, testLimits)
	ctx := context.Background()

	hashed, err := client.HashPassword(ctx, &securityv1.HashPasswordRequest{Plain: "correct horse battery"})
	require.NoError(t, err)

	verified, err := client.VerifyPassword(ctx, &securityv1.VerifyPasswordRequest{
		Plain:   "short",
		Encoded: hashed.GetEncoded(),
	})
	require.NoError(t, err, "an out-of-range plaintext is a mismatch, not an error")
	require.False(t, verified.GetMatches())
}

func TestServiceVerifyPasswordRejectsUnusableEncoded(t *testing.T) {
	client := startTestService(t, testLimits)
	ctx := context.Background()

	_, err := client.VerifyPassword(ctx, &securityv1.VerifyPasswordRequest{
		Plain:   "correct horse battery",
		Encoded: "not-a-phc-string",
	})
	require.Error(t, err)
	require.Equal(t, codes.InvalidArgument, status.Code(err))
	require.Contains(t, status.Convert(err).Message(), "password hash is unusable")

	_, err = client.VerifyPassword(ctx, &securityv1.VerifyPasswordRequest{
		Plain:   "correct horse battery",
		Encoded: "   ",
	})
	require.Error(t, err)
	require.Equal(t, codes.InvalidArgument, status.Code(err))
}

func TestServiceSanitizeContent(t *testing.T) {
	client := startTestService(t, testLimits)
	ctx := context.Background()

	response, err := client.SanitizeContent(ctx, &securityv1.SanitizeContentRequest{
		Format: "html",
		Source: `<p class="pp-note btn">hi</p><script>alert(1)</script>`,
	})
	require.NoError(t, err)
	require.Equal(t, `<p class="pp-note">hi</p>`, response.GetHtml())
	require.Equal(t, PolicyVersion, response.GetPolicyVersion())
	require.Equal(t, []string{"script"}, response.GetViolations())
}

func TestServiceSanitizeContentRejectsUnknownFormatAndOversize(t *testing.T) {
	client := startTestService(t, testLimits)
	ctx := context.Background()

	_, err := client.SanitizeContent(ctx, &securityv1.SanitizeContentRequest{Format: "excel", Source: "x"})
	require.Error(t, err)
	require.Equal(t, codes.InvalidArgument, status.Code(err))
	require.Contains(t, status.Convert(err).Message(), "unknown source format")

	_, err = client.SanitizeContent(ctx, &securityv1.SanitizeContentRequest{
		Format: "plain",
		Source: strings.Repeat("a", MaxSourceChars+1),
	})
	require.Error(t, err)
	require.Equal(t, codes.InvalidArgument, status.Code(err))
	require.Contains(t, status.Convert(err).Message(), "maximum allowed size")
}

func TestServiceInspectUploadVerdicts(t *testing.T) {
	client := startTestService(t, testLimits)
	ctx := context.Background()

	cases := []struct {
		name       string
		request    *securityv1.InspectUploadRequest
		wantStatus securityv1.ScanStatus
		wantReason string
	}{
		{
			name: "clean png",
			request: &securityv1.InspectUploadRequest{
				FileName: "a.png", DeclaredMime: "image/png", Size: 1024,
				StorageKey: "k", Head: pngMagic,
			},
			wantStatus: securityv1.ScanStatus_SCAN_STATUS_CLEAN,
			wantReason: "ok",
		},
		{
			name: "rejected mismatch",
			request: &securityv1.InspectUploadRequest{
				FileName: "a.png", DeclaredMime: "image/png", Size: 1024, Head: []byte("MZ"),
			},
			wantStatus: securityv1.ScanStatus_SCAN_STATUS_REJECTED,
			wantReason: "truncated_sample",
		},
		{
			name: "needs manual review",
			request: &securityv1.InspectUploadRequest{
				FileName: "a.png", DeclaredMime: "image/png", Size: 1024,
			},
			wantStatus: securityv1.ScanStatus_SCAN_STATUS_NEEDS_MANUAL_REVIEW,
			wantReason: "no_content_sample",
		},
		{
			name: "disallowed mime",
			request: &securityv1.InspectUploadRequest{
				DeclaredMime: "text/html", Size: 10, Head: []byte("<html>"),
			},
			wantStatus: securityv1.ScanStatus_SCAN_STATUS_REJECTED,
			wantReason: "mime_not_allowed",
		},
	}

	for _, tc := range cases {
		response, err := client.InspectUpload(ctx, tc.request)
		require.NoError(t, err, tc.name)
		require.Equal(t, tc.wantStatus, response.GetStatus(), tc.name)
		require.Equal(t, tc.wantReason, response.GetReasonCode(), tc.name)
		require.Equal(t, PolicyVersion, response.GetPolicyVersion(), tc.name)
	}
}

func TestConcurrencyOverrideParsing(t *testing.T) {
	cases := []struct {
		raw  string
		want int
		ok   bool
	}{
		{"1", 1, true},
		{"32", 32, true},
		{"  8  ", 8, true},
		{"0", 0, false},
		{"999", 0, false},
		{"abc", 0, false},
		{"", 0, false},
		{"-4", 0, false},
	}
	for _, tc := range cases {
		got, ok := parseConcurrency(tc.raw)
		require.Equal(t, tc.ok, ok, tc.raw)
		require.Equal(t, tc.want, got, tc.raw)
	}
}

func TestCPUFallbackIsClampedAndNeverZero(t *testing.T) {
	require.Equal(t, Argon2ConcurrencyFallback, fallbackConcurrency(0))
	require.Equal(t, Argon2ConcurrencyFallback, fallbackConcurrency(-2))
	require.Equal(t, 1, fallbackConcurrency(1))
	require.Equal(t, 3, fallbackConcurrency(3))
	require.Equal(t, 4, fallbackConcurrency(4))
	require.Equal(t, Argon2ConcurrencyCPUCap, fallbackConcurrency(64))
}

func TestResolveConcurrency(t *testing.T) {
	require.Equal(t, 8, resolveConcurrency("8", 2))
	require.Equal(t, 2, resolveConcurrency("", 2))
	require.Equal(t, 4, resolveConcurrency("999", 64))
}

func TestTimeoutDefaultsAndBounds(t *testing.T) {
	require.Equal(t, DefaultArgon2Timeout, resolveTimeout(""))
	require.Equal(t, DefaultArgon2Timeout, resolveTimeout("99"))
	require.Equal(t, MinArgon2Timeout, resolveTimeout("100"))
	require.Equal(t, MaxArgon2Timeout, resolveTimeout("60000"))
	require.Equal(t, DefaultArgon2Timeout, resolveTimeout("60001"))
	require.Equal(t, DefaultArgon2Timeout, resolveTimeout("nope"))
	require.Equal(t, DefaultArgon2Timeout, resolveTimeout("-1"))
}

func TestNewServerFillsZeroConfig(t *testing.T) {
	server := NewServer(ServerConfig{})
	require.GreaterOrEqual(t, server.Limits().Concurrency, 1)
	require.LessOrEqual(t, server.Limits().Concurrency, Argon2ConcurrencyMax)
	require.GreaterOrEqual(t, server.Limits().Timeout, MinArgon2Timeout)
	require.LessOrEqual(t, server.Limits().Timeout, MaxArgon2Timeout)
}

func TestRunArgon2RunsTheWork(t *testing.T) {
	server := NewServer(ServerConfig{Limits: Limits{Concurrency: 1, Timeout: time.Second}})

	var ran bool
	require.NoError(t, server.runArgon2(context.Background(), func() error {
		ran = true
		return nil
	}))
	require.True(t, ran)
}

func TestRunArgon2Deadline(t *testing.T) {
	server := NewServer(ServerConfig{Limits: Limits{Concurrency: 1, Timeout: MinArgon2Timeout}})

	err := server.runArgon2(context.Background(), func() error {
		time.Sleep(3 * MinArgon2Timeout)
		return nil
	})
	require.Error(t, err)
	require.Equal(t, codes.DeadlineExceeded, status.Code(err))
}

func TestRunArgon2RecoversPanics(t *testing.T) {
	server := NewServer(ServerConfig{Limits: Limits{Concurrency: 1, Timeout: time.Second}})

	err := server.runArgon2(context.Background(), func() error {
		panic("simulated blocking task failure")
	})
	require.Error(t, err)
	require.Equal(t, codes.Internal, status.Code(err))
}

func TestRunArgon2HonoursCancelledContext(t *testing.T) {
	server := NewServer(ServerConfig{Limits: Limits{Concurrency: 1, Timeout: time.Minute}})

	// Saturate the single permit so the next call has to wait for it.
	block := make(chan struct{})
	started := make(chan struct{})
	go func() {
		_ = server.runArgon2(context.Background(), func() error {
			close(started)
			<-block
			return nil
		})
	}()
	<-started
	defer close(block)

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	err := server.runArgon2(ctx, func() error { return nil })
	require.Error(t, err)
	require.Equal(t, codes.Canceled, status.Code(err))
}

func TestScanStatusProtoMapping(t *testing.T) {
	require.Equal(t, securityv1.ScanStatus_SCAN_STATUS_CLEAN, scanStatusProto(ScanClean))
	require.Equal(t, securityv1.ScanStatus_SCAN_STATUS_REJECTED, scanStatusProto(ScanRejected))
	require.Equal(t, securityv1.ScanStatus_SCAN_STATUS_NEEDS_MANUAL_REVIEW, scanStatusProto(ScanNeedsManualReview))
	require.Equal(t, securityv1.ScanStatus_SCAN_STATUS_UNSPECIFIED, scanStatusProto(ScanDecision(0)))
}
