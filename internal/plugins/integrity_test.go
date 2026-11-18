package plugins

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// integrityManifest is a valid package without server or browser halves: enough
// shape to load, cheap enough to build in a unit test.
const integrityManifest = `{
  "manifest_version": 1,
  "id": "com.example.integrity",
  "name": "Integrity fixture",
  "version": "1.0.0",
  "engines": {"pp": ">=0.1.0 <1.0.0"},
  "runtime": "none"
}`

// frontendIntegrityManifest adds the browser half so PublicPlugins reports it.
const frontendIntegrityManifest = `{
  "manifest_version": 1,
  "id": "com.example.integrity",
  "name": "Integrity fixture",
  "version": "1.0.0",
  "engines": {"pp": ">=0.1.0 <1.0.0"},
  "runtime": "none",
  "frontend": {"entry": "frontend/client.js", "slots": ["article.after"]},
  "permissions": ["ui.inject"]
}`

// writePackage materialises one package directory.
func writePackage(t *testing.T, manifest string) string {
	t.Helper()
	dir := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(dir, ManifestFileName), []byte(manifest), 0o644))
	if strings.Contains(manifest, "frontend") {
		require.NoError(t, os.MkdirAll(filepath.Join(dir, "frontend"), 0o755))
		require.NoError(t, os.WriteFile(
			filepath.Join(dir, "frontend", "client.js"),
			[]byte("window.__PP_PLUGIN_REGISTER__()"), 0o644))
	}
	return dir
}

// TestVerifyManifestStates covers the three contract states on disk.
func TestVerifyManifestStates(t *testing.T) {
	t.Run("unsigned without a sidecar", func(t *testing.T) {
		dir := writePackage(t, integrityManifest)
		verification, err := VerifyManifest(dir)
		require.NoError(t, err)
		require.Equal(t, IntegrityUnsigned, verification.Integrity)
		require.Len(t, verification.SHA256, 64)
		require.True(t, verification.VerifiedAt.IsZero())
		require.Empty(t, verification.Reason)
	})

	t.Run("verified after recording the digest", func(t *testing.T) {
		dir := writePackage(t, integrityManifest)
		recordedAt := time.Date(2026, 11, 17, 9, 0, 0, 0, time.UTC)
		sidecar, err := WriteManifestSidecar(dir, recordedAt)
		require.NoError(t, err)
		require.Equal(t, ManifestSidecarName, filepath.Base(filepath.Join(dir, ManifestSidecarName)))
		require.FileExists(t, filepath.Join(dir, ManifestSidecarName))

		verification, err := VerifyManifest(dir)
		require.NoError(t, err)
		require.Equal(t, IntegrityVerified, verification.Integrity)
		require.Equal(t, sidecar.SHA256, verification.SHA256)
		require.True(t, recordedAt.Equal(verification.VerifiedAt))
	})

	t.Run("mismatch after the manifest changed", func(t *testing.T) {
		dir := writePackage(t, integrityManifest)
		_, err := WriteManifestSidecar(dir, time.Now())
		require.NoError(t, err)

		// Whitespace is a change: the digest is over the raw bytes.
		require.NoError(t, os.WriteFile(
			filepath.Join(dir, ManifestFileName), []byte(integrityManifest+"\n"), 0o644))
		verification, err := VerifyManifest(dir)
		require.NoError(t, err)
		require.Equal(t, IntegrityMismatch, verification.Integrity)
		require.NotEmpty(t, verification.Reason)
	})

	t.Run("corrupt sidecar is a mismatch", func(t *testing.T) {
		dir := writePackage(t, integrityManifest)
		require.NoError(t, os.WriteFile(
			filepath.Join(dir, ManifestSidecarName), []byte("{not json"), 0o644))
		verification, err := VerifyManifest(dir)
		require.NoError(t, err)
		require.Equal(t, IntegrityMismatch, verification.Integrity)
	})

	t.Run("missing manifest is an error", func(t *testing.T) {
		_, err := VerifyManifest(t.TempDir())
		require.Error(t, err)
	})
}

// TestInstallRecordsTheDigest keeps the Status and the boot record in sync.
func TestInstallRecordsTheDigest(t *testing.T) {
	dir := writePackage(t, frontendIntegrityManifest)
	_, err := WriteManifestSidecar(dir, time.Now())
	require.NoError(t, err)

	host, err := New(Options{})
	require.NoError(t, err)
	defer host.Close()

	status, err := host.Install(dir)
	require.NoError(t, err)
	require.Equal(t, IntegrityVerified, status.Integrity)
	require.Len(t, status.ManifestHash, 64)
	require.False(t, status.VerifiedAt.IsZero())

	_, err = host.Enable(status.ID)
	require.NoError(t, err)

	public := host.PublicPlugins()
	require.Len(t, public, 1)
	// This field existed on PublicPlugin but was never assigned before Beta 1.2.
	require.Equal(t, status.ManifestHash, public[0].ManifestHash)
}

// TestEnableRefusesAModifiedManifest is the security property: a package that
// edits its own manifest after install can never be enabled.
func TestEnableRefusesAModifiedManifest(t *testing.T) {
	dir := writePackage(t, frontendIntegrityManifest)
	_, err := WriteManifestSidecar(dir, time.Now())
	require.NoError(t, err)

	host, err := New(Options{})
	require.NoError(t, err)
	defer host.Close()

	status, err := host.Install(dir)
	require.NoError(t, err)
	require.Equal(t, IntegrityVerified, status.Integrity)

	// Widen the permissions after the digest was recorded.
	tampered := strings.Replace(
		frontendIntegrityManifest,
		`"permissions": ["ui.inject"]`,
		`"permissions": ["ui.inject", "admin.route"]`,
		1,
	)
	require.NoError(t, os.WriteFile(filepath.Join(dir, ManifestFileName), []byte(tampered), 0o644))

	_, err = host.Enable(status.ID)
	require.ErrorIs(t, err, ErrIntegrityMismatch)

	stored, ok := host.Get(status.ID)
	require.True(t, ok)
	require.Equal(t, StateFailed, stored.State)
	require.Equal(t, IntegrityMismatch, stored.Integrity)
	require.Contains(t, stored.LastError, "integrity mismatch")
	require.Empty(t, host.PublicPlugins(), "a mismatched package must not reach the browser")

	// Disabling and removing stay possible: the operator must be able to recover.
	_, err = host.Disable(status.ID)
	require.NoError(t, err)
	require.NoError(t, host.Remove(status.ID))
}

// TestEnableAllowsUnsignedPackages keeps pre integrity packages running. The
// state is reported, not enforced: only a mismatch is refused.
func TestEnableAllowsUnsignedPackages(t *testing.T) {
	dir := writePackage(t, frontendIntegrityManifest)

	host, err := New(Options{})
	require.NoError(t, err)
	defer host.Close()

	status, err := host.Install(dir)
	require.NoError(t, err)
	require.Equal(t, IntegrityUnsigned, status.Integrity)
	require.Len(t, status.ManifestHash, 64)

	_, err = host.Enable(status.ID)
	require.NoError(t, err)
	require.Len(t, host.PublicPlugins(), 1)
}
