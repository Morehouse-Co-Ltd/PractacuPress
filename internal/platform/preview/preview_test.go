package preview

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// fixedClock returns a controllable clock for the expiry tests.
type fixedClock struct{ at time.Time }

func (c *fixedClock) now() time.Time { return c.at }

func newTestSigner(t *testing.T, clock *fixedClock) *Signer {
	t.Helper()
	signer, err := New(Options{
		Key: []byte("0123456789abcdef0123456789abcdef"),
		Now: clock.now,
	})
	require.NoError(t, err)
	return signer
}

func TestIssueAndVerifyRoundTrip(t *testing.T) {
	clock := &fixedClock{at: time.Date(2026, 11, 17, 10, 0, 0, 0, time.UTC)}
	signer := newTestSigner(t, clock)

	token, expiresAt, err := signer.Issue("content-1", 30*time.Minute)
	require.NoError(t, err)
	require.True(t, expiresAt.Equal(clock.at.Add(30*time.Minute)))

	contentID, ok := signer.Verify(token)
	require.True(t, ok)
	require.Equal(t, "content-1", contentID)

	// A token is not a wildcard: verify reports the id it was minted for, and the
	// caller must compare it with the item being read.
	other, ok := signer.Verify(token)
	require.True(t, ok)
	require.NotEqual(t, "content-2", other)
}

func TestVerifyRejectsExpiredToken(t *testing.T) {
	clock := &fixedClock{at: time.Date(2026, 11, 17, 10, 0, 0, 0, time.UTC)}
	signer := newTestSigner(t, clock)

	token, expiresAt, err := signer.Issue("content-1", time.Minute)
	require.NoError(t, err)
	_, ok := signer.Verify(token)
	require.True(t, ok)

	// Just after the expiry instant the link stops working.
	clock.at = expiresAt.Add(time.Second)
	_, ok = signer.Verify(token)
	require.False(t, ok)
}

func TestVerifyRejectsTamperedToken(t *testing.T) {
	clock := &fixedClock{at: time.Date(2026, 11, 17, 10, 0, 0, 0, time.UTC)}
	signer := newTestSigner(t, clock)

	token, _, err := signer.Issue("content-1", time.Minute)
	require.NoError(t, err)

	// Swap the content id while keeping the signature: the MAC no longer matches.
	parts := []byte(token)
	tampered := make([]byte, len(parts))
	copy(tampered, parts)
	for i := range tampered {
		if tampered[i] == '1' {
			tampered[i] = '2'
			break
		}
	}
	_, ok := signer.Verify(string(tampered))
	require.False(t, ok)

	// Truncated and random strings are rejected without panicking.
	for _, bad := range []string{"", "v1", "v1.content-1", "v1.content-1.123", "v2.content-1.9999999999.abc"} {
		_, ok := signer.Verify(bad)
		require.False(t, ok, "token %q must be rejected", bad)
	}
}

func TestVerifyRejectsTokenSignedWithAnotherKey(t *testing.T) {
	clock := &fixedClock{at: time.Date(2026, 11, 17, 10, 0, 0, 0, time.UTC)}
	signer := newTestSigner(t, clock)

	other, err := New(Options{
		Key: []byte("fedcba9876543210fedcba9876543210"),
		Now: clock.now,
	})
	require.NoError(t, err)

	token, _, err := other.Issue("content-1", time.Minute)
	require.NoError(t, err)

	_, ok := signer.Verify(token)
	require.False(t, ok, "a token signed by another installation must not verify")
}

func TestOpenPersistsKeyAcrossRestarts(t *testing.T) {
	dataDir := t.TempDir()
	clock := &fixedClock{at: time.Date(2026, 11, 17, 10, 0, 0, 0, time.UTC)}

	first, err := Open(dataDir)
	require.NoError(t, err)
	first.now = clock.now
	token, _, err := first.Issue("content-1", time.Minute)
	require.NoError(t, err)

	keyPath := filepath.Join(dataDir, KeyFileName)
	require.FileExists(t, keyPath)

	// A second start reads the same key, so a link handed out before a restart keeps
	// working.
	second, err := Open(dataDir)
	require.NoError(t, err)
	second.now = clock.now
	contentID, ok := second.Verify(token)
	require.True(t, ok)
	require.Equal(t, "content-1", contentID)

	if runtime.GOOS != "windows" {
		info, statErr := os.Stat(keyPath)
		require.NoError(t, statErr)
		require.Equal(t, os.FileMode(0o600), info.Mode().Perm())
	}
}

func TestOpenRequiresDataDir(t *testing.T) {
	_, err := Open("")
	require.Error(t, err)
	_, err = Open("   ")
	require.Error(t, err)
}

func TestNewRejectsShortKey(t *testing.T) {
	_, err := New(Options{Key: []byte("short")})
	require.ErrorIs(t, err, ErrInvalidKey)
}

func TestIssueDefaultsTTLAndRejectsEmptyContent(t *testing.T) {
	clock := &fixedClock{at: time.Date(2026, 11, 17, 10, 0, 0, 0, time.UTC)}
	signer := newTestSigner(t, clock)

	_, _, err := signer.Issue("", time.Minute)
	require.ErrorIs(t, err, ErrEmptyContent)

	_, expiresAt, err := signer.Issue("content-1", 0)
	require.NoError(t, err)
	require.True(t, expiresAt.Equal(clock.at.Add(DefaultTTL)))
}

func TestCorruptKeyFileIsNotSilentlyReplaced(t *testing.T) {
	dataDir := t.TempDir()
	keyPath := filepath.Join(dataDir, KeyFileName)
	require.NoError(t, os.WriteFile(keyPath, []byte("not-base64!"), 0o600))

	_, err := Open(dataDir)
	require.Error(t, err)
}
