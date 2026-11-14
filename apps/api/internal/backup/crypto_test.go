package backup

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/apps/api/internal/infrastructure/db"
	"github.com/practacu/practacu-press/apps/api/internal/site"
)

// testEncryptionKey returns a random 32-byte AES-256 key.
func testEncryptionKey(t *testing.T) []byte {
	t.Helper()
	key := make([]byte, EncryptionKeySize)
	_, err := rand.Read(key)
	require.NoError(t, err)
	return key
}

// testEncrypt seals plaintext as a complete PPBAK1 package.
func testEncrypt(t *testing.T, key, plaintext []byte) []byte {
	t.Helper()
	var buffer bytes.Buffer
	writer, err := EncryptWriter(&buffer, key)
	require.NoError(t, err)
	_, err = writer.Write(plaintext)
	require.NoError(t, err)
	require.NoError(t, writer.Close())
	return buffer.Bytes()
}

// testDecrypt opens a PPBAK1 package and returns the plaintext, if any.
func testDecrypt(t *testing.T, key, ciphertext []byte) ([]byte, error) {
	t.Helper()
	reader, err := NewDecryptingReader(bytes.NewReader(ciphertext), key)
	if err != nil {
		return nil, err
	}
	return io.ReadAll(reader)
}

// testRandomBytes returns n incompressible bytes, so a zip round trip really
// spans multiple 1 MiB encryption chunks instead of deflating to nothing.
func testRandomBytes(t *testing.T, n int) []byte {
	t.Helper()
	out := make([]byte, n)
	_, err := rand.Read(out)
	require.NoError(t, err)
	return out
}

func TestEncryptWriterChunkFraming(t *testing.T) {
	key := testEncryptionKey(t)
	cases := []struct {
		name string
		size int
	}{
		{name: "empty", size: 0},
		{name: "one-byte", size: 1},
		{name: "below-chunk", size: EncryptionChunkSize - 1},
		{name: "exact-chunk", size: EncryptionChunkSize},
		{name: "just-over-chunk", size: EncryptionChunkSize + 1},
		{name: "multi-chunk", size: 3*EncryptionChunkSize + 12_345},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			plaintext := testRandomBytes(t, testCase.size)
			sealed := testEncrypt(t, key, plaintext)

			require.Equal(t, EncryptionMagic, string(sealed[:len(EncryptionMagic)]))
			require.GreaterOrEqual(t, len(sealed), len(EncryptionMagic)+EncryptionNoncePrefixSize)

			// Walk the framing exactly as documented: 4-byte big-endian length,
			// then length + 16 bytes of ciphertext; a zero length is the end.
			offset := len(EncryptionMagic) + EncryptionNoncePrefixSize
			chunkSizes := make([]int, 0, 4)
			for {
				require.GreaterOrEqual(t, len(sealed), offset+4+16, "truncated chunk header")
				length := int(binary.BigEndian.Uint32(sealed[offset : offset+4]))
				offset += 4
				chunkSizes = append(chunkSizes, length)
				require.GreaterOrEqual(t, len(sealed), offset+length+16, "truncated chunk body")
				offset += length + 16
				if length == 0 {
					break
				}
			}
			require.Equal(t, len(sealed), offset, "trailing bytes after end marker")
			require.Equal(t, 0, chunkSizes[len(chunkSizes)-1], "last chunk must be the zero-length end marker")

			dataChunks := chunkSizes[:len(chunkSizes)-1]
			total := 0
			for _, size := range dataChunks {
				require.LessOrEqual(t, size, EncryptionChunkSize)
				total += size
			}
			require.Equal(t, testCase.size, total)
			if testCase.size > EncryptionChunkSize {
				require.Greater(t, len(dataChunks), 1, "large payload must span several chunks")
			}

			expected := len(EncryptionMagic) + EncryptionNoncePrefixSize +
				testCase.size + 20*(len(chunkSizes))
			require.Equal(t, expected, len(sealed))

			decrypted, err := testDecrypt(t, key, sealed)
			require.NoError(t, err)
			require.Equal(t, plaintext, decrypted)
		})
	}
}

func TestEncryptionUsesFreshRandomNoncePrefix(t *testing.T) {
	key := testEncryptionKey(t)
	first := testEncrypt(t, key, []byte("same plaintext"))
	second := testEncrypt(t, key, []byte("same plaintext"))
	require.NotEqual(t, first, second, "a fresh nonce prefix must change the ciphertext")
}

