package media

import (
	"bytes"
	"context"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func newStorage(t *testing.T) *LocalStorage {
	t.Helper()
	storage, err := NewLocalStorage(t.TempDir())
	require.NoError(t, err)
	return storage
}

func TestNewLocalStorageRequiresRoot(t *testing.T) {
	_, err := NewLocalStorage("  ")
	require.Error(t, err)
}

func TestPutStoresAndReadsBack(t *testing.T) {
	storage := newStorage(t)
	ctx := context.Background()
	payload := []byte("PNGDATA-0123456789")

	require.NoError(t, storage.Put(ctx, "ab/thing.png", bytes.NewReader(payload), int64(len(payload))))

	head, err := storage.ReadHead(ctx, "ab/thing.png", 4)
	require.NoError(t, err)
	require.Equal(t, []byte("PNGD"), head)
}

// TestPutRejectsOversizedBody proves the declared size is a hard bound, not a hint.
func TestPutRejectsTooFewBytes(t *testing.T) {
	storage := newStorage(t)

	err := storage.Put(context.Background(), "ab/x.png", strings.NewReader("short"), 100)
	require.Error(t, err)
}

func TestPutRejectsTraversalKeys(t *testing.T) {
	storage := newStorage(t)
	ctx := context.Background()

	for _, key := range []string{
		"../escape.png",
		"..\\escape.png",
		"/etc/passwd",
		"C:/windows/system32/cmd.exe",
		"ab/../../escape.png",
		"",
	} {
		err := storage.Put(ctx, key, strings.NewReader("x"), 1)
		require.ErrorIs(t, err, ErrStorageKeyUnsafe, key)
	}
}

func TestReadHeadMissingObject(t *testing.T) {
	storage := newStorage(t)

	_, err := storage.ReadHead(context.Background(), "ab/missing.png", 8)
	require.ErrorIs(t, err, ErrStorageObjectMissing)
}

func TestDeleteIsIdempotent(t *testing.T) {
	storage := newStorage(t)
	ctx := context.Background()

	require.NoError(t, storage.Put(ctx, "ab/x.png", strings.NewReader("abc"), 3))
	require.NoError(t, storage.Delete(ctx, "ab/x.png"))
	require.NoError(t, storage.Delete(ctx, "ab/x.png"), "deleting twice must not fail")
}

func TestReadHeadCapsSampleSize(t *testing.T) {
	storage := newStorage(t)
	ctx := context.Background()
	payload := bytes.Repeat([]byte("A"), HeadSampleSize+64)

	require.NoError(t, storage.Put(ctx, "ab/big.bin", bytes.NewReader(payload), int64(len(payload))))

	head, err := storage.ReadHead(ctx, "ab/big.bin", HeadSampleSize*8)
	require.NoError(t, err)
	require.Len(t, head, HeadSampleSize, "the sample never exceeds the inspection budget")
}

func TestReadHeadOnShortObject(t *testing.T) {
	storage := newStorage(t)
	ctx := context.Background()

	require.NoError(t, storage.Put(ctx, "ab/tiny.png", strings.NewReader("AB"), 2))

	head, err := storage.ReadHead(ctx, "ab/tiny.png", 8)
	require.NoError(t, err)
	require.Equal(t, []byte("AB"), head, "a short object yields what it has")
}

func TestRespectsCancelledContext(t *testing.T) {
	storage := newStorage(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	err := storage.Put(ctx, "ab/x.png", strings.NewReader("x"), 1)
	require.ErrorIs(t, err, context.Canceled)
}

func TestLocalStorageUsageAndSizeTrackObjects(t *testing.T) {
	storage := newStorage(t)
	ctx := context.Background()
	require.NoError(t, storage.Put(ctx, "aa/one.png", bytes.NewReader([]byte("1234")), 4))
	require.NoError(t, storage.Put(ctx, "bb/two.png", bytes.NewReader([]byte("123456")), 6))

	usage, err := storage.Usage(ctx)
	require.NoError(t, err)
	require.Equal(t, int64(10), usage)

	size, err := storage.Size(ctx, "aa/one.png")
	require.NoError(t, err)
	require.Equal(t, int64(4), size)

	require.NoError(t, storage.Delete(ctx, "aa/one.png"))
	usage, err = storage.Usage(ctx)
	require.NoError(t, err)
	require.Equal(t, int64(6), usage)
}
