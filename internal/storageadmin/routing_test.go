package storageadmin

import (
	"bytes"
	"context"
	"errors"
	"io"
	"sync"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/practacu/practacu-press/internal/media"
)

type fakeStore struct {
	name    string
	mu      sync.Mutex
	objects map[string][]byte
	usage   int64
}

func newFakeStore(name string) *fakeStore {
	return &fakeStore{name: name, objects: map[string][]byte{}}
}

func (f *fakeStore) Put(_ context.Context, key string, reader io.Reader, size int64) error {
	payload, err := io.ReadAll(io.LimitReader(reader, size))
	if err != nil {
		return err
	}
	if int64(len(payload)) != size {
		return errors.New("short read")
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.objects[key] = payload
	return nil
}

func (f *fakeStore) ReadHead(_ context.Context, key string, n int) ([]byte, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	payload, ok := f.objects[key]
	if !ok {
		return nil, media.ErrStorageObjectMissing
	}
	if n > len(payload) {
		n = len(payload)
	}
	return append([]byte(nil), payload[:n]...), nil
}

func (f *fakeStore) Open(_ context.Context, key string) (io.ReadCloser, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	payload, ok := f.objects[key]
	if !ok {
		return nil, media.ErrStorageObjectMissing
	}
	return io.NopCloser(bytes.NewReader(payload)), nil
}

func (f *fakeStore) Delete(_ context.Context, key string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.objects, key)
	return nil
}

func (f *fakeStore) Size(_ context.Context, key string) (int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	payload, ok := f.objects[key]
	if !ok {
		return 0, media.ErrStorageObjectMissing
	}
	return int64(len(payload)), nil
}

func (f *fakeStore) Usage(context.Context) (int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.usage, nil
}

func (f *fakeStore) has(key string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	_, ok := f.objects[key]
	return ok
}

func routingFor(t *testing.T, allocation Allocation, stores map[string]*fakeStore) *routingStorage {
	t.Helper()
	mediaStores := make(map[string]media.Storage, len(stores))
	for id, store := range stores {
		mediaStores[id] = store
	}
	usage := newUsageTracker("", nil)
	routing := newRoutingStorage("content", allocation, mediaStores, nil, nil, usage, nil)
	return routing
}

func TestRoutingSwitchesAtQuota(t *testing.T) {
	first, second := newFakeStore("first"), newFakeStore("second")
	routing := routingFor(t, Allocation{
		Mode: ModeQuota,
		Entries: []AllocationEntry{
			{StrategyID: "first", QuotaGB: 0},
			{StrategyID: "second", QuotaGB: 0},
		},
		Overflow: OverflowSwitch,
	}, map[string]*fakeStore{"first": first, "second": second})
	routing.entries[0].quotaBytes = 10

	require.NoError(t, routing.Put(context.Background(), "a", bytes.NewReader([]byte("123456")), 6))
	require.NoError(t, routing.Put(context.Background(), "b", bytes.NewReader([]byte("123456")), 6))

	require.True(t, first.has("a"))
	require.False(t, first.has("b"))
	require.True(t, second.has("b"))
	require.Equal(t, int64(6), routing.usage.get("first"))
	require.Equal(t, int64(6), routing.usage.get("second"))
}

func TestRoutingStopsAtFirstFullEntry(t *testing.T) {
	first, second := newFakeStore("first"), newFakeStore("second")
	routing := routingFor(t, Allocation{
		Mode: ModeQuota,
		Entries: []AllocationEntry{
			{StrategyID: "first"},
			{StrategyID: "second"},
		},
		Overflow: OverflowStop,
	}, map[string]*fakeStore{"first": first, "second": second})
	routing.entries[0].quotaBytes = 10

	require.NoError(t, routing.Put(context.Background(), "a", bytes.NewReader([]byte("123456")), 6))
	err := routing.Put(context.Background(), "b", bytes.NewReader([]byte("123456")), 6)
	require.ErrorIs(t, err, media.ErrStorageQuotaExceeded)
	require.False(t, second.has("b"))
}

func TestRoutingSingleModeIgnoresQuota(t *testing.T) {
	first, second := newFakeStore("first"), newFakeStore("second")
	routing := routingFor(t, Allocation{
		Mode: ModeSingle,
		Entries: []AllocationEntry{
			{StrategyID: "first"},
			{StrategyID: "second"},
		},
		Overflow: OverflowStop,
	}, map[string]*fakeStore{"first": first, "second": second})
	routing.entries[0].quotaBytes = 1

	require.NoError(t, routing.Put(context.Background(), "a", bytes.NewReader([]byte("12345")), 5))
	require.True(t, first.has("a"))
	require.False(t, second.has("a"))
}

func TestRoutingReadsAndDeletesAcrossEntries(t *testing.T) {
	first, second := newFakeStore("first"), newFakeStore("second")
	routing := routingFor(t, Allocation{
		Mode: ModeQuota,
		Entries: []AllocationEntry{
			{StrategyID: "first"},
			{StrategyID: "second"},
		},
		Overflow: OverflowSwitch,
	}, map[string]*fakeStore{"first": first, "second": second})
	routing.entries[0].quotaBytes = 1

	require.NoError(t, routing.Put(context.Background(), "old", bytes.NewReader([]byte("1234")), 4))
	require.True(t, second.has("old"))

	head, err := routing.ReadHead(context.Background(), "old", 2)
	require.NoError(t, err)
	require.Equal(t, []byte("12"), head)

	reader, err := routing.Open(context.Background(), "old")
	require.NoError(t, err)
	require.NoError(t, reader.Close())

	require.NoError(t, routing.Delete(context.Background(), "old"))
	require.False(t, second.has("old"))
	require.Equal(t, int64(0), routing.usage.get("second"))
}

func (f *fakeStore) usageValue() int64 {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.usage
}
