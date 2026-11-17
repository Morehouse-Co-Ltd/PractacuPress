package plugins

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Manifest integrity tracking (Beta 1.2 contract D).
//
// The package installer records the SHA-256 of the manifest it actually
// unpacked in a sidecar file next to the manifest itself. Loading and enabling
// then compare the manifest on disk with that sidecar:
//
//   - sidecar missing  -> unsigned: the package predates integrity tracking (or
//     was placed on disk by hand). It may still run, but the management page
//     says so instead of implying a guarantee that was never recorded.
//   - hash equal       -> verified: the manifest is bit for bit the one that was
//     installed.
//   - hash different   -> mismatch: the manifest changed after install. The host
//     refuses to enable the package; an extension that swaps its own manifest
//     after review is exactly the attack this check exists for.
//
// The sidecar filename is deliberately human readable and versioned so an
// operator can inspect or delete it by hand. Deleting it downgrades the package
// to "unsigned"; it cannot be used to forge "verified" without knowing the
// installer's write path.
const (
	// ManifestSidecarName is the integrity sidecar written inside a package
	// directory, next to ManifestFileName.
	ManifestSidecarName = "manifest.sha256.json"
	// ManifestSidecarVersion is the only sidecar document version understood.
	ManifestSidecarVersion = 1
	// ManifestHashAlgorithm is the only digest algorithm used.
	ManifestHashAlgorithm = "sha256"
)

// IntegrityState is the trust state the API reports for a package.
type IntegrityState string

// The three documented integrity states.
const (
	// IntegrityVerified means the manifest matches the hash recorded at install.
	IntegrityVerified IntegrityState = "verified"
	// IntegrityUnsigned means no hash was ever recorded for this package.
	IntegrityUnsigned IntegrityState = "unsigned"
	// IntegrityMismatch means the manifest changed after install.
	IntegrityMismatch IntegrityState = "mismatch"
)

// ErrIntegrityMismatch is returned when a package must not be enabled because
// its manifest no longer matches the recorded hash. Callers map it to a client
// error instead of a server failure: the package, not the server, is wrong.
var ErrIntegrityMismatch = errors.New("plugins: manifest integrity mismatch")

// ErrSidecarMissing means the package has no integrity sidecar. It is not a
// failure: it is the "unsigned" state.
var ErrSidecarMissing = errors.New("plugins: manifest integrity sidecar is missing")

// ManifestSidecar is the on-disk integrity record.
//
// VerifiedAt is when the digest was recorded (the install time), which is what
// lets the management page say "verified since ..." without a database column.
type ManifestSidecar struct {
	Version    int       `json:"version"`
	Algorithm  string    `json:"algorithm"`
	Manifest   string    `json:"manifest"`
	SHA256     string    `json:"sha256"`
	VerifiedAt time.Time `json:"verified_at"`
}

// ManifestVerification is the outcome of checking one package directory.
type ManifestVerification struct {
	// SHA256 is the digest of the manifest currently on disk, always populated.
	SHA256 string
	// RecordedSHA256 is the digest the sidecar recorded at install time. It is
	// empty for an unsigned package (nothing was ever recorded) and for a sidecar
	// that cannot be parsed. It is the value the API reports as manifest_hash,
	// because "installed with" is the recorded one, not the modified one.
	RecordedSHA256 string
	// Integrity is verified, unsigned or mismatch.
	Integrity IntegrityState
	// VerifiedAt is the digest's recording time, zero for unsigned or unreadable
	// sidecars.
	VerifiedAt time.Time
	// Reason explains a mismatch in operator terms; empty otherwise.
	Reason string
}

// ManifestHash returns the hex SHA-256 of the raw manifest bytes on disk.
//
// It hashes the file exactly as stored: re-encoding the decoded manifest would
// normalise whitespace and ordering away and stop the check from detecting the
// edit it exists to detect.
func ManifestHash(dir string) (string, error) {
	raw, err := os.ReadFile(filepath.Join(dir, ManifestFileName))
	if err != nil {
		return "", fmt.Errorf("plugins: read manifest for hashing: %w", err)
	}
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:]), nil
}