func TestDecryptRejectsWrongKey(t *testing.T) {
	key := testEncryptionKey(t)
	wrongKey := testEncryptionKey(t)
	sealed := testEncrypt(t, key, []byte("top secret backup"))
	_, err := testDecrypt(t, wrongKey, sealed)
	require.ErrorIs(t, err, ErrDecryptionFailed)
}

func TestDecryptRejectsTamperedCiphertext(t *testing.T) {
	key := testEncryptionKey(t)
	plaintext := testRandomBytes(t, EncryptionChunkSize+100)
	sealed := testEncrypt(t, key, plaintext)
	headerSize := len(EncryptionMagic) + EncryptionNoncePrefixSize

	// Flip one ciphertext byte inside the first chunk.
	tampered := append([]byte(nil), sealed...)
	tampered[headerSize+4+50] ^= 0xff
	_, err := testDecrypt(t, key, tampered)
	require.ErrorIs(t, err, ErrDecryptionFailed)

	// Truncate exactly before the authenticated end marker.
	truncated := sealed[:len(sealed)-20]
	_, err = testDecrypt(t, key, truncated)
	require.ErrorIs(t, err, ErrDecryptionFailed)

	// Append data after the end marker.
	appended := append(append([]byte(nil), sealed...), []byte("extra")...)
	_, err = testDecrypt(t, key, appended)
	require.ErrorIs(t, err, ErrInvalidArchive)
}

func TestDecryptRejectsReorderedChunks(t *testing.T) {
	key := testEncryptionKey(t)
	plaintext := testRandomBytes(t, 2*EncryptionChunkSize)
	sealed := testEncrypt(t, key, plaintext)
	headerSize := len(EncryptionMagic) + EncryptionNoncePrefixSize
	recordSize := EncryptionChunkSize + 20 // 4-byte length + ciphertext + tag

	// Both full chunks have the same size, so a swap keeps the framing valid;
	// only the per-chunk counter in the AAD can detect it.
	reordered := append([]byte(nil), sealed...)
	first := append([]byte(nil), reordered[headerSize:headerSize+recordSize]...)
	second := append([]byte(nil), reordered[headerSize+recordSize:headerSize+2*recordSize]...)
	copy(reordered[headerSize:headerSize+recordSize], second)
	copy(reordered[headerSize+recordSize:headerSize+2*recordSize], first)

	_, err := testDecrypt(t, key, reordered)
	require.ErrorIs(t, err, ErrDecryptionFailed)
}

func TestDecryptRejectsBadMagic(t *testing.T) {
	key := testEncryptionKey(t)
	sealed := testEncrypt(t, key, []byte("payload"))
	corrupted := append([]byte(nil), sealed...)
	corrupted[0] = 'X'
	_, err := NewDecryptingReader(bytes.NewReader(corrupted), key)
	require.ErrorIs(t, err, ErrInvalidArchive)
}

func TestEncryptionKeyLengthValidation(t *testing.T) {
	shortKey := testEncryptionKey(t)[:16]
	var buffer bytes.Buffer
	_, err := EncryptWriter(&buffer, shortKey)
	require.ErrorIs(t, err, ErrEncryptionKeyInvalid)

	_, err = NewDecryptingReader(bytes.NewReader(nil), nil)
	require.ErrorIs(t, err, ErrEncryptionKeyInvalid)

	dir := t.TempDir()
	_, err = NewService(Config{BackupDir: dir, EncryptionKey: shortKey})
	require.ErrorIs(t, err, ErrEncryptionKeyInvalid)
}

func TestParseEncryptionKey(t *testing.T) {
	key := testEncryptionKey(t)
	rawString := strings.Repeat("k", EncryptionKeySize)

	decoded, err := ParseEncryptionKey(hex.EncodeToString(key))
	require.NoError(t, err)
	require.Equal(t, key, decoded)

	decoded, err = ParseEncryptionKey("hex:" + strings.ToUpper(hex.EncodeToString(key)))
	require.NoError(t, err)
	require.Equal(t, key, decoded)

	decoded, err = ParseEncryptionKey(base64.StdEncoding.EncodeToString(key))
	require.NoError(t, err)
	require.Equal(t, key, decoded)

	decoded, err = ParseEncryptionKey("base64:" + base64.RawURLEncoding.EncodeToString(key))
	require.NoError(t, err)
	require.Equal(t, key, decoded)

	decoded, err = ParseEncryptionKey(rawString)
	require.NoError(t, err)
	require.Equal(t, []byte(rawString), decoded)

	decoded, err = ParseEncryptionKey("   ")
	require.NoError(t, err)
	require.Nil(t, decoded)

	for _, bad := range []string{"short", "hex:abcd", strings.Repeat("0", 10)} {
		_, err = ParseEncryptionKey(bad)
		require.ErrorIs(t, err, ErrEncryptionKeyInvalid, bad)
	}
}

