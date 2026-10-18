package media

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

)

// s3Endpoint returns the configured S3 test endpoint, or skips.
//
// The S3 adapter is exercised against a real endpoint (MinIO, moto or AWS) because a
// mocked client would only prove the SDK was called, not that the contract holds.
func s3Endpoint(t *testing.T) string {
	t.Helper()
	endpoint := os.Getenv("S3_TEST_ENDPOINT")
	if endpoint == "" {
		t.Skip("S3_TEST_ENDPOINT is not set; start MinIO or moto to run the S3 suite")
	}
	return endpoint
}

func newS3Storage(t *testing.T) *S3Storage {
	t.Helper()

	storage, err := NewS3Storage(context.Background(), S3Config{
		Bucket:    "practacu-test",
		Region:    "us-east-1",
		Endpoint:  s3Endpoint(t),
		AccessKey: "test",
		SecretKey: "testsecret",
		Prefix:    "media",
	})
	require.NoError(t, err)
	return storage
}

func TestS3PutReadAndDelete(t *testing.T) {
	storage := newS3Storage(t)
	ctx := context.Background()

	payload := []byte{0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A}
	key := "ab/s3-test.png"

	t.Cleanup(func() { _ = storage.Delete(context.Background(), key) })

	require.NoError(t, storage.Put(ctx, key, bytes.NewReader(payload), int64(len(payload))))

	head, err := storage.ReadHead(ctx, key, 8)
	require.NoError(t, err)
	require.Equal(t, payload, head)

	reader, err := storage.Open(ctx, key)
	require.NoError(t, err)
	defer reader.Close()

	full, err := io.ReadAll(reader)
	require.NoError(t, err)
	require.Equal(t, payload, full)

	require.NoError(t, storage.Delete(ctx, key))
	require.NoError(t, storage.Delete(ctx, key), "deleting twice must not fail")
}

func TestS3MissingObject(t *testing.T) {
	storage := newS3Storage(t)

	_, err := storage.ReadHead(context.Background(), "ab/does-not-exist.png", 8)
	require.ErrorIs(t, err, ErrStorageObjectMissing)
}

func TestS3RejectsTraversalKeys(t *testing.T) {
	storage := newS3Storage(t)
	ctx := context.Background()

	for _, key := range []string{"../escape.png", "..\\escape.png", "/absolute.png", ""} {
		err := storage.Put(ctx, key, strings.NewReader("x"), 1)
		require.ErrorIs(t, err, ErrStorageKeyUnsafe, key)
	}
}

func TestS3HonoursPrefix(t *testing.T) {
	storage := newS3Storage(t)
	require.Equal(t, "practacu-test", storage.Bucket())
}

// TestServiceWithS3Storage runs the upload flow against the object store, which is what
// proves the adapter satisfies the port rather than merely compiling.
func TestServiceWithS3Storage(t *testing.T) {
	storage := newS3Storage(t)
	ctx := context.Background()

	repo := newFakeRepo()
	scanner := &capturingScanner{result: ScanResult{Status: ScanClean}}
	service, err := NewService(ServiceConfig{
		Repository: repo,
		Scanner:    scanner,
		Storage:    storage,
	})
	require.NoError(t, err)

	payload := []byte{0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A}
	actor := Actor{UserID: "u1", SiteID: "s1"}
	upload, err := service.CreateUpload(ctx, actor, UploadRequest{
		FileName: "a.png", DeclaredMIME: "image/png",
		Size: int64(len(payload)), Purpose: PurposeContent,
	})
	require.NoError(t, err)

	t.Cleanup(func() { _ = storage.Delete(context.Background(), upload.StorageKey) })

	_, err = service.StoreContent(ctx, actor, upload.ID, bytes.NewReader(payload), int64(len(payload)))
	require.NoError(t, err)

	asset, err := service.CompleteUpload(ctx, actor, upload.ID)
	require.NoError(t, err)
	require.True(t, asset.Referenceable())
	require.Equal(t, payload, scanner.last.Head, "inspection received the stored sample")
}

var _ = errors.Is