// VerifyManifest checks a package directory against its recorded sidecar.
//
// A missing manifest is an error (the package is not installed). A missing or
// malformed sidecar is reported as a state, never as an error, so the caller can
// show "unsigned"/"mismatch" instead of a filesystem error.
func VerifyManifest(dir string) (ManifestVerification, error) {
	hash, err := ManifestHash(dir)
	if err != nil {
		return ManifestVerification{}, err
	}
	verification := ManifestVerification{SHA256: hash, Integrity: IntegrityUnsigned}

	sidecar, err := ReadManifestSidecar(dir)
	if errors.Is(err, ErrSidecarMissing) {
		return verification, nil
	}
	if err != nil {
		verification.Integrity = IntegrityMismatch
		verification.Reason = err.Error()
		return verification, nil
	}

	verification.VerifiedAt = sidecar.VerifiedAt.UTC()
	verification.RecordedSHA256 = sidecar.SHA256
	switch {
	case sidecar.Algorithm != ManifestHashAlgorithm:
		verification.Integrity = IntegrityMismatch
		verification.Reason = fmt.Sprintf("unsupported digest algorithm %q", sidecar.Algorithm)
	case sidecar.Manifest != ManifestFileName:
		verification.Integrity = IntegrityMismatch
		verification.Reason = fmt.Sprintf("sidecar names %q instead of %q", sidecar.Manifest, ManifestFileName)
	case !strings.EqualFold(sidecar.SHA256, hash):
		verification.Integrity = IntegrityMismatch
		verification.Reason = "the manifest hash does not match the recorded hash"
	default:
		verification.Integrity = IntegrityVerified
	}
	return verification, nil
}

// reportedManifestHash is the digest the API calls manifest_hash: the recorded
// one when a sidecar could be parsed, otherwise the current one (unsigned).
func reportedManifestHash(verification ManifestVerification) string {
	if verification.RecordedSHA256 != "" {
		return verification.RecordedSHA256
	}
	return verification.SHA256
}

// ReadManifestSidecar parses one package's sidecar. A missing file returns
// ErrSidecarMissing so callers can tell unsigned from corrupt.
func ReadManifestSidecar(dir string) (ManifestSidecar, error) {
	raw, err := os.ReadFile(filepath.Join(dir, ManifestSidecarName))
	if errors.Is(err, os.ErrNotExist) {
		return ManifestSidecar{}, ErrSidecarMissing
	}
	if err != nil {
		return ManifestSidecar{}, fmt.Errorf("plugins: read integrity sidecar: %w", err)
	}
	var sidecar ManifestSidecar
	if err := json.Unmarshal(raw, &sidecar); err != nil {
		return ManifestSidecar{}, fmt.Errorf("plugins: integrity sidecar is not valid JSON: %w", err)
	}
	if sidecar.Version != ManifestSidecarVersion {
		return ManifestSidecar{}, fmt.Errorf(
			"plugins: integrity sidecar version %d is not supported", sidecar.Version)
	}
	return sidecar, nil
}

// WriteManifestSidecar records the manifest digest for dir and returns it.
//
// The installer calls this after unpacking and before the package is published,
// so a package that is visible to the host always has a recorded hash. The write
// goes through a temporary file in the same directory: a crash mid-write leaves
// the old sidecar (or none) rather than a truncated JSON document.
func WriteManifestSidecar(dir string, now time.Time) (ManifestSidecar, error) {
	hash, err := ManifestHash(dir)
	if err != nil {
		return ManifestSidecar{}, err
	}
	if now.IsZero() {
		now = time.Now()
	}
	sidecar := ManifestSidecar{
		Version:    ManifestSidecarVersion,
		Algorithm:  ManifestHashAlgorithm,
		Manifest:   ManifestFileName,
		SHA256:     hash,
		VerifiedAt: now.UTC(),
	}
	raw, err := json.MarshalIndent(sidecar, "", "  ")
	if err != nil {
		return ManifestSidecar{}, fmt.Errorf("plugins: encode integrity sidecar: %w", err)
	}
	raw = append(raw, '\n')

	temp, err := os.CreateTemp(dir, ".manifest.sha256-*.tmp")
	if err != nil {
		return ManifestSidecar{}, fmt.Errorf("plugins: create integrity sidecar: %w", err)
	}
	tempName := temp.Name()
	if _, err := temp.Write(raw); err != nil {
		_ = temp.Close()
		_ = os.Remove(tempName)
		return ManifestSidecar{}, fmt.Errorf("plugins: write integrity sidecar: %w", err)
	}
	if err := temp.Close(); err != nil {
		_ = os.Remove(tempName)
		return ManifestSidecar{}, fmt.Errorf("plugins: close integrity sidecar: %w", err)
	}
	if err := os.Rename(tempName, filepath.Join(dir, ManifestSidecarName)); err != nil {
		_ = os.Remove(tempName)
		return ManifestSidecar{}, fmt.Errorf("plugins: publish integrity sidecar: %w", err)
	}
	return sidecar, nil
}