func TestIsEncryptedPackage(t *testing.T) {
	dir := t.TempDir()
	key := testEncryptionKey(t)
	sealed := testEncrypt(t, key, []byte("payload"))

	encryptedPath := filepath.Join(dir, "backup.ppbak")
	require.NoError(t, os.WriteFile(encryptedPath, sealed, 0o644))
	encrypted, err := IsEncryptedPackage(encryptedPath)
	require.NoError(t, err)
	require.True(t, encrypted)

	plainPath := filepath.Join(dir, "backup.zip")
	require.NoError(t, os.WriteFile(plainPath, []byte("PK\x05\x06 not really"), 0o644))
	encrypted, err = IsEncryptedPackage(plainPath)
	require.NoError(t, err)
	require.False(t, encrypted)

	shortPath := filepath.Join(dir, "short.bin")
	require.NoError(t, os.WriteFile(shortPath, []byte("PPB"), 0o644))
	encrypted, err = IsEncryptedPackage(shortPath)
	require.NoError(t, err)
	require.False(t, encrypted)

	_, err = IsEncryptedPackage(filepath.Join(dir, "missing.ppbak"))
	require.ErrorIs(t, err, ErrNotFound)
}

// TestEncryptedBackupCreateVerifyRestore is the end-to-end test: it builds a real
// encrypted package, inspects its framing, and verifies and restores it.
func TestEncryptedBackupCreateVerifyRestore(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	dbPath := filepath.Join(root, "practacu.db")
	mediaDir := filepath.Join(root, "media")
	backupDir := filepath.Join(root, "backups")
	require.NoError(t, os.MkdirAll(filepath.Join(mediaDir, "ab"), 0o755))
	// Incompressible media larger than one encryption chunk makes the stored
	// package span several authenticated chunks.
	large := testRandomBytes(t, 2500<<10)
	require.NoError(t, os.WriteFile(filepath.Join(mediaDir, "ab", "large.bin"), large, 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(mediaDir, "ab", "small.txt"), []byte("hello"), 0o644))

	handle, err := db.Open(ctx, "sqlite", db.SQLiteDSN(dbPath))
	require.NoError(t, err)
	require.NoError(t, handle.Client.Schema.Create(ctx))
	defer handle.Close()

	siteRow, err := handle.Client.Site.Create().
		SetSlug("alpha").
		SetName("Alpha").
		SetDomain("alpha.example").
		Save(ctx)
	require.NoError(t, err)
	_, err = handle.Client.SiteCustomization.Create().
		SetSiteID(siteRow.ID).
		SetDocument(`{"pages":[{"id":"p1","title":"About"}]}`).
		SetRevision(1).
		Save(ctx)
	require.NoError(t, err)

	key := testEncryptionKey(t)
	wrongKey := testEncryptionKey(t)
	now := func() time.Time { return time.Date(2026, 11, 7, 5, 0, 0, 0, time.UTC) }
	mediaRoots := []MediaRoot{{Alias: "global", Driver: "local", Dir: mediaDir}}
	encryptedService, err := NewService(Config{
		Driver:        "sqlite",
		DSN:           db.SQLiteDSN(dbPath),
		Snapshotter:   handle,
		MediaRoots:    mediaRoots,
		Designs:       NewDBDesignSource(handle),
		BackupDir:     backupDir,
		SchemaVersion: db.SchemaVersion,
		AppVersion:    "test",
		Now:           now,
		EncryptionKey: key,
	})
	require.NoError(t, err)

	artifact, err := encryptedService.CreateBackup(ctx)
	require.NoError(t, err)
	require.True(t, artifact.Encrypted)
	require.True(t, strings.HasSuffix(artifact.FileName, ".ppbak"))
	require.True(t, strings.HasSuffix(artifact.Path, ".ppbak"))
	require.FileExists(t, artifact.Path)
	require.Greater(t, artifact.Size, int64(2*EncryptionChunkSize), "package should span several chunks")

	stored, err := os.ReadFile(artifact.Path)
	require.NoError(t, err)
	require.Equal(t, EncryptionMagic, string(stored[:len(EncryptionMagic)]))
	// The sidecar hash is sha256sum of the stored ciphertext, not the plaintext.
	digest := sha256.Sum256(stored)
	require.Equal(t, hex.EncodeToString(digest[:]), artifact.SHA256)

	_, zipErr := zip.OpenReader(artifact.Path)
	require.Error(t, zipErr, "the stored bytes must not be a readable zip")

	manifest, err := encryptedService.VerifyBackup(artifact.Path)
	require.NoError(t, err)
	require.True(t, manifest.Encrypted)
	require.Equal(t, FormatBackup, manifest.Format)
	require.Equal(t, db.SchemaVersion, manifest.SchemaVersion)
	require.Equal(t, "database/practacu.db", manifest.Database.Dump)

	// A service without a key must refuse an encrypted package loudly.
	noKeyService, err := NewService(Config{
		BackupDir:     backupDir,
		SchemaVersion: db.SchemaVersion,
	})
	require.NoError(t, err)
	_, err = noKeyService.VerifyBackup(artifact.Path)
	require.ErrorIs(t, err, ErrEncryptionKeyRequired)

	// A wrong key must fail authentication, not "succeed" with garbage.
	wrongKeyService, err := NewService(Config{
		BackupDir:     backupDir,
		SchemaVersion: db.SchemaVersion,
		EncryptionKey: wrongKey,
	})
	require.NoError(t, err)
	_, err = wrongKeyService.VerifyBackup(artifact.Path)
	require.ErrorIs(t, err, ErrDecryptionFailed)

	// The artifact sidecar and the download path both understand .ppbak.
	described, err := encryptedService.readArtifact(artifact.ID)
	require.NoError(t, err)
	require.True(t, described.Encrypted)
	require.Equal(t, encryptedPackageExtension, filepath.Ext(described.Path))
	_, file, err := encryptedService.OpenBackup(
		ctx, Actor{UserID: "admin", Role: site.RolePlatformAdmin}, artifact.ID,
	)
	require.NoError(t, err)
	header := make([]byte, len(EncryptionMagic))
	_, err = io.ReadFull(file, header)
	require.NoError(t, err)
	require.Equal(t, EncryptionMagic, string(header))
	require.NoError(t, file.Close())

	// An artifact tampered on disk must not verify.
	tamperedPath := filepath.Join(root, "tampered.ppbak")
	tampered := append([]byte(nil), stored...)
	tampered[len(EncryptionMagic)+EncryptionNoncePrefixSize+4+32] ^= 0xff
	require.NoError(t, os.WriteFile(tamperedPath, tampered, 0o644))
	_, err = encryptedService.VerifyBackup(tamperedPath)
	require.ErrorIs(t, err, ErrDecryptionFailed)

	// Plaintext packages keep working, even on a service that has a key
	// configured: the reader trusts the magic, not the operator's env.
	plainService, err := NewService(Config{
		Driver:        "sqlite",
		DSN:           db.SQLiteDSN(dbPath),
		Snapshotter:   handle,
		MediaRoots:    mediaRoots,
		Designs:       NewDBDesignSource(handle),
		BackupDir:     backupDir,
		SchemaVersion: db.SchemaVersion,
		AppVersion:    "test",
		Now:           func() time.Time { return now().Add(time.Minute) },
	})
	require.NoError(t, err)
	plainArtifact, err := plainService.CreateBackup(ctx)
	require.NoError(t, err)
	require.False(t, plainArtifact.Encrypted)
	require.Equal(t, plainPackageExtension, filepath.Ext(plainArtifact.Path))
	plainManifest, err := encryptedService.VerifyBackup(plainArtifact.Path)
	require.NoError(t, err)
	require.False(t, plainManifest.Encrypted)

	plainRestoredDB := filepath.Join(root, "plain-restored.db")
	plainRestoredMedia := filepath.Join(root, "plain-restored-media")
	plainResult, err := encryptedService.Restore(ctx, RestoreOptions{
		ArchivePath:   plainArtifact.Path,
		TargetDBPath:  plainRestoredDB,
		MediaRoots:    []MediaRoot{{Alias: "global", Driver: "local", Dir: plainRestoredMedia}},
		SchemaVersion: db.SchemaVersion,
	})
	require.NoError(t, err)
	require.Equal(t, 1, plainResult.Sites)
	require.Equal(t, 2, plainResult.MediaFiles)
	plainRestored, err := os.ReadFile(filepath.Join(plainRestoredMedia, "ab", "large.bin"))
	require.NoError(t, err)
	require.Equal(t, large, plainRestored)

	// Restoring the encrypted package works with the right key.
	restoredDB := filepath.Join(root, "restored.db")
	restoredMedia := filepath.Join(root, "restored-media")
	result, err := encryptedService.Restore(ctx, RestoreOptions{
		ArchivePath:   artifact.Path,
		TargetDBPath:  restoredDB,
		MediaRoots:    []MediaRoot{{Alias: "global", Driver: "local", Dir: restoredMedia}},
		SchemaVersion: db.SchemaVersion,
	})
	require.NoError(t, err)
	require.Equal(t, 1, result.Sites)
	require.Equal(t, 2, result.MediaFiles)

	restoredLarge, err := os.ReadFile(filepath.Join(restoredMedia, "ab", "large.bin"))
	require.NoError(t, err)
	require.Equal(t, large, restoredLarge)

	restored, err := db.Open(ctx, "sqlite", db.SQLiteDSN(restoredDB))
	require.NoError(t, err)
	stats, err := restored.Inspect(ctx)
	require.NoError(t, err)
	require.Equal(t, 1, stats.Sites)
	require.NoError(t, restored.VerifySchema(ctx))
	require.NoError(t, restored.Close())

	// Missing and wrong keys must fail before the target database is touched.
	missingKeyTarget := filepath.Join(root, "missing-key.db")
	_, err = noKeyService.Restore(ctx, RestoreOptions{
		ArchivePath:   artifact.Path,
		TargetDBPath:  missingKeyTarget,
		MediaRoots:    []MediaRoot{{Alias: "global", Driver: "local", Dir: filepath.Join(root, "missing-media")}},
		SchemaVersion: db.SchemaVersion,
	})
	require.ErrorIs(t, err, ErrEncryptionKeyRequired)
	require.NoFileExists(t, missingKeyTarget)

	wrongKeyTarget := filepath.Join(root, "wrong-key.db")
	_, err = wrongKeyService.Restore(ctx, RestoreOptions{
		ArchivePath:   artifact.Path,
		TargetDBPath:  wrongKeyTarget,
		MediaRoots:    []MediaRoot{{Alias: "global", Driver: "local", Dir: filepath.Join(root, "wrong-media")}},
		SchemaVersion: db.SchemaVersion,
	})
	require.ErrorIs(t, err, ErrDecryptionFailed)
	require.NoFileExists(t, wrongKeyTarget)
}

// TestNewServiceAcceptsEmptyEncryptionKey documents that an unset key means
// plaintext and a malformed one is a constructor error, not a runtime surprise.
func TestNewServiceEncryptionKeyHandling(t *testing.T) {
	dir := t.TempDir()
	service, err := NewService(Config{BackupDir: dir, EncryptionKey: []byte{}})
	require.NoError(t, err)
	require.Empty(t, service.encryptionKey)

	key := testEncryptionKey(t)
	service, err = NewService(Config{BackupDir: dir, EncryptionKey: key})
	require.NoError(t, err)
	require.Equal(t, key, service.encryptionKey)

	// A caller mutating its slice must not change the service key.
	mutable := append([]byte(nil), key...)
	service, err = NewService(Config{BackupDir: dir, EncryptionKey: mutable})
	require.NoError(t, err)
	mutable[0] ^= 0xff
	require.Equal(t, key, service.encryptionKey)
}

// TestEncryptedPackageErrorsKeepSentinels guards the handler mapping: every
// encryption failure must stay identifiable through errors.Is.
func TestEncryptedPackageErrorsKeepSentinels(t *testing.T) {
	key := testEncryptionKey(t)
	sealed := testEncrypt(t, key, []byte("payload"))
	_, err := testDecrypt(t, testEncryptionKey(t), sealed)
	require.Error(t, err)
	require.True(t, errors.Is(err, ErrDecryptionFailed))
	require.Contains(t, err.Error(), "authentication failed")
}
